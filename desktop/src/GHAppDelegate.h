// GHAppDelegate: the menu-bar agent. Accessory app (no Dock icon), NSStatusItem menu, Accessibility trust
// polling, Alt+Shift+G hotkey, and the owner of the long-lived services (core, profile store, server client).
//
// The capture -> predict -> overlay -> event tap pipeline is GHController. The delegate only ever drives it
// through the GHDesktopPipeline protocol below, and only while the process is trusted and Ghost is enabled
// (a class named "GHPipeline" is still looked up at run time as a replacement seam).
#import <AppKit/AppKit.h>

@class GHCore, GHProfileStore, GHServerClient, GHPresence, GHServerHealth;

NS_ASSUME_NONNULL_BEGIN

/// Posted on the main queue when AXIsProcessTrusted() flips. userInfo: @{ @"trusted": NSNumber }.
extern NSNotificationName const GHTrustDidChangeNotification;
/// Posted when the enabled state or the paused app list changed (menu, hotkey or settings.json edit).
extern NSNotificationName const GHActivationDidChangeNotification;
/// Posted after every health/presence poll. object = the app delegate.
extern NSNotificationName const GHServerStatusDidChangeNotification;

/// What the app delegate expects from the pipeline class it finds at run time. All calls on the main thread.
@protocol GHDesktopPipeline <NSObject>
- (instancetype)initWithCore:(GHCore *)core store:(GHProfileStore *)store client:(GHServerClient *)client;
/// Only ever called while the process is trusted for Accessibility and Ghost is enabled.
- (void)start;
/// Trust revoked, Ghost disabled, or quitting: remove every ghost, the event tap and the observers.
- (void)stop;
@optional
/// One short line for the menu ("3 ghosts in Safari", "Paused in Terminal"). No field values.
- (NSString *)statusLine;
/// Browsers whose extension is active must be skipped (docs/desktop.md "Coexistence with the extension").
- (void)presenceDidChange:(nullable GHPresence *)presence;
@end

@interface GHAppDelegate : NSObject <NSApplicationDelegate, NSMenuDelegate>

@property (nonatomic, readonly, nullable) GHCore *core;
@property (nonatomic, readonly, nullable) GHProfileStore *store;
@property (nonatomic, readonly, nullable) GHServerClient *client;

@property (nonatomic, readonly) BOOL trusted;
/// settings.enabled. Toggled from the menu and with Alt+Shift+G.
@property (nonatomic, readonly) BOOL ghostEnabled;
@property (nonatomic, readonly, nullable) GHServerHealth *health;
@property (nonatomic, readonly, nullable) GHPresence *presence;
/// The app the user is working in (never Ghost itself).
@property (nonatomic, readonly, nullable) NSRunningApplication *frontmostUserApp;

- (void)toggleEnabled:(nullable id)sender;

// Pure helpers, exposed for tests.
/// "Needs Accessibility permission", "Off", "On: heuristic only (server offline)", "On: jev, 182 ms"...
+ (NSString *)statusTitleForTrusted:(BOOL)trusted enabled:(BOOL)enabled coreLoaded:(BOOL)coreLoaded
                           provider:(nullable NSString *)provider latencyMs:(nullable NSNumber *)latencyMs;
/// Template image for the status item (drawn in code; the bundle ships no assets).
+ (NSImage *)statusImageActive:(BOOL)active;

@end

NS_ASSUME_NONNULL_END
