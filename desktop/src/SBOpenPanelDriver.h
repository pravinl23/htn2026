// SBOpenPanelDriver: attach a local file through a page's upload control and the macOS open panel, without the
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
//   - Every Return goes through SBKeyPoster, alone in its burst, behind a guard that re-reads focus and the panel.
//
// The path must be absolute, exist, be readable, be a regular file (not a link, not a folder) under 25 MB, and hold
// no control character. Only the file name ever reaches the HUD; the log carries states and reason codes only.
#import <Foundation/Foundation.h>
#import "SBAXNode.h"
#import "SBKeyPoster.h"
#import "SBWriter.h"

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, SBOpenPanelState) {
    SBOpenPanelStateIdle = 0,
    SBOpenPanelStatePressUpload,
    SBOpenPanelStateWaitForPanel,
    SBOpenPanelStateOpenGoTo,
    SBOpenPanelStateWaitForGoToField,
    SBOpenPanelStateTypePath,
    SBOpenPanelStateConfirmGoTo,
    SBOpenPanelStateWaitForGoToDismissed,
    SBOpenPanelStateConfirmOpen,
    SBOpenPanelStateWaitForPanelClosed,
    SBOpenPanelStateVerifyOnPage,
    SBOpenPanelStateDone,
    SBOpenPanelStateFailed,
};

NSString *SBOpenPanelStateName(SBOpenPanelState state);

extern const unsigned long long SBOpenPanelMaxFileBytes;   // 25 MB
/// Wall clock for one search inside the panel or the page (the node caps still apply): a huge page or a hung app
/// cannot hold the main thread for longer than this plus one AX timeout.
extern const NSTimeInterval SBOpenPanelWalkSeconds;       // 0.15
/// Wall clock for one "does the page name the file" check (finding the web areas and searching them together).
extern const NSTimeInterval SBOpenPanelPageCheckSeconds;  // 0.25

// Reason codes (short, never content).
extern NSString *const SBOpenPanelReasonBusy;
extern NSString *const SBOpenPanelReasonInvalidPath;       // + ":" + a SBUploadPath* code
extern NSString *const SBOpenPanelReasonNoUploadTarget;
extern NSString *const SBOpenPanelReasonNoFrontmostApp;
extern NSString *const SBOpenPanelReasonPanelAlreadyOpen;
extern NSString *const SBOpenPanelReasonAlreadyShown;     // the page named the file before anything was pressed
extern NSString *const SBOpenPanelReasonPressFailed;
extern NSString *const SBOpenPanelReasonPanelTimeout;
extern NSString *const SBOpenPanelReasonFocusNotInPanel;
extern NSString *const SBOpenPanelReasonGoToTimeout;
extern NSString *const SBOpenPanelReasonGoToFieldBusy;     // it held text that could not be selected
extern NSString *const SBOpenPanelReasonFocusChanged;
extern NSString *const SBOpenPanelReasonPathMismatch;
extern NSString *const SBOpenPanelReasonGoToDismissTimeout;
extern NSString *const SBOpenPanelReasonPanelCloseTimeout;
extern NSString *const SBOpenPanelReasonFilenameNotShown;
extern NSString *const SBOpenPanelReasonAppChanged;
extern NSString *const SBOpenPanelReasonUserKey;
extern NSString *const SBOpenPanelReasonCancelled;
extern NSString *const SBOpenPanelReasonKeysRefused;        // the poster could not post (post-failed)

// Path problems (SBOpenPanelDriver +problemWithUploadPath:).
extern NSString *const SBUploadPathNotAbsolute;
extern NSString *const SBUploadPathControlCharacter;
extern NSString *const SBUploadPathMissing;
extern NSString *const SBUploadPathNotRegularFile;
extern NSString *const SBUploadPathUnreadable;
extern NSString *const SBUploadPathTooLarge;
extern NSString *const SBUploadPathEmpty;

@interface SBOpenPanelResult : NSObject
@property (nonatomic, readonly) BOOL ok;
@property (nonatomic, readonly, copy, nullable) NSString *reason;
/// The state the run was in when it finished (SBOpenPanelStateDone when ok).
@property (nonatomic, readonly) SBOpenPanelState finalState;
@property (nonatomic, readonly, copy) NSString *filename;
/// The one Escape of a timeout went out.
@property (nonatomic, readonly) BOOL pressedEscape;
/// The panel this run opened was still on screen when it finished.
@property (nonatomic, readonly) BOOL panelLeftOpen;
/// The page was seen showing the file name.
@property (nonatomic, readonly) BOOL verifiedOnPage;
@property (nonatomic, readonly) NSTimeInterval elapsed;
@end

@interface SBOpenPanelDriver : NSObject

- (instancetype)init NS_UNAVAILABLE;
/// `actuator` presses the upload button and selects text in the go-to field; `poster` is the only keyboard;
/// `state` answers frontmost app, focus and the app's windows, fresh on every call.
- (instancetype)initWithActuator:(id<SBAXActuating>)actuator poster:(id<SBKeyPosting>)poster state:(id<SBDesktopState>)state NS_DESIGNATED_INITIALIZER;

@property (nonatomic, readonly) id<SBAXActuating> actuator;
@property (nonatomic, readonly) id<SBKeyPosting> poster;
@property (nonatomic, readonly) id<SBDesktopState> state;

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
@property (nonatomic, copy, nullable) void (^progress)(SBOpenPanelState state, NSString *message);

@property (nonatomic, readonly) SBOpenPanelState currentState;
@property (nonatomic, readonly) BOOL running;

/// Runs the whole sequence. `completion` runs exactly once, on the queue `after` uses (or inline for refusals).
- (void)attachFileAtPath:(NSString *)path
            uploadButton:(id<SBAXNode>)uploadButton
              completion:(void (^)(SBOpenPanelResult *result))completion;

/// The event tap calls this for every UNTAGGED keyDown (the user's keys; Shabang's own carry
/// SBSyntheticEventUserData and must not be reported). Any thread. Ignored while not running.
- (void)noteUserKeyEvent;
/// Stops without posting anything. The completion reports "cancelled".
- (void)cancel;

// ---------- pure, exposed for tests ----------
/// nil when the path is fine, else a SBUploadPath* code.
+ (nullable NSString *)problemWithUploadPath:(nullable NSString *)path;
/// AXButton with subrole AXFileUploadButton, or an AXButton titled like "Attach" / "Upload" / "Choose file" /
/// "Browse". Never a cloud picker ("Dropbox", "Google Drive"), "Enter manually", or anything that submits.
+ (BOOL)isUploadButton:(nullable id<SBAXNode>)node;
/// The upload button inside an upload group (Greenhouse "Resume/CV"): the AXFileUploadButton first, else "Attach".
+ (nullable id<SBAXNode>)uploadButtonInGroup:(id<SBAXNode>)group;
/// The open panel among `windows`: an AXSheet (child or grandchild of a window, never inside web content) or an
/// AXWindow with subrole AXDialog, holding a button titled Open / Choose / Upload.
+ (nullable id<SBAXNode>)openPanelInWindows:(NSArray<id<SBAXNode>> *)windows;
+ (nullable id<SBAXNode>)defaultButtonOfPanel:(id<SBAXNode>)panel;
/// `node` or one of its AX parents (up to 64 levels) is `ancestor`.
+ (BOOL)node:(nullable id<SBAXNode>)node isInside:(nullable id<SBAXNode>)ancestor;
/// A text field that can be the go-to field: AXTextField / AXComboBox, not a search or secure field.
+ (BOOL)isGoToFieldCandidate:(nullable id<SBAXNode>)node;
/// Bounded search of `roots` for text that contains `filename` (case-insensitive).
+ (BOOL)nodes:(NSArray<id<SBAXNode>> *)roots mentionFilename:(NSString *)filename;
/// The AXWebAreas inside `windows` (bounded breadth-first search, not looking inside a web area).
+ (NSArray<id<SBAXNode>> *)webAreasInWindows:(NSArray<id<SBAXNode>> *)windows;
/// The default page check: the web areas of `windows` (else the windows themselves) name `filename`, within one
/// SBOpenPanelPageCheckSeconds budget; a hung app answers NO.
+ (BOOL)windows:(NSArray<id<SBAXNode>> *)windows showFilename:(NSString *)filename;

@end

NS_ASSUME_NONNULL_END
