#import "SBCore.h"
#import "SBLog.h"
#import <CommonCrypto/CommonDigest.h>
#import <JavaScriptCore/JavaScriptCore.h>
#import <dlfcn.h>
#import "SBEventTap.h"

NSString *const SBCoreErrorDomain = @"dev.shabang.desktop.core";

/// Everything the native side calls. Loading fails when one is missing (a stale bundle must not half work).
static NSArray<NSString *> *SBRequiredExports(void) {
    return @[ @"demoProfile", @"defaultSettings", @"mapForm", @"ghostsFor", @"upgradeGhosts", @"isSensitive",
              @"isLockedAction", @"textFacts", @"formRequest", @"cleanAssignments", @"isPlaceholder", @"textPastAnswers" ];
}

NSString *SBJSONString(id object) {
    if (!object || ![NSJSONSerialization isValidJSONObject:object]) return nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:NULL];
    return data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
}

id SBJSONParse(NSString *json) {
    NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
    if (!data) return nil;
    return [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingFragmentsAllowed error:NULL];
}

static NSError *SBCoreMakeError(SBCoreError code, NSString *message) {
    return [NSError errorWithDomain:SBCoreErrorDomain code:code userInfo:@{ NSLocalizedDescriptionKey: message }];
}

@interface SBCore ()
@property (atomic, copy, readwrite, nullable) NSString *lastError;
@end

@implementation SBCore {
    JSVirtualMachine *_vm;
    JSContext *_context;
    JSValue *_core;
    NSLock *_lock;
    NSString *_currentFunction;
}

+ (instancetype)sharedCore {
    static SBCore *shared;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSString *path = [self defaultBundlePath];
        NSError *error;
        shared = path ? [[SBCore alloc] initWithBundlePath:path error:&error] : nil;
        if (!shared) SBLog(@"core: not loaded (%@)", error.localizedDescription ?: @"shabang-core.js not found");
    });
    return shared;
}

#ifndef SHABANG_CORE_SHA256
#define SHABANG_CORE_SHA256 ""
#endif

NSString *SBCorePinnedSHA256(void) {
    return @SHABANG_CORE_SHA256;
}

NSString *SBCoreSHA256OfFile(NSString *path) {
    NSData *data = path.length ? [NSData dataWithContentsOfFile:path options:NSDataReadingMappedIfSafe error:NULL] : nil;
    if (!data) return nil;
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
    NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
    for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) [hex appendFormat:@"%02x", digest[i]];
    return hex;
}

BOOL SBCoreBundleMatchesPin(NSString *path, NSString *pinned) {
    if (pinned.length == 0) return YES;   // a build without a pin (never `make lib`)
    return [SBCoreSHA256OfFile(path) isEqualToString:pinned.lowercaseString];
}

+ (NSString *)defaultBundlePath {
    NSString *path = [self discoveredBundlePath];
    // The JavaScript is where the fact allowlist and the wire filters live: only the exact bundle this library was
    // built with is loaded (the test runner, which points DESKTOP_CORE_PATH at the fresh build, is the exception).
    if (path && !SBRealKeyEventsForbidden() && !SBCoreBundleMatchesPin(path, SBCorePinnedSHA256())) {
        SBLog(@"core: %@ is not the shabang-core.js this library was built with; not loaded (make -C desktop core lib)", path.lastPathComponent);
        return nil;
    }
    return path;
}

+ (NSString *)discoveredBundlePath {
    NSFileManager *fm = NSFileManager.defaultManager;
    // Only the test runner may point the core elsewhere: a variable in the agent's environment (launchctl setenv)
    // must not swap the code that enforces what leaves the machine.
    NSString *env = SBRealKeyEventsForbidden() ? NSProcessInfo.processInfo.environment[@"DESKTOP_CORE_PATH"] : nil;
    if (env.length && [fm fileExistsAtPath:env]) return env;
    // Beside the image this code was loaded from: libshabang.dylib lives OUTSIDE Shabang.app, so that a new core
    // never changes the bundle's seal (docs/desktop-realworld.md section 1). The bundle is only a fallback.
    Dl_info image;
    if (dladdr((__bridge void *)[SBCore class], &image) && image.dli_fname) {
        NSString *beside = [@(image.dli_fname).stringByDeletingLastPathComponent stringByAppendingPathComponent:@"shabang-core.js"];
        if ([fm fileExistsAtPath:beside]) return beside;
    }
    NSString *resource = [NSBundle.mainBundle pathForResource:@"ghost-core" ofType:@"js"];
    if (resource) return resource;
    NSString *exeDir = NSBundle.mainBundle.executablePath.stringByDeletingLastPathComponent ?: @".";
    for (NSString *relative in @[ @"shabang-core.js", @"build/shabang-core.js", @"../build/shabang-core.js", @"../Resources/shabang-core.js" ]) {
        NSString *candidate = [exeDir stringByAppendingPathComponent:relative].stringByStandardizingPath;
        if ([fm fileExistsAtPath:candidate]) return candidate;
    }
    return nil;
}

- (instancetype)initWithBundlePath:(NSString *)path error:(NSError **)error {
    if (![NSFileManager.defaultManager fileExistsAtPath:path]) {
        if (error) *error = SBCoreMakeError(SBCoreErrorBundleNotFound, [NSString stringWithFormat:@"no core bundle at %@ (run `make core`)", path]);
        return nil;
    }
    NSString *source = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:NULL];
    if (!source) {
        if (error) *error = SBCoreMakeError(SBCoreErrorBundleUnreadable, [NSString stringWithFormat:@"cannot read %@", path]);
        return nil;
    }
    return [self initWithSource:source error:error];
}

- (instancetype)initWithSource:(NSString *)source error:(NSError **)error {
    if (!(self = [super init])) return nil;
    _lock = [[NSLock alloc] init];
    _vm = [[JSVirtualMachine alloc] init];
    _context = [[JSContext alloc] initWithVirtualMachine:_vm];
    _context.name = @"GhostCore";

    __weak SBCore *weakSelf = self;
    _context.exceptionHandler = ^(JSContext *context, JSValue *exception) {
        [weakSelf recordException:exception];
    };

    [_context evaluateScript:source withSourceURL:[NSURL URLWithString:@"shabang-core.js"]];
    if (self.lastError) {
        if (error) *error = SBCoreMakeError(SBCoreErrorEvaluationFailed, [NSString stringWithFormat:@"shabang-core.js failed to evaluate: %@", self.lastError]);
        return nil;
    }
    _core = _context[@"GhostCore"];
    if (!_core.isObject) {
        if (error) *error = SBCoreMakeError(SBCoreErrorEvaluationFailed, @"shabang-core.js does not define GhostCore");
        return nil;
    }
    NSMutableArray<NSString *> *missing = [NSMutableArray array];
    for (NSString *name in SBRequiredExports()) {
        if (![self valueIsFunction:_core[name]]) [missing addObject:name];
    }
    self.lastError = nil;
    if (missing.count) {
        if (error) *error = SBCoreMakeError(SBCoreErrorMissingExport, [NSString stringWithFormat:@"GhostCore is missing: %@ (stale bundle? run `make core`)", [missing componentsJoinedByString:@", "]]);
        return nil;
    }
    return self;
}

- (BOOL)valueIsFunction:(JSValue *)value {
    if (!value.isObject) return NO;
    return JSObjectIsFunction(_context.JSGlobalContextRef, JSValueToObject(_context.JSGlobalContextRef, value.JSValueRef, NULL));
}

/// Exception text can quote its input (a JSON parse error names the offending token), and the input can be
/// a profile or a field value. Only the error's name, our own "GhostCore:" messages and the line are kept.
- (void)recordException:(JSValue *)exception {
    NSString *name = [exception[@"name"] isString] ? [exception[@"name"] toString] : @"Error";
    NSString *message = [exception[@"message"] isString] ? [exception[@"message"] toString] : @"";
    NSString *safeMessage = [message hasPrefix:@"GhostCore:"] ? message : @"(message withheld)";
    NSNumber *line = [exception[@"line"] isNumber] ? [exception[@"line"] toNumber] : @0;
    NSString *where = _currentFunction ? [NSString stringWithFormat:@"GhostCore.%@", _currentFunction] : @"shabang-core.js";
    NSString *summary = [NSString stringWithFormat:@"%@ in %@ line %@ %@", name, where, line, safeMessage];
    self.lastError = summary;
    SBLog(@"core: JS exception: %@", summary);
    _context.exception = nil;
}

#pragma mark - raw bridge

- (JSValue *)invoke:(NSString *)function arguments:(NSArray<NSString *> *)arguments {
    // Caller holds _lock.
    _currentFunction = function;
    self.lastError = nil;
    JSValue *result = [_core invokeMethod:function withArguments:arguments];
    _currentFunction = nil;
    return self.lastError ? nil : result;
}

- (NSString *)callString:(NSString *)function arguments:(NSArray<NSString *> *)arguments {
    [_lock lock];
    JSValue *result = [self invoke:function arguments:arguments];
    NSString *string = result.isString ? [result toString] : nil;
    [_lock unlock];
    return string;
}

- (BOOL)callBool:(NSString *)function arguments:(NSArray<NSString *> *)arguments fallback:(BOOL)fallback {
    [_lock lock];
    JSValue *result = [self invoke:function arguments:arguments];
    BOOL value = result.isBoolean ? [result toBool] : fallback;
    [_lock unlock];
    return value;
}

- (NSArray *)arrayFrom:(NSString *)function arguments:(NSArray<NSString *> *)arguments {
    id parsed = SBJSONParse([self callString:function arguments:arguments]);
    return [parsed isKindOfClass:[NSArray class]] ? parsed : @[];
}

- (NSDictionary *)dictionaryFrom:(NSString *)function arguments:(NSArray<NSString *> *)arguments {
    id parsed = SBJSONParse([self callString:function arguments:arguments]);
    return [parsed isKindOfClass:[NSDictionary class]] ? parsed : @{};
}

#pragma mark - the answer engine and the gate

/// ISO-8601 with milliseconds, the format `Date.parse` in the core reads back exactly.
static NSString *SBISODate(NSDate *when) {
    static NSISO8601DateFormatter *formatter;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        formatter = [[NSISO8601DateFormatter alloc] init];
        formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
    });
    return [formatter stringFromDate:when];
}

#pragma mark - typed wrappers

- (NSDictionary<NSString *, id> *)demoProfile {
    return [self dictionaryFrom:@"demoProfile" arguments:@[]];
}

- (NSDictionary<NSString *, id> *)defaultSettings {
    return [self dictionaryFrom:@"defaultSettings" arguments:@[]];
}

- (NSArray<NSDictionary<NSString *, id> *> *)mapFields:(NSArray<SBField *> *)fields factKeys:(NSArray<NSString *> *)factKeys {
    return [self mapFieldObjects:[SBField JSONObjectsForFields:fields] factKeys:factKeys];
}

- (NSArray<NSDictionary<NSString *, id> *> *)mapFieldObjects:(NSArray<NSDictionary *> *)fields factKeys:(NSArray<NSString *> *)factKeys {
    NSString *fieldsJson = SBJSONString(fields), *keysJson = SBJSONString(factKeys);
    if (!fieldsJson || !keysJson) return @[];
    return [self arrayFrom:@"mapForm" arguments:@[ fieldsJson, keysJson ]];
}

- (NSArray *)ghosts:(NSString *)function
       fieldObjects:(NSArray<NSDictionary *> *)fields
             second:(NSArray<NSDictionary *> *)assignments
            profile:(NSDictionary *)profile
           settings:(NSDictionary *)settings
             source:(NSString *)source
            options:(NSDictionary *)options {
    NSString *fieldsJson = SBJSONString(fields), *assignmentsJson = SBJSONString(assignments);
    NSString *profileJson = SBJSONString(profile), *settingsJson = SBJSONString(settings);
    NSString *optionsJson = SBJSONString(options ?: @{}) ?: @"{}";
    // No ghosts at all beats ghosts built from half an input.
    if (!fieldsJson || !assignmentsJson || !profileJson || !settingsJson) return @[];
    return [self arrayFrom:function arguments:@[ fieldsJson, assignmentsJson, profileJson, settingsJson, source ?: @"offline", optionsJson ]];
}

- (NSArray<NSDictionary<NSString *, id> *> *)ghostsForFields:(NSArray<SBField *> *)fields
                                                  assignments:(NSArray<NSDictionary *> *)assignments
                                                      profile:(NSDictionary *)profile
                                                     settings:(NSDictionary *)settings
                                                       source:(NSString *)source
                                                      options:(NSDictionary *)options {
    return [self ghosts:@"ghostsFor" fieldObjects:[SBField JSONObjectsForFields:fields] second:assignments profile:profile settings:settings source:source options:options];
}

- (NSArray<NSDictionary<NSString *, id> *> *)ghostsForFieldObjects:(NSArray<NSDictionary *> *)fields
                                                        assignments:(NSArray<NSDictionary *> *)assignments
                                                            profile:(NSDictionary *)profile
                                                           settings:(NSDictionary *)settings
                                                             source:(NSString *)source
                                                            options:(NSDictionary *)options {
    return [self ghosts:@"ghostsFor" fieldObjects:fields second:assignments profile:profile settings:settings source:source options:options];
}

- (NSArray<NSDictionary<NSString *, id> *> *)upgradeGhostsForFields:(NSArray<SBField *> *)fields
                                                              served:(NSArray<NSDictionary *> *)served
                                                             profile:(NSDictionary *)profile
                                                            settings:(NSDictionary *)settings
                                                              source:(NSString *)source
                                                             options:(NSDictionary *)options {
    return [self ghosts:@"upgradeGhosts" fieldObjects:[SBField JSONObjectsForFields:fields] second:served profile:profile settings:settings source:source options:options];
}

- (BOOL)isSensitive:(NSDictionary<NSString *, id> *)probe {
    NSString *json = SBJSONString(probe);
    if (!json) return YES;
    return [self callBool:@"isSensitive" arguments:@[ json ] fallback:YES];
}

- (BOOL)isSensitiveLabel:(NSString *)label placeholder:(NSString *)placeholder identifier:(NSString *)identifier {
    NSMutableDictionary *probe = [NSMutableDictionary dictionary];
    if (label) probe[@"label"] = label;
    if (placeholder) probe[@"placeholder"] = placeholder;
    if (identifier) probe[@"id"] = identifier;
    return [self isSensitive:probe];
}

- (BOOL)isLockedAction:(NSDictionary<NSString *, id> *)probe {
    NSString *json = SBJSONString(probe);
    if (!json) return YES;
    return [self callBool:@"isLockedAction" arguments:@[ json ] fallback:YES];
}

- (BOOL)isLockedActionText:(NSString *)text {
    return [self isLockedAction:@{ @"text": text ?: @"" }];
}

- (NSDictionary<NSString *, NSString *> *)textFactsForProfile:(NSDictionary *)profile {
    NSString *json = SBJSONString(profile);
    if (!json) return @{};
    return [self dictionaryFrom:@"textFacts" arguments:@[ json ]];
}

- (NSArray<NSDictionary<NSString *, NSString *> *> *)pastAnswersForProfile:(NSDictionary *)profile label:(NSString *)label {
    NSString *json = SBJSONString(profile);
    if (!json) return @[];
    NSMutableArray<NSDictionary<NSString *, NSString *> *> *out = [NSMutableArray array];
    for (id item in [self arrayFrom:@"textPastAnswers" arguments:@[ json, label ?: @"" ]]) {
        if (![item isKindOfClass:[NSDictionary class]]) continue;
        NSString *question = item[@"question"], *answer = item[@"answer"];
        if ([question isKindOfClass:[NSString class]] && [answer isKindOfClass:[NSString class]]) [out addObject:@{ @"question": question, @"answer": answer }];
    }
    return out;
}

- (NSData *)formRequestBodyForFieldObjects:(NSArray<NSDictionary *> *)fields
                                  factKeys:(NSArray<NSString *> *)factKeys
                                    origin:(NSString *)origin
                             formSignature:(NSString *)formSignature {
    NSString *fieldsJson = SBJSONString(fields), *keysJson = SBJSONString(factKeys);
    if (!fieldsJson || !keysJson) return nil;
    NSString *body = [self callString:@"formRequest" arguments:@[ fieldsJson, keysJson, origin ?: @"", formSignature ?: @"" ]];
    if (!body || [body isEqualToString:@"null"]) return nil;
    return [body dataUsingEncoding:NSUTF8StringEncoding];
}

- (NSArray<NSDictionary<NSString *, id> *> *)cleanAssignments:(id)rawAssignments {
    NSString *json = SBJSONString(rawAssignments);
    if (!json) return @[];
    return [self arrayFrom:@"cleanAssignments" arguments:@[ json ]];
}

#pragma mark - SBSafetyChecking

- (BOOL)isSensitiveProbe:(NSDictionary<NSString *, id> *)probe {
    return [self isSensitive:probe];
}

- (BOOL)isLockedProbe:(NSDictionary<NSString *, id> *)probe {
    return [self isLockedAction:probe];
}

- (NSArray<NSDictionary<NSString *, id> *> *)proposeAnswersForFieldObjects:(NSArray<NSDictionary *> *)fields
                                                                   profile:(NSDictionary *)profile
                                                                   answers:(NSString *)answersJSON
                                                                  settings:(NSDictionary *)settings {
    NSString *fieldsJson = SBJSONString(fields), *profileJson = SBJSONString(profile), *settingsJson = SBJSONString(settings);
    if (!fieldsJson || !profileJson || !settingsJson) return @[];
    return [self arrayFrom:@"proposeAnswers" arguments:@[ fieldsJson, profileJson, answersJSON ?: @"", settingsJson ]];
}

- (NSDictionary<NSString *, id> *)recordCorrectionForFieldObject:(NSDictionary *)field
                                                            value:(NSString *)value
                                                          answers:(NSString *)answersJSON
                                                               at:(NSDate *)when {
    NSString *fieldJson = SBJSONString(field);
    if (!fieldJson || ![value isKindOfClass:[NSString class]]) return @{};
    return [self dictionaryFrom:@"recordCorrection"
                      arguments:@[ fieldJson, value, answersJSON ?: @"", SBISODate(when ?: [NSDate date]) ]];
}

- (NSDictionary<NSString *, id> *)gateForFieldObjects:(NSArray<NSDictionary *> *)fields
                                                ghosts:(NSArray<NSDictionary *> *)ghosts
                                              accepted:(NSArray<NSString *> *)accepted {
    NSString *fieldsJson = SBJSONString(fields), *ghostsJson = SBJSONString(ghosts ?: @[]);
    NSString *optionsJson = SBJSONString(@{ @"accepted": accepted ?: @[] }) ?: @"{}";
    if (!fieldsJson || !ghostsJson) return @{};
    return [self dictionaryFrom:@"gateFor" arguments:@[ fieldsJson, ghostsJson, optionsJson ]];
}

- (BOOL)isPlaceholderValue:(NSString *)value label:(NSString *)label {
    return [self callBool:@"isPlaceholder" arguments:@[ value ?: @"", label ?: @"" ] fallback:NO];
}

#pragma mark - Shabang anywhere (docs/anywhere.md)

- (NSDictionary<NSString *, id> *)nextActionForCandidates:(NSArray<NSDictionary *> *)candidates
                                                   signals:(NSDictionary *)signals
                                                    memory:(NSString *)memoryJSON
                                                   options:(NSDictionary *)options {
    NSString *candidatesJson = SBJSONString(candidates ?: @[]), *signalsJson = SBJSONString(signals ?: @{});
    NSString *optionsJson = SBJSONString(options ?: @{}) ?: @"{}";
    // No proposal at all beats one built from half an input (rule 4).
    if (!candidatesJson || !signalsJson) return @{};
    return [self dictionaryFrom:@"nextAction" arguments:@[ candidatesJson, signalsJson, memoryJSON ?: @"", optionsJson ]];
}

- (NSString *)roleMemoryByRecording:(NSString *)memoryJSON parts:(NSDictionary *)parts outcome:(NSString *)outcome {
    NSString *partsJson = SBJSONString(parts ?: @{});
    if (!partsJson) return memoryJSON;
    NSString *updated = [self callString:@"recordRoleOutcome" arguments:@[ memoryJSON ?: @"", partsJson, outcome ?: @"" ]];
    return updated ?: memoryJSON;
}

- (NSString *)emptyRoleMemoryJSON {
    return [self callString:@"emptyRoleMemory" arguments:@[]];
}

- (BOOL)isCandidateLocked:(NSDictionary *)candidate role:(NSString *)role {
    NSString *json = SBJSONString(candidate);
    if (!json) return YES; // when in doubt, lock
    return [self callBool:@"lockedForCandidate" arguments:@[ json, role ?: @"unknown" ] fallback:YES];
}

@end
