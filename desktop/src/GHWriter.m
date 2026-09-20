#import "GHWriter.h"
#import "GHComboBoxDriver.h"
#import "GHEventTap.h"
#import "GHKeyPoster.h"
#import "GHLog.h"
#import "GHOpenPanelDriver.h"
#import <stdatomic.h>

NSString *const GHWriteMethodNone = @"none";
NSString *const GHWriteMethodValue = @"value";
NSString *const GHWriteMethodSelectedText = @"selected-text";
NSString *const GHWriteMethodTyping = @"typing";
NSString *const GHWriteMethodPress = @"press";
NSString *const GHWriteMethodOpenPanel = @"open-panel";
NSString *const GHWriteMethodComboBox = @"combobox";
NSString *const GHWriteMethodFocus = @"focus";

NSString *const GHWriteReasonLocked = @"locked";
NSString *const GHWriteReasonSensitive = @"sensitive";
NSString *const GHWriteReasonHasValue = @"has-value";
NSString *const GHWriteReasonPending = @"pending";
NSString *const GHWriteReasonGone = @"gone";
NSString *const GHWriteReasonDisabled = @"disabled";
NSString *const GHWriteReasonBusy = @"busy";
NSString *const GHWriteReasonUnsupported = @"unsupported";
NSString *const GHWriteReasonDidNotHold = @"did-not-hold";
NSString *const GHWriteReasonNotFocused = @"not-focused";
NSString *const GHWriteReasonOptionNotFound = @"option-not-found";
NSString *const GHWriteReasonUploadPrefix = @"upload-";
NSString *const GHWriteReasonComboBoxPrefix = @"combobox-";

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

@interface GHWriteResult ()
@property (nonatomic, readwrite) BOOL ok;
@property (nonatomic, readwrite, copy) NSString *method;
@property (nonatomic, readwrite, copy, nullable) NSString *reason;
@property (nonatomic, readwrite) BOOL refused;
@property (nonatomic, readwrite) BOOL sequence;
@end

@implementation GHWriteResult

+ (instancetype)okWithMethod:(NSString *)method {
    GHWriteResult *result = [[self alloc] init];
    result.ok = YES;
    result.method = method;
    return result;
}

+ (instancetype)refusal:(NSString *)reason {
    GHWriteResult *result = [[self alloc] init];
    result.method = GHWriteMethodNone;
    result.reason = reason;
    result.refused = YES;
    return result;
}

+ (instancetype)failure:(NSString *)reason method:(NSString *)method {
    GHWriteResult *result = [[self alloc] init];
    result.method = method;
    result.reason = reason;
    return result;
}

+ (instancetype)failureWithReason:(NSString *)reason method:(NSString *)method sequence:(BOOL)sequence {
    GHWriteResult *result = [self failure:reason method:method];
    result.sequence = sequence;
    return result;
}

- (instancetype)fromSequence {
    self.sequence = YES;
    return self;
}

- (NSString *)description {
    return [NSString stringWithFormat:@"<GHWriteResult ok=%d method=%@ reason=%@%@>", self.ok, self.method, self.reason ?: @"-", self.sequence ? @" sequence" : @""];
}

@end

#pragma mark - live actuator

static pid_t GHPidOfNode(id<GHAXNode> node) {
    pid_t pid = 0;
    AXUIElementRef element = node.axElement;
    if (element && AXUIElementGetPid(element, &pid) != kAXErrorSuccess) pid = 0;
    return pid;
}

@implementation GHAXLiveActuator {
    pid_t _menuPID;
}

- (instancetype)init {
    return [self initWithPoster:[GHKeyPoster livePoster]];
}

- (instancetype)initWithPoster:(id<GHKeyPosting>)poster {
    if ((self = [super init])) _poster = poster;
    return self;
}

- (id<GHAXNode>)refreshedNode:(id<GHAXNode>)node {
    AXUIElementRef element = node.axElement;
    if (!element) return nil;
    GHAXElementNode *fresh = [GHAXElementNode nodeWithElement:element];
    // A destroyed element answers the batch fetch with kAXErrorInvalidUIElement: no role.
    return fresh.role.length ? fresh : nil;
}

- (BOOL)focusNode:(id<GHAXNode>)node {
    AXUIElementRef element = node.axElement;
    if (!element) return NO;
    return AXUIElementSetAttributeValue(element, kAXFocusedAttribute, kCFBooleanTrue) == kAXErrorSuccess;
}

- (BOOL)setValue:(NSString *)value ofNode:(id<GHAXNode>)node {
    AXUIElementRef element = node.axElement;
    if (!element || !value) return NO;
    Boolean settable = false;
    if (AXUIElementIsAttributeSettable(element, kAXValueAttribute, &settable) != kAXErrorSuccess || !settable) return NO;
    return AXUIElementSetAttributeValue(element, kAXValueAttribute, (__bridge CFStringRef)value) == kAXErrorSuccess;
}

- (BOOL)selectAllInNode:(id<GHAXNode>)node {
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

- (BOOL)replaceSelectionWithText:(NSString *)text inNode:(id<GHAXNode>)node {
    AXUIElementRef element = node.axElement;
    if (!element || !text) return NO;
    Boolean settable = false;
    if (AXUIElementIsAttributeSettable(element, kAXSelectedTextAttribute, &settable) != kAXErrorSuccess || !settable) return NO;
    return AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute, (__bridge CFStringRef)text) == kAXErrorSuccess;
}

- (BOOL)typeText:(NSString *)text intoNode:(id<GHAXNode>)node {
    // What reaches the keyboard is what GHEventTap would have typed: control characters are spaces, never an Enter.
    NSString *typed = [[GHEventTap chunksForText:text ?: @""] componentsJoinedByString:@""];
    if (typed.length == 0 || !node) return NO;
    __block pid_t app = GHPidOfNode(node);
    GHKeyBurstResult *burst = [self.poster postBurst:@[ [GHKeyStroke text:typed] ] guard:^BOOL(GHKeyStroke *stroke, pid_t frontmost, id<GHAXNode> focused) {
        if (app <= 0) app = frontmost;   // fakes carry no element: the app in front at the first chunk is the one
        return frontmost > 0 && frontmost == app && [GHOpenPanelDriver node:focused isInside:node];
    }];
    return burst.ok;
}

- (BOOL)pressNode:(id<GHAXNode>)node {
    AXUIElementRef element = node.axElement;
    if (!element) return NO;
    _menuPID = GHPidOfNode(node);
    AXError error = AXUIElementPerformAction(element, kAXPressAction);
    // A popup runs its menu inside the press: the call times out while the menu is open, and that is a success.
    return error == kAXErrorSuccess || error == kAXErrorCannotComplete;
}

- (BOOL)dismissMenuOfPopup:(id<GHAXNode>)popup stillWanted:(BOOL (^)(void))stillWanted {
    pid_t app = _menuPID;
    _menuPID = 0;
    if (app <= 0 || !popup) return NO;   // no menu of ours to close
    if (stillWanted && !stillWanted()) return NO;
    GHKeyBurstResult *burst = [self.poster postBurst:@[ [GHKeyStroke escape] ] guard:^BOOL(GHKeyStroke *stroke, pid_t frontmost, id<GHAXNode> focused) {
        return [GHWriter menuIsOpenForPopup:[self refreshedNode:popup] focused:focused] && frontmost == app;
    } lastCheck:stillWanted];
    return burst.ok;
}

- (BOOL)scrollToVisible:(id<GHAXNode>)node {
    AXUIElementRef element = node.axElement;
    if (!element) return NO;
    return AXUIElementPerformAction(element, CFSTR("AXScrollToVisible")) == kAXErrorSuccess;
}

@end

#pragma mark - fake actuator

@implementation GHFakeAXActuator {
    NSMutableArray<id<GHAXNode>> *_pressed;
    NSMutableArray<id<GHAXNode>> *_focusRequests;
    __weak GHFakeAXNode *_selectedAll;
}

- (instancetype)init {
    if ((self = [super init])) {
        _valueSticks = YES;
        _typingSticks = YES;
        _pressWorks = YES;
        _focusWorks = YES;
        _scrollWorks = YES;
        _pressed = [NSMutableArray array];
        _focusRequests = [NSMutableArray array];
        _goneNodes = [NSMutableSet set];
    }
    return self;
}

- (NSArray<id<GHAXNode>> *)pressedNodes { return [_pressed copy]; }
- (NSArray<id<GHAXNode>> *)focusRequests { return [_focusRequests copy]; }

- (GHFakeAXNode *)fake:(id<GHAXNode>)node {
    return [(id)node isKindOfClass:[GHFakeAXNode class]] ? (GHFakeAXNode *)node : nil;
}

- (NSString *)shaped:(NSString *)value {
    return self.reformat ? self.reformat(value) : value;
}

- (id<GHAXNode>)refreshedNode:(id<GHAXNode>)node {
    GHFakeAXNode *fake = [self fake:node];
    return (fake && ![_goneNodes containsObject:fake]) ? fake : nil;
}

- (BOOL)focusNode:(id<GHAXNode>)node {
    _focusCount++;
    if (node) [_focusRequests addObject:node];
    GHFakeAXNode *fake = [self fake:node];
    if (!fake || !self.focusWorks) return NO;
    self.focusedNode.isFocused = NO;
    fake.isFocused = YES;
    self.focusedNode = fake;
    return YES;
}

- (BOOL)setValue:(NSString *)value ofNode:(id<GHAXNode>)node {
    _setValueCount++;
    GHFakeAXNode *fake = [self fake:node];
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

- (BOOL)selectAllInNode:(id<GHAXNode>)node {
    _selectedAll = [self fake:node];
    return YES;
}

- (BOOL)replaceSelectionWithText:(NSString *)text inNode:(id<GHAXNode>)node {
    _replaceSelectionCount++;
    GHFakeAXNode *fake = [self fake:node];
    if (!fake || !self.selectedTextSticks) return NO;
    fake.value = [self shaped:text];
    return YES;
}

- (BOOL)typeText:(NSString *)text intoNode:(id<GHAXNode>)node {
    _typeCount++;
    GHFakeAXNode *target = self.focusedNode;
    // The live actuator's guard: nothing is typed unless the node (or something inside it) has focus.
    if (!target || ![GHOpenPanelDriver node:target isInside:node]) return NO;
    if (!self.typingSticks) return YES;   // the events were posted; nobody kept them
    NSString *before = (_selectedAll == target) ? @"" : (target.value ?: @"");
    target.value = [self shaped:[before stringByAppendingString:[[GHEventTap chunksForText:text] componentsJoinedByString:@""]]];
    _selectedAll = nil;
    return YES;
}

- (BOOL)pressNode:(id<GHAXNode>)node {
    [_pressed addObject:node];
    GHFakeAXNode *fake = [self fake:node];
    if (!fake) return NO;
    if (!self.pressWorks) return YES;
    if ([fake.role isEqualToString:kRoleCheckBox]) {
        fake.value = [fake.value isEqualToString:@"1"] ? @"0" : @"1";
    } else if ([fake.role isEqualToString:kRoleRadio]) {
        for (id<GHAXNode> sibling in fake.parent.children) {
            GHFakeAXNode *other = [self fake:sibling];
            if ([other.role isEqualToString:kRoleRadio]) other.value = @"0";
        }
        fake.value = @"1";
    } else if ([fake.role isEqualToString:kRoleMenuItem]) {
        id<GHAXNode> up = fake.parent;
        while (up && ![up.role isEqualToString:kRolePopUp]) up = up.parent;
        [self fake:up].value = fake.title;
    }
    return YES;
}

- (BOOL)dismissMenuOfPopup:(id<GHAXNode>)popup stillWanted:(BOOL (^)(void))stillWanted {
    if (stillWanted && !stillWanted()) return NO;
    if (![GHWriter menuIsOpenForPopup:[self refreshedNode:popup] focused:self.focusedNode]) return NO;
    _dismissMenuCount++;
    return YES;
}

- (BOOL)scrollToVisible:(id<GHAXNode>)node {
    _scrollCount++;
    GHFakeAXNode *fake = [self fake:node];
    if (!fake || !self.scrollWorks || [_goneNodes containsObject:fake]) return NO;
    if (self.onScroll) self.onScroll(fake);
    return YES;
}

@end

#pragma mark - writer

@implementation GHWriter {
    _Atomic(bool) _pickActive;    // a popup menu Ghost opened may be showing
    _Atomic(bool) _pickUserKey;   // the user pressed a key since: no Escape of ours follows it
}

- (instancetype)initWithActuator:(id<GHAXActuating>)actuator {
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

static NSString *GHNormal(NSString *text) {
    NSArray<NSString *> *parts = [text.lowercaseString componentsSeparatedByCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    return [[parts filteredArrayUsingPredicate:[NSPredicate predicateWithFormat:@"length > 0"]] componentsJoinedByString:@" "];
}

#pragma mark sequences and upload widgets

+ (BOOL)ghostRunsSequence:(GHGhost *)ghost field:(GHField *)field {
    if ([ghost.action isEqualToString:GHGhostActionUpload]) return YES;
    return [ghost.action isEqualToString:GHGhostActionSelect] && ghost.lazy && (!field || field.lazyOptions);
}

static BOOL GHNodeIsNamed(id<GHAXNode> node) {
    NSCharacterSet *space = NSCharacterSet.whitespaceAndNewlineCharacterSet;
    return [node.title stringByTrimmingCharactersInSet:space].length > 0 || [node.axDescription stringByTrimmingCharactersInSet:space].length > 0;
}

+ (id<GHAXNode>)uploadWidgetOfInput:(id<GHAXNode>)input {
    id<GHAXNode> widget = nil;
    id<GHAXNode> cursor = input.parent;
    for (NSUInteger level = 0; cursor && level < kWidgetLevelsUp; level++, cursor = cursor.parent) {
        if (![cursor.role isEqualToString:@"AXGroup"]) break;
        widget = cursor;
        if (GHNodeIsNamed(cursor)) break;
    }
    return widget ?: input.parent;
}

/// Breadth-first over `root`, bounded; YES as soon as `match` says so. Never looks into the widget's text fields.
static BOOL GHWidgetHas(id<GHAXNode> root, BOOL (^match)(id<GHAXNode> node)) {
    if (!root) return NO;
    NSMutableArray<id<GHAXNode>> *queue = [NSMutableArray arrayWithObject:root];
    NSMutableArray<NSNumber *> *depths = [NSMutableArray arrayWithObject:@0];
    NSUInteger visited = 0;
    while (queue.count && visited < kWidgetSearchNodes) {
        id<GHAXNode> node = queue.firstObject;
        NSUInteger depth = depths.firstObject.unsignedIntegerValue;
        [queue removeObjectAtIndex:0];
        [depths removeObjectAtIndex:0];
        visited++;
        if (match(node)) return YES;
        if (depth >= kWidgetSearchDepth) continue;
        for (id<GHAXNode> child in node.children) {
            [queue addObject:child];
            [depths addObject:@(depth + 1)];
        }
    }
    return NO;
}

+ (BOOL)widget:(id<GHAXNode>)widget mentionsFile:(NSString *)filename {
    if (!widget || filename.length == 0) return NO;
    return GHWidgetHas(widget, ^BOOL(id<GHAXNode> node) {
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

+ (BOOL)widgetHasRemoveControl:(id<GHAXNode>)widget {
    return GHWidgetHas(widget, ^BOOL(id<GHAXNode> node) {
        if (![node.role isEqualToString:@"AXButton"] && ![node.role isEqualToString:@"AXLink"]) return NO;
        return [self labelIsRemoveControl:[NSString stringWithFormat:@"%@ %@", node.title ?: @"", node.axDescription ?: @""]];
    });
}

static BOOL GHSameChoice(NSString *shown, GHGhost *ghost) {
    NSString *text = GHNormal(shown ?: @"");
    if (text.length == 0) return NO;
    return [text isEqualToString:GHNormal(ghost.displayText ?: @"")] || [text isEqualToString:GHNormal(ghost.value ?: @"")];
}

#pragma mark safety

- (BOOL)looksSensitive:(id<GHAXNode>)node {
    if ([node.role isEqualToString:kRoleSecure] || [node.subrole isEqualToString:kRoleSecure]) return YES;
    // Fail closed: a writer nobody gave a safety check to writes nowhere.
    if (!self.isNodeSensitive) return YES;
    return self.isNodeSensitive(node);
}

- (BOOL)focusLockedNode:(id<GHAXNode>)node {
    // Moving keyboard focus is not activating. There is no code path in this class that presses a button.
    return [self focusNode:node];
}

- (BOOL)focusNode:(id<GHAXNode>)node {
    id<GHAXNode> fresh = node ? [self.actuator refreshedNode:node] : nil;
    if (!fresh || [self looksSensitive:fresh]) return NO;
    return [self.actuator focusNode:fresh];
}

- (void)noteUserKeyEvent {
    [self.openPanelDriver noteUserKeyEvent];
    [self.comboBoxDriver noteUserKeyEvent];
    if (atomic_load(&_pickActive)) atomic_store(&_pickUserKey, true);
}

+ (BOOL)menuIsOpenForPopup:(id<GHAXNode>)popup focused:(id<GHAXNode>)focused {
    if (!popup) return NO;
    for (id<GHAXNode> child in popup.children) if ([child.role isEqualToString:@"AXMenu"]) return YES;
    NSString *role = focused.role;
    BOOL inMenu = [role isEqualToString:@"AXMenu"] || [role isEqualToString:kRoleMenuItem];
    return inMenu && [GHOpenPanelDriver node:focused isInside:popup];
}

#pragma mark execute

- (void)executeGhost:(GHGhost *)ghost field:(GHField *)field node:(id<GHAXNode>)node optionNode:(id<GHAXNode>)optionNode
          completion:(void (^)(GHWriteResult *))completion {
    if (_busy) { completion([GHWriteResult refusal:GHWriteReasonBusy]); return; }
    _busy = YES;
    NSString *label = GHLogLabel(field.label);
    NSString *kind = field.kind ?: @"?";
    NSString *action = ghost.action ?: @"?";
    CFAbsoluteTime started = CFAbsoluteTimeGetCurrent();
    __weak GHWriter *weakSelf = self;
    void (^finish)(GHWriteResult *) = ^(GHWriteResult *result) {
        GHWriter *writer = weakSelf;
        if (writer) writer->_busy = NO;
        GHLog(@"writer: %@ kind=%@ label=%@ ok=%d method=%@ reason=%@ %.0f ms", action, kind, label, result.ok, result.method,
              result.reason ?: @"-", (CFAbsoluteTimeGetCurrent() - started) * 1000.0);
        completion(result);
    };

    // Rule 2 of the safety list: locked targets are never pressed, whatever the ghost claims to be.
    BOOL isClick = [ghost.action isEqualToString:GHGhostActionClick];
    if (!ghost || ghost.locked || field.locked) { finish([GHWriteResult refusal:GHWriteReasonLocked]); return; }
    // An UNLOCKED click ghost is a next-action proposal (docs/anywhere.md): a plainly reversible control the
    // user asked for with Tab. It is pressed only when a caller gave this writer a live lock check, and only
    // after that check has looked at the element again -- with no check, nothing is ever pressed.
    if (isClick && !self.isNodeLocked) { finish([GHWriteResult refusal:GHWriteReasonLocked]); return; }
    if (!isClick && ([field.kind isEqualToString:GHKindButton] || [field.kind isEqualToString:GHKindLink] ||
                     [field.kind isEqualToString:GHKindItem])) { finish([GHWriteResult refusal:GHWriteReasonLocked]); return; }
    if (ghost.pending) { finish([GHWriteResult refusal:GHWriteReasonPending]); return; }

    BOOL isRadio = [field.kind isEqualToString:GHKindRadio];
    id<GHAXNode> target = isRadio ? optionNode : node;
    if (!target) { finish([GHWriteResult refusal:isRadio ? GHWriteReasonOptionNotFound : GHWriteReasonGone]); return; }
    id<GHAXNode> fresh = [self.actuator refreshedNode:target];
    if (!fresh) { finish([GHWriteResult refusal:GHWriteReasonGone]); return; }
    if ([self looksSensitive:fresh]) { finish([GHWriteResult refusal:GHWriteReasonSensitive]); return; }
    if (isRadio && node) {
        id<GHAXNode> group = [self.actuator refreshedNode:node];
        if (group && [self looksSensitive:group]) { finish([GHWriteResult refusal:GHWriteReasonSensitive]); return; }
    }
    if (!fresh.enabled) { finish([GHWriteResult refusal:GHWriteReasonDisabled]); return; }

    if (isClick) { [self press:fresh finish:finish]; return; }
    if ([ghost.action isEqualToString:GHGhostActionUpload]) { [self upload:ghost field:field button:fresh fileInput:optionNode finish:finish]; return; }
    if ([field.kind isEqualToString:GHKindFile]) { finish([GHWriteResult refusal:GHWriteReasonUnsupported]); return; }   // a path only goes through the panel
    if ([ghost.action isEqualToString:GHGhostActionCheck]) { [self tick:fresh ghost:ghost finish:finish]; return; }
    if (isRadio) { [self choose:fresh finish:finish]; return; }
    if ([ghost.action isEqualToString:GHGhostActionSelect]) {
        if ([fresh.role isEqualToString:kRolePopUp]) { [self pick:fresh ghost:ghost finish:finish]; return; }
        if (ghost.lazy) { [self chooseLazy:ghost comboBox:fresh finish:finish]; return; }
        // A combo box is a text field with suggestions: it takes the option's label.
        [self fill:fresh text:ghost.displayText.length ? ghost.displayText : ghost.value finish:finish];
        return;
    }
    if ([ghost.action isEqualToString:GHGhostActionFill]) { [self fill:fresh text:ghost.value finish:finish]; return; }
    finish([GHWriteResult refusal:GHWriteReasonUnsupported]);
}

#pragma mark press (docs/anywhere.md: the next-action proposal)

/// The ONE press in this class. The element is read again by the caller before we get here; this asks the lock
/// check one last time (a control whose name changed under us, a menu that turned into a confirmation) and then
/// performs the app's own default action. Nothing is typed, nothing is filled, no key is posted.
- (void)press:(id<GHAXNode>)node finish:(void (^)(GHWriteResult *))finish {
    if (!self.isNodeLocked || self.isNodeLocked(node)) { finish([GHWriteResult refusal:GHWriteReasonLocked]); return; }
    // A text box is never pressed: putting the cursor in it IS the action (a search box the user is about to
    // type in). Nothing is typed and nothing is filled either way -- the click ghost carries no value.
    BOOL typeable = [node.role isEqualToString:kRoleTextField] || [node.role isEqualToString:kRoleTextArea] ||
                    [node.subrole isEqualToString:kRoleSearchField];
    NSString *method = typeable ? GHWriteMethodFocus : GHWriteMethodPress;
    BOOL ok = typeable ? [self.actuator focusNode:node] : [self.actuator pressNode:node];
    if (!ok) { finish([GHWriteResult failure:GHWriteReasonDidNotHold method:method]); return; }
    finish([GHWriteResult okWithMethod:method]);
}

#pragma mark upload, lazy select

/// One Tab: press the widget's Attach control (else the file input itself) and drive the open panel. The driver
/// refuses before touching anything when the path, the button, an already open panel or the page say no.
- (void)upload:(GHGhost *)ghost field:(GHField *)field button:(id<GHAXNode>)button fileInput:(id<GHAXNode>)fileInput finish:(void (^)(GHWriteResult *))finish {
    GHOpenPanelDriver *driver = self.openPanelDriver;
    if (!driver || ![field.kind isEqualToString:GHKindFile]) { finish([GHWriteResult refusal:GHWriteReasonUnsupported]); return; }
    if (field.value.length > 0) { finish([GHWriteResult refusal:GHWriteReasonHasValue]); return; }   // a file is attached already
    NSString *path = ghost.value ?: @"";
    NSString *problem = [GHOpenPanelDriver problemWithUploadPath:path];
    if (problem) { finish([GHWriteResult refusal:[GHWriteReasonUploadPrefix stringByAppendingString:GHOpenPanelReasonInvalidPath]]); return; }
    id<GHAXNode> target = [GHOpenPanelDriver isUploadButton:button] ? button : nil;
    if (!target && fileInput) {
        id<GHAXNode> input = [self.actuator refreshedNode:fileInput];
        if (input && [GHOpenPanelDriver isUploadButton:input] && ![self looksSensitive:input]) target = input;
    }
    if (!target) { finish([GHWriteResult refusal:[GHWriteReasonUploadPrefix stringByAppendingString:GHOpenPanelReasonNoUploadTarget]]); return; }
    [driver attachFileAtPath:path uploadButton:target completion:^(GHOpenPanelResult *result) {
        NSString *reason = [GHWriteReasonUploadPrefix stringByAppendingString:result.reason ?: @"failed"];
        if (result.ok) finish([[GHWriteResult okWithMethod:GHWriteMethodOpenPanel] fromSequence]);
        else if (result.finalState == GHOpenPanelStateIdle) finish([[GHWriteResult refusal:reason] fromSequence]);   // nothing was touched
        else finish([[GHWriteResult failure:reason method:GHWriteMethodOpenPanel] fromSequence]);
    }];
}

/// react-select and friends: the driver types the intended answer, chooses a real option and verifies it. Skipped
/// (nothing left behind) is a refusal, so the walk goes on; Failed stops the walk.
- (void)chooseLazy:(GHGhost *)ghost comboBox:(id<GHAXNode>)comboBox finish:(void (^)(GHWriteResult *))finish {
    GHComboBoxDriver *driver = self.comboBoxDriver;
    NSString *answer = ghost.value.length ? ghost.value : ghost.displayText;
    if (!driver || ![GHComboBoxDriver isComboBox:comboBox] || answer.length == 0) { finish([GHWriteResult refusal:GHWriteReasonUnsupported]); return; }
    // A protected question is answered with whichever option MEANS "prefer not to answer", in the form's own
    // words: `answer` is only the wording the core proposed (docs/answers.md section 1).
    [driver chooseAnswer:answer
              inComboBox:comboBox
                 decline:ghost.declineAnswer
         neutralFallback:ghost.neutralFallback
              completion:^(GHComboBoxResult *result) {
        NSString *reason = [GHWriteReasonComboBoxPrefix stringByAppendingString:result.reason ?: @"failed"];
        if (result.chosen) finish([[GHWriteResult okWithMethod:GHWriteMethodComboBox] fromSequence]);
        else if (result.skipsField) finish([[GHWriteResult refusal:reason] fromSequence]);
        else finish([[GHWriteResult failure:reason method:GHWriteMethodComboBox] fromSequence]);
    }];
}

#pragma mark fill

- (void)fill:(id<GHAXNode>)node text:(NSString *)text finish:(void (^)(GHWriteResult *))finish {
    if (text.length == 0) { finish([GHWriteResult refusal:GHWriteReasonUnsupported]); return; }
    // Rule 9: whitespace counts as a value, so nothing the user typed is ever overwritten.
    if (node.value.length > 0) { finish([GHWriteResult refusal:GHWriteReasonHasValue]); return; }
    [self.actuator focusNode:node];   // cosmetic for AXValue, required for typing (checked there)

    __weak GHWriter *weakSelf = self;
    BOOL (^held)(void) = ^BOOL {
        GHWriter *writer = weakSelf;
        id<GHAXNode> now = writer ? [writer.actuator refreshedNode:node] : nil;
        return now != nil && [GHWriter value:now.value holds:text];
    };
    void (^typing)(void) = ^{
        GHWriter *writer = weakSelf;
        if (!writer) return;
        // Key events land on whatever has keyboard focus: it has to be this very element.
        id<GHAXNode> now = [writer.actuator refreshedNode:node];
        if (now && !now.isFocused) {
            [writer.actuator focusNode:now];
            now = [writer.actuator refreshedNode:node];
        }
        if (!now) { finish([GHWriteResult failure:GHWriteReasonGone method:GHWriteMethodNone]); return; }
        if (!now.isFocused || [writer looksSensitive:now]) { finish([GHWriteResult failure:GHWriteReasonNotFocused method:GHWriteMethodNone]); return; }
        [writer.actuator selectAllInNode:now];
        if (![writer.actuator typeText:text intoNode:now]) { finish([GHWriteResult failure:GHWriteReasonDidNotHold method:GHWriteMethodTyping]); return; }
        NSTimeInterval wait = writer.verifyDelay + 0.004 * (double)[GHEventTap chunksForText:text].count;
        writer.after(wait, ^{
            finish(held() ? [GHWriteResult okWithMethod:GHWriteMethodTyping] : [GHWriteResult failure:GHWriteReasonDidNotHold method:GHWriteMethodTyping]);
        });
    };
    void (^selectedText)(void) = ^{
        GHWriter *writer = weakSelf;
        if (!writer) return;
        id<GHAXNode> now = [writer.actuator refreshedNode:node];
        if (!now) { finish([GHWriteResult failure:GHWriteReasonGone method:GHWriteMethodNone]); return; }
        [writer.actuator selectAllInNode:now];
        if (![writer.actuator replaceSelectionWithText:text inNode:now]) { typing(); return; }
        writer.after(writer.verifyDelay, ^{
            if (held()) finish([GHWriteResult okWithMethod:GHWriteMethodSelectedText]); else typing();
        });
    };

    if (![self.actuator setValue:text ofNode:node]) { selectedText(); return; }
    self.after(self.verifyDelay, ^{
        if (held()) finish([GHWriteResult okWithMethod:GHWriteMethodValue]); else selectedText();
    });
}

#pragma mark check, radio

static BOOL GHIsOn(id<GHAXNode> node) {
    NSString *value = node.value ?: @"";
    return value.length > 0 && ![value isEqualToString:@"0"] && ![value.lowercaseString isEqualToString:@"false"];
}

- (void)pressAndExpectOn:(id<GHAXNode>)node finish:(void (^)(GHWriteResult *))finish {
    if (![self.actuator pressNode:node]) { finish([GHWriteResult failure:GHWriteReasonDidNotHold method:GHWriteMethodPress]); return; }
    __weak GHWriter *weakSelf = self;
    self.after(self.verifyDelay, ^{
        id<GHAXNode> now = [weakSelf.actuator refreshedNode:node];
        finish(now && GHIsOn(now) ? [GHWriteResult okWithMethod:GHWriteMethodPress] : [GHWriteResult failure:GHWriteReasonDidNotHold method:GHWriteMethodPress]);
    });
}

- (void)tick:(id<GHAXNode>)node ghost:(GHGhost *)ghost finish:(void (^)(GHWriteResult *))finish {
    // A `check` ghost only ever ticks a box: unticking would undo a choice the app or the user made.
    if (![ghost.value isEqualToString:@"true"]) { finish([GHWriteResult refusal:GHWriteReasonUnsupported]); return; }
    if (GHIsOn(node)) { finish([GHWriteResult okWithMethod:GHWriteMethodNone]); return; }   // the state already matches: no press
    [self pressAndExpectOn:node finish:finish];
}

- (void)choose:(id<GHAXNode>)radio finish:(void (^)(GHWriteResult *))finish {
    if (GHIsOn(radio)) { finish([GHWriteResult okWithMethod:GHWriteMethodNone]); return; }
    [self pressAndExpectOn:radio finish:finish];
}

#pragma mark popup

static void GHCollectMenuItems(id<GHAXNode> node, NSUInteger depth, NSUInteger *budget, NSMutableArray<id<GHAXNode>> *out) {
    if (depth > kMenuSearchDepth || *budget == 0) return;
    for (id<GHAXNode> child in node.children) {
        if (*budget == 0) return;
        (*budget)--;
        if ([child.role isEqualToString:kRoleMenuItem]) [out addObject:child];
        else GHCollectMenuItems(child, depth + 1, budget, out);
    }
}

- (void)pick:(id<GHAXNode>)popup ghost:(GHGhost *)ghost finish:(void (^)(GHWriteResult *))done {
    if (![GHWriter isPlaceholderChoice:popup.value]) { done([GHWriteResult refusal:GHWriteReasonHasValue]); return; }
    NSString *label = ghost.displayText.length ? ghost.displayText : ghost.value;
    if (label.length == 0) { done([GHWriteResult refusal:GHWriteReasonUnsupported]); return; }
    __weak GHWriter *weakSelf = self;
    atomic_store(&_pickUserKey, false);
    atomic_store(&_pickActive, true);
    void (^finish)(GHWriteResult *) = ^(GHWriteResult *result) {
        GHWriter *writer = weakSelf;
        if (writer) atomic_store(&writer->_pickActive, false);
        done(result);
    };
    // A key the user pressed while the menu was up belongs to them (it may have gone to the menu): no Escape after it.
    BOOL (^noUserKey)(void) = ^BOOL {
        GHWriter *writer = weakSelf;
        return writer != nil && !atomic_load(&writer->_pickUserKey);
    };
    BOOL (^shows)(void) = ^BOOL {
        id<GHAXNode> now = [weakSelf.actuator refreshedNode:popup];
        return now != nil && GHSameChoice(now.value ?: now.title, ghost);
    };
    void (^openMenu)(void) = ^{
        GHWriter *writer = weakSelf;
        if (!writer) return;
        if (![writer.actuator pressNode:popup]) { finish([GHWriteResult failure:GHWriteReasonDidNotHold method:GHWriteMethodPress]); return; }
        writer.after(writer.menuDelay, ^{
            GHWriter *inner = weakSelf;
            if (!inner) return;
            id<GHAXNode> open = [inner.actuator refreshedNode:popup];
            NSMutableArray<id<GHAXNode>> *items = [NSMutableArray array];
            NSUInteger budget = kMenuSearchNodes;
            if (open) GHCollectMenuItems(open, 0, &budget, items);
            id<GHAXNode> match = nil;
            for (id<GHAXNode> item in items) {
                if (item.enabled && GHSameChoice(item.title ?: item.value ?: item.axDescription, ghost)) { match = item; break; }
            }
            if (!match) {
                [inner.actuator dismissMenuOfPopup:popup stillWanted:noUserKey];   // we opened it, we close it (if it is open)
                finish([GHWriteResult failure:GHWriteReasonOptionNotFound method:GHWriteMethodPress]);
                return;
            }
            if (![inner.actuator pressNode:match]) {
                [inner.actuator dismissMenuOfPopup:popup stillWanted:noUserKey];
                finish([GHWriteResult failure:GHWriteReasonDidNotHold method:GHWriteMethodPress]);
                return;
            }
            inner.after(inner.verifyDelay, ^{
                finish(shows() ? [GHWriteResult okWithMethod:GHWriteMethodPress] : [GHWriteResult failure:GHWriteReasonDidNotHold method:GHWriteMethodPress]);
            });
        });
    };
    // Cheapest first: some popups take AXValue and nothing has to open.
    if (![self.actuator setValue:label ofNode:popup]) { openMenu(); return; }
    self.after(self.verifyDelay, ^{
        if (shows()) finish([GHWriteResult okWithMethod:GHWriteMethodValue]); else openMenu();
    });
}

@end
