// GHEventTap: the one place Ghost looks at the keyboard. A session-level CGEventTap (head insert) on its OWN
// thread, so a main thread that is busy walking an accessibility tree never delays the user's keys.
//
// The callback does the minimum: it reads a lock-free snapshot the controller published (a few bits in one
// atomic word), runs the pure rule from GHWalkState (GHDecideTab / GHDecideEscape), returns NULL to consume,
// and tells the delegate on the main queue. It never calls AX, JavaScriptCore or anything that can block.
//
// Safety:
//   - Nothing is ever consumed unless the snapshot says `active` (enabled, trusted, app not paused).
//   - Only an unmodified Tab and an unmodified Escape can be consumed. Every other event passes untouched.
//   - Events Ghost posted itself (GHKeyPoster, the handed-back Tab) carry GHSyntheticEventUserData and are ignored.
//   - Every UNTAGGED key-down (the user's, whether consumed or not, whether Ghost is active or not) is reported to
//     -userKeyObserver on the tap thread: an open-panel or combobox sequence in flight aborts on it.
//   - A tap the system disabled (timeout or user input) re-enables itself; a watchdog checks every 5 s.
//   - Key contents are never stored or logged. "Printable" is a yes/no; the characters are dropped at once.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import "GHWalkState.h"

NS_ASSUME_NONNULL_BEGIN

/// kCGEventSourceUserData of every event Ghost posts.
extern const int64_t GHSyntheticEventUserData;

extern const CGKeyCode GHKeyCodeTab;         // 48
extern const CGKeyCode GHKeyCodeEscape;      // 53
extern const CGKeyCode GHKeyCodeRightOption; // 61, the Ghost key (docs/accept-key.md)

/// A tap of the Ghost key is right Option down and up again within this long, with nothing in between.
extern const NSTimeInterval GHGhostKeyTapSeconds; // 0.3

/// Process-wide kill switch for synthetic input. Once called, no key event ever leaves this process: GHEventTap
/// +postKeyCode:, GHTaggedKeyEventSink (GHKeyPoster's live sink) and the harness Tab all refuse. The test runner calls
/// it before the first test, so no code path under test can reach the real keyboard. There is no way back.
void GHForbidRealKeyEvents(void);
BOOL GHRealKeyEventsForbidden(void);

/// Shift, Control, Option, Command. Caps Lock, Fn and the numeric-pad bit are not modifiers for this purpose.
GHKeyModifiers GHKeyModifiersFromFlags(CGEventFlags flags);

@class GHEventTap;

/// Every call arrives on the main queue, after the event was already consumed or passed.
@protocol GHEventTapDelegate <NSObject>
/// `decision` is Accept, Park, Queue, Jump or (never reported) Swallow.
- (void)eventTap:(GHEventTap *)tap didConsumeTab:(GHKeyDecision)decision isRepeat:(BOOL)isRepeat;
- (void)eventTapDidConsumeEscape:(GHEventTap *)tap;
/// A tap of the Ghost key (right Option alone). Accepts the current ghost wherever Tab belongs to the app.
/// The modifier event itself is never consumed, so holding right Option as a real modifier still works.
- (void)eventTapDidTapGhostKey:(GHEventTap *)tap;
/// A printable key went to the app while focus was in a captured field: typing overrides that field's ghost.
- (void)eventTapDidSeeTypingInField:(GHEventTap *)tap;
/// The user scrolled while ghosts were on screen (coalesced): their rects are stale.
- (void)eventTapDidSeeScroll:(GHEventTap *)tap;
@end

@interface GHEventTap : NSObject

@property (nonatomic, weak, nullable) id<GHEventTapDelegate> delegate;

/// Creates the tap and its thread. NO when the system refuses (the process is not trusted for Accessibility):
/// nothing is consumed then, and the watchdog keeps retrying until -uninstall.
- (BOOL)install;
- (void)uninstall;
/// YES while a live, enabled tap exists.
@property (nonatomic, readonly) BOOL installed;
/// -install was called and -uninstall was not (the watchdog is running).
@property (nonatomic, readonly) BOOL wanted;
/// How often a disabled tap was switched back on.
@property (nonatomic, readonly) NSUInteger reenableCount;

/// Lock-free, any thread. Until the first publish the snapshot is all zeros: nothing is consumed.
- (void)publishSnapshot:(GHWalkSnapshot)snapshot;
- (GHWalkSnapshot)publishedSnapshot;
/// The walk ran out, failed or parked: swallow the rest of the current hold instead of accepting more.
- (void)haltHold;
/// Runs ON THE TAP THREAD (or the caller's, in tests) for every untagged key-down, before anything is decided. It
/// must only flip atomic flags (GHOpenPanelDriver / GHComboBoxDriver -noteUserKeyEvent). Thread safe to set.
@property (copy, nullable) void (^userKeyObserver)(void);

// ---------- the callback's logic, callable without a real tap (tests) ----------
/// YES = consume. `userData` is kCGEventSourceUserData; `printable` whether the key produces a visible character.
- (BOOL)handleKeyDown:(CGKeyCode)keyCode flags:(CGEventFlags)flags isRepeat:(BOOL)isRepeat userData:(int64_t)userData printable:(BOOL)printable;
- (void)handleKeyUp:(CGKeyCode)keyCode userData:(int64_t)userData;
- (void)handleFlagsChanged:(CGEventFlags)flags keyCode:(CGKeyCode)keyCode;
- (void)handleScroll;
/// Tests: call the delegate inline instead of through the main queue.
@property (nonatomic) BOOL deliversSynchronously;

// ---------- posting ----------
// Typing (GHWriter's fallback, the drivers) goes through GHKeyPoster, which re-checks focus before every chunk.
// The one key posted here is the Tab handed back to the app when Ghost consumed it on a stale snapshot: GHKeyPoster
// can never post Tab by design.
/// One tagged key press (down + up) without modifiers.
+ (BOOL)postKeyCode:(CGKeyCode)keyCode;
/// Text as it is typed: chunks of at most 20 UTF-16 units, never splitting a surrogate pair. Control characters never
/// survive: a newline becomes a space (an Enter in a one-line field could submit a form). Pure.
+ (NSArray<NSString *> *)chunksForText:(NSString *)text;

@end

NS_ASSUME_NONNULL_END
