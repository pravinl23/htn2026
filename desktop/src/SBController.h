// SBController: capture -> predict -> walk -> overlay + writer, for whatever window is in front.
// The native twin of extension/src/content/controller.ts; the walk itself lives in SBWalkState (pure).
//
//   AX notifications (debounced by SBAccessibility)
//     -> capture the focused window (SBCapture)
//     -> offline ghosts from GhostCore at once (0 network)
//     -> per-window cache, then ONE /v1/predict/form per form signature (never per rescan); the answer
//        upgrades the list without disturbing the ghost the user is on
//     -> free-text drafts for `needs_text` fields over SSE, at most 3 at a time, generated ahead of the walk; text
//        areas and long questions get the posting's company / role / description (SBPageContext)
//     -> SBOverlayWindow render, SBEventTap snapshot
//   Tab (consumed by SBEventTap) -> SBWriter -> verify -> advance, or stop the walk and say why.
//     - upload ghost: ONE Tab presses Attach and drives the open panel (SBOpenPanelDriver, HUD "Picking <file>");
//       afterwards a fresh capture must show the file name (or a new Remove control) in the upload widget
//     - lazy select: SBComboBoxDriver chooses a real option and verifies it; "skipped" leaves the field alone
//     - the current ghost is off screen: AXScrollToVisible first (the desktop jump: Tab with focus on the page
//       scrolls it into view and writes nothing); after every accept the next ghost is scrolled into view
//     - hold-Tab never starts an upload / combobox sequence and never accepts a pending draft: it stops there
//     - every untagged key-down (SBEventTap.userKeyObserver) aborts a sequence in flight
//
// Nothing runs while Shabang is disabled, the process is untrusted, the frontmost app is paused (built-in list,
// the user's list) or a browser's own extension is active there. Main thread only. Values are never logged.
#import <Foundation/Foundation.h>
#import "SBAppDelegate.h"
#import "SBAccessibility.h"
#import "SBEventTap.h"
#import "SBServerClient.h"
#import "SBWalkState.h"

@class SBCore, SBProfileStore, SBOverlayWindow, SBWriter, SBCapture, SBCaptureResult, SBField, SBVision;

NS_ASSUME_NONNULL_BEGIN

/// Posted on the main queue when -statusLine changed (the menu-bar tooltip follows it).
extern NSNotificationName const SBControllerStateDidChangeNotification;

extern const NSTimeInterval SBDraftWaitSeconds;       // 4 s: how long a Tab waits for a draft that is still streaming
extern const NSUInteger SBMaxConcurrentDrafts;        // 3

/// What a next-action proposal shows: the control's own name, but only where that name is an ACTION
/// ("Play", "Cart"). A box you interact with by value gets nothing -- its name is its placeholder, and
/// echoing it back reads as "type this". Pure; exposed for tests.
NSString *SBProposalDisplayText(SBField *field);

@interface SBController : NSObject <SBDesktopPipeline, SBAccessibilityDelegate, SBEventTapDelegate, SBGhostTextStreamDelegate>

- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithCore:(SBCore *)core store:(SBProfileStore *)store client:(nullable SBServerClient *)client NS_DESIGNATED_INITIALIZER;

// Parts. Created on demand by -start; tests inject fakes BEFORE using the controller.
@property (nonatomic, strong) SBAccessibility *accessibility;
@property (nonatomic, strong) SBCapture *capture;
@property (nonatomic, strong) SBEventTap *eventTap;
@property (nonatomic, strong) SBWriter *writer;
@property (nonatomic, strong, nullable) SBOverlayWindow *overlay;
/// The eyes (docs/anywhere.md section 4): names the controls nothing in the tree could name. Built on first
/// use; a test injects one with a stub transport and a stub screenshot.
@property (nonatomic, strong, nullable) SBVision *vision;

@property (nonatomic, readonly) SBWalkState *walk;
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
- (void)presenceDidChange:(nullable SBPresence *)presence;

// ---------- seams (the live path calls exactly these) ----------
/// Tests: skip the trust / pause / presence gate (there is no live AX in the test runner).
@property (nonatomic) BOOL assumesActive;
/// A fresh capture of the window in front (upload check, the rescan after a walk step). nil = the live
/// SBAccessibility capture while running. Tests hand in the fake window's capture.
@property (nonatomic, copy, nullable) SBCaptureResult *_Nullable (^captureProvider)(void);
/// Waits `delay` seconds and runs the block on the main queue (the upload check, which is repeated while the page
/// finishes the upload). nil = dispatch_after; tests hand in their own clock.
@property (nonatomic, copy, nullable) void (^after)(NSTimeInterval delay, dispatch_block_t block);
/// Gives a consumed Tab back to the app (a stale snapshot, a jump the page refused). nil = a tagged synthetic Tab
/// (SBEventTap +postKeyCode:), and only while the controller runs live (-start, trusted AX): a controller driven by
/// tests posts nothing. Tests record it here.
@property (nonatomic, copy, nullable) void (^tabHandBack)(void);
/// Where keyboard focus is right now (nil = the window itself), read before every step of a walk and before focus is
/// moved on after a write. nil block = the live SBAccessibility read while running (a failed read counts as "focus is
/// somewhere else"). Tests hand in their fake focus here.
@property (nonatomic, copy, nullable) id<SBAXNode> _Nullable (^focusedNodeProvider)(void);
/// The HUD's progress line ("Picking resume-alex-chen.pdf", "Attached ..."); nil when there is none.
@property (nonatomic, readonly, copy, nullable) NSString *hudStatus;
/// One rescan's worth of work on an already captured window. `pageKey` names the page (a new key forgets the
/// walk); `origin` is the cache key part from SBServerClient.
- (void)adoptCaptureResult:(nullable SBCaptureResult *)result pageKey:(NSString *)pageKey origin:(NSString *)origin;
/// Where keyboard focus is now (nil = the window itself). Rule 7: a ghosted field becomes current.
- (void)noteFocusedNode:(nullable id<SBAXNode>)node;
/// nil for the window itself, SBWalkFocusElsewhere, or the signature of the captured field behind `node`.
- (nullable NSString *)focusSignatureForNode:(nullable id<SBAXNode>)node;

// ---------- harness (SBHarness --autotab reads these; labels and short codes only, never a value) ----------
/// How many consumed Tabs the walk has finished handling, whatever the outcome.
@property (nonatomic, readonly) NSUInteger stepCount;
/// The last of them: { label, action, outcome, verified, reason?, ms }. `outcome` is accepted | parked | refused |
/// failed | gone | handed-back | focus-left | jumped | not-visible | needs-press | draft-not-ready | inactive; `reason`
/// is a SBWriteReason code. `jumped` = scrolled into view, nothing written; `needs-press` = a hold reached an upload or
/// combobox ghost, which only a fresh press starts; `focus-left` = a queued, held or delayed step found focus outside
/// the walk and was dropped (never handed back, nothing written).
@property (nonatomic, readonly, copy, nullable) NSDictionary<NSString *, id> *lastStep;
/// { running, active, busy, ghosts, unlocked, accepted, provider, statusLine, status?, current?: { label, action, locked, pending, visible } }
- (NSDictionary<NSString *, id> *)harnessState;

// ---------- pure helpers ----------
/// A text area, or a text field whose label is a real question (6+ words, or a question of 3+ words).
+ (BOOL)isLongQuestionField:(SBField *)field;
/// The `pageContext` of a /v1/shabang-text draft: company, role and the posting's description for text areas and long
/// questions (when `page` knows them), else only the field's own section context.
+ (NSDictionary<NSString *, NSString *> *)draftContextForField:(SBField *)field page:(nullable NSDictionary<NSString *, NSString *> *)page;

@end

NS_ASSUME_NONNULL_END
