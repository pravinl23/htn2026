// SBAccessibility: everything that touches the live accessibility API outside of single nodes.
//   - trust state (prompt once, poll until trusted, notice a revoked permission)
//   - frontmost app and focused window tracking (NSWorkspace + AXObserver)
//   - AX notifications coalesced into ONE debounced "needs rescan" callback (150 ms, 600 ms ceiling)
//   - AXEnhancedUserInterface / AXManualAccessibility for Chromium and Electron apps
//   - the pause list (password managers, terminals, system security surfaces, Shabang itself)
// Nothing here is attempted while the process is untrusted: every AX call would return -25211.
// Main thread only.
#import <Foundation/Foundation.h>
#import <ApplicationServices/ApplicationServices.h>
#import "SBAXNode.h"
#import "SBCapture.h"

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, SBTrustState) {
    SBTrustStateUnknown = 0,
    SBTrustStateUntrusted,   // menu bar: "Needs Accessibility permission"
    SBTrustStateTrusted,
};

typedef NS_OPTIONS(NSUInteger, SBRescanReason) {
    SBRescanReasonNone           = 0,
    SBRescanReasonAppChanged     = 1 << 0,
    SBRescanReasonWindowChanged  = 1 << 1,
    SBRescanReasonFocusChanged   = 1 << 2,
    SBRescanReasonValueChanged   = 1 << 3,
    SBRescanReasonLayoutChanged  = 1 << 4,
    SBRescanReasonWindowGeometry = 1 << 5,   // moved or resized
    SBRescanReasonElementGone    = 1 << 6,
    SBRescanReasonPageLoaded     = 1 << 7,
    SBRescanReasonTrustChanged   = 1 << 8,
    SBRescanReasonManual         = 1 << 9,
};

@class SBAccessibility;

@protocol SBAccessibilityDelegate <NSObject>
@optional
/// Debounced: at most one call per burst of notifications, `reasons` is the union of what happened.
- (void)accessibility:(SBAccessibility *)accessibility needsRescan:(SBRescanReason)reasons;
/// Immediate, before the debounce: the overlay must hide NOW (app or window switched, window moving or resizing).
- (void)accessibilityShouldHideOverlay:(SBAccessibility *)accessibility reason:(SBRescanReason)reason;
/// Immediate: keyboard focus moved inside the frontmost app ("focus follows the user").
- (void)accessibilityFocusedElementDidChange:(SBAccessibility *)accessibility;
- (void)accessibility:(SBAccessibility *)accessibility trustDidChange:(SBTrustState)state;
- (void)accessibilityFrontmostAppDidChange:(SBAccessibility *)accessibility;
@end

/// Trailing-edge debounce with a ceiling, so a page that never stops mutating still gets rescanned.
@interface SBDebouncer : NSObject
- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithDelay:(NSTimeInterval)delay ceiling:(NSTimeInterval)ceiling handler:(void (^)(NSUInteger flags))handler NS_DESIGNATED_INITIALIZER;
/// ORs `flags` into the pending set and (re)arms the timer on the main queue.
- (void)poke:(NSUInteger)flags;
- (void)cancel;
@property (nonatomic, readonly) BOOL pending;
/// Pure rule behind `poke:`: seconds from `now` until the handler should run.
+ (NSTimeInterval)waitForBurstStartedAt:(NSTimeInterval)firstPoke now:(NSTimeInterval)now delay:(NSTimeInterval)delay ceiling:(NSTimeInterval)ceiling;
@end

@interface SBAccessibility : NSObject

@property (nonatomic, weak, nullable) id<SBAccessibilityDelegate> delegate;

// ---------- trust ----------
@property (nonatomic, readonly) SBTrustState trustState;
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
/// YES when the frontmost app builds its web tree only on request (Chromium, Electron), which also means it
/// reports no frame at all for content scrolled out of the viewport.
@property (nonatomic, readonly) BOOL frontmostNeedsEnhancedUserInterface;
/// YES when the frontmost app is on the default or the user pause list: Shabang does nothing there.
@property (nonatomic, readonly) BOOL frontmostIsPaused;
/// YES while an AXObserver is attached to the frontmost app.
@property (nonatomic, readonly) BOOL observing;
/// Last AXError seen while attaching or reading (kAXErrorSuccess when all is well).
@property (nonatomic, readonly) AXError lastError;

// ---------- live reads (nil unless trusted, running and not paused) ----------
- (nullable id<SBAXNode>)focusedWindowNode;
- (nullable id<SBAXNode>)focusedElementNode;
- (nullable NSString *)focusedWindowTitle;
/// scheme://host[:port] of a web area (AXURL). Never the path or the query: those can carry personal data.
- (nullable NSString *)originOfWebAreaNode:(nullable id<SBAXNode>)webArea;
/// Walks the focused window with `capture`. nil when there is nothing Shabang may look at.
- (nullable SBCaptureResult *)captureFocusedWindowWithCapture:(SBCapture *)capture;
/// Asks for a rescan through the same debounce as AX notifications.
- (void)setNeedsRescan:(SBRescanReason)reason;

// ---------- pause list ----------
+ (NSSet<NSString *> *)defaultPausedBundleIdentifiers;
/// Families matched by prefix (every 1Password helper, every Bitwarden build...).
+ (NSArray<NSString *> *)defaultPausedBundlePrefixes;
/// Added to the defaults ("Pause in <frontmost app>" in the menu). Persisted by the caller.
@property (nonatomic, copy) NSSet<NSString *> *userPausedBundleIdentifiers;
- (BOOL)isBundleIdentifierPaused:(nullable NSString *)bundleIdentifier;

// ---------- Chromium, Electron and CEF ----------
+ (NSSet<NSString *> *)chromiumBundleIdentifiers;
/// The app is really Chromium behind a native window: it ships an Electron or a CEF framework. Spotify is CEF,
/// not Electron, and without this its whole window is 15 accessibility nodes.
+ (BOOL)bundleAtURLUsesChromium:(nullable NSURL *)bundleURL;
/// YES when the web tree of this app only shows up after AXEnhancedUserInterface / AXManualAccessibility.
+ (BOOL)appNeedsEnhancedUserInterface:(nullable NSString *)bundleIdentifier bundleURL:(nullable NSURL *)bundleURL;

/// AX notification name -> what it means for Shabang. SBRescanReasonNone for names Shabang does not care about.
+ (SBRescanReason)reasonForNotification:(NSString *)notification;
/// The notifications registered on every observed application.
+ (NSArray<NSString *> *)observedNotifications;

@end

NS_ASSUME_NONNULL_END
