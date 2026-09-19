#import "GHController.h"
#import "GHCapture.h"
#import "GHCore.h"
#import "GHLog.h"
#import "GHOverlayWindow.h"
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
static const NSTimeInterval kValueRescanSpacing = 0.5;
static const NSTimeInterval kScrollSettleSeconds = 0.06;
static const NSTimeInterval kDraftRenderSpacing = 0.08;
static const NSUInteger kFocusClimb = 3;

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
    BOOL _drainChecksFocus;
    BOOL _rescanDeferred;
    NSString *_waitingDraft;
    void (^_waitContinuation)(BOOL ready);
    NSUInteger _waitToken;

    CFAbsoluteTime _quietUntil;
    CFAbsoluteTime _lastRescanAt;
    NSUInteger _scrollGeneration;
    NSString *_lastStatusLine;
    NSString *_lastRescanLog;
    CFAbsoluteTime _stepStartedAt;
}

@synthesize eventTap = _eventTap;

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
}

- (GHWriter *)writer {
    if (!_writer) _writer = [[GHWriter alloc] initWithActuator:[[GHAXLiveActuator alloc] init]];
    return _writer;
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

    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(storeDidChange:) name:GHProfileStoreDidChangeNotification object:_store];
    self.accessibility.delegate = self;
    [self syncPauseList];
    [self.accessibility start];
    [self.eventTap install];
    GHLog(@"controller: started (tap %@)", self.eventTap.installed ? @"installed" : @"NOT installed");
    [self rescanForReasons:GHRescanReasonManual];
}

- (void)stop {
    if (!_running) return;
    _running = NO;
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
    _predictionRequests = 0;
    _provider = kOfflineProvider;
    _cacheState = @"offline";
    _shownAt = 0;
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
    GHCaptureResult *result = [ax captureFocusedWindowWithCapture:self.capture];
    NSString *bundle = ax.frontmostBundleIdentifier ?: @"";
    NSString *title = result ? ([ax focusedWindowTitle] ?: @"") : @"";
    NSString *webOrigin = result.webAreaNode ? [ax originOfWebAreaNode:result.webAreaNode] : nil;
    NSString *pageKey = [@[ bundle, webOrigin ?: @"", title ] componentsJoinedByString:@"\n"];
    NSString *origin = [GHServerClient originForBundleId:bundle pageURL:webOrigin windowTitle:title];
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

    NSMutableDictionary *options = [NSMutableDictionary dictionary];
    options[@"keepLock"] = @(_walk.keepLock);
    if (_walk.lockSignature) options[@"lockSignature"] = _walk.lockSignature;

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
        [ghosts addObject:ghost];
    }
    NSArray<GHGhost *> *withDrafts = [self ghostsByAddingDrafts:ghosts offline:offline answers:answers settings:settings];
    if ([_cacheState isEqualToString:@"offline"]) _latencyMs = @(MAX(0.0, (result.elapsed + (CFAbsoluteTimeGetCurrent() - started)) * 1000.0));

    // Focus is re-read against the new capture; the walk keeps its current ghost first and follows focus second.
    if (self.accessibility.running) [_walk noteFocus:[self liveFocusSignature]];
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
    return !([kind isEqualToString:GHKindButton] || [kind isEqualToString:GHKindLink] || [kind isEqualToString:GHKindFile] || [kind isEqualToString:GHKindOther]);
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
        NSDictionary *context = field.context.length ? @{ @"description": field.context } : @{};
        draft.stream = [_client streamGhostTextForFieldLabel:field.label fieldSignature:field.signature pageContext:context
                                                     profile:_store.profile maxChars:kDraftMaxChars delegate:self];
        // nil = refused locally (sensitive label, no server URL): the delegate hears the reason on the next turn.
    }
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

static BOOL GHIsWindowItself(id<GHAXNode> node) {
    static NSSet<NSString *> *roles;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ roles = [NSSet setWithArray:@[ @"AXWindow", @"AXWebArea", @"AXApplication", @"AXScrollArea", @"AXSheet", @"AXDialog" ]]; });
    NSString *role = node.role;
    return role.length == 0 || [roles containsObject:role];
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
    if (!node || GHIsWindowItself(node)) return nil;
    id<GHAXNode> cursor = node;
    for (NSUInteger level = 0; cursor && level <= kFocusClimb; level++) {
        NSString *signature = [self signatureOfFieldAtNode:cursor];
        if (signature) return signature;
        cursor = cursor.parent;   // a combo box focuses its inner text field
        if (cursor && GHIsWindowItself(cursor)) break;
    }
    return GHWalkFocusElsewhere;
}

/// Where the keyboard is, read live. A failed read is NOT "the window itself": when Ghost cannot tell where focus
/// is, Tab stays native.
- (NSString *)liveFocusSignature {
    GHAccessibility *ax = self.accessibility;
    id<GHAXNode> node = [ax focusedElementNode];
    if (!node && ax.lastError != kAXErrorSuccess) return GHWalkFocusElsewhere;
    return [self focusSignatureForNode:node];
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
    return input;
}

- (void)render {
    GHOverlayWindow *overlay = self.overlay;
    if (!self.active || !overlay) {
        [overlay hideImmediately];
        _currentVisible = NO;
    } else {
        GHOverlayInput *input = [self overlayInput];
        if (input.entries.count == 0 && !input.hud && !input.error) {
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
    [self.eventTap publishSnapshot:[_walk snapshotWithActive:self.active currentVisible:_currentVisible busy:_busy]];
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

#pragma mark - GHEventTapDelegate

- (void)eventTap:(GHEventTap *)tap didConsumeTab:(GHKeyDecision)decision isRepeat:(BOOL)isRepeat {
    if (!_running && !self.assumesActive) return;
    if (_busy) {
        // A fresh press during a write is queued (never dropped, never native); a repeat is dropped.
        if (!isRepeat) _pendingTabs = MIN(_pendingTabs + 1, (NSInteger)_walk.ghosts.count);
        return;
    }
    _drainIsRepeat = isRepeat;
    _drainChecksFocus = !isRepeat && decision != GHKeyDecisionQueue;
    _pendingTabs++;
    [self drain];
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
    __weak GHController *weakSelf = self;
    [self acceptCurrentThen:^{ [weakSelf drainStep]; }];
}

- (void)finishDrain {
    _busy = NO;
    _pendingTabs = 0;
    [self publish];
    if (_rescanDeferred) {
        _rescanDeferred = NO;
        if (_running) [self.accessibility setNeedsRescan:GHRescanReasonManual];
        else if (self.assumesActive && _result) [self adoptCaptureResult:_result pageKey:_pageKey ?: @"" origin:_origin ?: @""];
    }
}

/// The snapshot the tap decided on can be a few milliseconds old. If the user has meanwhile put focus somewhere
/// that is not part of the walk, the Tab was theirs: hand it back instead of filling anything.
- (BOOL)userLeftTheWalk {
    GHAccessibility *ax = self.accessibility;
    if (!ax.running || !ax.trusted) return NO;
    [_walk noteFocus:[self liveFocusSignature]];
    return ![_walk snapshotWithActive:YES currentVisible:YES busy:NO].focusInWalk;
}

- (void)stopTheHold {
    _pendingTabs = 0;
    [self.eventTap haltHold];
}

- (void)acceptCurrentThen:(dispatch_block_t)done {
    GHGhost *ghost = _walk.current;
    // Paused, disabled or handed to the extension between the key press and now: nothing is written.
    if (!ghost || !self.active) { [self recordStep:@"inactive" reason:nil ghost:ghost]; [self stopTheHold]; done(); return; }
    if (_drainChecksFocus) {
        _drainChecksFocus = NO;
        if ([self userLeftTheWalk]) {
            GHLog(@"controller: focus left the walk before the write; Tab handed back to the app");
            [self recordStep:@"handed-back" reason:nil ghost:ghost];
            [self stopTheHold];
            [GHEventTap postKeyCode:GHKeyCodeTab];
            done();
            return;
        }
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
    if (ghost.locked) { [self recordStep:@"parked" reason:GHWriteReasonLocked ghost:ghost]; [self parkOn:node]; done(); return; }
    if (ghost.pending) { [self acceptPending:ghost then:done]; return; }
    if (![self currentIsVisibleNow]) {
        // A queued press, but the field got hidden or scrolled away meanwhile: no write the user cannot see.
        [self recordStep:@"not-visible" reason:nil ghost:ghost];
        _pendingTabs = 0;
        _rescanDeferred = YES;
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
    NSString *signature = ghost.signature;
    _quietUntil = CFAbsoluteTimeGetCurrent() + 2.0;   // until the write reports back
    __weak GHController *weakSelf = self;
    [self.writer executeGhost:ghost field:field node:node optionNode:optionNode completion:^(GHWriteResult *result) {
        GHController *controller = weakSelf;
        if (!controller) return;
        [controller finishedWriting:signature result:result];
        done();
    }];
}

- (void)finishedWriting:(NSString *)signature result:(GHWriteResult *)result {
    _quietUntil = CFAbsoluteTimeGetCurrent() + kOwnWriteQuietSeconds;
    if (!_running && !self.assumesActive) return;
    [self recordStep:result.ok ? @"accepted" : (result.refused ? @"refused" : @"failed") reason:result.ok ? nil : (result.reason ?: @"failed")
               ghost:[_walk ghostWithSignature:signature]];
    if (result.ok) {
        [self rememberWrittenValueOf:[_walk ghostWithSignature:signature]];
        [_walk accept:signature];
        [self focusCurrent];
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
    else field.value = ghost.value.length ? ghost.value : ghost.displayText;
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
    GHGhost *current = _walk.current;
    if (current) {
        state[@"current"] = @{ @"label": _fields[current.signature].label ?: @"", @"action": current.action ?: @"",
                               @"locked": @(current.locked), @"pending": @(current.pending), @"visible": @(_currentVisible) };
    }
    return state;
}

/// Rule 2: focus moves onto the next ghost's element. Cosmetic: when the app ignores AXFocused, focus stays on the
/// field the walk just left, which still counts as "in the walk".
- (void)focusCurrent {
    GHGhost *next = _walk.current;
    id<GHAXNode> node = next ? [_result nodeForSignature:next.signature] : nil;
    if (!node) return;
    if (next.locked) { [self.writer focusLockedNode:node]; [self.eventTap haltHold]; }
    else [self.writer focusNode:node];
    [self refreshRectOfSignature:next.signature];
}

@end
