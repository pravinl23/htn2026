// GHOpenPanelDriver: attach a local file through a page's upload control and the macOS open panel, without the
// mouse (docs/desktop-realworld.md, "File-upload target contract").
//
//   pressUpload          AXPress on the page's upload button (injected actuator). A panel that was already open
//                        before the press is not ours: abort without touching anything.
//   waitForPanel         up to 3 s: an AXSheet, or an AXWindow with subrole AXDialog, in the frontmost app that holds
//                        a default button titled Open / Choose / Upload
//   openGoTo             Command+Shift+G, only while focus is inside that panel
//   waitForGoToField     the focused element becomes a text field inside the panel
//   typePath             the path, only while the focused element IS that field; then the field must read back the
//                        exact path
//   confirmGoTo          Return, only while focus is that field, it holds the exact path and the panel is there
//   waitForGoToDismissed the field loses focus and the Open button is enabled (or the panel already closed)
//   confirmOpen          Return, only while the panel is still there, focus is inside it and Open is enabled
//   waitForPanelClosed   up to 3 s
//   verifyOnPage         the page shows the file name (default: any text in the app's windows mentions it)
//   done
//
// Abort rules:
//   - An untagged key event from the user at any point aborts at once (-noteUserKeyEvent, thread safe; checked
//     before every poll and inside every key guard). Nothing more is posted after that.
//   - A different frontmost app aborts; nothing is ever typed or pressed into another app.
//   - On a TIMEOUT (and when the go-to field did not take the exact path) one Escape is posted, only if the panel
//     is still open, was opened by this run, and focus is inside it. Never a second one.
//   - Every Return goes through GHKeyPoster, alone in its burst, behind a guard that re-reads focus and the panel.
//
// The path must be absolute, exist, be readable, be a regular file (not a link, not a folder) under 25 MB, and hold
// no control character. Only the file name ever reaches the HUD; the log carries states and reason codes only.
#import <Foundation/Foundation.h>
#import "GHAXNode.h"
#import "GHKeyPoster.h"
#import "GHWriter.h"

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, GHOpenPanelState) {
    GHOpenPanelStateIdle = 0,
    GHOpenPanelStatePressUpload,
    GHOpenPanelStateWaitForPanel,
    GHOpenPanelStateOpenGoTo,
    GHOpenPanelStateWaitForGoToField,
    GHOpenPanelStateTypePath,
    GHOpenPanelStateConfirmGoTo,
    GHOpenPanelStateWaitForGoToDismissed,
    GHOpenPanelStateConfirmOpen,
    GHOpenPanelStateWaitForPanelClosed,
    GHOpenPanelStateVerifyOnPage,
    GHOpenPanelStateDone,
    GHOpenPanelStateFailed,
};

NSString *GHOpenPanelStateName(GHOpenPanelState state);

extern const unsigned long long GHOpenPanelMaxFileBytes;   // 25 MB
/// Wall clock for one search inside the panel or the page (the node caps still apply): a huge page or a hung app
/// cannot hold the main thread for longer than this plus one AX timeout.
extern const NSTimeInterval GHOpenPanelWalkSeconds;       // 0.15
/// Wall clock for one "does the page name the file" check (finding the web areas and searching them together).
extern const NSTimeInterval GHOpenPanelPageCheckSeconds;  // 0.25

// Reason codes (short, never content).
extern NSString *const GHOpenPanelReasonBusy;
extern NSString *const GHOpenPanelReasonInvalidPath;       // + ":" + a GHUploadPath* code
extern NSString *const GHOpenPanelReasonNoUploadTarget;
extern NSString *const GHOpenPanelReasonNoFrontmostApp;
extern NSString *const GHOpenPanelReasonPanelAlreadyOpen;
extern NSString *const GHOpenPanelReasonAlreadyShown;     // the page named the file before anything was pressed
extern NSString *const GHOpenPanelReasonPressFailed;
extern NSString *const GHOpenPanelReasonPanelTimeout;
extern NSString *const GHOpenPanelReasonFocusNotInPanel;
extern NSString *const GHOpenPanelReasonGoToTimeout;
extern NSString *const GHOpenPanelReasonGoToFieldBusy;     // it held text that could not be selected
extern NSString *const GHOpenPanelReasonFocusChanged;
extern NSString *const GHOpenPanelReasonPathMismatch;
extern NSString *const GHOpenPanelReasonGoToDismissTimeout;
extern NSString *const GHOpenPanelReasonPanelCloseTimeout;
extern NSString *const GHOpenPanelReasonFilenameNotShown;
extern NSString *const GHOpenPanelReasonAppChanged;
extern NSString *const GHOpenPanelReasonUserKey;
extern NSString *const GHOpenPanelReasonCancelled;
extern NSString *const GHOpenPanelReasonKeysRefused;        // the poster could not post (post-failed)

// Path problems (GHOpenPanelDriver +problemWithUploadPath:).
extern NSString *const GHUploadPathNotAbsolute;
extern NSString *const GHUploadPathControlCharacter;
extern NSString *const GHUploadPathMissing;
extern NSString *const GHUploadPathNotRegularFile;
extern NSString *const GHUploadPathUnreadable;
extern NSString *const GHUploadPathTooLarge;
extern NSString *const GHUploadPathEmpty;

@interface GHOpenPanelResult : NSObject
@property (nonatomic, readonly) BOOL ok;
@property (nonatomic, readonly, copy, nullable) NSString *reason;
/// The state the run was in when it finished (GHOpenPanelStateDone when ok).
@property (nonatomic, readonly) GHOpenPanelState finalState;
@property (nonatomic, readonly, copy) NSString *filename;
/// The one Escape of a timeout went out.
@property (nonatomic, readonly) BOOL pressedEscape;
/// The panel this run opened was still on screen when it finished.
@property (nonatomic, readonly) BOOL panelLeftOpen;
/// The page was seen showing the file name.
@property (nonatomic, readonly) BOOL verifiedOnPage;
@property (nonatomic, readonly) NSTimeInterval elapsed;
@end

@interface GHOpenPanelDriver : NSObject

- (instancetype)init NS_UNAVAILABLE;
/// `actuator` presses the upload button and selects text in the go-to field; `poster` is the only keyboard;
/// `state` answers frontmost app, focus and the app's windows, fresh on every call.
- (instancetype)initWithActuator:(id<GHAXActuating>)actuator poster:(id<GHKeyPosting>)poster state:(id<GHDesktopState>)state NS_DESIGNATED_INITIALIZER;

@property (nonatomic, readonly) id<GHAXActuating> actuator;
@property (nonatomic, readonly) id<GHKeyPosting> poster;
@property (nonatomic, readonly) id<GHDesktopState> state;

/// Default: dispatch_after on the main queue. Tests run it by hand.
@property (nonatomic, copy) void (^after)(NSTimeInterval delay, dispatch_block_t block);
/// Seconds, monotonic. Default: CACurrentMediaTime-like uptime clock.
@property (nonatomic, copy) NSTimeInterval (^clock)(void);
@property (nonatomic) NSTimeInterval pollInterval;          // 0.1
@property (nonatomic) NSTimeInterval panelTimeout;          // 3
@property (nonatomic) NSTimeInterval goToFieldTimeout;      // 2
@property (nonatomic) NSTimeInterval typeSettleDelay;       // 0.15: typing -> read-back
@property (nonatomic) NSTimeInterval goToDismissTimeout;    // 2
@property (nonatomic) NSTimeInterval panelCloseTimeout;     // 3
@property (nonatomic) NSTimeInterval pageTimeout;           // 3
/// Does the page show `filename` now? Default: a bounded search of the web content (AXWebArea) of the frontmost app's
/// windows for text that contains it (AXStaticText value, titles, descriptions); the whole window only when it holds
/// no web area. Browser chrome (tab titles are private) is never read.
@property (nonatomic, copy, null_resettable) BOOL (^pageShowsFilename)(NSString *filename, pid_t pid);
/// HUD lines on the main queue: "Opening the file picker", "Picking resume-alex-chen.pdf", "Attached ...".
@property (nonatomic, copy, nullable) void (^progress)(GHOpenPanelState state, NSString *message);

@property (nonatomic, readonly) GHOpenPanelState currentState;
@property (nonatomic, readonly) BOOL running;

/// Runs the whole sequence. `completion` runs exactly once, on the queue `after` uses (or inline for refusals).
- (void)attachFileAtPath:(NSString *)path
            uploadButton:(id<GHAXNode>)uploadButton
              completion:(void (^)(GHOpenPanelResult *result))completion;

/// The event tap calls this for every UNTAGGED keyDown (the user's keys; Ghost's own carry
/// GHSyntheticEventUserData and must not be reported). Any thread. Ignored while not running.
- (void)noteUserKeyEvent;
/// Stops without posting anything. The completion reports "cancelled".
- (void)cancel;

// ---------- pure, exposed for tests ----------
/// nil when the path is fine, else a GHUploadPath* code.
+ (nullable NSString *)problemWithUploadPath:(nullable NSString *)path;
/// AXButton with subrole AXFileUploadButton, or an AXButton titled like "Attach" / "Upload" / "Choose file" /
/// "Browse". Never a cloud picker ("Dropbox", "Google Drive"), "Enter manually", or anything that submits.
+ (BOOL)isUploadButton:(nullable id<GHAXNode>)node;
/// The upload button inside an upload group (Greenhouse "Resume/CV"): the AXFileUploadButton first, else "Attach".
+ (nullable id<GHAXNode>)uploadButtonInGroup:(id<GHAXNode>)group;
/// The open panel among `windows`: an AXSheet (child or grandchild of a window, never inside web content) or an
/// AXWindow with subrole AXDialog, holding a button titled Open / Choose / Upload.
+ (nullable id<GHAXNode>)openPanelInWindows:(NSArray<id<GHAXNode>> *)windows;
+ (nullable id<GHAXNode>)defaultButtonOfPanel:(id<GHAXNode>)panel;
/// `node` or one of its AX parents (up to 64 levels) is `ancestor`.
+ (BOOL)node:(nullable id<GHAXNode>)node isInside:(nullable id<GHAXNode>)ancestor;
/// A text field that can be the go-to field: AXTextField / AXComboBox, not a search or secure field.
+ (BOOL)isGoToFieldCandidate:(nullable id<GHAXNode>)node;
/// Bounded search of `roots` for text that contains `filename` (case-insensitive).
+ (BOOL)nodes:(NSArray<id<GHAXNode>> *)roots mentionFilename:(NSString *)filename;
/// The AXWebAreas inside `windows` (bounded breadth-first search, not looking inside a web area).
+ (NSArray<id<GHAXNode>> *)webAreasInWindows:(NSArray<id<GHAXNode>> *)windows;
/// The default page check: the web areas of `windows` (else the windows themselves) name `filename`, within one
/// GHOpenPanelPageCheckSeconds budget; a hung app answers NO.
+ (BOOL)windows:(NSArray<id<GHAXNode>> *)windows showFilename:(NSString *)filename;

@end

NS_ASSUME_NONNULL_END
