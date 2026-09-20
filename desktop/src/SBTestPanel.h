// SBTestPanel: two buttons floating over everything, for telling apart the two ways an accept can fail.
//
// When a ghost does not take, there are two completely different causes and they look identical from the
// outside:
//
//   1. the key never reached Shabang at all (the app owns Tab, or focus is somewhere Shabang will not take it from);
//   2. the key reached Shabang and the actuation did nothing (the control does not implement AXPress, the
//      element moved, the app ignored the click).
//
// So: press a button, keep your hands off the keyboard, and one second later Shabang does the thing by itself.
//
//   Tab      posts a REAL Tab, untagged, through the same HID tap the user's own keystrokes come in on. If
//            this does nothing but Accept works, the key is the problem, not the click.
//   Accept   goes straight to the accept path, exactly as the Shabang key does. If this does nothing either,
//            the actuation is the problem.
//
// The second of delay is the point: it is enough to take your hand off the mouse and let the app settle, and
// the panel never takes focus, so whatever was in front stays in front and stays focused.
//
// After each press the panel shows what the controller recorded -- the outcome, the method that was used and
// the reason it failed -- which is the same short vocabulary as the log and never contains anything you typed.
#import <AppKit/AppKit.h>

NS_ASSUME_NONNULL_BEGIN

@class SBController;

/// Seconds between the press and the action. Long enough to get your hand back out of the way.
extern const NSTimeInterval SBTestPanelDelay;   // 1.0

@interface SBTestPanel : NSObject

- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithController:(SBController *)controller NS_DESIGNATED_INITIALIZER;

@property (nonatomic, readonly) BOOL visible;
- (void)show;
- (void)hide;
- (void)toggle;

/// Test seam: how the delay is run, and how a real Tab is posted. Defaults are the main queue and the same
/// poster the harness uses. A test replaces both and nothing touches the keyboard.
@property (nonatomic, copy) void (^after)(NSTimeInterval delay, dispatch_block_t block);
@property (nonatomic, copy) BOOL (^postTab)(void);

/// What the buttons do, exposed so a test can call them without a window server.
- (void)runTab;
- (void)runAccept;
/// The line the panel shows: what the controller recorded for the last step. Codes only, never content.
@property (nonatomic, readonly, copy) NSString *resultLine;

@end

NS_ASSUME_NONNULL_END
