#import "SBAccessibility.h"
#import <AppKit/AppKit.h>
#import "SBLog.h"

static const NSTimeInterval kRescanDelay = 0.150;
static const NSTimeInterval kRescanCeiling = 0.600;
static const NSTimeInterval kTrustPollUntrusted = 1.0;
static const NSTimeInterval kTrustPollTrusted = 3.0;

#pragma mark - SBDebouncer

@implementation SBDebouncer {
    NSTimeInterval _delay;
    NSTimeInterval _ceiling;
    void (^_handler)(NSUInteger);
    NSUInteger _flags;
    NSUInteger _generation;
    NSTimeInterval _burstStart;
    BOOL _pending;
}

- (instancetype)initWithDelay:(NSTimeInterval)delay ceiling:(NSTimeInterval)ceiling handler:(void (^)(NSUInteger))handler {
    if ((self = [super init])) {
        _delay = delay;
        _ceiling = ceiling;
        _handler = [handler copy];
    }
    return self;
}

+ (NSTimeInterval)waitForBurstStartedAt:(NSTimeInterval)firstPoke now:(NSTimeInterval)now delay:(NSTimeInterval)delay ceiling:(NSTimeInterval)ceiling {
    NSTimeInterval untilCeiling = (firstPoke + ceiling) - now;
    return MAX(0, MIN(delay, untilCeiling));
}

- (BOOL)pending {
    return _pending;
}

- (void)poke:(NSUInteger)flags {
    NSTimeInterval now = [NSProcessInfo processInfo].systemUptime;
    if (!_pending) {
        _pending = YES;
        _burstStart = now;
    }
    _flags |= flags;
    NSUInteger generation = ++_generation;
    NSTimeInterval wait = [SBDebouncer waitForBurstStartedAt:_burstStart now:now delay:_delay ceiling:_ceiling];
    __weak SBDebouncer *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(wait * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        [weakSelf fireIfGeneration:generation];
    });
}

- (void)fireIfGeneration:(NSUInteger)generation {
    if (!_pending || generation != _generation) return;
    NSUInteger flags = _flags;
    _flags = 0;
    _pending = NO;
    if (_handler) _handler(flags);
}

- (void)cancel {
    _generation++;
    _flags = 0;
    _pending = NO;
}

@end

#pragma mark - SBAccessibility

@interface SBAccessibility ()
- (void)handleNotification:(NSString *)notification;
@end

static void SBAXObserverCallback(AXObserverRef observer, AXUIElementRef element, CFStringRef notification, void *refcon) {
    // refcon is unretained: -detach removes the observer before the object can go away.
    SBAccessibility *accessibility = (__bridge SBAccessibility *)refcon;
    [accessibility handleNotification:(__bridge NSString *)notification];
}

@implementation SBAccessibility {
    SBDebouncer *_debouncer;
    NSTimer *_trustTimer;
    BOOL _prompted;
    AXObserverRef _observer;
    AXUIElementRef _application;
    NSMutableSet<NSNumber *> *_enhancedPIDs;
    NSURL *_frontmostBundleURL;
}

- (instancetype)init {
    if ((self = [super init])) {
        _trustProbe = ^BOOL { return AXIsProcessTrusted() ? YES : NO; };
        _userPausedBundleIdentifiers = [NSSet set];
        _enhancedPIDs = [NSMutableSet set];
        _lastError = kAXErrorSuccess;
        __weak SBAccessibility *weakSelf = self;
        _debouncer = [[SBDebouncer alloc] initWithDelay:kRescanDelay ceiling:kRescanCeiling handler:^(NSUInteger flags) {
            SBAccessibility *strongSelf = weakSelf;
            if (!strongSelf || !strongSelf.running) return;
            id<SBAccessibilityDelegate> delegate = strongSelf.delegate;
            if ([delegate respondsToSelector:@selector(accessibility:needsRescan:)]) [delegate accessibility:strongSelf needsRescan:(SBRescanReason)flags];
        }];
    }
    return self;
}

- (void)dealloc {
    [self stop];
}

#pragma mark Trust

- (BOOL)trusted {
    return _trustState == SBTrustStateTrusted;
}

- (BOOL)requestTrustWithPromptOnce {
    if (!_prompted) {
        _prompted = YES;
        NSDictionary *options = @{ (__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES };
        AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
        SBLog(@"accessibility: asked the system to show the Accessibility permission prompt");
    }
    [self refreshTrust];
    return self.trusted;
}

/// Returns YES when the state changed.
- (BOOL)refreshTrust {
    SBTrustState next = self.trustProbe() ? SBTrustStateTrusted : SBTrustStateUntrusted;
    if (next == _trustState) return NO;
    _trustState = next;
    SBLog(@"accessibility: %@", next == SBTrustStateTrusted ? @"trusted" : [NSString stringWithFormat:@"NOT trusted (grant %@ in System Settings > Privacy & Security > Accessibility)", SBBundleDisplayName()]);
    if (next == SBTrustStateTrusted) {
        [SBAXElementNode applyMessagingTimeout];
        _lastError = kAXErrorSuccess;
        if (_running) [self attachToFrontmost];
    } else {
        [self detach];
    }
    [self scheduleTrustPoll];
    id<SBAccessibilityDelegate> delegate = self.delegate;
    if ([delegate respondsToSelector:@selector(accessibility:trustDidChange:)]) [delegate accessibility:self trustDidChange:next];
    if (_running) [self setNeedsRescan:SBRescanReasonTrustChanged];
    return YES;
}

- (void)scheduleTrustPoll {
    [_trustTimer invalidate];
    _trustTimer = nil;
    if (!_running) return;
    NSTimeInterval interval = self.trusted ? kTrustPollTrusted : kTrustPollUntrusted;
    __weak SBAccessibility *weakSelf = self;
    _trustTimer = [NSTimer timerWithTimeInterval:interval repeats:YES block:^(NSTimer *timer) {
        SBAccessibility *strongSelf = weakSelf;
        if (!strongSelf) { [timer invalidate]; return; }
        [strongSelf refreshTrust];
    }];
    _trustTimer.tolerance = interval * 0.2;
    [[NSRunLoop mainRunLoop] addTimer:_trustTimer forMode:NSRunLoopCommonModes];
}

/// An AX call failed. -25211 after we were trusted usually means the permission was just revoked.
- (void)noteError:(AXError)error {
    _lastError = error;
    if (error == kAXErrorAPIDisabled) [self refreshTrust];
}

- (NSString *)statusLine {
    if (!self.trusted) return @"Needs Accessibility permission";
    if (self.frontmostIsPaused) return [NSString stringWithFormat:@"Paused in %@", self.frontmostAppName ?: @"this app"];
    if (_frontmostPID == 0) return @"Waiting for an app";
    if (!_observer) return [NSString stringWithFormat:@"Cannot read %@", self.frontmostAppName ?: @"this app"];
    return @"Ready";
}

#pragma mark Lifecycle

- (void)start {
    if (_running) return;
    _running = YES;
    NSNotificationCenter *center = [NSWorkspace sharedWorkspace].notificationCenter;
    [center addObserver:self selector:@selector(applicationActivated:) name:NSWorkspaceDidActivateApplicationNotification object:nil];
    [center addObserver:self selector:@selector(applicationTerminated:) name:NSWorkspaceDidTerminateApplicationNotification object:nil];
    [self adoptApplication:[NSWorkspace sharedWorkspace].frontmostApplication];
    if (![self refreshTrust]) {
        // State did not change (start after stop): the poll and the observer still have to come back.
        [self scheduleTrustPoll];
        if (self.trusted) [self attachToFrontmost];
    }
}

- (void)stop {
    if (!_running) return;
    _running = NO;
    [[NSWorkspace sharedWorkspace].notificationCenter removeObserver:self];
    [_trustTimer invalidate];
    _trustTimer = nil;
    [_debouncer cancel];
    [self detach];
}

#pragma mark Frontmost app

- (void)adoptApplication:(NSRunningApplication *)application {
    _frontmostPID = application ? application.processIdentifier : 0;
    _frontmostBundleIdentifier = [application.bundleIdentifier copy];
    _frontmostAppName = [application.localizedName copy];
    _frontmostBundleURL = application.bundleURL;
}

- (void)applicationActivated:(NSNotification *)note {
    NSRunningApplication *application = note.userInfo[NSWorkspaceApplicationKey];
    if (application.processIdentifier == _frontmostPID && _frontmostPID != 0) return;
    [self detach];
    [self adoptApplication:application];
    id<SBAccessibilityDelegate> delegate = self.delegate;
    if ([delegate respondsToSelector:@selector(accessibilityShouldHideOverlay:reason:)]) [delegate accessibilityShouldHideOverlay:self reason:SBRescanReasonAppChanged];
    if ([delegate respondsToSelector:@selector(accessibilityFrontmostAppDidChange:)]) [delegate accessibilityFrontmostAppDidChange:self];
    if (self.trusted) [self attachToFrontmost];
    [self setNeedsRescan:SBRescanReasonAppChanged];
}

- (void)applicationTerminated:(NSNotification *)note {
    NSRunningApplication *application = note.userInfo[NSWorkspaceApplicationKey];
    [_enhancedPIDs removeObject:@(application.processIdentifier)];
    if (application.processIdentifier != _frontmostPID) return;
    [self detach];
    [self adoptApplication:nil];
}

- (BOOL)frontmostIsPaused {
    return [self isBundleIdentifierPaused:_frontmostBundleIdentifier];
}

- (BOOL)observing {
    return _observer != NULL;
}

- (void)setUserPausedBundleIdentifiers:(NSSet<NSString *> *)identifiers {
    _userPausedBundleIdentifiers = [identifiers copy] ?: [NSSet set];
    if (!_running) return;
    // Pausing the frontmost app must take effect now, and so must un-pausing it.
    if (self.frontmostIsPaused) {
        [self detach];
        id<SBAccessibilityDelegate> delegate = self.delegate;
        if ([delegate respondsToSelector:@selector(accessibilityShouldHideOverlay:reason:)]) [delegate accessibilityShouldHideOverlay:self reason:SBRescanReasonAppChanged];
    } else if (self.trusted && !_observer) {
        [self attachToFrontmost];
    }
    [self setNeedsRescan:SBRescanReasonManual];
}

#pragma mark Observer

- (void)attachToFrontmost {
    [self detach];
    if (!self.trusted || _frontmostPID == 0 || self.frontmostIsPaused) return;
    if (_frontmostPID == [NSProcessInfo processInfo].processIdentifier) return;

    _application = AXUIElementCreateApplication(_frontmostPID);
    if (!_application) return;
    AXUIElementSetMessagingTimeout(_application, SBAXMessagingTimeoutSeconds);
    [self exposeWebTreeIfNeeded];

    AXObserverRef observer = NULL;
    AXError error = AXObserverCreate(_frontmostPID, SBAXObserverCallback, &observer);
    if (error != kAXErrorSuccess || !observer) {
        SBLog(@"accessibility: cannot observe %@ (AXError %d)", _frontmostBundleIdentifier ?: @"?", (int)error);
        [self noteError:error];
        return;
    }
    _observer = observer;
    NSUInteger registered = 0;
    for (NSString *notification in [SBAccessibility observedNotifications]) {
        AXError added = AXObserverAddNotification(_observer, _application, (__bridge CFStringRef)notification, (__bridge void *)self);
        if (added == kAXErrorSuccess || added == kAXErrorNotificationAlreadyRegistered) registered++;
        else if (added == kAXErrorAPIDisabled) {
            [self noteError:added];
            [self detach];
            return;
        }
    }
    CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(_observer), kCFRunLoopCommonModes);
    _lastError = kAXErrorSuccess;
    SBLog(@"accessibility: observing %@ (%lu notifications)", _frontmostBundleIdentifier ?: @"?", (unsigned long)registered);
}

- (void)detach {
    if (_observer) {
        CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(_observer), kCFRunLoopCommonModes);
        if (_application) {
            for (NSString *notification in [SBAccessibility observedNotifications]) {
                AXObserverRemoveNotification(_observer, _application, (__bridge CFStringRef)notification);
            }
        }
        CFRelease(_observer);
        _observer = NULL;
    }
    if (_application) {
        CFRelease(_application);
        _application = NULL;
    }
}

/// Chromium builds its web accessibility tree only when it believes assistive technology is present.
- (void)exposeWebTreeIfNeeded {
    NSNumber *pid = @(_frontmostPID);
    if ([_enhancedPIDs containsObject:pid]) return;
    if (![SBAccessibility appNeedsEnhancedUserInterface:_frontmostBundleIdentifier bundleURL:_frontmostBundleURL]) return;
    AXError enhanced = AXUIElementSetAttributeValue(_application, CFSTR("AXEnhancedUserInterface"), kCFBooleanTrue);
    AXError manual = AXUIElementSetAttributeValue(_application, CFSTR("AXManualAccessibility"), kCFBooleanTrue);
    if (enhanced == kAXErrorAPIDisabled || manual == kAXErrorAPIDisabled) return; // not trusted after all: try again later
    [_enhancedPIDs addObject:pid];
    SBLog(@"accessibility: asked %@ for its web tree (enhanced %d, manual %d)", _frontmostBundleIdentifier ?: @"?", (int)enhanced, (int)manual);
}

- (BOOL)frontmostNeedsEnhancedUserInterface {
    return [SBAccessibility appNeedsEnhancedUserInterface:_frontmostBundleIdentifier bundleURL:_frontmostBundleURL];
}

- (void)handleNotification:(NSString *)notification {
    if (!_running) return;
    SBRescanReason reason = [SBAccessibility reasonForNotification:notification];
    if (reason == SBRescanReasonNone) return;
    id<SBAccessibilityDelegate> delegate = self.delegate;
    if (reason & (SBRescanReasonWindowChanged | SBRescanReasonWindowGeometry)) {
        if ([delegate respondsToSelector:@selector(accessibilityShouldHideOverlay:reason:)]) [delegate accessibilityShouldHideOverlay:self reason:reason];
    }
    if (reason & SBRescanReasonFocusChanged) {
        if ([delegate respondsToSelector:@selector(accessibilityFocusedElementDidChange:)]) [delegate accessibilityFocusedElementDidChange:self];
    }
    [_debouncer poke:reason];
}

- (void)setNeedsRescan:(SBRescanReason)reason {
    if (!_running) return;
    [_debouncer poke:reason];
}

+ (NSArray<NSString *> *)observedNotifications {
    return @[
        (__bridge NSString *)kAXFocusedWindowChangedNotification,
        (__bridge NSString *)kAXMainWindowChangedNotification,
        (__bridge NSString *)kAXFocusedUIElementChangedNotification,
        (__bridge NSString *)kAXValueChangedNotification,
        (__bridge NSString *)kAXLayoutChangedNotification,
        (__bridge NSString *)kAXWindowMovedNotification,
        (__bridge NSString *)kAXWindowResizedNotification,
        (__bridge NSString *)kAXUIElementDestroyedNotification,
        (__bridge NSString *)kAXTitleChangedNotification,
        @"AXLoadComplete",
    ];
}

+ (SBRescanReason)reasonForNotification:(NSString *)notification {
    static NSDictionary<NSString *, NSNumber *> *reasons;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        reasons = @{
            (__bridge NSString *)kAXFocusedWindowChangedNotification: @(SBRescanReasonWindowChanged),
            (__bridge NSString *)kAXMainWindowChangedNotification: @(SBRescanReasonWindowChanged),
            (__bridge NSString *)kAXFocusedUIElementChangedNotification: @(SBRescanReasonFocusChanged),
            (__bridge NSString *)kAXValueChangedNotification: @(SBRescanReasonValueChanged),
            (__bridge NSString *)kAXLayoutChangedNotification: @(SBRescanReasonLayoutChanged),
            (__bridge NSString *)kAXWindowMovedNotification: @(SBRescanReasonWindowGeometry),
            (__bridge NSString *)kAXWindowResizedNotification: @(SBRescanReasonWindowGeometry),
            (__bridge NSString *)kAXUIElementDestroyedNotification: @(SBRescanReasonElementGone),
            (__bridge NSString *)kAXTitleChangedNotification: @(SBRescanReasonPageLoaded), // tab switch or navigation
            @"AXLoadComplete": @(SBRescanReasonPageLoaded),
        };
    });
    return (SBRescanReason)reasons[notification ?: @""].unsignedIntegerValue;
}

#pragma mark Live reads

- (BOOL)mayRead {
    return _running && self.trusted && _application != NULL && !self.frontmostIsPaused;
}

- (id<SBAXNode>)copyNodeAttribute:(CFStringRef)attribute of:(AXUIElementRef)element {
    CFTypeRef value = NULL;
    AXError error = AXUIElementCopyAttributeValue(element, attribute, &value);
    if (error != kAXErrorSuccess || !value) {
        if (error != kAXErrorNoValue && error != kAXErrorSuccess) [self noteError:error];
        return nil;
    }
    id<SBAXNode> node = nil;
    if (CFGetTypeID(value) == AXUIElementGetTypeID()) node = [SBAXElementNode nodeWithElement:(AXUIElementRef)value];
    CFRelease(value);
    return node;
}

- (id<SBAXNode>)focusedWindowNode {
    if (![self mayRead]) return nil;
    id<SBAXNode> window = [self copyNodeAttribute:kAXFocusedWindowAttribute of:_application];
    if (!window && [self mayRead]) window = [self copyNodeAttribute:kAXMainWindowAttribute of:_application];
    return window;
}

- (id<SBAXNode>)focusedElementNode {
    if (![self mayRead]) return nil;
    return [self copyNodeAttribute:kAXFocusedUIElementAttribute of:_application];
}

- (NSString *)focusedWindowTitle {
    return [self focusedWindowNode].title;
}

- (NSString *)originOfWebAreaNode:(id<SBAXNode>)webArea {
    AXUIElementRef element = webArea.axElement;
    if (!element || ![self mayRead]) return nil;
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(element, CFSTR("AXURL"), &value) != kAXErrorSuccess || !value) return nil;
    id object = CFBridgingRelease(value);
    NSURL *url = [object isKindOfClass:[NSURL class]] ? object : ([object isKindOfClass:[NSString class]] ? [NSURL URLWithString:object] : nil);
    if (url.scheme.length == 0 || url.host.length == 0) return nil;
    NSString *origin = [NSString stringWithFormat:@"%@://%@", url.scheme.lowercaseString, url.host.lowercaseString];
    return url.port ? [origin stringByAppendingFormat:@":%@", url.port] : origin;
}

- (SBCaptureResult *)captureFocusedWindowWithCapture:(SBCapture *)capture {
    id<SBAXNode> window = [self focusedWindowNode];
    if (!window) return nil;
    SBCaptureResult *result = [capture captureWindow:window];
    if (result.partial) {
        SBLog(@"accessibility: partial capture of %@: %lu nodes, %lu fields, %.0f ms, stop %ld",
              _frontmostBundleIdentifier ?: @"?", (unsigned long)result.visitedNodes, (unsigned long)result.fields.count,
              result.elapsed * 1000.0, (long)result.stop);
    }
    return result;
}

#pragma mark Pause list

+ (NSSet<NSString *> *)defaultPausedBundleIdentifiers {
    static NSSet<NSString *> *identifiers;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        identifiers = [NSSet setWithArray:@[
            // Password managers.
            @"com.1password.1password", @"com.agilebits.onepassword7", @"com.agilebits.onepassword-osx",
            @"com.bitwarden.desktop", @"com.lastpass.LastPass", @"com.lastpass.lastpassmacdesktop",
            @"com.dashlane.Dashlane", @"com.dashlane.dashlanephonefinal", @"org.keepassxc.keepassxc",
            @"me.proton.pass.electron", @"in.sinew.Enpass-Desktop", @"com.nordpass.macos.NordPass",
            @"com.callpod.keepermac.lite", @"com.markmcguill.strongbox.mac",
            // Terminals: Tab is completion there, and the screen is full of secrets.
            @"com.apple.Terminal", @"com.googlecode.iterm2", @"dev.warp.Warp-Stable", @"com.github.wez.wezterm",
            @"net.kovidgoyal.kitty", @"co.zeit.hyper", @"com.mitchellh.ghostty", @"org.alacritty",
            // System security surfaces.
            @"com.apple.keychainaccess", @"com.apple.systempreferences", @"com.apple.Passwords", @"com.apple.loginwindow",
            @"com.apple.SecurityAgent", @"com.apple.LocalAuthentication.UIAgent",
            // Shabang itself.
            @"dev.shabang.desktop",
        ]];
    });
    return identifiers;
}

+ (NSArray<NSString *> *)defaultPausedBundlePrefixes {
    return @[ @"com.1password.", @"com.agilebits.onepassword", @"com.bitwarden.", @"com.lastpass.", @"com.dashlane.", @"org.keepassxc." ];
}

- (BOOL)isBundleIdentifierPaused:(NSString *)bundleIdentifier {
    // No bundle id means we cannot tell what it is: stay out.
    if (bundleIdentifier.length == 0) return YES;
    NSString *own = [NSBundle mainBundle].bundleIdentifier;
    if (own.length && [bundleIdentifier caseInsensitiveCompare:own] == NSOrderedSame) return YES;
    for (NSSet<NSString *> *set in @[ [SBAccessibility defaultPausedBundleIdentifiers], self.userPausedBundleIdentifiers ?: [NSSet set] ]) {
        for (NSString *paused in set) {
            if ([bundleIdentifier caseInsensitiveCompare:paused] == NSOrderedSame) return YES;
        }
    }
    NSString *lower = bundleIdentifier.lowercaseString;
    for (NSString *prefix in [SBAccessibility defaultPausedBundlePrefixes]) {
        if ([lower hasPrefix:prefix.lowercaseString]) return YES;
    }
    return NO;
}

#pragma mark Chromium and Electron

+ (NSSet<NSString *> *)chromiumBundleIdentifiers {
    static NSSet<NSString *> *identifiers;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        identifiers = [NSSet setWithArray:@[
            @"com.google.Chrome", @"com.google.Chrome.beta", @"com.google.Chrome.dev", @"com.google.Chrome.canary",
            @"com.brave.Browser", @"com.brave.Browser.beta", @"com.brave.Browser.nightly",
            @"com.microsoft.edgemac", @"com.microsoft.edgemac.Beta", @"com.microsoft.edgemac.Dev",
            @"company.thebrowser.Browser", @"company.thebrowser.dia",
            @"com.operasoftware.Opera", @"com.operasoftware.OperaGX", @"com.vivaldi.Vivaldi", @"org.chromium.Chromium",
        ]];
    });
    return identifiers;
}

/// Frameworks that mean "this window is really Chromium". Electron apps ship one; so do CEF apps, which is
/// what Spotify, and most music and chat clients that are not Electron, actually are. Both build their
/// accessibility tree only when asked, so both need the same two attributes set.
+ (NSArray<NSString *> *)chromiumFrameworkPaths {
    return @[ @"Contents/Frameworks/Electron Framework.framework",
              @"Contents/Frameworks/Chromium Embedded Framework.framework" ];
}

+ (BOOL)bundleAtURLUsesChromium:(NSURL *)bundleURL {
    if (!bundleURL.isFileURL) return NO;
    static NSMutableDictionary<NSString *, NSNumber *> *cache;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ cache = [NSMutableDictionary dictionary]; });
    NSString *path = bundleURL.path;
    @synchronized (cache) {
        NSNumber *known = cache[path];
        if (known) return known.boolValue;
    }
    BOOL chromium = NO;
    for (NSString *framework in [self chromiumFrameworkPaths]) {
        if ([[NSFileManager defaultManager] fileExistsAtPath:[path stringByAppendingPathComponent:framework]]) { chromium = YES; break; }
    }
    @synchronized (cache) { cache[path] = @(chromium); }
    return chromium;
}

+ (BOOL)appNeedsEnhancedUserInterface:(NSString *)bundleIdentifier bundleURL:(NSURL *)bundleURL {
    if (bundleIdentifier.length) {
        for (NSString *known in [self chromiumBundleIdentifiers]) {
            if ([bundleIdentifier caseInsensitiveCompare:known] == NSOrderedSame) return YES;
        }
    }
    return [self bundleAtURLUsesChromium:bundleURL];
}

@end
