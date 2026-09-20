#import "SBAXNode.h"

const float SBAXMessagingTimeoutSeconds = 0.25f;

SBAXWalkBudget SBAXWalkBudgetMake(NSUInteger nodes, NSTimeInterval seconds) {
    SBAXWalkBudget budget = { nodes, seconds > 0 ? CFAbsoluteTimeGetCurrent() + seconds : 0, NO, NO };
    return budget;
}

SBAXWalkBudget SBAXWalkBudgetNested(const SBAXWalkBudget *parent, NSUInteger nodes) {
    SBAXWalkBudget budget = { nodes, parent ? parent->deadline : 0, parent ? (parent->exhausted || parent->hung) : NO, parent ? parent->hung : NO };
    return budget;
}

BOOL SBAXNodeLooksHung(id<SBAXNode> node) {
    if (!node) return NO;
    if ([(id)node isKindOfClass:[SBAXElementNode class]]) {
        (void)node.role;   // the batch fetch, if it has not happened yet
        return ((SBAXElementNode *)node).lastError == kAXErrorCannotComplete;
    }
    if ([(id)node isKindOfClass:[SBFakeAXNode class]]) return ((SBFakeAXNode *)node).lastError == kAXErrorCannotComplete;
    return NO;
}

BOOL SBAXWalkBudgetSpend(SBAXWalkBudget *budget, id<SBAXNode> node) {
    if (!budget || budget->exhausted || budget->hung) return NO;
    if (budget->nodes == 0 || (budget->deadline > 0 && CFAbsoluteTimeGetCurrent() >= budget->deadline)) {
        budget->exhausted = YES;
        return NO;
    }
    budget->nodes--;
    if (SBAXNodeLooksHung(node)) {
        budget->hung = YES;
        return NO;
    }
    return YES;
}

void SBAXWalkBudgetAbsorb(SBAXWalkBudget *parent, const SBAXWalkBudget *nested) {
    if (!parent || !nested) return;
    if (nested->hung) parent->hung = YES;
    if (parent->deadline > 0 && CFAbsoluteTimeGetCurrent() >= parent->deadline) parent->exhausted = YES;
}

// Order matters: the batch reply is positional.
typedef NS_ENUM(NSUInteger, SBAXSlot) {
    SBAXSlotRole = 0,
    SBAXSlotSubrole,
    SBAXSlotRoleDescription,
    SBAXSlotTitle,
    SBAXSlotDescription,
    SBAXSlotPlaceholder,
    SBAXSlotHelp,
    SBAXSlotValue,
    SBAXSlotDOMIdentifier,
    SBAXSlotIdentifier,
    SBAXSlotDOMClassList,
    SBAXSlotEnabled,
    SBAXSlotRequired,
    SBAXSlotPosition,
    SBAXSlotSize,
    SBAXSlotFocused,
    SBAXSlotChildren,
    SBAXSlotCount,
};

static NSArray<NSString *> *SBAXBatchAttributes(void) {
    static NSArray<NSString *> *attributes;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        attributes = @[
            (__bridge NSString *)kAXRoleAttribute,
            (__bridge NSString *)kAXSubroleAttribute,
            (__bridge NSString *)kAXRoleDescriptionAttribute,
            (__bridge NSString *)kAXTitleAttribute,
            (__bridge NSString *)kAXDescriptionAttribute,
            (__bridge NSString *)kAXPlaceholderValueAttribute,
            (__bridge NSString *)kAXHelpAttribute,
            (__bridge NSString *)kAXValueAttribute,
            @"AXDOMIdentifier",
            (__bridge NSString *)kAXIdentifierAttribute,
            @"AXDOMClassList",
            (__bridge NSString *)kAXEnabledAttribute,
            @"AXRequired",
            (__bridge NSString *)kAXPositionAttribute,
            (__bridge NSString *)kAXSizeAttribute,
            (__bridge NSString *)kAXFocusedAttribute,
            (__bridge NSString *)kAXChildrenAttribute,
        ];
    });
    return attributes;
}

// A text area can hold a whole document; capture only needs "is there a value" and equality checks.
static const NSUInteger SBAXMaxValueLength = 8192;

static NSString *SBAXString(id object) {
    if ([object isKindOfClass:[NSString class]]) return object;
    if ([object isKindOfClass:[NSAttributedString class]]) return [(NSAttributedString *)object string];
    return nil;
}

static NSString *SBAXValueString(id object) {
    NSString *string = SBAXString(object);
    if (string) return string.length > SBAXMaxValueLength ? [string substringToIndex:SBAXMaxValueLength] : string;
    if ([object isKindOfClass:[NSNumber class]]) return [(NSNumber *)object stringValue];
    return nil;
}

static BOOL SBAXIsElement(id object) {
    return object != nil && CFGetTypeID((__bridge CFTypeRef)object) == AXUIElementGetTypeID();
}

@implementation SBAXElementNode {
    AXUIElementRef _element;
    BOOL _fetched;
    NSArray *_slots; // SBAXSlotCount entries, NSNull where the attribute is missing
    NSArray<id<SBAXNode>> *_children;
    BOOL _titleElementFetched;
    id<SBAXNode> _titleUIElement;
    __weak SBAXElementNode *_knownParent;
    BOOL _parentFetched;
    id<SBAXNode> _fetchedParent;
    BOOL _settableKnown;
    BOOL _settable;
    BOOL _pressableKnown;
    BOOL _pressable;
}

@synthesize lastError = _lastError;

+ (instancetype)nodeWithElement:(AXUIElementRef)element {
    if (!element) return nil;
    SBAXElementNode *node = [[self alloc] init];
    node->_element = (AXUIElementRef)CFRetain(element);
    return node;
}

+ (void)applyMessagingTimeout {
    AXUIElementRef systemWide = AXUIElementCreateSystemWide();
    if (!systemWide) return;
    AXUIElementSetMessagingTimeout(systemWide, SBAXMessagingTimeoutSeconds);
    CFRelease(systemWide);
}

- (void)dealloc {
    if (_element) CFRelease(_element);
}

- (AXUIElementRef)axElement {
    return _element;
}

- (void)fetchIfNeeded {
    if (_fetched) return;
    _fetched = YES;
    CFArrayRef values = NULL;
    _lastError = AXUIElementCopyMultipleAttributeValues(_element, (__bridge CFArrayRef)SBAXBatchAttributes(), 0, &values);
    if (_lastError != kAXErrorSuccess || !values) {
        if (values) CFRelease(values);
        return;
    }
    NSArray *raw = CFBridgingRelease(values);
    if (raw.count != SBAXSlotCount) return;
    NSMutableArray *slots = [NSMutableArray arrayWithCapacity:SBAXSlotCount];
    for (id entry in raw) {
        // Missing attributes come back as an AXValue wrapping the AXError.
        BOOL missing = entry == [NSNull null];
        if (!missing && CFGetTypeID((__bridge CFTypeRef)entry) == AXValueGetTypeID()) {
            missing = AXValueGetType((__bridge AXValueRef)entry) == kAXValueTypeAXError;
        }
        [slots addObject:missing ? [NSNull null] : entry];
    }
    _slots = slots;
}

- (id)slot:(SBAXSlot)slot {
    [self fetchIfNeeded];
    id entry = slot < _slots.count ? _slots[slot] : nil;
    return entry == [NSNull null] ? nil : entry;
}

- (NSString *)stringSlot:(SBAXSlot)slot {
    NSString *string = SBAXString([self slot:slot]);
    return string.length ? string : nil;
}

- (NSString *)role { return [self stringSlot:SBAXSlotRole]; }
- (NSString *)subrole { return [self stringSlot:SBAXSlotSubrole]; }
- (NSString *)roleDescription { return [self stringSlot:SBAXSlotRoleDescription]; }
- (NSString *)title { return [self stringSlot:SBAXSlotTitle]; }
- (NSString *)axDescription { return [self stringSlot:SBAXSlotDescription]; }
- (NSString *)placeholder { return [self stringSlot:SBAXSlotPlaceholder]; }
- (NSString *)help { return [self stringSlot:SBAXSlotHelp]; }
- (NSString *)value { return SBAXValueString([self slot:SBAXSlotValue]); }

- (NSString *)identifier {
    return [self stringSlot:SBAXSlotDOMIdentifier] ?: [self stringSlot:SBAXSlotIdentifier];
}

- (NSArray<NSString *> *)domClassList {
    id list = [self slot:SBAXSlotDOMClassList];
    if (![list isKindOfClass:[NSArray class]]) return nil;
    NSMutableArray<NSString *> *classes = [NSMutableArray array];
    for (id entry in (NSArray *)list) {
        if ([entry isKindOfClass:[NSString class]]) [classes addObject:entry];
    }
    return classes;
}

- (BOOL)enabled {
    id flag = [self slot:SBAXSlotEnabled];
    return [flag isKindOfClass:[NSNumber class]] ? [flag boolValue] : YES;
}

- (BOOL)required {
    id flag = [self slot:SBAXSlotRequired];
    return [flag isKindOfClass:[NSNumber class]] && [flag boolValue];
}

- (BOOL)isFocused {
    id flag = [self slot:SBAXSlotFocused];
    return [flag isKindOfClass:[NSNumber class]] && [flag boolValue];
}

- (BOOL)pressable {
    if (_pressableKnown) return _pressable;
    _pressableKnown = YES;
    _pressable = NO;
    AXUIElementRef element = self.axElement;
    CFArrayRef names = NULL;
    if (element && AXUIElementCopyActionNames(element, &names) == kAXErrorSuccess && names) {
        // Only whether AXPress is there. The rest of the list is not read: on a chat app the action names
        // carry the other person's name ("Pin <someone>"), and none of that belongs anywhere near a capture.
        _pressable = [(__bridge NSArray *)names containsObject:(__bridge NSString *)kAXPressAction];
    }
    if (names) CFRelease(names);
    return _pressable;
}

/// Not part of the batch fetch: one call, made only when a caller actually needs the answer, and cached
/// because a node is a snapshot anyway.
- (BOOL)valueIsSettable {
    if (_settableKnown) return _settable;
    _settableKnown = YES;
    _settable = NO;
    AXUIElementRef element = self.axElement;
    Boolean settable = false;
    if (element && AXUIElementIsAttributeSettable(element, kAXValueAttribute, &settable) == kAXErrorSuccess) _settable = settable ? YES : NO;
    return _settable;
}

- (CGRect)frame {
    id position = [self slot:SBAXSlotPosition];
    id size = [self slot:SBAXSlotSize];
    if (!position || !size) return CGRectZero;
    if (CFGetTypeID((__bridge CFTypeRef)position) != AXValueGetTypeID()) return CGRectZero;
    if (CFGetTypeID((__bridge CFTypeRef)size) != AXValueGetTypeID()) return CGRectZero;
    CGPoint origin = CGPointZero;
    CGSize extent = CGSizeZero;
    if (!AXValueGetValue((__bridge AXValueRef)position, kAXValueTypeCGPoint, &origin)) return CGRectZero;
    if (!AXValueGetValue((__bridge AXValueRef)size, kAXValueTypeCGSize, &extent)) return CGRectZero;
    if (!isfinite(origin.x) || !isfinite(origin.y) || !isfinite(extent.width) || !isfinite(extent.height)) return CGRectZero;
    return CGRectMake(origin.x, origin.y, extent.width, extent.height);
}

- (NSArray<id<SBAXNode>> *)children {
    if (_children) return _children;
    NSMutableArray<id<SBAXNode>> *nodes = [NSMutableArray array];
    id list = [self slot:SBAXSlotChildren];
    if ([list isKindOfClass:[NSArray class]]) {
        for (id entry in (NSArray *)list) {
            if (!SBAXIsElement(entry)) continue;
            SBAXElementNode *child = [SBAXElementNode nodeWithElement:(__bridge AXUIElementRef)entry];
            if (!child) continue;
            child->_knownParent = self;
            [nodes addObject:child];
        }
    }
    _children = nodes;
    return _children;
}

- (id<SBAXNode>)copyElementAttribute:(CFStringRef)attribute {
    CFTypeRef value = NULL;
    AXError error = AXUIElementCopyAttributeValue(_element, attribute, &value);
    if (error != kAXErrorSuccess || !value) return nil;
    id object = CFBridgingRelease(value);
    return SBAXIsElement(object) ? [SBAXElementNode nodeWithElement:(__bridge AXUIElementRef)object] : nil;
}

- (id<SBAXNode>)titleUIElement {
    if (!_titleElementFetched) {
        _titleElementFetched = YES;
        _titleUIElement = [self copyElementAttribute:kAXTitleUIElementAttribute];
    }
    return _titleUIElement;
}

- (id<SBAXNode>)parent {
    SBAXElementNode *known = _knownParent;
    if (known) return known;
    if (!_parentFetched) {
        _parentFetched = YES;
        _fetchedParent = [self copyElementAttribute:kAXParentAttribute];
    }
    return _fetchedParent;
}

- (BOOL)isSameNode:(id<SBAXNode>)other {
    if (other == self) return YES;
    AXUIElementRef theirs = other.axElement;
    return theirs != NULL && CFEqual(_element, theirs);
}

- (BOOL)isEqual:(id)object {
    return [object isKindOfClass:[SBAXElementNode class]] && [self isSameNode:object];
}

- (NSUInteger)hash {
    return (NSUInteger)CFHash(_element);
}

- (NSString *)description {
    // Role only: titles and values stay out of logs.
    return [NSString stringWithFormat:@"<SBAXElementNode %@>", _fetched ? (self.role ?: @"?") : @"unfetched"];
}

@end

@implementation SBFakeAXNode {
    NSMutableArray<SBFakeAXNode *> *_children;
}

- (instancetype)init {
    if ((self = [super init])) {
        _children = [NSMutableArray array];
        _enabled = YES;
        _valueIsSettable = YES;
        _frame = CGRectZero;
    }
    return self;
}

+ (instancetype)nodeWithRole:(NSString *)role {
    SBFakeAXNode *node = [[self alloc] init];
    node.role = role;
    return node;
}

+ (instancetype)nodeWithRole:(NSString *)role title:(NSString *)title frame:(CGRect)frame {
    SBFakeAXNode *node = [self nodeWithRole:role];
    node.title = title;
    node.frame = frame;
    return node;
}

+ (instancetype)staticText:(NSString *)text frame:(CGRect)frame {
    SBFakeAXNode *node = [self nodeWithRole:@"AXStaticText"];
    node.value = text;
    node.frame = frame;
    return node;
}

- (SBFakeAXNode *)addChild:(SBFakeAXNode *)child {
    child.parent = self;
    [_children addObject:child];
    return child;
}

- (void)addChildren:(NSArray<SBFakeAXNode *> *)children {
    for (SBFakeAXNode *child in children) [self addChild:child];
}

- (void)insertChild:(SBFakeAXNode *)child atIndex:(NSUInteger)index {
    if (!child) return;
    child.parent = self;
    [_children insertObject:child atIndex:MIN(index, _children.count)];
}

- (BOOL)removeChild:(SBFakeAXNode *)child {
    NSUInteger index = [_children indexOfObjectIdenticalTo:child];
    if (index == NSNotFound) return NO;
    [_children removeObjectAtIndex:index];
    return YES;
}

- (NSUInteger)indexOfChild:(id<SBAXNode>)child {
    return child ? [_children indexOfObjectIdenticalTo:(SBFakeAXNode *)child] : NSNotFound;
}

- (NSArray<id<SBAXNode>> *)children {
    _childrenReadCount++;
    return [_children copy];
}

- (AXUIElementRef)axElement {
    return NULL;
}

- (BOOL)isSameNode:(id<SBAXNode>)other {
    return other == self;
}

- (NSString *)description {
    return [NSString stringWithFormat:@"<SBFakeAXNode %@>", self.role ?: @"?"];
}

#pragma mark Dump trees

static NSString *SBDumpString(id value) {
    return [value isKindOfClass:[NSString class]] && [(NSString *)value length] > 0 ? value : nil;
}

static CGFloat SBDumpNumber(id value) {
    return [value isKindOfClass:[NSNumber class]] && isfinite([value doubleValue]) ? (CGFloat)[value doubleValue] : 0;
}

static BOOL SBDumpFlag(id value, BOOL fallback) {
    return [value isKindOfClass:[NSNumber class]] ? [value boolValue] : fallback;
}

/// Dumps are bounded (depth, node count), so is this: a hostile or broken file cannot recurse forever.
static const NSUInteger SBDumpMaxDepth = 200;
static const NSUInteger SBDumpMaxValueLength = 8192;

+ (instancetype)nodeFromDump:(NSDictionary *)raw depth:(NSUInteger)depth {
    if (![raw isKindOfClass:[NSDictionary class]] || depth > SBDumpMaxDepth) return nil;
    NSString *role = SBDumpString(raw[@"role"]);
    if (!role) return nil;
    SBFakeAXNode *node = [self nodeWithRole:role];
    node.subrole = SBDumpString(raw[@"subrole"]);
    node.roleDescription = SBDumpString(raw[@"roleDescription"]);
    node.title = SBDumpString(raw[@"title"]);
    node.axDescription = SBDumpString(raw[@"description"]);
    node.placeholder = SBDumpString(raw[@"placeholder"]);
    node.help = SBDumpString(raw[@"help"]);
    node.identifier = SBDumpString(raw[@"identifier"]);

    NSArray *classes = raw[@"classes"];
    if ([classes isKindOfClass:[NSArray class]]) {
        NSMutableArray<NSString *> *list = [NSMutableArray array];
        for (id item in classes) if (SBDumpString(item)) [list addObject:item];
        if (list.count) node.domClassList = list;
    }

    BOOL sensitive = SBDumpFlag(raw[@"sensitive"], NO);
    NSString *text = SBDumpString(raw[@"text"]);
    id length = raw[@"valueLength"];
    if (sensitive) {
        node.value = nil;
    } else if (text) {
        node.value = text;
    } else if ([length isKindOfClass:[NSNumber class]]) {
        NSUInteger count = (NSUInteger)MIN(MAX([length doubleValue], 0.0), (double)SBDumpMaxValueLength);
        node.value = [@"" stringByPaddingToLength:count withString:@"x" startingAtIndex:0];
    }

    NSDictionary *rect = raw[@"rect"];
    if ([rect isKindOfClass:[NSDictionary class]]) {
        node.frame = CGRectMake(SBDumpNumber(rect[@"x"]), SBDumpNumber(rect[@"y"]), SBDumpNumber(rect[@"width"]), SBDumpNumber(rect[@"height"]));
    }
    node.enabled = SBDumpFlag(raw[@"enabled"], YES);
    node.required = SBDumpFlag(raw[@"required"], NO);
    node.isFocused = SBDumpFlag(raw[@"focused"], NO);
    node.valueIsSettable = SBDumpFlag(raw[@"settable"], YES);
    NSArray *actions = raw[@"actions"];
    node.pressable = [actions isKindOfClass:[NSArray class]] && [actions containsObject:@"AXPress"];

    NSString *labelledBy = SBDumpString(raw[@"labelledBy"]);
    if (labelledBy) node.titleUIElement = [self staticText:labelledBy frame:CGRectZero];

    NSArray *children = raw[@"children"];
    if ([children isKindOfClass:[NSArray class]]) {
        for (id child in children) {
            SBFakeAXNode *built = [self nodeFromDump:child depth:depth + 1];
            if (built) [node addChild:built];
        }
    }
    return node;
}

+ (instancetype)nodeWithDumpTree:(NSDictionary<NSString *, id> *)dump {
    if (![dump isKindOfClass:[NSDictionary class]]) return nil;
    NSDictionary *tree = [dump[@"tree"] isKindOfClass:[NSDictionary class]] ? dump[@"tree"] : dump;
    return [self nodeFromDump:tree depth:0];
}

+ (instancetype)nodeWithDumpTreeFile:(NSString *)path {
    NSData *data = path.length ? [NSData dataWithContentsOfFile:path] : nil;
    if (!data) return nil;
    id json = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
    return [json isKindOfClass:[NSDictionary class]] ? [self nodeWithDumpTree:json] : nil;
}

@end
