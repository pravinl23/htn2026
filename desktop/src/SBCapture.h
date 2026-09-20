// SBCapture: turns the accessibility tree of one window into SBFields (the native twin of
// extension/src/content/capture.ts). Pure logic over SBAXNode, so it is tested with fake trees.
//
// Walk: breadth-first, bounded (nodes, depth, wall clock). When a bound trips the walk stops and the
// fields found so far are returned. Browser chrome is excluded from results; when the window has a
// web area, only fields inside a web area are returned. Safari may place that web area below AXTabGroup,
// so the walker can traverse a tab group while still refusing its controls as page candidates. Outside a
// web area, toolbars, menus, tab-bar items (AXTabButton) and the address field are never entered.
//
// Real forms (desktop/tests/fixtures/greenhouse-safari-viam.json):
// - label = AXTitle, else AXDescription, else AXTitleUIElement, placeholder, help, preceding static text;
// - kind: role description ("email field", "telephone number field"), then DOM id/classes, then the label
//   ("LinkedIn Profile", "Github", "Website" are url fields);
// - AXComboBox without readable options (react-select) is a select with `lazyOptions`; its placeholder / chosen
//   value sibling gives it a visible box, and its trailing "Toggle flyout" button is part of it, not a field;
// - an upload widget (file input + "Attach" + Dropbox / Google Drive / "Enter manually") is ONE `file` field,
//   labelled by the widget ("Resume/CV"), whose element is the visible "Attach" button (fallback: the input);
// - a site's own "Autofill my application" button is ignored.
//
// Safety: AXSecureTextField is never captured, and neither is anything whose naming sources trip the
// sensitive rules (not even its label). Values never reach a signature, a label or a log.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import "SBAXNode.h"
#import "SBField.h"
#import "SBSafetyChecking.h"

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, SBCaptureStop) {
    SBCaptureStopNone = 0,   // the whole window was walked
    SBCaptureStopNodes,      // maxNodes reached
    SBCaptureStopTime,       // timeBudget used up
};

@interface SBCaptureLimits : NSObject <NSCopying>
@property (nonatomic) NSUInteger maxNodes;        // 1500
@property (nonatomic) NSUInteger maxDepth;        // 40 (children below it are not visited)
@property (nonatomic) NSTimeInterval timeBudget;  // 0.120 s
/// Replaces timeBudget once the walk has met an AXWebArea: a real job posting is ~400 nodes of IPC into
/// WebKit (~0.4 ms each), and a walk cut short there drops the bottom of the form, the locked Submit with it,
/// and changes the form signature from one rescan to the next. maxNodes still bounds the walk. 0.6 s
@property (nonatomic) NSTimeInterval webAreaTimeBudget;
@property (nonatomic) NSUInteger maxLinks;        // 40: links never get a ghost, keep the state small
@property (nonatomic) NSUInteger maxOptions;      // 255: Jev's choice limit
/// Rows entered per AXTable / AXOutline / AXList / AXGrid / AXBrowser. 12. A Finder folder or a Spotify
/// playlist has thousands of them, nobody is about to click the 900th, and walking them costs the whole budget.
@property (nonatomic) NSUInteger maxListRows;
+ (instancetype)defaultLimits;
@end

@interface SBCaptureResult : NSObject
/// Reading order: top to bottom, then left to right. Sensitive fields are absent.
@property (nonatomic, readonly, copy) NSArray<SBField *> *fields;
@property (nonatomic, readonly) NSUInteger visitedNodes;
@property (nonatomic, readonly) SBCaptureStop stop;
/// YES when the walk stopped early (nodes or time) or the depth bound hid part of the tree.
@property (nonatomic, readonly) BOOL partial;
@property (nonatomic, readonly) NSTimeInterval elapsed;
@property (nonatomic, readonly) CGRect windowFrame;
@property (nonatomic, readonly) BOOL sawWebArea;
/// The node the walk started from (the focused window). docs/anywhere.md: SBAffordance reads it again to
/// measure the page, so a native window gets the same hints a web page does.
@property (nonatomic, readonly, strong, nullable) id<SBAXNode> windowNode;
/// First web area met by the walk (SBAccessibility reads its origin for the cache key). nil in native windows.
@property (nonatomic, readonly, strong, nullable) id<SBAXNode> webAreaNode;
/// Hash of the value-field signatures: the cache key part that identifies "this form".
@property (nonatomic, readonly, copy) NSString *formSignature;
/// The node a field was built from (the group node for radio groups). nil for unknown signatures.
- (nullable id<SBAXNode>)nodeForSignature:(NSString *)signature;
/// Radio groups only: option label -> the radio button node.
- (nullable id<SBAXNode>)radioNodeForSignature:(NSString *)signature optionLabel:(NSString *)label;
/// `file` fields only: the page's real file input (AXFileUploadButton). nodeForSignature is its "Attach" button.
- (nullable id<SBAXNode>)uploadNodeForSignature:(NSString *)signature;
@end

@interface SBCapture : NSObject

- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithSafety:(id<SBSafetyChecking>)safety NS_DESIGNATED_INITIALIZER;

@property (nonatomic, copy) SBCaptureLimits *limits;

/// Monotonic seconds. Tests inject a fake clock to exercise the time budget.
@property (nonatomic, copy) NSTimeInterval (^clock)(void);

/// docs/desktop.md says off-window elements are skipped, and that is the default (NO). With YES, a field
/// scrolled out of view is kept when it still lies inside its web area's document box and within the
/// window's horizontal extent (so honeypots parked at -9999px stay out). The rect tells the caller
/// whether the field is on screen right now; nothing off screen may ever be written to.
@property (nonatomic) BOOL keepsScrolledOutFields;

/// Chromium (and Electron) report NO frame at all for content that is scrolled out of the viewport, where WebKit
/// still reports the real off-screen rectangle. With the default NO a Chromium page therefore loses every field
/// below the fold to the zero-size rule -- on the real Greenhouse posting in Chrome that was the entire application
/// form, captured as 13 stray fields instead of 31. With YES (and only together with keepsScrolledOutFields) a
/// frameless node inside a web area is kept as a scrolled-out field instead of being dropped as a hidden one. That
/// is safe in a Chromium tree specifically, because Chromium leaves display:none / visibility:hidden / aria-hidden
/// elements OUT of the accessibility tree altogether, so a node that is there but has no box is real content that
/// merely is not on screen. Its rect stays empty until something scrolls it into view, and an empty rect is never
/// on screen, so it still can never be written to or drawn.
@property (nonatomic) BOOL treatsFramelessWebNodesAsScrolledOut;

/// docs/anywhere.md: a button or link with NO readable name anywhere in the tree (a player's fullscreen glyph, a
/// cart icon, a kebab) is dropped by default, because the form walk can do nothing with it. With YES such a
/// control is kept when it is drawn at a clickable size, marked `unnamed`, and carries its AXDescription and DOM
/// class tokens so the affordance layer can read icon words and the vision fallback can name the rest. An
/// unnamed control never gets a value ghost: the core needs a label to map a fact to a field.
@property (nonatomic) BOOL capturesUnnamedControls;

/// `window` is normally the focused AXWindow. Any node works (tests pass a web area or a group).
- (SBCaptureResult *)captureWindow:(id<SBAXNode>)window;

/// Options of a select whose menu is only materialized once it is open (called lazily by the writer).
- (NSArray<NSDictionary<NSString *, NSString *> *> *)optionsForSelectNode:(id<SBAXNode>)node;

/// Fresh safety check of one live node right before a write: secure role, naming sources, identifier.
- (BOOL)isNodeSensitive:(id<SBAXNode>)node;

// Pure helpers, exposed for tests and for the controller.
+ (nullable NSString *)kindForRole:(nullable NSString *)role subrole:(nullable NSString *)subrole;
+ (NSString *)cleanLabel:(nullable NSString *)raw;
+ (NSString *)normalizedLabel:(nullable NSString *)label;
+ (NSArray<SBField *> *)fieldsInReadingOrder:(NSArray<SBField *> *)fields;
+ (BOOL)nativeLooksSensitive:(nullable NSString *)text;
+ (BOOL)nativeLooksLocked:(nullable NSString *)text;

@end

NS_ASSUME_NONNULL_END
