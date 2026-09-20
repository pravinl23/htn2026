#import "SBAppDelegate.h"
#import "SBController.h"
#import "SBCore.h"
#import "SBHarness.h"
#import "SBLog.h"
#import "SBProfileStore.h"
#import "SBServerClient.h"
#import "SBTestPanel.h"
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>

NSNotificationName const SBTrustDidChangeNotification = @"SBTrustDidChangeNotification";
NSNotificationName const SBActivationDidChangeNotification = @"SBActivationDidChangeNotification";
NSNotificationName const SBServerStatusDidChangeNotification = @"SBServerStatusDidChangeNotification";

static NSString *const kDemoURL = @"http://localhost:5173";
static NSString *const kAccessibilityPaneURL = @"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
static const NSTimeInterval kTrustPollUntrusted = 1.5;
static const NSTimeInterval kTrustPollTrusted = 10.0;
static const NSTimeInterval kServerPoll = 15.0;
static const NSTimeInterval kLaunchRequestWarmUp = 2.0;   // pipeline start + first capture + offline ghosts

@interface SBAppDelegate ()
@property (nonatomic, readwrite, nullable) SBCore *core;
@property (nonatomic, readwrite, nullable) SBProfileStore *store;
@property (nonatomic, readwrite, nullable) SBServerClient *client;
@property (nonatomic, readwrite) BOOL trusted;
@property (nonatomic, readwrite, nullable) SBServerHealth *health;
@property (nonatomic, readwrite, nullable) SBPresence *presence;
@property (nonatomic, readwrite, nullable) NSRunningApplication *frontmostUserApp;
- (void)hotKeyPressed;
@end

static OSStatus SBHotKeyHandler(EventHandlerCallRef next, EventRef event, void *userData) {
    SBAppDelegate *delegate = (__bridge SBAppDelegate *)userData;
    dispatch_async(dispatch_get_main_queue(), ^{ [delegate hotKeyPressed]; });
    return noErr;
}

@implementation SBAppDelegate {
    NSStatusItem *_statusItem;
    NSTimer *_trustTimer;
    NSTimer *_serverTimer;
    id<SBDesktopPipeline> _pipeline;
    BOOL _pipelineRunning;
    BOOL _pipelineLookupLogged;
    EventHotKeyRef _hotKey;
    EventHandlerRef _hotKeyHandler;
    NSString *_serverErrorCode;
    BOOL _serverStateKnown;
    SBHarnessServer *_harnessServer;
    // Items of the menu that is open right now, so their titles follow the state while the user is looking.
    NSMenuItem *_toggleItem;
    NSMenuItem *_statusInfoItem;
    NSMenuItem *_serverInfoItem;
    NSMenuItem *_pipelineInfoItem;
    SBTestPanel *_testPanel;
}

#pragma mark - launch

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    SBLog(@"app: launched pid=%d", getpid());
    self.core = [SBCore sharedCore];
    self.store = [[SBProfileStore alloc] initWithCore:self.core];
    [self.store prepare];
    [self.store startWatching];
    if (self.core) {
        NSString *cachePath = [self.store.directory stringByAppendingPathComponent:@"form-cache.json"];
        self.client = [[SBServerClient alloc] initWithBaseURLString:self.store.serverURLString core:self.core configuration:nil
                                                              cache:[[SBFormCache alloc] initWithPath:cachePath]];
    }

    [self installStatusItem];
    [self installHotKey];

    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    [center addObserver:self selector:@selector(storeDidChange:) name:SBProfileStoreDidChangeNotification object:self.store];
    [center addObserver:self selector:@selector(pipelineStateDidChange:) name:SBControllerStateDidChangeNotification object:nil];
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
    SBLog(@"app: quit");
    SBLogFlush();
}

- (BOOL)ghostEnabled {
    return self.store ? self.store.enabled : NO;
}

#pragma mark - trust

/// Nothing but this check (and the menu) happens while untrusted: every AX call would return -25211.
- (void)checkTrustPrompting:(BOOL)prompt {
    BOOL trusted = AXIsProcessTrusted();
    if (!trusted && prompt && !getenv("SHABANG_NO_PROMPT")) {
        // Once per launch: shows the system dialog that leads to Privacy & Security -> Accessibility.
        NSDictionary *options = @{ (__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES };
        trusted = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
        SBLog(@"app: not trusted for Accessibility yet; asked the system to show the permission prompt");
    }
    if (prompt) SBLog(@"app: accessibility trusted=%d at launch", trusted);
    [self applyTrust:trusted force:prompt];
}

- (void)applyTrust:(BOOL)trusted force:(BOOL)force {
    BOOL changed = trusted != self.trusted;
    self.trusted = trusted;
    if (changed || force) {
        if (changed) SBLog(@"app: accessibility trusted=%d", trusted);
        [self scheduleTrustTimer];
        [self syncPipeline];
        [self refreshStatusItem];
        if (changed) [NSNotificationCenter.defaultCenter postNotificationName:SBTrustDidChangeNotification object:self userInfo:@{ @"trusted": @(trusted) }];
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
        for (NSString *name in @[ NSStringFromClass([SBController class]), @"SBPipeline" ]) {
            Class cls = NSClassFromString(name);
            if (!cls || ![cls instancesRespondToSelector:@selector(initWithCore:store:client:)]) continue;
            if (![cls instancesRespondToSelector:@selector(start)] || ![cls instancesRespondToSelector:@selector(stop)]) continue;
            _pipeline = [(id<SBDesktopPipeline>)[cls alloc] initWithCore:self.core store:self.store client:self.client];
            SBLog(@"app: pipeline class %@ found", name);
            break;
        }
    }
    if (!_pipeline) {
        if (!_pipelineLookupLogged) SBLog(@"app: no pipeline class in this build (SBController); menu and services only");
        _pipelineLookupLogged = YES;
        return;
    }
    [_pipeline start];
    _pipelineRunning = YES;
    if ([_pipeline respondsToSelector:@selector(presenceDidChange:)]) [_pipeline presenceDidChange:self.presence];
    SBLog(@"app: pipeline started");
}

- (void)stopPipeline {
    if (!_pipelineRunning) return;
    [_pipeline stop];
    _pipelineRunning = NO;
    SBLog(@"app: pipeline stopped");
}

#pragma mark - harness

- (SBController *)harnessController {
    return _pipelineRunning && [_pipeline isKindOfClass:[SBController class]] ? (SBController *)_pipeline : nil;
}

- (void)startHarness {
#if SHABANG_NO_HARNESS
    return;   // the installed library: no request folder, no autotab (make install-lib)
#endif
    if (!self.harnessChannel) return;
    __weak SBAppDelegate *weakSelf = self;
    _harnessServer = [[SBHarnessServer alloc] initWithChannel:self.harnessChannel controller:^SBController *{ return [weakSelf harnessController]; }];
    [_harnessServer start];
    SBHarnessRequest *request = self.launchRequest;
    if (!request) return;
    // This agent exists for one --autotab: give the pipeline time to see the window, run, answer, quit.
    request.delay = MAX(request.delay, kLaunchRequestWarmUp);
    SBLog(@"harness: request mode=%@ id=%@ (agent launched for it)", request.mode, request.identifier);
    __block BOOL answered = NO;
    void (^answer)(NSDictionary<NSString *, id> *) = ^(NSDictionary<NSString *, id> *response) {
        if (answered) return;
        answered = YES;
        NSMutableDictionary<NSString *, id> *out = [response mutableCopy];
        out[@"mode"] = request.mode;
        out[@"agent"] = @"standalone";
        SBHarnessWriteResponse(out, request.outPath);
        SBLog(@"harness: answered mode=%@ id=%@ error=%@", request.mode, request.identifier, response[@"error"] ?: @"none");
        [NSApp terminate:nil];
    };
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(request.deadline * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        answer(SBHarnessErrorResponse(@"timeout", nil));
    });
    [SBHarness performRequest:request controller:[self harnessController] completion:answer];
}

#pragma mark - enable, pause

/// The provider / latency / cache readout along the bottom of the screen. It is a developer's instrument, not
/// part of the product, so it is off unless somebody asks for it. The controller picks the change up live.
- (void)toggleHud:(id)sender {
    [self.store updateSettings:@{ @"showHud": @(!self.store.showHud) } error:NULL];
}

/// Two buttons that do the thing a second from now, so an accept that fails can be told apart from a key that
/// never arrived (SBTestPanel). Off by default; nothing is installed until it is asked for.
- (void)toggleTestPanel:(id)sender {
    if (!_testPanel) {
        // The pipeline is looked up at run time and is only a protocol here; the panel needs the real thing.
        if (![(id)_pipeline isKindOfClass:[SBController class]]) return;
        _testPanel = [[SBTestPanel alloc] initWithController:(SBController *)_pipeline];
    }
    [_testPanel toggle];
}

- (void)toggleEnabled:(id)sender {
    BOOL enabled = !self.ghostEnabled;
    [self.store setEnabled:enabled];
    SBLog(@"app: enabled=%d", enabled);
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
    SBLog(@"app: %@ in %@", paused ? @"resumed" : @"paused", bundleId);
    [self activationChanged];
}

- (void)activationChanged {
    [self syncPipeline];
    [self refreshStatusItem];
    [NSNotificationCenter.defaultCenter postNotificationName:SBActivationDidChangeNotification object:self];
}

- (void)storeDidChange:(NSNotification *)notification {
    self.client.baseURLString = self.store.serverURLString;
    [self activationChanged];
}

- (void)installHotKey {
    EventTypeSpec spec = { kEventClassKeyboard, kEventHotKeyPressed };
    OSStatus status = InstallApplicationEventHandler(&SBHotKeyHandler, 1, &spec, (__bridge void *)self, &_hotKeyHandler);
    EventHotKeyID hotKeyId = { .signature = 'SBST', .id = 1 };
    if (status == noErr) status = RegisterEventHotKey(kVK_ANSI_G, optionKey | shiftKey, hotKeyId, GetApplicationEventTarget(), 0, &_hotKey);
    if (status != noErr) SBLog(@"app: could not register the Alt+Shift+G hotkey (status %d)", (int)status);
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
    __weak SBAppDelegate *weakSelf = self;
    [self.client checkHealthWithCompletion:^(SBServerHealth *health, NSString *errorCode) {
        SBAppDelegate *me = weakSelf;
        if (!me) return;
        BOOL changed = !me->_serverStateKnown || (health == nil) != (me.health == nil) || (health && ![health.provider isEqualToString:me.health.provider]);
        me->_serverStateKnown = YES;
        me.health = health;
        me->_serverErrorCode = errorCode;
        if (changed) SBLog(@"app: server %@", health ? [NSString stringWithFormat:@"online provider=%@", health.provider] : [NSString stringWithFormat:@"offline (%@)", errorCode]);
        [me refreshStatusItem];
        [NSNotificationCenter.defaultCenter postNotificationName:SBServerStatusDidChangeNotification object:me];
        // No point asking an offline server who else is there.
        if (!health) { [me applyPresence:nil]; return; }
        [me.client fetchPresenceWithCompletion:^(SBPresence *presence, NSString *presenceError) { [weakSelf applyPresence:presence]; }];
    }];
}

- (void)applyPresence:(SBPresence *)presence {
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

/**
 * The mark, as a menu-bar TEMPLATE image: macOS reads only its alpha and tints it for the menu bar, so it is
 * black on a light bar and white on a dark one, and it follows the bar's own contrast settings. Embedded as
 * base64 rather than read from the bundle because the library is loaded from Application Support and must not
 * depend on where the host app happens to live.
 */
static NSString *SBMarkPNGBase64(void) {
    return @""
    "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";
}

+ (NSImage *)statusImageActive:(BOOL)active {
    static NSImage *mark;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSData *png = [[NSData alloc] initWithBase64EncodedString:SBMarkPNGBase64() options:0];
        mark = png.length ? [[NSImage alloc] initWithData:png] : nil;
        mark.size = NSMakeSize(18, 18);
    });
    if (!mark) return nil;
    // On: the mark at full strength. Off: the same mark, faded -- the shape never changes, so the icon stays
    // recognisable as this product whether or not it is running.
    NSImage *image = active ? [mark copy] : [NSImage imageWithSize:NSMakeSize(18, 18) flipped:NO drawingHandler:^BOOL(NSRect rect) {
        [mark drawInRect:rect fromRect:NSZeroRect operation:NSCompositingOperationSourceOver fraction:0.35];
        return YES;
    }];
    image.template = YES;
    image.accessibilityDescription = [NSString stringWithFormat:active ? @"%@ is on" : @"%@ is off", SBProductName];
    return image;
}

- (void)installStatusItem {
    _statusItem = [NSStatusBar.systemStatusBar statusItemWithLength:NSSquareStatusItemLength];
    NSMenu *menu = [[NSMenu alloc] initWithTitle:SBProductName];
    menu.delegate = self;
    menu.autoenablesItems = NO;
    _statusItem.menu = menu;
    [self refreshStatusItem];
}

- (BOOL)isActive {
    return self.trusted && self.ghostEnabled && self.core != nil;
}

- (NSString *)statusTitle {
    return [SBAppDelegate statusTitleForTrusted:self.trusted enabled:self.ghostEnabled coreLoaded:self.core != nil
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
    _statusItem.button.image = [SBAppDelegate statusImageActive:[self isActive]];
    NSString *pipeline = [self pipelineLine];
    _statusItem.button.toolTip = pipeline ? [NSString stringWithFormat:@"%@: %@\n%@", SBProductName, [self statusTitle], pipeline]
                                          : [NSString stringWithFormat:@"%@: %@", SBProductName, [self statusTitle]];
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
    NSMenuItem *quit = [[NSMenuItem alloc] initWithTitle:@"Quit Shabang" action:@selector(terminate:) keyEquivalent:@"q"];
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
    SBLog(@"app: log opened from the menu");
    SBLogFlush();
    [NSWorkspace.sharedWorkspace openURL:[NSURL fileURLWithPath:SBLogPath()]];
}

@end
