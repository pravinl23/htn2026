// SBAppDelegate: the menu-bar agent. Accessory app (no Dock icon), NSStatusItem menu, Accessibility trust
// polling, Alt+Shift+G hotkey, and the owner of the long-lived services (core, profile store, server client).
//
// The capture -> predict -> overlay -> event tap pipeline is SBController. The delegate only ever drives it
// through the SBDesktopPipeline protocol below, and only while the process is trusted and Shabang is enabled
// (a class named "SBPipeline" is still looked up at run time as a replacement seam).
#import <AppKit/AppKit.h>

@class SBCore, SBProfileStore, SBServerClient, SBPresence, SBServerHealth, SBHarnessChannel, SBHarnessRequest;

NS_ASSUME_NONNULL_BEGIN

/// Posted on the main queue when AXIsProcessTrusted() flips. userInfo: @{ @"trusted": NSNumber }.
extern NSNotificationName const SBTrustDidChangeNotification;
/// Posted when the enabled state or the paused app list changed (menu, hotkey or settings.json edit).
extern NSNotificationName const SBActivationDidChangeNotification;
/// Posted after every health/presence poll. object = the app delegate.
extern NSNotificationName const SBServerStatusDidChangeNotification;

/// What the app delegate expects from the pipeline class it finds at run time. All calls on the main thread.
@protocol SBDesktopPipeline <NSObject>
- (instancetype)initWithCore:(SBCore *)core store:(SBProfileStore *)store client:(SBServerClient *)client;
/// Only ever called while the process is trusted for Accessibility and Shabang is enabled.
- (void)start;
/// Trust revoked, Shabang disabled, or quitting: remove every ghost, the event tap and the observers.
- (void)stop;
@optional
/// One short line for the menu ("3 ghosts in Safari", "Paused in Terminal"). No field values.
- (NSString *)statusLine;
/// Browsers whose extension is active must be skipped (docs/desktop.md "Coexistence with the extension").
- (void)presenceDidChange:(nullable SBPresence *)presence;
@end

@interface SBAppDelegate : NSObject <NSApplicationDelegate, NSMenuDelegate>

@property (nonatomic, readonly, nullable) SBCore *core;
@property (nonatomic, readonly, nullable) SBProfileStore *store;
@property (nonatomic, readonly, nullable) SBServerClient *client;

@property (nonatomic, readonly) BOOL trusted;
/// settings.enabled. Toggled from the menu and with Alt+Shift+G.
@property (nonatomic, readonly) BOOL ghostEnabled;
@property (nonatomic, readonly, nullable) SBServerHealth *health;
@property (nonatomic, readonly, nullable) SBPresence *presence;
/// The app the user is working in (never Shabang itself).
@property (nonatomic, readonly, nullable) NSRunningApplication *frontmostUserApp;

- (void)toggleEnabled:(nullable id)sender;

// Harness (SBHarness.h). Both are set by GhostMain before the app runs.
/// Where harness requests from later `open -n ... --args` launches arrive. nil: this agent serves none.
@property (nonatomic, strong, nullable) SBHarnessChannel *harnessChannel;
/// A standalone --autotab: run this one request once the pipeline is up, write its answer, quit.
@property (nonatomic, strong, nullable) SBHarnessRequest *launchRequest;

// Pure helpers, exposed for tests.
/// "Needs Accessibility permission", "Off", "On: heuristic only (server offline)", "On: jev, 182 ms"...
+ (NSString *)statusTitleForTrusted:(BOOL)trusted enabled:(BOOL)enabled coreLoaded:(BOOL)coreLoaded
                           provider:(nullable NSString *)provider latencyMs:(nullable NSNumber *)latencyMs;
/// Template image for the status item (drawn in code; the bundle ships no assets).
+ (NSImage *)statusImageActive:(BOOL)active;

@end

NS_ASSUME_NONNULL_END
