#import "GHCore.h"
#import "GHLog.h"
#import <JavaScriptCore/JavaScriptCore.h>

NSString *const GHCoreErrorDomain = @"dev.ghost.desktop.core";

/// Everything the native side calls. Loading fails when one is missing (a stale bundle must not half work).
static NSArray<NSString *> *GHRequiredExports(void) {
    return @[ @"demoProfile", @"defaultSettings", @"mapForm", @"ghostsFor", @"upgradeGhosts", @"isSensitive",
              @"isLockedAction", @"textFacts", @"formRequest", @"cleanAssignments", @"isPlaceholder" ];
}

NSString *GHJSONString(id object) {
    if (!object || ![NSJSONSerialization isValidJSONObject:object]) return nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:NULL];
    return data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
}

id GHJSONParse(NSString *json) {
    NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
    if (!data) return nil;
    return [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingFragmentsAllowed error:NULL];
}

static NSError *GHCoreMakeError(GHCoreError code, NSString *message) {
    return [NSError errorWithDomain:GHCoreErrorDomain code:code userInfo:@{ NSLocalizedDescriptionKey: message }];
}

@interface GHCore ()
@property (atomic, copy, readwrite, nullable) NSString *lastError;
@end

@implementation GHCore {
    JSVirtualMachine *_vm;
    JSContext *_context;
    JSValue *_core;
    NSLock *_lock;
    NSString *_currentFunction;
}

+ (instancetype)sharedCore {
    static GHCore *shared;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSString *path = [self defaultBundlePath];
        NSError *error;
        shared = path ? [[GHCore alloc] initWithBundlePath:path error:&error] : nil;
        if (!shared) GHLog(@"core: not loaded (%@)", error.localizedDescription ?: @"ghost-core.js not found");
    });
    return shared;
}

+ (NSString *)defaultBundlePath {
    NSFileManager *fm = NSFileManager.defaultManager;
    NSString *env = NSProcessInfo.processInfo.environment[@"DESKTOP_CORE_PATH"];
    if (env.length && [fm fileExistsAtPath:env]) return env;
    NSString *resource = [NSBundle.mainBundle pathForResource:@"ghost-core" ofType:@"js"];
    if (resource) return resource;
    NSString *exeDir = NSBundle.mainBundle.executablePath.stringByDeletingLastPathComponent ?: @".";
    for (NSString *relative in @[ @"ghost-core.js", @"build/ghost-core.js", @"../build/ghost-core.js", @"../Resources/ghost-core.js" ]) {
        NSString *candidate = [exeDir stringByAppendingPathComponent:relative].stringByStandardizingPath;
        if ([fm fileExistsAtPath:candidate]) return candidate;
    }
    return nil;
}

- (instancetype)initWithBundlePath:(NSString *)path error:(NSError **)error {
    if (![NSFileManager.defaultManager fileExistsAtPath:path]) {
        if (error) *error = GHCoreMakeError(GHCoreErrorBundleNotFound, [NSString stringWithFormat:@"no core bundle at %@ (run `make core`)", path]);
        return nil;
    }
    NSString *source = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:NULL];
    if (!source) {
        if (error) *error = GHCoreMakeError(GHCoreErrorBundleUnreadable, [NSString stringWithFormat:@"cannot read %@", path]);
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

    __weak GHCore *weakSelf = self;
    _context.exceptionHandler = ^(JSContext *context, JSValue *exception) {
        [weakSelf recordException:exception];
    };

    [_context evaluateScript:source withSourceURL:[NSURL URLWithString:@"ghost-core.js"]];
    if (self.lastError) {
        if (error) *error = GHCoreMakeError(GHCoreErrorEvaluationFailed, [NSString stringWithFormat:@"ghost-core.js failed to evaluate: %@", self.lastError]);
        return nil;
    }
    _core = _context[@"GhostCore"];
    if (!_core.isObject) {
        if (error) *error = GHCoreMakeError(GHCoreErrorEvaluationFailed, @"ghost-core.js does not define GhostCore");
        return nil;
    }
    NSMutableArray<NSString *> *missing = [NSMutableArray array];
    for (NSString *name in GHRequiredExports()) {
        if (![self valueIsFunction:_core[name]]) [missing addObject:name];
    }
    self.lastError = nil;
    if (missing.count) {
        if (error) *error = GHCoreMakeError(GHCoreErrorMissingExport, [NSString stringWithFormat:@"GhostCore is missing: %@ (stale bundle? run `make core`)", [missing componentsJoinedByString:@", "]]);
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
    NSString *where = _currentFunction ? [NSString stringWithFormat:@"GhostCore.%@", _currentFunction] : @"ghost-core.js";
    NSString *summary = [NSString stringWithFormat:@"%@ in %@ line %@ %@", name, where, line, safeMessage];
    self.lastError = summary;
    GHLog(@"core: JS exception: %@", summary);
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
    id parsed = GHJSONParse([self callString:function arguments:arguments]);
    return [parsed isKindOfClass:[NSArray class]] ? parsed : @[];
}

- (NSDictionary *)dictionaryFrom:(NSString *)function arguments:(NSArray<NSString *> *)arguments {
    id parsed = GHJSONParse([self callString:function arguments:arguments]);
    return [parsed isKindOfClass:[NSDictionary class]] ? parsed : @{};
}

#pragma mark - typed wrappers

- (NSDictionary<NSString *, id> *)demoProfile {
    return [self dictionaryFrom:@"demoProfile" arguments:@[]];
}

- (NSDictionary<NSString *, id> *)defaultSettings {
    return [self dictionaryFrom:@"defaultSettings" arguments:@[]];
}

- (NSArray<NSDictionary<NSString *, id> *> *)mapFields:(NSArray<GHField *> *)fields factKeys:(NSArray<NSString *> *)factKeys {
    return [self mapFieldObjects:[GHField JSONObjectsForFields:fields] factKeys:factKeys];
}

- (NSArray<NSDictionary<NSString *, id> *> *)mapFieldObjects:(NSArray<NSDictionary *> *)fields factKeys:(NSArray<NSString *> *)factKeys {
    NSString *fieldsJson = GHJSONString(fields), *keysJson = GHJSONString(factKeys);
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
    NSString *fieldsJson = GHJSONString(fields), *assignmentsJson = GHJSONString(assignments);
    NSString *profileJson = GHJSONString(profile), *settingsJson = GHJSONString(settings);
    NSString *optionsJson = GHJSONString(options ?: @{}) ?: @"{}";
    // No ghosts at all beats ghosts built from half an input.
    if (!fieldsJson || !assignmentsJson || !profileJson || !settingsJson) return @[];
    return [self arrayFrom:function arguments:@[ fieldsJson, assignmentsJson, profileJson, settingsJson, source ?: @"offline", optionsJson ]];
}

- (NSArray<NSDictionary<NSString *, id> *> *)ghostsForFields:(NSArray<GHField *> *)fields
                                                  assignments:(NSArray<NSDictionary *> *)assignments
                                                      profile:(NSDictionary *)profile
                                                     settings:(NSDictionary *)settings
                                                       source:(NSString *)source
                                                      options:(NSDictionary *)options {
    return [self ghosts:@"ghostsFor" fieldObjects:[GHField JSONObjectsForFields:fields] second:assignments profile:profile settings:settings source:source options:options];
}

- (NSArray<NSDictionary<NSString *, id> *> *)ghostsForFieldObjects:(NSArray<NSDictionary *> *)fields
                                                        assignments:(NSArray<NSDictionary *> *)assignments
                                                            profile:(NSDictionary *)profile
                                                           settings:(NSDictionary *)settings
                                                             source:(NSString *)source
                                                            options:(NSDictionary *)options {
    return [self ghosts:@"ghostsFor" fieldObjects:fields second:assignments profile:profile settings:settings source:source options:options];
}

- (NSArray<NSDictionary<NSString *, id> *> *)upgradeGhostsForFields:(NSArray<GHField *> *)fields
                                                              served:(NSArray<NSDictionary *> *)served
                                                             profile:(NSDictionary *)profile
                                                            settings:(NSDictionary *)settings
                                                              source:(NSString *)source
                                                             options:(NSDictionary *)options {
    return [self ghosts:@"upgradeGhosts" fieldObjects:[GHField JSONObjectsForFields:fields] second:served profile:profile settings:settings source:source options:options];
}

- (BOOL)isSensitive:(NSDictionary<NSString *, id> *)probe {
    NSString *json = GHJSONString(probe);
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
    NSString *json = GHJSONString(probe);
    if (!json) return YES;
    return [self callBool:@"isLockedAction" arguments:@[ json ] fallback:YES];
}

- (BOOL)isLockedActionText:(NSString *)text {
    return [self isLockedAction:@{ @"text": text ?: @"" }];
}

- (NSDictionary<NSString *, NSString *> *)textFactsForProfile:(NSDictionary *)profile {
    NSString *json = GHJSONString(profile);
    if (!json) return @{};
    return [self dictionaryFrom:@"textFacts" arguments:@[ json ]];
}

- (NSData *)formRequestBodyForFieldObjects:(NSArray<NSDictionary *> *)fields
                                  factKeys:(NSArray<NSString *> *)factKeys
                                    origin:(NSString *)origin
                             formSignature:(NSString *)formSignature {
    NSString *fieldsJson = GHJSONString(fields), *keysJson = GHJSONString(factKeys);
    if (!fieldsJson || !keysJson) return nil;
    NSString *body = [self callString:@"formRequest" arguments:@[ fieldsJson, keysJson, origin ?: @"", formSignature ?: @"" ]];
    if (!body || [body isEqualToString:@"null"]) return nil;
    return [body dataUsingEncoding:NSUTF8StringEncoding];
}

- (NSArray<NSDictionary<NSString *, id> *> *)cleanAssignments:(id)rawAssignments {
    NSString *json = GHJSONString(rawAssignments);
    if (!json) return @[];
    return [self arrayFrom:@"cleanAssignments" arguments:@[ json ]];
}

#pragma mark - GHSafetyChecking

- (BOOL)isSensitiveProbe:(NSDictionary<NSString *, id> *)probe {
    return [self isSensitive:probe];
}

- (BOOL)isLockedProbe:(NSDictionary<NSString *, id> *)probe {
    return [self isLockedAction:probe];
}

- (BOOL)isPlaceholderValue:(NSString *)value label:(NSString *)label {
    return [self callBool:@"isPlaceholder" arguments:@[ value ?: @"", label ?: @"" ] fallback:NO];
}

@end
