// GHWalkState: the pure state machine of a Ghost walk (the native twin of the `state` half of
// extension/src/content/controller.ts). No AX, no windows, no timers, no I/O: everything here runs in the
// test runner with hand-made ghosts.
//
// It owns: the live ghost list (lock ghost parked last), the current ghost, what was accepted, what was
// dismissed (never resurrected by a rescan), the field the walk just left, the Submit the walk is heading
// for, keystrokes saved and the error line. It also holds THE rule that decides whether a Tab or an Escape
// belongs to Ghost (GHDecideTab / GHDecideEscape), as plain C over a plain struct, so the event tap can run
// it on its own thread from a lock-free snapshot.
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Pass as a focus signature when keyboard focus is on an element that is NOT a captured field (a search
/// box, a code editor, a toolbar). nil means "focus is on the window itself / nowhere".
extern NSString *const GHWalkFocusElsewhere;

extern NSString *const GHGhostActionFill;
extern NSString *const GHGhostActionSelect;
extern NSString *const GHGhostActionCheck;
extern NSString *const GHGhostActionClick;
/// Desktop only: attach the file at `value` (an absolute path; `displayText` is its file name) through the page's
/// upload control and the macOS open panel (GHOpenPanelDriver).
extern NSString *const GHGhostActionUpload;

/// One precomputed suggestion: the typed form of a `Ghost` dictionary from GhostCore.
@interface GHGhost : NSObject <NSCopying>
@property (nonatomic, copy) NSString *signature;
@property (nonatomic, copy) NSString *action;            // fill | select | check | click | upload
@property (nonatomic, copy, nullable) NSString *value;   // stays in memory: never logged
@property (nonatomic, copy) NSString *displayText;       // stays in memory: never logged
@property (nonatomic) double confidence;
@property (nonatomic) BOOL locked;
@property (nonatomic, copy) NSString *source;            // offline | server | cache | llm | loop
@property (nonatomic) BOOL pending;                      // free text still streaming in
/// A select answered before its options exist (react-select): `value` is the intended answer, matched against the
/// real options when the ghost is accepted (GHComboBoxDriver).
@property (nonatomic) BOOL lazy;
+ (nullable instancetype)ghostWithDictionary:(nullable NSDictionary<NSString *, id> *)dictionary;
+ (NSArray<GHGhost *> *)ghostsWithDictionaries:(nullable NSArray *)dictionaries;
- (NSDictionary<NSString *, id> *)dictionary;
/// What accepting this ghost saves: the value's length for a fill, 1 for select/check/upload.
@property (nonatomic, readonly) NSInteger keystrokes;
@end

#pragma mark - key decisions

typedef NS_OPTIONS(NSUInteger, GHKeyModifiers) {
    GHKeyModifierNone    = 0,
    GHKeyModifierShift   = 1 << 0,
    GHKeyModifierControl = 1 << 1,
    GHKeyModifierOption  = 1 << 2,
    GHKeyModifierCommand = 1 << 3,
};

typedef NS_ENUM(NSInteger, GHKeyDecision) {
    GHKeyDecisionPass = 0,   // not Ghost's key: the event goes on untouched
    GHKeyDecisionAccept,     // consume; accept the current ghost (asynchronously, on the main queue)
    GHKeyDecisionPark,       // consume; the current ghost is locked: move focus onto it, NEVER press it
    GHKeyDecisionQueue,      // consume; a write is in flight: queue one more accept
    GHKeyDecisionSwallow,    // consume and do nothing (the rest of a hold that ran out, halted or is mid-write)
    GHKeyDecisionDismiss,    // Escape: consume; dismiss the current ghost
    GHKeyDecisionJump,       // consume; the current ghost is off screen: scroll it into view, write NOTHING
};

/// Everything the rule needs, as plain flags. Built on the main thread, read anywhere.
typedef struct {
    BOOL active;          // Ghost enabled, process trusted, frontmost app neither paused nor handled by the extension
    BOOL hasCurrent;
    BOOL currentVisible;  // the current ghost is drawn on screen right now (GHOverlayModel.currentVisible)
    BOOL currentLocked;
    BOOL currentPending;  // a draft that is still streaming
    BOOL focusInWalk;     // focus is on the current ghost's element, on the field the walk just left, or on the window itself
    BOOL focusOnField;    // focus is on a captured value field (typing there overrides its ghost)
    BOOL busy;            // a write is in flight
    BOOL canJump;         // the current ghost is off screen and Ghost can scroll it into view (not tried in vain yet)
} GHWalkSnapshot;

/// State of one physical key hold. Owned by whoever feeds key events in (the event tap).
typedef struct {
    BOOL walking;   // this hold began with a press Ghost consumed
    BOOL halted;    // swallow the rest of this hold (lock reached, walk ran out, write failed)
} GHHoldState;

/// The Tab rule of docs/desktop.md (mirror of rules 1 to 4 of docs/architecture.md). Updates `hold`.
GHKeyDecision GHDecideTab(GHWalkSnapshot snapshot, GHKeyModifiers modifiers, BOOL isRepeat, GHHoldState *_Nullable hold);
/// Escape passes the same gate as Tab and is only consumed when a ghost really gets dismissed. `owned`
/// remembers whether this hold's first press was consumed: its auto-repeats are then swallowed (they never
/// dismiss a second ghost), and the repeats of an Escape that was the app's stay the app's.
GHKeyDecision GHDecideEscape(GHWalkSnapshot snapshot, GHKeyModifiers modifiers, BOOL isRepeat, BOOL *_Nullable owned);
static inline BOOL GHKeyDecisionConsumes(GHKeyDecision decision) { return decision != GHKeyDecisionPass; }

#pragma mark - state

@interface GHWalkState : NSObject

/// LIVE ghosts only: accepted and dismissed ones leave the list. At most one locked ghost, always last.
@property (nonatomic, readonly, copy) NSArray<GHGhost *> *ghosts;
/// -1 when nothing is current. Never points at the lock ghost while an unlocked ghost remains.
@property (nonatomic, readonly) NSInteger currentIndex;
@property (nonatomic, readonly, nullable) GHGhost *current;
@property (nonatomic, readonly) NSInteger accepted;
@property (nonatomic, readonly, copy) NSSet<NSString *> *dismissed;
/// The field the walk just left (accepted, dismissed, typed over): Tab pressed there still belongs to the walk.
@property (nonatomic, readonly, copy, nullable) NSString *leftSignature;
/// The Submit this walk is heading for. No other locked button is ever kept alive on its own.
@property (nonatomic, readonly, copy, nullable) NSString *lockSignature;
@property (nonatomic, readonly) NSInteger keystrokesSaved;
/// Never contains a value.
@property (nonatomic, readonly, copy, nullable) NSString *error;
/// nil = the window itself, GHWalkFocusElsewhere = some other control, else a field signature.
@property (nonatomic, readonly, copy, nullable) NSString *focusSignature;
@property (nonatomic, readonly) BOOL hasUnlocked;
/// Pass to GhostCore as `keepLock`: the walk filled something and knows its Submit.
@property (nonatomic, readonly) BOOL keepLock;
/// Something was accepted and nothing unlocked is left.
@property (nonatomic, readonly) BOOL finished;

- (nullable GHGhost *)ghostWithSignature:(nullable NSString *)signature;
- (NSInteger)indexOfSignature:(nullable NSString *)signature;

/// A rescan: `ghosts` is the fresh list from the core. Keeps the current ghost, `accepted` and the
/// dismissals, never resurrects a dismissed ghost, parks the lock last, drops a lone stranger lock.
- (void)rescanWithGhosts:(NSArray<GHGhost *> *)ghosts;
/// The write held: counts it, clears the error, leaves the field, advances (wrapping to skipped ghosts).
- (void)accept:(NSString *)signature;
/// Escape, or a refused write (rule 9): gone for this page, the walk advances.
- (void)dismiss:(NSString *)signature;
/// The user typed in this field: its ghost (if any) is dismissed and the signature never gets one again.
- (void)typedOver:(NSString *)signature;
/// The element behind the ghost is gone: drop it without remembering a dismissal (a rescan decides).
- (void)drop:(NSString *)signature;
/// Rule 8: the write did not hold. The ghost is dismissed and the reason is shown. `reason` is a short code.
- (void)fail:(NSString *)signature reason:(NSString *)reason;
/// Rule 7, focus follows the user: a focused field with a live ghost becomes current (never the lock ghost early).
- (void)focusMoved:(nullable NSString *)signature;
/// Makes a live ghost current (never the lock ghost while unlocked ones remain). NO when it could not.
- (BOOL)makeCurrent:(NSString *)signature;
/// Records where keyboard focus is WITHOUT following it (a rescan re-reads focus; the current ghost has priority).
- (void)noteFocus:(nullable NSString *)signature;
/// Streaming text: replaces the ghost with the same signature in place. NO when there is none.
- (BOOL)updateGhost:(GHGhost *)ghost;
/// Hold-Tab never accepts a pending draft: makes the next unlocked, non-pending ghost current. NO when there is none.
- (BOOL)skipPendingCurrent;
/// A new page, window or app (or Ghost switched off): nothing accepted, nothing dismissed, no Submit to keep.
- (void)reset;

/// The walk's half of the snapshot (`active`, `currentVisible` and `busy` come from the caller).
- (GHWalkSnapshot)snapshotWithActive:(BOOL)active currentVisible:(BOOL)currentVisible busy:(BOOL)busy;

/// Convenience over GHDecideTab for a fresh state read: `focusSignature` as in -focusMoved: (without side effects).
- (BOOL)shouldConsumeTabWithModifiers:(GHKeyModifiers)modifiers
                             isRepeat:(BOOL)isRepeat
                       focusSignature:(nullable NSString *)focusSignature
                       currentVisible:(BOOL)currentVisible
                                 hold:(GHHoldState *)hold;
- (BOOL)shouldConsumeEscapeWithModifiers:(GHKeyModifiers)modifiers
                          focusSignature:(nullable NSString *)focusSignature
                          currentVisible:(BOOL)currentVisible;

@end

NS_ASSUME_NONNULL_END
