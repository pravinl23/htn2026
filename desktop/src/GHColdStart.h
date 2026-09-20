// GHColdStart: the one-time local scan that gives Ghost a knowledge graph on day one (docs/cold-start.md).
//
// GHScanSources counts what is there; this runs the plan over the sources the user switched on, hands what it
// reads to the pure rules in shared/src/coldstart (through GhostCore), and comes back with PROPOSALS. It never
// writes into the profile: the graph changes only when the user accepts a proposal (`ghostctl scan --apply`).
//
// The promises, enforced here and not only documented:
//   local        nothing read is uploaded, nothing is sent anywhere, no model is called. Only fact KEYS ever
//                reach the prediction server, and never from this path.
//   opt in       a source that is not in `enabledKinds` is not opened. A source whose permission is missing is
//                reported as "needs permission: <what to click>" and not opened either.
//   bounded      60 s wall clock, 500 files, 2 MB per file, cancellable between every item, off the main thread.
//   forgetful    the browser history is copied read-only, aggregated, and the COPY is deleted in the same call.
//   value-free   the report GHColdStart hands out carries labels, categories, confidences, provenance KINDS and
//                counts. Never a path, a file name, a URL or a fact value. Those live only in the private
//                pending store (mode 0600), and only until the user accepts or discards them.
#import <Foundation/Foundation.h>
#import "GHScanSources.h"

@class GHCore, GHProfileStore;

NS_ASSUME_NONNULL_BEGIN

/// Why a run ended.
typedef NS_ENUM(NSInteger, GHColdStartStop) {
    GHColdStartStopFinished = 0,
    GHColdStartStopBudget = 1,      // the wall clock or the file cap ran out; what was found is still returned
    GHColdStartStopCancelled = 2,
    GHColdStartStopNoCore = 3,      // ghost-core.js is missing: nothing is read at all
};
NSString *GHColdStartStopName(GHColdStartStop stop);

/// Hard limits. The plan may lower them; nothing raises them.
typedef struct {
    NSTimeInterval wallClockSeconds;   // 60
    // 500, not 200: the application inventory reads one tiny identifier file per installed application, and a
    // Mac with three hundred of them must not eat the budget every other source is waiting for.
    NSUInteger maxFiles;
    NSUInteger maxBytesPerFile;        // 2 MiB
} GHColdStartBudget;
GHColdStartBudget GHColdStartDefaultBudget(void);

/// Monotonic time, injected so a test can make the budget run out without waiting.
@protocol GHColdStartClock <NSObject>
- (NSTimeInterval)nowSeconds;
@end

/// Everything that touches a file. Tests hand in a fake: no subprocess, no disk, no database.
@protocol GHColdStartFiles <NSObject>
/// Plain text of a document, at most `maxBytes` (pdf/docx go through textutil). nil when it cannot be read.
- (nullable NSString *)textOfFileAtPath:(NSString *)path maxBytes:(NSUInteger)maxBytes;
/// A read-only COPY of a database, so the browser's own file is never opened by Ghost. Returns the copy's path.
- (nullable NSString *)copyOfDatabaseAtPath:(NSString *)path;
/// `{ origin, visitedAt, pathPattern? }` rows from a COPY. Never called with the original path.
- (NSArray<NSDictionary<NSString *, id> *> *)historyRowsFromCopyAtPath:(NSString *)copyPath limit:(NSUInteger)limit;
/// Deletes the copy. Called in the same run, whatever else happened.
- (void)removeCopyAtPath:(NSString *)copyPath;
/// The user's own contact card as vCard text, or nil when Contacts has not been granted (never prompts).
- (nullable NSString *)meCardText;
@end

/// The real machine: textutil, a file copy and /usr/bin/sqlite3, all through argument vectors, never a shell.
@interface GHColdStartFilesMac : NSObject <GHColdStartFiles>
@property (nonatomic) NSTimeInterval subprocessTimeout;   // default 10 s
@end

/// One proposed fact. `value` never leaves this object except through the private pending store.
@interface GHColdStartProposal : NSObject
@property (nonatomic, copy) NSString *identifier;      // "p1": what --apply accepts
@property (nonatomic, copy) NSString *key;             // graph key ("fullName", "address.home.city")
@property (nonatomic, copy) NSString *value;           // PRIVATE
@property (nonatomic, copy) NSString *label;
@property (nonatomic, copy) NSString *category;
@property (nonatomic) double confidence;
@property (nonatomic) NSInteger support;
@property (nonatomic, copy) NSString *sourceKind;      // which cold-start source found it
@property (nonatomic, copy) NSString *provenanceKind;  // FactSource kind: "file", "github", "user"...
/// Labels, categories, confidences and provenance KINDS. No value, no file name, no evidence.
- (NSDictionary<NSString *, id> *)reportObject;
/// Everything, for the private pending store (mode 0600).
- (NSDictionary<NSString *, id> *)pendingObject;
@end

/// What one run found.
@interface GHColdStartResult : NSObject
@property (nonatomic, copy) NSString *scanIdentifier;
@property (nonatomic, copy) NSArray<GHColdStartProposal *> *proposals;
/// The habit aggregate, minus its per-origin rows (those name hosts and stay in the pending store).
@property (nonatomic, copy, nullable) NSDictionary<NSString *, id> *habits;
/// The surface aggregate, minus its per-surface rows (those name places and stay in the pending store).
@property (nonatomic, copy, nullable) NSDictionary<NSString *, id> *surfaces;
/// Counts per KIND of screen from recently used documents: `[{ kind, count }]`. No id at all, so it is reportable.
@property (nonatomic, copy) NSArray<NSDictionary<NSString *, id> *> *screenKinds;
/// The role-memory snapshot the habits produced, for `--apply` to seed memory.json with. PRIVATE.
@property (nonatomic, copy, nullable) NSDictionary<NSString *, id> *roleMemory;
/// The FULL aggregates, ids and all, for `--apply` to seed graph.json with. PRIVATE, never reported.
@property (nonatomic, copy, nullable) NSDictionary<NSString *, id> *historyAggregate;
@property (nonatomic, copy, nullable) NSDictionary<NSString *, id> *surfaceAggregate;
/// Per-source outcome: `{ kind, status, permission, needsPermission?, opened, proposals, skipped, detail? }`.
@property (nonatomic, copy) NSArray<NSDictionary<NSString *, id> *> *sourceReports;
@property (nonatomic, copy) NSDictionary<NSString *, NSNumber *> *skippedCounts;
@property (nonatomic) NSUInteger filesOpened;
@property (nonatomic) NSUInteger skippedTotal;
@property (nonatomic) NSTimeInterval elapsedSeconds;
@property (nonatomic) GHColdStartStop stop;
/// The consent plan this run followed, as the core built it.
@property (nonatomic, copy, nullable) NSDictionary<NSString *, id> *plan;

/// THE value-free report: what `--out` is allowed to contain and what a person (or an agent) may read.
- (NSDictionary<NSString *, id> *)reportObject;
/// The private half: proposal values and the role-memory snapshot. Never printed, never shared, 0600 on disk.
- (NSDictionary<NSString *, id> *)pendingObject;
@end

/// NO when `object` carries anything that looks like a path, a URL, an e-mail address or a long digit run.
/// The last gate before a report is written: a leak fails the write instead of reaching a file.
BOOL GHColdStartIsValueFree(id object, NSString *_Nullable *_Nullable offender);

@interface GHColdStart : NSObject

- (instancetype)initWithCore:(nullable GHCore *)core files:(id<GHColdStartFiles>)files NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

@property (nonatomic) GHColdStartBudget budget;
@property (nonatomic, strong, nullable) id<GHColdStartClock> clock;
/// The machine, for the sources that read a preference file, a directory listing or a Spotlight attribute rather
/// than a document. Without one those sources report "no-environment" and are skipped honestly, never guessed at.
@property (nonatomic, strong, nullable) id<GHScanEnvironment> environment;
/// Time zone offset in minutes for the habit buckets (default: this machine's).
@property (nonatomic) NSInteger timeZoneOffsetMinutes;
/// Minimum visits before a host is counted on its own rather than folded into "other" (default 3).
@property (nonatomic) NSUInteger habitMinVisits;

/// The consent plan for these sources: the panel's rows, the caps and the estimate. Reads nothing.
- (nullable NSDictionary<NSString *, id> *)planForSources:(NSArray<GHScanSource *> *)sources
                                             enabledKinds:(NSSet<NSString *> *)enabledKinds;

/// Runs the plan. Blocks; call it off the main thread (or use the asynchronous form). Never writes anything.
- (GHColdStartResult *)runSources:(NSArray<GHScanSource *> *)sources enabledKinds:(NSSet<NSString *> *)enabledKinds;

/// The same on a background queue; `completion` is called on the main queue.
- (void)runSources:(NSArray<GHScanSource *> *)sources
      enabledKinds:(NSSet<NSString *> *)enabledKinds
        completion:(void (^)(GHColdStartResult *result))completion;

/// Stops the run at the next item. Safe from any thread.
- (void)cancel;
@property (nonatomic, readonly) BOOL cancelled;

@end

/// What `--apply` did.
typedef struct {
    NSUInteger applied;
    NSUInteger conflicts;     // the profile already holds a different value; the user decides, not Ghost
    NSUInteger unchanged;     // already exactly this value
    NSUInteger ignored;       // not accepted in the report
} GHColdStartApplyCounts;

/// Writes the accepted proposals into `store`. `report` is the value-free file the user reviewed (a proposal is
/// accepted when its `accepted` is true); `pending` is the private store that still holds the values. Both must
/// carry the same `scanId`, or nothing is applied. Existing facts are never overwritten.
GHColdStartApplyCounts GHColdStartApply(NSDictionary *report, NSDictionary *pending, GHProfileStore *store, NSError *_Nullable *_Nullable error);

/// Seeds memory.json with the habit priors, but ONLY when there is no memory yet: a cold start may give Ghost
/// its first priors, never overwrite what the user has taught it. Returns NO when there was nothing to do.
BOOL GHColdStartSeedRoleMemory(NSDictionary *pending, NSString *memoryPath);

#pragma mark - the one small file (docs/storage.md)

/// Seeds `graphPath` with the surfaces and habits a scan found, plus the facts the report accepted. Additive,
/// capped by the shared rules before anything is written, and atomic at mode 0600. `summary` comes back with the
/// counts the caller prints: surfaces, habits, facts, bytes. NO on any failure, with the file left untouched.
BOOL GHColdStartApplyGraph(GHCore *core, NSDictionary *report, NSDictionary *pending, NSString *graphPath,
                           NSDictionary<NSString *, id> *_Nullable *_Nullable summary);

/// What Ghost knows: counts per screen kind, per source, the file size and the most used surfaces. The surface
/// ids come back so a UI can offer "forget this one"; a printed report shows the counts, never the ids.
NSDictionary<NSString *, id> *_Nullable GHColdStartDescribeGraph(GHCore *core, NSString *graphPath);

/// "Forget this source": exactly what it produced goes, and a surface another source also found stays.
BOOL GHColdStartForgetSource(GHCore *core, NSString *graphPath, NSString *kind,
                             NSDictionary<NSString *, id> *_Nullable *_Nullable removed);

/// "Delete everything": the graph, the pending proposals and the seeded role memory, in one call.
BOOL GHColdStartForgetEverything(NSString *directory);

NS_ASSUME_NONNULL_END
