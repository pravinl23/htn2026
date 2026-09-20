#import "SBOpenPanelDriver.h"
#import "SBLog.h"
#import <stdatomic.h>

const unsigned long long SBOpenPanelMaxFileBytes = 25ull * 1024ull * 1024ull;

NSString *const SBOpenPanelReasonBusy = @"busy";
NSString *const SBOpenPanelReasonInvalidPath = @"invalid-path";
NSString *const SBOpenPanelReasonNoUploadTarget = @"no-upload-target";
NSString *const SBOpenPanelReasonNoFrontmostApp = @"no-frontmost-app";
NSString *const SBOpenPanelReasonPanelAlreadyOpen = @"panel-already-open";
NSString *const SBOpenPanelReasonPressFailed = @"press-failed";
NSString *const SBOpenPanelReasonPanelTimeout = @"panel-timeout";
NSString *const SBOpenPanelReasonFocusNotInPanel = @"focus-not-in-panel";
NSString *const SBOpenPanelReasonGoToTimeout = @"goto-timeout";
NSString *const SBOpenPanelReasonGoToFieldBusy = @"goto-field-busy";
NSString *const SBOpenPanelReasonFocusChanged = @"focus-changed";
NSString *const SBOpenPanelReasonPathMismatch = @"path-mismatch";
NSString *const SBOpenPanelReasonGoToDismissTimeout = @"goto-dismiss-timeout";
NSString *const SBOpenPanelReasonPanelCloseTimeout = @"panel-close-timeout";
NSString *const SBOpenPanelReasonFilenameNotShown = @"filename-not-shown";
NSString *const SBOpenPanelReasonAppChanged = @"app-changed";
NSString *const SBOpenPanelReasonUserKey = @"user-key";
NSString *const SBOpenPanelReasonCancelled = @"cancelled";
NSString *const SBOpenPanelReasonKeysRefused = @"keys-refused";
NSString *const SBOpenPanelReasonAlreadyShown = @"already-shown";

NSString *const SBUploadPathNotAbsolute = @"not-absolute";
NSString *const SBUploadPathControlCharacter = @"control-character";
NSString *const SBUploadPathMissing = @"missing";
NSString *const SBUploadPathNotRegularFile = @"not-regular-file";
NSString *const SBUploadPathUnreadable = @"unreadable";
NSString *const SBUploadPathTooLarge = @"too-large";
NSString *const SBUploadPathEmpty = @"empty";

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
const NSTimeInterval SBOpenPanelWalkSeconds = 0.15;
const NSTimeInterval SBOpenPanelPageCheckSeconds = 0.25;

NSString *SBOpenPanelStateName(SBOpenPanelState state) {
    switch (state) {
        case SBOpenPanelStateIdle: return @"idle";
        case SBOpenPanelStatePressUpload: return @"pressUpload";
        case SBOpenPanelStateWaitForPanel: return @"waitForPanel";
        case SBOpenPanelStateOpenGoTo: return @"openGoTo";
        case SBOpenPanelStateWaitForGoToField: return @"waitForGoToField";
        case SBOpenPanelStateTypePath: return @"typePath";
        case SBOpenPanelStateConfirmGoTo: return @"confirmGoTo";
        case SBOpenPanelStateWaitForGoToDismissed: return @"waitForGoToDismissed";
        case SBOpenPanelStateConfirmOpen: return @"confirmOpen";
        case SBOpenPanelStateWaitForPanelClosed: return @"waitForPanelClosed";
        case SBOpenPanelStateVerifyOnPage: return @"verifyOnPage";
        case SBOpenPanelStateDone: return @"done";
        case SBOpenPanelStateFailed: return @"failed";
    }
    return @"?";
}

#pragma mark - result

@interface SBOpenPanelResult ()
@property (nonatomic, readwrite) BOOL ok;
@property (nonatomic, readwrite, copy, nullable) NSString *reason;
@property (nonatomic, readwrite) SBOpenPanelState finalState;
@property (nonatomic, readwrite, copy) NSString *filename;
@property (nonatomic, readwrite) BOOL pressedEscape;
@property (nonatomic, readwrite) BOOL panelLeftOpen;
@property (nonatomic, readwrite) BOOL verifiedOnPage;
@property (nonatomic, readwrite) NSTimeInterval elapsed;
@end

@implementation SBOpenPanelResult
- (NSString *)description {
    return [NSString stringWithFormat:@"<SBOpenPanelResult ok=%d reason=%@ state=%@ escape=%d leftOpen=%d page=%d>", self.ok,
            self.reason ?: @"-", SBOpenPanelStateName(self.finalState), self.pressedEscape, self.panelLeftOpen, self.verifiedOnPage];
}
@end

#pragma mark - helpers

static NSString *SBTrimmedLower(NSString *text) {
    return [text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].lowercaseString ?: @"";
}

static BOOL SBHasControlCharacter(NSString *text) {
    for (NSUInteger i = 0; i < text.length; i++) {
        unichar c = [text characterAtIndex:i];
        if (c < 0x20 || c == 0x7F || (c >= 0x80 && c < 0xA0) || c == 0x2028 || c == 0x2029) return YES;
    }
    return NO;
}

/// Breadth-first, bounded (nodes AND wall clock: `budget` is shared by every walk of one check), never into web
/// content unless `intoWeb`. Returns the first node `match` accepts.
static id<SBAXNode> SBFindNodeWithin(id<SBAXNode> root, NSUInteger maxDepth, NSUInteger maxNodes, BOOL intoWeb, SBAXWalkBudget *outer,
                                     BOOL (^match)(id<SBAXNode> node)) {
    if (!root) return nil;
    SBAXWalkBudget budget = SBAXWalkBudgetNested(outer, maxNodes);
    NSMutableArray<id<SBAXNode>> *queue = [NSMutableArray arrayWithObject:root];
    NSMutableArray<NSNumber *> *depths = [NSMutableArray arrayWithObject:@0];
    id<SBAXNode> found = nil;
    while (queue.count) {
        id<SBAXNode> node = queue.firstObject;
        NSUInteger depth = depths.firstObject.unsignedIntegerValue;
        [queue removeObjectAtIndex:0];
        [depths removeObjectAtIndex:0];
        if (!SBAXWalkBudgetSpend(&budget, node)) break;
        if (match(node)) { found = node; break; }
        if (depth >= maxDepth) continue;
        if (!intoWeb && [node.role isEqualToString:kRoleWebArea]) continue;
        for (id<SBAXNode> child in node.children) {
            [queue addObject:child];
            [depths addObject:@(depth + 1)];
        }
    }
    SBAXWalkBudgetAbsorb(outer, &budget);
    return found;
}

static id<SBAXNode> SBFindNode(id<SBAXNode> root, NSUInteger maxDepth, NSUInteger maxNodes, BOOL intoWeb, BOOL (^match)(id<SBAXNode> node)) {
    SBAXWalkBudget budget = SBAXWalkBudgetMake(maxNodes, SBOpenPanelWalkSeconds);
    return SBFindNodeWithin(root, maxDepth, maxNodes, intoWeb, &budget, match);
}

#pragma mark - driver

@implementation SBOpenPanelDriver {
    _Atomic(bool) _active;
    _Atomic(bool) _userKeySeen;
    NSUInteger _generation;
    void (^_completion)(SBOpenPanelResult *);
    NSString *_path;
    NSString *_filename;
    pid_t _pid;
    id<SBAXNode> _panel;
    id<SBAXNode> _goToField;
    BOOL _openedByUs;
    BOOL _panelClosedEarly;
    NSTimeInterval _started;
}

- (instancetype)initWithActuator:(id<SBAXActuating>)actuator poster:(id<SBKeyPosting>)poster state:(id<SBDesktopState>)state {
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
    id<SBDesktopState> state = _state;
    _pageShowsFilename = ^BOOL(NSString *filename, pid_t pid) {
        return [SBOpenPanelDriver windows:[state windowsOfProcess:pid] showFilename:filename];
    };
}

#pragma mark pure

+ (NSString *)problemWithUploadPath:(NSString *)path {
    if (path.length == 0) return SBUploadPathEmpty;
    if (![path hasPrefix:@"/"]) return SBUploadPathNotAbsolute;
    // A control character would be typed as something else (a newline could even become an Enter).
    if (SBHasControlCharacter(path)) return SBUploadPathControlCharacter;
    NSFileManager *files = NSFileManager.defaultManager;
    // attributesOfItemAtPath does not follow a final symbolic link: a link is "not a regular file".
    NSDictionary<NSFileAttributeKey, id> *attributes = [files attributesOfItemAtPath:path error:NULL];
    if (!attributes) return SBUploadPathMissing;
    if (![attributes[NSFileType] isEqualToString:NSFileTypeRegular]) return SBUploadPathNotRegularFile;
    if (![files isReadableFileAtPath:path]) return SBUploadPathUnreadable;
    if ([attributes[NSFileSize] unsignedLongLongValue] >= SBOpenPanelMaxFileBytes) return SBUploadPathTooLarge;
    return nil;
}

+ (BOOL)isUploadButton:(id<SBAXNode>)node {
    if (![node.role isEqualToString:kRoleButton]) return NO;
    NSString *text = SBTrimmedLower(node.title.length ? node.title : (node.axDescription ?: @""));
    for (NSString *deny in @[ @"dropbox", @"google drive", @"onedrive", @"box.com", @"enter manually", @"paste", @"submit", @"apply",
                              @"send", @"remove", @"delete", @"autofill" ]) {
        if ([text containsString:deny]) return NO;
    }
    if ([node.subrole isEqualToString:kSubroleFileUpload]) return YES;
    for (NSString *prefix in @[ @"attach", @"upload", @"choose file", @"select file", @"browse" ]) {
        if ([text hasPrefix:prefix]) return YES;
    }
    // Chromium publishes <input type=file> as a plain AXButton with no subrole, and appends the control's own
    // state to its name instead: "Resume / CV: No file chosen". That state is the only thing that identifies
    // it, and no other kind of button says it. Without this the writer refuses its own upload ghost with
    // no-upload-target, which is exactly what it did on a real form in Chrome.
    for (NSString *state in @[ @"no file chosen", @"no files chosen", @"no file selected", @"no files selected",
                               @"file chosen", @"file selected", @"files chosen", @"files selected" ]) {
        if ([text containsString:state]) return YES;
    }
    return NO;
}

+ (id<SBAXNode>)uploadButtonInGroup:(id<SBAXNode>)group {
    id<SBAXNode> input = SBFindNode(group, 6, 300, NO, ^BOOL(id<SBAXNode> node) {
        return [node.role isEqualToString:kRoleButton] && [node.subrole isEqualToString:kSubroleFileUpload] && [SBOpenPanelDriver isUploadButton:node];
    });
    if (input) return input;
    return SBFindNode(group, 6, 300, NO, ^BOOL(id<SBAXNode> node) { return [SBOpenPanelDriver isUploadButton:node]; });
}

+ (id<SBAXNode>)defaultButtonOfPanel:(id<SBAXNode>)panel {
    return SBFindNode(panel, kPanelSearchDepth, kPanelSearchNodes, NO, ^BOOL(id<SBAXNode> node) {
        if (![node.role isEqualToString:kRoleButton]) return NO;
        NSString *text = SBTrimmedLower(node.title.length ? node.title : (node.axDescription ?: @""));
        return [text isEqualToString:@"open"] || [text isEqualToString:@"choose"] || [text isEqualToString:@"upload"];
    });
}

+ (id<SBAXNode>)openPanelInWindows:(NSArray<id<SBAXNode>> *)windows {
    for (id<SBAXNode> window in windows) {
        BOOL dialog = [window.role isEqualToString:kRoleWindow] && ([window.subrole isEqualToString:@"AXDialog"] || [window.subrole isEqualToString:@"AXSystemDialog"]);
        if ((dialog || [window.role isEqualToString:kRoleSheet]) && [self defaultButtonOfPanel:window]) return window;
        // Sheets hang directly below their window (or one container down). Web content never holds an AXSheet.
        for (id<SBAXNode> child in window.children) {
            if ([child.role isEqualToString:kRoleSheet]) {
                if ([self defaultButtonOfPanel:child]) return child;
                continue;
            }
            if ([child.role isEqualToString:kRoleWebArea]) continue;
            for (id<SBAXNode> grandchild in child.children) {
                if ([grandchild.role isEqualToString:kRoleSheet] && [self defaultButtonOfPanel:grandchild]) return grandchild;
            }
        }
    }
    return nil;
}

+ (BOOL)node:(id<SBAXNode>)node isInside:(id<SBAXNode>)ancestor {
    if (!node || !ancestor) return NO;
    id<SBAXNode> current = node;
    for (NSUInteger level = 0; current && level < kParentWalkLimit; level++, current = current.parent) {
        if ([current isSameNode:ancestor]) return YES;
    }
    return NO;
}

+ (BOOL)isGoToFieldCandidate:(id<SBAXNode>)node {
    if (!node || !node.enabled) return NO;
    if (![node.role isEqualToString:@"AXTextField"] && ![node.role isEqualToString:@"AXComboBox"]) return NO;
    return ![node.subrole isEqualToString:@"AXSearchField"] && ![node.subrole isEqualToString:@"AXSecureTextField"];
}

static NSArray<id<SBAXNode>> *SBWebAreasInWindows(NSArray<id<SBAXNode>> *windows, SBAXWalkBudget *outer) {
    NSMutableArray<id<SBAXNode>> *pages = [NSMutableArray array];
    for (id<SBAXNode> window in windows) {
        SBAXWalkBudget budget = SBAXWalkBudgetNested(outer, kPanelSearchNodes);
        NSMutableArray<id<SBAXNode>> *queue = [NSMutableArray arrayWithObject:window];
        while (queue.count) {
            id<SBAXNode> node = queue.firstObject;
            [queue removeObjectAtIndex:0];
            if (!SBAXWalkBudgetSpend(&budget, node)) break;
            if ([node.role isEqualToString:kRoleWebArea]) { [pages addObject:node]; continue; }
            [queue addObjectsFromArray:node.children];
        }
        SBAXWalkBudgetAbsorb(outer, &budget);
        if (outer->hung || outer->exhausted) break;
    }
    return pages;
}

static BOOL SBNodesMentionFilename(NSArray<id<SBAXNode>> *roots, NSString *filename, SBAXWalkBudget *outer) {
    if (filename.length == 0) return NO;
    BOOL (^mentions)(NSString *) = ^BOOL(NSString *text) {
        return text.length >= filename.length && [text rangeOfString:filename options:NSCaseInsensitiveSearch].location != NSNotFound;
    };
    for (id<SBAXNode> root in roots) {
        id<SBAXNode> hit = SBFindNodeWithin(root, kPageSearchDepth, kPageSearchNodes, YES, outer, ^BOOL(id<SBAXNode> node) {
            // Page text and labels only: what the user typed into a field is never read here.
            if ([node.role isEqualToString:@"AXStaticText"] && mentions(node.value)) return YES;
            return mentions(node.title) || mentions(node.axDescription);
        });
        if (hit) return YES;
        if (outer->hung || outer->exhausted) break;
    }
    return NO;
}

+ (NSArray<id<SBAXNode>> *)webAreasInWindows:(NSArray<id<SBAXNode>> *)windows {
    SBAXWalkBudget budget = SBAXWalkBudgetMake(NSUIntegerMax, SBOpenPanelPageCheckSeconds);
    return SBWebAreasInWindows(windows, &budget);
}

+ (BOOL)nodes:(NSArray<id<SBAXNode>> *)roots mentionFilename:(NSString *)filename {
    SBAXWalkBudget budget = SBAXWalkBudgetMake(NSUIntegerMax, SBOpenPanelPageCheckSeconds);
    return SBNodesMentionFilename(roots, filename, &budget);
}

+ (BOOL)windows:(NSArray<id<SBAXNode>> *)windows showFilename:(NSString *)filename {
    // One budget for the whole check: finding the web areas and searching them share SBOpenPanelPageCheckSeconds.
    SBAXWalkBudget budget = SBAXWalkBudgetMake(NSUIntegerMax, SBOpenPanelPageCheckSeconds);
    NSArray<id<SBAXNode>> *pages = SBWebAreasInWindows(windows, &budget);
    if (budget.hung) return NO;
    return SBNodesMentionFilename(pages.count ? pages : windows, filename, &budget);
}

#pragma mark run

- (void)attachFileAtPath:(NSString *)path uploadButton:(id<SBAXNode>)uploadButton completion:(void (^)(SBOpenPanelResult *))completion {
    NSString *filename = path.lastPathComponent ?: @"";
    void (^refuse)(NSString *) = ^(NSString *reason) {
        SBLog(@"openpanel: refused (%@)", reason);
        SBOpenPanelResult *result = [[SBOpenPanelResult alloc] init];
        result.reason = reason;
        result.filename = filename;
        result.finalState = SBOpenPanelStateIdle;
        completion(result);
    };
    if (_running) { refuse(SBOpenPanelReasonBusy); return; }
    NSString *problem = [SBOpenPanelDriver problemWithUploadPath:path];
    if (problem) { refuse([NSString stringWithFormat:@"%@:%@", SBOpenPanelReasonInvalidPath, problem]); return; }
    id<SBAXNode> button = uploadButton ? [self.actuator refreshedNode:uploadButton] : nil;
    if (![SBOpenPanelDriver isUploadButton:button] || !button.enabled) { refuse(SBOpenPanelReasonNoUploadTarget); return; }
    pid_t pid = [self.state frontmostProcessIdentifier];
    if (pid <= 0) { refuse(SBOpenPanelReasonNoFrontmostApp); return; }
    // Only a panel THIS run opens is ever driven.
    if ([SBOpenPanelDriver openPanelInWindows:[self.state windowsOfProcess:pid]]) { refuse(SBOpenPanelReasonPanelAlreadyOpen); return; }
    // A page that already shows the name would make the final check meaningless.
    if (self.pageShowsFilename(filename, pid)) { refuse(SBOpenPanelReasonAlreadyShown); return; }

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
    SBLog(@"openpanel: start");

    [self enter:SBOpenPanelStatePressUpload message:@"Opening the file picker"];
    // The Attach control is almost always a web element, and in a Chromium-hosted window AXPress on one answers
    // success and opens nothing -- so the panel never appears and the whole upload times out waiting for it.
    // (It worked in Safari, where WebKit's AXPress is honest, which is why this looked app-specific.)
    BOOL opened = [self.actuator pressIsTrustworthyForNode:button] ? [self.actuator pressNode:button]
                                                                   : [self.actuator clickNode:button];
    if (!opened) { [self fail:SBOpenPanelReasonPressFailed escape:NO]; return; }
    [self enter:SBOpenPanelStateWaitForPanel message:nil];
    [self waitUntil:^BOOL {
        id<SBAXNode> panel = [SBOpenPanelDriver openPanelInWindows:[self.state windowsOfProcess:self->_pid]];
        if (!panel) return NO;
        self->_panel = panel;
        self->_openedByUs = YES;
        return YES;
    } timeout:self.panelTimeout then:^{ [self openGoTo]; } timeoutReason:SBOpenPanelReasonPanelTimeout escape:NO watchUser:YES];
}

- (void)openGoTo {
    [self enter:SBOpenPanelStateOpenGoTo message:[NSString stringWithFormat:@"Picking %@", _filename]];
    SBKeyBurstResult *burst = [self.poster postBurst:@[ [SBKeyStroke goToFolder] ] guard:^BOOL(SBKeyStroke *stroke, pid_t frontmost, id<SBAXNode> focused) {
        return [SBOpenPanelDriver node:focused isInside:self->_panel] && [self mayPostTo:frontmost];
    } lastCheck:[self mayStillPost]];
    if (!burst.ok) { [self fail:[self reasonForBurst:burst fallback:SBOpenPanelReasonFocusNotInPanel] escape:NO]; return; }
    [self enter:SBOpenPanelStateWaitForGoToField message:nil];
    [self waitUntil:^BOOL {
        id<SBAXNode> focused = [self.state focusedElement];
        if (![SBOpenPanelDriver isGoToFieldCandidate:focused] || ![SBOpenPanelDriver node:focused isInside:self->_panel]) return NO;
        self->_goToField = focused;
        return YES;
    } timeout:self.goToFieldTimeout then:^{ [self typePath]; } timeoutReason:SBOpenPanelReasonGoToTimeout escape:YES watchUser:YES];
}

- (void)typePath {
    [self enter:SBOpenPanelStateTypePath message:nil];
    id<SBAXNode> field = [self.actuator refreshedNode:_goToField];
    if (!field) { [self fail:SBOpenPanelReasonFocusChanged escape:NO]; return; }
    // The go-to field usually opens with the last folder selected; typing replaces a selection, never appends.
    if (field.value.length > 0 && ![self.actuator selectAllInNode:field]) { [self fail:SBOpenPanelReasonGoToFieldBusy escape:YES]; return; }
    SBKeyBurstResult *burst = [self.poster postBurst:@[ [SBKeyStroke text:_path] ] guard:^BOOL(SBKeyStroke *stroke, pid_t frontmost, id<SBAXNode> focused) {
        return [focused isSameNode:self->_goToField] && [self mayPostTo:frontmost];
    } lastCheck:[self mayStillPost]];
    if (!burst.ok) { [self fail:[self reasonForBurst:burst fallback:SBOpenPanelReasonFocusChanged] escape:NO]; return; }
    NSUInteger generation = _generation;
    self.after(self.typeSettleDelay, ^{
        if (generation != self->_generation || !self->_running || ![self stillSafe]) return;
        if (![self goToFieldHoldsPath]) { [self fail:SBOpenPanelReasonPathMismatch escape:YES]; return; }
        [self confirmGoTo];
    });
}

- (BOOL)goToFieldHoldsPath {
    id<SBAXNode> field = [self.actuator refreshedNode:_goToField];
    return field != nil && [field.value isEqualToString:_path];
}

- (void)confirmGoTo {
    [self enter:SBOpenPanelStateConfirmGoTo message:nil];
    SBKeyBurstResult *burst = [self.poster postBurst:@[ [SBKeyStroke returnKey] ] guard:^BOOL(SBKeyStroke *stroke, pid_t frontmost, id<SBAXNode> focused) {
        // The window walk and the field read first; focus, the app and the user's keys last (and again by the poster).
        return [self panelStillThere] && [self goToFieldHoldsPath] && [focused isSameNode:self->_goToField] && [self mayPostTo:frontmost];
    } lastCheck:[self mayStillPost]];
    if (!burst.ok) { [self fail:[self reasonForBurst:burst fallback:SBOpenPanelReasonFocusChanged] escape:NO]; return; }
    [self enter:SBOpenPanelStateWaitForGoToDismissed message:nil];
    [self waitUntil:^BOOL {
        if (![self panelStillThere]) { self->_panelClosedEarly = YES; return YES; }
        id<SBAXNode> focused = [self.state focusedElement];
        if (!focused || [focused isSameNode:self->_goToField]) return NO;
        if (![SBOpenPanelDriver node:focused isInside:self->_panel]) return NO;
        return [self openButtonEnabled];
    } timeout:self.goToDismissTimeout then:^{
        // Some panels choose the file on the first Return: the page gets it, and a second Return must never follow.
        if (self->_panelClosedEarly) [self verifyOnPage]; else [self confirmOpen];
    } timeoutReason:SBOpenPanelReasonGoToDismissTimeout escape:YES watchUser:YES];
}

/// Read from a panel found again in freshly read windows: live nodes are snapshots, and the one kept in _panel still
/// says whatever the Open button said when the panel appeared (usually "disabled").
- (BOOL)openButtonEnabled {
    id<SBAXNode> panel = [self freshPanel];
    id<SBAXNode> button = panel ? [SBOpenPanelDriver defaultButtonOfPanel:panel] : nil;
    return button != nil && button.enabled;
}

- (void)confirmOpen {
    [self enter:SBOpenPanelStateConfirmOpen message:nil];
    SBKeyBurstResult *burst = [self.poster postBurst:@[ [SBKeyStroke returnKey] ] guard:^BOOL(SBKeyStroke *stroke, pid_t frontmost, id<SBAXNode> focused) {
        return [self openButtonEnabled] && [SBOpenPanelDriver node:focused isInside:self->_panel] && ![focused isSameNode:self->_goToField]
            && [self mayPostTo:frontmost];
    } lastCheck:[self mayStillPost]];
    if (!burst.ok) { [self fail:[self reasonForBurst:burst fallback:SBOpenPanelReasonFocusNotInPanel] escape:NO]; return; }
    [self enter:SBOpenPanelStateWaitForPanelClosed message:nil];
    [self waitUntil:^BOOL { return ![self panelStillThere]; }
            timeout:self.panelCloseTimeout then:^{ [self verifyOnPage]; } timeoutReason:SBOpenPanelReasonPanelCloseTimeout escape:YES watchUser:YES];
}

- (void)verifyOnPage {
    [self enter:SBOpenPanelStateVerifyOnPage message:nil];
    // The panel is gone and nothing more is posted: a key or an app switch now cannot hurt, so they do not abort.
    [self waitUntil:^BOOL { return self.pageShowsFilename(self->_filename, self->_pid); }
            timeout:self.pageTimeout then:^{ [self succeed]; } timeoutReason:SBOpenPanelReasonFilenameNotShown escape:NO watchUser:NO];
}

#pragma mark plumbing

- (void)enter:(SBOpenPanelState)state message:(NSString *)message {
    // Every transition, because an upload is ten steps in another process and the only way to see which one
    // went wrong is to watch it walk. Names and milliseconds only -- never the path, never the file name.
    SBLog(@"openpanel: -> %@ (%.0f ms in)", SBOpenPanelStateName(state), (self.clock() - _started) * 1000.0);
    _currentState = state;
    if (message && self.progress) self.progress(state, message);
}

- (BOOL)mayPostTo:(pid_t)frontmost {
    return _running && !atomic_load(&_userKeySeen) && frontmost == _pid;
}

/// The panel this run drives, found again in freshly read windows (never the cached snapshot). nil once it is gone.
- (id<SBAXNode>)freshPanel {
    if (!_panel) return nil;
    id<SBAXNode> panel = [SBOpenPanelDriver openPanelInWindows:[self.state windowsOfProcess:_pid]];
    return (panel != nil && [panel isSameNode:_panel]) ? panel : nil;
}

- (BOOL)panelStillThere {
    return [self freshPanel] != nil;
}

/// The poster's very last question before each post: still running, no key of the user's, same app in front.
- (BOOL (^)(void))mayStillPost {
    __weak SBOpenPanelDriver *weakSelf = self;
    return ^BOOL {
        SBOpenPanelDriver *driver = weakSelf;
        return driver != nil && [driver mayPostTo:[driver.state frontmostProcessIdentifier]];
    };
}

/// YES while nothing forbids going on; otherwise fails the run and returns NO.
- (BOOL)stillSafe {
    if (atomic_load(&_userKeySeen)) { [self fail:SBOpenPanelReasonUserKey escape:NO]; return NO; }
    if ([self.state frontmostProcessIdentifier] != _pid) { [self fail:SBOpenPanelReasonAppChanged escape:NO]; return NO; }
    return YES;
}

- (NSString *)reasonForBurst:(SBKeyBurstResult *)burst fallback:(NSString *)fallback {
    if ([burst.reason isEqualToString:SBKeyBurstReasonPostFailed] || [burst.reason isEqualToString:SBKeyBurstReasonMalformed]) return SBOpenPanelReasonKeysRefused;
    if (atomic_load(&_userKeySeen)) return SBOpenPanelReasonUserKey;
    if ([self.state frontmostProcessIdentifier] != _pid) return SBOpenPanelReasonAppChanged;
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
        SBKeyBurstResult *burst = [self.poster postBurst:@[ [SBKeyStroke escape] ] guard:^BOOL(SBKeyStroke *stroke, pid_t frontmost, id<SBAXNode> focused) {
            return [SBOpenPanelDriver node:focused isInside:self->_panel] && [self mayPostTo:frontmost];
        } lastCheck:[self mayStillPost]];
        pressedEscape = burst.ok;
    }
    SBOpenPanelResult *result = [[SBOpenPanelResult alloc] init];
    result.reason = reason;
    result.finalState = _currentState;
    result.pressedEscape = pressedEscape;
    result.panelLeftOpen = [self panelStillThere];
    [self finish:result];
}

- (void)succeed {
    SBOpenPanelResult *result = [[SBOpenPanelResult alloc] init];
    result.ok = YES;
    result.verifiedOnPage = YES;
    result.finalState = SBOpenPanelStateDone;
    [self enter:SBOpenPanelStateDone message:[NSString stringWithFormat:@"Attached %@", _filename]];
    [self finish:result];
}

- (void)finish:(SBOpenPanelResult *)result {
    result.filename = _filename ?: @"";
    result.elapsed = self.clock() - _started;
    SBOpenPanelState stoppedIn = _currentState;
    _running = NO;
    atomic_store(&_active, false);
    _generation++;
    _currentState = result.ok ? SBOpenPanelStateDone : SBOpenPanelStateFailed;
    _panel = nil;
    _goToField = nil;
    void (^completion)(SBOpenPanelResult *) = _completion;
    _completion = nil;
    SBLog(@"openpanel: %@ in %@ (escape=%d leftOpen=%d) %.0f ms", result.ok ? @"attached" : result.reason, SBOpenPanelStateName(stoppedIn),
          result.pressedEscape, result.panelLeftOpen, result.elapsed * 1000.0);
    if (!result.ok && self.progress) self.progress(SBOpenPanelStateFailed, [NSString stringWithFormat:@"Could not attach %@ (%@)", result.filename, result.reason]);
    if (completion) completion(result);
}

- (void)noteUserKeyEvent {
    if (atomic_load(&_active)) atomic_store(&_userKeySeen, true);
}

- (void)cancel {
    [self fail:SBOpenPanelReasonCancelled escape:NO];
}

@end
