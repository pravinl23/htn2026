// GHAXNode: a read-only view of one accessibility element. Capture logic only ever talks to this
// protocol, so it runs unchanged against live AXUIElementRefs (GHAXElementNode) and against fake
// trees in tests (GHFakeAXNode).
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ApplicationServices/ApplicationServices.h>

NS_ASSUME_NONNULL_BEGIN

@protocol GHAXNode <NSObject>

@property (nonatomic, readonly, copy, nullable) NSString *role;
@property (nonatomic, readonly, copy, nullable) NSString *subrole;
/// Localized ("email field", "telephone number field"). Only ever used as a weak hint.
@property (nonatomic, readonly, copy, nullable) NSString *roleDescription;
@property (nonatomic, readonly, copy, nullable) NSString *title;
@property (nonatomic, readonly, copy, nullable) NSString *axDescription;
@property (nonatomic, readonly, copy, nullable) NSString *placeholder;
@property (nonatomic, readonly, copy, nullable) NSString *help;
/// AXValue as a string: strings as they are, numbers and booleans as "1"/"0"/"2", anything else nil.
@property (nonatomic, readonly, copy, nullable) NSString *value;
/// AXDOMIdentifier when the element comes from a web view, else AXIdentifier.
@property (nonatomic, readonly, copy, nullable) NSString *identifier;
/// AXDOMClassList when exposed (WebKit and Chromium).
@property (nonatomic, readonly, copy, nullable) NSArray<NSString *> *domClassList;
/// YES unless the element says AXEnabled = false.
@property (nonatomic, readonly) BOOL enabled;
/// AXRequired (aria-required / required) when exposed.
@property (nonatomic, readonly) BOOL required;
/// Global display coordinates, top-left origin. CGRectZero when unknown.
@property (nonatomic, readonly) CGRect frame;
@property (nonatomic, readonly) NSArray<id<GHAXNode>> *children;
@property (nonatomic, readonly, nullable) id<GHAXNode> titleUIElement;
@property (nonatomic, readonly, nullable) id<GHAXNode> parent;
@property (nonatomic, readonly) BOOL isFocused;
/// The live element behind this node. NULL for fakes.
@property (nonatomic, readonly, nullable) AXUIElementRef axElement;

/// Same underlying element (CFEqual for live nodes, identity for fakes).
- (BOOL)isSameNode:(nullable id<GHAXNode>)other;

@end

/// Seconds an unresponsive app may block one AX call.
extern const float GHAXMessagingTimeoutSeconds; // 0.25

/// Live node. Every scalar attribute is fetched in ONE AXUIElementCopyMultipleAttributeValues round
/// trip on first access and cached, so a node is a snapshot: make a new one to see new state.
/// Children, the title element and the parent are fetched lazily, one call each.
@interface GHAXElementNode : NSObject <GHAXNode>

/// Retains `element`. Returns nil for NULL.
+ (nullable instancetype)nodeWithElement:(nullable AXUIElementRef)element;

/// AXError of the batch fetch (kAXErrorSuccess before the fetch and when it worked).
@property (nonatomic, readonly) AXError lastError;

/// Applies GHAXMessagingTimeoutSeconds process-wide through the system-wide element. GHAccessibility
/// calls it once trusted and sets the same timeout on every application element it talks to.
+ (void)applyMessagingTimeout;

@end

/// In-memory node for tests. All properties are writable; `addChild:` wires the parent.
@interface GHFakeAXNode : NSObject <GHAXNode>

@property (nonatomic, readwrite, copy, nullable) NSString *role;
@property (nonatomic, readwrite, copy, nullable) NSString *subrole;
@property (nonatomic, readwrite, copy, nullable) NSString *roleDescription;
@property (nonatomic, readwrite, copy, nullable) NSString *title;
@property (nonatomic, readwrite, copy, nullable) NSString *axDescription;
@property (nonatomic, readwrite, copy, nullable) NSString *placeholder;
@property (nonatomic, readwrite, copy, nullable) NSString *help;
@property (nonatomic, readwrite, copy, nullable) NSString *value;
@property (nonatomic, readwrite, copy, nullable) NSString *identifier;
@property (nonatomic, readwrite, copy, nullable) NSArray<NSString *> *domClassList;
@property (nonatomic, readwrite) BOOL enabled;
@property (nonatomic, readwrite) BOOL required;
@property (nonatomic, readwrite) CGRect frame;
@property (nonatomic, readwrite, strong, nullable) id<GHAXNode> titleUIElement;
@property (nonatomic, readwrite, weak, nullable) id<GHAXNode> parent;
@property (nonatomic, readwrite) BOOL isFocused;

/// How many times `children` was read: lets tests prove that skipped subtrees are never expanded.
@property (nonatomic, readonly) NSUInteger childrenReadCount;

+ (instancetype)nodeWithRole:(NSString *)role;
+ (instancetype)nodeWithRole:(NSString *)role title:(nullable NSString *)title frame:(CGRect)frame;
/// An AXStaticText whose AXValue is `text`.
+ (instancetype)staticText:(NSString *)text frame:(CGRect)frame;

/// Appends and returns the child (so trees can be built inline).
- (GHFakeAXNode *)addChild:(GHFakeAXNode *)child;
- (void)addChildren:(NSArray<GHFakeAXNode *> *)children;

@end

NS_ASSUME_NONNULL_END
