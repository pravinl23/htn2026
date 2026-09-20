// SBCore: JavaScriptCore bridge to build/shabang-core.js (global `GhostCore`, see desktop/core/entry.ts).
// Strings in, strings out underneath; typed Objective-C wrappers on top.
//
// Threading: one JSContext guarded by a lock, so any thread may call in. Calls are synchronous and
// cheap (a whole form maps in well under a millisecond), but never call from the event-tap callback.
#import <Foundation/Foundation.h>
#import "SBField.h"
#import "SBSafetyChecking.h"

NS_ASSUME_NONNULL_BEGIN

extern NSString *const SBCoreErrorDomain;

typedef NS_ENUM(NSInteger, SBCoreError) {
    SBCoreErrorBundleNotFound = 1,
    SBCoreErrorBundleUnreadable = 2,
    SBCoreErrorEvaluationFailed = 3,
    SBCoreErrorMissingExport = 4,
};

/// SHA-256 (lower-case hex) of the shabang-core.js this library was built with (`make lib` embeds it); "" when unpinned.
NSString *SBCorePinnedSHA256(void);
/// SHA-256 of a file, lower-case hex; nil when it cannot be read.
NSString *_Nullable SBCoreSHA256OfFile(NSString *_Nullable path);
/// YES when `pinned` is empty or equals the file's SHA-256.
BOOL SBCoreBundleMatchesPin(NSString *_Nullable path, NSString *_Nullable pinned);

/// Conforms to SBSafetyChecking (capture's view of the two shared safety rules); both answers fail CLOSED.
@interface SBCore : NSObject <SBSafetyChecking>

/// Process-wide instance, loaded from `+defaultBundlePath`. nil (and logged once) when the bundle cannot be loaded.
+ (nullable instancetype)sharedCore;

/// DESKTOP_CORE_PATH (the test runner only: ignored in Shabang itself), else shabang-core.js beside the image this code
/// was loaded from (libshabang.dylib), else Shabang.app/Contents/Resources/shabang-core.js, else shabang-core.js or
/// build/shabang-core.js next to the executable. Outside the test runner the file must match SBCorePinnedSHA256, or
/// nil is returned (a swapped core would bypass the fact allowlist and the wire filters).
+ (nullable NSString *)defaultBundlePath;

- (nullable instancetype)initWithBundlePath:(NSString *)path error:(NSError *_Nullable *_Nullable)error;
- (nullable instancetype)initWithSource:(NSString *)source error:(NSError *_Nullable *_Nullable)error NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

/// Message of the last JavaScript exception (never contains arguments). nil after a clean call.
@property (atomic, copy, readonly, nullable) NSString *lastError;

// ---------- raw bridge ----------
/// Calls GhostCore.<function>(...args) with string arguments. nil when the call threw or did not return a string.
- (nullable NSString *)callString:(NSString *)function arguments:(NSArray<NSString *> *)arguments;
/// Same for functions that return a boolean. `fallback` is returned when the call threw.
- (BOOL)callBool:(NSString *)function arguments:(NSArray<NSString *> *)arguments fallback:(BOOL)fallback;

// ---------- typed wrappers ----------
/// { facts: {key: value}, pastAnswers: [] }: the fictional demo profile.
- (NSDictionary<NSString *, id> *)demoProfile;
/// GhostSettings defaults (enabled, confidenceThreshold 0.7, serverUrl, showHud, learningEnabled).
- (NSDictionary<NSString *, id> *)defaultSettings;

/// FieldAssignment dictionaries { signature, factKey, confidence } from the shared heuristic.
- (NSArray<NSDictionary<NSString *, id> *> *)mapFields:(NSArray<SBField *> *)fields factKeys:(NSArray<NSString *> *)factKeys;
/// Same on CapturedField JSON objects (tests, caches).
- (NSArray<NSDictionary<NSString *, id> *> *)mapFieldObjects:(NSArray<NSDictionary *> *)fields factKeys:(NSArray<NSString *> *)factKeys;

/// Shabang dictionaries { signature, action, value?, displayText, confidence, locked, source } in field
/// order, lock ghost last. `options` may carry @"keepLock" (NSNumber BOOL) and @"lockSignature".
- (NSArray<NSDictionary<NSString *, id> *> *)ghostsForFields:(NSArray<SBField *> *)fields
                                                  assignments:(NSArray<NSDictionary *> *)assignments
                                                      profile:(NSDictionary *)profile
                                                     settings:(NSDictionary *)settings
                                                       source:(NSString *)source
                                                      options:(nullable NSDictionary *)options;
- (NSArray<NSDictionary<NSString *, id> *> *)ghostsForFieldObjects:(NSArray<NSDictionary *> *)fields
                                                        assignments:(NSArray<NSDictionary *> *)assignments
                                                            profile:(NSDictionary *)profile
                                                           settings:(NSDictionary *)settings
                                                             source:(NSString *)source
                                                            options:(nullable NSDictionary *)options;

/// Offline ghosts upgraded with served (server or cache) assignments; same merge rules as the extension.
- (NSArray<NSDictionary<NSString *, id> *> *)upgradeGhostsForFields:(NSArray<SBField *> *)fields
                                                              served:(NSArray<NSDictionary *> *)served
                                                             profile:(NSDictionary *)profile
                                                            settings:(NSDictionary *)settings
                                                              source:(NSString *)source
                                                             options:(nullable NSDictionary *)options;

/// Probe keys: inputType, autocomplete, name, id, label, placeholder, markedSensitive. Fails CLOSED:
/// YES when the core is broken or the probe cannot be serialized.
- (BOOL)isSensitive:(NSDictionary<NSString *, id> *)probe;
- (BOOL)isSensitiveLabel:(nullable NSString *)label placeholder:(nullable NSString *)placeholder identifier:(nullable NSString *)identifier;
/// Probe keys: text, buttonType, markedLocked, insideForm. Fails CLOSED (YES = locked).
- (BOOL)isLockedAction:(NSDictionary<NSString *, id> *)probe;
- (BOOL)isLockedActionText:(nullable NSString *)text;

/// The non-sensitive subset of profile facts allowed to go to /v1/shabang-text.
- (NSDictionary<NSString *, NSString *> *)textFactsForProfile:(NSDictionary *)profile;
/// Past answers a /v1/shabang-text draft for `label` may see (core textPastAnswers): at most three, only questions
/// similar to `label`, never a sensitive, EEO or work-authorization question, never an answer with contact data.
/// Empty on any error.
- (NSArray<NSDictionary<NSString *, NSString *> *> *)pastAnswersForProfile:(NSDictionary *)profile label:(NSString *)label;

/// JSON body for POST /v1/predict/form: value-free, non-sensitive fields and fact KEYS only.
/// nil when there is nothing worth asking (no usable fields or keys).
- (nullable NSData *)formRequestBodyForFieldObjects:(NSArray<NSDictionary *> *)fields
                                           factKeys:(NSArray<NSString *> *)factKeys
                                             origin:(NSString *)origin
                                      formSignature:(NSString *)formSignature;

/// Keeps the well-formed entries of a server reply or a cache entry.
- (NSArray<NSDictionary<NSString *, id> *> *)cleanAssignments:(id)rawAssignments;

/// True for "Select an option" style entries that stand for "nothing chosen yet".
- (BOOL)isPlaceholderValue:(nullable NSString *)value label:(nullable NSString *)label;

// ---------- the answer engine (docs/answers.md) and the gate (docs/incremental.md) ----------
/// What Shabang would propose for each field: { signature, value, optionLabel?, confidence, source, class,
/// reason, needsReview, questionKey }. `answersJSON` is the answers.json snapshot ("" = nothing learned).
- (NSArray<NSDictionary<NSString *, id> *> *)proposeAnswersForFieldObjects:(NSArray<NSDictionary *> *)fields
                                                                   profile:(NSDictionary *)profile
                                                                   answers:(nullable NSString *)answersJSON
                                                                  settings:(NSDictionary *)settings;

/// The user answered a question themselves: learn it, keyed by the question rather than the site.
/// Returns { answers: <new snapshot>, counter: <value-free counter name>, changed, class, refusal?, questionKey? },
/// or an empty dictionary when the core is unavailable. `when` may be nil (now).
- (NSDictionary<NSString *, id> *)recordCorrectionForFieldObject:(NSDictionary *)field
                                                            value:(NSString *)value
                                                          answers:(nullable NSString *)answersJSON
                                                               at:(nullable NSDate *)when;

/// { unmetRequired, terminalAllowed, reason?, firstUnmetLabel?, blockedTerminals, allowedTerminals }.
/// `accepted` are the signatures the user has already taken in this walk.
- (NSDictionary<NSString *, id> *)gateForFieldObjects:(NSArray<NSDictionary *> *)fields
                                                ghosts:(NSArray<NSDictionary *> *)ghosts
                                              accepted:(nullable NSArray<NSString *> *)accepted;

// ---------- Shabang anywhere (docs/anywhere.md) ----------

/// The next-action pass over what a window offers: affordances, the kind of place, its priors and role memory.
/// `candidates` are `SBField -toCandidateJSONObject` dictionaries, `signals` a `SBPageSignals -toJSONObject`,
/// `memoryJSON` the memory.json snapshot ("" = nothing learned), `options` may carry `threshold` and `limit`.
/// Returns `{ pageKind, pageConfidence, pageEvidence, cartCount, threshold, proposals: [...], top, unnamed }`,
/// or an empty dictionary when the core is unavailable. `top` is the one thing Shabang would propose, already
/// gated; the caller still refuses to press anything `locked`.
- (NSDictionary<NSString *, id> *)nextActionForCandidates:(NSArray<NSDictionary *> *)candidates
                                                   signals:(NSDictionary *)signals
                                                    memory:(nullable NSString *)memoryJSON
                                                   options:(nullable NSDictionary *)options;

/// One accept / dismissal / replacement folded into the role memory snapshot. Returns the NEW snapshot JSON,
/// or the old one unchanged when the core refuses it. `parts` is `{ pageKind, role, previousRole? }`.
- (nullable NSString *)roleMemoryByRecording:(nullable NSString *)memoryJSON
                                        parts:(NSDictionary *)parts
                                      outcome:(NSString *)outcome;

/// An empty, well-formed role-memory snapshot (what a first run writes). nil when the core is unavailable.
- (nullable NSString *)emptyRoleMemoryJSON;

/// Rule 2 for a proposal: the candidate's own flag, its role, and the shared lock test. Fails CLOSED.
- (BOOL)isCandidateLocked:(NSDictionary *)candidate role:(nullable NSString *)role;

@end

/// JSON helpers shared by the desktop modules. Both return nil instead of throwing.
NSString *_Nullable SBJSONString(id _Nullable object);
id _Nullable SBJSONParse(NSString *_Nullable json);

NS_ASSUME_NONNULL_END
