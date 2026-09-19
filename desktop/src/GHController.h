// GHController: capture -> predict -> walk -> overlay + writer, for whatever window is in front.
// The native twin of extension/src/content/controller.ts; the walk itself lives in GHWalkState (pure).
//
//   AX notifications (debounced by GHAccessibility)
//     -> capture the focused window (GHCapture)
//     -> offline ghosts from GhostCore at once (0 network)
//     -> per-window cache, then ONE /v1/predict/form per form signature (never per rescan); the answer
//        upgrades the list without disturbing the ghost the user is on
//     -> free-text drafts for `needs_text` fields over SSE, at most 3 at a time, generated ahead of the walk; text
//        areas and long questions get the posting's company / role / description (GHPageContext)
//     -> GHOverlayWindow render, GHEventTap snapshot
//   Tab (consumed by GHEventTap) -> GHWriter -> verify -> advance, or stop the walk and say why.
//     - upload ghost: ONE Tab presses Attach and drives the open panel (GHOpenPanelDriver, HUD "Picking <file>");
//       afterwards a fresh capture must show the file name (or a new Remove control) in the upload widget
//     - lazy select: GHComboBoxDriver chooses a real option and verifies it; "skipped" leaves the field alone
//     - the current ghost is off screen: AXScrollToVisible first (the desktop jump: Tab with focus on the page
//       scrolls it into view and writes nothing); after every accept the next ghost is scrolled into view
//     - hold-Tab never starts an upload / combobox sequence and never accepts a pending draft: it stops there
//     - every untagged key-down (GHEventTap.userKeyObserver) aborts a sequence in flight
//
// Nothing runs while Ghost is disabled, the process is untrusted, the frontmost app is paused (built-in list,
// the user's list) or a browser's own extension is active there. Main thread only. Values are never logged.
#import <Foundation/Foundation.h>
#import "GHAppDelegate.h"
#import "GHAccessibility.h"
#import "GHEventTap.h"
#import "GHServerClient.h"
#import "GHWalkState.h"

@class GHCore, GHProfileStore, GHOverlayWindow, GHWriter, GHCapture, GHCaptureResult, GHField;

NS_ASSUME_NONNULL_BEGIN

/// Posted on the main queue when -statusLine changed (the menu-bar tooltip follows it).
extern NSNotificationName const GHControllerStateDidChangeNotification;

extern const NSTimeInterval GHDraftWaitSeconds;       // 4 s: how long a Tab waits for a draft that is still streaming
extern const NSUInteger GHMaxConcurrentDrafts;        // 3

@interface GHController : NSObject <GHDesktopPipeline, GHAccessibilityDelegate, GHEventTapDelegate, GHGhostTextStreamDelegate>

- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithCore:(GHCore *)core store:(GHProfileStore *)store client:(nullable GHServerClient *)client NS_DESIGNATED_INITIALIZER;

// Parts. Created on demand by -start; tests inject fakes BEFORE using the controller.
@property (nonatomic, strong) GHAccessibility *accessibility;
@property (nonatomic, strong) GHCapture *capture;
@property (nonatomic, strong) GHEventTap *eventTap;
@property (nonatomic, strong) GHWriter *writer;
@property (nonatomic, strong, nullable) GHOverlayWindow *overlay;

@property (nonatomic, readonly) GHWalkState *walk;
@property (nonatomic, readonly) BOOL running;
/// A write (or the wait for a draft) is in flight.
@property (nonatomic, readonly) BOOL busy;
/// Enabled, trusted, frontmost app neither paused nor handled by its extension.
@property (nonatomic, readonly) BOOL active;
/// The current ghost is drawn on screen (from the last render).
@property (nonatomic, readonly) BOOL currentVisible;
/// "offline-heuristic", or the provider of the last cache/server answer.
@property (nonatomic, readonly, copy) NSString *provider;
/// How many /v1/predict/form questions this page asked (cache hits included): never more than one per form.
@property (nonatomic, readonly) NSUInteger predictionRequests;
@property (nonatomic, readonly) NSUInteger activeDraftCount;

- (void)start;
- (void)stop;
- (NSString *)statusLine;
- (void)presenceDidChange:(nullable GHPresence *)presence;

// ---------- seams (the live path calls exactly these) ----------
/// Tests: skip the trust / pause / presence gate (there is no live AX in the test runner).
@property (nonatomic) BOOL assumesActive;
/// A fresh capture of the window in front (upload check, the rescan after a walk step). nil = the live
/// GHAccessibility capture while running. Tests hand in the fake window's capture.
@property (nonatomic, copy, nullable) GHCaptureResult *_Nullable (^captureProvider)(void);
/// Waits `delay` seconds and runs the block on the main queue (the upload check, which is repeated while the page
/// finishes the upload). nil = dispatch_after; tests hand in their own clock.
@property (nonatomic, copy, nullable) void (^after)(NSTimeInterval delay, dispatch_block_t block);
/// Gives a consumed Tab back to the app (a stale snapshot, a jump the page refused). nil = a tagged synthetic Tab
/// (GHEventTap +postKeyCode:), and only while the controller runs live (-start, trusted AX): a controller driven by
/// tests posts nothing. Tests record it here.
@property (nonatomic, copy, nullable) void (^tabHandBack)(void);
/// Where keyboard focus is right now (nil = the window itself), read before every step of a walk and before focus is
/// moved on after a write. nil block = the live GHAccessibility read while running (a failed read counts as "focus is
/// somewhere else"). Tests hand in their fake focus here.
@property (nonatomic, copy, nullable) id<GHAXNode> _Nullable (^focusedNodeProvider)(void);
/// The HUD's progress line ("Picking resume-alex-chen.pdf", "Attached ..."); nil when there is none.
@property (nonatomic, readonly, copy, nullable) NSString *hudStatus;
/// One rescan's worth of work on an already captured window. `pageKey` names the page (a new key forgets the
/// walk); `origin` is the cache key part from GHServerClient.
- (void)adoptCaptureResult:(nullable GHCaptureResult *)result pageKey:(NSString *)pageKey origin:(NSString *)origin;
/// Where keyboard focus is now (nil = the window itself). Rule 7: a ghosted field becomes current.
- (void)noteFocusedNode:(nullable id<GHAXNode>)node;
/// nil for the window itself, GHWalkFocusElsewhere, or the signature of the captured field behind `node`.
- (nullable NSString *)focusSignatureForNode:(nullable id<GHAXNode>)node;

// ---------- harness (GHHarness --autotab reads these; labels and short codes only, never a value) ----------
/// How many consumed Tabs the walk has finished handling, whatever the outcome.
@property (nonatomic, readonly) NSUInteger stepCount;
/// The last of them: { label, action, outcome, verified, reason?, ms }. `outcome` is accepted | parked | refused |
/// failed | gone | handed-back | focus-left | jumped | not-visible | needs-press | draft-not-ready | inactive; `reason`
/// is a GHWriteReason code. `jumped` = scrolled into view, nothing written; `needs-press` = a hold reached an upload or
/// combobox ghost, which only a fresh press starts; `focus-left` = a queued, held or delayed step found focus outside
/// the walk and was dropped (never handed back, nothing written).
@property (nonatomic, readonly, copy, nullable) NSDictionary<NSString *, id> *lastStep;
/// { running, active, busy, ghosts, unlocked, accepted, provider, statusLine, status?, current?: { label, action, locked, pending, visible } }
- (NSDictionary<NSString *, id> *)harnessState;

// ---------- pure helpers ----------
/// A text area, or a text field whose label is a real question (6+ words, or a question of 3+ words).
+ (BOOL)isLongQuestionField:(GHField *)field;
/// The `pageContext` of a /v1/ghost-text draft: company, role and the posting's description for text areas and long
/// questions (when `page` knows them), else only the field's own section context.
+ (NSDictionary<NSString *, NSString *> *)draftContextForField:(GHField *)field page:(nullable NSDictionary<NSString *, NSString *> *)page;

@end

NS_ASSUME_NONNULL_END
