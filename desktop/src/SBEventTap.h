// SBEventTap: the one place Shabang looks at the keyboard. A session-level CGEventTap (head insert) on its OWN
// thread, so a main thread that is busy walking an accessibility tree never delays the user's keys.
//
// The callback does the minimum: it reads a lock-free snapshot the controller published (a few bits in one
// atomic word), runs the pure rule from SBWalkState (SBDecideTab / SBDecideEscape), returns NULL to consume,
// and tells the delegate on the main queue. It never calls AX, JavaScriptCore or anything that can block.
//
// Safety:
//   - Nothing is ever consumed unless the snapshot says `active` (enabled, trusted, app not paused).
//   - Only an unmodified Tab and an unmodified Escape can be consumed. Every other event passes untouched.
//   - Events Shabang posted itself (SBKeyPoster, the handed-back Tab) carry SBSyntheticEventUserData and are ignored.
//   - Every UNTAGGED key-down (the user's, whether consumed or not, whether Shabang is active or not) is reported to
//     -userKeyObserver on the tap thread: an open-panel or combobox sequence in flight aborts on it.
//   - A tap the system disabled (timeout or user input) re-enables itself; a watchdog checks every 5 s.
//   - Key contents are never stored or logged. "Printable" is a yes/no; the characters are dropped at once.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import "SBWalkState.h"

NS_ASSUME_NONNULL_BEGIN

/// kCGEventSourceUserData of every event Shabang posts.
extern const int64_t SBSyntheticEventUserData;

extern const CGKeyCode SBKeyCodeTab;          // 48
extern const CGKeyCode SBKeyCodeEscape;       // 53
extern const CGKeyCode SBKeyCodeRightOption;  // 61
extern const CGKeyCode SBKeyCodeRightCommand; // 54

/// A tap of the Shabang key is that modifier down and up again within this long, with nothing in between.
extern const NSTimeInterval SBGhostKeyTapSeconds; // 0.3

/**
 * Which key accepts a ghost outside a form (docs/accept-key.md).
 *
 * Both choices are a LONE tap of a right-hand modifier: down and up with no other key in between, and the
 * modifier event itself is never consumed. That is what gives them no conflict surface at all -- macOS
 * produces nothing for either tap, no app binds one, and holding the key still works exactly as it always
 * did, accented characters included, because a chord is never a tap.
 *
 * Right COMMAND is the default, and right Option is not, which was learned the hard way on a real machine:
 * a lone Option tap is not free after all. macOS toggles Mouse Keys when Option is pressed five times, and
 * apps bind a double tap of it as a global hotkey -- Claude's own desktop app does. Spamming the accept key
 * hit both. Nothing in macOS or in any common app answers a lone right Command tap.
 *
 * Right Option stays available for anyone who wants it and does not run into either.
 */
typedef NS_ENUM(NSInteger, SBGhostKey) {
    SBGhostKeyRightCommand = 0,
    SBGhostKeyRightOption,
};

/// "right-command" / "right-option" from settings.json. Anything else is the default.
SBGhostKey SBGhostKeyFromName(NSString *_Nullable name);
/// The key code a choice listens for, and the flag mask that says it is down.
CGKeyCode SBGhostKeyCode(SBGhostKey key);
CGEventFlags SBGhostKeyFlagMask(SBGhostKey key);
/// What the HUD and the ghost's hint chip call it: "right \u2325" / "right \u2318".
NSString *SBGhostKeyDisplayName(SBGhostKey key);

/// Process-wide kill switch for synthetic input. Once called, no key event ever leaves this process: SBEventTap
/// +postKeyCode:, SBTaggedKeyEventSink (SBKeyPoster's live sink) and the harness Tab all refuse. The test runner calls
/// it before the first test, so no code path under test can reach the real keyboard. There is no way back.
void SBForbidRealKeyEvents(void);
BOOL SBRealKeyEventsForbidden(void);

/// Shift, Control, Option, Command. Caps Lock, Fn and the numeric-pad bit are not modifiers for this purpose.
SBKeyModifiers SBKeyModifiersFromFlags(CGEventFlags flags);

@class SBEventTap;

/// Every call arrives on the main queue, after the event was already consumed or passed.
@protocol SBEventTapDelegate <NSObject>
/// `decision` is Accept, Park, Queue, Jump or (never reported) Swallow.
- (void)eventTap:(SBEventTap *)tap didConsumeTab:(SBKeyDecision)decision isRepeat:(BOOL)isRepeat;
- (void)eventTapDidConsumeEscape:(SBEventTap *)tap;
/// A tap of the Shabang key (right Option alone). Accepts the current ghost wherever Tab belongs to the app.
/// The modifier event itself is never consumed, so holding right Option as a real modifier still works.
- (void)eventTapDidTapGhostKey:(SBEventTap *)tap;
/// A printable key went to the app while focus was in a captured field: typing overrides that field's ghost.
- (void)eventTapDidSeeTypingInField:(SBEventTap *)tap;
/// The user scrolled while ghosts were on screen (coalesced): their rects are stale.
- (void)eventTapDidSeeScroll:(SBEventTap *)tap;
@end

@interface SBEventTap : NSObject

@property (nonatomic, weak, nullable) id<SBEventTapDelegate> delegate;
/// Which lone modifier tap accepts a ghost. Read on the tap thread, so it is atomic. Default: right Option.
@property (atomic) SBGhostKey ghostKey;

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
- (void)publishSnapshot:(SBWalkSnapshot)snapshot;
- (SBWalkSnapshot)publishedSnapshot;
/// The walk ran out, failed or parked: swallow the rest of the current hold instead of accepting more.
- (void)haltHold;
/// Runs ON THE TAP THREAD (or the caller's, in tests) for every untagged key-down, before anything is decided. It
/// must only flip atomic flags (SBOpenPanelDriver / SBComboBoxDriver -noteUserKeyEvent). Thread safe to set.
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
// Typing (SBWriter's fallback, the drivers) goes through SBKeyPoster, which re-checks focus before every chunk.
// The one key posted here is the Tab handed back to the app when Shabang consumed it on a stale snapshot: SBKeyPoster
// can never post Tab by design.
/// One tagged key press (down + up) without modifiers.
+ (BOOL)postKeyCode:(CGKeyCode)keyCode;
/// Text as it is typed: chunks of at most 20 UTF-16 units, never splitting a surrogate pair. Control characters never
/// survive: a newline becomes a space (an Enter in a one-line field could submit a form). Pure.
+ (NSArray<NSString *> *)chunksForText:(NSString *)text;

@end

NS_ASSUME_NONNULL_END
