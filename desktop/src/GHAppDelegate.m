#import "GHAppDelegate.h"
#import "GHController.h"
#import "GHCore.h"
#import "GHHarness.h"
#import "GHLog.h"
#import "GHProfileStore.h"
#import "GHServerClient.h"
#import "GHTestPanel.h"
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>

NSNotificationName const GHTrustDidChangeNotification = @"GHTrustDidChangeNotification";
NSNotificationName const GHActivationDidChangeNotification = @"GHActivationDidChangeNotification";
NSNotificationName const GHServerStatusDidChangeNotification = @"GHServerStatusDidChangeNotification";

static NSString *const kDemoURL = @"http://localhost:5173";
static NSString *const kAccessibilityPaneURL = @"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
static const NSTimeInterval kTrustPollUntrusted = 1.5;
static const NSTimeInterval kTrustPollTrusted = 10.0;
static const NSTimeInterval kServerPoll = 15.0;
static const NSTimeInterval kLaunchRequestWarmUp = 2.0;   // pipeline start + first capture + offline ghosts

@interface GHAppDelegate ()
@property (nonatomic, readwrite, nullable) GHCore *core;
@property (nonatomic, readwrite, nullable) GHProfileStore *store;
@property (nonatomic, readwrite, nullable) GHServerClient *client;
@property (nonatomic, readwrite) BOOL trusted;
@property (nonatomic, readwrite, nullable) GHServerHealth *health;
@property (nonatomic, readwrite, nullable) GHPresence *presence;
@property (nonatomic, readwrite, nullable) NSRunningApplication *frontmostUserApp;
- (void)hotKeyPressed;
@end

static OSStatus GHHotKeyHandler(EventHandlerCallRef next, EventRef event, void *userData) {
    GHAppDelegate *delegate = (__bridge GHAppDelegate *)userData;
    dispatch_async(dispatch_get_main_queue(), ^{ [delegate hotKeyPressed]; });
    return noErr;
}

@implementation GHAppDelegate {
    NSStatusItem *_statusItem;
    NSTimer *_trustTimer;
    NSTimer *_serverTimer;
    id<GHDesktopPipeline> _pipeline;
    BOOL _pipelineRunning;
    BOOL _pipelineLookupLogged;
    EventHotKeyRef _hotKey;
    EventHandlerRef _hotKeyHandler;
    NSString *_serverErrorCode;
    BOOL _serverStateKnown;
    GHHarnessServer *_harnessServer;
    // Items of the menu that is open right now, so their titles follow the state while the user is looking.
    NSMenuItem *_toggleItem;
    NSMenuItem *_statusInfoItem;
    NSMenuItem *_serverInfoItem;
    NSMenuItem *_pipelineInfoItem;
    GHTestPanel *_testPanel;
}

#pragma mark - launch

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    GHLog(@"app: launched pid=%d", getpid());
    self.core = [GHCore sharedCore];
    self.store = [[GHProfileStore alloc] initWithCore:self.core];
    [self.store prepare];
    [self.store startWatching];
    if (self.core) {
        NSString *cachePath = [self.store.directory stringByAppendingPathComponent:@"form-cache.json"];
        self.client = [[GHServerClient alloc] initWithBaseURLString:self.store.serverURLString core:self.core configuration:nil
                                                              cache:[[GHFormCache alloc] initWithPath:cachePath]];
    }

    [self installStatusItem];
    [self installHotKey];

    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    [center addObserver:self selector:@selector(storeDidChange:) name:GHProfileStoreDidChangeNotification object:self.store];
    [center addObserver:self selector:@selector(pipelineStateDidChange:) name:GHControllerStateDidChangeNotification object:nil];
    [NSWorkspace.sharedWorkspace.notificationCenter addObserver:self selector:@selector(appDidActivate:)
                                                           name:NSWorkspaceDidActivateApplicationNotification object:nil];
    [self rememberFrontmost:NSWorkspace.sharedWorkspace.frontmostApplication];

    [self checkTrustPrompting:YES];
    [self pollServer];
    _serverTimer = [NSTimer scheduledTimerWithTimeInterval:kServerPoll target:self selector:@selector(pollServer) userInfo:nil repeats:YES];
    _serverTimer.tolerance = 3.0;
    [self startHarness];
}

- (void)applicationWillTerminate:(NSNotification *)notification {
    [_harnessServer stop];
    [self.harnessChannel releaseAgentLock];
    [self stopPipeline];
    [self.client cancelAll];
    [self.store stopWatching];
    if (_hotKey) UnregisterEventHotKey(_hotKey);
    if (_hotKeyHandler) RemoveEventHandler(_hotKeyHandler);
    GHLog(@"app: quit");
    GHLogFlush();
}

- (BOOL)ghostEnabled {
    return self.store ? self.store.enabled : NO;
}

#pragma mark - trust

/// Nothing but this check (and the menu) happens while untrusted: every AX call would return -25211.
- (void)checkTrustPrompting:(BOOL)prompt {
    BOOL trusted = AXIsProcessTrusted();
    if (!trusted && prompt && !getenv("GHOST_NO_PROMPT")) {
        // Once per launch: shows the system dialog that leads to Privacy & Security -> Accessibility.
        NSDictionary *options = @{ (__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES };
        trusted = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
        GHLog(@"app: not trusted for Accessibility yet; asked the system to show the permission prompt");
    }
    if (prompt) GHLog(@"app: accessibility trusted=%d at launch", trusted);
    [self applyTrust:trusted force:prompt];
}

- (void)applyTrust:(BOOL)trusted force:(BOOL)force {
    BOOL changed = trusted != self.trusted;
    self.trusted = trusted;
    if (changed || force) {
        if (changed) GHLog(@"app: accessibility trusted=%d", trusted);
        [self scheduleTrustTimer];
        [self syncPipeline];
        [self refreshStatusItem];
        if (changed) [NSNotificationCenter.defaultCenter postNotificationName:GHTrustDidChangeNotification object:self userInfo:@{ @"trusted": @(trusted) }];
    }
}

- (void)scheduleTrustTimer {
    [_trustTimer invalidate];
    NSTimeInterval interval = self.trusted ? kTrustPollTrusted : kTrustPollUntrusted;
    _trustTimer = [NSTimer scheduledTimerWithTimeInterval:interval target:self selector:@selector(trustTimerFired) userInfo:nil repeats:YES];
    _trustTimer.tolerance = interval / 4;
}

- (void)trustTimerFired {
    [self applyTrust:AXIsProcessTrusted() force:NO];
}

#pragma mark - pipeline (run-time lookup)

- (void)syncPipeline {
    BOOL shouldRun = self.trusted && self.ghostEnabled && self.core != nil;
    if (shouldRun) [self startPipeline]; else [self stopPipeline];
}

- (void)startPipeline {
    if (_pipelineRunning) return;
    if (!_pipeline) {
        for (NSString *name in @[ NSStringFromClass([GHController class]), @"GHPipeline" ]) {
            Class cls = NSClassFromString(name);
            if (!cls || ![cls instancesRespondToSelector:@selector(initWithCore:store:client:)]) continue;
            if (![cls instancesRespondToSelector:@selector(start)] || ![cls instancesRespondToSelector:@selector(stop)]) continue;
            _pipeline = [(id<GHDesktopPipeline>)[cls alloc] initWithCore:self.core store:self.store client:self.client];
            GHLog(@"app: pipeline class %@ found", name);
            break;
        }
    }
    if (!_pipeline) {
        if (!_pipelineLookupLogged) GHLog(@"app: no pipeline class in this build (GHController); menu and services only");
        _pipelineLookupLogged = YES;
        return;
    }
    [_pipeline start];
    _pipelineRunning = YES;
    if ([_pipeline respondsToSelector:@selector(presenceDidChange:)]) [_pipeline presenceDidChange:self.presence];
    GHLog(@"app: pipeline started");
}

- (void)stopPipeline {
    if (!_pipelineRunning) return;
    [_pipeline stop];
    _pipelineRunning = NO;
    GHLog(@"app: pipeline stopped");
}

#pragma mark - harness

- (GHController *)harnessController {
    return _pipelineRunning && [_pipeline isKindOfClass:[GHController class]] ? (GHController *)_pipeline : nil;
}

- (void)startHarness {
#if GHOST_NO_HARNESS
    return;   // the installed library: no request folder, no autotab (make install-lib)
#endif
    if (!self.harnessChannel) return;
    __weak GHAppDelegate *weakSelf = self;
    _harnessServer = [[GHHarnessServer alloc] initWithChannel:self.harnessChannel controller:^GHController *{ return [weakSelf harnessController]; }];
    [_harnessServer start];
    GHHarnessRequest *request = self.launchRequest;
    if (!request) return;
    // This agent exists for one --autotab: give the pipeline time to see the window, run, answer, quit.
    request.delay = MAX(request.delay, kLaunchRequestWarmUp);
    GHLog(@"harness: request mode=%@ id=%@ (agent launched for it)", request.mode, request.identifier);
    __block BOOL answered = NO;
    void (^answer)(NSDictionary<NSString *, id> *) = ^(NSDictionary<NSString *, id> *response) {
        if (answered) return;
        answered = YES;
        NSMutableDictionary<NSString *, id> *out = [response mutableCopy];
        out[@"mode"] = request.mode;
        out[@"agent"] = @"standalone";
        GHHarnessWriteResponse(out, request.outPath);
        GHLog(@"harness: answered mode=%@ id=%@ error=%@", request.mode, request.identifier, response[@"error"] ?: @"none");
        [NSApp terminate:nil];
    };
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(request.deadline * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        answer(GHHarnessErrorResponse(@"timeout", nil));
    });
    [GHHarness performRequest:request controller:[self harnessController] completion:answer];
}

#pragma mark - enable, pause

/// The provider / latency / cache readout along the bottom of the screen. It is a developer's instrument, not
/// part of the product, so it is off unless somebody asks for it. The controller picks the change up live.
- (void)toggleHud:(id)sender {
    [self.store updateSettings:@{ @"showHud": @(!self.store.showHud) } error:NULL];
}

/// Two buttons that do the thing a second from now, so an accept that fails can be told apart from a key that
/// never arrived (GHTestPanel). Off by default; nothing is installed until it is asked for.
- (void)toggleTestPanel:(id)sender {
    if (!_testPanel) {
        // The pipeline is looked up at run time and is only a protocol here; the panel needs the real thing.
        if (![(id)_pipeline isKindOfClass:[GHController class]]) return;
        _testPanel = [[GHTestPanel alloc] initWithController:(GHController *)_pipeline];
    }
    [_testPanel toggle];
}

- (void)toggleEnabled:(id)sender {
    BOOL enabled = !self.ghostEnabled;
    [self.store setEnabled:enabled];
    GHLog(@"app: enabled=%d", enabled);
    [self activationChanged];
}

- (void)hotKeyPressed {
    [self toggleEnabled:nil];
}

- (void)togglePauseForFrontmost:(id)sender {
    NSString *bundleId = [sender representedObject];
    if (![bundleId isKindOfClass:[NSString class]]) return;
    BOOL paused = [[self.store userPausedBundleIds] containsObject:bundleId];
    [self.store setPaused:!paused forBundleId:bundleId];
    GHLog(@"app: %@ in %@", paused ? @"resumed" : @"paused", bundleId);
    [self activationChanged];
}

- (void)activationChanged {
    [self syncPipeline];
    [self refreshStatusItem];
    [NSNotificationCenter.defaultCenter postNotificationName:GHActivationDidChangeNotification object:self];
}

- (void)storeDidChange:(NSNotification *)notification {
    self.client.baseURLString = self.store.serverURLString;
    [self activationChanged];
}

- (void)installHotKey {
    EventTypeSpec spec = { kEventClassKeyboard, kEventHotKeyPressed };
    OSStatus status = InstallApplicationEventHandler(&GHHotKeyHandler, 1, &spec, (__bridge void *)self, &_hotKeyHandler);
    EventHotKeyID hotKeyId = { .signature = 'GHST', .id = 1 };
    if (status == noErr) status = RegisterEventHotKey(kVK_ANSI_G, optionKey | shiftKey, hotKeyId, GetApplicationEventTarget(), 0, &_hotKey);
    if (status != noErr) GHLog(@"app: could not register the Alt+Shift+G hotkey (status %d)", (int)status);
}

#pragma mark - frontmost app

- (void)appDidActivate:(NSNotification *)notification {
    [self rememberFrontmost:notification.userInfo[NSWorkspaceApplicationKey]];
}

- (void)rememberFrontmost:(NSRunningApplication *)app {
    if (!app || app.processIdentifier == getpid()) return;
    self.frontmostUserApp = app;
}

#pragma mark - server

- (void)pollServer {
    if (!self.client) return;
    __weak GHAppDelegate *weakSelf = self;
    [self.client checkHealthWithCompletion:^(GHServerHealth *health, NSString *errorCode) {
        GHAppDelegate *me = weakSelf;
        if (!me) return;
        BOOL changed = !me->_serverStateKnown || (health == nil) != (me.health == nil) || (health && ![health.provider isEqualToString:me.health.provider]);
        me->_serverStateKnown = YES;
        me.health = health;
        me->_serverErrorCode = errorCode;
        if (changed) GHLog(@"app: server %@", health ? [NSString stringWithFormat:@"online provider=%@", health.provider] : [NSString stringWithFormat:@"offline (%@)", errorCode]);
        [me refreshStatusItem];
        [NSNotificationCenter.defaultCenter postNotificationName:GHServerStatusDidChangeNotification object:me];
        // No point asking an offline server who else is there.
        if (!health) { [me applyPresence:nil]; return; }
        [me.client fetchPresenceWithCompletion:^(GHPresence *presence, NSString *presenceError) { [weakSelf applyPresence:presence]; }];
    }];
}

- (void)applyPresence:(GHPresence *)presence {
    self.presence = presence;
    if (_pipelineRunning && [_pipeline respondsToSelector:@selector(presenceDidChange:)]) [_pipeline presenceDidChange:presence];
}

#pragma mark - status item

+ (NSString *)statusTitleForTrusted:(BOOL)trusted enabled:(BOOL)enabled coreLoaded:(BOOL)coreLoaded
                           provider:(NSString *)provider latencyMs:(NSNumber *)latencyMs {
    if (!coreLoaded) return @"Core bundle missing (run make core)";
    if (!trusted) return @"Needs Accessibility permission";
    if (!enabled) return @"Off";
    if (!provider) return @"On: heuristic only (server offline)";
    if (!latencyMs) return [NSString stringWithFormat:@"On: %@", provider];
    return [NSString stringWithFormat:@"On: %@, %ld ms", provider, (long)latencyMs.integerValue];
}

+ (NSImage *)statusImageActive:(BOOL)active {
    NSImage *image = [NSImage imageWithSize:NSMakeSize(18, 18) flipped:NO drawingHandler:^BOOL(NSRect rect) {
        NSBezierPath *body = [NSBezierPath bezierPath];
        [body moveToPoint:NSMakePoint(3, 2)];
        [body lineToPoint:NSMakePoint(3, 10)];
        [body appendBezierPathWithArcWithCenter:NSMakePoint(9, 10) radius:6 startAngle:180 endAngle:0 clockwise:YES];
        [body lineToPoint:NSMakePoint(15, 2)];
        [body lineToPoint:NSMakePoint(13, 4)];
        [body lineToPoint:NSMakePoint(11, 2)];
        [body lineToPoint:NSMakePoint(9, 4)];
        [body lineToPoint:NSMakePoint(7, 2)];
        [body lineToPoint:NSMakePoint(5, 4)];
        [body closePath];
        [[NSColor blackColor] setFill];
        [[NSColor blackColor] setStroke];
        if (active) {
            [body fill];
            // Eyes are punched out so they take the menu bar's colour.
            [NSGraphicsContext.currentContext setCompositingOperation:NSCompositingOperationDestinationOut];
            [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(5.6, 9, 2.4, 3.2)] fill];
            [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(10, 9, 2.4, 3.2)] fill];
        } else {
            body.lineWidth = 1.2;
            [body stroke];
        }
        return YES;
    }];
    image.template = YES;
    image.accessibilityDescription = active ? @"Ghost is on" : @"Ghost is off";
    return image;
}

- (void)installStatusItem {
    _statusItem = [NSStatusBar.systemStatusBar statusItemWithLength:NSSquareStatusItemLength];
    NSMenu *menu = [[NSMenu alloc] initWithTitle:@"Ghost"];
    menu.delegate = self;
    menu.autoenablesItems = NO;
    _statusItem.menu = menu;
    [self refreshStatusItem];
}

- (BOOL)isActive {
    return self.trusted && self.ghostEnabled && self.core != nil;
}

- (NSString *)statusTitle {
    return [GHAppDelegate statusTitleForTrusted:self.trusted enabled:self.ghostEnabled coreLoaded:self.core != nil
                                       provider:self.health.provider latencyMs:self.health ? self.client.lastLatencyMs : nil];
}

- (NSString *)pipelineLine {
    if (!_pipelineRunning || ![_pipeline respondsToSelector:@selector(statusLine)]) return nil;
    NSString *line = [_pipeline statusLine];
    return line.length ? line : nil;
}

- (NSString *)serverLine {
    if (self.health) return [NSString stringWithFormat:@"Server: %@ (text: %@)", self.health.provider, self.health.textProvider];
    return [NSString stringWithFormat:@"Server: offline%@", _serverErrorCode ? [NSString stringWithFormat:@" (%@)", _serverErrorCode] : @""];
}

- (void)refreshStatusItem {
    _statusItem.button.image = [GHAppDelegate statusImageActive:[self isActive]];
    NSString *pipeline = [self pipelineLine];
    _statusItem.button.toolTip = pipeline ? [NSString stringWithFormat:@"Ghost: %@\n%@", [self statusTitle], pipeline]
                                          : [NSString stringWithFormat:@"Ghost: %@", [self statusTitle]];
    // The menu may be open right now: its lines follow the state live.
    _toggleItem.state = self.ghostEnabled ? NSControlStateValueOn : NSControlStateValueOff;
    _statusInfoItem.title = [self statusTitle];
    _serverInfoItem.title = [self serverLine];
    _pipelineInfoItem.title = pipeline ?: @"";
    _pipelineInfoItem.hidden = pipeline == nil;
}

- (void)pipelineStateDidChange:(NSNotification *)notification {
    [self refreshStatusItem];
}

- (void)menuDidClose:(NSMenu *)menu {
    _toggleItem = _statusInfoItem = _serverInfoItem = _pipelineInfoItem = nil;
}

- (NSMenuItem *)infoItem:(NSString *)title {
    NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:nil keyEquivalent:@""];
    item.enabled = NO;
    return item;
}

- (NSMenuItem *)actionItem:(NSString *)title action:(SEL)action {
    NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:action keyEquivalent:@""];
    item.target = self;
    return item;
}

- (void)menuNeedsUpdate:(NSMenu *)menu {
    // The trust answer can be seconds old; the user is looking right now.
    [self applyTrust:AXIsProcessTrusted() force:NO];
    [menu removeAllItems];

    NSMenuItem *toggle = [self actionItem:@"Enabled" action:@selector(toggleEnabled:)];
    toggle.state = self.ghostEnabled ? NSControlStateValueOn : NSControlStateValueOff;
    toggle.keyEquivalent = @"g";
    toggle.keyEquivalentModifierMask = NSEventModifierFlagOption | NSEventModifierFlagShift;
    [menu addItem:toggle];
    _toggleItem = toggle;
    _statusInfoItem = [self infoItem:[self statusTitle]];
    [menu addItem:_statusInfoItem];

    if (!self.trusted) {
        [menu addItem:[self actionItem:@"Open Accessibility Settings..." action:@selector(openAccessibilitySettings:)]];
    }
    _serverInfoItem = [self infoItem:[self serverLine]];
    [menu addItem:_serverInfoItem];
    NSString *pipeline = [self pipelineLine];
    _pipelineInfoItem = [self infoItem:pipeline ?: @""];
    _pipelineInfoItem.hidden = pipeline == nil;
    [menu addItem:_pipelineInfoItem];

    [menu addItem:[NSMenuItem separatorItem]];
    [self addFrontmostItemsTo:menu];

    [menu addItem:[NSMenuItem separatorItem]];
    [menu addItem:[self actionItem:@"Open profile.json" action:@selector(openProfile:)]];
    [menu addItem:[self actionItem:@"Open settings.json" action:@selector(openSettings:)]];
    [menu addItem:[self actionItem:@"Open demo" action:@selector(openDemo:)]];
    [menu addItem:[self actionItem:@"Open log" action:@selector(openLog:)]];
    NSMenuItem *hud = [self actionItem:@"Debug HUD" action:@selector(toggleHud:)];
    hud.state = self.store.showHud ? NSControlStateValueOn : NSControlStateValueOff;
    [menu addItem:hud];
    NSMenuItem *test = [self actionItem:@"Test buttons" action:@selector(toggleTestPanel:)];
    test.state = _testPanel.visible ? NSControlStateValueOn : NSControlStateValueOff;
    [menu addItem:test];
    [menu addItem:[NSMenuItem separatorItem]];
    NSMenuItem *quit = [[NSMenuItem alloc] initWithTitle:@"Quit Ghost" action:@selector(terminate:) keyEquivalent:@"q"];
    quit.target = NSApp;
    [menu addItem:quit];
}

- (void)addFrontmostItemsTo:(NSMenu *)menu {
    NSRunningApplication *app = self.frontmostUserApp;
    NSString *bundleId = app.bundleIdentifier;
    NSString *name = app.localizedName ?: @"this app";
    if (!bundleId) {
        [menu addItem:[self infoItem:@"No app in front"]];
        return;
    }
    if ([self.presence isExtensionActiveForBundleId:bundleId]) {
        [menu addItem:[self infoItem:[NSString stringWithFormat:@"%@: handled by the extension", name]]];
    }
    if ([self.store isBuiltInPausedBundleId:bundleId]) {
        [menu addItem:[self infoItem:[NSString stringWithFormat:@"Never runs in %@", name]]];
        return;
    }
    BOOL paused = [[self.store userPausedBundleIds] containsObject:bundleId];
    NSMenuItem *pause = [self actionItem:[NSString stringWithFormat:paused ? @"Resume in %@" : @"Pause in %@", name] action:@selector(togglePauseForFrontmost:)];
    pause.representedObject = bundleId;
    [menu addItem:pause];
}

#pragma mark - menu actions

- (void)openAccessibilitySettings:(id)sender {
    [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:kAccessibilityPaneURL]];
}

- (void)openProfile:(id)sender {
    [self.store prepare];
    [NSWorkspace.sharedWorkspace openURL:[NSURL fileURLWithPath:self.store.profilePath]];
}

- (void)openSettings:(id)sender {
    [self.store prepare];
    [NSWorkspace.sharedWorkspace openURL:[NSURL fileURLWithPath:self.store.settingsPath]];
}

- (void)openDemo:(id)sender {
    [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:kDemoURL]];
}

- (void)openLog:(id)sender {
    GHLog(@"app: log opened from the menu");
    GHLogFlush();
    [NSWorkspace.sharedWorkspace openURL:[NSURL fileURLWithPath:GHLogPath()]];
}

@end
