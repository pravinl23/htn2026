#import "GHOpenPanelDriver.h"
#import "GHLog.h"
#import <stdatomic.h>

const unsigned long long GHOpenPanelMaxFileBytes = 25ull * 1024ull * 1024ull;

NSString *const GHOpenPanelReasonBusy = @"busy";
NSString *const GHOpenPanelReasonInvalidPath = @"invalid-path";
NSString *const GHOpenPanelReasonNoUploadTarget = @"no-upload-target";
NSString *const GHOpenPanelReasonNoFrontmostApp = @"no-frontmost-app";
NSString *const GHOpenPanelReasonPanelAlreadyOpen = @"panel-already-open";
NSString *const GHOpenPanelReasonPressFailed = @"press-failed";
NSString *const GHOpenPanelReasonPanelTimeout = @"panel-timeout";
NSString *const GHOpenPanelReasonFocusNotInPanel = @"focus-not-in-panel";
NSString *const GHOpenPanelReasonGoToTimeout = @"goto-timeout";
NSString *const GHOpenPanelReasonGoToFieldBusy = @"goto-field-busy";
NSString *const GHOpenPanelReasonFocusChanged = @"focus-changed";
NSString *const GHOpenPanelReasonPathMismatch = @"path-mismatch";
NSString *const GHOpenPanelReasonGoToDismissTimeout = @"goto-dismiss-timeout";
NSString *const GHOpenPanelReasonPanelCloseTimeout = @"panel-close-timeout";
NSString *const GHOpenPanelReasonFilenameNotShown = @"filename-not-shown";
NSString *const GHOpenPanelReasonAppChanged = @"app-changed";
NSString *const GHOpenPanelReasonUserKey = @"user-key";
NSString *const GHOpenPanelReasonCancelled = @"cancelled";
NSString *const GHOpenPanelReasonKeysRefused = @"keys-refused";
NSString *const GHOpenPanelReasonAlreadyShown = @"already-shown";

NSString *const GHUploadPathNotAbsolute = @"not-absolute";
NSString *const GHUploadPathControlCharacter = @"control-character";
NSString *const GHUploadPathMissing = @"missing";
NSString *const GHUploadPathNotRegularFile = @"not-regular-file";
NSString *const GHUploadPathUnreadable = @"unreadable";
NSString *const GHUploadPathTooLarge = @"too-large";
NSString *const GHUploadPathEmpty = @"empty";

static NSString *const kRoleButton = @"AXButton";
static NSString *const kRoleSheet = @"AXSheet";
static NSString *const kRoleWindow = @"AXWindow";
static NSString *const kRoleWebArea = @"AXWebArea";
static NSString *const kSubroleFileUpload = @"AXFileUploadButton";
static const NSUInteger kPanelSearchNodes = 800;
static const NSUInteger kPanelSearchDepth = 12;
static const NSUInteger kPageSearchNodes = 4000;
static const NSUInteger kPageSearchDepth = 80;
static const NSUInteger kParentWalkLimit = 64;
const NSTimeInterval GHOpenPanelWalkSeconds = 0.15;
const NSTimeInterval GHOpenPanelPageCheckSeconds = 0.25;

NSString *GHOpenPanelStateName(GHOpenPanelState state) {
    switch (state) {
        case GHOpenPanelStateIdle: return @"idle";
        case GHOpenPanelStatePressUpload: return @"pressUpload";
        case GHOpenPanelStateWaitForPanel: return @"waitForPanel";
        case GHOpenPanelStateOpenGoTo: return @"openGoTo";
        case GHOpenPanelStateWaitForGoToField: return @"waitForGoToField";
        case GHOpenPanelStateTypePath: return @"typePath";
        case GHOpenPanelStateConfirmGoTo: return @"confirmGoTo";
        case GHOpenPanelStateWaitForGoToDismissed: return @"waitForGoToDismissed";
        case GHOpenPanelStateConfirmOpen: return @"confirmOpen";
        case GHOpenPanelStateWaitForPanelClosed: return @"waitForPanelClosed";
        case GHOpenPanelStateVerifyOnPage: return @"verifyOnPage";
        case GHOpenPanelStateDone: return @"done";
        case GHOpenPanelStateFailed: return @"failed";
    }
    return @"?";
}

#pragma mark - result

@interface GHOpenPanelResult ()
@property (nonatomic, readwrite) BOOL ok;
@property (nonatomic, readwrite, copy, nullable) NSString *reason;
@property (nonatomic, readwrite) GHOpenPanelState finalState;
@property (nonatomic, readwrite, copy) NSString *filename;
@property (nonatomic, readwrite) BOOL pressedEscape;
@property (nonatomic, readwrite) BOOL panelLeftOpen;
@property (nonatomic, readwrite) BOOL verifiedOnPage;
@property (nonatomic, readwrite) NSTimeInterval elapsed;
@end

@implementation GHOpenPanelResult
- (NSString *)description {
    return [NSString stringWithFormat:@"<GHOpenPanelResult ok=%d reason=%@ state=%@ escape=%d leftOpen=%d page=%d>", self.ok,
            self.reason ?: @"-", GHOpenPanelStateName(self.finalState), self.pressedEscape, self.panelLeftOpen, self.verifiedOnPage];
}
@end

#pragma mark - helpers

static NSString *GHTrimmedLower(NSString *text) {
    return [text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].lowercaseString ?: @"";
}

static BOOL GHHasControlCharacter(NSString *text) {
    for (NSUInteger i = 0; i < text.length; i++) {
        unichar c = [text characterAtIndex:i];
        if (c < 0x20 || c == 0x7F || (c >= 0x80 && c < 0xA0) || c == 0x2028 || c == 0x2029) return YES;
    }
    return NO;
}

/// Breadth-first, bounded (nodes AND wall clock: `budget` is shared by every walk of one check), never into web
/// content unless `intoWeb`. Returns the first node `match` accepts.
static id<GHAXNode> GHFindNodeWithin(id<GHAXNode> root, NSUInteger maxDepth, NSUInteger maxNodes, BOOL intoWeb, GHAXWalkBudget *outer,
                                     BOOL (^match)(id<GHAXNode> node)) {
    if (!root) return nil;
    GHAXWalkBudget budget = GHAXWalkBudgetNested(outer, maxNodes);
    NSMutableArray<id<GHAXNode>> *queue = [NSMutableArray arrayWithObject:root];
    NSMutableArray<NSNumber *> *depths = [NSMutableArray arrayWithObject:@0];
    id<GHAXNode> found = nil;
    while (queue.count) {
        id<GHAXNode> node = queue.firstObject;
        NSUInteger depth = depths.firstObject.unsignedIntegerValue;
        [queue removeObjectAtIndex:0];
        [depths removeObjectAtIndex:0];
        if (!GHAXWalkBudgetSpend(&budget, node)) break;
        if (match(node)) { found = node; break; }
        if (depth >= maxDepth) continue;
        if (!intoWeb && [node.role isEqualToString:kRoleWebArea]) continue;
        for (id<GHAXNode> child in node.children) {
            [queue addObject:child];
            [depths addObject:@(depth + 1)];
        }
    }
    GHAXWalkBudgetAbsorb(outer, &budget);
    return found;
}

static id<GHAXNode> GHFindNode(id<GHAXNode> root, NSUInteger maxDepth, NSUInteger maxNodes, BOOL intoWeb, BOOL (^match)(id<GHAXNode> node)) {
    GHAXWalkBudget budget = GHAXWalkBudgetMake(maxNodes, GHOpenPanelWalkSeconds);
    return GHFindNodeWithin(root, maxDepth, maxNodes, intoWeb, &budget, match);
}

#pragma mark - driver

@implementation GHOpenPanelDriver {
    _Atomic(bool) _active;
    _Atomic(bool) _userKeySeen;
    NSUInteger _generation;
    void (^_completion)(GHOpenPanelResult *);
    NSString *_path;
    NSString *_filename;
    pid_t _pid;
    id<GHAXNode> _panel;
    id<GHAXNode> _goToField;
    BOOL _openedByUs;
    BOOL _panelClosedEarly;
    NSTimeInterval _started;
}

- (instancetype)initWithActuator:(id<GHAXActuating>)actuator poster:(id<GHKeyPosting>)poster state:(id<GHDesktopState>)state {
    if ((self = [super init])) {
        _actuator = actuator;
        _poster = poster;
        _state = state;
        _pollInterval = 0.1;
        _panelTimeout = 3.0;
        _goToFieldTimeout = 2.0;
        _typeSettleDelay = 0.15;
        _goToDismissTimeout = 2.0;
        _panelCloseTimeout = 3.0;
        _pageTimeout = 3.0;
        _after = ^(NSTimeInterval delay, dispatch_block_t block) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)), dispatch_get_main_queue(), block);
        };
        _clock = ^NSTimeInterval { return NSProcessInfo.processInfo.systemUptime; };
        self.pageShowsFilename = nil;
    }
    return self;
}

- (void)setPageShowsFilename:(BOOL (^)(NSString *, pid_t))pageShowsFilename {
    if (pageShowsFilename) { _pageShowsFilename = [pageShowsFilename copy]; return; }
    id<GHDesktopState> state = _state;
    _pageShowsFilename = ^BOOL(NSString *filename, pid_t pid) {
        return [GHOpenPanelDriver windows:[state windowsOfProcess:pid] showFilename:filename];
    };
}

#pragma mark pure

+ (NSString *)problemWithUploadPath:(NSString *)path {
    if (path.length == 0) return GHUploadPathEmpty;
    if (![path hasPrefix:@"/"]) return GHUploadPathNotAbsolute;
    // A control character would be typed as something else (a newline could even become an Enter).
    if (GHHasControlCharacter(path)) return GHUploadPathControlCharacter;
    NSFileManager *files = NSFileManager.defaultManager;
    // attributesOfItemAtPath does not follow a final symbolic link: a link is "not a regular file".
    NSDictionary<NSFileAttributeKey, id> *attributes = [files attributesOfItemAtPath:path error:NULL];
    if (!attributes) return GHUploadPathMissing;
    if (![attributes[NSFileType] isEqualToString:NSFileTypeRegular]) return GHUploadPathNotRegularFile;
    if (![files isReadableFileAtPath:path]) return GHUploadPathUnreadable;
    if ([attributes[NSFileSize] unsignedLongLongValue] >= GHOpenPanelMaxFileBytes) return GHUploadPathTooLarge;
    return nil;
}

+ (BOOL)isUploadButton:(id<GHAXNode>)node {
    if (![node.role isEqualToString:kRoleButton]) return NO;
    NSString *text = GHTrimmedLower(node.title.length ? node.title : (node.axDescription ?: @""));
    for (NSString *deny in @[ @"dropbox", @"google drive", @"onedrive", @"box.com", @"enter manually", @"paste", @"submit", @"apply",
                              @"send", @"remove", @"delete", @"autofill" ]) {
        if ([text containsString:deny]) return NO;
    }
    if ([node.subrole isEqualToString:kSubroleFileUpload]) return YES;
    for (NSString *prefix in @[ @"attach", @"upload", @"choose file", @"select file", @"browse" ]) {
        if ([text hasPrefix:prefix]) return YES;
    }
    return NO;
}

+ (id<GHAXNode>)uploadButtonInGroup:(id<GHAXNode>)group {
    id<GHAXNode> input = GHFindNode(group, 6, 300, NO, ^BOOL(id<GHAXNode> node) {
        return [node.role isEqualToString:kRoleButton] && [node.subrole isEqualToString:kSubroleFileUpload] && [GHOpenPanelDriver isUploadButton:node];
    });
    if (input) return input;
    return GHFindNode(group, 6, 300, NO, ^BOOL(id<GHAXNode> node) { return [GHOpenPanelDriver isUploadButton:node]; });
}

+ (id<GHAXNode>)defaultButtonOfPanel:(id<GHAXNode>)panel {
    return GHFindNode(panel, kPanelSearchDepth, kPanelSearchNodes, NO, ^BOOL(id<GHAXNode> node) {
        if (![node.role isEqualToString:kRoleButton]) return NO;
        NSString *text = GHTrimmedLower(node.title.length ? node.title : (node.axDescription ?: @""));
        return [text isEqualToString:@"open"] || [text isEqualToString:@"choose"] || [text isEqualToString:@"upload"];
    });
}

+ (id<GHAXNode>)openPanelInWindows:(NSArray<id<GHAXNode>> *)windows {
    for (id<GHAXNode> window in windows) {
        BOOL dialog = [window.role isEqualToString:kRoleWindow] && ([window.subrole isEqualToString:@"AXDialog"] || [window.subrole isEqualToString:@"AXSystemDialog"]);
        if ((dialog || [window.role isEqualToString:kRoleSheet]) && [self defaultButtonOfPanel:window]) return window;
        // Sheets hang directly below their window (or one container down). Web content never holds an AXSheet.
        for (id<GHAXNode> child in window.children) {
            if ([child.role isEqualToString:kRoleSheet]) {
                if ([self defaultButtonOfPanel:child]) return child;
                continue;
            }
            if ([child.role isEqualToString:kRoleWebArea]) continue;
            for (id<GHAXNode> grandchild in child.children) {
                if ([grandchild.role isEqualToString:kRoleSheet] && [self defaultButtonOfPanel:grandchild]) return grandchild;
            }
        }
    }
    return nil;
}

+ (BOOL)node:(id<GHAXNode>)node isInside:(id<GHAXNode>)ancestor {
    if (!node || !ancestor) return NO;
    id<GHAXNode> current = node;
    for (NSUInteger level = 0; current && level < kParentWalkLimit; level++, current = current.parent) {
        if ([current isSameNode:ancestor]) return YES;
    }
    return NO;
}

+ (BOOL)isGoToFieldCandidate:(id<GHAXNode>)node {
    if (!node || !node.enabled) return NO;
    if (![node.role isEqualToString:@"AXTextField"] && ![node.role isEqualToString:@"AXComboBox"]) return NO;
    return ![node.subrole isEqualToString:@"AXSearchField"] && ![node.subrole isEqualToString:@"AXSecureTextField"];
}

static NSArray<id<GHAXNode>> *GHWebAreasInWindows(NSArray<id<GHAXNode>> *windows, GHAXWalkBudget *outer) {
    NSMutableArray<id<GHAXNode>> *pages = [NSMutableArray array];
    for (id<GHAXNode> window in windows) {
        GHAXWalkBudget budget = GHAXWalkBudgetNested(outer, kPanelSearchNodes);
        NSMutableArray<id<GHAXNode>> *queue = [NSMutableArray arrayWithObject:window];
        while (queue.count) {
            id<GHAXNode> node = queue.firstObject;
            [queue removeObjectAtIndex:0];
            if (!GHAXWalkBudgetSpend(&budget, node)) break;
            if ([node.role isEqualToString:kRoleWebArea]) { [pages addObject:node]; continue; }
            [queue addObjectsFromArray:node.children];
        }
        GHAXWalkBudgetAbsorb(outer, &budget);
        if (outer->hung || outer->exhausted) break;
    }
    return pages;
}

static BOOL GHNodesMentionFilename(NSArray<id<GHAXNode>> *roots, NSString *filename, GHAXWalkBudget *outer) {
    if (filename.length == 0) return NO;
    BOOL (^mentions)(NSString *) = ^BOOL(NSString *text) {
        return text.length >= filename.length && [text rangeOfString:filename options:NSCaseInsensitiveSearch].location != NSNotFound;
    };
    for (id<GHAXNode> root in roots) {
        id<GHAXNode> hit = GHFindNodeWithin(root, kPageSearchDepth, kPageSearchNodes, YES, outer, ^BOOL(id<GHAXNode> node) {
            // Page text and labels only: what the user typed into a field is never read here.
            if ([node.role isEqualToString:@"AXStaticText"] && mentions(node.value)) return YES;
            return mentions(node.title) || mentions(node.axDescription);
        });
        if (hit) return YES;
        if (outer->hung || outer->exhausted) break;
    }
    return NO;
}

+ (NSArray<id<GHAXNode>> *)webAreasInWindows:(NSArray<id<GHAXNode>> *)windows {
    GHAXWalkBudget budget = GHAXWalkBudgetMake(NSUIntegerMax, GHOpenPanelPageCheckSeconds);
    return GHWebAreasInWindows(windows, &budget);
}

+ (BOOL)nodes:(NSArray<id<GHAXNode>> *)roots mentionFilename:(NSString *)filename {
    GHAXWalkBudget budget = GHAXWalkBudgetMake(NSUIntegerMax, GHOpenPanelPageCheckSeconds);
    return GHNodesMentionFilename(roots, filename, &budget);
}

+ (BOOL)windows:(NSArray<id<GHAXNode>> *)windows showFilename:(NSString *)filename {
    // One budget for the whole check: finding the web areas and searching them share GHOpenPanelPageCheckSeconds.
    GHAXWalkBudget budget = GHAXWalkBudgetMake(NSUIntegerMax, GHOpenPanelPageCheckSeconds);
    NSArray<id<GHAXNode>> *pages = GHWebAreasInWindows(windows, &budget);
    if (budget.hung) return NO;
    return GHNodesMentionFilename(pages.count ? pages : windows, filename, &budget);
}

#pragma mark run

- (void)attachFileAtPath:(NSString *)path uploadButton:(id<GHAXNode>)uploadButton completion:(void (^)(GHOpenPanelResult *))completion {
    NSString *filename = path.lastPathComponent ?: @"";
    void (^refuse)(NSString *) = ^(NSString *reason) {
        GHLog(@"openpanel: refused (%@)", reason);
        GHOpenPanelResult *result = [[GHOpenPanelResult alloc] init];
        result.reason = reason;
        result.filename = filename;
        result.finalState = GHOpenPanelStateIdle;
        completion(result);
    };
    if (_running) { refuse(GHOpenPanelReasonBusy); return; }
    NSString *problem = [GHOpenPanelDriver problemWithUploadPath:path];
    if (problem) { refuse([NSString stringWithFormat:@"%@:%@", GHOpenPanelReasonInvalidPath, problem]); return; }
    id<GHAXNode> button = uploadButton ? [self.actuator refreshedNode:uploadButton] : nil;
    if (![GHOpenPanelDriver isUploadButton:button] || !button.enabled) { refuse(GHOpenPanelReasonNoUploadTarget); return; }
    pid_t pid = [self.state frontmostProcessIdentifier];
    if (pid <= 0) { refuse(GHOpenPanelReasonNoFrontmostApp); return; }
    // Only a panel THIS run opens is ever driven.
    if ([GHOpenPanelDriver openPanelInWindows:[self.state windowsOfProcess:pid]]) { refuse(GHOpenPanelReasonPanelAlreadyOpen); return; }
    // A page that already shows the name would make the final check meaningless.
    if (self.pageShowsFilename(filename, pid)) { refuse(GHOpenPanelReasonAlreadyShown); return; }

    _running = YES;
    _generation++;
    atomic_store(&_userKeySeen, false);
    atomic_store(&_active, true);
    _completion = [completion copy];
    _path = [path copy];
    _filename = [filename copy];
    _pid = pid;
    _panel = nil;
    _goToField = nil;
    _openedByUs = NO;
    _panelClosedEarly = NO;
    _started = self.clock();
    GHLog(@"openpanel: start");

    [self enter:GHOpenPanelStatePressUpload message:@"Opening the file picker"];
    if (![self.actuator pressNode:button]) { [self fail:GHOpenPanelReasonPressFailed escape:NO]; return; }
    [self enter:GHOpenPanelStateWaitForPanel message:nil];
    [self waitUntil:^BOOL {
        id<GHAXNode> panel = [GHOpenPanelDriver openPanelInWindows:[self.state windowsOfProcess:self->_pid]];
        if (!panel) return NO;
        self->_panel = panel;
        self->_openedByUs = YES;
        return YES;
    } timeout:self.panelTimeout then:^{ [self openGoTo]; } timeoutReason:GHOpenPanelReasonPanelTimeout escape:NO watchUser:YES];
}

- (void)openGoTo {
    [self enter:GHOpenPanelStateOpenGoTo message:[NSString stringWithFormat:@"Picking %@", _filename]];
    GHKeyBurstResult *burst = [self.poster postBurst:@[ [GHKeyStroke goToFolder] ] guard:^BOOL(GHKeyStroke *stroke, pid_t frontmost, id<GHAXNode> focused) {
        return [GHOpenPanelDriver node:focused isInside:self->_panel] && [self mayPostTo:frontmost];
    } lastCheck:[self mayStillPost]];
    if (!burst.ok) { [self fail:[self reasonForBurst:burst fallback:GHOpenPanelReasonFocusNotInPanel] escape:NO]; return; }
    [self enter:GHOpenPanelStateWaitForGoToField message:nil];
    [self waitUntil:^BOOL {
        id<GHAXNode> focused = [self.state focusedElement];
        if (![GHOpenPanelDriver isGoToFieldCandidate:focused] || ![GHOpenPanelDriver node:focused isInside:self->_panel]) return NO;
        self->_goToField = focused;
        return YES;
    } timeout:self.goToFieldTimeout then:^{ [self typePath]; } timeoutReason:GHOpenPanelReasonGoToTimeout escape:YES watchUser:YES];
}

- (void)typePath {
    [self enter:GHOpenPanelStateTypePath message:nil];
    id<GHAXNode> field = [self.actuator refreshedNode:_goToField];
    if (!field) { [self fail:GHOpenPanelReasonFocusChanged escape:NO]; return; }
    // The go-to field usually opens with the last folder selected; typing replaces a selection, never appends.
    if (field.value.length > 0 && ![self.actuator selectAllInNode:field]) { [self fail:GHOpenPanelReasonGoToFieldBusy escape:YES]; return; }
    GHKeyBurstResult *burst = [self.poster postBurst:@[ [GHKeyStroke text:_path] ] guard:^BOOL(GHKeyStroke *stroke, pid_t frontmost, id<GHAXNode> focused) {
        return [focused isSameNode:self->_goToField] && [self mayPostTo:frontmost];
    } lastCheck:[self mayStillPost]];
    if (!burst.ok) { [self fail:[self reasonForBurst:burst fallback:GHOpenPanelReasonFocusChanged] escape:NO]; return; }
    NSUInteger generation = _generation;
    self.after(self.typeSettleDelay, ^{
        if (generation != self->_generation || !self->_running || ![self stillSafe]) return;
        if (![self goToFieldHoldsPath]) { [self fail:GHOpenPanelReasonPathMismatch escape:YES]; return; }
        [self confirmGoTo];
    });
}

- (BOOL)goToFieldHoldsPath {
    id<GHAXNode> field = [self.actuator refreshedNode:_goToField];
    return field != nil && [field.value isEqualToString:_path];
}

- (void)confirmGoTo {
    [self enter:GHOpenPanelStateConfirmGoTo message:nil];
    GHKeyBurstResult *burst = [self.poster postBurst:@[ [GHKeyStroke returnKey] ] guard:^BOOL(GHKeyStroke *stroke, pid_t frontmost, id<GHAXNode> focused) {
        // The window walk and the field read first; focus, the app and the user's keys last (and again by the poster).
        return [self panelStillThere] && [self goToFieldHoldsPath] && [focused isSameNode:self->_goToField] && [self mayPostTo:frontmost];
    } lastCheck:[self mayStillPost]];
    if (!burst.ok) { [self fail:[self reasonForBurst:burst fallback:GHOpenPanelReasonFocusChanged] escape:NO]; return; }
    [self enter:GHOpenPanelStateWaitForGoToDismissed message:nil];
    [self waitUntil:^BOOL {
        if (![self panelStillThere]) { self->_panelClosedEarly = YES; return YES; }
        id<GHAXNode> focused = [self.state focusedElement];
        if (!focused || [focused isSameNode:self->_goToField]) return NO;
        if (![GHOpenPanelDriver node:focused isInside:self->_panel]) return NO;
        return [self openButtonEnabled];
    } timeout:self.goToDismissTimeout then:^{
        // Some panels choose the file on the first Return: the page gets it, and a second Return must never follow.
        if (self->_panelClosedEarly) [self verifyOnPage]; else [self confirmOpen];
    } timeoutReason:GHOpenPanelReasonGoToDismissTimeout escape:YES watchUser:YES];
}

/// Read from a panel found again in freshly read windows: live nodes are snapshots, and the one kept in _panel still
/// says whatever the Open button said when the panel appeared (usually "disabled").
- (BOOL)openButtonEnabled {
    id<GHAXNode> panel = [self freshPanel];
    id<GHAXNode> button = panel ? [GHOpenPanelDriver defaultButtonOfPanel:panel] : nil;
    return button != nil && button.enabled;
}

- (void)confirmOpen {
    [self enter:GHOpenPanelStateConfirmOpen message:nil];
    GHKeyBurstResult *burst = [self.poster postBurst:@[ [GHKeyStroke returnKey] ] guard:^BOOL(GHKeyStroke *stroke, pid_t frontmost, id<GHAXNode> focused) {
        return [self openButtonEnabled] && [GHOpenPanelDriver node:focused isInside:self->_panel] && ![focused isSameNode:self->_goToField]
            && [self mayPostTo:frontmost];
    } lastCheck:[self mayStillPost]];
    if (!burst.ok) { [self fail:[self reasonForBurst:burst fallback:GHOpenPanelReasonFocusNotInPanel] escape:NO]; return; }
    [self enter:GHOpenPanelStateWaitForPanelClosed message:nil];
    [self waitUntil:^BOOL { return ![self panelStillThere]; }
            timeout:self.panelCloseTimeout then:^{ [self verifyOnPage]; } timeoutReason:GHOpenPanelReasonPanelCloseTimeout escape:YES watchUser:YES];
}

- (void)verifyOnPage {
    [self enter:GHOpenPanelStateVerifyOnPage message:nil];
    // The panel is gone and nothing more is posted: a key or an app switch now cannot hurt, so they do not abort.
    [self waitUntil:^BOOL { return self.pageShowsFilename(self->_filename, self->_pid); }
            timeout:self.pageTimeout then:^{ [self succeed]; } timeoutReason:GHOpenPanelReasonFilenameNotShown escape:NO watchUser:NO];
}

#pragma mark plumbing

- (void)enter:(GHOpenPanelState)state message:(NSString *)message {
    _currentState = state;
    if (message && self.progress) self.progress(state, message);
}

- (BOOL)mayPostTo:(pid_t)frontmost {
    return _running && !atomic_load(&_userKeySeen) && frontmost == _pid;
}

/// The panel this run drives, found again in freshly read windows (never the cached snapshot). nil once it is gone.
- (id<GHAXNode>)freshPanel {
    if (!_panel) return nil;
    id<GHAXNode> panel = [GHOpenPanelDriver openPanelInWindows:[self.state windowsOfProcess:_pid]];
    return (panel != nil && [panel isSameNode:_panel]) ? panel : nil;
}

- (BOOL)panelStillThere {
    return [self freshPanel] != nil;
}

/// The poster's very last question before each post: still running, no key of the user's, same app in front.
- (BOOL (^)(void))mayStillPost {
    __weak GHOpenPanelDriver *weakSelf = self;
    return ^BOOL {
        GHOpenPanelDriver *driver = weakSelf;
        return driver != nil && [driver mayPostTo:[driver.state frontmostProcessIdentifier]];
    };
}

/// YES while nothing forbids going on; otherwise fails the run and returns NO.
- (BOOL)stillSafe {
    if (atomic_load(&_userKeySeen)) { [self fail:GHOpenPanelReasonUserKey escape:NO]; return NO; }
    if ([self.state frontmostProcessIdentifier] != _pid) { [self fail:GHOpenPanelReasonAppChanged escape:NO]; return NO; }
    return YES;
}

- (NSString *)reasonForBurst:(GHKeyBurstResult *)burst fallback:(NSString *)fallback {
    if ([burst.reason isEqualToString:GHKeyBurstReasonPostFailed] || [burst.reason isEqualToString:GHKeyBurstReasonMalformed]) return GHOpenPanelReasonKeysRefused;
    if (atomic_load(&_userKeySeen)) return GHOpenPanelReasonUserKey;
    if ([self.state frontmostProcessIdentifier] != _pid) return GHOpenPanelReasonAppChanged;
    return fallback;
}

- (void)waitUntil:(BOOL (^)(void))ready timeout:(NSTimeInterval)timeout then:(dispatch_block_t)next
    timeoutReason:(NSString *)reason escape:(BOOL)escape watchUser:(BOOL)watchUser {
    [self tick:ready deadline:self.clock() + timeout generation:_generation then:next reason:reason escape:escape watchUser:watchUser];
}

- (void)tick:(BOOL (^)(void))ready deadline:(NSTimeInterval)deadline generation:(NSUInteger)generation then:(dispatch_block_t)next
      reason:(NSString *)reason escape:(BOOL)escape watchUser:(BOOL)watchUser {
    if (generation != _generation || !_running) return;
    if (watchUser && ![self stillSafe]) return;
    if (ready()) { next(); return; }
    if (self.clock() >= deadline) { [self fail:reason escape:escape]; return; }
    self.after(self.pollInterval, ^{
        [self tick:ready deadline:deadline generation:generation then:next reason:reason escape:escape watchUser:watchUser];
    });
}

- (void)fail:(NSString *)reason escape:(BOOL)escape {
    if (!_running) return;
    BOOL pressedEscape = NO;
    // One Escape, only into a panel this run opened, only while focus is inside it, never after the user took over.
    if (escape && _openedByUs && [self panelStillThere]) {
        GHKeyBurstResult *burst = [self.poster postBurst:@[ [GHKeyStroke escape] ] guard:^BOOL(GHKeyStroke *stroke, pid_t frontmost, id<GHAXNode> focused) {
            return [GHOpenPanelDriver node:focused isInside:self->_panel] && [self mayPostTo:frontmost];
        } lastCheck:[self mayStillPost]];
        pressedEscape = burst.ok;
    }
    GHOpenPanelResult *result = [[GHOpenPanelResult alloc] init];
    result.reason = reason;
    result.finalState = _currentState;
    result.pressedEscape = pressedEscape;
    result.panelLeftOpen = [self panelStillThere];
    [self finish:result];
}

- (void)succeed {
    GHOpenPanelResult *result = [[GHOpenPanelResult alloc] init];
    result.ok = YES;
    result.verifiedOnPage = YES;
    result.finalState = GHOpenPanelStateDone;
    [self enter:GHOpenPanelStateDone message:[NSString stringWithFormat:@"Attached %@", _filename]];
    [self finish:result];
}

- (void)finish:(GHOpenPanelResult *)result {
    result.filename = _filename ?: @"";
    result.elapsed = self.clock() - _started;
    GHOpenPanelState stoppedIn = _currentState;
    _running = NO;
    atomic_store(&_active, false);
    _generation++;
    _currentState = result.ok ? GHOpenPanelStateDone : GHOpenPanelStateFailed;
    _panel = nil;
    _goToField = nil;
    void (^completion)(GHOpenPanelResult *) = _completion;
    _completion = nil;
    GHLog(@"openpanel: %@ in %@ (escape=%d leftOpen=%d) %.0f ms", result.ok ? @"attached" : result.reason, GHOpenPanelStateName(stoppedIn),
          result.pressedEscape, result.panelLeftOpen, result.elapsed * 1000.0);
    if (!result.ok && self.progress) self.progress(GHOpenPanelStateFailed, [NSString stringWithFormat:@"Could not attach %@ (%@)", result.filename, result.reason]);
    if (completion) completion(result);
}

- (void)noteUserKeyEvent {
    if (atomic_load(&_active)) atomic_store(&_userKeySeen, true);
}

- (void)cancel {
    [self fail:GHOpenPanelReasonCancelled escape:NO];
}

@end
