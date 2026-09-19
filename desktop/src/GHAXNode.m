#import "GHAXNode.h"

const float GHAXMessagingTimeoutSeconds = 0.25f;

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

@end
