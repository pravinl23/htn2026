#import "GHAXNode.h"

const float GHAXMessagingTimeoutSeconds = 0.25f;

GHAXWalkBudget GHAXWalkBudgetMake(NSUInteger nodes, NSTimeInterval seconds) {
    GHAXWalkBudget budget = { nodes, seconds > 0 ? CFAbsoluteTimeGetCurrent() + seconds : 0, NO, NO };
    return budget;
}

GHAXWalkBudget GHAXWalkBudgetNested(const GHAXWalkBudget *parent, NSUInteger nodes) {
    GHAXWalkBudget budget = { nodes, parent ? parent->deadline : 0, parent ? (parent->exhausted || parent->hung) : NO, parent ? parent->hung : NO };
    return budget;
}

BOOL GHAXNodeLooksHung(id<GHAXNode> node) {
    if (!node) return NO;
    if ([(id)node isKindOfClass:[GHAXElementNode class]]) {
        (void)node.role;   // the batch fetch, if it has not happened yet
        return ((GHAXElementNode *)node).lastError == kAXErrorCannotComplete;
    }
    if ([(id)node isKindOfClass:[GHFakeAXNode class]]) return ((GHFakeAXNode *)node).lastError == kAXErrorCannotComplete;
    return NO;
}

BOOL GHAXWalkBudgetSpend(GHAXWalkBudget *budget, id<GHAXNode> node) {
    if (!budget || budget->exhausted || budget->hung) return NO;
    if (budget->nodes == 0 || (budget->deadline > 0 && CFAbsoluteTimeGetCurrent() >= budget->deadline)) {
        budget->exhausted = YES;
        return NO;
    }
    budget->nodes--;
    if (GHAXNodeLooksHung(node)) {
        budget->hung = YES;
        return NO;
    }
    return YES;
}

void GHAXWalkBudgetAbsorb(GHAXWalkBudget *parent, const GHAXWalkBudget *nested) {
    if (!parent || !nested) return;
    if (nested->hung) parent->hung = YES;
    if (parent->deadline > 0 && CFAbsoluteTimeGetCurrent() >= parent->deadline) parent->exhausted = YES;
}

// Order matters: the batch reply is positional.
typedef NS_ENUM(NSUInteger, GHAXSlot) {
    GHAXSlotRole = 0,
    GHAXSlotSubrole,
    GHAXSlotRoleDescription,
    GHAXSlotTitle,
    GHAXSlotDescription,
    GHAXSlotPlaceholder,
    GHAXSlotHelp,
    GHAXSlotValue,
    GHAXSlotDOMIdentifier,
    GHAXSlotIdentifier,
    GHAXSlotDOMClassList,
    GHAXSlotEnabled,
    GHAXSlotRequired,
    GHAXSlotPosition,
    GHAXSlotSize,
    GHAXSlotFocused,
    GHAXSlotChildren,
    GHAXSlotCount,
};

static NSArray<NSString *> *GHAXBatchAttributes(void) {
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
static const NSUInteger GHAXMaxValueLength = 8192;

static NSString *GHAXString(id object) {
    if ([object isKindOfClass:[NSString class]]) return object;
    if ([object isKindOfClass:[NSAttributedString class]]) return [(NSAttributedString *)object string];
    return nil;
}

static NSString *GHAXValueString(id object) {
    NSString *string = GHAXString(object);
    if (string) return string.length > GHAXMaxValueLength ? [string substringToIndex:GHAXMaxValueLength] : string;
    if ([object isKindOfClass:[NSNumber class]]) return [(NSNumber *)object stringValue];
    return nil;
}

static BOOL GHAXIsElement(id object) {
    return object != nil && CFGetTypeID((__bridge CFTypeRef)object) == AXUIElementGetTypeID();
}

@implementation GHAXElementNode {
    AXUIElementRef _element;
    BOOL _fetched;
    NSArray *_slots; // GHAXSlotCount entries, NSNull where the attribute is missing
    NSArray<id<GHAXNode>> *_children;
    BOOL _titleElementFetched;
    id<GHAXNode> _titleUIElement;
    __weak GHAXElementNode *_knownParent;
    BOOL _parentFetched;
    id<GHAXNode> _fetchedParent;
    BOOL _settableKnown;
    BOOL _settable;
}

@synthesize lastError = _lastError;

+ (instancetype)nodeWithElement:(AXUIElementRef)element {
    if (!element) return nil;
    GHAXElementNode *node = [[self alloc] init];
    node->_element = (AXUIElementRef)CFRetain(element);
    return node;
}

+ (void)applyMessagingTimeout {
    AXUIElementRef systemWide = AXUIElementCreateSystemWide();
    if (!systemWide) return;
    AXUIElementSetMessagingTimeout(systemWide, GHAXMessagingTimeoutSeconds);
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
    _lastError = AXUIElementCopyMultipleAttributeValues(_element, (__bridge CFArrayRef)GHAXBatchAttributes(), 0, &values);
    if (_lastError != kAXErrorSuccess || !values) {
        if (values) CFRelease(values);
        return;
    }
    NSArray *raw = CFBridgingRelease(values);
    if (raw.count != GHAXSlotCount) return;
    NSMutableArray *slots = [NSMutableArray arrayWithCapacity:GHAXSlotCount];
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

- (id)slot:(GHAXSlot)slot {
    [self fetchIfNeeded];
    id entry = slot < _slots.count ? _slots[slot] : nil;
    return entry == [NSNull null] ? nil : entry;
}

- (NSString *)stringSlot:(GHAXSlot)slot {
    NSString *string = GHAXString([self slot:slot]);
    return string.length ? string : nil;
}

- (NSString *)role { return [self stringSlot:GHAXSlotRole]; }
- (NSString *)subrole { return [self stringSlot:GHAXSlotSubrole]; }
- (NSString *)roleDescription { return [self stringSlot:GHAXSlotRoleDescription]; }
- (NSString *)title { return [self stringSlot:GHAXSlotTitle]; }
- (NSString *)axDescription { return [self stringSlot:GHAXSlotDescription]; }
- (NSString *)placeholder { return [self stringSlot:GHAXSlotPlaceholder]; }
- (NSString *)help { return [self stringSlot:GHAXSlotHelp]; }
- (NSString *)value { return GHAXValueString([self slot:GHAXSlotValue]); }

- (NSString *)identifier {
    return [self stringSlot:GHAXSlotDOMIdentifier] ?: [self stringSlot:GHAXSlotIdentifier];
}

- (NSArray<NSString *> *)domClassList {
    id list = [self slot:GHAXSlotDOMClassList];
    if (![list isKindOfClass:[NSArray class]]) return nil;
    NSMutableArray<NSString *> *classes = [NSMutableArray array];
    for (id entry in (NSArray *)list) {
        if ([entry isKindOfClass:[NSString class]]) [classes addObject:entry];
    }
    return classes;
}

- (BOOL)enabled {
    id flag = [self slot:GHAXSlotEnabled];
    return [flag isKindOfClass:[NSNumber class]] ? [flag boolValue] : YES;
}

- (BOOL)required {
    id flag = [self slot:GHAXSlotRequired];
    return [flag isKindOfClass:[NSNumber class]] && [flag boolValue];
}

- (BOOL)isFocused {
    id flag = [self slot:GHAXSlotFocused];
    return [flag isKindOfClass:[NSNumber class]] && [flag boolValue];
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
    id position = [self slot:GHAXSlotPosition];
    id size = [self slot:GHAXSlotSize];
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

- (NSArray<id<GHAXNode>> *)children {
    if (_children) return _children;
    NSMutableArray<id<GHAXNode>> *nodes = [NSMutableArray array];
    id list = [self slot:GHAXSlotChildren];
    if ([list isKindOfClass:[NSArray class]]) {
        for (id entry in (NSArray *)list) {
            if (!GHAXIsElement(entry)) continue;
            GHAXElementNode *child = [GHAXElementNode nodeWithElement:(__bridge AXUIElementRef)entry];
            if (!child) continue;
            child->_knownParent = self;
            [nodes addObject:child];
        }
    }
    _children = nodes;
    return _children;
}

- (id<GHAXNode>)copyElementAttribute:(CFStringRef)attribute {
    CFTypeRef value = NULL;
    AXError error = AXUIElementCopyAttributeValue(_element, attribute, &value);
    if (error != kAXErrorSuccess || !value) return nil;
    id object = CFBridgingRelease(value);
    return GHAXIsElement(object) ? [GHAXElementNode nodeWithElement:(__bridge AXUIElementRef)object] : nil;
}

- (id<GHAXNode>)titleUIElement {
    if (!_titleElementFetched) {
        _titleElementFetched = YES;
        _titleUIElement = [self copyElementAttribute:kAXTitleUIElementAttribute];
    }
    return _titleUIElement;
}

- (id<GHAXNode>)parent {
    GHAXElementNode *known = _knownParent;
    if (known) return known;
    if (!_parentFetched) {
        _parentFetched = YES;
        _fetchedParent = [self copyElementAttribute:kAXParentAttribute];
    }
    return _fetchedParent;
}

- (BOOL)isSameNode:(id<GHAXNode>)other {
    if (other == self) return YES;
    AXUIElementRef theirs = other.axElement;
    return theirs != NULL && CFEqual(_element, theirs);
}

- (BOOL)isEqual:(id)object {
    return [object isKindOfClass:[GHAXElementNode class]] && [self isSameNode:object];
}

- (NSUInteger)hash {
    return (NSUInteger)CFHash(_element);
}

- (NSString *)description {
    // Role only: titles and values stay out of logs.
    return [NSString stringWithFormat:@"<GHAXElementNode %@>", _fetched ? (self.role ?: @"?") : @"unfetched"];
}

@end

@implementation GHFakeAXNode {
    NSMutableArray<GHFakeAXNode *> *_children;
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
    GHFakeAXNode *node = [[self alloc] init];
    node.role = role;
    return node;
}

+ (instancetype)nodeWithRole:(NSString *)role title:(NSString *)title frame:(CGRect)frame {
    GHFakeAXNode *node = [self nodeWithRole:role];
    node.title = title;
    node.frame = frame;
    return node;
}

+ (instancetype)staticText:(NSString *)text frame:(CGRect)frame {
    GHFakeAXNode *node = [self nodeWithRole:@"AXStaticText"];
    node.value = text;
    node.frame = frame;
    return node;
}

- (GHFakeAXNode *)addChild:(GHFakeAXNode *)child {
    child.parent = self;
    [_children addObject:child];
    return child;
}

- (void)addChildren:(NSArray<GHFakeAXNode *> *)children {
    for (GHFakeAXNode *child in children) [self addChild:child];
}

- (void)insertChild:(GHFakeAXNode *)child atIndex:(NSUInteger)index {
    if (!child) return;
    child.parent = self;
    [_children insertObject:child atIndex:MIN(index, _children.count)];
}

- (BOOL)removeChild:(GHFakeAXNode *)child {
    NSUInteger index = [_children indexOfObjectIdenticalTo:child];
    if (index == NSNotFound) return NO;
    [_children removeObjectAtIndex:index];
    return YES;
}

- (NSUInteger)indexOfChild:(id<GHAXNode>)child {
    return child ? [_children indexOfObjectIdenticalTo:(GHFakeAXNode *)child] : NSNotFound;
}

- (NSArray<id<GHAXNode>> *)children {
    _childrenReadCount++;
    return [_children copy];
}

- (AXUIElementRef)axElement {
    return NULL;
}

- (BOOL)isSameNode:(id<GHAXNode>)other {
    return other == self;
}

- (NSString *)description {
    return [NSString stringWithFormat:@"<GHFakeAXNode %@>", self.role ?: @"?"];
}

#pragma mark Dump trees

static NSString *GHDumpString(id value) {
    return [value isKindOfClass:[NSString class]] && [(NSString *)value length] > 0 ? value : nil;
}

static CGFloat GHDumpNumber(id value) {
    return [value isKindOfClass:[NSNumber class]] && isfinite([value doubleValue]) ? (CGFloat)[value doubleValue] : 0;
}

static BOOL GHDumpFlag(id value, BOOL fallback) {
    return [value isKindOfClass:[NSNumber class]] ? [value boolValue] : fallback;
}

/// Dumps are bounded (depth, node count), so is this: a hostile or broken file cannot recurse forever.
static const NSUInteger GHDumpMaxDepth = 200;
static const NSUInteger GHDumpMaxValueLength = 8192;

+ (instancetype)nodeFromDump:(NSDictionary *)raw depth:(NSUInteger)depth {
    if (![raw isKindOfClass:[NSDictionary class]] || depth > GHDumpMaxDepth) return nil;
    NSString *role = GHDumpString(raw[@"role"]);
    if (!role) return nil;
    GHFakeAXNode *node = [self nodeWithRole:role];
    node.subrole = GHDumpString(raw[@"subrole"]);
    node.roleDescription = GHDumpString(raw[@"roleDescription"]);
    node.title = GHDumpString(raw[@"title"]);
    node.axDescription = GHDumpString(raw[@"description"]);
    node.placeholder = GHDumpString(raw[@"placeholder"]);
    node.help = GHDumpString(raw[@"help"]);
    node.identifier = GHDumpString(raw[@"identifier"]);

    NSArray *classes = raw[@"classes"];
    if ([classes isKindOfClass:[NSArray class]]) {
        NSMutableArray<NSString *> *list = [NSMutableArray array];
        for (id item in classes) if (GHDumpString(item)) [list addObject:item];
        if (list.count) node.domClassList = list;
    }

    BOOL sensitive = GHDumpFlag(raw[@"sensitive"], NO);
    NSString *text = GHDumpString(raw[@"text"]);
    id length = raw[@"valueLength"];
    if (sensitive) {
        node.value = nil;
    } else if (text) {
        node.value = text;
    } else if ([length isKindOfClass:[NSNumber class]]) {
        NSUInteger count = (NSUInteger)MIN(MAX([length doubleValue], 0.0), (double)GHDumpMaxValueLength);
        node.value = [@"" stringByPaddingToLength:count withString:@"x" startingAtIndex:0];
    }

    NSDictionary *rect = raw[@"rect"];
    if ([rect isKindOfClass:[NSDictionary class]]) {
        node.frame = CGRectMake(GHDumpNumber(rect[@"x"]), GHDumpNumber(rect[@"y"]), GHDumpNumber(rect[@"width"]), GHDumpNumber(rect[@"height"]));
    }
    node.enabled = GHDumpFlag(raw[@"enabled"], YES);
    node.required = GHDumpFlag(raw[@"required"], NO);
    node.isFocused = GHDumpFlag(raw[@"focused"], NO);
    node.valueIsSettable = GHDumpFlag(raw[@"settable"], YES);

    NSString *labelledBy = GHDumpString(raw[@"labelledBy"]);
    if (labelledBy) node.titleUIElement = [self staticText:labelledBy frame:CGRectZero];

    NSArray *children = raw[@"children"];
    if ([children isKindOfClass:[NSArray class]]) {
        for (id child in children) {
            GHFakeAXNode *built = [self nodeFromDump:child depth:depth + 1];
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
