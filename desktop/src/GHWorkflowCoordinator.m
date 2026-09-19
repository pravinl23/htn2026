#import "GHWorkflowCoordinator.h"
#import "GHCapture.h"
#import "GHComboBoxDriver.h"

static const NSTimeInterval GHWorkflowTimeout = 8.0;
static const NSUInteger GHWorkflowMaxText = 600;

static NSString *GHWorkflowText(id value, NSUInteger limit) {
    if (![value isKindOfClass:NSString.class]) return nil;
    NSString *trimmed = [value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (!trimmed.length) return nil;
    return trimmed.length <= limit ? trimmed : [trimmed substringToIndex:limit];
}

static NSString *GHNormalizedURL(NSString *raw) {
    NSString *text = GHWorkflowText(raw, 2048);
    NSURLComponents *parts = text ? [NSURLComponents componentsWithString:text] : nil;
    if (!parts || ![@[ @"http", @"https" ] containsObject:parts.scheme.lowercaseString] || !parts.host.length || parts.user.length || parts.password.length) return nil;
    parts.path = [parts.path stringByReplacingOccurrencesOfString:@"/+$" withString:@"" options:NSRegularExpressionSearch range:NSMakeRange(0, parts.path.length)];
    parts.query = nil;
    parts.fragment = nil;
    return parts.string;
}

static BOOL GHWorkflowTextIsPrivate(NSString *text) {
    static NSRegularExpression *contact;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        contact = [NSRegularExpression regularExpressionWithPattern:@"[^\\s@]+@[^\\s@]+\\.[^\\s@]+|\\+?\\d[\\d\\s().-]{6,}\\d" options:0 error:NULL];
    });
    if (text.length == 0) return NO;
    if ([contact firstMatchInString:text options:0 range:NSMakeRange(0, text.length)]) return YES;
    return [GHCapture nativeLooksSensitive:text] || [GHComboBoxDriver isDemographicText:text];
}

/// A field the workflow request must not describe at all: secure, sensitive-looking or an EEO / demographic question.
static BOOL GHWorkflowFieldIsPrivate(GHField *field) {
    if ([field.inputType isEqualToString:@"password"]) return YES;
    NSString *naming = [NSString stringWithFormat:@"%@ %@ %@ %@", field.label ?: @"", field.identifier ?: @"", field.inputType ?: @"", field.placeholder ?: @""];
    if ([GHCapture nativeLooksSensitive:naming]) return YES;
    for (NSString *text in @[ field.label ?: @"", field.identifier ?: @"", field.placeholder ?: @"", field.context ?: @"" ]) {
        if ([GHComboBoxDriver isDemographicText:text]) return YES;
    }
    return NO;
}

@interface GHWorkflowSuggestion ()
@property (nonatomic, readwrite, copy) NSString *workflowIdentifier;
@property (nonatomic, readwrite, copy) NSString *actionIdentifier;
@property (nonatomic, readwrite, copy) NSString *title;
@property (nonatomic, readwrite, copy) NSString *preview;
@property (nonatomic, readwrite, copy) NSString *safety;
@property (nonatomic, readwrite, copy) NSString *confirmation;
@property (nonatomic, readwrite) double confidence;
@property (nonatomic, readwrite) BOOL simulated;
+ (nullable instancetype)fromJSONObject:(nullable id)object;
@end

@implementation GHWorkflowSuggestion
+ (instancetype)fromJSONObject:(id)object {
    if (![object isKindOfClass:NSDictionary.class]) return nil;
    NSDictionary *json = object;
    NSDictionary *action = [json[@"action"] isKindOfClass:NSDictionary.class] ? json[@"action"] : nil;
    NSString *workflow = GHWorkflowText(json[@"workflowId"], 120);
    NSString *identifier = GHWorkflowText(action[@"id"], 120);
    NSString *title = GHWorkflowText(action[@"title"], 240);
    NSString *preview = GHWorkflowText(json[@"preview"], 800);
    NSString *safety = GHWorkflowText(action[@"safety"], 40);
    NSString *confirmation = GHWorkflowText(action[@"confirmation"], 40);
    if (!workflow || !identifier || !title || !preview || ![@[ @"read", @"reversible", @"high-impact" ] containsObject:safety] || ![@[ @"tab", @"review", @"explicit" ] containsObject:confirmation]) return nil;
    GHWorkflowSuggestion *suggestion = [[self alloc] init];
    suggestion.workflowIdentifier = workflow;
    suggestion.actionIdentifier = identifier;
    suggestion.title = title;
    suggestion.preview = preview;
    suggestion.safety = safety;
    suggestion.confirmation = confirmation;
    suggestion.confidence = MAX(0.0, MIN(1.0, [json[@"confidence"] doubleValue]));
    suggestion.simulated = [json[@"simulated"] boolValue];
    return suggestion;
}
@end

@implementation GHWorkflowContextBuilder

+ (NSDictionary<NSString *,id> *)snapshotWithApplicationName:(NSString *)applicationName
                                              bundleIdentifier:(NSString *)bundleIdentifier
                                                   windowTitle:(NSString *)windowTitle
                                                  focusedField:(GHField *)focusedField
                                                    nearbyText:(NSArray<NSString *> *)nearbyText
                                             safeValueToInsert:(NSString *)safeValueToInsert
                                             connectedToolkits:(NSArray<NSString *> *)connectedToolkits
                                                     workflow:(NSDictionary<NSString *,id> *)workflow {
    NSMutableDictionary *snapshot = [@{ @"version": @1,
                                        @"timestamp": @((long long)(NSDate.date.timeIntervalSince1970 * 1000.0)),
                                        @"activeApplication": @{ @"name": GHWorkflowText(applicationName, 100) ?: @"Unknown",
                                                                  @"bundleIdentifier": GHWorkflowText(bundleIdentifier, 180) ?: @"unknown" } } mutableCopy];
    // `windowTitle` never crosses the wire: titles name documents, mailboxes and tabs. The parameter stays for callers.
    (void)windowTitle;

    if (focusedField && !GHWorkflowFieldIsPrivate(focusedField)) {
        NSMutableDictionary *focused = [@{ @"role": GHWorkflowText(focusedField.kind, 80) ?: @"other" } mutableCopy];
        NSString *label = GHWorkflowText(focusedField.label, 180);
        NSString *identifier = GHWorkflowText(focusedField.identifier, 160);
        NSString *prepared = GHWorkflowText(safeValueToInsert, GHWorkflowMaxText);
        if (label) focused[@"label"] = label;
        if (identifier) focused[@"identifier"] = identifier;
        // Whether the field holds something, never what: what the user typed stays on the machine.
        focused[@"hasValue"] = @(focusedField.value.length > 0);
        if (prepared) focused[@"safeValueToInsert"] = prepared;
        snapshot[@"focusedElement"] = focused;
    }

    NSMutableArray *nearby = [NSMutableArray array];
    for (id item in [nearbyText isKindOfClass:NSArray.class] ? nearbyText : @[]) {
        NSString *line = GHWorkflowText(item, GHWorkflowMaxText);
        // Page text only (the caller's contract): a line with contact data or a sensitive / EEO word is dropped.
        if (line && !GHWorkflowTextIsPrivate(line)) [nearby addObject:line];
        if (nearby.count == 10) break;
    }
    if (nearby.count) snapshot[@"nearbyText"] = nearby;

    NSMutableOrderedSet *toolkits = [NSMutableOrderedSet orderedSet];
    for (id item in [connectedToolkits isKindOfClass:NSArray.class] ? connectedToolkits : @[]) {
        NSString *toolkit = GHWorkflowText(item, 80).lowercaseString;
        if (toolkit) [toolkits addObject:toolkit];
        if (toolkits.count == 20) break;
    }
    if (toolkits.count) snapshot[@"connectedToolkits"] = toolkits.array;
    if ([workflow isKindOfClass:NSDictionary.class]) {
        NSString *identifier = GHWorkflowText(workflow[@"id"], 120);
        NSString *kind = GHWorkflowText(workflow[@"kind"], 60);
        NSString *step = GHWorkflowText(workflow[@"step"], 80);
        NSString *status = GHWorkflowText(workflow[@"status"], 40);
        if (identifier && kind && step && [@[ @"active", @"completed", @"failed", @"cancelled" ] containsObject:status])
            snapshot[@"workflow"] = @{ @"id": identifier, @"kind": kind, @"step": step, @"status": status };
    }
    return snapshot;
}

@end

@interface GHWorkflowCoordinator ()
@property (nonatomic, readwrite, copy) NSString *userId;
@property (nonatomic, readwrite, nullable) GHWorkflowSuggestion *currentSuggestion;
@property (nonatomic, readwrite, copy, nullable) NSDictionary<NSString *, id> *workflowState;
@property (nonatomic, readwrite) BOOL busy;
@property (nonatomic, copy, nullable) NSString *executionToken;
@property (nonatomic, strong) NSURLSession *session;
@end

@implementation GHWorkflowCoordinator

- (instancetype)initWithBaseURLString:(NSString *)baseURLString userId:(NSString *)userId configuration:(NSURLSessionConfiguration *)configuration {
    if ((self = [super init])) {
        _baseURLString = GHNormalizedURL(baseURLString);
        _userId = [GHWorkflowText(userId, 120) ?: @"default" copy];
        NSURLSessionConfiguration *config = configuration ?: NSURLSessionConfiguration.ephemeralSessionConfiguration;
        config.HTTPCookieStorage = nil;
        config.URLCache = nil;
        config.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
        config.timeoutIntervalForRequest = GHWorkflowTimeout;
        _session = [NSURLSession sessionWithConfiguration:config];
    }
    return self;
}

- (void)setBaseURLString:(NSString *)baseURLString { _baseURLString = [GHNormalizedURL(baseURLString) copy]; }

- (void)finish:(GHWorkflowCompletion)completion value:(id)value error:(NSString *)errorCode {
    dispatch_async(dispatch_get_main_queue(), ^{ self.busy = NO; if (completion) completion(value, errorCode); });
}

- (void)post:(NSString *)path body:(NSDictionary *)body completion:(GHWorkflowCompletion)completion {
    if (self.busy || !self.baseURLString) { if (completion) completion(nil, self.busy ? @"busy" : @"no-server-url"); return; }
    NSURL *url = [NSURL URLWithString:[self.baseURLString stringByAppendingString:path]];
    NSData *data = [NSJSONSerialization dataWithJSONObject:body options:0 error:NULL];
    if (!url || !data) { if (completion) completion(nil, @"bad-request"); return; }
    self.busy = YES;
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    request.HTTPMethod = @"POST";
    request.HTTPBody = data;
    [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
    if (self.executeToken.length) [request setValue:self.executeToken forHTTPHeaderField:@"X-Ghost-Token"];
    __weak typeof(self) weakSelf = self;
    [[self.session dataTaskWithRequest:request completionHandler:^(NSData *responseData, NSURLResponse *response, NSError *error) {
        GHWorkflowCoordinator *strongSelf = weakSelf;
        if (!strongSelf) return;
        if (error) { [strongSelf finish:completion value:nil error:error.code == NSURLErrorTimedOut ? @"timeout" : @"unreachable"]; return; }
        NSInteger status = [(NSHTTPURLResponse *)response statusCode];
        id json = responseData.length ? [NSJSONSerialization JSONObjectWithData:responseData options:0 error:NULL] : nil;
        if (status < 200 || status >= 300) { [strongSelf finish:completion value:nil error:[NSString stringWithFormat:@"http-%ld", (long)status]]; return; }
        if (![json isKindOfClass:NSDictionary.class]) { [strongSelf finish:completion value:nil error:@"bad-response"]; return; }
        [strongSelf finish:completion value:json error:nil];
    }] resume];
}

- (void)requestPredictionForContext:(NSDictionary<NSString *,id> *)context demo:(BOOL)demo completion:(GHWorkflowCompletion)completion {
    [self post:@"/v1/workflows/predict" body:@{ @"userId": self.userId, @"context": context ?: @{}, @"demo": @(demo) } completion:^(id value, NSString *errorCode) {
        NSDictionary *json = [value isKindOfClass:NSDictionary.class] ? value : nil;
        self.workflowState = [json[@"workflow"] isKindOfClass:NSDictionary.class] ? json[@"workflow"] : nil;
        self.currentSuggestion = [GHWorkflowSuggestion fromJSONObject:json[@"suggestion"]];
        self.executionToken = nil;
        if (completion) completion(self.currentSuggestion, errorCode);
    }];
}

- (void)prefetchComposioForContext:(NSDictionary<NSString *,id> *)context completion:(GHWorkflowCompletion)completion {
    [self post:@"/v1/composio/prefetch" body:@{ @"userId": self.userId, @"context": context ?: @{} } completion:completion];
}

- (void)rejectSuggestion { self.currentSuggestion = nil; self.executionToken = nil; }

- (void)approveSuggestionWithConfirmation:(NSString *)confirmation completion:(GHWorkflowCompletion)completion {
    GHWorkflowSuggestion *suggestion = self.currentSuggestion;
    if (!suggestion) { if (completion) completion(nil, @"no-suggestion"); return; }
    [self post:@"/v1/workflows/approve" body:@{ @"userId": self.userId, @"workflowId": suggestion.workflowIdentifier, @"actionId": suggestion.actionIdentifier, @"confirmation": confirmation ?: @"" } completion:^(id value, NSString *errorCode) {
        NSDictionary *json = [value isKindOfClass:NSDictionary.class] ? value : nil;
        self.executionToken = GHWorkflowText(json[@"executionToken"], 200);
        if (completion) completion(self.executionToken, errorCode ?: (self.executionToken ? nil : @"bad-response"));
    }];
}

- (void)executeApprovedActionWithCompletion:(GHWorkflowCompletion)completion {
    GHWorkflowSuggestion *suggestion = self.currentSuggestion;
    NSString *token = self.executionToken;
    self.executionToken = nil; // never retry an uncertain write
    if (!suggestion || !token) { if (completion) completion(nil, @"not-approved"); return; }
    [self post:@"/v1/workflows/execute" body:@{ @"userId": self.userId, @"workflowId": suggestion.workflowIdentifier, @"executionToken": token } completion:^(id value, NSString *errorCode) {
        NSDictionary *json = [value isKindOfClass:NSDictionary.class] ? value : nil;
        if ([json[@"workflow"] isKindOfClass:NSDictionary.class]) self.workflowState = json[@"workflow"];
        if (!errorCode && json[@"result"]) self.currentSuggestion = nil;
        if (completion) completion(json, errorCode);
    }];
}

- (void)completeLocalActionWithToken:(NSString *)completionToken ok:(BOOL)ok errorCode:(NSString *)errorCode completion:(GHWorkflowCompletion)completion {
    NSString *workflowIdentifier = self.currentSuggestion.workflowIdentifier ?: GHWorkflowText(self.workflowState[@"id"], 120);
    if (!workflowIdentifier || !completionToken.length) { if (completion) completion(nil, @"bad-request"); return; }
    NSMutableDictionary *body = [@{ @"userId": self.userId, @"workflowId": workflowIdentifier, @"completionToken": completionToken, @"ok": @(ok) } mutableCopy];
    if (!ok && errorCode.length) body[@"errorCode"] = errorCode;
    [self post:@"/v1/workflows/local-result" body:body completion:^(id value, NSString *resultError) {
        NSDictionary *json = [value isKindOfClass:NSDictionary.class] ? value : nil;
        if ([json[@"workflow"] isKindOfClass:NSDictionary.class]) self.workflowState = json[@"workflow"];
        if (!resultError) self.currentSuggestion = nil;
        if (completion) completion(json, resultError);
    }];
}

- (void)cancelAll { [self.session invalidateAndCancel]; self.busy = NO; self.executionToken = nil; }

@end
