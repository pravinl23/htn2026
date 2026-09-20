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
/**
 * Can this element's AXValue be written at all? Costs one extra round trip, so it is asked only where the
 * answer decides something.
 *
 * It is what tells a box you type in apart from a box that merely holds text. Messages, Mail, Slack and
 * Discord all publish every message on screen as an AXTextArea: without this, one open conversation looked
 * like a twenty-one field form and Ghost offered to fill the other person's messages.
 */
@property (nonatomic, readonly) BOOL valueIsSettable;
/**
 * Does this element publish an AXPress action? Costs one extra round trip, so it is asked only where the
 * answer decides something.
 *
 * It is what tells a label apart from a thing you can press. Measured on a live Messages window: every
 * conversation in the sidebar is an AXStaticText -- no AXRow, no AXCell anywhere -- and every one of them
 * publishes AXPress. Read the role alone and a chat list is nine pieces of text; ask this and it is nine
 * conversations.
 */
@property (nonatomic, readonly) BOOL pressable;
/// The live element behind this node. NULL for fakes.
@property (nonatomic, readonly, nullable) AXUIElementRef axElement;

/// Same underlying element (CFEqual for live nodes, identity for fakes).
- (BOOL)isSameNode:(nullable id<GHAXNode>)other;

@end

/// Seconds an unresponsive app may block one AX call.
extern const float GHAXMessagingTimeoutSeconds; // 0.25

/// A node count and a wall-clock deadline for one bounded walk on the main thread. Every walk outside GHCapture
/// (open panel, combobox list, upload widget checks, page context) spends one of these per visited node, so a huge
/// page cannot freeze Ghost and a hung app (kAXErrorCannotComplete) ends the walk at the first node that says so.
typedef struct {
    NSUInteger nodes;          // visits left
    CFAbsoluteTime deadline;   // CFAbsoluteTimeGetCurrent() value; 0 = no deadline
    BOOL exhausted;            // out of nodes or time
    BOOL hung;                 // a node answered kAXErrorCannotComplete: nothing more is read in this walk
} GHAXWalkBudget;

GHAXWalkBudget GHAXWalkBudgetMake(NSUInteger nodes, NSTimeInterval seconds);
/// A nested walk: its own node count, the parent's deadline.
GHAXWalkBudget GHAXWalkBudgetNested(const GHAXWalkBudget *parent, NSUInteger nodes);
/// Spends one visit on `node`. NO when the budget is out of nodes or time, or `node` looks hung.
BOOL GHAXWalkBudgetSpend(GHAXWalkBudget *budget, id<GHAXNode> _Nullable node);
/// Folds a nested walk back into its parent (a hang or a passed deadline stops the parent too).
void GHAXWalkBudgetAbsorb(GHAXWalkBudget *parent, const GHAXWalkBudget *nested);
/// The node's attribute fetch failed with kAXErrorCannotComplete (the app did not answer in time).
BOOL GHAXNodeLooksHung(id<GHAXNode> _Nullable node);

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
/// Fakes are editable unless a test says otherwise; a dump node takes it from `settable` (default: editable).
@property (nonatomic, readwrite) BOOL valueIsSettable;
/// Fakes publish no AXPress unless a test says so; a dump node takes it from its `actions` list.
@property (nonatomic, readwrite) BOOL pressable;
@property (nonatomic, readwrite) CGRect frame;
@property (nonatomic, readwrite, strong, nullable) id<GHAXNode> titleUIElement;
@property (nonatomic, readwrite, weak, nullable) id<GHAXNode> parent;
@property (nonatomic, readwrite) BOOL isFocused;
/// What a live node's batch fetch would have answered (kAXErrorCannotComplete = a hung app). kAXErrorSuccess default.
@property (nonatomic, readwrite) AXError lastError;

/// How many times `children` was read: lets tests prove that skipped subtrees are never expanded.
@property (nonatomic, readonly) NSUInteger childrenReadCount;

+ (instancetype)nodeWithRole:(NSString *)role;
+ (instancetype)nodeWithRole:(NSString *)role title:(nullable NSString *)title frame:(CGRect)frame;
/// An AXStaticText whose AXValue is `text`.
+ (instancetype)staticText:(NSString *)text frame:(CGRect)frame;

/// Appends and returns the child (so trees can be built inline).
- (GHFakeAXNode *)addChild:(GHFakeAXNode *)child;
- (void)addChildren:(NSArray<GHFakeAXNode *> *)children;
/// A page that changes under the walk (a menu opens after its combo box, a sheet hangs below a window). `index`
/// is clamped to the end; the child's parent is wired.
- (void)insertChild:(GHFakeAXNode *)child atIndex:(NSUInteger)index;
/// Detaches `child` (identity); NO when it was not a child.
- (BOOL)removeChild:(GHFakeAXNode *)child;
/// Position of `child` among the children (identity), NSNotFound when absent. Does not count as a children read.
- (NSUInteger)indexOfChild:(id<GHAXNode>)child;

/// Rebuilds a tree saved by `shabangctl dump-tree` (desktop/tests/fixtures), so real dumps become regression tests.
/// Takes the whole answer (`{ "tree": ... }`) or one bare node. The dump never holds a value: static text keeps
/// its `text`, any other node with `valueLength` N gets N filler characters ("x"), and a `sensitive` node gets
/// none. `description` becomes axDescription, `classes` the DOM class list, `labelledBy` a detached AXStaticText
/// title element. Unknown keys (`actions`, `note`, `childrenOmitted`) are ignored. nil when there is no role.
+ (nullable instancetype)nodeWithDumpTree:(NSDictionary<NSString *, id> *)dump;
/// The same from a JSON file. nil when it cannot be read or parsed.
+ (nullable instancetype)nodeWithDumpTreeFile:(NSString *)path;

@end

NS_ASSUME_NONNULL_END
