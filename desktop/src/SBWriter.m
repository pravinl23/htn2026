#import "SBWriter.h"
#import <AppKit/AppKit.h>
#import "SBAccessibility.h"
#import "SBComboBoxDriver.h"
#import "SBEventTap.h"
#import "SBKeyPoster.h"
#import "SBLog.h"
#import "SBGeometry.h"
#import "SBOpenPanelDriver.h"
#import <stdatomic.h>

NSString *const SBWriteMethodNone = @"none";
NSString *const SBWriteMethodValue = @"value";
NSString *const SBWriteMethodSelectedText = @"selected-text";
NSString *const SBWriteMethodTyping = @"typing";
NSString *const SBWriteMethodPress = @"press";
NSString *const SBWriteMethodClick = @"click";
NSString *const SBWriteMethodOpen = @"open";
NSString *const SBWriteMethodOpenPanel = @"open-panel";
NSString *const SBWriteMethodComboBox = @"combobox";
NSString *const SBWriteMethodFocus = @"focus";

NSString *const SBWriteReasonLocked = @"locked";
NSString *const SBWriteReasonSensitive = @"sensitive";
NSString *const SBWriteReasonHasValue = @"has-value";
NSString *const SBWriteReasonPending = @"pending";
NSString *const SBWriteReasonGone = @"gone";
NSString *const SBWriteReasonDisabled = @"disabled";
NSString *const SBWriteReasonBusy = @"busy";
NSString *const SBWriteReasonUnsupported = @"unsupported";
NSString *const SBWriteReasonDidNotHold = @"did-not-hold";
NSString *const SBWriteReasonNotFocused = @"not-focused";
NSString *const SBWriteReasonOptionNotFound = @"option-not-found";
NSString *const SBWriteReasonUploadPrefix = @"upload-";
NSString *const SBWriteReasonComboBoxPrefix = @"combobox-";

static NSString *const kRoleSecure = @"AXSecureTextField";
static NSString *const kRolePopUp = @"AXPopUpButton";
static NSString *const kRoleMenuItem = @"AXMenuItem";
static NSString *const kRoleCheckBox = @"AXCheckBox";
static NSString *const kRoleRadio = @"AXRadioButton";
static NSString *const kRoleTextField = @"AXTextField";
static NSString *const kRoleTextArea = @"AXTextArea";
static NSString *const kRoleSearchField = @"AXSearchField";
static const NSUInteger kMenuSearchDepth = 4;
static const NSUInteger kMenuSearchNodes = 600;
static const NSUInteger kWidgetLevelsUp = 3;
static const NSUInteger kWidgetSearchDepth = 5;
static const NSUInteger kWidgetSearchNodes = 300;

#pragma mark - result

@interface SBWriteResult ()
@property (nonatomic, readwrite) BOOL ok;
@property (nonatomic, readwrite, copy) NSString *method;
@property (nonatomic, readwrite, copy, nullable) NSString *reason;
@property (nonatomic, readwrite) BOOL refused;
@property (nonatomic, readwrite) BOOL sequence;
@end

@implementation SBWriteResult

+ (instancetype)okWithMethod:(NSString *)method {
    SBWriteResult *result = [[self alloc] init];
    result.ok = YES;
    result.method = method;
    return result;
}

+ (instancetype)refusal:(NSString *)reason {
    SBWriteResult *result = [[self alloc] init];
    result.method = SBWriteMethodNone;
    result.reason = reason;
    result.refused = YES;
    return result;
}

+ (instancetype)failure:(NSString *)reason method:(NSString *)method {
    SBWriteResult *result = [[self alloc] init];
    result.method = method;
    result.reason = reason;
    return result;
}

+ (instancetype)failureWithReason:(NSString *)reason method:(NSString *)method sequence:(BOOL)sequence {
    SBWriteResult *result = [self failure:reason method:method];
    result.sequence = sequence;
    return result;
}

- (instancetype)fromSequence {
    self.sequence = YES;
    return self;
}

- (NSString *)description {
    return [NSString stringWithFormat:@"<SBWriteResult ok=%d method=%@ reason=%@%@>", self.ok, self.method, self.reason ?: @"-", self.sequence ? @" sequence" : @""];
}

@end

#pragma mark - live actuator

static pid_t SBPidOfNode(id<SBAXNode> node) {
    pid_t pid = 0;
    AXUIElementRef element = node.axElement;
    if (element && AXUIElementGetPid(element, &pid) != kAXErrorSuccess) pid = 0;
    return pid;
}

/// Roles whose AXPress opens a menu and then blocks until it closes, so a timeout there means "it worked".
static BOOL SBRoleOpensAMenu(NSString *role) {
    return [role isEqualToString:kRolePopUp] || [role isEqualToString:@"AXMenuButton"] || [role isEqualToString:@"AXComboBox"];
}

@implementation SBAXLiveActuator {
    pid_t _menuPID;
    CGEventSourceRef _mouseSource;
}

- (void)dealloc {
    if (_mouseSource) CFRelease(_mouseSource);
}

- (instancetype)init {
    return [self initWithPoster:[SBKeyPoster livePoster]];
}

- (instancetype)initWithPoster:(id<SBKeyPosting>)poster {
    if ((self = [super init])) _poster = poster;
    return self;
}

- (id<SBAXNode>)refreshedNode:(id<SBAXNode>)node {
    AXUIElementRef element = node.axElement;
    if (!element) return nil;
    SBAXElementNode *fresh = [SBAXElementNode nodeWithElement:element];
    // A destroyed element answers the batch fetch with kAXErrorInvalidUIElement: no role.
    return fresh.role.length ? fresh : nil;
}

- (BOOL)focusNode:(id<SBAXNode>)node {
    AXUIElementRef element = node.axElement;
    if (!element) return NO;
    return AXUIElementSetAttributeValue(element, kAXFocusedAttribute, kCFBooleanTrue) == kAXErrorSuccess;
}

- (BOOL)setValue:(NSString *)value ofNode:(id<SBAXNode>)node {
    AXUIElementRef element = node.axElement;
    if (!element || !value) return NO;
    Boolean settable = false;
    if (AXUIElementIsAttributeSettable(element, kAXValueAttribute, &settable) != kAXErrorSuccess || !settable) return NO;
    return AXUIElementSetAttributeValue(element, kAXValueAttribute, (__bridge CFStringRef)value) == kAXErrorSuccess;
}

- (BOOL)selectAllInNode:(id<SBAXNode>)node {
    AXUIElementRef element = node.axElement;
    if (!element) return NO;
    CFTypeRef count = NULL;
    CFIndex length = 0;
    if (AXUIElementCopyAttributeValue(element, kAXNumberOfCharactersAttribute, &count) == kAXErrorSuccess && count) {
        if (CFGetTypeID(count) == CFNumberGetTypeID()) CFNumberGetValue((CFNumberRef)count, kCFNumberCFIndexType, &length);
    }
    if (count) CFRelease(count);
    CFRange range = CFRangeMake(0, MAX(length, 0));
    AXValueRef value = AXValueCreate(kAXValueTypeCFRange, &range);
    if (!value) return NO;
    AXError error = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute, value);
    CFRelease(value);
    return error == kAXErrorSuccess;
}

- (BOOL)replaceSelectionWithText:(NSString *)text inNode:(id<SBAXNode>)node {
    AXUIElementRef element = node.axElement;
    if (!element || !text) return NO;
    Boolean settable = false;
    if (AXUIElementIsAttributeSettable(element, kAXSelectedTextAttribute, &settable) != kAXErrorSuccess || !settable) return NO;
    return AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute, (__bridge CFStringRef)text) == kAXErrorSuccess;
}

- (BOOL)typeText:(NSString *)text intoNode:(id<SBAXNode>)node {
    // What reaches the keyboard is what SBEventTap would have typed: control characters are spaces, never an Enter.
    NSString *typed = [[SBEventTap chunksForText:text ?: @""] componentsJoinedByString:@""];
    if (typed.length == 0 || !node) return NO;
    __block pid_t app = SBPidOfNode(node);
    SBKeyBurstResult *burst = [self.poster postBurst:@[ [SBKeyStroke text:typed] ] guard:^BOOL(SBKeyStroke *stroke, pid_t frontmost, id<SBAXNode> focused) {
        if (app <= 0) app = frontmost;   // fakes carry no element: the app in front at the first chunk is the one
        return frontmost > 0 && frontmost == app && [SBOpenPanelDriver node:focused isInside:node];
    }];
    return burst.ok;
}

- (BOOL)pressNode:(id<SBAXNode>)node {
    AXUIElementRef element = node.axElement;
    if (!element) return NO;
    _menuPID = SBPidOfNode(node);
    AXError error = AXUIElementPerformAction(element, kAXPressAction);
    if (error == kAXErrorSuccess) return YES;
    // A popup runs its menu inside the press: the call times out while the menu is open, and that is a success.
    // Nothing ELSE gets that benefit of the doubt -- kAXErrorCannotComplete is also what an app that never
    // answered returns, and counting it as a success is how a press that did nothing was logged ok=1.
    return error == kAXErrorCannotComplete && SBRoleOpensAMenu(node.role);
}

- (BOOL)openNode:(id<SBAXNode>)node {
    AXUIElementRef element = node.axElement;
    // AXOpen is the app saying what "activate this row" means, and it beats guessing with the mouse -- but it
    // is an ACTION, so it lies everywhere AXPress does. In a Chromium window it answers success and opens
    // nothing, so asking first only throws away the double click that would have worked.
    if (element && [self pressIsTrustworthyForNode:node] && AXUIElementPerformAction(element, CFSTR("AXOpen")) == kAXErrorSuccess) return YES;
    return [self clickNode:node clicks:2];
}

- (BOOL)nodeAcceptsPress:(id<SBAXNode>)node {
    AXUIElementRef element = node.axElement;
    if (!element) return NO;
    CFArrayRef names = NULL;
    if (AXUIElementCopyActionNames(element, &names) != kAXErrorSuccess || !names) return NO;
    BOOL found = [(__bridge NSArray *)names containsObject:(__bridge NSString *)kAXPressAction];
    CFRelease(names);
    return found;
}

- (BOOL)pressIsTrustworthyForNode:(id<SBAXNode>)node {
    pid_t pid = SBPidOfNode(node);
    if (pid <= 0) return YES;
    // Per pid, because the answer is a property of the app and a pid does not change apps under us.
    static NSMutableDictionary<NSNumber *, NSNumber *> *cache;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ cache = [NSMutableDictionary dictionary]; });
    @synchronized (cache) {
        NSNumber *known = cache[@(pid)];
        if (known) return known.boolValue;
    }
    NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    BOOL chromium = app && [SBAccessibility appNeedsEnhancedUserInterface:app.bundleIdentifier bundleURL:app.bundleURL];
    @synchronized (cache) { cache[@(pid)] = @(!chromium); }
    return !chromium;
}

- (BOOL)clickNode:(id<SBAXNode>)node {
    return [self clickNode:node clicks:1];
}

- (BOOL)clickNode:(id<SBAXNode>)node clicks:(int64_t)clicks {
    if (SBRealKeyEventsForbidden()) return NO;   // the test runner never moves the real pointer
    CGRect frame = node.frame;
    if (!SBRectIsUsable(frame)) return NO;
    if (!_mouseSource) {
        _mouseSource = CGEventSourceCreate(kCGEventSourceStatePrivate);
        if (!_mouseSource) return NO;
        CGEventSourceSetUserData(_mouseSource, SBSyntheticEventUserData);
    }
    CGPoint target = CGPointMake(CGRectGetMidX(frame), CGRectGetMidY(frame));
    // Where the user left the pointer, so it can be put back: a ghost must not steal the mouse.
    CGEventRef probe = CGEventCreate(NULL);
    CGPoint origin = probe ? CGEventGetLocation(probe) : target;
    if (probe) CFRelease(probe);

    // A move first: many controls only arm themselves once the pointer is over them (hover state, tracking area).
    BOOL ok = YES;
    // A double click is the same down/up pair twice, with clickState counting up: that second value is what
    // makes the system read it as a double click rather than two separate ones.
    const CGEventType steps[] = { kCGEventMouseMoved, kCGEventLeftMouseDown, kCGEventLeftMouseUp,
                                  kCGEventLeftMouseDown, kCGEventLeftMouseUp };
    NSUInteger stepCount = clicks >= 2 ? 5 : 3;
    for (NSUInteger i = 0; i < stepCount && ok; i++) {
        CGEventRef event = CGEventCreateMouseEvent(_mouseSource, steps[i], target, kCGMouseButtonLeft);
        if (!event) { ok = NO; break; }
        if (steps[i] != kCGEventMouseMoved) CGEventSetIntegerValueField(event, kCGMouseEventClickState, i >= 3 ? 2 : 1);
        CGEventSetIntegerValueField(event, kCGEventSourceUserData, SBSyntheticEventUserData);
        CGEventPost(kCGHIDEventTap, event);
        CFRelease(event);
    }
    if (!CGPointEqualToPoint(origin, target)) {
        CGEventRef back = CGEventCreateMouseEvent(_mouseSource, kCGEventMouseMoved, origin, kCGMouseButtonLeft);
        if (back) {
            CGEventSetIntegerValueField(back, kCGEventSourceUserData, SBSyntheticEventUserData);
            CGEventPost(kCGHIDEventTap, back);
            CFRelease(back);
        }
    }
    return ok;
}

- (BOOL)dismissMenuOfPopup:(id<SBAXNode>)popup stillWanted:(BOOL (^)(void))stillWanted {
    pid_t app = _menuPID;
    _menuPID = 0;
    if (app <= 0 || !popup) return NO;   // no menu of ours to close
    if (stillWanted && !stillWanted()) return NO;
    SBKeyBurstResult *burst = [self.poster postBurst:@[ [SBKeyStroke escape] ] guard:^BOOL(SBKeyStroke *stroke, pid_t frontmost, id<SBAXNode> focused) {
        return [SBWriter menuIsOpenForPopup:[self refreshedNode:popup] focused:focused] && frontmost == app;
    } lastCheck:stillWanted];
    return burst.ok;
}

- (BOOL)scrollToVisible:(id<SBAXNode>)node {
    AXUIElementRef element = node.axElement;
    if (!element) return NO;
    return AXUIElementPerformAction(element, CFSTR("AXScrollToVisible")) == kAXErrorSuccess;
}

@end

#pragma mark - fake actuator

@implementation SBFakeAXActuator {
    NSMutableArray<id<SBAXNode>> *_pressed;
    NSMutableArray<id<SBAXNode>> *_clicked;
    NSMutableArray<id<SBAXNode>> *_opened;
    NSMutableArray<id<SBAXNode>> *_focusRequests;
    __weak SBFakeAXNode *_selectedAll;
}

- (instancetype)init {
    if ((self = [super init])) {
        _valueSticks = YES;
        _typingSticks = YES;
        _pressWorks = YES;
        _publishesPress = YES;
        _pressIsTrustworthy = YES;
        _clickWorks = YES;
        _openWorks = YES;
        _focusWorks = YES;
        _scrollWorks = YES;
        _pressed = [NSMutableArray array];
        _clicked = [NSMutableArray array];
        _opened = [NSMutableArray array];
        _focusRequests = [NSMutableArray array];
        _goneNodes = [NSMutableSet set];
    }
    return self;
}

- (NSArray<id<SBAXNode>> *)pressedNodes { return [_pressed copy]; }
- (NSArray<id<SBAXNode>> *)focusRequests { return [_focusRequests copy]; }

- (SBFakeAXNode *)fake:(id<SBAXNode>)node {
    return [(id)node isKindOfClass:[SBFakeAXNode class]] ? (SBFakeAXNode *)node : nil;
}

- (NSString *)shaped:(NSString *)value {
    return self.reformat ? self.reformat(value) : value;
}

- (id<SBAXNode>)refreshedNode:(id<SBAXNode>)node {
    SBFakeAXNode *fake = [self fake:node];
    return (fake && ![_goneNodes containsObject:fake]) ? fake : nil;
}

- (BOOL)focusNode:(id<SBAXNode>)node {
    _focusCount++;
    if (node) [_focusRequests addObject:node];
    SBFakeAXNode *fake = [self fake:node];
    if (!fake || !self.focusWorks) return NO;
    self.focusedNode.isFocused = NO;
    fake.isFocused = YES;
    self.focusedNode = fake;
    return YES;
}

- (BOOL)setValue:(NSString *)value ofNode:(id<SBAXNode>)node {
    _setValueCount++;
    SBFakeAXNode *fake = [self fake:node];
    if (!fake) return NO;
    if ([fake.role isEqualToString:kRolePopUp]) {
        if (!self.popupValueSettable) return NO;
        fake.value = value;
        return YES;
    }
    // A page that reverts the write still reports success: only the read-back tells.
    if (self.valueSticks) fake.value = [self shaped:value];
    return YES;
}

- (BOOL)selectAllInNode:(id<SBAXNode>)node {
    _selectedAll = [self fake:node];
    return YES;
}

- (BOOL)replaceSelectionWithText:(NSString *)text inNode:(id<SBAXNode>)node {
    _replaceSelectionCount++;
    SBFakeAXNode *fake = [self fake:node];
    if (!fake || !self.selectedTextSticks) return NO;
    fake.value = [self shaped:text];
    return YES;
}

- (BOOL)typeText:(NSString *)text intoNode:(id<SBAXNode>)node {
    _typeCount++;
    SBFakeAXNode *target = self.focusedNode;
    // The live actuator's guard: nothing is typed unless the node (or something inside it) has focus.
    if (!target || ![SBOpenPanelDriver node:target isInside:node]) return NO;
    if (!self.typingSticks) return YES;   // the events were posted; nobody kept them
    NSString *before = (_selectedAll == target) ? @"" : (target.value ?: @"");
    target.value = [self shaped:[before stringByAppendingString:[[SBEventTap chunksForText:text] componentsJoinedByString:@""]]];
    _selectedAll = nil;
    return YES;
}

- (BOOL)pressNode:(id<SBAXNode>)node {
    [_pressed addObject:node];
    SBFakeAXNode *fake = [self fake:node];
    if (!fake) return NO;
    if (!self.pressWorks) return YES;
    if ([fake.role isEqualToString:kRoleCheckBox]) {
        fake.value = [fake.value isEqualToString:@"1"] ? @"0" : @"1";
    } else if ([fake.role isEqualToString:kRoleRadio]) {
        for (id<SBAXNode> sibling in fake.parent.children) {
            SBFakeAXNode *other = [self fake:sibling];
            if ([other.role isEqualToString:kRoleRadio]) other.value = @"0";
        }
        fake.value = @"1";
    } else if ([fake.role isEqualToString:kRoleMenuItem]) {
        id<SBAXNode> up = fake.parent;
        while (up && ![up.role isEqualToString:kRolePopUp]) up = up.parent;
        [self fake:up].value = fake.title;
    }
    return YES;
}

- (BOOL)nodeAcceptsPress:(id<SBAXNode>)node {
    return [self fake:node] != nil && self.publishesPress;
}

- (BOOL)pressIsTrustworthyForNode:(id<SBAXNode>)node {
    return self.pressIsTrustworthy;
}

- (BOOL)clickNode:(id<SBAXNode>)node {
    SBFakeAXNode *fake = [self fake:node];
    if (!fake) return NO;
    [_clicked addObject:node];
    if (!self.clickWorks) return NO;
    // A real click reaches the app the same way a press would have, so the visible effect is the same.
    return [self pressNode:node];
}

- (BOOL)openNode:(id<SBAXNode>)node {
    SBFakeAXNode *fake = [self fake:node];
    if (!fake) return NO;
    [_opened addObject:node];
    return self.openWorks;
}

- (NSArray<id<SBAXNode>> *)openedNodes { return [_opened copy]; }

- (NSArray<id<SBAXNode>> *)clickedNodes { return [_clicked copy]; }

- (BOOL)dismissMenuOfPopup:(id<SBAXNode>)popup stillWanted:(BOOL (^)(void))stillWanted {
    if (stillWanted && !stillWanted()) return NO;
    if (![SBWriter menuIsOpenForPopup:[self refreshedNode:popup] focused:self.focusedNode]) return NO;
    _dismissMenuCount++;
    return YES;
}

- (BOOL)scrollToVisible:(id<SBAXNode>)node {
    _scrollCount++;
    SBFakeAXNode *fake = [self fake:node];
    if (!fake || !self.scrollWorks || [_goneNodes containsObject:fake]) return NO;
    if (self.onScroll) self.onScroll(fake);
    return YES;
}

@end

#pragma mark - writer

@implementation SBWriter {
    _Atomic(bool) _pickActive;    // a popup menu Shabang opened may be showing
    _Atomic(bool) _pickUserKey;   // the user pressed a key since: no Escape of ours follows it
}

- (instancetype)initWithActuator:(id<SBAXActuating>)actuator {
    if ((self = [super init])) {
        _actuator = actuator;
        _verifyDelay = 0.06;
        _menuDelay = 0.18;
        _after = ^(NSTimeInterval delay, dispatch_block_t block) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)), dispatch_get_main_queue(), block);
        };
    }
    return self;
}

#pragma mark pure helpers

+ (NSString *)comparable:(NSString *)text {
    if (text.length == 0) return @"";
    NSString *folded = text.precomposedStringWithCompatibilityMapping.lowercaseString;
    NSMutableString *out = [NSMutableString stringWithCapacity:folded.length];
    NSCharacterSet *keep = [NSCharacterSet alphanumericCharacterSet];
    [folded enumerateSubstringsInRange:NSMakeRange(0, folded.length) options:NSStringEnumerationByComposedCharacterSequences
                            usingBlock:^(NSString *substring, NSRange range, NSRange enclosing, BOOL *stop) {
        if (substring.length && [keep longCharacterIsMember:[substring characterAtIndex:0]]) [out appendString:substring];
    }];
    return out;
}

+ (BOOL)value:(NSString *)actual holds:(NSString *)expected {
    NSString *have = [self comparable:actual], *wanted = [self comparable:expected];
    if (wanted.length == 0) return [actual ?: @"" isEqualToString:expected ?: @""];   // nothing but punctuation: exact only
    if ([have isEqualToString:wanted]) return YES;
    if (have.length == 0 || have.length * 2 < wanted.length) return NO;
    return [have containsString:wanted] || [wanted containsString:have];
}

+ (BOOL)isPlaceholderChoice:(NSString *)shown {
    NSString *text = [shown stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].lowercaseString ?: @"";
    if (text.length == 0) return YES;
    for (NSString *prefix in @[ @"select", @"choose", @"please", @"--" ]) if ([text hasPrefix:prefix]) return YES;
    return NO;
}

static NSString *SBNormal(NSString *text) {
    NSArray<NSString *> *parts = [text.lowercaseString componentsSeparatedByCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    return [[parts filteredArrayUsingPredicate:[NSPredicate predicateWithFormat:@"length > 0"]] componentsJoinedByString:@" "];
}

#pragma mark sequences and upload widgets

+ (BOOL)ghostRunsSequence:(SBGhost *)ghost field:(SBField *)field {
    if ([ghost.action isEqualToString:SBGhostActionUpload]) return YES;
    return [ghost.action isEqualToString:SBGhostActionSelect] && ghost.lazy && (!field || field.lazyOptions);
}

static BOOL SBNodeIsNamed(id<SBAXNode> node) {
    NSCharacterSet *space = NSCharacterSet.whitespaceAndNewlineCharacterSet;
    return [node.title stringByTrimmingCharactersInSet:space].length > 0 || [node.axDescription stringByTrimmingCharactersInSet:space].length > 0;
}

+ (id<SBAXNode>)uploadWidgetOfInput:(id<SBAXNode>)input {
    id<SBAXNode> widget = nil;
    id<SBAXNode> cursor = input.parent;
    for (NSUInteger level = 0; cursor && level < kWidgetLevelsUp; level++, cursor = cursor.parent) {
        if (![cursor.role isEqualToString:@"AXGroup"]) break;
        widget = cursor;
        if (SBNodeIsNamed(cursor)) break;
    }
    return widget ?: input.parent;
}

/// Breadth-first over `root`, bounded; YES as soon as `match` says so. Never looks into the widget's text fields.
static BOOL SBWidgetHas(id<SBAXNode> root, BOOL (^match)(id<SBAXNode> node)) {
    if (!root) return NO;
    NSMutableArray<id<SBAXNode>> *queue = [NSMutableArray arrayWithObject:root];
    NSMutableArray<NSNumber *> *depths = [NSMutableArray arrayWithObject:@0];
    NSUInteger visited = 0;
    while (queue.count && visited < kWidgetSearchNodes) {
        id<SBAXNode> node = queue.firstObject;
        NSUInteger depth = depths.firstObject.unsignedIntegerValue;
        [queue removeObjectAtIndex:0];
        [depths removeObjectAtIndex:0];
        visited++;
        if (match(node)) return YES;
        if (depth >= kWidgetSearchDepth) continue;
        for (id<SBAXNode> child in node.children) {
            [queue addObject:child];
            [depths addObject:@(depth + 1)];
        }
    }
    return NO;
}

+ (BOOL)widget:(id<SBAXNode>)widget mentionsFile:(NSString *)filename {
    if (!widget || filename.length == 0) return NO;
    return SBWidgetHas(widget, ^BOOL(id<SBAXNode> node) {
        NSString *role = node.role ?: @"";
        // Page text and control names only: what somebody typed into a field is never read here.
        NSArray<NSString *> *texts = [role isEqualToString:@"AXStaticText"] ? @[ node.value ?: @"", node.title ?: @"" ] : @[ node.title ?: @"", node.axDescription ?: @"" ];
        for (NSString *text in texts) {
            if (text.length >= filename.length && [text rangeOfString:filename options:NSCaseInsensitiveSearch].location != NSNotFound) return YES;
        }
        return NO;
    });
}

+ (BOOL)labelIsRemoveControl:(NSString *)label {
    static NSRegularExpression *removal;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ removal = [NSRegularExpression regularExpressionWithPattern:@"\\b(remove|delete|clear)\\b" options:NSRegularExpressionCaseInsensitive error:NULL]; });
    NSString *name = label ?: @"";
    return [removal firstMatchInString:name options:0 range:NSMakeRange(0, name.length)] != nil;
}

+ (BOOL)widgetHasRemoveControl:(id<SBAXNode>)widget {
    return SBWidgetHas(widget, ^BOOL(id<SBAXNode> node) {
        if (![node.role isEqualToString:@"AXButton"] && ![node.role isEqualToString:@"AXLink"]) return NO;
        return [self labelIsRemoveControl:[NSString stringWithFormat:@"%@ %@", node.title ?: @"", node.axDescription ?: @""]];
    });
}

static BOOL SBSameChoice(NSString *shown, SBGhost *ghost) {
    NSString *text = SBNormal(shown ?: @"");
    if (text.length == 0) return NO;
    return [text isEqualToString:SBNormal(ghost.displayText ?: @"")] || [text isEqualToString:SBNormal(ghost.value ?: @"")];
}

#pragma mark safety

- (BOOL)looksSensitive:(id<SBAXNode>)node {
    if ([node.role isEqualToString:kRoleSecure] || [node.subrole isEqualToString:kRoleSecure]) return YES;
    // Fail closed: a writer nobody gave a safety check to writes nowhere.
    if (!self.isNodeSensitive) return YES;
    return self.isNodeSensitive(node);
}

- (BOOL)focusLockedNode:(id<SBAXNode>)node {
    // Moving keyboard focus is not activating. There is no code path in this class that presses a button.
    return [self focusNode:node];
}

- (BOOL)focusNode:(id<SBAXNode>)node {
    id<SBAXNode> fresh = node ? [self.actuator refreshedNode:node] : nil;
    if (!fresh || [self looksSensitive:fresh]) return NO;
    return [self.actuator focusNode:fresh];
}

- (void)noteUserKeyEvent {
    [self.openPanelDriver noteUserKeyEvent];
    [self.comboBoxDriver noteUserKeyEvent];
    if (atomic_load(&_pickActive)) atomic_store(&_pickUserKey, true);
}

+ (BOOL)menuIsOpenForPopup:(id<SBAXNode>)popup focused:(id<SBAXNode>)focused {
    if (!popup) return NO;
    for (id<SBAXNode> child in popup.children) if ([child.role isEqualToString:@"AXMenu"]) return YES;
    NSString *role = focused.role;
    BOOL inMenu = [role isEqualToString:@"AXMenu"] || [role isEqualToString:kRoleMenuItem];
    return inMenu && [SBOpenPanelDriver node:focused isInside:popup];
}

#pragma mark execute

- (void)executeGhost:(SBGhost *)ghost field:(SBField *)field node:(id<SBAXNode>)node optionNode:(id<SBAXNode>)optionNode
          completion:(void (^)(SBWriteResult *))completion {
    if (_busy) { completion([SBWriteResult refusal:SBWriteReasonBusy]); return; }
    _busy = YES;
    NSString *label = SBLogLabel(field.label);
    NSString *kind = field.kind ?: @"?";
    NSString *action = ghost.action ?: @"?";
    CFAbsoluteTime started = CFAbsoluteTimeGetCurrent();
    __weak SBWriter *weakSelf = self;
    void (^finish)(SBWriteResult *) = ^(SBWriteResult *result) {
        SBWriter *writer = weakSelf;
        if (writer) writer->_busy = NO;
        SBLog(@"writer: %@ kind=%@ label=%@ ok=%d method=%@ reason=%@ %.0f ms", action, kind, label, result.ok, result.method,
              result.reason ?: @"-", (CFAbsoluteTimeGetCurrent() - started) * 1000.0);
        completion(result);
    };

    // Rule 2 of the safety list: locked targets are never pressed, whatever the ghost claims to be.
    BOOL isClick = [ghost.action isEqualToString:SBGhostActionClick];
    if (!ghost || ghost.locked || field.locked) { finish([SBWriteResult refusal:SBWriteReasonLocked]); return; }
    // An UNLOCKED click ghost is a next-action proposal (docs/anywhere.md): a plainly reversible control the
    // user asked for with Tab. It is pressed only when a caller gave this writer a live lock check, and only
    // after that check has looked at the element again -- with no check, nothing is ever pressed.
    if (isClick && !self.isNodeLocked) { finish([SBWriteResult refusal:SBWriteReasonLocked]); return; }
    if (!isClick && ([field.kind isEqualToString:SBKindButton] || [field.kind isEqualToString:SBKindLink] ||
                     [field.kind isEqualToString:SBKindItem])) { finish([SBWriteResult refusal:SBWriteReasonLocked]); return; }
    if (ghost.pending) { finish([SBWriteResult refusal:SBWriteReasonPending]); return; }

    BOOL isRadio = [field.kind isEqualToString:SBKindRadio];
    id<SBAXNode> target = isRadio ? optionNode : node;
    if (!target) { finish([SBWriteResult refusal:isRadio ? SBWriteReasonOptionNotFound : SBWriteReasonGone]); return; }
    id<SBAXNode> fresh = [self.actuator refreshedNode:target];
    if (!fresh) { finish([SBWriteResult refusal:SBWriteReasonGone]); return; }
    if ([self looksSensitive:fresh]) { finish([SBWriteResult refusal:SBWriteReasonSensitive]); return; }
    if (isRadio && node) {
        id<SBAXNode> group = [self.actuator refreshedNode:node];
        if (group && [self looksSensitive:group]) { finish([SBWriteResult refusal:SBWriteReasonSensitive]); return; }
    }
    if (!fresh.enabled) { finish([SBWriteResult refusal:SBWriteReasonDisabled]); return; }

    if (isClick) { [self press:fresh item:[field.kind isEqualToString:SBKindItem] finish:finish]; return; }
    if ([ghost.action isEqualToString:SBGhostActionUpload]) { [self upload:ghost field:field button:fresh fileInput:optionNode finish:finish]; return; }
    if ([field.kind isEqualToString:SBKindFile]) { finish([SBWriteResult refusal:SBWriteReasonUnsupported]); return; }   // a path only goes through the panel
    if ([ghost.action isEqualToString:SBGhostActionCheck]) { [self tick:fresh ghost:ghost finish:finish]; return; }
    if (isRadio) { [self choose:fresh finish:finish]; return; }
    if ([ghost.action isEqualToString:SBGhostActionSelect]) {
        if ([fresh.role isEqualToString:kRolePopUp]) { [self pick:fresh ghost:ghost finish:finish]; return; }
        if (ghost.lazy) { [self chooseLazy:ghost comboBox:fresh finish:finish]; return; }
        // A combo box is a text field with suggestions: it takes the option's label.
        [self fill:fresh text:ghost.displayText.length ? ghost.displayText : ghost.value finish:finish];
        return;
    }
    if ([ghost.action isEqualToString:SBGhostActionFill]) { [self fill:fresh text:ghost.value finish:finish]; return; }
    finish([SBWriteResult refusal:SBWriteReasonUnsupported]);
}

#pragma mark press (docs/anywhere.md: the next-action proposal)

/// The ONE press in this class. The element is read again by the caller before we get here; this asks the lock
/// check one last time (a control whose name changed under us, a menu that turned into a confirmation) and then
/// performs the app's own default action. Nothing is typed, nothing is filled, no key is posted.
- (void)press:(id<SBAXNode>)node item:(BOOL)item finish:(void (^)(SBWriteResult *))finish {
    if (!self.isNodeLocked || self.isNodeLocked(node)) { finish([SBWriteResult refusal:SBWriteReasonLocked]); return; }
    // A row is not a button: activating one is an OPEN, and AXPress on it only selects (measured on Spotify,
    // where pressing a playlist highlighted it and opened nothing).
    if (item) {
        // Whether the app's actions can be BELIEVED and whether a row takes one click or two are two different
        // questions, and conflating them is how this briefly did a half press: one real click on a track row,
        // which selected it and played nothing. A row selects on one and opens on two in a web list exactly as
        // in a native one. -openNode: answers both.
        if ([self.actuator openNode:node]) { finish([SBWriteResult okWithMethod:SBWriteMethodOpen]); return; }
        finish([SBWriteResult failure:SBWriteReasonDidNotHold method:SBWriteMethodOpen]);
        return;
    }
    // A text box is never pressed: putting the cursor in it IS the action (a search box the user is about to
    // type in). Nothing is typed and nothing is filled either way -- the click ghost carries no value.
    BOOL typeable = [node.role isEqualToString:kRoleTextField] || [node.role isEqualToString:kRoleTextArea] ||
                    [node.subrole isEqualToString:kRoleSearchField];
    if (typeable) {
        if (![self.actuator focusNode:node]) { finish([SBWriteResult failure:SBWriteReasonDidNotHold method:SBWriteMethodFocus]); return; }
        finish([SBWriteResult okWithMethod:SBWriteMethodFocus]);
        return;
    }
    // AXPress is the app's own default action and the polite way in, but most of the desktop does not implement
    // it: a Finder row, a Spotify tile, a Discord channel, anything custom-drawn. Ask whether the element
    // publishes the action at all, and click it for real when it does not, or when the press was refused.
    //
    // And in a Chromium-hosted window, do not ask at all. There the element publishes AXPress, answers SUCCESS,
    // and nothing happens -- so a press is not a cheaper click, it is a silent no-op that also stops the real
    // click from being tried. Clicking is the only thing that works, so it is the only thing worth doing.
    if ([self.actuator pressIsTrustworthyForNode:node] && [self.actuator nodeAcceptsPress:node] && [self.actuator pressNode:node]) {
        finish([SBWriteResult okWithMethod:SBWriteMethodPress]);
        return;
    }
    if ([self.actuator clickNode:node]) { finish([SBWriteResult okWithMethod:SBWriteMethodClick]); return; }
    finish([SBWriteResult failure:SBWriteReasonDidNotHold method:SBWriteMethodPress]);
}

#pragma mark upload, lazy select

/// One Tab: press the widget's Attach control (else the file input itself) and drive the open panel. The driver
/// refuses before touching anything when the path, the button, an already open panel or the page say no.
- (void)upload:(SBGhost *)ghost field:(SBField *)field button:(id<SBAXNode>)button fileInput:(id<SBAXNode>)fileInput finish:(void (^)(SBWriteResult *))finish {
    SBOpenPanelDriver *driver = self.openPanelDriver;
    if (!driver || ![field.kind isEqualToString:SBKindFile]) { finish([SBWriteResult refusal:SBWriteReasonUnsupported]); return; }
    if (field.value.length > 0) { finish([SBWriteResult refusal:SBWriteReasonHasValue]); return; }   // a file is attached already
    NSString *path = ghost.value ?: @"";
    NSString *problem = [SBOpenPanelDriver problemWithUploadPath:path];
    if (problem) { finish([SBWriteResult refusal:[SBWriteReasonUploadPrefix stringByAppendingString:SBOpenPanelReasonInvalidPath]]); return; }
    id<SBAXNode> target = [SBOpenPanelDriver isUploadButton:button] ? button : nil;
    if (!target && fileInput) {
        id<SBAXNode> input = [self.actuator refreshedNode:fileInput];
        if (input && [SBOpenPanelDriver isUploadButton:input] && ![self looksSensitive:input]) target = input;
    }
    if (!target) { finish([SBWriteResult refusal:[SBWriteReasonUploadPrefix stringByAppendingString:SBOpenPanelReasonNoUploadTarget]]); return; }
    [driver attachFileAtPath:path uploadButton:target completion:^(SBOpenPanelResult *result) {
        NSString *reason = [SBWriteReasonUploadPrefix stringByAppendingString:result.reason ?: @"failed"];
        if (result.ok) finish([[SBWriteResult okWithMethod:SBWriteMethodOpenPanel] fromSequence]);
        else if (result.finalState == SBOpenPanelStateIdle) finish([[SBWriteResult refusal:reason] fromSequence]);   // nothing was touched
        else finish([[SBWriteResult failure:reason method:SBWriteMethodOpenPanel] fromSequence]);
    }];
}

/// react-select and friends: the driver types the intended answer, chooses a real option and verifies it. Skipped
/// (nothing left behind) is a refusal, so the walk goes on; Failed stops the walk.
- (void)chooseLazy:(SBGhost *)ghost comboBox:(id<SBAXNode>)comboBox finish:(void (^)(SBWriteResult *))finish {
    SBComboBoxDriver *driver = self.comboBoxDriver;
    NSString *answer = ghost.value.length ? ghost.value : ghost.displayText;
    if (!driver || ![SBComboBoxDriver isComboBox:comboBox] || answer.length == 0) { finish([SBWriteResult refusal:SBWriteReasonUnsupported]); return; }
    // A protected question is answered with whichever option MEANS "prefer not to answer", in the form's own
    // words: `answer` is only the wording the core proposed (docs/answers.md section 1).
    [driver chooseAnswer:answer
              inComboBox:comboBox
                 decline:ghost.declineAnswer
         neutralFallback:ghost.neutralFallback
              completion:^(SBComboBoxResult *result) {
        NSString *reason = [SBWriteReasonComboBoxPrefix stringByAppendingString:result.reason ?: @"failed"];
        if (result.chosen) finish([[SBWriteResult okWithMethod:SBWriteMethodComboBox] fromSequence]);
        else if (result.skipsField) finish([[SBWriteResult refusal:reason] fromSequence]);
        else finish([[SBWriteResult failure:reason method:SBWriteMethodComboBox] fromSequence]);
    }];
}

#pragma mark fill

- (void)fill:(id<SBAXNode>)node text:(NSString *)text finish:(void (^)(SBWriteResult *))finish {
    if (text.length == 0) { finish([SBWriteResult refusal:SBWriteReasonUnsupported]); return; }
    // Rule 9: whitespace counts as a value, so nothing the user typed is ever overwritten.
    if (node.value.length > 0) { finish([SBWriteResult refusal:SBWriteReasonHasValue]); return; }
    [self.actuator focusNode:node];   // cosmetic for AXValue, required for typing (checked there)

    __weak SBWriter *weakSelf = self;
    BOOL (^held)(void) = ^BOOL {
        SBWriter *writer = weakSelf;
        id<SBAXNode> now = writer ? [writer.actuator refreshedNode:node] : nil;
        return now != nil && [SBWriter value:now.value holds:text];
    };
    void (^typing)(void) = ^{
        SBWriter *writer = weakSelf;
        if (!writer) return;
        // Key events land on whatever has keyboard focus: it has to be this very element.
        id<SBAXNode> now = [writer.actuator refreshedNode:node];
        if (now && !now.isFocused) {
            [writer.actuator focusNode:now];
            now = [writer.actuator refreshedNode:node];
        }
        if (!now) { finish([SBWriteResult failure:SBWriteReasonGone method:SBWriteMethodNone]); return; }
        if (!now.isFocused || [writer looksSensitive:now]) { finish([SBWriteResult failure:SBWriteReasonNotFocused method:SBWriteMethodNone]); return; }
        [writer.actuator selectAllInNode:now];
        if (![writer.actuator typeText:text intoNode:now]) { finish([SBWriteResult failure:SBWriteReasonDidNotHold method:SBWriteMethodTyping]); return; }
        NSTimeInterval wait = writer.verifyDelay + 0.004 * (double)[SBEventTap chunksForText:text].count;
        writer.after(wait, ^{
            finish(held() ? [SBWriteResult okWithMethod:SBWriteMethodTyping] : [SBWriteResult failure:SBWriteReasonDidNotHold method:SBWriteMethodTyping]);
        });
    };
    void (^selectedText)(void) = ^{
        SBWriter *writer = weakSelf;
        if (!writer) return;
        id<SBAXNode> now = [writer.actuator refreshedNode:node];
        if (!now) { finish([SBWriteResult failure:SBWriteReasonGone method:SBWriteMethodNone]); return; }
        [writer.actuator selectAllInNode:now];
        if (![writer.actuator replaceSelectionWithText:text inNode:now]) { typing(); return; }
        writer.after(writer.verifyDelay, ^{
            if (held()) finish([SBWriteResult okWithMethod:SBWriteMethodSelectedText]); else typing();
        });
    };

    if (![self.actuator setValue:text ofNode:node]) { selectedText(); return; }
    self.after(self.verifyDelay, ^{
        if (held()) finish([SBWriteResult okWithMethod:SBWriteMethodValue]); else selectedText();
    });
}

#pragma mark check, radio

static BOOL SBIsOn(id<SBAXNode> node) {
    NSString *value = node.value ?: @"";
    return value.length > 0 && ![value isEqualToString:@"0"] && ![value.lowercaseString isEqualToString:@"false"];
}

- (void)pressAndExpectOn:(id<SBAXNode>)node finish:(void (^)(SBWriteResult *))finish {
    // Same rule as the click path: a web checkbox in a Chromium window answers AXPress with success and stays
    // off. The state is read back below either way, so the worst a click costs is the same verified failure.
    BOOL trustworthy = [self.actuator pressIsTrustworthyForNode:node];
    BOOL acted = trustworthy ? [self.actuator pressNode:node] : [self.actuator clickNode:node];
    NSString *method = trustworthy ? SBWriteMethodPress : SBWriteMethodClick;
    if (!acted) { finish([SBWriteResult failure:SBWriteReasonDidNotHold method:method]); return; }
    __weak SBWriter *weakSelf = self;
    self.after(self.verifyDelay, ^{
        id<SBAXNode> now = [weakSelf.actuator refreshedNode:node];
        finish(now && SBIsOn(now) ? [SBWriteResult okWithMethod:method] : [SBWriteResult failure:SBWriteReasonDidNotHold method:method]);
    });
}

- (void)tick:(id<SBAXNode>)node ghost:(SBGhost *)ghost finish:(void (^)(SBWriteResult *))finish {
    // A `check` ghost only ever ticks a box: unticking would undo a choice the app or the user made.
    if (![ghost.value isEqualToString:@"true"]) { finish([SBWriteResult refusal:SBWriteReasonUnsupported]); return; }
    if (SBIsOn(node)) { finish([SBWriteResult okWithMethod:SBWriteMethodNone]); return; }   // the state already matches: no press
    [self pressAndExpectOn:node finish:finish];
}

- (void)choose:(id<SBAXNode>)radio finish:(void (^)(SBWriteResult *))finish {
    if (SBIsOn(radio)) { finish([SBWriteResult okWithMethod:SBWriteMethodNone]); return; }
    [self pressAndExpectOn:radio finish:finish];
}

#pragma mark popup

static void SBCollectMenuItems(id<SBAXNode> node, NSUInteger depth, NSUInteger *budget, NSMutableArray<id<SBAXNode>> *out) {
    if (depth > kMenuSearchDepth || *budget == 0) return;
    for (id<SBAXNode> child in node.children) {
        if (*budget == 0) return;
        (*budget)--;
        if ([child.role isEqualToString:kRoleMenuItem]) [out addObject:child];
        else SBCollectMenuItems(child, depth + 1, budget, out);
    }
}

- (void)pick:(id<SBAXNode>)popup ghost:(SBGhost *)ghost finish:(void (^)(SBWriteResult *))done {
    if (![SBWriter isPlaceholderChoice:popup.value]) { done([SBWriteResult refusal:SBWriteReasonHasValue]); return; }
    NSString *label = ghost.displayText.length ? ghost.displayText : ghost.value;
    if (label.length == 0) { done([SBWriteResult refusal:SBWriteReasonUnsupported]); return; }
    __weak SBWriter *weakSelf = self;
    atomic_store(&_pickUserKey, false);
    atomic_store(&_pickActive, true);
    void (^finish)(SBWriteResult *) = ^(SBWriteResult *result) {
        SBWriter *writer = weakSelf;
        if (writer) atomic_store(&writer->_pickActive, false);
        done(result);
    };
    // A key the user pressed while the menu was up belongs to them (it may have gone to the menu): no Escape after it.
    BOOL (^noUserKey)(void) = ^BOOL {
        SBWriter *writer = weakSelf;
        return writer != nil && !atomic_load(&writer->_pickUserKey);
    };
    BOOL (^shows)(void) = ^BOOL {
        id<SBAXNode> now = [weakSelf.actuator refreshedNode:popup];
        return now != nil && SBSameChoice(now.value ?: now.title, ghost);
    };
    void (^openMenu)(void) = ^{
        SBWriter *writer = weakSelf;
        if (!writer) return;
        if (![writer.actuator pressNode:popup]) { finish([SBWriteResult failure:SBWriteReasonDidNotHold method:SBWriteMethodPress]); return; }
        writer.after(writer.menuDelay, ^{
            SBWriter *inner = weakSelf;
            if (!inner) return;
            id<SBAXNode> open = [inner.actuator refreshedNode:popup];
            NSMutableArray<id<SBAXNode>> *items = [NSMutableArray array];
            NSUInteger budget = kMenuSearchNodes;
            if (open) SBCollectMenuItems(open, 0, &budget, items);
            id<SBAXNode> match = nil;
            for (id<SBAXNode> item in items) {
                if (item.enabled && SBSameChoice(item.title ?: item.value ?: item.axDescription, ghost)) { match = item; break; }
            }
            if (!match) {
                [inner.actuator dismissMenuOfPopup:popup stillWanted:noUserKey];   // we opened it, we close it (if it is open)
                finish([SBWriteResult failure:SBWriteReasonOptionNotFound method:SBWriteMethodPress]);
                return;
            }
            if (![inner.actuator pressNode:match]) {
                [inner.actuator dismissMenuOfPopup:popup stillWanted:noUserKey];
                finish([SBWriteResult failure:SBWriteReasonDidNotHold method:SBWriteMethodPress]);
                return;
            }
            inner.after(inner.verifyDelay, ^{
                finish(shows() ? [SBWriteResult okWithMethod:SBWriteMethodPress] : [SBWriteResult failure:SBWriteReasonDidNotHold method:SBWriteMethodPress]);
            });
        });
    };
    // Cheapest first: some popups take AXValue and nothing has to open.
    if (![self.actuator setValue:label ofNode:popup]) { openMenu(); return; }
    self.after(self.verifyDelay, ^{
        if (shows()) finish([SBWriteResult okWithMethod:SBWriteMethodValue]); else openMenu();
    });
}

@end
