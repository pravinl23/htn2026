// GHCore: JavaScriptCore bridge to build/ghost-core.js (global `GhostCore`, see desktop/core/entry.ts).
// Strings in, strings out underneath; typed Objective-C wrappers on top.
//
// Threading: one JSContext guarded by a lock, so any thread may call in. Calls are synchronous and
// cheap (a whole form maps in well under a millisecond), but never call from the event-tap callback.
#import <Foundation/Foundation.h>
#import "GHField.h"
#import "GHSafetyChecking.h"

NS_ASSUME_NONNULL_BEGIN

extern NSString *const GHCoreErrorDomain;

typedef NS_ENUM(NSInteger, GHCoreError) {
    GHCoreErrorBundleNotFound = 1,
    GHCoreErrorBundleUnreadable = 2,
    GHCoreErrorEvaluationFailed = 3,
    GHCoreErrorMissingExport = 4,
};

/// SHA-256 (lower-case hex) of the ghost-core.js this library was built with (`make lib` embeds it); "" when unpinned.
NSString *GHCorePinnedSHA256(void);
/// SHA-256 of a file, lower-case hex; nil when it cannot be read.
NSString *_Nullable GHCoreSHA256OfFile(NSString *_Nullable path);
/// YES when `pinned` is empty or equals the file's SHA-256.
BOOL GHCoreBundleMatchesPin(NSString *_Nullable path, NSString *_Nullable pinned);

/// Conforms to GHSafetyChecking (capture's view of the two shared safety rules); both answers fail CLOSED.
@interface GHCore : NSObject <GHSafetyChecking>

/// Process-wide instance, loaded from `+defaultBundlePath`. nil (and logged once) when the bundle cannot be loaded.
+ (nullable instancetype)sharedCore;

/// DESKTOP_CORE_PATH (the test runner only: ignored in Ghost itself), else ghost-core.js beside the image this code
/// was loaded from (libghost.dylib), else Ghost.app/Contents/Resources/ghost-core.js, else ghost-core.js or
/// build/ghost-core.js next to the executable. Outside the test runner the file must match GHCorePinnedSHA256, or
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
- (NSArray<NSDictionary<NSString *, id> *> *)mapFields:(NSArray<GHField *> *)fields factKeys:(NSArray<NSString *> *)factKeys;
/// Same on CapturedField JSON objects (tests, caches).
- (NSArray<NSDictionary<NSString *, id> *> *)mapFieldObjects:(NSArray<NSDictionary *> *)fields factKeys:(NSArray<NSString *> *)factKeys;

/// Ghost dictionaries { signature, action, value?, displayText, confidence, locked, source } in field
/// order, lock ghost last. `options` may carry @"keepLock" (NSNumber BOOL) and @"lockSignature".
- (NSArray<NSDictionary<NSString *, id> *> *)ghostsForFields:(NSArray<GHField *> *)fields
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
- (NSArray<NSDictionary<NSString *, id> *> *)upgradeGhostsForFields:(NSArray<GHField *> *)fields
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

/// The non-sensitive subset of profile facts allowed to go to /v1/ghost-text.
- (NSDictionary<NSString *, NSString *> *)textFactsForProfile:(NSDictionary *)profile;
/// Past answers a /v1/ghost-text draft for `label` may see (core textPastAnswers): at most three, only questions
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

@end

/// JSON helpers shared by the desktop modules. Both return nil instead of throwing.
NSString *_Nullable GHJSONString(id _Nullable object);
id _Nullable GHJSONParse(NSString *_Nullable json);

NS_ASSUME_NONNULL_END
