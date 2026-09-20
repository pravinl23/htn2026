// GHWriter: the accept path (the native twin of extension/src/content/execute.ts).
//
//   fill      focus (AXFocused) -> set AXValue -> read back and verify -> [select all + AXSelectedText -> verify]
//             -> real typing (select all, tagged unicode key events) -> verify
//   select    AXPopUpButton: AXValue, else AXPress the popup and AXPress the AXMenuItem with the matching title.
//             A LAZY select on a web combo box (react-select): GHComboBoxDriver types the intended answer, picks an
//             exact / high-confidence option and verifies it. Never typed as free text into a list.
//             Any other AXComboBox: filled like a text field with the option's label.
//   upload    GHOpenPanelDriver: press the page's Attach control (else its file input), drive the macOS open panel
//             with the path, verify the panel closed and the page names the file.
//   check     AXPress only when the state differs. A box is only ever ticked.
//   radio     AXPress the option's radio button only when it is not already chosen.
//   click     Locked targets are NEVER pressed; -focusLockedNode: only moves focus there. An UNLOCKED click ghost
//             is a next-action proposal (docs/anywhere.md) and is pressed with AXPress -- but only when a caller
//             gave this writer an `isNodeLocked` check and that check, asked again about the live element, says
//             the control is reversible. A typeable control (a search box) is focused instead: the cursor going
//             there IS the action, and a click ghost never carries a value to write.
//
// Keys: the typing fallback and every driver post through GHKeyPoster, which re-reads the frontmost app and the
// focused element before each chunk. A driver sequence in flight aborts on any untagged key (-noteUserKeyEvent).
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

@class GHOpenPanelDriver, GHComboBoxDriver;
@protocol GHKeyPosting;

NS_ASSUME_NONNULL_BEGIN

extern NSString *const GHWriteMethodNone;          // nothing was written
extern NSString *const GHWriteMethodValue;         // AXValue
extern NSString *const GHWriteMethodSelectedText;  // AXSelectedText over the whole value
extern NSString *const GHWriteMethodTyping;        // synthetic key events
extern NSString *const GHWriteMethodPress;         // AXPress
extern NSString *const GHWriteMethodClick;         // a real left click, for controls that do not implement AXPress
extern NSString *const GHWriteMethodOpen;          // AXOpen, or a double click: what activating a list entry means
extern NSString *const GHWriteMethodOpenPanel;     // GHOpenPanelDriver
extern NSString *const GHWriteMethodComboBox;      // GHComboBoxDriver
extern NSString *const GHWriteMethodFocus;         // the cursor was put in a text box; nothing was pressed

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
// Driver outcomes are "upload-<GHOpenPanelReason*>" and "combobox-<GHComboBoxReason*>" (short codes, never content).
extern NSString *const GHWriteReasonUploadPrefix;     // "upload-"
extern NSString *const GHWriteReasonComboBoxPrefix;   // "combobox-"

@interface GHWriteResult : NSObject
@property (nonatomic, readonly) BOOL ok;
@property (nonatomic, readonly, copy) NSString *method;
/// Short code, never content. nil when ok.
@property (nonatomic, readonly, copy, nullable) NSString *reason;
/// YES for refusals that mean "leave this field alone" rather than "Ghost is broken here".
@property (nonatomic, readonly) BOOL refused;
/// An open-panel or combobox sequence ran (keys may have been posted): keys the user pressed meanwhile are dropped.
@property (nonatomic, readonly) BOOL sequence;
/// A failure decided after the write (the controller's upload check). `reason` is a short code.
+ (instancetype)failureWithReason:(NSString *)reason method:(NSString *)method sequence:(BOOL)sequence;
/// A success decided after the write: the element the write went into was replaced by the page (React), and a fresh
/// capture shows the new one holding the value.
+ (instancetype)okWithMethod:(NSString *)method;
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
/// Real key events, only while `node` (or something inside it) has keyboard focus: checked again before every chunk.
/// Control characters are typed as spaces. NO when the focus check failed or the system refused an event.
- (BOOL)typeText:(NSString *)text intoNode:(id<GHAXNode>)node;
- (BOOL)pressNode:(id<GHAXNode>)node;
/// Does this element publish an AXPress action at all? A great many controls do not: a Finder row, a Spotify
/// tile, a Discord channel, most custom-drawn and canvas widgets. Asking first is what tells "pressing it did
/// nothing" apart from "this is not a thing you press".
- (BOOL)nodeAcceptsPress:(id<GHAXNode>)node;
/// A real left click at the centre of the element, for everything AXPress cannot reach. The pointer is put
/// back where the user left it afterwards. NO when the element has no usable box on screen, or the system
/// refused the events. Never called for a locked control: the caller checks that first.
- (BOOL)clickNode:(id<GHAXNode>)node;
/**
 * Open a list entry: AXOpen if the element publishes it, else a real DOUBLE click.
 *
 * A row is not a button. AXPress on one SELECTS it -- measured on Spotify, where pressing a playlist
 * highlighted it and opened nothing -- because selecting is what a single click on a row does. Opening it is
 * a double click, or the AXOpen action the app publishes for exactly this.
 */
- (BOOL)openNode:(id<GHAXNode>)node;
/// A popup Ghost opened but cannot operate: close its menu again with one tagged Escape, and only while that menu is
/// really open (an AXMenu under the popup, or focus on a menu item inside it), the same app is in front and
/// `stillWanted` (the user has not pressed a key meanwhile) says yes. YES when the Escape was posted. Forgets the
/// popup's app afterwards: never a second Escape for the same press.
- (BOOL)dismissMenuOfPopup:(id<GHAXNode>)popup stillWanted:(nullable BOOL (^)(void))stillWanted;
/// AXScrollToVisible: the page scrolls the element into view. Writes nothing.
- (BOOL)scrollToVisible:(id<GHAXNode>)node;
@end

/// The live AX calls. Its keyboard is a GHKeyPoster (default +[GHKeyPoster livePoster]).
@interface GHAXLiveActuator : NSObject <GHAXActuating>
- (instancetype)init;
- (instancetype)initWithPoster:(id<GHKeyPosting>)poster NS_DESIGNATED_INITIALIZER;
@property (nonatomic, readonly) id<GHKeyPosting> poster;
@end

/// In-memory actuator over GHFakeAXNode, with switches for every way a real app misbehaves.
@interface GHFakeAXActuator : NSObject <GHAXActuating>
@property (nonatomic) BOOL valueSticks;          // AXValue writes are kept (YES)
@property (nonatomic) BOOL selectedTextSticks;   // AXSelectedText writes are kept (NO: most web views lack it)
@property (nonatomic) BOOL typingSticks;         // typed text reaches the focused node (YES)
@property (nonatomic) BOOL pressWorks;           // AXPress toggles checkboxes/radios and picks menu items (YES)
@property (nonatomic) BOOL publishesPress;       // the element lists AXPress among its actions at all (YES)
@property (nonatomic) BOOL clickWorks;           // a real click reaches the app (YES)
@property (nonatomic) BOOL openWorks;            // AXOpen / a double click opens a list entry (YES)
@property (nonatomic) BOOL focusWorks;           // AXFocused is honoured (YES)
@property (nonatomic) BOOL popupValueSettable;   // AXValue on a popup button works (NO)
@property (nonatomic) BOOL scrollWorks;          // AXScrollToVisible is accepted (YES); what it moves is up to onScroll
/// The "page" scrolling: called by -scrollToVisible: when scrollWorks.
@property (nonatomic, copy, nullable) void (^onScroll)(GHFakeAXNode *node);
/// A page that reformats what it is given (phone mask, upper-casing). nil = keep as is.
@property (nonatomic, copy, nullable) NSString *(^reformat)(NSString *value);
@property (nonatomic, strong, nullable) GHFakeAXNode *focusedNode;
@property (nonatomic, readonly) NSUInteger setValueCount;
@property (nonatomic, readonly) NSUInteger replaceSelectionCount;
@property (nonatomic, readonly) NSUInteger typeCount;
@property (nonatomic, readonly) NSUInteger focusCount;
@property (nonatomic, readonly) NSUInteger dismissMenuCount;
@property (nonatomic, readonly) NSUInteger scrollCount;
@property (nonatomic, readonly, copy) NSArray<id<GHAXNode>> *pressedNodes;
/// Every node -clickNode: was asked to click, in order (whether it worked or not).
@property (nonatomic, readonly, copy) NSArray<id<GHAXNode>> *clickedNodes;
/// Every node -openNode: was asked to open: a list entry is opened, never pressed.
@property (nonatomic, readonly, copy) NSArray<id<GHAXNode>> *openedNodes;
/// Every node -focusNode: was asked to focus, in order (whether it worked or not).
@property (nonatomic, readonly, copy) NSArray<id<GHAXNode>> *focusRequests;
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
/// docs/anywhere.md: a next-action proposal is an UNLOCKED `click` ghost on a plainly reversible control (play,
/// fullscreen, open an item). This block re-reads the live element right before the press and answers whether it
/// is irreversible after all. With no block set EVERY click ghost is refused, which is what the form walk wants:
/// its only click ghost is the locked Submit, and Ghost never presses that.
@property (nonatomic, copy, nullable) BOOL (^isNodeLocked)(id<GHAXNode> node);
/// Runs `block` after `delay` seconds. Default: the main queue. Tests run it inline.
@property (nonatomic, copy) void (^after)(NSTimeInterval delay, dispatch_block_t block);
/// Seconds between a write and its read-back (web views apply and sometimes revert asynchronously).
@property (nonatomic) NSTimeInterval verifyDelay;   // 0.06
@property (nonatomic) NSTimeInterval menuDelay;     // 0.18
@property (nonatomic, readonly) BOOL busy;

/// Upload ghosts. nil = uploads are refused (unsupported). Atomic: the event tap thread reads it.
@property (atomic, strong, nullable) GHOpenPanelDriver *openPanelDriver;
/// Lazy select ghosts on web combo boxes. nil = refused (unsupported), never typed as free text.
@property (atomic, strong, nullable) GHComboBoxDriver *comboBoxDriver;
/// Any thread (the event tap calls it for every untagged key-down): a driver sequence in flight aborts.
- (void)noteUserKeyEvent;
/// Pure: accepting `ghost` runs a multi-step keyboard sequence (upload, or a lazy select on a combo box). Hold-Tab
/// never starts one.
+ (BOOL)ghostRunsSequence:(GHGhost *)ghost field:(nullable GHField *)field;

/// `node` is the element of `field` (for radio groups: anything; `optionNode` is the radio to press; for `file`
/// fields `node` is the widget's Attach control and `optionNode` the page's real file input).
/// The completion always runs, on the queue -after: uses (or the driver's), exactly once.
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
/// Pure: a menu opened from `popup` is showing: an AXMenu child of the (freshly read) popup, or `focused` is an AXMenu
/// or AXMenuItem inside it. An ARIA listbox exposed as a popup button has neither, and gets no Escape.
+ (BOOL)menuIsOpenForPopup:(nullable id<GHAXNode>)popup focused:(nullable id<GHAXNode>)focused;

// ---------- upload widgets (pure, over GHAXNode) ----------
/// The widget around a page's file input: the first named group (title / description) up to 3 levels up, else the
/// input's parent. Greenhouse: the "Resume/CV" group.
+ (nullable id<GHAXNode>)uploadWidgetOfInput:(nullable id<GHAXNode>)input;
/// Page text in the widget names `filename` (case-insensitive). Field values are never read.
+ (BOOL)widget:(nullable id<GHAXNode>)widget mentionsFile:(NSString *)filename;
/// The widget holds a Remove / Delete / Clear control (what upload widgets show once a file is attached).
+ (BOOL)widgetHasRemoveControl:(nullable id<GHAXNode>)widget;
/// "Remove file", "Delete", "Clear": the control a page shows INSTEAD of Attach once a file is attached.
+ (BOOL)labelIsRemoveControl:(nullable NSString *)label;

@end

NS_ASSUME_NONNULL_END
