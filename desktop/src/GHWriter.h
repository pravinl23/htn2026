// GHWriter: the accept path (the native twin of extension/src/content/execute.ts).
//
//   fill      focus (AXFocused) -> set AXValue -> read back and verify -> [select all + AXSelectedText -> verify]
//             -> real typing (select all, tagged unicode key events) -> verify
//   select    AXPopUpButton: AXValue, else AXPress the popup and AXPress the AXMenuItem with the matching title.
//             AXComboBox: filled like a text field with the option's label.
//   check     AXPress only when the state differs. A box is only ever ticked.
//   radio     AXPress the option's radio button only when it is not already chosen.
//   click     NEVER. Locked targets are not pressed by Ghost; -focusLockedNode: only moves focus there.
//
// Before anything is written the element is read again: a secure or sensitive-looking element is refused, a
// field that gained a value is refused (rule 9), a disabled or vanished element is refused. After every write
// the value is read back; a write that did not hold is reported and the controller stops the walk.
//
// Every AX call goes through GHAXActuating, so the whole path runs against GHFakeAXNode trees in tests.
// Values are never logged.
#import <Foundation/Foundation.h>
#import "GHAXNode.h"
#import "GHField.h"
#import "GHWalkState.h"

NS_ASSUME_NONNULL_BEGIN

extern NSString *const GHWriteMethodNone;          // nothing was written
extern NSString *const GHWriteMethodValue;         // AXValue
extern NSString *const GHWriteMethodSelectedText;  // AXSelectedText over the whole value
extern NSString *const GHWriteMethodTyping;        // synthetic key events
extern NSString *const GHWriteMethodPress;         // AXPress

// Refusals (nothing was touched).
extern NSString *const GHWriteReasonLocked;
extern NSString *const GHWriteReasonSensitive;
extern NSString *const GHWriteReasonHasValue;
extern NSString *const GHWriteReasonPending;
extern NSString *const GHWriteReasonGone;
extern NSString *const GHWriteReasonDisabled;
extern NSString *const GHWriteReasonBusy;
extern NSString *const GHWriteReasonUnsupported;
// Failures (something was tried).
extern NSString *const GHWriteReasonDidNotHold;
extern NSString *const GHWriteReasonNotFocused;
extern NSString *const GHWriteReasonOptionNotFound;

@interface GHWriteResult : NSObject
@property (nonatomic, readonly) BOOL ok;
@property (nonatomic, readonly, copy) NSString *method;
/// Short code, never content. nil when ok.
@property (nonatomic, readonly, copy, nullable) NSString *reason;
/// YES for refusals that mean "leave this field alone" rather than "Ghost is broken here".
@property (nonatomic, readonly) BOOL refused;
@end

/// The few AX operations that change something. Live: GHAXLiveActuator. Tests: GHFakeAXActuator.
@protocol GHAXActuating <NSObject>
/// Nodes are snapshots: a fresh one of the same element. nil when the element is gone.
- (nullable id<GHAXNode>)refreshedNode:(id<GHAXNode>)node;
- (BOOL)focusNode:(id<GHAXNode>)node;
- (BOOL)setValue:(NSString *)value ofNode:(id<GHAXNode>)node;
/// AXSelectedTextRange over the whole value.
- (BOOL)selectAllInNode:(id<GHAXNode>)node;
/// AXSelectedText: replaces the selection through the app's own editing path.
- (BOOL)replaceSelectionWithText:(NSString *)text inNode:(id<GHAXNode>)node;
/// Real key events into whatever has keyboard focus. The writer checks focus first.
- (BOOL)typeText:(NSString *)text;
- (BOOL)pressNode:(id<GHAXNode>)node;
/// A popup Ghost opened but cannot operate: close it again (a tagged Escape).
- (void)dismissOpenMenu;
@end

@interface GHAXLiveActuator : NSObject <GHAXActuating>
@end

/// In-memory actuator over GHFakeAXNode, with switches for every way a real app misbehaves.
@interface GHFakeAXActuator : NSObject <GHAXActuating>
@property (nonatomic) BOOL valueSticks;          // AXValue writes are kept (YES)
@property (nonatomic) BOOL selectedTextSticks;   // AXSelectedText writes are kept (NO: most web views lack it)
@property (nonatomic) BOOL typingSticks;         // typed text reaches the focused node (YES)
@property (nonatomic) BOOL pressWorks;           // AXPress toggles checkboxes/radios and picks menu items (YES)
@property (nonatomic) BOOL focusWorks;           // AXFocused is honoured (YES)
@property (nonatomic) BOOL popupValueSettable;   // AXValue on a popup button works (NO)
/// A page that reformats what it is given (phone mask, upper-casing). nil = keep as is.
@property (nonatomic, copy, nullable) NSString *(^reformat)(NSString *value);
@property (nonatomic, strong, nullable) GHFakeAXNode *focusedNode;
@property (nonatomic, readonly) NSUInteger setValueCount;
@property (nonatomic, readonly) NSUInteger replaceSelectionCount;
@property (nonatomic, readonly) NSUInteger typeCount;
@property (nonatomic, readonly) NSUInteger focusCount;
@property (nonatomic, readonly) NSUInteger dismissMenuCount;
@property (nonatomic, readonly, copy) NSArray<id<GHAXNode>> *pressedNodes;
/// Nodes removed from the "app": refreshedNode: returns nil for them.
@property (nonatomic, readonly) NSMutableSet<GHFakeAXNode *> *goneNodes;
@end

@interface GHWriter : NSObject

- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithActuator:(id<GHAXActuating>)actuator NS_DESIGNATED_INITIALIZER;

@property (nonatomic, readonly) id<GHAXActuating> actuator;
/// Fresh safety check of the live element right before a write (GHCapture -isNodeSensitive:). The writer
/// refuses AXSecureTextField by itself; with no block set every other node counts as NOT checked and is
/// refused too, so a writer that was wired up wrong cannot write anywhere.
@property (nonatomic, copy, nullable) BOOL (^isNodeSensitive)(id<GHAXNode> node);
/// Runs `block` after `delay` seconds. Default: the main queue. Tests run it inline.
@property (nonatomic, copy) void (^after)(NSTimeInterval delay, dispatch_block_t block);
/// Seconds between a write and its read-back (web views apply and sometimes revert asynchronously).
@property (nonatomic) NSTimeInterval verifyDelay;   // 0.06
@property (nonatomic) NSTimeInterval menuDelay;     // 0.18
@property (nonatomic, readonly) BOOL busy;

/// `node` is the element of `field` (for radio groups: anything; `optionNode` is the radio to press).
/// The completion always runs, on the queue -after: uses, exactly once.
- (void)executeGhost:(GHGhost *)ghost
               field:(GHField *)field
                node:(nullable id<GHAXNode>)node
          optionNode:(nullable id<GHAXNode>)optionNode
          completion:(void (^)(GHWriteResult *result))completion;

/// Rule 3: focus lands on the locked element so an explicit Enter or click can confirm. Never presses.
- (BOOL)focusLockedNode:(id<GHAXNode>)node;
/// Cosmetic focus move onto the next ghost's field.
- (BOOL)focusNode:(id<GHAXNode>)node;

/// Pure: did `actual` keep `expected`, allowing for the page's own spelling (masks, trimming, case)?
+ (BOOL)value:(nullable NSString *)actual holds:(NSString *)expected;
/// Pure: letters and digits only, NFKC, lower case.
+ (NSString *)comparable:(nullable NSString *)text;
/// Pure: "Select...", "Choose one", "--", "" stand for "nothing chosen yet".
+ (BOOL)isPlaceholderChoice:(nullable NSString *)shown;

@end

NS_ASSUME_NONNULL_END
