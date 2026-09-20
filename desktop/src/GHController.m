#import "GHController.h"
#import "GHCapture.h"
#import "GHComboBoxDriver.h"
#import "GHCore.h"
#import "GHKeyPoster.h"
#import "GHLog.h"
#import "GHOpenPanelDriver.h"
#import "GHNextAction.h"
#import "GHOverlayWindow.h"
#import "GHPageContext.h"
#import "GHProfileStore.h"
#import "GHWriter.h"

NSNotificationName const GHControllerStateDidChangeNotification = @"GHControllerStateDidChangeNotification";

const NSTimeInterval GHDraftWaitSeconds = 4.0;
const NSUInteger GHMaxConcurrentDrafts = 3;

static NSString *const kNeedsText = @"needs_text";
static NSString *const kOfflineProvider = @"offline-heuristic";
static NSString *const kDraftingText = @"Drafting...";
static const NSUInteger kMaxFormsPerPage = 6;
static const NSUInteger kMinFormFields = 2;
static const NSUInteger kDraftMaxChars = 600;
static const NSTimeInterval kSettleSeconds = 0.4;          // an upgrade may still replace a ghost nobody looked at yet
static const NSTimeInterval kOwnWriteQuietSeconds = 0.4;   // value-changed notifications caused by our own write
static const NSUInteger kChromiumMaxNodes = 4000;
static const NSTimeInterval kChromiumWebAreaBudget = 1.6;
static const NSTimeInterval kValueRescanSpacing = 0.5;
static const NSTimeInterval kScrollSettleSeconds = 0.06;
static const NSTimeInterval kDraftRenderSpacing = 0.08;
static const NSUInteger kFocusClimb = 3;
static const NSUInteger kPageContextNodes = 1500;   // a live AX walk on the main thread: bounded, once per page
static const NSTimeInterval kScrollSettleFirst = 0.12;   // a page that scrolls smoothly has not moved yet right after
static const NSTimeInterval kScrollSettleLast = 0.4;     // AXScrollToVisible: its rects are read again twice
static NSString *const kUploadNotVerified = @"upload-not-verified";
// Live, Safari: Greenhouse uploads the file to its storage before the widget names it or grows a Remove button, so
// one look right after the panel closed says "not attached" for an upload that worked. The check is repeated.
static const NSTimeInterval kUploadVerifyPoll = 0.35;
static const NSUInteger kUploadVerifyTries = 8;

/// One free-text draft. The text stays in memory and is never logged.
@interface GHDraft : NSObject
@property (nonatomic, copy) NSString *signature;
@property (nonatomic) double confidence;
@property (nonatomic, strong) NSMutableString *text;
@property (nonatomic) BOOL started;
@property (nonatomic) BOOL finished;
@property (nonatomic) BOOL failed;
@property (nonatomic, strong, nullable) GHGhostTextStream *stream;
@end

@implementation GHDraft
@end

@interface GHController ()
/// What the event tap thread reaches for every untagged key-down (the writer's drivers abort on it).
@property (atomic, strong, nullable) GHWriter *keyRelayWriter;
@end

@implementation GHController {
    GHCore *_core;
    GHProfileStore *_store;
    GHServerClient *_client;
    GHPresence *_presence;
    BOOL _ownsOverlay;

    // The last capture.
    GHCaptureResult *_result;
    NSArray<GHField *> *_orderedFields;
    NSDictionary<NSString *, GHField *> *_fields;
    NSString *_pageKey;
    NSString *_origin;

    // Prediction (cache -> server), once per form.
    NSMutableSet<NSString *> *_asked;
    NSMutableDictionary<NSString *, NSDictionary *> *_served;
    NSMutableSet<NSString *> *_pinned;
    NSString *_factsId;
    NSUInteger _epoch;
    NSString *_cacheState;      // hit | miss | offline
    NSNumber *_latencyMs;
    CFAbsoluteTime _shownAt;

    // Drafts.
    NSMutableDictionary<NSString *, GHDraft *> *_drafts;
    BOOL _draftRenderQueued;

    // The accept queue.
    NSInteger _pendingTabs;
    BOOL _drainIsRepeat;
    BOOL _stepMayHandBack;   // the first step of a fresh, unqueued press: a Tab that was not Ghost's goes back to the app
    BOOL _stepDirect;        // the step in flight follows the user's press at once (no draft wait, no sequence)
    BOOL _rescanDeferred;
    NSString *_walkBundleId;   // the app whose window the walk belongs to (live captures only)
    NSString *_waitingDraft;
    void (^_waitContinuation)(BOOL ready);
    NSUInteger _waitToken;

    CFAbsoluteTime _quietUntil;
    CFAbsoluteTime _lastRescanAt;
    NSUInteger _scrollGeneration;
    NSString *_lastStatusLine;
    NSString *_lastRescanLog;
    CFAbsoluteTime _stepStartedAt;

    // The answer engine and the gate (docs/answers.md, docs/incremental.md).
    NSString *_gateReason;                     // "2 required fields still empty: Country"; nil when nothing is unmet
    NSMutableDictionary<NSString *, NSString *> *_seenValues;   // the last capture's values, to spot a user edit
    NSMutableDictionary<NSString *, NSString *> *_ghostWrote;   // what GHOST put there: never a correction
    NSUInteger _correctionCount;
    NSString *_lastCorrectionCounter;           // the value-free telemetry counter of the last correction

    // Sequences (uploads, lazy selects) and the jump.
    NSMutableSet<NSString *> *_sequenceDone;   // accepted through a driver on this page: never offered again
    NSString *_jumpFailedSignature;            // AXScrollToVisible could not bring this ghost on screen
    NSDictionary<NSString *, NSString *> *_pageContext;   // company / role / description, once per page
    BOOL _pageContextRead;
    // docs/anywhere.md: what Ghost offers when the window is not a form. Built on first use, because most
    // windows never need it and the memory file should not be touched before it is.
    GHNextAction *_nextAction;
    GHNextProposal *_proposal;          // the one on offer right now (nil when the walk is a form walk)
    NSString *_previousRole;            // the role of the last action the user took in this page view
}

@synthesize eventTap = _eventTap;
@synthesize writer = _writer;

- (instancetype)initWithCore:(GHCore *)core store:(GHProfileStore *)store client:(GHServerClient *)client {
    if ((self = [super init])) {
        _core = core;
        _store = store;
        _client = client;
        _walk = [[GHWalkState alloc] init];
        _asked = [NSMutableSet set];
        _served = [NSMutableDictionary dictionary];
        _pinned = [NSMutableSet set];
        _drafts = [NSMutableDictionary dictionary];
        _factsId = @"";
        _cacheState = @"offline";
        _provider = kOfflineProvider;
        _orderedFields = @[];
        _fields = @{};
        _sequenceDone = [NSMutableSet set];
        _seenValues = [NSMutableDictionary dictionary];
        _ghostWrote = [NSMutableDictionary dictionary];
    }
    return self;
}

- (void)dealloc {
    [NSNotificationCenter.defaultCenter removeObserver:self];
}

#pragma mark - parts

- (GHAccessibility *)accessibility {
    if (!_accessibility) _accessibility = [[GHAccessibility alloc] init];
    return _accessibility;
}

- (GHCapture *)capture {
    if (!_capture) {
        _capture = [[GHCapture alloc] initWithSafety:_core];
        // The extension walks the whole form, not only what is on screen. Nothing off screen is ever written to:
        // Tab is only consumed while the current ghost is visible, and the rect is re-read before every write.
        _capture.keepsScrolledOutFields = YES;
    }
    return _capture;
}

- (GHEventTap *)eventTap {
    if (!_eventTap) self.eventTap = [[GHEventTap alloc] init];
    return _eventTap;
}

- (void)setEventTap:(GHEventTap *)eventTap {
    _eventTap = eventTap;
    eventTap.delegate = self;
    // The tap thread: flags only. A sequence in flight (open panel, combobox) aborts on any key of the user's.
    __weak GHController *weakSelf = self;
    eventTap.userKeyObserver = ^{ [weakSelf.keyRelayWriter noteUserKeyEvent]; };
}

/// The live writer: one keyboard (GHKeyPoster) for typing and both drivers, one view of the desktop.
- (GHWriter *)writer {
    if (!_writer) {
        GHKeyPoster *poster = [GHKeyPoster livePoster];
        GHAXLiveActuator *actuator = [[GHAXLiveActuator alloc] initWithPoster:poster];
        GHLiveDesktopState *desktop = [[GHLiveDesktopState alloc] init];
        GHWriter *writer = [[GHWriter alloc] initWithActuator:actuator];
        writer.openPanelDriver = [[GHOpenPanelDriver alloc] initWithActuator:actuator poster:poster state:desktop];
        writer.comboBoxDriver = [[GHComboBoxDriver alloc] initWithActuator:actuator poster:poster state:desktop];
        self.writer = writer;
    }
    return _writer;
}

- (void)setWriter:(GHWriter *)writer {
    _writer = writer;
    self.keyRelayWriter = writer;
}

/// Progress lines to the HUD, the same safety oracle as the writer's. Set right before a sequence starts, so a writer
/// or driver injected later is wired too.
- (void)prepareDriversOf:(GHWriter *)writer {
    __weak GHController *weakSelf = self;
    writer.openPanelDriver.progress = ^(GHOpenPanelState state, NSString *message) {
        if (state != GHOpenPanelStateFailed) [weakSelf showStatus:message];   // a failure is the error chip's
    };
    GHComboBoxDriver *combo = writer.comboBoxDriver;
    if (combo && !combo.isNodeSensitive) {
        GHCapture *capture = self.capture;
        combo.isNodeSensitive = ^BOOL(id<GHAXNode> node) { return [capture isNodeSensitive:node]; };
    }
}

- (void)showStatus:(NSString *)message {
    _hudStatus = [message copy];
    [self render];
}

/// Only a started controller with a live accessibility session ever posts: a controller driven by tests (or not
/// started) records the hand-back and posts nothing.
- (void)handBackTab {
    if (self.tabHandBack) { self.tabHandBack(); return; }
    if (!_running || self.assumesActive || !self.accessibility.running) {
        GHLog(@"controller: Tab hand-back skipped (not running live)");
        return;
    }
    [GHEventTap postKeyCode:GHKeyCodeTab];
}

/// A new capture of the window in front, or nil when there is no way to take one.
- (GHCaptureResult *)freshCapture {
    if (self.captureProvider) return self.captureProvider();
    if (_running && self.accessibility.running) return [self.accessibility captureFocusedWindowWithCapture:self.capture];
    return nil;
}

#pragma mark - lifecycle

- (void)start {
    if (_running) return;
    _running = YES;
    if (!self.overlay) {
        self.overlay = [[GHOverlayWindow alloc] init];
        _ownsOverlay = YES;
    }
    __weak GHController *weakSelf = self;
    self.overlay.onLayoutChange = ^{ [weakSelf.accessibility setNeedsRescan:GHRescanReasonLayoutChanged]; };
    GHCapture *capture = self.capture;
    if (!self.writer.isNodeSensitive) self.writer.isNodeSensitive = ^BOOL(id<GHAXNode> node) { return [capture isNodeSensitive:node]; };
    // docs/anywhere.md: icon-only controls are kept for the next-action path, and an UNLOCKED click ghost may be
    // pressed -- after this check has read the live element one last time. Rule 2 still refuses anything else.
    capture.capturesUnnamedControls = YES;
    GHCore *core = _core;
    if (!self.writer.isNodeLocked) {
        self.writer.isNodeLocked = ^BOOL(id<GHAXNode> node) {
            NSString *name = [GHCapture cleanLabel:node.title ?: node.axDescription];
            if ([GHCapture nativeLooksLocked:name]) return YES;
            return [core isLockedActionText:name];
        };
    }

    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(storeDidChange:) name:GHProfileStoreDidChangeNotification object:_store];
    self.accessibility.delegate = self;
    [self syncPauseList];
    [self.accessibility start];
    [self.eventTap install];
    GHLog(@"controller: started (tap %@)", self.eventTap.installed ? @"installed" : @"NOT installed");
    [self rescanForReasons:GHRescanReasonManual];
}

/// An upload or combobox sequence in flight stops at once, before the tap that watches the user's keys goes away:
/// nothing is posted after Ghost was switched off or lost its permission.
- (void)cancelSequences {
    GHWriter *writer = _writer;   // never create the live writer just to cancel it
    [writer.openPanelDriver cancel];
    [writer.comboBoxDriver cancel];
}

- (void)stop {
    if (!_running) return;
    _running = NO;
    [self cancelSequences];
    [NSNotificationCenter.defaultCenter removeObserver:self name:GHProfileStoreDidChangeNotification object:_store];
    [self.eventTap uninstall];
    [self.accessibility stop];
    [self forgetPage];
    [self forgetPredictions:@""];
    _pendingTabs = 0;
    _busy = NO;
    _rescanDeferred = NO;
    _result = nil;
    _orderedFields = @[];
    _fields = @{};
    _pageKey = nil;
    [self.overlay hideImmediately];
    if (_ownsOverlay) {
        [self.overlay invalidate];
        self.overlay = nil;
        _ownsOverlay = NO;
    }
    _currentVisible = NO;
    [self noteStateChanged];
    GHLog(@"controller: stopped");
}

- (void)storeDidChange:(NSNotification *)notification {
    [self syncPauseList];
    // A new threshold re-gates live, a new profile re-maps: both are an ordinary rescan.
    if (_running) [self.accessibility setNeedsRescan:GHRescanReasonManual];
    else if (self.assumesActive && _result) [self adoptCaptureResult:_result pageKey:_pageKey ?: @"" origin:_origin ?: @""];
}

/// GHProfileStore is the source of truth for the user's pause list; GHAccessibility enforces it on the AX side.
- (void)syncPauseList {
    self.accessibility.userPausedBundleIdentifiers = [NSSet setWithArray:[_store userPausedBundleIds] ?: @[]];
}

- (void)presenceDidChange:(GHPresence *)presence {
    BOOL before = self.active;
    _presence = presence;
    if (before == self.active) return;
    GHLog(@"controller: %@ is %@ handled by its extension", self.accessibility.frontmostBundleIdentifier ?: @"?", self.active ? @"no longer" : @"now");
    [self rescanForReasons:GHRescanReasonManual];
}

#pragma mark - gate

- (BOOL)extensionHandlesFrontmost {
    return [_presence isExtensionActiveForBundleId:self.accessibility.frontmostBundleIdentifier];
}

- (BOOL)active {
    if (!_running && !self.assumesActive) return NO;
    if (!_store.enabled) return NO;
    if (self.assumesActive) return YES;
    GHAccessibility *ax = self.accessibility;
    if (!ax.trusted || ax.frontmostIsPaused) return NO;
    if ([_store isPausedBundleId:ax.frontmostBundleIdentifier]) return NO;
    return ![self extensionHandlesFrontmost];
}

- (NSString *)statusLine {
    GHAccessibility *ax = self.accessibility;
    NSString *app = ax.frontmostAppName ?: @"this app";
    if (!self.assumesActive) {
        if (!ax.trusted) return @"Needs Accessibility permission";
        if (ax.frontmostIsPaused || [_store isPausedBundleId:ax.frontmostBundleIdentifier]) return [NSString stringWithFormat:@"Paused in %@", app];
        if ([self extensionHandlesFrontmost]) return [NSString stringWithFormat:@"%@: handled by the extension", app];
        if (_running && !self.eventTap.installed) return @"Keyboard tap unavailable (check the Accessibility permission)";
    }
    if (_walk.error) return _walk.error;
    if (_busy && _hudStatus.length) return _hudStatus;
    if (!_busy && _gateReason.length && _walk.ghosts.count > 0 && !_walk.error) return _gateReason;
    NSUInteger unlocked = 0;
    for (GHGhost *ghost in _walk.ghosts) if (!ghost.locked) unlocked++;
    if (unlocked > 0) return [NSString stringWithFormat:@"%lu ghost%@ in %@", (unsigned long)unlocked, unlocked == 1 ? @"" : @"s", app];
    if (_walk.current.locked) return [NSString stringWithFormat:@"Parked on the locked action in %@ (Enter confirms)", app];
    if (_walk.accepted > 0) return [NSString stringWithFormat:@"Filled %ld field%@ in %@", (long)_walk.accepted, _walk.accepted == 1 ? @"" : @"s", app];
    return [NSString stringWithFormat:@"No ghosts in %@", app];
}

- (void)noteStateChanged {
    NSString *line = [self statusLine];
    if ([line isEqualToString:_lastStatusLine ?: @""]) return;
    _lastStatusLine = line;
    [NSNotificationCenter.defaultCenter postNotificationName:GHControllerStateDidChangeNotification object:self];
}

#pragma mark - forgetting

/// A new page, window or app starts a new walk.
- (void)forgetPage {
    [_walk reset];
    [self cancelAllDrafts];
    [_drafts removeAllObjects];
    [_asked removeAllObjects];
    [_served removeAllObjects];
    [_pinned removeAllObjects];
    [_sequenceDone removeAllObjects];
    [_seenValues removeAllObjects];
    [_ghostWrote removeAllObjects];
    _gateReason = nil;
    _predictionRequests = 0;
    _provider = kOfflineProvider;
    _cacheState = @"offline";
    _shownAt = 0;
    _jumpFailedSignature = nil;
    _pageContext = nil;
    _pageContextRead = NO;
    _proposal = nil;
    _previousRole = nil;
    _hudStatus = nil;
    _epoch++;   // an answer still in flight belongs to the page we left
    [self endDraftWait:NO];
}

/// Another fact key set is another question.
- (void)forgetPredictions:(NSString *)factsId {
    _factsId = [factsId copy];
    [_asked removeAllObjects];
    [_served removeAllObjects];
    [_pinned removeAllObjects];
    _provider = kOfflineProvider;
    _cacheState = @"offline";
    _epoch++;
}

- (void)clearBecauseInactive {
    if (_walk.ghosts.count > 0 || _walk.accepted > 0) GHLog(@"controller: inactive here, ghosts removed");
    [self cancelSequences];
    [self forgetPage];
    _result = nil;
    _orderedFields = @[];
    _fields = @{};
    _pageKey = nil;
    [self render];
}

#pragma mark - GHAccessibilityDelegate

- (void)accessibility:(GHAccessibility *)accessibility needsRescan:(GHRescanReason)reasons {
    [self rescanForReasons:reasons];
}

- (void)accessibilityShouldHideOverlay:(GHAccessibility *)accessibility reason:(GHRescanReason)reason {
    [self hideUntilNextRender];
}

- (void)accessibilityFocusedElementDidChange:(GHAccessibility *)accessibility {
    if (!_running || !self.active) return;
    [self noteFocusSignature:[self liveFocusSignature]];
}

- (void)accessibility:(GHAccessibility *)accessibility trustDidChange:(GHTrustState)state {
    if (state != GHTrustStateTrusted) [self clearBecauseInactive];
    [self noteStateChanged];
}

- (void)accessibilityFrontmostAppDidChange:(GHAccessibility *)accessibility {
    // Another app in front: focus is not in this walk, whatever its window says (a Tab there is never queued).
    if (_walkBundleId.length && ![accessibility.frontmostBundleIdentifier ?: @"" isEqualToString:_walkBundleId]) [_walk noteFocus:GHWalkFocusElsewhere];
    [self hideUntilNextRender];
    [self noteStateChanged];
}

/// Stale rects must never be drawn or tabbed into: nothing is visible until the next render says so.
- (void)hideUntilNextRender {
    [self.overlay hideImmediately];
    _currentVisible = NO;
    [self publish];
}

#pragma mark - rescan

- (void)rescanForReasons:(GHRescanReason)reasons {
    if (!_running) return;
    if (_busy) { _rescanDeferred = YES; return; }   // never swap the ghost list under a write that is in flight
    if (!self.active) { [self clearBecauseInactive]; return; }
    CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
    if (reasons == GHRescanReasonValueChanged) {
        // Every keystroke (and every write of ours) reports a value change, and a rescan is a full tree walk.
        if (now < _quietUntil) return;
        if (_result && _orderedFields.count == 0) return;   // a document editor: nothing here to re-map
        if (now - _lastRescanAt < kValueRescanSpacing) { [self.accessibility setNeedsRescan:GHRescanReasonValueChanged]; return; }
    }
    _lastRescanAt = now;

    GHAccessibility *ax = self.accessibility;
    // Chromium and Electron give a scrolled-out node no frame at all, where WebKit gives its real off-screen one.
    // Told which kind of app is in front, the capture keeps those frameless nodes instead of dropping them as
    // hidden -- without this the whole part of a Chrome page below the fold is invisible to Ghost.
    BOOL chromium = ax.frontmostNeedsEnhancedUserInterface;
    self.capture.treatsFramelessWebNodesAsScrolledOut = chromium;
    // Chromium answers an AX call several times slower than WebKit and exposes more nodes per page, so the same
    // walk that finishes in Safari stops half way through a Chrome page and the form below the fold is lost.
    GHCaptureLimits *limits = [[GHCaptureLimits defaultLimits] copy];
    if (chromium) {
        limits.maxNodes = kChromiumMaxNodes;
        limits.webAreaTimeBudget = kChromiumWebAreaBudget;
    }
    self.capture.limits = limits;
    GHCaptureResult *result = [ax captureFocusedWindowWithCapture:self.capture];
    NSString *bundle = ax.frontmostBundleIdentifier ?: @"";
    NSString *title = result ? ([ax focusedWindowTitle] ?: @"") : @"";
    NSString *webOrigin = result.webAreaNode ? [ax originOfWebAreaNode:result.webAreaNode] : nil;
    NSString *pageKey = [@[ bundle, webOrigin ?: @"", title ] componentsJoinedByString:@"\n"];
    NSString *origin = [GHServerClient originForBundleId:bundle pageURL:webOrigin windowTitle:title];
    _walkBundleId = [bundle copy];
    [self adoptCaptureResult:result pageKey:pageKey origin:origin];
}

- (void)adoptCaptureResult:(GHCaptureResult *)result pageKey:(NSString *)pageKey origin:(NSString *)origin {
    if (_busy) { _rescanDeferred = YES; return; }
    if (!self.active) { [self clearBecauseInactive]; return; }
    CFAbsoluteTime started = CFAbsoluteTimeGetCurrent();
    if (![pageKey isEqualToString:_pageKey ?: @""]) {
        if (_pageKey) GHLog(@"controller: new page, the walk starts over");
        [self forgetPage];
        _pageKey = [pageKey copy];
    }
    _result = result;
    _origin = [origin copy];
    _orderedFields = result.fields ?: @[];
    NSMutableDictionary<NSString *, GHField *> *bySignature = [NSMutableDictionary dictionary];
    for (GHField *field in _orderedFields) bySignature[field.signature] = field;
    _fields = bySignature;

    NSDictionary *profile = _store.profile, *settings = _store.settings;
    NSArray<NSString *> *factKeys = [_store usableFactKeys];
    NSString *factsId = [[factKeys sortedArrayUsingSelector:@selector(compare:)] componentsJoinedByString:@","];
    if (![factsId isEqualToString:_factsId]) [self forgetPredictions:factsId];

    // What the user answered themselves since the last capture is learned BEFORE the new ghosts are built, so
    // the correction is already in the store when the engine proposes again.
    [self learnUserEdits];

    NSMutableDictionary *options = [NSMutableDictionary dictionary];
    options[@"keepLock"] = @(_walk.keepLock);
    if (_walk.lockSignature) options[@"lockSignature"] = _walk.lockSignature;
    // Answers the user gave before (never sent anywhere), and what this walk has already accepted: a required
    // field the user has taken a ghost for counts as met, so the Submit ghost appears at the right moment.
    NSString *answersJSON = [_store answersJSON];
    if (answersJSON.length) options[@"answers"] = answersJSON;
    NSArray<NSString *> *accepted = [_walk.acceptedSignatures allObjects];
    if (accepted.count) options[@"accepted"] = accepted;
    if (_pageContext[@"company"].length) options[@"company"] = _pageContext[@"company"];

    NSArray<NSDictionary *> *offline = _orderedFields.count ? [_core mapFields:_orderedFields factKeys:factKeys] : @[];
    NSMutableArray<NSDictionary *> *answers = [NSMutableArray array];
    for (NSString *signature in _served) if (![_pinned containsObject:signature]) [answers addObject:_served[signature]];
    NSArray<NSDictionary *> *ghostObjects = @[];
    if (_orderedFields.count > 0) {
        ghostObjects = answers.count > 0
            ? [_core upgradeGhostsForFields:_orderedFields served:answers profile:profile settings:settings source:[self ghostSource] options:options]
            : [_core ghostsForFields:_orderedFields assignments:offline profile:profile settings:settings source:@"offline" options:options];
    }
    NSMutableArray<GHGhost *> *ghosts = [NSMutableArray array];
    for (GHGhost *ghost in [GHGhost ghostsWithDictionaries:ghostObjects]) {
        GHField *field = _fields[ghost.signature];
        // A ghost needs a live element, and a lock ghost is only ever a captured, locked button.
        if (!field || ![result nodeForSignature:ghost.signature]) continue;
        if (ghost.locked && !(field.locked && [field.kind isEqualToString:GHKindButton])) continue;
        // A file attached / an option chosen through a driver is never offered twice, whatever the page shows now.
        if ([_sequenceDone containsObject:ghost.signature]) continue;
        [ghosts addObject:ghost];
    }
    NSArray<GHGhost *> *withDrafts = [self ghostsByAddingDrafts:ghosts offline:offline answers:answers settings:settings];
    // Most windows are not forms. With nothing to fill, Ghost offers the one thing this KIND of place is for.
    withDrafts = [self ghostsByAddingNextAction:withDrafts result:result settings:settings];
    [self updateGateWithGhosts:withDrafts accepted:accepted];
    if ([_cacheState isEqualToString:@"offline"]) _latencyMs = @(MAX(0.0, (result.elapsed + (CFAbsoluteTimeGetCurrent() - started)) * 1000.0));

    // Focus is re-read against the new capture; the walk keeps its current ghost first and follows focus second.
    if ([self canReadLiveFocus]) [_walk noteFocus:[self liveFocusSignature]];
    [_walk rescanWithGhosts:withDrafts];
    [self preferVisibleCurrent];
    [self pruneDrafts];
    if (_shownAt == 0 && _walk.hasUnlocked) _shownAt = CFAbsoluteTimeGetCurrent();
    [self startQueuedDrafts];
    [self render];
    [self requestPredictionWithFactKeys:factKeys];

    NSString *summary = [NSString stringWithFormat:@"fields=%lu ghosts=%lu locked=%d source=%@", (unsigned long)_orderedFields.count,
                         (unsigned long)_walk.ghosts.count, _walk.ghosts.lastObject.locked, [self ghostSource]];
    if (![summary isEqualToString:_lastRescanLog ?: @""]) {
        _lastRescanLog = summary;
        GHLog(@"controller: rescan %@ in %@ (%.0f ms)", summary, self.accessibility.frontmostBundleIdentifier ?: @"?", [_latencyMs doubleValue]);
    }
}

#pragma mark - Ghost anywhere (docs/anywhere.md)

/// The next-action engine, with its role memory beside the profile. Built on first use.
- (GHNextAction *)nextAction {
    if (!_nextAction) {
        NSString *directory = _store.directory ?: [GHProfileStore defaultDirectory];
        NSString *path = [directory stringByAppendingPathComponent:@"memory.json"];
        _nextAction = [[GHNextAction alloc] initWithCore:_core memory:[[GHRoleMemoryStore alloc] initWithPath:path core:_core]];
    }
    return _nextAction;
}

/**
 * Nothing to fill: propose the one control this KIND of place is for (the video's fullscreen once it plays, the
 * first item of a grid, the search box of a shop, the cart when it holds something). The proposal is an ordinary
 * unlocked click ghost, so Tab, Escape, typing, focus following and the lock all behave exactly as they do in a
 * form walk. A form walk is never disturbed: with even one value ghost on the page, this does nothing at all.
 */
- (NSArray<GHGhost *> *)ghostsByAddingNextAction:(NSArray<GHGhost *> *)ghosts result:(GHCaptureResult *)result settings:(NSDictionary *)settings {
    if (ghosts.count > 0 || result.fields.count == 0) {
        _proposal = nil;
        return ghosts;
    }
    GHNextAction *engine = [self nextAction];
    NSNumber *threshold = [settings[@"confidenceThreshold"] isKindOfClass:[NSNumber class]] ? settings[@"confidenceThreshold"] : nil;
    if (threshold) engine.threshold = threshold.doubleValue;
    GHPageSignals *signals = [[GHPageSignals alloc] init];
    signals.appBundleId = _walkBundleId ?: self.accessibility.frontmostBundleIdentifier;
    signals.previousRole = _previousRole;
    GHNextProposal *proposal = [engine proposeForResult:result window:result.windowNode signals:signals];
    _proposal = proposal;
    if (!proposal) return ghosts;
    GHField *field = _fields[proposal.signature];
    if (!field) return ghosts;
    return [ghosts arrayByAddingObject:[proposal ghostWithDisplayText:field.label ?: @""]];
}

/// The user took the proposal, refused it, or did something else: remembered under the ROLE, so it transfers to
/// the next video, the next shop and the next feed. Never under a label, a window or an app.
/**
 * Every ghost outcome, to the server and on to Sentry (SENTRY.md).
 *
 * This is deliberately separate from `recordProposalOutcome:`, which only fires for NEXT-ACTION proposals
 * and so never saw a form fill at all. The learning loop is judged on the rejection stream, and a stream
 * that silently omits two thirds of the ghosts is worse than none.
 *
 * Reads the ghost for its action, source, confidence and lock, so nothing about the page is passed in.
 * Fire and forget: a failed post must never change a walk.
 */
- (void)reportGhostOutcome:(NSString *)outcome forSignature:(NSString *)signature {
    GHGhost *ghost = [_walk ghostWithSignature:signature];
    if (!ghost) return;
    [_client reportGhostOutcomeWithAction:ghost.action
                                   source:ghost.source
                               confidence:ghost.confidence
                                   locked:ghost.locked
                                  outcome:outcome];
}

- (void)recordProposalOutcome:(NSString *)outcome forSignature:(NSString *)signature {
    GHNextProposal *proposal = _proposal;
    if (!proposal || ![proposal.signature isEqualToString:signature ?: @""]) return;
    [_nextAction recordOutcome:outcome forProposal:proposal];
    if ([outcome isEqualToString:GHRoleOutcomeAccepted]) _previousRole = proposal.role;
    _proposal = nil;
}

#pragma mark - the answer engine and the gate (docs/answers.md, docs/incremental.md)

/// The user answered something themselves since the last capture: learn it, keyed by the question rather than by
/// the site, so the same question is answered everywhere afterwards. No key logging: the evidence is the value the
/// page reports now against the one it reported at the last capture, and what Ghost itself wrote is never a
/// correction. Learned answers never leave the machine, and a value that looks like a secret is refused by the core.
- (void)learnUserEdits {
    if (!_core || _orderedFields.count == 0) return;
    BOOL learning = [_store.settings[@"learningEnabled"] boolValue];
    NSMutableDictionary<NSString *, NSString *> *now = [NSMutableDictionary dictionary];
    NSMutableArray<GHField *> *corrected = [NSMutableArray array];
    for (GHField *field in _orderedFields) {
        NSString *value = field.value ?: @"";
        now[field.signature] = value;
        NSString *before = _seenValues[field.signature];
        if (!before || [before isEqualToString:value] || value.length == 0) continue;
        if ([_ghostWrote[field.signature] isEqualToString:value]) continue;   // Ghost put that there
        [corrected addObject:field];
    }
    _seenValues = now;
    if (!learning || corrected.count == 0) return;
    NSString *answersJSON = [_store answersJSON];
    for (GHField *field in corrected) {
        NSDictionary *result = [_core recordCorrectionForFieldObject:[field toJSONObject] value:field.value ?: @""
                                                              answers:answersJSON at:nil];
        NSDictionary *snapshot = result[@"answers"];
        if (![snapshot isKindOfClass:[NSDictionary class]]) continue;
        if ([result[@"changed"] isEqualToString:@"refused"]) {
            // Codes only: never the question, never the value.
            GHLog(@"controller: correction refused (%@) label=%@", result[@"refusal"] ?: @"?", GHLogLabel(field.label));
            continue;
        }
        [_store saveAnswers:snapshot error:NULL];
        answersJSON = [_store answersJSON];
        _correctionCount++;
        _lastCorrectionCounter = result[@"counter"];
        GHLog(@"controller: learned a correction (%@) label=%@", result[@"counter"] ?: @"?", GHLogLabel(field.label));
    }
}

/// The gate's reason, for the HUD: what the Submit ghost is waiting for. Value-free (a label, a count).
- (void)updateGateWithGhosts:(NSArray<GHGhost *> *)ghosts accepted:(NSArray<NSString *> *)accepted {
    _gateReason = nil;
    if (!_core || _orderedFields.count == 0) return;
    NSMutableArray<NSDictionary *> *ghostObjects = [NSMutableArray array];
    for (GHGhost *ghost in ghosts) [ghostObjects addObject:[ghost dictionary]];
    NSDictionary *gate = [_core gateForFieldObjects:[GHField JSONObjectsForFields:_orderedFields]
                                              ghosts:ghostObjects accepted:accepted ?: @[]];
    // Only say it when it actually withheld something: an optional field left empty is nobody's business.
    if ([gate[@"terminalAllowed"] boolValue] || ![gate[@"reason"] isKindOfClass:[NSString class]]) return;
    NSString *label = [gate[@"firstUnmetLabel"] isKindOfClass:[NSString class]] ? gate[@"firstUnmetLabel"] : nil;
    _gateReason = label.length ? [NSString stringWithFormat:@"%@: %@", gate[@"reason"], label] : gate[@"reason"];
}

/// A current ghost nobody can see is useless (Tab stays native for it, and the desktop has no jump pill): unless
/// the user is ON it, the first ghost that is on screen takes over.
- (void)preferVisibleCurrent {
    GHGhost *current = _walk.current;
    GHScreenLayout *layout = self.overlay.layout;
    if (!current || current.locked || !layout) return;
    if ([_walk.focusSignature isEqualToString:current.signature]) return;
    CGRect window = (_result && GHRectIsUsable(_result.windowFrame)) ? _result.windowFrame : CGRectNull;
    if ([layout isAXRectVisibleEnough:_fields[current.signature].rect inWindow:window]) return;
    NSArray<GHGhost *> *ghosts = _walk.ghosts;
    NSUInteger count = ghosts.count, start = (NSUInteger)MAX(_walk.currentIndex, 0);
    for (NSUInteger step = 1; step < count; step++) {
        GHGhost *candidate = ghosts[(start + step) % count];
        if (candidate.locked) continue;
        if ([layout isAXRectVisibleEnough:_fields[candidate.signature].rect inWindow:window]) { [_walk makeCurrent:candidate.signature]; return; }
    }
}

- (NSString *)ghostSource {
    if ([_cacheState isEqualToString:@"hit"]) return @"cache";
    return [_cacheState isEqualToString:@"miss"] ? @"server" : @"offline";
}

#pragma mark - prediction: cache -> server, once per form

static BOOL GHIsValueKind(NSString *kind) {
    return !([kind isEqualToString:GHKindButton] || [kind isEqualToString:GHKindLink] || [kind isEqualToString:GHKindItem] ||
             [kind isEqualToString:GHKindFile] || [kind isEqualToString:GHKindOther]);
}

- (void)requestPredictionWithFactKeys:(NSArray<NSString *> *)factKeys {
    if (!_client || factKeys.count == 0 || !_result) return;
    NSUInteger valueFields = 0;
    for (GHField *field in _orderedFields) if (GHIsValueKind(field.kind)) valueFields++;
    // Not for a lone field without an offline ghost: that is a search box, not a form.
    if (valueFields == 0 || (valueFields < kMinFormFields && !_walk.hasUnlocked)) return;
    NSString *formSignature = _result.formSignature ?: @"";
    if (formSignature.length == 0 || [_asked containsObject:formSignature] || _asked.count >= kMaxFormsPerPage) return;
    [_asked addObject:formSignature];
    _predictionRequests++;
    NSUInteger epoch = _epoch;
    __weak GHController *weakSelf = self;
    [_client predictFormForFields:_orderedFields factKeys:factKeys origin:_origin ?: @"" formSignature:formSignature
                       completion:^(GHFormPrediction *prediction, NSString *errorCode) {
        GHController *controller = weakSelf;
        // Server down, slow or wrong: the offline ghosts are already on screen and simply stay.
        if (!controller || !prediction || !(controller.running || controller.assumesActive) || epoch != controller->_epoch) return;
        [controller upgradeWithPrediction:prediction];
    }];
}

- (BOOL)userIsOn:(GHGhost *)ghost {
    if ([_walk.focusSignature isEqualToString:ghost.signature]) return YES;
    if (_walk.accepted > 0 || _walk.leftSignature != nil) return YES;
    return _shownAt > 0 && CFAbsoluteTimeGetCurrent() - _shownAt > kSettleSeconds;
}

/// New answers never touch the ghost the user is on; everything else is rebuilt like any rescan.
- (void)upgradeWithPrediction:(GHFormPrediction *)prediction {
    GHGhost *current = _walk.current;
    if (current && !current.locked && [self userIsOn:current]) [_pinned addObject:current.signature];
    for (NSDictionary *assignment in prediction.assignments) {
        NSString *signature = assignment[@"signature"];
        if ([signature isKindOfClass:[NSString class]]) _served[signature] = assignment;
    }
    _provider = prediction.provider.length ? [prediction.provider copy] : kOfflineProvider;
    _cacheState = prediction.fromCache ? @"hit" : @"miss";
    _latencyMs = @(prediction.elapsedMs);
    GHLog(@"controller: form answer provider=%@ cache=%@ assignments=%lu %.0f ms", _provider, _cacheState,
          (unsigned long)prediction.assignments.count, prediction.elapsedMs);
    // No new tree walk: the answer is merged into the capture we already have.
    if (_busy) _rescanDeferred = YES;
    else [self adoptCaptureResult:_result pageKey:_pageKey ?: @"" origin:_origin ?: @""];
}

#pragma mark - drafts (free text over SSE)

- (NSArray<GHGhost *> *)ghostsByAddingDrafts:(NSArray<GHGhost *> *)ghosts offline:(NSArray<NSDictionary *> *)offline
                                     answers:(NSArray<NSDictionary *> *)answers settings:(NSDictionary *)settings {
    if (!_client) return ghosts;
    NSMutableDictionary<NSString *, NSDictionary *> *merged = [NSMutableDictionary dictionary];
    for (NSDictionary *assignment in offline) if ([assignment[@"signature"] isKindOfClass:[NSString class]]) merged[assignment[@"signature"]] = assignment;
    for (NSDictionary *assignment in answers) if ([assignment[@"signature"] isKindOfClass:[NSString class]]) merged[assignment[@"signature"]] = assignment;
    double threshold = [settings[@"confidenceThreshold"] isKindOfClass:[NSNumber class]] ? [settings[@"confidenceThreshold"] doubleValue] : 0.7;

    NSMutableDictionary<NSString *, GHGhost *> *bySignature = [NSMutableDictionary dictionary];
    GHGhost *lock = nil;
    NSUInteger valueGhosts = 0;
    for (GHGhost *ghost in ghosts) {
        if (ghost.locked) lock = ghost; else { bySignature[ghost.signature] = ghost; valueGhosts++; }
    }
    // Only where Ghost is already helping with a form: never a draft for a lone chat box or a notes window.
    BOOL formInProgress = valueGhosts > 0 || _walk.accepted > 0;

    NSMutableArray<GHGhost *> *out = [NSMutableArray array];
    for (GHField *field in _orderedFields) {
        GHGhost *known = bySignature[field.signature];
        if (known) { [out addObject:known]; continue; }
        NSDictionary *assignment = merged[field.signature];
        if (![assignment[@"factKey"] isEqual:kNeedsText]) continue;
        double confidence = [assignment[@"confidence"] isKindOfClass:[NSNumber class]] ? [assignment[@"confidence"] doubleValue] : 0;
        BOOL textual = [field.kind isEqualToString:GHKindTextArea] || [field.kind isEqualToString:GHKindText];
        if (!textual || confidence < threshold || field.value.length > 0 || field.label.length == 0) continue;
        if ([_walk.dismissed containsObject:field.signature]) continue;
        GHDraft *draft = _drafts[field.signature];
        if (!draft) {
            if (!formInProgress) continue;
            draft = [[GHDraft alloc] init];
            draft.signature = field.signature;
            draft.confidence = confidence;
            draft.text = [NSMutableString string];
            _drafts[field.signature] = draft;
        }
        if (draft.failed) continue;
        [out addObject:[self ghostForDraft:draft]];
    }
    if (lock) [out addObject:lock];
    return out;
}

- (GHGhost *)ghostForDraft:(GHDraft *)draft {
    GHGhost *ghost = [[GHGhost alloc] init];
    ghost.signature = draft.signature;
    ghost.action = GHGhostActionFill;
    ghost.value = [draft.text copy];
    ghost.displayText = draft.text.length ? [draft.text copy] : kDraftingText;
    ghost.confidence = draft.confidence;
    ghost.source = @"llm";
    ghost.pending = !draft.finished;
    return ghost;
}

- (NSUInteger)activeDraftCount {
    NSUInteger count = 0;
    for (GHDraft *draft in _drafts.allValues) if (draft.started && !draft.finished && !draft.failed) count++;
    return count;
}

/// Speculative generation: drafts for later fields start while the user is still on earlier ones, 3 at a time,
/// in reading order.
- (void)startQueuedDrafts {
    if (!_client) return;
    NSUInteger active = self.activeDraftCount;
    for (GHField *field in _orderedFields) {
        if (active >= GHMaxConcurrentDrafts) return;
        GHDraft *draft = _drafts[field.signature];
        if (!draft || draft.started || draft.failed || ![_walk ghostWithSignature:field.signature]) continue;
        draft.started = YES;
        active++;
        NSDictionary *page = [GHController isLongQuestionField:field] ? [self pageContext] : nil;
        NSDictionary *context = [GHController draftContextForField:field page:page];
        draft.stream = [_client streamGhostTextForFieldLabel:field.label fieldSignature:field.signature pageContext:context
                                                     profile:_store.profile maxChars:kDraftMaxChars delegate:self];
        // nil = refused locally (sensitive label, no server URL): the delegate hears the reason on the next turn.
    }
}

/// What the posting is about, read once per page from the web area (never an input's value).
- (NSDictionary<NSString *, NSString *> *)pageContext {
    if (_pageContextRead) return _pageContext;
    _pageContextRead = YES;
    id<GHAXNode> root = _result.webAreaNode;
    if (!root) return nil;
    GHPageContext *context = [GHPageContext contextFromNode:root maxNodes:kPageContextNodes];
    _pageContext = [context dictionary];
    GHLog(@"controller: page context company=%lu role=%lu description=%lu chars (%lu nodes)", (unsigned long)context.company.length,
          (unsigned long)context.role.length, (unsigned long)context.jobDescription.length, (unsigned long)context.visitedNodes);
    return _pageContext;
}

+ (BOOL)isLongQuestionField:(GHField *)field {
    if ([field.kind isEqualToString:GHKindTextArea]) return YES;
    if (![field.kind isEqualToString:GHKindText]) return NO;
    NSString *label = [field.label stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] ?: @"";
    NSUInteger words = 0;
    for (NSString *part in [label componentsSeparatedByCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet]) if (part.length) words++;
    return words >= 6 || ([label hasSuffix:@"?"] && words >= 3);
}

+ (NSDictionary<NSString *, NSString *> *)draftContextForField:(GHField *)field page:(NSDictionary<NSString *, NSString *> *)page {
    NSMutableDictionary<NSString *, NSString *> *context = [NSMutableDictionary dictionary];
    if (page.count > 0 && [self isLongQuestionField:field]) {
        for (NSString *key in @[ @"company", @"role", @"description" ]) {
            if ([page[key] isKindOfClass:[NSString class]] && page[key].length) context[key] = page[key];
        }
    }
    if (!context[@"description"] && field.context.length) context[@"description"] = field.context;
    return context;
}

/// Drafts whose ghost did not survive the rescan (dismissed, field filled by hand, field gone) stop streaming.
- (void)pruneDrafts {
    for (GHDraft *draft in _drafts.allValues) {
        if (draft.failed || [_walk ghostWithSignature:draft.signature]) continue;
        if (draft.started && !draft.finished) [self cancelDraft:draft];
    }
}

- (void)cancelDraft:(GHDraft *)draft {
    draft.failed = YES;
    GHGhostTextStream *stream = draft.stream;
    draft.stream = nil;
    [stream cancel];
}

- (void)cancelAllDrafts {
    for (GHDraft *draft in _drafts.allValues) if (!draft.finished && !draft.failed) [self cancelDraft:draft];
}

- (GHDraft *)draftForStream:(GHGhostTextStream *)stream {
    GHDraft *draft = _drafts[stream.fieldSignature ?: @""];
    // A refused stream was never handed back to us, so `stream` is nil on the draft: match by signature then.
    return (draft && (draft.stream == stream || draft.stream == nil)) ? draft : nil;
}

- (void)ghostTextStream:(GHGhostTextStream *)stream didReceiveDelta:(NSString *)delta {
    GHDraft *draft = [self draftForStream:stream];
    if (!draft || draft.failed || draft.finished) return;
    [draft.text appendString:delta ?: @""];
    if (![_walk updateGhost:[self ghostForDraft:draft]] || _draftRenderQueued) return;
    _draftRenderQueued = YES;
    __weak GHController *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kDraftRenderSpacing * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        GHController *controller = weakSelf;
        if (!controller) return;
        controller->_draftRenderQueued = NO;
        [controller render];
    });
}

- (void)ghostTextStream:(GHGhostTextStream *)stream didFinishWithText:(NSString *)text provider:(NSString *)provider latencyMs:(NSNumber *)latencyMs {
    GHDraft *draft = [self draftForStream:stream];
    if (!draft || draft.failed || draft.finished) return;
    NSString *final = [text ?: draft.text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    draft.stream = nil;
    if (final.length == 0) { [self draftFailed:draft code:@"empty"]; return; }
    draft.text = [final mutableCopy];
    draft.finished = YES;
    GHLog(@"controller: draft ready label=%@ chars=%lu provider=%@", GHLogLabel(_fields[draft.signature].label), (unsigned long)final.length, provider ?: @"?");
    [_walk updateGhost:[self ghostForDraft:draft]];
    [self startQueuedDrafts];
    [self render];
    if ([_waitingDraft isEqualToString:draft.signature]) [self endDraftWait:YES];
}

- (void)ghostTextStream:(GHGhostTextStream *)stream didFailWithCode:(NSString *)code {
    GHDraft *draft = [self draftForStream:stream];
    if (!draft || draft.finished) return;
    if (draft.failed && [code isEqualToString:@"aborted"]) return;   // we cancelled it ourselves
    draft.stream = nil;
    [self draftFailed:draft code:code];
}

/// No draft is not an error: the field simply has no ghost (the server is optional).
- (void)draftFailed:(GHDraft *)draft code:(NSString *)code {
    draft.failed = YES;
    GHLog(@"controller: no draft for label=%@ (%@)", GHLogLabel(_fields[draft.signature].label), code ?: @"failed");
    BOOL waiting = [_waitingDraft isEqualToString:draft.signature];
    [_walk drop:draft.signature];
    [self startQueuedDrafts];
    [self render];
    if (waiting) [self endDraftWait:NO];
}

- (void)endDraftWait:(BOOL)ready {
    void (^continuation)(BOOL) = _waitContinuation;
    _waitContinuation = nil;
    _waitingDraft = nil;
    _waitToken++;
    if (continuation) continuation(ready);
}

#pragma mark - focus

/// Only a node whose role was really read can be "the window itself": an element whose role came back empty (a slow
/// app, an element destroyed a moment ago) is somewhere Ghost cannot see.
static BOOL GHIsWindowItself(id<GHAXNode> node) {
    static NSSet<NSString *> *roles;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ roles = [NSSet setWithArray:@[ @"AXWindow", @"AXWebArea", @"AXApplication", @"AXScrollArea", @"AXSheet", @"AXDialog" ]]; });
    NSString *role = node.role;
    return role.length > 0 && [roles containsObject:role];
}

/// The node's attributes could not be read (a live node whose batch fetch failed, or no role at all).
static BOOL GHNodeIsUnreadable(id<GHAXNode> node) {
    if (node.role.length == 0) return YES;
    if ([(id)node isKindOfClass:[GHAXElementNode class]]) return ((GHAXElementNode *)node).lastError != kAXErrorSuccess;
    return NO;
}

- (NSString *)signatureOfFieldAtNode:(id<GHAXNode>)node {
    for (GHField *field in _orderedFields) {
        if ([field.kind isEqualToString:GHKindLink]) continue;
        if ([[_result nodeForSignature:field.signature] isSameNode:node]) return field.signature;
        if (![field.kind isEqualToString:GHKindRadio]) continue;
        for (NSDictionary<NSString *, NSString *> *option in field.options) {
            NSString *label = option[@"label"];
            if (label && [[_result radioNodeForSignature:field.signature optionLabel:label] isSameNode:node]) return field.signature;
        }
    }
    return nil;
}

- (NSString *)focusSignatureForNode:(id<GHAXNode>)node {
    if (!node) return nil;
    if (GHNodeIsUnreadable(node)) return GHWalkFocusElsewhere;   // fail closed: Tab stays native
    if (GHIsWindowItself(node)) return nil;
    id<GHAXNode> cursor = node;
    for (NSUInteger level = 0; cursor && level <= kFocusClimb; level++) {
        NSString *signature = [self signatureOfFieldAtNode:cursor];
        if (signature) return signature;
        cursor = cursor.parent;   // a combo box focuses its inner text field
        if (cursor && GHIsWindowItself(cursor)) break;
    }
    return GHWalkFocusElsewhere;
}

/// Ghost can read where focus is right now: a test seam, or the live AX session.
- (BOOL)canReadLiveFocus {
    if (self.focusedNodeProvider) return YES;
    GHAccessibility *ax = self.accessibility;
    return ax.running && ax.trusted;
}

/// The focused element, read live. `*known` is NO when the read failed (never "the window itself").
- (id<GHAXNode>)liveFocusedNodeKnown:(BOOL *)known {
    if (self.focusedNodeProvider) { *known = YES; return self.focusedNodeProvider(); }
    GHAccessibility *ax = self.accessibility;
    id<GHAXNode> node = [ax focusedElementNode];
    *known = node != nil || ax.lastError == kAXErrorSuccess;
    return node;
}

/// Where the keyboard is, read live. A failed read is NOT "the window itself": when Ghost cannot tell where focus
/// is, Tab stays native.
- (NSString *)liveFocusSignature {
    BOOL known = NO;
    id<GHAXNode> node = [self liveFocusedNodeKnown:&known];
    if (!known) return GHWalkFocusElsewhere;
    return [self focusSignatureForNode:node];
}

/// The app in front is no longer the one whose window the walk belongs to (live only).
- (BOOL)walkAppLeftTheFront {
    if (self.focusedNodeProvider || _walkBundleId.length == 0) return NO;
    GHAccessibility *ax = self.accessibility;
    return ax.running && ![ax.frontmostBundleIdentifier ?: @"" isEqualToString:_walkBundleId];
}

- (void)noteFocusSignature:(NSString *)signature {
    NSString *before = _walk.current.signature;
    [_walk focusMoved:signature];
    if (before == _walk.current.signature || [before isEqualToString:_walk.current.signature ?: @""]) [self publish];
    else [self render];
}

- (void)noteFocusedNode:(id<GHAXNode>)node {
    [self noteFocusSignature:[self focusSignatureForNode:node]];
}

#pragma mark - render

- (GHOverlayInput *)overlayInput {
    GHOverlayInput *input = [[GHOverlayInput alloc] init];
    NSMutableArray<GHOverlayEntry *> *entries = [NSMutableArray array];
    NSInteger currentIndex = -1;
    GHGhost *current = _walk.current;
    for (GHGhost *ghost in _walk.ghosts) {
        GHField *field = _fields[ghost.signature];
        if (!field) continue;
        if (ghost == current) currentIndex = (NSInteger)entries.count;
        [entries addObject:[GHOverlayEntry entryWithField:field ghost:[ghost dictionary]]];
    }
    input.entries = entries;
    input.currentIndex = currentIndex;
    CGRect window = _result ? _result.windowFrame : CGRectNull;
    input.windowAXFrame = GHRectIsUsable(window) ? window : CGRectNull;
    BOOL somethingToShow = entries.count > 0 || _walk.accepted > 0 || _walk.error != nil;
    if (_store.showHud && somethingToShow) {
        input.hud = [GHOverlayHUDInfo infoWithProvider:_provider ?: kOfflineProvider latencyMs:_latencyMs cache:_cacheState keystrokesSaved:_walk.keystrokesSaved];
    }
    input.error = _walk.error;
    // A withheld Submit always says why, so the walk ending on a field never reads as "the form is done".
    input.status = _walk.error ? nil : (_hudStatus ?: (entries.count > 0 ? _gateReason : nil));
    return input;
}

- (void)render {
    GHOverlayWindow *overlay = self.overlay;
    if (!self.active || !overlay) {
        [overlay hideImmediately];
        _currentVisible = NO;
    } else {
        GHOverlayInput *input = [self overlayInput];
        if (input.entries.count == 0 && !input.hud && !input.error && !input.status) {
            [overlay hideImmediately];
            _currentVisible = NO;
        } else {
            GHOverlayModel *model = [GHOverlayModel modelWithInput:input layout:overlay.layout];
            [overlay render:model];
            _currentVisible = model.currentVisible;
        }
    }
    [self publish];
    [self noteStateChanged];
}

- (void)publish {
    GHWalkSnapshot snapshot = [_walk snapshotWithActive:self.active currentVisible:_currentVisible busy:_busy];
    GHGhost *current = _walk.current;
    if (current && _currentVisible && [_jumpFailedSignature isEqualToString:current.signature]) _jumpFailedSignature = nil;
    snapshot.canJump = current != nil && !_currentVisible && self.overlay != nil && [_result nodeForSignature:current.signature] != nil
                       && ![_jumpFailedSignature isEqualToString:current.signature];
    [self.eventTap publishSnapshot:snapshot];
}

/// Re-reads the rect of one ghost's element. NO when the element is gone.
- (BOOL)refreshRectOfSignature:(NSString *)signature {
    GHField *field = _fields[signature];
    id<GHAXNode> node = [_result nodeForSignature:signature];
    if (!field || !node) return NO;
    if ([field.kind isEqualToString:GHKindRadio]) {
        CGRect box = CGRectNull;
        for (NSDictionary<NSString *, NSString *> *option in field.options) {
            id<GHAXNode> radio = [_result radioNodeForSignature:signature optionLabel:option[@"label"] ?: @""];
            id<GHAXNode> fresh = radio ? [self.writer.actuator refreshedNode:radio] : nil;
            if (fresh && GHRectIsUsable(fresh.frame)) box = CGRectIsNull(box) ? fresh.frame : CGRectUnion(box, fresh.frame);
        }
        if (CGRectIsNull(box)) return NO;
        field.rect = box;
        return YES;
    }
    id<GHAXNode> fresh = [self.writer.actuator refreshedNode:node];
    if (!fresh) return NO;
    if (GHRectIsUsable(fresh.frame)) field.rect = fresh.frame;
    return YES;
}

/// True when the current ghost can be seen right now, judged on a freshly read rect (no write the user cannot see).
- (BOOL)currentIsVisibleNow {
    GHGhost *current = _walk.current;
    if (!current || !self.overlay) return NO;
    [self refreshRectOfSignature:current.signature];
    GHOverlayModel *model = [GHOverlayModel modelWithInput:[self overlayInput] layout:self.overlay.layout];
    return model.currentVisible;
}

- (BOOL)revealCurrent {
    return [self revealCurrentScrolled:NULL];
}

/// AXScrollToVisible on the current ghost's element when it is off screen, then every rect is read again (the page
/// scrolled) and the overlay redrawn. Writes nothing. YES when the ghost is on screen afterwards. `*scrolled` says
/// whether the page accepted the scroll: then the rects are read again a little later too (smooth scrolling), and a
/// ghost still off screen after that is not jumped to again.
- (BOOL)revealCurrentScrolled:(BOOL *)scrolled {
    if (scrolled) *scrolled = NO;
    GHGhost *current = _walk.current;
    id<GHAXNode> node = current ? [_result nodeForSignature:current.signature] : nil;
    if (!node || !self.overlay) return NO;
    if ([self currentIsVisibleNow]) return YES;
    id<GHAXNode> fresh = [self.writer.actuator refreshedNode:node];
    if (!fresh || ![self.writer.actuator scrollToVisible:fresh]) {
        [self render];
        return NO;
    }
    if (scrolled) *scrolled = YES;
    for (GHGhost *ghost in _walk.ghosts) [self refreshRectOfSignature:ghost.signature];
    [self render];
    if (!_currentVisible) [self settleAfterScrollingTo:current.signature];
    return _currentVisible;
}

- (void)settleAfterScrollingTo:(NSString *)signature {
    NSUInteger generation = ++_scrollGeneration;   // a newer scroll (ours or the user's) supersedes these reads
    __weak GHController *weakSelf = self;
    for (NSNumber *delay in @[ @(kScrollSettleFirst), @(kScrollSettleLast) ]) {
        BOOL last = delay.doubleValue >= kScrollSettleLast;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay.doubleValue * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            GHController *controller = weakSelf;
            if (!controller || generation != controller->_scrollGeneration || !(controller.running || controller.assumesActive)) return;
            if (controller->_busy) return;   // the step in flight renders when it is done
            for (GHGhost *ghost in controller.walk.ghosts) [controller refreshRectOfSignature:ghost.signature];
            [controller render];
            GHGhost *current = controller.walk.current;
            if (!last || controller->_currentVisible || ![current.signature isEqualToString:signature]) return;
            controller->_jumpFailedSignature = [signature copy];   // Tab is native for it from now on
            GHLog(@"controller: scrolled to label=%@ but it stayed off screen", GHLogLabel(controller->_fields[signature].label));
            [controller publish];
        });
    }
}

/// The desktop jump: Tab while the current ghost is off screen and focus is on the page. Nothing is written; when the
/// page cannot bring the ghost into view the Tab goes back to the app and the next one stays native.
- (void)jumpForTab {
    _stepStartedAt = CFAbsoluteTimeGetCurrent();
    GHGhost *current = _walk.current;
    if (!current || !self.active) { [self recordStep:@"inactive" reason:nil ghost:current]; [self publish]; return; }
    if ([self userLeftTheWalk]) {
        [self recordStep:@"handed-back" reason:nil ghost:current];
        [self handBackTab];
        return;
    }
    BOOL scrolled = NO;
    if ([self revealCurrentScrolled:&scrolled] || scrolled) {
        // On screen, or the page is still scrolling to it: either way this Tab was the jump (nothing written).
        [self recordStep:@"jumped" reason:nil ghost:current];
        GHLog(@"controller: jumped to label=%@ (scrolled into view, nothing written)", GHLogLabel(_fields[current.signature].label));
        return;
    }
    _jumpFailedSignature = [current.signature copy];
    [self recordStep:@"not-visible" reason:nil ghost:current];
    [self publish];
    [self handBackTab];
}

#pragma mark - GHEventTapDelegate

- (void)eventTap:(GHEventTap *)tap didConsumeTab:(GHKeyDecision)decision isRepeat:(BOOL)isRepeat {
    if (!_running && !self.assumesActive) return;
    if (_busy) {
        // A fresh press during a write is queued (the tap only queues it while focus is in the walk); a repeat is
        // dropped. Every queued press is checked against live focus again right before its own step runs.
        if (!isRepeat) _pendingTabs = MIN(_pendingTabs + 1, (NSInteger)_walk.ghosts.count);
        return;
    }
    if (decision == GHKeyDecisionJump) { [self jumpForTab]; return; }
    _drainIsRepeat = isRepeat;
    _stepMayHandBack = !isRepeat && decision != GHKeyDecisionQueue;
    _pendingTabs++;
    [self drain];
}

/**
 * The Ghost key: a lone tap of right Option accepts the current ghost (docs/accept-key.md).
 *
 * Tab is the right key only where Tab already means "take this and move on" - walking a form. Everywhere
 * else the app owns it: a video page, a mail client, an editor, a spreadsheet, most SPAs. Stealing it there
 * is a bug, so Ghost offers a key nobody binds. The modifier event is never consumed, so right Option keeps
 * working as a modifier and for accented characters; only a down-and-up with no other key counts as a tap.
 *
 * Deliberately simple: it takes the same path as an accepted Tab, including the lock rule, so a locked
 * action still cannot be taken by a tap.
 */
- (void)eventTapDidTapGhostKey:(GHEventTap *)tap {
    [self eventTap:tap didConsumeTab:GHKeyDecisionAccept isRepeat:NO];
}

- (void)eventTapDidConsumeEscape:(GHEventTap *)tap {
    GHGhost *ghost = _walk.current;
    if (_busy || !ghost) return;
    GHLog(@"controller: dismissed (escape) label=%@", GHLogLabel(_fields[ghost.signature].label));
    [self dismissSignature:ghost.signature];
}

- (void)eventTapDidSeeTypingInField:(GHEventTap *)tap {
    NSString *signature = _walk.focusSignature;
    if (_busy || !signature || [signature isEqualToString:GHWalkFocusElsewhere]) return;
    if ([_walk ghostWithSignature:signature]) GHLog(@"controller: dismissed (typed) label=%@", GHLogLabel(_fields[signature].label));
    GHDraft *draft = _drafts[signature];
    if (draft && !draft.failed) [self cancelDraft:draft];
    // The strongest signal there is: Ghost proposed something and the user wrote their own answer instead.
    [self reportGhostOutcome:@"typed-over" forSignature:signature];
    [_walk typedOver:signature];
    [self render];
}

- (void)eventTapDidSeeScroll:(GHEventTap *)tap {
    if (_walk.ghosts.count == 0) return;
    [self hideUntilNextRender];
    NSUInteger generation = ++_scrollGeneration;
    __weak GHController *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kScrollSettleSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        GHController *controller = weakSelf;
        if (!controller || generation != controller->_scrollGeneration || controller->_busy || !controller.running) return;
        for (GHGhost *ghost in controller.walk.ghosts) [controller refreshRectOfSignature:ghost.signature];
        [controller render];
        // Fields that scrolled into the window since the last walk still need a real capture.
        [controller.accessibility setNeedsRescan:GHRescanReasonLayoutChanged];
    });
}

- (void)dismissSignature:(NSString *)signature {
    GHDraft *draft = _drafts[signature];
    if (draft && !draft.failed && !draft.finished) [self cancelDraft:draft];
    [self recordProposalOutcome:GHRoleOutcomeDismissed forSignature:signature];
    [self reportGhostOutcome:@"escaped" forSignature:signature];
    [_walk dismiss:signature];
    [self render];
}

#pragma mark - accepting

- (void)drain {
    if (_busy) return;
    _busy = YES;
    [self publish];
    [self drainStep];
}

- (void)drainStep {
    if (_pendingTabs <= 0 || (!_running && !self.assumesActive)) { [self finishDrain]; return; }
    _pendingTabs--;
    _stepStartedAt = CFAbsoluteTimeGetCurrent();
    _stepDirect = YES;
    __weak GHController *weakSelf = self;
    [self acceptCurrentThen:^{ [weakSelf drainStep]; }];
}

- (void)finishDrain {
    _busy = NO;
    _pendingTabs = 0;
    _stepMayHandBack = NO;
    [self publish];
    if (_rescanDeferred) {
        _rescanDeferred = NO;
        if (_running) [self.accessibility setNeedsRescan:GHRescanReasonManual];
        else if (self.assumesActive && _result) {
            GHCaptureResult *fresh = self.captureProvider ? self.captureProvider() : nil;
            [self adoptCaptureResult:fresh ?: _result pageKey:_pageKey ?: @"" origin:_origin ?: @""];
        }
    }
}

/// The snapshot the tap decided on can be a few milliseconds old. If the user has meanwhile put focus somewhere
/// that is not part of the walk, the Tab was theirs: hand it back instead of filling anything.
- (BOOL)userLeftTheWalk {
    if (![self canReadLiveFocus]) return NO;
    if ([self walkAppLeftTheFront]) { [_walk noteFocus:GHWalkFocusElsewhere]; return YES; }
    [_walk noteFocus:[self liveFocusSignature]];
    return ![_walk snapshotWithActive:YES currentVisible:YES busy:NO].focusInWalk;
}

/// After a write: focus is still where the write left it (the field just written, anything inside an upload widget,
/// the window itself, or the next ghost the page moved it to). Anything else means the user went somewhere else
/// meanwhile, and Ghost does not pull focus away from there.
- (BOOL)focusStayedWithWrite:(NSString *)signature {
    if (![self canReadLiveFocus]) return YES;
    if ([self walkAppLeftTheFront]) return NO;
    BOOL known = NO;
    id<GHAXNode> focused = [self liveFocusedNodeKnown:&known];
    if (!known) return NO;
    NSString *focus = [self focusSignatureForNode:focused];
    [_walk noteFocus:focus];
    if (!focus || [focus isEqualToString:signature] || [focus isEqualToString:_walk.current.signature ?: @""]) return YES;
    // An upload leaves focus on the widget's own controls (Attach, Remove) or on its file input.
    for (id<GHAXNode> anchor in @[ [_result uploadNodeForSignature:signature] ?: (id)NSNull.null, [_result nodeForSignature:signature] ?: (id)NSNull.null ]) {
        if ((id)anchor == (id)NSNull.null) continue;
        id<GHAXNode> fresh = [self.writer.actuator refreshedNode:anchor] ?: anchor;
        id<GHAXNode> widget = [GHWriter uploadWidgetOfInput:fresh];
        if ([GHOpenPanelDriver node:focused isInside:widget ?: fresh]) return YES;
    }
    return NO;
}

- (void)stopTheHold {
    _pendingTabs = 0;
    [self.eventTap haltHold];
}

- (void)acceptCurrentThen:(dispatch_block_t)done {
    GHGhost *ghost = _walk.current;
    // Paused, disabled or handed to the extension between the key press and now: nothing is written.
    if (!ghost || !self.active) { [self recordStep:@"inactive" reason:nil ghost:ghost]; [self stopTheHold]; done(); return; }
    // Every step, whatever brought it here (a fresh press, a queued press, a hold, the end of a draft wait), checks
    // live focus first. Only the first step of a fresh press gives its Tab back; any later one is simply dropped.
    BOOL mayHandBack = _stepMayHandBack;
    _stepMayHandBack = NO;
    if ([self userLeftTheWalk]) {
        [self stopTheHold];
        if (mayHandBack) {
            GHLog(@"controller: focus left the walk before the write; Tab handed back to the app");
            [self recordStep:@"handed-back" reason:nil ghost:ghost];
            [self handBackTab];
        } else {
            GHLog(@"controller: focus left the walk; the queued or delayed Tab is dropped");
            [self recordStep:@"focus-left" reason:nil ghost:ghost];
            [self publish];
        }
        done();
        return;
    }
    GHField *field = _fields[ghost.signature];
    id<GHAXNode> node = [_result nodeForSignature:ghost.signature];
    if (!field || !node) {
        [self recordStep:@"gone" reason:GHWriteReasonGone ghost:ghost];
        [_walk drop:ghost.signature];
        _rescanDeferred = YES;
        [self render];
        done();
        return;
    }
    // Rule 3: a locked ghost is never activated. Focus lands on it so Enter or a click can confirm.
    if (ghost.locked) {
        [self revealCurrent];
        [self recordStep:@"parked" reason:GHWriteReasonLocked ghost:ghost];
        [self parkOn:node];
        done();
        return;
    }
    if (ghost.pending) { [self acceptPending:ghost then:done]; return; }
    // Rule: hold-Tab never accepts a guess (docs/answers.md section 3). The hold stops ON it, visible, so the
    // user reads it before Submit; one deliberate press takes it. A held Tab can therefore never fill a
    // required field with a guess and unlock Submit in the same breath.
    if (_drainIsRepeat && ghost.needsReview) {
        [self revealCurrent];
        [self recordStep:@"needs-press" reason:ghost.guess ? @"guess" : @"check-this" ghost:ghost];
        [self stopTheHold];
        [self render];
        done();
        return;
    }
    if (_drainIsRepeat && [GHWriter ghostRunsSequence:ghost field:field]) {
        // Hold-Tab never starts an upload or a combobox sequence: its own repeats (user keys) would abort it. The
        // hold stops here, on screen; one fresh press starts it.
        [self revealCurrent];
        [self recordStep:@"needs-press" reason:nil ghost:ghost];
        [self stopTheHold];
        [self render];
        done();
        return;
    }
    if (![self currentIsVisibleNow]) {
        // Never a write the user cannot see: the ghost is scrolled into view (and drawn) first; the next Tab writes.
        BOOL shown = [self revealCurrent];
        [self recordStep:shown ? @"jumped" : @"not-visible" reason:nil ghost:ghost];
        _pendingTabs = 0;
        if (!shown) _rescanDeferred = YES;
        [self render];
        done();
        return;
    }
    [self write:ghost field:field node:node then:done];
}

- (void)parkOn:(id<GHAXNode>)node {
    [self stopTheHold];
    [self.writer focusLockedNode:node];
    [self render];
}

/// Hold-Tab never accepts a pending draft (it skips to the next ready ghost, or stops). A deliberate press waits
/// up to 4 s for the draft to finish.
- (void)acceptPending:(GHGhost *)ghost then:(dispatch_block_t)done {
    if (_drainIsRepeat) {
        if ([_walk skipPendingCurrent]) { [self render]; [self acceptCurrentThen:done]; return; }
        [self recordStep:@"draft-not-ready" reason:GHWriteReasonPending ghost:ghost];
        [self stopTheHold];
        done();
        return;
    }
    NSString *signature = ghost.signature;
    _waitingDraft = signature;
    // Seconds may pass: the step that follows is no longer the press itself (focus is checked again when it runs,
    // and it never parks focus on a lock).
    _stepDirect = NO;
    _stepMayHandBack = NO;
    NSUInteger token = ++_waitToken;
    __weak GHController *weakSelf = self;
    _waitContinuation = ^(BOOL ready) {
        GHController *controller = weakSelf;
        if (!controller) return;
        GHGhost *now = [controller.walk ghostWithSignature:signature];
        if (!ready || !now || now.pending || controller.walk.current != now) {
            [controller recordStep:@"draft-not-ready" reason:GHWriteReasonPending ghost:now];
            [controller stopTheHold];
            done();
            return;
        }
        [controller acceptCurrentThen:done];
    };
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(GHDraftWaitSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        GHController *controller = weakSelf;
        if (!controller || controller->_waitToken != token || !controller->_waitContinuation) return;
        GHLog(@"controller: the draft was not ready after %.0f s; Tab dropped", GHDraftWaitSeconds);
        [controller endDraftWait:NO];
    });
}

- (BOOL)radioGroupAlreadyAnswered:(GHField *)field {
    for (NSDictionary<NSString *, NSString *> *option in field.options) {
        id<GHAXNode> radio = [_result radioNodeForSignature:field.signature optionLabel:option[@"label"] ?: @""];
        id<GHAXNode> fresh = radio ? [self.writer.actuator refreshedNode:radio] : nil;
        if ([fresh.value isEqualToString:@"1"]) return YES;
    }
    return NO;
}

- (void)write:(GHGhost *)ghost field:(GHField *)field node:(id<GHAXNode>)node then:(dispatch_block_t)done {
    id<GHAXNode> optionNode = nil;
    if ([field.kind isEqualToString:GHKindRadio]) {
        // Rule 9 for radio groups: a group the user already answered is left alone.
        if ([self radioGroupAlreadyAnswered:field]) { [self dismissSignature:ghost.signature]; done(); return; }
        for (NSDictionary<NSString *, NSString *> *option in field.options) {
            if (![option[@"value"] isEqualToString:ghost.value ?: @""]) continue;
            optionNode = [_result radioNodeForSignature:field.signature optionLabel:option[@"label"] ?: @""];
            break;
        }
    }
    BOOL upload = [ghost.action isEqualToString:GHGhostActionUpload];
    BOOL hadRemoveControl = NO;
    id<GHAXNode> uploadWidget = nil;
    if (upload) {
        // For a file field the writer presses the widget's Attach control; the page's file input is the fallback.
        optionNode = [_result uploadNodeForSignature:ghost.signature];
        id<GHAXNode> input = optionNode ? [self.writer.actuator refreshedNode:optionNode] : nil;
        uploadWidget = [GHWriter uploadWidgetOfInput:input];
        hadRemoveControl = [GHWriter widgetHasRemoveControl:uploadWidget];
    }
    if ([GHWriter ghostRunsSequence:ghost field:field]) [self prepareDriversOf:self.writer];
    _hudStatus = nil;
    _quietUntil = CFAbsoluteTimeGetCurrent() + 2.0;   // until the write reports back
    [self runWrite:ghost field:field node:node optionNode:optionNode upload:upload widget:uploadWidget
      widgetRect:uploadWidget ? uploadWidget.frame : field.rect hadRemoveControl:hadRemoveControl mayRetry:YES then:done];
}

- (void)runWrite:(GHGhost *)ghost field:(GHField *)field node:(id<GHAXNode>)node optionNode:(id<GHAXNode>)optionNode
          upload:(BOOL)upload widget:(id<GHAXNode>)widget widgetRect:(CGRect)widgetRect
hadRemoveControl:(BOOL)hadRemoveControl mayRetry:(BOOL)mayRetry then:(dispatch_block_t)done {
    NSString *signature = ghost.signature;
    NSString *filename = upload ? ghost.displayText : nil;
    __weak GHController *weakSelf = self;
    [self.writer executeGhost:ghost field:field node:node optionNode:optionNode completion:^(GHWriteResult *result) {
        GHController *controller = weakSelf;
        if (!controller) return;
        if (upload && result.ok) {
            [controller whenUploadShowsFile:filename signature:signature widget:widget widgetRect:widgetRect
                          hadRemoveControl:hadRemoveControl tries:kUploadVerifyTries completion:^(BOOL shown) {
                GHWriteResult *outcome = shown ? result : [GHWriteResult failureWithReason:kUploadNotVerified method:GHWriteMethodOpenPanel sequence:YES];
                [controller finishedWriting:signature result:outcome];
                done();
            }];
            return;
        }
        // The page replaced the element while Ghost was writing into it (React does, on the first field of a
        // Greenhouse form). The write is not necessarily lost: a fresh capture either shows the new element holding
        // the value, or hands it over for ONE retry. Never for a sequence: an upload or a list is never redriven.
        if (mayRetry && !result.ok && !result.sequence && [result.reason isEqualToString:GHWriteReasonGone]) {
            GHCaptureResult *fresh = [controller freshCapture];
            GHField *freshField = nil;
            for (GHField *candidate in fresh.fields) {
                if ([candidate.signature isEqualToString:signature]) { freshField = candidate; break; }
            }
            id<GHAXNode> freshNode = [fresh nodeForSignature:signature];
            NSString *wanted = ghost.value.length ? ghost.value : (ghost.displayText ?: @"");
            if (freshField && freshNode && wanted.length && [GHWriter value:freshField.value holds:wanted]) {
                GHLog(@"controller: the element was replaced during the write; the new one holds the value");
                [controller finishedWriting:signature result:[GHWriteResult okWithMethod:result.method]];
                done();
                return;
            }
            if (freshField && freshNode) {
                GHLog(@"controller: the element was replaced during the write; one retry on the new one");
                [controller runWrite:ghost field:freshField node:freshNode optionNode:optionNode upload:upload widget:widget
                          widgetRect:widgetRect hadRemoveControl:hadRemoveControl mayRetry:NO then:done];
                return;
            }
        }
        [controller finishedWriting:signature result:result];
        done();
    }];
}

/// The upload check, repeated while the page catches up (it uploads the file before it names it). Every look is a
/// fresh capture, so the polling stops as soon as one of them shows the file.
- (void)whenUploadShowsFile:(NSString *)filename signature:(NSString *)signature widget:(id<GHAXNode>)widget
                 widgetRect:(CGRect)widgetRect hadRemoveControl:(BOOL)hadRemoveControl tries:(NSUInteger)tries
                 completion:(void (^)(BOOL))completion {
    if ([self uploadShowsFile:filename signature:signature widget:widget widgetRect:widgetRect hadRemoveControl:hadRemoveControl]) {
        completion(YES);
        return;
    }
    if (tries == 0 || (!_running && !self.assumesActive)) { completion(NO); return; }
    __weak GHController *weakSelf = self;
    [self after:kUploadVerifyPoll do:^{
        GHController *controller = weakSelf;
        if (!controller) { completion(NO); return; }
        [controller whenUploadShowsFile:filename signature:signature widget:widget widgetRect:widgetRect
                       hadRemoveControl:hadRemoveControl tries:tries - 1 completion:completion];
    }];
}

- (void)after:(NSTimeInterval)delay do:(dispatch_block_t)block {
    if (self.after) { self.after(delay, block); return; }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)), dispatch_get_main_queue(), block);
}

/// After the panel closed and the page named the file: a fresh capture must agree. The upload field now holds the
/// file's name, or its widget names the file or shows a Remove control it did not have before.
- (BOOL)uploadShowsFile:(NSString *)filename signature:(NSString *)signature widget:(id<GHAXNode>)widget
             widgetRect:(CGRect)widgetRect hadRemoveControl:(BOOL)hadRemoveControl {
    if (filename.length == 0) return NO;
    GHCaptureResult *fresh = [self freshCapture];
    for (GHField *field in fresh.fields) {
        if (![field.signature isEqualToString:signature]) continue;
        if ([field.value rangeOfString:filename options:NSCaseInsensitiveSearch].location != NSNotFound) return YES;
    }
    id<GHAXNode> input = [fresh uploadNodeForSignature:signature];
    if (!input) {
        id<GHAXNode> old = [_result uploadNodeForSignature:signature];
        input = old ? [self.writer.actuator refreshedNode:old] : nil;
    }
    id<GHAXNode> around = [GHWriter uploadWidgetOfInput:input] ?: (widget ? [self.writer.actuator refreshedNode:widget] : nil);
    if ([GHWriter widget:around mentionsFile:filename]) return YES;
    if (!hadRemoveControl && [GHWriter widgetHasRemoveControl:around]) return YES;
    // Live, Safari: Greenhouse takes the file input AND the Attach button out of the page once the file is attached,
    // so neither the field nor its widget can be found again. What it leaves behind is the file name and a Remove
    // button where the upload field was: the fresh capture is searched there.
    if (hadRemoveControl || !GHRectIsUsable(widgetRect)) return NO;
    CGRect box = CGRectInset(widgetRect, -16, -16);
    for (GHField *field in fresh.fields) {
        if (![field.kind isEqualToString:GHKindButton] && ![field.kind isEqualToString:GHKindLink]) continue;
        if (![GHWriter labelIsRemoveControl:field.label]) continue;
        CGRect rect = field.rect;
        if (!GHRectIsUsable(rect)) continue;
        if (CGRectContainsPoint(box, CGPointMake(CGRectGetMidX(rect), CGRectGetMidY(rect)))) return YES;
    }
    return NO;
}

- (void)finishedWriting:(NSString *)signature result:(GHWriteResult *)result {
    _quietUntil = CFAbsoluteTimeGetCurrent() + kOwnWriteQuietSeconds;
    if (!_running && !self.assumesActive) return;
    [self recordStep:result.ok ? @"accepted" : (result.refused ? @"refused" : @"failed") reason:result.ok ? nil : (result.reason ?: @"failed")
               ghost:[_walk ghostWithSignature:signature]];
    if (result.sequence) {
        // Keys pressed while the panel or the list was being driven are never replayed as more accepts.
        [self stopTheHold];
        if (result.ok) [_sequenceDone addObject:signature];
        else _hudStatus = nil;
        GHLog(@"controller: sequence label=%@ %@", GHLogLabel(_fields[signature].label), result.ok ? @"done" : (result.reason ?: @"failed"));
    }
    if (result.ok) {
        [self rememberWrittenValueOf:[_walk ghostWithSignature:signature]];
        // docs/anywhere.md section 6: an accepted proposal is remembered under its ROLE, so "fullscreen after
        // starting a video" carries to the next video Ghost has never seen.
        [self recordProposalOutcome:GHRoleOutcomeAccepted forSignature:signature];
        [self reportGhostOutcome:@"accepted" forSignature:signature];
        [_walk accept:signature];
        if ([self focusStayedWithWrite:signature]) {
            // A lock only ever gets focus straight from the user's press, never after a draft wait or a sequence.
            [self focusCurrentAllowingLock:_stepDirect && !result.sequence];
        } else {
            GHLog(@"controller: focus moved away during the write; it stays where the user put it");
            [self stopTheHold];
        }
        [self render];
        if (_walk.finished) GHLog(@"controller: walk finished accepted=%ld keystrokesSaved=%ld", (long)_walk.accepted, (long)_walk.keystrokesSaved);
        _rescanDeferred = YES;   // the page may react to the value (dependent fields, validation)
        return;
    }
    NSString *reason = result.reason ?: @"failed";
    if ([reason isEqualToString:GHWriteReasonBusy]) return;
    if ([reason isEqualToString:GHWriteReasonLocked]) { [self stopTheHold]; [self render]; return; }
    if ([reason isEqualToString:GHWriteReasonGone]) {
        [_walk drop:signature];
        _rescanDeferred = YES;
        [self render];
        return;
    }
    if (result.refused && ![reason isEqualToString:GHWriteReasonUnsupported] && ![reason isEqualToString:GHWriteReasonOptionNotFound]) {
        // Rule 9 and the safety re-check: the ghost goes away for good, without an error (nothing is broken).
        [self dismissSignature:signature];
        return;
    }
    // Rule 8: stop the walk, keep the rest pending, say why. The reason is a short code, never content.
    [self stopTheHold];
    [_walk fail:signature reason:reason];
    [self render];
}

/// Our copy of the capture is older than the write: without this, merging a late server answer into it would
/// offer the field we just filled a second time. (A real rescan replaces the copy anyway.)
- (void)rememberWrittenValueOf:(GHGhost *)ghost {
    GHField *field = ghost ? _fields[ghost.signature] : nil;
    if (!field) return;
    if ([ghost.action isEqualToString:GHGhostActionCheck]) field.value = @"true";
    else if ([ghost.action isEqualToString:GHGhostActionUpload]) field.value = ghost.displayText;   // the name the page shows
    else field.value = ghost.value.length ? ghost.value : ghost.displayText;
    // What GHOST wrote is never read back as a correction by the next capture (docs/answers.md section 4);
    // a lazy select lands as the option's own wording, so both are remembered.
    _ghostWrote[field.signature] = field.value ?: @"";
    _seenValues[field.signature] = field.value ?: @"";
}

#pragma mark - harness

/// Labels and short codes only. `ghost` may already have left the walk; nil records a step without a label.
- (void)recordStep:(NSString *)outcome reason:(NSString *)reason ghost:(GHGhost *)ghost {
    NSMutableDictionary<NSString *, id> *step = [NSMutableDictionary dictionary];
    step[@"outcome"] = outcome;
    step[@"verified"] = @([outcome isEqualToString:@"accepted"]);
    if (reason) step[@"reason"] = reason;
    if (ghost) {
        step[@"label"] = _fields[ghost.signature].label ?: @"";
        step[@"action"] = ghost.action ?: @"";
        step[@"locked"] = @(ghost.locked);
    }
    step[@"ms"] = @(round((CFAbsoluteTimeGetCurrent() - _stepStartedAt) * 1000.0));
    _lastStep = step;
    _stepCount++;
}

- (NSDictionary<NSString *, id> *)harnessState {
    NSUInteger unlocked = 0;
    for (GHGhost *ghost in _walk.ghosts) if (!ghost.locked) unlocked++;
    NSMutableDictionary<NSString *, id> *state = [@{
        @"running": @(_running), @"active": @(self.active), @"busy": @(_busy),
        @"ghosts": @(_walk.ghosts.count), @"unlocked": @(unlocked), @"accepted": @(_walk.accepted),
        @"provider": _provider ?: @"", @"statusLine": [self statusLine] ?: @"",
    } mutableCopy];
    if (_hudStatus.length) state[@"status"] = _hudStatus;
    GHGhost *current = _walk.current;
    if (current) {
        state[@"current"] = @{ @"label": _fields[current.signature].label ?: @"", @"action": current.action ?: @"",
                               @"locked": @(current.locked), @"pending": @(current.pending), @"visible": @(_currentVisible) };
    }
    return state;
}

/// Rule 2: focus moves onto the next ghost's element. Cosmetic: when the app ignores AXFocused, focus stays on the
/// field the walk just left, which still counts as "in the walk".
- (void)focusCurrentAllowingLock:(BOOL)lockAllowed {
    GHGhost *next = _walk.current;
    id<GHAXNode> node = next ? [_result nodeForSignature:next.signature] : nil;
    if (!node) return;
    if (next.locked) {
        // Parked (drawn, current) either way; keyboard focus lands on it only when the user's Tab just caused it.
        if (lockAllowed) [self.writer focusLockedNode:node];
        [self stopTheHold];
    } else {
        [self.writer focusNode:node];
    }
    [self refreshRectOfSignature:next.signature];
    // AXScrollToVisible before the next ghost is drawn: focusing an element does not always scroll it into view.
    if (![self currentIsVisibleNow]) [self revealCurrent];
}

@end
