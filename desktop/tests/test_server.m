// SBServerClient tests against a stub NSURLProtocol: no socket is ever opened.
#import "SBTest.h"
#import "SBCore.h"
#import "SBField.h"
#import "SBServerClient.h"

#pragma mark - stub protocol

@interface SBStubReply : NSObject
@property (nonatomic) NSInteger status;
@property (nonatomic, copy) NSString *contentType;
@property (nonatomic, copy) NSArray<NSData *> *chunks;
@property (nonatomic, strong) NSError *error;
/// Keep the response open after the last chunk (a stream the client has to cancel).
@property (nonatomic) BOOL hang;
+ (instancetype)json:(id)object status:(NSInteger)status;
+ (instancetype)sse:(NSArray<NSString *> *)chunks;
@end

@implementation SBStubReply
+ (instancetype)json:(id)object status:(NSInteger)status {
    SBStubReply *reply = [[SBStubReply alloc] init];
    reply.status = status;
    reply.contentType = @"application/json";
    reply.chunks = @[ [NSJSONSerialization dataWithJSONObject:object options:0 error:NULL] ];
    return reply;
}
+ (instancetype)sse:(NSArray<NSString *> *)chunks {
    SBStubReply *reply = [[SBStubReply alloc] init];
    reply.status = 200;
    reply.contentType = @"text/event-stream; charset=utf-8";
    NSMutableArray *data = [NSMutableArray array];
    for (NSString *chunk in chunks) [data addObject:[chunk dataUsingEncoding:NSUTF8StringEncoding]];
    reply.chunks = data;
    return reply;
}
@end

@interface SBStubRequest : NSObject
@property (nonatomic, copy) NSString *method;
@property (nonatomic, copy) NSString *path;
@property (nonatomic, copy) NSDictionary<NSString *, NSString *> *headers;
@property (nonatomic, copy) NSData *body;
@property (nonatomic, readonly) NSString *bodyText;
@property (nonatomic, readonly) NSDictionary *bodyJSON;
@end

@implementation SBStubRequest
- (NSString *)bodyText { return [[NSString alloc] initWithData:self.body ?: [NSData data] encoding:NSUTF8StringEncoding]; }
- (NSDictionary *)bodyJSON { return self.body.length ? [NSJSONSerialization JSONObjectWithData:self.body options:0 error:NULL] : nil; }
@end

@interface SBStubURLProtocol : NSURLProtocol
+ (void)resetWithHandler:(SBStubReply * (^)(SBStubRequest *request))handler;
+ (NSArray<SBStubRequest *> *)requests;
@end

static SBStubReply * (^gHandler)(SBStubRequest *);
static NSMutableArray<SBStubRequest *> *gRequests;

@implementation SBStubURLProtocol

+ (void)resetWithHandler:(SBStubReply * (^)(SBStubRequest *))handler {
    @synchronized ([SBStubURLProtocol class]) {
        gHandler = [handler copy];
        gRequests = [NSMutableArray array];
    }
}

+ (NSArray<SBStubRequest *> *)requests {
    @synchronized ([SBStubURLProtocol class]) { return [gRequests copy]; }
}

+ (BOOL)canInitWithRequest:(NSURLRequest *)request { return YES; }
+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request { return request; }

static NSData *ReadBody(NSURLRequest *request) {
    if (request.HTTPBody) return request.HTTPBody;
    NSInputStream *stream = request.HTTPBodyStream;
    if (!stream) return nil;
    NSMutableData *data = [NSMutableData data];
    [stream open];
    uint8_t buffer[4096];
    NSInteger read;
    while ((read = [stream read:buffer maxLength:sizeof(buffer)]) > 0) [data appendBytes:buffer length:(NSUInteger)read];
    [stream close];
    return data;
}

- (void)startLoading {
    SBStubRequest *seen = [[SBStubRequest alloc] init];
    seen.method = self.request.HTTPMethod;
    seen.path = self.request.URL.path;
    seen.headers = self.request.allHTTPHeaderFields ?: @{};
    seen.body = ReadBody(self.request);
    SBStubReply * (^handler)(SBStubRequest *);
    @synchronized ([SBStubURLProtocol class]) {
        [gRequests addObject:seen];
        handler = gHandler;
    }
    SBStubReply *reply = handler ? handler(seen) : nil;
    if (!reply || reply.error) {
        [self.client URLProtocol:self didFailWithError:reply.error ?: [NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorCannotConnectToHost userInfo:nil]];
        return;
    }
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:self.request.URL statusCode:reply.status HTTPVersion:@"HTTP/1.1"
                                                            headerFields:@{ @"Content-Type": reply.contentType ?: @"application/json" }];
    [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
    for (NSData *chunk in reply.chunks) [self.client URLProtocol:self didLoadData:chunk];
    if (!reply.hang) [self.client URLProtocolDidFinishLoading:self];
}

- (void)stopLoading {}

@end

#pragma mark - helpers

static SBCore *ServerCore(void) {
    static SBCore *core;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSString *path = [SBCore defaultBundlePath];
        core = path ? [[SBCore alloc] initWithBundlePath:path error:NULL] : nil;
    });
    return core;
}

static SBServerClient *Client(SBFormCache *cache) {
    NSURLSessionConfiguration *configuration = [NSURLSessionConfiguration ephemeralSessionConfiguration];
    configuration.protocolClasses = @[ [SBStubURLProtocol class] ];
    return [[SBServerClient alloc] initWithBaseURLString:@"http://127.0.0.1:8787/" core:ServerCore() configuration:configuration cache:cache];
}

static NSArray<SBField *> *SampleFields(void) {
    SBField *first = [SBField fieldWithSignature:@"txt|first" label:@"First name" kind:SBKindText];
    SBField *email = [SBField fieldWithSignature:@"txt|email" label:@"Email" kind:SBKindEmail];
    email.value = @"someone.typed@example.org";
    SBField *card = [SBField fieldWithSignature:@"txt|card" label:@"Card number" kind:SBKindText];
    SBField *submit = [SBField fieldWithSignature:@"btn|submit" label:@"Submit" kind:SBKindButton];
    submit.locked = YES;
    return @[ first, email, card, submit ];
}

static NSDictionary *PredictReply(void) {
    return @{ @"assignments": @[ @{ @"signature": @"txt|first", @"factKey": @"firstName", @"confidence": @0.98, @"source": @"jev", @"calibrated": @YES },
                                 @{ @"signature": @"txt|email", @"factKey": @"email", @"confidence": @0.97, @"source": @"jev", @"calibrated": @YES } ],
              @"provider": @"jev-gateway", @"calibrated": @YES, @"latencyMs": @143 };
}

#pragma mark - predict/form

GH_TEST(server_predict_sends_fact_keys_and_no_values) {
    [SBStubURLProtocol resetWithHandler:^SBStubReply *(SBStubRequest *request) { return [SBStubReply json:PredictReply() status:200]; }];
    SBServerClient *client = Client(nil);
    NSDictionary *profile = [ServerCore() demoProfile];
    NSArray *keys = [[profile[@"facts"] allKeys] sortedArrayUsingSelector:@selector(compare:)];
    __block SBFormPrediction *prediction;
    __block BOOL done = NO;
    [client predictFormForFields:SampleFields() factKeys:keys origin:@"app://com.apple.Safari/jobs.example.com" formSignature:@"form-abc"
                      completion:^(SBFormPrediction *result, NSString *errorCode) { prediction = result; done = YES; }];
    GH_ASSERT(SBTestWaitUntil(5.0, ^BOOL { return done; }));
    GH_ASSERT(prediction != nil);
    GH_ASSERT_EQUAL_OBJECTS(prediction.provider, @"jev-gateway");
    GH_ASSERT(prediction.calibrated);
    GH_ASSERT_FALSE(prediction.fromCache);
    GH_ASSERT_EQUAL_OBJECTS(prediction.ghostSource, @"server");
    GH_ASSERT_EQUAL_OBJECTS(prediction.serverLatencyMs, @143);
    GH_ASSERT_EQUAL_INT(prediction.assignments.count, 2);
    GH_ASSERT(client.lastLatencyMs != nil);
    GH_ASSERT(client.lastErrorCode == nil);

    NSArray<SBStubRequest *> *requests = [SBStubURLProtocol requests];
    GH_ASSERT_EQUAL_INT(requests.count, 1); // ONE call for the whole form
    SBStubRequest *request = requests[0];
    GH_ASSERT_EQUAL_OBJECTS(request.method, @"POST");
    GH_ASSERT_EQUAL_OBJECTS(request.path, @"/v1/predict/form");
    GH_ASSERT_EQUAL_OBJECTS(request.headers[@"Content-Type"], @"application/json");
    GH_ASSERT(request.headers[@"Origin"] == nil);
    GH_ASSERT(request.headers[@"Cookie"] == nil);

    NSDictionary *body = request.bodyJSON;
    GH_ASSERT_EQUAL_OBJECTS(body[@"factKeys"], keys);
    GH_ASSERT_EQUAL_OBJECTS(body[@"origin"], @"app://com.apple.Safari/jobs.example.com");
    GH_ASSERT_EQUAL_OBJECTS(body[@"formSignature"], @"form-abc");
    GH_ASSERT_EQUAL_INT([body[@"fields"] count], 2); // the card field and the button never leave
    NSString *text = request.bodyText;
    for (NSString *value in [profile[@"facts"] allValues]) {
        if (value.length < 4) continue;
        GH_ASSERT_MSG(![text containsString:value], @"a profile value (length %lu) reached the server", (unsigned long)value.length);
    }
    GH_ASSERT_FALSE([text containsString:@"someone.typed"]);
    GH_ASSERT_FALSE([text containsString:@"Card number"]);
    GH_ASSERT_FALSE([text containsString:@"\"value\":\"someone"]);
}

GH_TEST(server_predict_repeat_visit_makes_zero_calls) {
    [SBStubURLProtocol resetWithHandler:^SBStubReply *(SBStubRequest *request) { return [SBStubReply json:PredictReply() status:200]; }];
    NSString *cachePath = [SBTestTempDirectory() stringByAppendingPathComponent:@"form-cache.json"];
    SBServerClient *client = Client([[SBFormCache alloc] initWithPath:cachePath]);
    NSArray *keys = @[ @"firstName", @"email" ];
    __block int completions = 0;
    __block SBFormPrediction *second;
    [client predictFormForFields:SampleFields() factKeys:keys origin:@"app://x/host" formSignature:@"f1" completion:^(SBFormPrediction *result, NSString *code) { completions++; }];
    GH_ASSERT(SBTestWaitUntil(5.0, ^BOOL { return completions == 1; }));
    [client predictFormForFields:SampleFields() factKeys:@[ @"email", @"firstName" ] origin:@"app://x/host" formSignature:@"f1"
                      completion:^(SBFormPrediction *result, NSString *code) { second = result; completions++; }];
    GH_ASSERT(SBTestWaitUntil(5.0, ^BOOL { return completions == 2; }));
    GH_ASSERT_EQUAL_INT([SBStubURLProtocol requests].count, 1);
    GH_ASSERT(second.fromCache);
    GH_ASSERT_EQUAL_OBJECTS(second.ghostSource, @"cache");
    GH_ASSERT_EQUAL_OBJECTS(second.provider, @"jev-gateway");
    GH_ASSERT_EQUAL_INT(second.assignments.count, 2);

    // On disk: private, value-free, and read back by a new process.
    [client.cache waitForWrites];
    NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:cachePath error:NULL];
    GH_ASSERT_EQUAL_INT([attributes[NSFilePosixPermissions] intValue], 0600);
    NSString *onDisk = [NSString stringWithContentsOfFile:cachePath encoding:NSUTF8StringEncoding error:NULL];
    GH_ASSERT([onDisk containsString:@"firstName"]);
    GH_ASSERT_FALSE([onDisk containsString:@"Alex"]);
    GH_ASSERT_FALSE([onDisk containsString:@"app://x/host"]); // keys are hashed: the file does not list where the user has been
    SBFormCache *reopened = [[SBFormCache alloc] initWithPath:cachePath];
    GH_ASSERT([reopened entryForOrigin:@"app://x/host" formSignature:@"f1" factKeys:keys] != nil);
    GH_ASSERT([reopened entryForOrigin:@"app://x/host" formSignature:@"f1" factKeys:@[ @"firstName" ]] == nil); // profile shape changed: ask again
    GH_ASSERT([reopened entryForOrigin:@"app://y/host" formSignature:@"f1" factKeys:keys] == nil);
}

GH_TEST(server_predict_does_not_cache_fallback_answers) {
    NSMutableDictionary *reply = [PredictReply() mutableCopy];
    reply[@"fallbackFrom"] = @"jev-gateway";
    reply[@"provider"] = @"heuristic";
    [SBStubURLProtocol resetWithHandler:^SBStubReply *(SBStubRequest *request) { return [SBStubReply json:reply status:200]; }];
    SBFormCache *cache = [[SBFormCache alloc] initWithPath:nil];
    SBServerClient *client = Client(cache);
    __block SBFormPrediction *prediction;
    __block BOOL done = NO;
    [client predictFormForFields:SampleFields() factKeys:@[ @"firstName" ] origin:@"o" formSignature:@"f" completion:^(SBFormPrediction *result, NSString *code) { prediction = result; done = YES; }];
    GH_ASSERT(SBTestWaitUntil(5.0, ^BOOL { return done; }));
    GH_ASSERT_EQUAL_OBJECTS(prediction.fallbackFrom, @"jev-gateway");
    GH_ASSERT_EQUAL_INT(cache.count, 0);
}

GH_TEST(server_errors_are_short_codes) {
    SBServerClient *client = Client(nil);
    NSArray<NSArray *> *cases = @[
        @[ [SBStubReply json:@{ @"error": @"boom with details" } status:500], @"http-500" ],
        @[ [SBStubReply json:@[ @"not", @"an", @"object" ] status:200], @"bad-response" ],
        @[ [SBStubReply json:@{ @"assignments": @"nope", @"provider": @"x" } status:200], @"bad-response" ],
        @[ [SBStubReply json:@{ @"assignments": @[], @"provider": @"x" } status:200], @"empty" ],
    ];
    for (NSArray *testCase in cases) {
        [SBStubURLProtocol resetWithHandler:^SBStubReply *(SBStubRequest *request) { return testCase[0]; }];
        __block NSString *code;
        __block BOOL done = NO;
        [client predictFormForFields:SampleFields() factKeys:@[ @"firstName" ] origin:@"o" formSignature:@"f" completion:^(SBFormPrediction *result, NSString *errorCode) { code = errorCode; done = YES; }];
        GH_ASSERT(SBTestWaitUntil(5.0, ^BOOL { return done; }));
        GH_ASSERT_EQUAL_OBJECTS(code, testCase[1]);
    }
    SBStubReply *timeout = [[SBStubReply alloc] init];
    timeout.error = [NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorTimedOut userInfo:nil];
    [SBStubURLProtocol resetWithHandler:^SBStubReply *(SBStubRequest *request) { return timeout; }];
    __block NSString *code;
    [client checkHealthWithCompletion:^(SBServerHealth *health, NSString *errorCode) { code = errorCode ?: @"ok"; }];
    GH_ASSERT(SBTestWaitUntil(5.0, ^BOOL { return code != nil; }));
    GH_ASSERT_EQUAL_OBJECTS(code, @"timeout");
    GH_ASSERT_EQUAL_OBJECTS(client.lastErrorCode, @"timeout");
}

GH_TEST(server_predict_with_nothing_to_ask_makes_no_call) {
    [SBStubURLProtocol resetWithHandler:^SBStubReply *(SBStubRequest *request) { return [SBStubReply json:PredictReply() status:200]; }];
    SBServerClient *client = Client(nil);
    SBField *card = [SBField fieldWithSignature:@"txt|card" label:@"Card number" kind:SBKindText];
    __block NSString *code;
    [client predictFormForFields:@[ card ] factKeys:@[ @"firstName" ] origin:@"o" formSignature:@"f" completion:^(SBFormPrediction *result, NSString *errorCode) { code = errorCode; }];
    GH_ASSERT(SBTestWaitUntil(5.0, ^BOOL { return code != nil; }));
    GH_ASSERT_EQUAL_OBJECTS(code, @"bad-request");
    GH_ASSERT_EQUAL_INT([SBStubURLProtocol requests].count, 0);
}

GH_TEST(server_invalid_url_never_leaves) {
    GH_ASSERT_EQUAL_OBJECTS([SBServerClient normalizedServerURL:@" http://localhost:8787/// "], @"http://localhost:8787");
    GH_ASSERT_EQUAL_OBJECTS([SBServerClient normalizedServerURL:@"https://ghost.example/api/"], @"https://ghost.example/api");
    GH_ASSERT([SBServerClient normalizedServerURL:@"ftp://localhost"] == nil);
    GH_ASSERT([SBServerClient normalizedServerURL:@"http://user:pw@localhost:8787"] == nil);
    GH_ASSERT([SBServerClient normalizedServerURL:@"localhost:8787"] == nil);
    [SBStubURLProtocol resetWithHandler:^SBStubReply *(SBStubRequest *request) { return [SBStubReply json:@{} status:200]; }];
    SBServerClient *client = Client(nil);
    client.baseURLString = @"file:///etc/passwd";
    __block NSString *code;
    [client checkHealthWithCompletion:^(SBServerHealth *health, NSString *errorCode) { code = errorCode; }];
    GH_ASSERT(SBTestWaitUntil(5.0, ^BOOL { return code != nil; }));
    GH_ASSERT_EQUAL_OBJECTS(code, @"no-server-url");
    GH_ASSERT_EQUAL_INT([SBStubURLProtocol requests].count, 0);
}

#pragma mark - health, presence, origin

GH_TEST(server_health_and_presence) {
    [SBStubURLProtocol resetWithHandler:^SBStubReply *(SBStubRequest *request) {
        if ([request.path isEqualToString:@"/v1/health"]) {
            return [SBStubReply json:@{ @"ok": @YES, @"provider": @"heuristic", @"calibrated": @NO, @"textProvider": @"template", @"version": @"0.1.0" } status:200];
        }
        return [SBStubReply json:@{ @"clients": @[ @{ @"client": @"extension", @"browser": @"Chrome", @"ageMs": @12000 },
                                                   @{ @"client": @"extension", @"browser": @"firefox", @"ageMs": @200000 },
                                                   @{ @"client": @"desktop", @"browser": @"arc", @"ageMs": @1 } ] } status:200];
    }];
    SBServerClient *client = Client(nil);
    __block SBServerHealth *health;
    __block SBPresence *presence;
    [client checkHealthWithCompletion:^(SBServerHealth *result, NSString *code) { health = result; }];
    [client fetchPresenceWithCompletion:^(SBPresence *result, NSString *code) { presence = result; }];
    GH_ASSERT(SBTestWaitUntil(5.0, ^BOOL { return health != nil && presence != nil; }));
    GH_ASSERT_EQUAL_OBJECTS(health.provider, @"heuristic");
    GH_ASSERT_FALSE(health.calibrated);
    GH_ASSERT_EQUAL_OBJECTS(health.textProvider, @"template");
    for (SBStubRequest *request in [SBStubURLProtocol requests]) {
        GH_ASSERT_EQUAL_OBJECTS(request.method, @"GET");
        GH_ASSERT(request.headers[@"Origin"] == nil);
    }
    GH_ASSERT([presence isExtensionActiveForBundleId:@"com.google.Chrome"]);
    GH_ASSERT_FALSE([presence isExtensionActiveForBundleId:@"org.mozilla.firefox"]);      // heartbeat older than 90 s
    GH_ASSERT_FALSE([presence isExtensionActiveForBundleId:@"company.thebrowser.Browser"]); // not an extension heartbeat
    GH_ASSERT_FALSE([presence isExtensionActiveForBundleId:@"com.apple.Safari"]);
    GH_ASSERT_FALSE([presence isExtensionActiveForBundleId:@"com.apple.TextEdit"]);
    GH_ASSERT_FALSE([presence isExtensionActiveForBundleId:nil]);
}

GH_TEST(server_presence_accepts_last_seen_and_ignores_junk) {
    NSDate *now = [NSDate dateWithTimeIntervalSince1970:2000000];
    SBPresence *presence = [SBPresence presenceFromJSONObject:@{ @"clients": @[
        @{ @"client": @"extension", @"browser": @"arc", @"lastSeen": @(2000000 * 1000.0 - 30000) },
        @{ @"client": @"extension", @"browser": @"edge", @"lastSeen": @(2000000 * 1000.0 + 600000) }, // from the future: proves nothing
        @{ @"client": @"extension", @"browser": @"brave" }, @"junk", @{ @"client": @"extension", @"browser": @7, @"ageMs": @1 } ] } now:now];
    GH_ASSERT_NEAR(presence.extensionAges[@"arc"].doubleValue, 30, 0.001);
    GH_ASSERT([presence isExtensionActiveForBundleId:@"company.thebrowser.Browser"]);
    GH_ASSERT_FALSE([presence isExtensionActiveForBundleId:@"com.microsoft.edgemac"]);
    GH_ASSERT_FALSE([presence isExtensionActiveForBundleId:@"com.brave.Browser"]);
    GH_ASSERT_EQUAL_INT([SBPresence presenceFromJSONObject:@"nope" now:now].extensionAges.count, 0);
}

GH_TEST(server_origin_never_carries_path_or_query) {
    GH_ASSERT_EQUAL_OBJECTS([SBServerClient originForBundleId:@"com.apple.Safari" pageURL:@"https://Jobs.Example.com/apply/123?token=abc#frag" windowTitle:@"Apply"],
                            @"app://com.apple.Safari/jobs.example.com");
    // A window title never leaves: not a host-looking word in a tab title, a document name or a mailbox address.
    GH_ASSERT_EQUAL_OBJECTS([SBServerClient originForBundleId:@"org.mozilla.firefox" pageURL:nil windowTitle:@"Careers at acme.io - Mozilla Firefox"], @"app://org.mozilla.firefox");
    GH_ASSERT_EQUAL_OBJECTS([SBServerClient originForBundleId:@"com.google.Chrome" pageURL:nil windowTitle:@"localhost:5173/apply"], @"app://com.google.Chrome");
    GH_ASSERT_EQUAL_OBJECTS([SBServerClient originForBundleId:@"com.microsoft.Word" pageURL:nil windowTitle:@"Q3-layoffs.docx"], @"app://com.microsoft.Word");
    GH_ASSERT_EQUAL_OBJECTS([SBServerClient originForBundleId:@"com.apple.mail" pageURL:nil windowTitle:@"Inbox – alex.chen@gmail.com"], @"app://com.apple.mail");
    GH_ASSERT_EQUAL_OBJECTS([SBServerClient originForBundleId:@"com.apple.Safari" pageURL:@"about:blank" windowTitle:@"J.Smith offer"], @"app://com.apple.Safari");
    GH_ASSERT_EQUAL_OBJECTS([SBServerClient originForBundleId:@"com.apple.TextEdit" pageURL:nil windowTitle:@"Untitled"], @"app://com.apple.TextEdit");
    GH_ASSERT_EQUAL_OBJECTS([SBServerClient originForBundleId:nil pageURL:nil windowTitle:nil], @"app://unknown");
}

#pragma mark - SSE

static NSArray<NSString *> *ParseChunks(NSArray<NSData *> *chunks, BOOL finish) {
    NSMutableArray<NSString *> *events = [NSMutableArray array];
    SBSSEParser *parser = [[SBSSEParser alloc] initWithHandler:^(NSString *data) { [events addObject:data]; }];
    for (NSData *chunk in chunks) [parser appendData:chunk];
    if (finish) [parser finish];
    return events;
}

GH_TEST(sse_parses_at_every_chunk_boundary) {
    NSString *stream = @": comment\r\ndata: {\"delta\":\"Héllo 👻 \"}\r\n\r\nevent: x\ndata: first\ndata: second\n\ndata:no-space\r\rdata: {\"done\":true}\n\n";
    NSData *bytes = [stream dataUsingEncoding:NSUTF8StringEncoding];
    NSArray<NSString *> *expected = @[ @"{\"delta\":\"Héllo 👻 \"}", @"first\nsecond", @"no-space", @"{\"done\":true}" ];
    GH_ASSERT_EQUAL_OBJECTS(ParseChunks(@[ bytes ], NO), expected);
    // Split in two at EVERY byte offset: inside a line, inside CRLF, inside a multi-byte character.
    for (NSUInteger cut = 1; cut < bytes.length; cut++) {
        NSArray *chunks = @[ [bytes subdataWithRange:NSMakeRange(0, cut)], [bytes subdataWithRange:NSMakeRange(cut, bytes.length - cut)] ];
        GH_ASSERT_MSG([ParseChunks(chunks, NO) isEqual:expected], @"events differ when the stream is cut at byte %lu", (unsigned long)cut);
    }
    // One byte at a time.
    NSMutableArray *single = [NSMutableArray array];
    for (NSUInteger i = 0; i < bytes.length; i++) [single addObject:[bytes subdataWithRange:NSMakeRange(i, 1)]];
    GH_ASSERT_EQUAL_OBJECTS(ParseChunks(single, NO), expected);
}

GH_TEST(sse_flushes_last_event_without_blank_line) {
    NSData *bytes = [@"data: one\n\ndata: two" dataUsingEncoding:NSUTF8StringEncoding];
    GH_ASSERT_EQUAL_OBJECTS(ParseChunks(@[ bytes ], NO), (@[ @"one" ]));
    GH_ASSERT_EQUAL_OBJECTS(ParseChunks(@[ bytes ], YES), (@[ @"one", @"two" ]));
    GH_ASSERT_EQUAL_INT(ParseChunks(@[ [@"\n\n\n: ping\n\n" dataUsingEncoding:NSUTF8StringEncoding] ], YES).count, 0);
}

#pragma mark - ghost-text

@interface SBStreamRecorder : NSObject <SBGhostTextStreamDelegate>
@property (nonatomic, strong) NSMutableArray<NSString *> *deltas;
@property (nonatomic, copy) NSString *finalText;
@property (nonatomic, copy) NSString *provider;
@property (nonatomic, copy) NSString *failure;
@property (nonatomic) int terminalCalls;
@end

@implementation SBStreamRecorder
- (instancetype)init {
    if ((self = [super init])) _deltas = [NSMutableArray array];
    return self;
}
- (void)ghostTextStream:(SBGhostTextStream *)stream didReceiveDelta:(NSString *)delta { [self.deltas addObject:delta]; }
- (void)ghostTextStream:(SBGhostTextStream *)stream didFinishWithText:(NSString *)text provider:(NSString *)provider latencyMs:(NSNumber *)latencyMs {
    self.finalText = text;
    self.provider = provider;
    self.terminalCalls++;
}
- (void)ghostTextStream:(SBGhostTextStream *)stream didFailWithCode:(NSString *)code {
    self.failure = code;
    self.terminalCalls++;
}
@end

static NSDictionary *ProfileWithAnswers(void) {
    NSMutableDictionary *profile = [[ServerCore() demoProfile] mutableCopy];
    profile[@"pastAnswers"] = @[
        @{ @"question": @"Why do you want to work at Shopify?", @"answer": @"I like building fast tools." },
        @{ @"question": @"Why do you want to work on developer tools?", @"answer": @"Tools multiply everyone." },
        @{ @"question": @"Phone", @"answer": @"+1 416 555 0142" },                                   // contact data
        @{ @"question": @"Why do you want to work here? Reach me", @"answer": @"alex.chen.dev@example.com" },
        @{ @"question": @"Are you authorized to work here?", @"answer": @"Yes, citizen" },           // work status
        @{ @"question": @"Why do you want to work here? (gender)", @"answer": @"Prefer to self-describe" },   // EEO
        @{ @"question": @"Favourite ice cream flavour", @"answer": @"Pistachio" },                  // unrelated
        @{ @"question": @"Question 1", @"answer": @"Unrelated too" },
    ];
    return profile;
}

GH_TEST(server_ghost_text_streams_deltas_and_filters_facts) {
    [SBStubURLProtocol resetWithHandler:^SBStubReply *(SBStubRequest *request) {
        // Chunk boundaries fall inside a line and inside the event separator.
        return [SBStubReply sse:@[ @"data: {\"del", @"ta\":\"I build \"}\n", @"\ndata: {\"delta\":\"fast tools.\"}\n\ndata: {\"done\":true,\"text\":\"I build fast tools.\",",
                                   @"\"provider\":\"template\",\"latencyMs\":12}\n\n" ]];
    }];
    SBServerClient *client = Client(nil);
    SBStreamRecorder *recorder = [[SBStreamRecorder alloc] init];
    SBGhostTextStream *stream = [client streamGhostTextForFieldLabel:@"Why do you want to work here?" fieldSignature:@"area|why"
                                                         pageContext:@{ @"company": @"Acme", @"role": @" Engineer ", @"junk": @"dropped" }
                                                                conversation:nil profile:ProfileWithAnswers() maxChars:600 delegate:recorder];
    GH_ASSERT(stream != nil);
    GH_ASSERT(SBTestWaitUntil(5.0, ^BOOL { return recorder.terminalCalls > 0; }));
    GH_ASSERT(recorder.failure == nil);
    GH_ASSERT_EQUAL_OBJECTS([recorder.deltas componentsJoinedByString:@""], @"I build fast tools.");
    GH_ASSERT_EQUAL_OBJECTS(recorder.finalText, @"I build fast tools.");
    GH_ASSERT_EQUAL_OBJECTS(recorder.provider, @"template");
    GH_ASSERT_EQUAL_OBJECTS(stream.text, @"I build fast tools.");
    GH_ASSERT(stream.finished);
    GH_ASSERT_EQUAL_INT(recorder.terminalCalls, 1);

    SBStubRequest *request = [SBStubURLProtocol requests].firstObject;
    GH_ASSERT_EQUAL_OBJECTS(request.path, @"/v1/shabang-text");
    GH_ASSERT_EQUAL_OBJECTS(request.headers[@"Content-Type"], @"application/json");
    GH_ASSERT_EQUAL_OBJECTS(request.headers[@"Accept"], @"text/event-stream");
    GH_ASSERT(request.headers[@"Origin"] == nil);
    NSDictionary *body = request.bodyJSON;
    GH_ASSERT_EQUAL_OBJECTS(body[@"fieldLabel"], @"Why do you want to work here?");
    GH_ASSERT_EQUAL_OBJECTS(body[@"pageContext"], (@{ @"company": @"Acme", @"role": @"Engineer" }));
    GH_ASSERT_EQUAL_OBJECTS(body[@"maxChars"], @600);
    // Only answers to similar questions: never contact data, work status, EEO, or unrelated questions.
    NSArray *sent = body[@"pastAnswers"];
    NSMutableArray *questions = [NSMutableArray array];
    for (NSDictionary *item in sent) [questions addObject:item[@"question"]];
    GH_ASSERT_EQUAL_OBJECTS(questions, (@[ @"Why do you want to work at Shopify?", @"Why do you want to work on developer tools?" ]));
    for (NSString *secret in @[ @"555 0142", @"example.com", @"citizen", @"self-describe", @"Pistachio", @"Unrelated too" ]) {
        GH_ASSERT_MSG(![request.bodyText containsString:secret], @"%@ must not leave for a draft", secret);
    }
    NSDictionary *facts = body[@"facts"];
    GH_ASSERT_EQUAL_OBJECTS(facts[@"school"], @"University of Waterloo");
    NSString *text = request.bodyText;
    for (NSString *key in @[ @"email", @"phone", @"linkedin", @"workAuthorization", @"requiresSponsorship" ]) {
        GH_ASSERT_MSG(facts[key] == nil, @"%@ must not be sent for a draft", key);
    }
    GH_ASSERT_FALSE([text containsString:@"alex.chen.dev@example.com"]);
    GH_ASSERT_FALSE([text containsString:@"555 0142"]);
}

GH_TEST(server_ghost_text_refuses_sensitive_labels_locally) {
    [SBStubURLProtocol resetWithHandler:^SBStubReply *(SBStubRequest *request) { return [SBStubReply sse:@[ @"data: {\"delta\":\"x\"}\n\n" ]]; }];
    SBServerClient *client = Client(nil);
    SBStreamRecorder *recorder = [[SBStreamRecorder alloc] init];
    SBGhostTextStream *stream = [client streamGhostTextForFieldLabel:@"Security code" fieldSignature:@"txt|code" pageContext:nil conversation:nil profile:ProfileWithAnswers() maxChars:0 delegate:recorder];
    GH_ASSERT(stream == nil);
    GH_ASSERT(SBTestWaitUntil(5.0, ^BOOL { return recorder.terminalCalls > 0; }));
    GH_ASSERT_EQUAL_OBJECTS(recorder.failure, @"sensitive");
    GH_ASSERT_EQUAL_INT([SBStubURLProtocol requests].count, 0);
}

GH_TEST(server_ghost_text_failures) {
    SBServerClient *client = Client(nil);
    NSArray<NSArray *> *cases = @[
        @[ [SBStubReply json:@{ @"error": @"fieldLabel looks sensitive; details" } status:400], @"http-400" ],
        @[ [SBStubReply sse:@[ @"data: {\"delta\":\"half a sen" ]], @"stream-ended-early" ],
        @[ [SBStubReply sse:@[ @"data: {\"delta\":\"x\"}\n\ndata: {\"error\":\"model said: <prompt echo>\"}\n\n" ]], @"server-error" ],
    ];
    for (NSArray *testCase in cases) {
        [SBStubURLProtocol resetWithHandler:^SBStubReply *(SBStubRequest *request) { return testCase[0]; }];
        SBStreamRecorder *recorder = [[SBStreamRecorder alloc] init];
        [client streamGhostTextForFieldLabel:@"Tell us about a project" fieldSignature:@"area|project" pageContext:nil conversation:nil profile:ProfileWithAnswers() maxChars:0 delegate:recorder];
        GH_ASSERT(SBTestWaitUntil(5.0, ^BOOL { return recorder.terminalCalls > 0; }));
        GH_ASSERT_EQUAL_OBJECTS(recorder.failure, testCase[1]);
        GH_ASSERT(recorder.finalText == nil);
        GH_ASSERT_EQUAL_INT(recorder.terminalCalls, 1);
    }
}

GH_TEST(server_ghost_text_cancel_reports_aborted_once) {
    SBStubReply *open = [SBStubReply sse:@[ @"data: {\"delta\":\"typing...\"}\n\n" ]];
    open.hang = YES;
    [SBStubURLProtocol resetWithHandler:^SBStubReply *(SBStubRequest *request) { return open; }];
    SBServerClient *client = Client(nil);
    SBStreamRecorder *recorder = [[SBStreamRecorder alloc] init];
    SBGhostTextStream *stream = [client streamGhostTextForFieldLabel:@"Cover letter" fieldSignature:@"area|cover" pageContext:nil conversation:nil profile:ProfileWithAnswers() maxChars:0 delegate:recorder];
    GH_ASSERT(SBTestWaitUntil(5.0, ^BOOL { return recorder.deltas.count == 1; }));
    [stream cancel];
    [stream cancel];
    GH_ASSERT(SBTestWaitUntil(5.0, ^BOOL { return recorder.terminalCalls > 0; }));
    SBTestWaitUntil(0.2, ^BOOL { return NO; }); // let the cancelled task complete: it must not report twice
    GH_ASSERT_EQUAL_OBJECTS(recorder.failure, @"aborted");
    GH_ASSERT_EQUAL_INT(recorder.terminalCalls, 1);
}
