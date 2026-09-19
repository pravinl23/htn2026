// GHController: capture -> predict -> walk -> overlay + writer, for whatever window is in front.
// The native twin of extension/src/content/controller.ts; the walk itself lives in GHWalkState (pure).
//
//   AX notifications (debounced by GHAccessibility)
//     -> capture the focused window (GHCapture)
//     -> offline ghosts from GhostCore at once (0 network)
//     -> per-window cache, then ONE /v1/predict/form per form signature (never per rescan); the answer
//        upgrades the list without disturbing the ghost the user is on
//     -> free-text drafts for `needs_text` fields over SSE, at most 3 at a time, generated ahead of the walk
//     -> GHOverlayWindow render, GHEventTap snapshot
//   Tab (consumed by GHEventTap) -> GHWriter -> verify -> advance, or stop the walk and say why.
//
// Nothing runs while Ghost is disabled, the process is untrusted, the frontmost app is paused (built-in list,
// the user's list) or a browser's own extension is active there. Main thread only. Values are never logged.
#import <Foundation/Foundation.h>
#import "GHAppDelegate.h"
#import "GHAccessibility.h"
#import "GHEventTap.h"
#import "GHServerClient.h"
#import "GHWalkState.h"

@class GHCore, GHProfileStore, GHOverlayWindow, GHWriter, GHCapture, GHCaptureResult;

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
/// One rescan's worth of work on an already captured window. `pageKey` names the page (a new key forgets the
/// walk); `origin` is the cache key part from GHServerClient.
- (void)adoptCaptureResult:(nullable GHCaptureResult *)result pageKey:(NSString *)pageKey origin:(NSString *)origin;
/// Where keyboard focus is now (nil = the window itself). Rule 7: a ghosted field becomes current.
- (void)noteFocusedNode:(nullable id<GHAXNode>)node;
/// nil for the window itself, GHWalkFocusElsewhere, or the signature of the captured field behind `node`.
- (nullable NSString *)focusSignatureForNode:(nullable id<GHAXNode>)node;

@end

NS_ASSUME_NONNULL_END
