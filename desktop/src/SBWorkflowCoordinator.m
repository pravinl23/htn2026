#import "SBWorkflowCoordinator.h"
#import "SBCapture.h"
#import "SBComboBoxDriver.h"

static const NSTimeInterval SBWorkflowTimeout = 8.0;
static const NSUInteger SBWorkflowMaxText = 600;

static NSString *SBWorkflowText(id value, NSUInteger limit) {
    if (![value isKindOfClass:NSString.class]) return nil;
    NSString *trimmed = [value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (!trimmed.length) return nil;
    return trimmed.length <= limit ? trimmed : [trimmed substringToIndex:limit];
}

static NSString *SBNormalizedURL(NSString *raw) {
    NSString *text = SBWorkflowText(raw, 2048);
    NSURLComponents *parts = text ? [NSURLComponents componentsWithString:text] : nil;
    if (!parts || ![@[ @"http", @"https" ] containsObject:parts.scheme.lowercaseString] || !parts.host.length || parts.user.length || parts.password.length) return nil;
    parts.path = [parts.path stringByReplacingOccurrencesOfString:@"/+$" withString:@"" options:NSRegularExpressionSearch range:NSMakeRange(0, parts.path.length)];
    parts.query = nil;
    parts.fragment = nil;
    return parts.string;
}

static BOOL SBWorkflowTextIsPrivate(NSString *text) {
    static NSRegularExpression *contact;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        contact = [NSRegularExpression regularExpressionWithPattern:@"[^\\s@]+@[^\\s@]+\\.[^\\s@]+|\\+?\\d[\\d\\s().-]{6,}\\d" options:0 error:NULL];
    });
    if (text.length == 0) return NO;
    if ([contact firstMatchInString:text options:0 range:NSMakeRange(0, text.length)]) return YES;
    return [SBCapture nativeLooksSensitive:text] || [SBComboBoxDriver isDemographicText:text];
}

/// A field the workflow request must not describe at all: secure, sensitive-looking or an EEO / demographic question.
static BOOL SBWorkflowFieldIsPrivate(SBField *field) {
    if ([field.inputType isEqualToString:@"password"]) return YES;
    NSString *naming = [NSString stringWithFormat:@"%@ %@ %@ %@", field.label ?: @"", field.identifier ?: @"", field.inputType ?: @"", field.placeholder ?: @""];
    if ([SBCapture nativeLooksSensitive:naming]) return YES;
    for (NSString *text in @[ field.label ?: @"", field.identifier ?: @"", field.placeholder ?: @"", field.context ?: @"" ]) {
        if ([SBComboBoxDriver isDemographicText:text]) return YES;
    }
    return NO;
}

@interface SBWorkflowSuggestion ()
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

@implementation SBWorkflowSuggestion
+ (instancetype)fromJSONObject:(id)object {
    if (![object isKindOfClass:NSDictionary.class]) return nil;
    NSDictionary *json = object;
    NSDictionary *action = [json[@"action"] isKindOfClass:NSDictionary.class] ? json[@"action"] : nil;
    NSString *workflow = SBWorkflowText(json[@"workflowId"], 120);
    NSString *identifier = SBWorkflowText(action[@"id"], 120);
    NSString *title = SBWorkflowText(action[@"title"], 240);
    NSString *preview = SBWorkflowText(json[@"preview"], 800);
    NSString *safety = SBWorkflowText(action[@"safety"], 40);
    NSString *confirmation = SBWorkflowText(action[@"confirmation"], 40);
    if (!workflow || !identifier || !title || !preview || ![@[ @"read", @"reversible", @"high-impact" ] containsObject:safety] || ![@[ @"tab", @"review", @"explicit" ] containsObject:confirmation]) return nil;
    SBWorkflowSuggestion *suggestion = [[self alloc] init];
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

@implementation SBWorkflowContextBuilder

+ (NSDictionary<NSString *,id> *)snapshotWithApplicationName:(NSString *)applicationName
                                              bundleIdentifier:(NSString *)bundleIdentifier
                                                   windowTitle:(NSString *)windowTitle
                                                  focusedField:(SBField *)focusedField
                                                    nearbyText:(NSArray<NSString *> *)nearbyText
                                             safeValueToInsert:(NSString *)safeValueToInsert
                                             connectedToolkits:(NSArray<NSString *> *)connectedToolkits
                                                     workflow:(NSDictionary<NSString *,id> *)workflow {
    NSMutableDictionary *snapshot = [@{ @"version": @1,
                                        @"timestamp": @((long long)(NSDate.date.timeIntervalSince1970 * 1000.0)),
                                        @"activeApplication": @{ @"name": SBWorkflowText(applicationName, 100) ?: @"Unknown",
                                                                  @"bundleIdentifier": SBWorkflowText(bundleIdentifier, 180) ?: @"unknown" } } mutableCopy];
    // `windowTitle` never crosses the wire: titles name documents, mailboxes and tabs. The parameter stays for callers.
    (void)windowTitle;

    if (focusedField && !SBWorkflowFieldIsPrivate(focusedField)) {
        NSMutableDictionary *focused = [@{ @"role": SBWorkflowText(focusedField.kind, 80) ?: @"other" } mutableCopy];
        NSString *label = SBWorkflowText(focusedField.label, 180);
        NSString *identifier = SBWorkflowText(focusedField.identifier, 160);
        NSString *prepared = SBWorkflowText(safeValueToInsert, SBWorkflowMaxText);
        if (label) focused[@"label"] = label;
        if (identifier) focused[@"identifier"] = identifier;
        // Whether the field holds something, never what: what the user typed stays on the machine.
        focused[@"hasValue"] = @(focusedField.value.length > 0);
        if (prepared) focused[@"safeValueToInsert"] = prepared;
        snapshot[@"focusedElement"] = focused;
    }

    NSMutableArray *nearby = [NSMutableArray array];
    for (id item in [nearbyText isKindOfClass:NSArray.class] ? nearbyText : @[]) {
        NSString *line = SBWorkflowText(item, SBWorkflowMaxText);
        // Page text only (the caller's contract): a line with contact data or a sensitive / EEO word is dropped.
        if (line && !SBWorkflowTextIsPrivate(line)) [nearby addObject:line];
        if (nearby.count == 10) break;
    }
    if (nearby.count) snapshot[@"nearbyText"] = nearby;

    NSMutableOrderedSet *toolkits = [NSMutableOrderedSet orderedSet];
    for (id item in [connectedToolkits isKindOfClass:NSArray.class] ? connectedToolkits : @[]) {
        NSString *toolkit = SBWorkflowText(item, 80).lowercaseString;
        if (toolkit) [toolkits addObject:toolkit];
        if (toolkits.count == 20) break;
    }
    if (toolkits.count) snapshot[@"connectedToolkits"] = toolkits.array;
    if ([workflow isKindOfClass:NSDictionary.class]) {
        NSString *identifier = SBWorkflowText(workflow[@"id"], 120);
        NSString *kind = SBWorkflowText(workflow[@"kind"], 60);
        NSString *step = SBWorkflowText(workflow[@"step"], 80);
        NSString *status = SBWorkflowText(workflow[@"status"], 40);
        if (identifier && kind && step && [@[ @"active", @"completed", @"failed", @"cancelled" ] containsObject:status])
            snapshot[@"workflow"] = @{ @"id": identifier, @"kind": kind, @"step": step, @"status": status };
    }
    return snapshot;
}

@end

@interface SBWorkflowCoordinator ()
@property (nonatomic, readwrite, copy) NSString *userId;
@property (nonatomic, readwrite, nullable) SBWorkflowSuggestion *currentSuggestion;
@property (nonatomic, readwrite, copy, nullable) NSDictionary<NSString *, id> *workflowState;
@property (nonatomic, readwrite) BOOL busy;
@property (nonatomic, copy, nullable) NSString *executionToken;
@property (nonatomic, strong) NSURLSession *session;
@end

@implementation SBWorkflowCoordinator

- (instancetype)initWithBaseURLString:(NSString *)baseURLString userId:(NSString *)userId configuration:(NSURLSessionConfiguration *)configuration {
    if ((self = [super init])) {
        _baseURLString = SBNormalizedURL(baseURLString);
        _userId = [SBWorkflowText(userId, 120) ?: @"default" copy];
        NSURLSessionConfiguration *config = configuration ?: NSURLSessionConfiguration.ephemeralSessionConfiguration;
        config.HTTPCookieStorage = nil;
        config.URLCache = nil;
        config.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
        config.timeoutIntervalForRequest = SBWorkflowTimeout;
        _session = [NSURLSession sessionWithConfiguration:config];
    }
    return self;
}

- (void)setBaseURLString:(NSString *)baseURLString { _baseURLString = [SBNormalizedURL(baseURLString) copy]; }

- (void)finish:(SBWorkflowCompletion)completion value:(id)value error:(NSString *)errorCode {
    dispatch_async(dispatch_get_main_queue(), ^{ self.busy = NO; if (completion) completion(value, errorCode); });
}

- (void)post:(NSString *)path body:(NSDictionary *)body completion:(SBWorkflowCompletion)completion {
    if (self.busy || !self.baseURLString) { if (completion) completion(nil, self.busy ? @"busy" : @"no-server-url"); return; }
    NSURL *url = [NSURL URLWithString:[self.baseURLString stringByAppendingString:path]];
    NSData *data = [NSJSONSerialization dataWithJSONObject:body options:0 error:NULL];
    if (!url || !data) { if (completion) completion(nil, @"bad-request"); return; }
    self.busy = YES;
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    request.HTTPMethod = @"POST";
    request.HTTPBody = data;
    [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
    if (self.executeToken.length) [request setValue:self.executeToken forHTTPHeaderField:@"X-Shabang-Token"];
    __weak typeof(self) weakSelf = self;
    [[self.session dataTaskWithRequest:request completionHandler:^(NSData *responseData, NSURLResponse *response, NSError *error) {
        SBWorkflowCoordinator *strongSelf = weakSelf;
        if (!strongSelf) return;
        if (error) { [strongSelf finish:completion value:nil error:error.code == NSURLErrorTimedOut ? @"timeout" : @"unreachable"]; return; }
        NSInteger status = [(NSHTTPURLResponse *)response statusCode];
        id json = responseData.length ? [NSJSONSerialization JSONObjectWithData:responseData options:0 error:NULL] : nil;
        if (status < 200 || status >= 300) { [strongSelf finish:completion value:nil error:[NSString stringWithFormat:@"http-%ld", (long)status]]; return; }
        if (![json isKindOfClass:NSDictionary.class]) { [strongSelf finish:completion value:nil error:@"bad-response"]; return; }
        [strongSelf finish:completion value:json error:nil];
    }] resume];
}

- (void)requestPredictionForContext:(NSDictionary<NSString *,id> *)context demo:(BOOL)demo completion:(SBWorkflowCompletion)completion {
    [self post:@"/v1/workflows/predict" body:@{ @"userId": self.userId, @"context": context ?: @{}, @"demo": @(demo) } completion:^(id value, NSString *errorCode) {
        NSDictionary *json = [value isKindOfClass:NSDictionary.class] ? value : nil;
        self.workflowState = [json[@"workflow"] isKindOfClass:NSDictionary.class] ? json[@"workflow"] : nil;
        self.currentSuggestion = [SBWorkflowSuggestion fromJSONObject:json[@"suggestion"]];
        self.executionToken = nil;
        if (completion) completion(self.currentSuggestion, errorCode);
    }];
}

- (void)prefetchComposioForContext:(NSDictionary<NSString *,id> *)context completion:(SBWorkflowCompletion)completion {
    [self post:@"/v1/composio/prefetch" body:@{ @"userId": self.userId, @"context": context ?: @{} } completion:completion];
}

- (void)rejectSuggestion { self.currentSuggestion = nil; self.executionToken = nil; }

- (void)approveSuggestionWithConfirmation:(NSString *)confirmation completion:(SBWorkflowCompletion)completion {
    SBWorkflowSuggestion *suggestion = self.currentSuggestion;
    if (!suggestion) { if (completion) completion(nil, @"no-suggestion"); return; }
    [self post:@"/v1/workflows/approve" body:@{ @"userId": self.userId, @"workflowId": suggestion.workflowIdentifier, @"actionId": suggestion.actionIdentifier, @"confirmation": confirmation ?: @"" } completion:^(id value, NSString *errorCode) {
        NSDictionary *json = [value isKindOfClass:NSDictionary.class] ? value : nil;
        self.executionToken = SBWorkflowText(json[@"executionToken"], 200);
        if (completion) completion(self.executionToken, errorCode ?: (self.executionToken ? nil : @"bad-response"));
    }];
}

- (void)executeApprovedActionWithCompletion:(SBWorkflowCompletion)completion {
    SBWorkflowSuggestion *suggestion = self.currentSuggestion;
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

- (void)completeLocalActionWithToken:(NSString *)completionToken ok:(BOOL)ok errorCode:(NSString *)errorCode completion:(SBWorkflowCompletion)completion {
    NSString *workflowIdentifier = self.currentSuggestion.workflowIdentifier ?: SBWorkflowText(self.workflowState[@"id"], 120);
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
