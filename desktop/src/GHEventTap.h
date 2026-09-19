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
//   - Events Ghost posted itself (typing fallback) carry GHSyntheticEventUserData and are ignored.
//   - A tap the system disabled (timeout or user input) re-enables itself; a watchdog checks every 5 s.
//   - Key contents are never stored or logged. "Printable" is a yes/no; the characters are dropped at once.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import "GHWalkState.h"

NS_ASSUME_NONNULL_BEGIN

/// kCGEventSourceUserData of every event Ghost posts.
extern const int64_t GHSyntheticEventUserData;

extern const CGKeyCode GHKeyCodeTab;      // 48
extern const CGKeyCode GHKeyCodeEscape;   // 53

/// Shift, Control, Option, Command. Caps Lock, Fn and the numeric-pad bit are not modifiers for this purpose.
GHKeyModifiers GHKeyModifiersFromFlags(CGEventFlags flags);

@class GHEventTap;

/// Every call arrives on the main queue, after the event was already consumed or passed.
@protocol GHEventTapDelegate <NSObject>
/// `decision` is Accept, Park, Queue or (never reported) Swallow.
- (void)eventTap:(GHEventTap *)tap didConsumeTab:(GHKeyDecision)decision isRepeat:(BOOL)isRepeat;
- (void)eventTapDidConsumeEscape:(GHEventTap *)tap;
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

// ---------- the callback's logic, callable without a real tap (tests) ----------
/// YES = consume. `userData` is kCGEventSourceUserData; `printable` whether the key produces a visible character.
- (BOOL)handleKeyDown:(CGKeyCode)keyCode flags:(CGEventFlags)flags isRepeat:(BOOL)isRepeat userData:(int64_t)userData printable:(BOOL)printable;
- (void)handleKeyUp:(CGKeyCode)keyCode userData:(int64_t)userData;
- (void)handleFlagsChanged:(CGEventFlags)flags;
- (void)handleScroll;
/// Tests: call the delegate inline instead of through the main queue.
@property (nonatomic) BOOL deliversSynchronously;

// ---------- posting (the typing fallback of GHWriter, and the replay of a Tab consumed on a stale snapshot) ----------
/// Unicode key events in chunks of at most 20 UTF-16 units, never splitting a surrogate pair, each tagged with
/// GHSyntheticEventUserData and free of modifier flags. Control characters are never posted: a newline becomes
/// a space (an Enter in a one-line field could submit a form). NO when the event source cannot be created.
+ (BOOL)postText:(NSString *)text;
/// One tagged key press (down + up) without modifiers.
+ (BOOL)postKeyCode:(CGKeyCode)keyCode;
/// What -postText: really sends for `text` (pure; exposed for tests).
+ (NSArray<NSString *> *)chunksForText:(NSString *)text;

@end

NS_ASSUME_NONNULL_END
