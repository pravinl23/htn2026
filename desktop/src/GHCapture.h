// GHCapture: turns the accessibility tree of one window into GHFields (the native twin of
// extension/src/content/capture.ts). Pure logic over GHAXNode, so it is tested with fake trees.
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
#import "GHAXNode.h"
#import "GHField.h"
#import "GHSafetyChecking.h"

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, GHCaptureStop) {
    GHCaptureStopNone = 0,   // the whole window was walked
    GHCaptureStopNodes,      // maxNodes reached
    GHCaptureStopTime,       // timeBudget used up
};

@interface GHCaptureLimits : NSObject <NSCopying>
@property (nonatomic) NSUInteger maxNodes;        // 1500
@property (nonatomic) NSUInteger maxDepth;        // 40 (children below it are not visited)
@property (nonatomic) NSTimeInterval timeBudget;  // 0.120 s
@property (nonatomic) NSUInteger maxLinks;        // 40: links never get a ghost, keep the state small
@property (nonatomic) NSUInteger maxOptions;      // 255: Jev's choice limit
+ (instancetype)defaultLimits;
@end

@interface GHCaptureResult : NSObject
/// Reading order: top to bottom, then left to right. Sensitive fields are absent.
@property (nonatomic, readonly, copy) NSArray<GHField *> *fields;
@property (nonatomic, readonly) NSUInteger visitedNodes;
@property (nonatomic, readonly) GHCaptureStop stop;
/// YES when the walk stopped early (nodes or time) or the depth bound hid part of the tree.
@property (nonatomic, readonly) BOOL partial;
@property (nonatomic, readonly) NSTimeInterval elapsed;
@property (nonatomic, readonly) CGRect windowFrame;
@property (nonatomic, readonly) BOOL sawWebArea;
/// First web area met by the walk (GHAccessibility reads its origin for the cache key). nil in native windows.
@property (nonatomic, readonly, strong, nullable) id<GHAXNode> webAreaNode;
/// Hash of the value-field signatures: the cache key part that identifies "this form".
@property (nonatomic, readonly, copy) NSString *formSignature;
/// The node a field was built from (the group node for radio groups). nil for unknown signatures.
- (nullable id<GHAXNode>)nodeForSignature:(NSString *)signature;
/// Radio groups only: option label -> the radio button node.
- (nullable id<GHAXNode>)radioNodeForSignature:(NSString *)signature optionLabel:(NSString *)label;
/// `file` fields only: the page's real file input (AXFileUploadButton). nodeForSignature is its "Attach" button.
- (nullable id<GHAXNode>)uploadNodeForSignature:(NSString *)signature;
@end

@interface GHCapture : NSObject

- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithSafety:(id<GHSafetyChecking>)safety NS_DESIGNATED_INITIALIZER;

@property (nonatomic, copy) GHCaptureLimits *limits;

/// Monotonic seconds. Tests inject a fake clock to exercise the time budget.
@property (nonatomic, copy) NSTimeInterval (^clock)(void);

/// docs/desktop.md says off-window elements are skipped, and that is the default (NO). With YES, a field
/// scrolled out of view is kept when it still lies inside its web area's document box and within the
/// window's horizontal extent (so honeypots parked at -9999px stay out). The rect tells the caller
/// whether the field is on screen right now; nothing off screen may ever be written to.
@property (nonatomic) BOOL keepsScrolledOutFields;

/// `window` is normally the focused AXWindow. Any node works (tests pass a web area or a group).
- (GHCaptureResult *)captureWindow:(id<GHAXNode>)window;

/// Options of a select whose menu is only materialized once it is open (called lazily by the writer).
- (NSArray<NSDictionary<NSString *, NSString *> *> *)optionsForSelectNode:(id<GHAXNode>)node;

/// Fresh safety check of one live node right before a write: secure role, naming sources, identifier.
- (BOOL)isNodeSensitive:(id<GHAXNode>)node;

// Pure helpers, exposed for tests and for the controller.
+ (nullable NSString *)kindForRole:(nullable NSString *)role subrole:(nullable NSString *)subrole;
+ (NSString *)cleanLabel:(nullable NSString *)raw;
+ (NSString *)normalizedLabel:(nullable NSString *)label;
+ (NSArray<GHField *> *)fieldsInReadingOrder:(NSArray<GHField *> *)fields;
+ (BOOL)nativeLooksSensitive:(nullable NSString *)text;
+ (BOOL)nativeLooksLocked:(nullable NSString *)text;

@end

NS_ASSUME_NONNULL_END
