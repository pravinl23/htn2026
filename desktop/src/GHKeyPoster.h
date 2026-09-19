// GHKeyPoster: the one way the open-panel and combobox drivers touch the keyboard (docs/desktop-realworld.md,
// "File-upload target contract" and "Real combobox target contract").
//
// A burst is a short list of strokes. IMMEDIATELY before every single post (every text chunk, every key) the
// poster reads the CURRENT frontmost app and the CURRENT system-wide focused element (never a snapshot taken
// earlier) and hands them to the caller's guard. A guard may walk trees and take a while, so after it said yes
// both are read AGAIN and must not have moved, and the caller's cheap last check (user key seen? still running?)
// runs right before the event goes out. The first "no" aborts the whole burst: nothing after it is posted.
// NSWorkspace's frontmost app only updates when the main run loop turns, so the live focus re-read (an AX call to
// the system) and the user-key flag (set by the event tap's own thread) are what catch a switch mid-guard. The guard is where the drivers encode "only while focus is the go-to field", "only while the combobox
// list is open", "never if the frontmost app changed", "never after the user pressed a key".
//
// Hard limits that hold whatever a guard says:
//   - The only key codes this file can post are +postableKeyCodes (text carrier, G with Command+Shift, Return,
//     Backspace, Escape, Down, Up). Never Space (49), keypad Enter (76) or Tab (48).
//   - A Return is always a burst of its own, so its guard is the very last thing that runs before it.
//   - Text never carries a control character: a burst with one is refused before anything is posted. Text goes out
//     as a unicode string on the text-carrier key (0), so a space inside "United States" is a character typed into
//     the field the guard allowed, never a press of the Space key (which could activate a focused button).
//   - Every event is tagged with GHSyntheticEventUserData, so Ghost's own event tap ignores it.
//   - Nothing is logged but stroke names and counts. Never the text.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import "GHAXNode.h"

NS_ASSUME_NONNULL_BEGIN

extern const CGKeyCode GHKeyCodeTextCarrier;   // 0: carries a unicode string
extern const CGKeyCode GHKeyCodeANSIG;         // 5: with Command+Shift = "Go to Folder" in an open panel
extern const CGKeyCode GHKeyCodeReturn;        // 36
extern const CGKeyCode GHKeyCodeBackspace;     // 51
extern const CGKeyCode GHKeyCodeDownArrow;     // 125
extern const CGKeyCode GHKeyCodeUpArrow;       // 126
// Escape (53) is GHKeyCodeEscape in GHEventTap.h.

typedef NS_ENUM(NSInteger, GHKeyStrokeKind) {
    GHKeyStrokeKindText = 1,
    GHKeyStrokeKindEscape,
    GHKeyStrokeKindDownArrow,
    GHKeyStrokeKindUpArrow,
    GHKeyStrokeKindBackspace,
    GHKeyStrokeKindGoToFolder,   // Command+Shift+G
    GHKeyStrokeKindReturn,       // open panel go-to sheet / Open button, or an OPEN combobox list only
};

@interface GHKeyStroke : NSObject
+ (instancetype)text:(NSString *)text;
+ (instancetype)escape;
+ (instancetype)downArrow;
+ (instancetype)upArrow;
+ (instancetype)backspace;
+ (instancetype)goToFolder;
+ (instancetype)returnKey;
- (instancetype)init NS_UNAVAILABLE;
@property (nonatomic, readonly) GHKeyStrokeKind kind;
@property (nonatomic, readonly) CGKeyCode keyCode;
@property (nonatomic, readonly) CGEventFlags flags;
/// Text strokes only. Never logged.
@property (nonatomic, readonly, copy, nullable) NSString *text;
/// "text", "escape", "down", "up", "backspace", "go-to-folder", "return": safe for logs.
@property (nonatomic, readonly, copy) NSString *name;
@end

extern NSString *const GHKeyBurstReasonEmpty;          // nothing to post
extern NSString *const GHKeyBurstReasonMalformed;      // a Return that is not alone, text with a control character
extern NSString *const GHKeyBurstReasonGuardRefused;   // the guard said no (focus, app, user key...)
extern NSString *const GHKeyBurstReasonPostFailed;     // the system would not take the event

@interface GHKeyBurstResult : NSObject
@property (nonatomic, readonly) BOOL ok;
/// Atomic posts that went out (a text stroke is one post per chunk of at most 20 UTF-16 units).
@property (nonatomic, readonly) NSUInteger postedCount;
/// Index of the stroke that was refused or failed; NSNotFound when ok.
@property (nonatomic, readonly) NSUInteger failedIndex;
@property (nonatomic, readonly, copy, nullable) NSString *reason;
@end

/// What the guard sees, read fresh right before every post. `focused` is nil when AX cannot tell.
typedef BOOL (^GHKeyGuard)(GHKeyStroke *stroke, pid_t frontmostPID, id<GHAXNode> _Nullable focused);

/// The very last question before a post, asked after the guard and after focus and the app were read again: cheap
/// flags only (the driver still running, no key of the user's since it started). Called on the posting thread.
typedef BOOL (^GHKeyLastCheck)(void);

@protocol GHKeyPosting <NSObject>
/// Posts `strokes` in order on the calling thread (the main thread in Ghost). Stops at the first refused guard or
/// failed post; nothing after that point is ever posted. Same as `lastCheck:nil`.
- (GHKeyBurstResult *)postBurst:(NSArray<GHKeyStroke *> *)strokes guard:(GHKeyGuard)guard;
/// For every single post: read the frontmost app and focus, run `guard` (which may take a while: tree walks), read
/// both AGAIN and refuse when either moved while the guard ran, then ask `lastCheck`, then post. A guard's slow
/// walk therefore cannot let a click or a Command+Tab slip in before a Return.
- (GHKeyBurstResult *)postBurst:(NSArray<GHKeyStroke *> *)strokes guard:(GHKeyGuard)guard lastCheck:(nullable GHKeyLastCheck)lastCheck;
@end

/// Live desktop state. Every call reads the system again; nothing is cached.
@protocol GHDesktopState <NSObject>
/// The active app (the one that receives key events). 0 when unknown.
- (pid_t)frontmostProcessIdentifier;
/// The system-wide focused element. nil when unknown.
- (nullable id<GHAXNode>)focusedElement;
/// The app's AXWindows (sheets hang below them as AXSheet children). Empty when unknown.
- (NSArray<id<GHAXNode>> *)windowsOfProcess:(pid_t)pid;
@end

/// NSWorkspace for the active app, the system-wide AX element for focus, AXWindows of the app element.
@interface GHLiveDesktopState : NSObject <GHDesktopState>
@end

/// Settable state for tests.
@interface GHFakeDesktopState : NSObject <GHDesktopState>
@property (nonatomic) pid_t frontmostPID;
@property (nonatomic, strong, nullable) id<GHAXNode> focusedNode;
/// pid -> windows.
@property (nonatomic, readonly) NSMutableDictionary<NSNumber *, NSMutableArray<id<GHAXNode>> *> *windowsByPID;
@property (nonatomic, readonly) NSUInteger focusReads;
@property (nonatomic, readonly) NSUInteger frontmostReads;
- (void)addWindow:(id<GHAXNode>)window forPID:(pid_t)pid;
- (void)removeWindow:(id<GHAXNode>)window forPID:(pid_t)pid;
@end

/// Where atomic posts go. One call = one key press (down + up).
@protocol GHKeyEventSink <NSObject>
- (BOOL)sendKeyCode:(CGKeyCode)keyCode flags:(CGEventFlags)flags text:(nullable NSString *)text;
@end

/// CGEventPost at the HID level from a private event source, every event tagged with GHSyntheticEventUserData.
@interface GHTaggedKeyEventSink : NSObject <GHKeyEventSink>
@end

@interface GHKeyPoster : NSObject <GHKeyPosting>
- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithState:(id<GHDesktopState>)state sink:(id<GHKeyEventSink>)sink NS_DESIGNATED_INITIALIZER;
/// GHLiveDesktopState + GHTaggedKeyEventSink, 2 ms between posts (some web views drop bursts).
+ (GHKeyPoster *)livePoster;
@property (nonatomic, readonly) id<GHDesktopState> state;
@property (nonatomic, readonly) id<GHKeyEventSink> sink;
/// Seconds to sleep between two atomic posts of one burst. 0 for fakes.
@property (nonatomic) NSTimeInterval interPostDelay;
/// Every key code this class can ever post: @[ @0, @5, @36, @51, @53, @125, @126 ]. Pinned by a test.
+ (NSArray<NSNumber *> *)postableKeyCodes;
/// Pure: the atomic posts a burst expands to (text split into chunks). nil with *reason for a malformed burst.
+ (nullable NSArray<GHKeyStroke *> *)atomicStrokesForBurst:(NSArray<GHKeyStroke *> *)strokes reason:(NSString *_Nullable *_Nullable)reason;
@end

/// The production poster over a GHFakeDesktopState and a recording sink: the guard logic under test is the real one.
@interface GHFakeKeyPoster : GHKeyPoster
- (instancetype)initWithState:(GHFakeDesktopState *)state NS_DESIGNATED_INITIALIZER;
- (instancetype)initWithState:(id<GHDesktopState>)state sink:(id<GHKeyEventSink>)sink NS_UNAVAILABLE;
@property (nonatomic, readonly) GHFakeDesktopState *fakeState;
/// Every atomic post that reached the "system", in order (text chunks as text strokes).
@property (nonatomic, readonly, copy) NSArray<GHKeyStroke *> *posted;
/// The names of `posted`, e.g. @[ @"text", @"return" ].
@property (nonatomic, readonly, copy) NSArray<NSString *> *postedNames;
/// Everything typed through text strokes, concatenated.
@property (nonatomic, readonly, copy) NSString *typedText;
@property (nonatomic, readonly) NSUInteger guardCalls;
@property (nonatomic, readonly) NSUInteger burstCount;
/// The "app" reacting to a post (move focus, open a sheet, type into the focused fake node...).
@property (nonatomic, copy, nullable) void (^onPost)(GHKeyStroke *stroke);
/// The system refuses events.
@property (nonatomic) BOOL sinkFails;
- (NSUInteger)countOfKind:(GHKeyStrokeKind)kind;
@end

NS_ASSUME_NONNULL_END
