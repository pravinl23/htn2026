// GHAccessibility: everything that touches the live accessibility API outside of single nodes.
//   - trust state (prompt once, poll until trusted, notice a revoked permission)
//   - frontmost app and focused window tracking (NSWorkspace + AXObserver)
//   - AX notifications coalesced into ONE debounced "needs rescan" callback (150 ms, 600 ms ceiling)
//   - AXEnhancedUserInterface / AXManualAccessibility for Chromium and Electron apps
//   - the pause list (password managers, terminals, system security surfaces, Ghost itself)
// Nothing here is attempted while the process is untrusted: every AX call would return -25211.
// Main thread only.
#import <Foundation/Foundation.h>
#import <ApplicationServices/ApplicationServices.h>
#import "GHAXNode.h"
#import "GHCapture.h"

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, GHTrustState) {
    GHTrustStateUnknown = 0,
    GHTrustStateUntrusted,   // menu bar: "Needs Accessibility permission"
    GHTrustStateTrusted,
};

typedef NS_OPTIONS(NSUInteger, GHRescanReason) {
    GHRescanReasonNone           = 0,
    GHRescanReasonAppChanged     = 1 << 0,
    GHRescanReasonWindowChanged  = 1 << 1,
    GHRescanReasonFocusChanged   = 1 << 2,
    GHRescanReasonValueChanged   = 1 << 3,
    GHRescanReasonLayoutChanged  = 1 << 4,
    GHRescanReasonWindowGeometry = 1 << 5,   // moved or resized
    GHRescanReasonElementGone    = 1 << 6,
    GHRescanReasonPageLoaded     = 1 << 7,
    GHRescanReasonTrustChanged   = 1 << 8,
    GHRescanReasonManual         = 1 << 9,
};

@class GHAccessibility;

@protocol GHAccessibilityDelegate <NSObject>
@optional
/// Debounced: at most one call per burst of notifications, `reasons` is the union of what happened.
- (void)accessibility:(GHAccessibility *)accessibility needsRescan:(GHRescanReason)reasons;
/// Immediate, before the debounce: the overlay must hide NOW (app or window switched, window moving or resizing).
- (void)accessibilityShouldHideOverlay:(GHAccessibility *)accessibility reason:(GHRescanReason)reason;
/// Immediate: keyboard focus moved inside the frontmost app ("focus follows the user").
- (void)accessibilityFocusedElementDidChange:(GHAccessibility *)accessibility;
- (void)accessibility:(GHAccessibility *)accessibility trustDidChange:(GHTrustState)state;
- (void)accessibilityFrontmostAppDidChange:(GHAccessibility *)accessibility;
@end

/// Trailing-edge debounce with a ceiling, so a page that never stops mutating still gets rescanned.
@interface GHDebouncer : NSObject
- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithDelay:(NSTimeInterval)delay ceiling:(NSTimeInterval)ceiling handler:(void (^)(NSUInteger flags))handler NS_DESIGNATED_INITIALIZER;
/// ORs `flags` into the pending set and (re)arms the timer on the main queue.
- (void)poke:(NSUInteger)flags;
- (void)cancel;
@property (nonatomic, readonly) BOOL pending;
/// Pure rule behind `poke:`: seconds from `now` until the handler should run.
+ (NSTimeInterval)waitForBurstStartedAt:(NSTimeInterval)firstPoke now:(NSTimeInterval)now delay:(NSTimeInterval)delay ceiling:(NSTimeInterval)ceiling;
@end

@interface GHAccessibility : NSObject

@property (nonatomic, weak, nullable) id<GHAccessibilityDelegate> delegate;

// ---------- trust ----------
@property (nonatomic, readonly) GHTrustState trustState;
@property (nonatomic, readonly) BOOL trusted;
/// Defaults to AXIsProcessTrusted(). Tests replace it.
@property (nonatomic, copy) BOOL (^trustProbe)(void);
/// Shows the system "grant Accessibility" prompt. At most once per process; later calls only re-check.
- (BOOL)requestTrustWithPromptOnce;
/// Human line for the menu: "Ready", "Needs Accessibility permission", "Paused in Terminal"...
@property (nonatomic, readonly, copy) NSString *statusLine;

// ---------- lifecycle ----------
/// Starts tracking the frontmost app and polling trust (1 s while untrusted, 3 s while trusted).
- (void)start;
- (void)stop;
@property (nonatomic, readonly) BOOL running;

// ---------- frontmost app ----------
@property (nonatomic, readonly) pid_t frontmostPID;                         // 0 when unknown
@property (nonatomic, readonly, copy, nullable) NSString *frontmostBundleIdentifier;
@property (nonatomic, readonly, copy, nullable) NSString *frontmostAppName;
/// YES when the frontmost app is on the default or the user pause list: Ghost does nothing there.
@property (nonatomic, readonly) BOOL frontmostIsPaused;
/// YES while an AXObserver is attached to the frontmost app.
@property (nonatomic, readonly) BOOL observing;
/// Last AXError seen while attaching or reading (kAXErrorSuccess when all is well).
@property (nonatomic, readonly) AXError lastError;

// ---------- live reads (nil unless trusted, running and not paused) ----------
- (nullable id<GHAXNode>)focusedWindowNode;
- (nullable id<GHAXNode>)focusedElementNode;
- (nullable NSString *)focusedWindowTitle;
/// scheme://host[:port] of a web area (AXURL). Never the path or the query: those can carry personal data.
- (nullable NSString *)originOfWebAreaNode:(nullable id<GHAXNode>)webArea;
/// Walks the focused window with `capture`. nil when there is nothing Ghost may look at.
- (nullable GHCaptureResult *)captureFocusedWindowWithCapture:(GHCapture *)capture;
/// Asks for a rescan through the same debounce as AX notifications.
- (void)setNeedsRescan:(GHRescanReason)reason;

// ---------- pause list ----------
+ (NSSet<NSString *> *)defaultPausedBundleIdentifiers;
/// Families matched by prefix (every 1Password helper, every Bitwarden build...).
+ (NSArray<NSString *> *)defaultPausedBundlePrefixes;
/// Added to the defaults ("Pause in <frontmost app>" in the menu). Persisted by the caller.
@property (nonatomic, copy) NSSet<NSString *> *userPausedBundleIdentifiers;
- (BOOL)isBundleIdentifierPaused:(nullable NSString *)bundleIdentifier;

// ---------- Chromium and Electron ----------
+ (NSSet<NSString *> *)chromiumBundleIdentifiers;
+ (BOOL)bundleAtURLUsesElectron:(nullable NSURL *)bundleURL;
/// YES when the web tree of this app only shows up after AXEnhancedUserInterface / AXManualAccessibility.
+ (BOOL)appNeedsEnhancedUserInterface:(nullable NSString *)bundleIdentifier bundleURL:(nullable NSURL *)bundleURL;

/// AX notification name -> what it means for Ghost. GHRescanReasonNone for names Ghost does not care about.
+ (GHRescanReason)reasonForNotification:(NSString *)notification;
/// The notifications registered on every observed application.
+ (NSArray<NSString *> *)observedNotifications;

@end

NS_ASSUME_NONNULL_END
