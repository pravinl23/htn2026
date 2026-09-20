// GHNextAction: Ghost anywhere on the native side (docs/anywhere.md). When the form walk has nothing to offer
// -- and most windows are not forms -- this is what Ghost proposes instead: the one control the affordances,
// the kind of place and the user's own role memory say comes next.
//
//   capture (GHCapture)  ->  hints (GHAffordance)  ->  GhostCore.nextAction  ->  one click ghost
//
// The proposal is an ordinary unlocked `click` ghost, so the whole existing walk applies to it unchanged: the
// overlay draws the ghost cursor on it, Tab accepts it, Escape dismisses it, typing or any other key cancels,
// and anything irreversible keeps its lock and is never pressed (rules 1 and 2).
//
// Role memory lives in ~/Library/Application Support/Shabang/memory.json: counts per (page kind, previous role,
// role), nothing else. No label, no value, no app, no site, and it never leaves the machine.
#import <Foundation/Foundation.h>
#import "GHAffordance.h"
#import "GHWalkState.h"

@class GHCore, GHCaptureResult;

NS_ASSUME_NONNULL_BEGIN

/// What the core proposed, in the terms the controller and the HUD use.
@interface GHNextProposal : NSObject
/// The captured signature of the control (the ghost's signature).
@property (nonatomic, copy) NSString *signature;
/// The affordance role: "fullscreen", "primary-item", "search"... Never page text.
@property (nonatomic, copy) NSString *role;
@property (nonatomic) double confidence;
/// Irreversible: drawn with the lock badge, never pressed by Ghost.
@property (nonatomic) BOOL locked;
/// memory | prior | affordance: where the confidence came from.
@property (nonatomic, copy) NSString *source;
/// Below the confidence gate, or a role nothing could name: drawn with a "guess" chip, never auto-accepted
/// by a held accept key (docs/always-propose.md). A guess is still ALWAYS proposed.
@property (nonatomic) BOOL guess;
/// One clause the HUD can show ("you usually go fullscreen after starting a video"). Roles and places only.
@property (nonatomic, copy) NSString *reason;
/// The kind of place this was proposed in, kept so an accept is recorded under the same key.
@property (nonatomic, copy) NSString *pageKind;
/// The role of the action the user took last here, or nil for the first proposal of this window.
@property (nonatomic, copy, nullable) NSString *previousRole;
/// A `click` GHGhost for the walk: unlocked ones are pressed, locked ones only ever parked on.
- (GHGhost *)ghostWithDisplayText:(NSString *)displayText;
@end

/// Role-keyed memory on disk. Corrupt, truncated or foreign content reads as "nothing learned yet", never as
/// a reason to stop proposing. Written atomically with mode 0600, like every other Ghost file.
@interface GHRoleMemoryStore : NSObject
- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithPath:(NSString *)path core:(nullable GHCore *)core NS_DESIGNATED_INITIALIZER;
/// ~/Library/Application Support/Shabang/memory.json.
+ (NSString *)defaultPath;
@property (nonatomic, readonly, copy) NSString *path;
/// The snapshot as the core reads it ("" when there is nothing).
@property (nonatomic, readonly, copy) NSString *snapshotJSON;
/// Folds one outcome in and writes the file. `parts` is `{ pageKind, role, previousRole? }`.
- (void)record:(NSDictionary<NSString *, NSString *> *)parts outcome:(NSString *)outcome;
/// Re-reads the file (tests, and a store that was edited underneath).
- (void)reload;
@end

extern NSString *const GHRoleOutcomeAccepted;
extern NSString *const GHRoleOutcomeDismissed;
extern NSString *const GHRoleOutcomeReplaced;

@interface GHNextAction : NSObject

- (instancetype)init NS_UNAVAILABLE;
/// `memory` may be nil: then nothing is remembered and every proposal comes from the priors alone.
- (instancetype)initWithCore:(GHCore *)core memory:(nullable GHRoleMemoryStore *)memory NS_DESIGNATED_INITIALIZER;

/// The confidence gate. Defaults to the shared 0.7; the controller passes the user's setting.
@property (nonatomic) double threshold;

/// The whole pass for one captured window: annotate, ask the core, return the one proposal (or nil).
/// `window` is the node capture walked; `signals` may carry what only the app knows (bundle id, path pattern,
/// fullscreen). Never proposes a control that is not in `result`.
- (nullable GHNextProposal *)proposeForResult:(nullable GHCaptureResult *)result
                                       window:(nullable id<GHAXNode>)window
                                      signals:(nullable GHPageSignals *)signals;

/// The last pass's page kind, its evidence and the ids nothing could name (what the vision fallback is for).
@property (nonatomic, readonly, copy) NSString *pageKind;
@property (nonatomic, readonly, copy) NSArray<NSString *> *pageEvidence;
@property (nonatomic, readonly, copy) NSArray<NSString *> *unnamedSignatures;
/// Every ranked row of the last pass, best first (the HUD's "what else was on offer").
@property (nonatomic, readonly, copy) NSArray<GHNextProposal *> *ranked;
/// What the last pass measured, for the HUD and the tests.
@property (nonatomic, readonly, copy, nullable) GHPageSignals *lastSignals;

/// The user took the proposal / dismissed it / did something else instead. Recorded under the role, so it
/// transfers to the next video, the next shop and the next feed.
- (void)recordOutcome:(NSString *)outcome forProposal:(nullable GHNextProposal *)proposal;

// ---------- pure, exposed for tests ----------
/// An empty box somebody types in that the app has put the keyboard into. `outSignature` gets its signature.
+ (BOOL)window:(GHCaptureResult *)result hasAFocusedEmptyField:(NSString *_Nullable *_Nullable)outSignature;
/// Is the app already showing a list of answers directly under that box (an autocomplete, a "Suggested"
/// list, recent files)? Then the next action is to take one of them, not to type into the box.
+ (BOOL)result:(GHCaptureResult *)result showsCandidatesUnder:(NSString *)signature;

@end

NS_ASSUME_NONNULL_END
