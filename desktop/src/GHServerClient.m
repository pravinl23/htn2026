#import "GHServerClient.h"
#import "GHCore.h"
#import "GHLog.h"
#import "GHProfileStore.h"
#include <CommonCrypto/CommonDigest.h>

const NSTimeInterval GHServerRequestTimeout = 3.0;
const NSTimeInterval GHServerStreamTimeout = 30.0;
const NSTimeInterval GHPresenceFreshSeconds = 90.0;

static const NSUInteger kLabelMax = 300, kSignatureMax = 500, kNameMax = 200, kDescriptionMax = 2000;
static const NSUInteger kPastAnswersMax = 3, kQuestionMax = 300, kAnswerMax = 2000;
static const NSUInteger kMinMaxChars = 20, kMaxMaxChars = 5000;

static NSString *GHClip(id value, NSUInteger max) {
    if (![value isKindOfClass:[NSString class]]) return nil;
    NSString *trimmed = [value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (trimmed.length == 0) return nil;
    if (trimmed.length <= max) return trimmed;
    return [trimmed substringWithRange:[trimmed rangeOfComposedCharacterSequencesForRange:NSMakeRange(0, max)]];
}

static NSString *GHErrorCode(NSError *error) {
    if (!error) return @"unreachable";
    if ([error.domain isEqualToString:NSURLErrorDomain]) {
        if (error.code == NSURLErrorTimedOut) return @"timeout";
        if (error.code == NSURLErrorCancelled) return @"aborted";
    }
    return @"unreachable";
}

#pragma mark - results

@interface GHFormPrediction ()
@property (nonatomic, readwrite, copy) NSArray<NSDictionary<NSString *, id> *> *assignments;
@property (nonatomic, readwrite, copy) NSString *provider;
@property (nonatomic, readwrite) BOOL calibrated;
@property (nonatomic, readwrite, nullable) NSNumber *serverLatencyMs;
@property (nonatomic, readwrite) double elapsedMs;
@property (nonatomic, readwrite) BOOL fromCache;
@property (nonatomic, readwrite, copy, nullable) NSString *fallbackFrom;
@end

@implementation GHFormPrediction
- (NSString *)ghostSource { return self.fromCache ? @"cache" : @"server"; }
@end

@interface GHServerHealth ()
@property (nonatomic, readwrite, copy) NSString *provider;
@property (nonatomic, readwrite) BOOL calibrated;
@property (nonatomic, readwrite, copy) NSString *textProvider;
@property (nonatomic, readwrite, copy, nullable) NSString *model;
@property (nonatomic, readwrite, copy, nullable) NSString *version;
@end

@implementation GHServerHealth
@end

@interface GHPresence ()
@property (nonatomic, readwrite, copy) NSDictionary<NSString *, NSNumber *> *extensionAges;
@end

@implementation GHPresence

+ (NSDictionary<NSString *, NSString *> *)browsersByBundleId {
    static NSDictionary *map;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        map = @{
            @"com.google.chrome": @"chrome", @"com.google.chrome.beta": @"chrome", @"com.google.chrome.dev": @"chrome",
            @"com.google.chrome.canary": @"chrome", @"org.chromium.chromium": @"chromium",
            @"company.thebrowser.browser": @"arc", @"com.brave.browser": @"brave", @"com.microsoft.edgemac": @"edge",
            @"com.operasoftware.opera": @"opera", @"com.vivaldi.vivaldi": @"vivaldi",
            @"org.mozilla.firefox": @"firefox", @"org.mozilla.firefoxdeveloperedition": @"firefox", @"org.mozilla.nightly": @"firefox",
            @"com.apple.safari": @"safari",
        };
    });
    return map;
}

+ (NSString *)browserNameForBundleId:(NSString *)bundleId {
    return bundleId ? [self browsersByBundleId][bundleId.lowercaseString] : nil;
}

+ (instancetype)presenceFromJSONObject:(id)json now:(NSDate *)now {
    GHPresence *presence = [[GHPresence alloc] init];
    NSMutableDictionary<NSString *, NSNumber *> *ages = [NSMutableDictionary dictionary];
    NSArray *clients = [json isKindOfClass:[NSDictionary class]] ? json[@"clients"] : nil;
    if ([clients isKindOfClass:[NSArray class]]) {
        for (NSDictionary *item in clients) {
            if (![item isKindOfClass:[NSDictionary class]]) continue;
            if (![item[@"client"] isEqual:@"extension"] || ![item[@"browser"] isKindOfClass:[NSString class]]) continue;
            double age = NAN;
            if ([item[@"ageMs"] isKindOfClass:[NSNumber class]]) age = [item[@"ageMs"] doubleValue] / 1000.0;
            else if ([item[@"lastSeen"] isKindOfClass:[NSNumber class]]) age = now.timeIntervalSince1970 - [item[@"lastSeen"] doubleValue] / 1000.0;
            // A heartbeat without an age, or "from the future", proves nothing: ignore it.
            if (!isfinite(age) || age < -5) continue;
            NSString *browser = [item[@"browser"] lowercaseString];
            NSNumber *known = ages[browser];
            if (!known || age < known.doubleValue) ages[browser] = @(MAX(0, age));
        }
    }
    presence.extensionAges = ages;
    return presence;
}

- (BOOL)isExtensionActiveForBundleId:(NSString *)bundleId {
    NSString *browser = [GHPresence browserNameForBundleId:bundleId];
    NSNumber *age = browser ? self.extensionAges[browser] : nil;
    return age != nil && age.doubleValue < GHPresenceFreshSeconds;
}

@end

#pragma mark - SSE

@implementation GHSSEParser {
    void (^_handler)(NSString *);
    NSMutableData *_buffer;
    NSMutableArray<NSString *> *_data;
    BOOL _lastWasCR;
}

- (instancetype)initWithHandler:(void (^)(NSString *))handler {
    if ((self = [super init])) {
        _handler = [handler copy];
        _buffer = [NSMutableData data];
        _data = [NSMutableArray array];
    }
    return self;
}

- (void)endEvent {
    if (_data.count > 0) _handler([_data componentsJoinedByString:@"\n"]);
    [_data removeAllObjects];
}

- (void)readLine:(NSData *)lineBytes {
    if (lineBytes.length == 0) { [self endEvent]; return; }
    // Lines are split on bytes, so a complete line is always complete UTF-8.
    NSString *line = [[NSString alloc] initWithData:lineBytes encoding:NSUTF8StringEncoding];
    if (![line hasPrefix:@"data:"]) return;
    NSString *payload = [line substringFromIndex:5];
    if ([payload hasPrefix:@" "]) payload = [payload substringFromIndex:1];
    [_data addObject:payload];
}

- (void)appendData:(NSData *)chunk {
    const uint8_t *bytes = chunk.bytes;
    NSUInteger length = chunk.length;
    for (NSUInteger i = 0; i < length; i++) {
        uint8_t byte = bytes[i];
        if (byte == '\n' && _lastWasCR) { _lastWasCR = NO; continue; } // the LF of a CRLF, possibly in the next chunk
        _lastWasCR = (byte == '\r');
        if (byte == '\n' || byte == '\r') {
            [self readLine:_buffer];
            _buffer.length = 0;
        } else {
            [_buffer appendBytes:&byte length:1];
        }
    }
}

- (void)finish {
    if (_buffer.length > 0) [self readLine:_buffer];
    _buffer.length = 0;
    [self endEvent];
}

@end

#pragma mark - stream

@interface GHGhostTextStream ()
@property (nonatomic, readwrite, copy) NSString *fieldSignature;
@property (nonatomic, readwrite) BOOL finished;
@property (nonatomic, weak) id<GHGhostTextStreamDelegate> delegate;
@property (nonatomic, strong) NSURLSessionDataTask *task;
@property (nonatomic, strong) GHSSEParser *parser;
@property (nonatomic, strong) NSMutableString *received;
@property (nonatomic) NSInteger status;
@end

@implementation GHGhostTextStream

- (NSString *)text {
    @synchronized (self) { return [self.received copy] ?: @""; }
}

/// Main queue only. The first terminal event wins; everything after it is dropped.
- (void)finishWithCode:(NSString *)code text:(NSString *)text provider:(NSString *)provider latencyMs:(NSNumber *)latencyMs {
    if (self.finished) return;
    self.finished = YES;
    [self.task cancel];
    id<GHGhostTextStreamDelegate> delegate = self.delegate;
    if (code) [delegate ghostTextStream:self didFailWithCode:code];
    else [delegate ghostTextStream:self didFinishWithText:text provider:provider latencyMs:latencyMs];
}

- (void)handleEventData:(NSString *)data {
    if (self.finished) return;
    id payload = GHJSONParse(data);
    if (![payload isKindOfClass:[NSDictionary class]]) return;
    if ([payload[@"delta"] isKindOfClass:[NSString class]]) {
        NSString *delta = payload[@"delta"];
        if (delta.length == 0) return;
        @synchronized (self) { [self.received appendString:delta]; }
        [self.delegate ghostTextStream:self didReceiveDelta:delta];
    } else if ([payload[@"done"] isEqual:@YES] && [payload[@"text"] isKindOfClass:[NSString class]]) {
        NSString *provider = [payload[@"provider"] isKindOfClass:[NSString class]] ? payload[@"provider"] : @"unknown";
        NSNumber *latency = [payload[@"latencyMs"] isKindOfClass:[NSNumber class]] ? payload[@"latencyMs"] : nil;
        [self finishWithCode:nil text:payload[@"text"] provider:provider latencyMs:latency];
    } else if ([payload[@"error"] isKindOfClass:[NSString class]]) {
        // Never echo the server's error text: it can quote the request.
        [self finishWithCode:@"server-error" text:nil provider:nil latencyMs:nil];
    }
}

- (void)cancel {
    dispatch_block_t work = ^{ [self finishWithCode:@"aborted" text:nil provider:nil latencyMs:nil]; };
    if (NSThread.isMainThread) work(); else dispatch_async(dispatch_get_main_queue(), work);
}

@end

/// The session retains its delegate, so the delegate is this small router rather than the client.
@interface GHStreamRouter : NSObject <NSURLSessionDataDelegate>
- (void)addStream:(GHGhostTextStream *)stream;
- (NSArray<GHGhostTextStream *> *)allStreams;
@end

@implementation GHStreamRouter {
    NSMutableDictionary<NSNumber *, GHGhostTextStream *> *_streams;
}

- (instancetype)init {
    if ((self = [super init])) _streams = [NSMutableDictionary dictionary];
    return self;
}

- (void)addStream:(GHGhostTextStream *)stream {
    @synchronized (self) { _streams[@(stream.task.taskIdentifier)] = stream; }
}

- (GHGhostTextStream *)streamForTask:(NSURLSessionTask *)task remove:(BOOL)remove {
    @synchronized (self) {
        GHGhostTextStream *stream = _streams[@(task.taskIdentifier)];
        if (remove) [_streams removeObjectForKey:@(task.taskIdentifier)];
        return stream;
    }
}

- (NSArray<GHGhostTextStream *> *)allStreams {
    @synchronized (self) { return _streams.allValues; }
}

- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task didReceiveResponse:(NSURLResponse *)response
 completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler {
    GHGhostTextStream *stream = [self streamForTask:task remove:NO];
    NSInteger status = [response isKindOfClass:[NSHTTPURLResponse class]] ? ((NSHTTPURLResponse *)response).statusCode : 0;
    stream.status = status;
    completionHandler(status == 200 ? NSURLSessionResponseAllow : NSURLSessionResponseCancel);
}

- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task didReceiveData:(NSData *)data {
    GHGhostTextStream *stream = [self streamForTask:task remove:NO];
    if (!stream) return;
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!stream.finished) [stream.parser appendData:data];
    });
}

- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
    GHGhostTextStream *stream = [self streamForTask:task remove:YES];
    if (!stream) return;
    dispatch_async(dispatch_get_main_queue(), ^{
        if (stream.finished) return;
        [stream.parser finish];
        if (stream.finished) return;
        NSString *code = @"stream-ended-early";
        if (stream.status != 0 && stream.status != 200) code = [NSString stringWithFormat:@"http-%ld", (long)stream.status];
        else if (error) code = GHErrorCode(error);
        [stream finishWithCode:code text:nil provider:nil latencyMs:nil];
    });
}

@end

#pragma mark - cache

@implementation GHFormCache {
    NSString *_path;
    NSMutableDictionary<NSString *, NSDictionary *> *_entries;
    dispatch_queue_t _ioQueue;
}

- (instancetype)initWithPath:(NSString *)path {
    if (!(self = [super init])) return nil;
    _path = [path copy];
    _maxEntries = 200;
    _maxAge = 30 * 24 * 3600.0;
    _entries = [NSMutableDictionary dictionary];
    _ioQueue = dispatch_queue_create("dev.ghost.desktop.form-cache", DISPATCH_QUEUE_SERIAL);
    [self load];
    return self;
}

- (void)load {
    if (!_path) return;
    NSData *data = [NSData dataWithContentsOfFile:_path];
    id parsed = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
    NSDictionary *entries = [parsed isKindOfClass:[NSDictionary class]] ? parsed[@"entries"] : nil;
    if (![entries isKindOfClass:[NSDictionary class]]) return;
    [entries enumerateKeysAndObjectsUsingBlock:^(id key, id entry, BOOL *stop) {
        if (![key isKindOfClass:[NSString class]] || ![entry isKindOfClass:[NSDictionary class]]) return;
        if (![entry[@"assignments"] isKindOfClass:[NSArray class]] || ![entry[@"savedAt"] isKindOfClass:[NSNumber class]]) return;
        self->_entries[key] = entry;
    }];
}

+ (NSString *)keyForOrigin:(NSString *)origin formSignature:(NSString *)formSignature factKeys:(NSArray<NSString *> *)factKeys {
    NSArray *sorted = [factKeys sortedArrayUsingSelector:@selector(compare:)];
    NSString *joined = [NSString stringWithFormat:@"%@\n%@\n%@", origin, formSignature, [sorted componentsJoinedByString:@","]];
    NSData *bytes = [joined dataUsingEncoding:NSUTF8StringEncoding];
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(bytes.bytes, (CC_LONG)bytes.length, digest);
    NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
    for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) [hex appendFormat:@"%02x", digest[i]];
    return hex;
}

- (NSDictionary<NSString *, id> *)entryForOrigin:(NSString *)origin formSignature:(NSString *)formSignature factKeys:(NSArray<NSString *> *)factKeys {
    NSString *key = [GHFormCache keyForOrigin:origin formSignature:formSignature factKeys:factKeys];
    @synchronized (self) {
        NSDictionary *entry = _entries[key];
        if (!entry) return nil;
        if (NSDate.date.timeIntervalSince1970 - [entry[@"savedAt"] doubleValue] > self.maxAge) {
            [_entries removeObjectForKey:key];
            return nil;
        }
        return entry;
    }
}

- (void)saveAssignments:(NSArray<NSDictionary *> *)assignments provider:(NSString *)provider calibrated:(BOOL)calibrated
              forOrigin:(NSString *)origin formSignature:(NSString *)formSignature factKeys:(NSArray<NSString *> *)factKeys {
    if (assignments.count == 0) return;
    NSString *key = [GHFormCache keyForOrigin:origin formSignature:formSignature factKeys:factKeys];
    @synchronized (self) {
        _entries[key] = @{ @"assignments": assignments, @"provider": provider ?: @"unknown", @"calibrated": @(calibrated), @"savedAt": @(NSDate.date.timeIntervalSince1970) };
        [self evict];
    }
    [self persist];
}

/// Caller holds the lock. Oldest entries go first.
- (void)evict {
    if (_entries.count <= self.maxEntries) return;
    NSArray<NSString *> *byAge = [_entries keysSortedByValueUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
        return [a[@"savedAt"] compare:b[@"savedAt"]];
    }];
    NSUInteger excess = _entries.count - self.maxEntries;
    for (NSUInteger i = 0; i < excess; i++) [_entries removeObjectForKey:byAge[i]];
}

- (void)persist {
    if (!_path) return;
    NSDictionary *snapshot;
    @synchronized (self) { snapshot = @{ @"version": @1, @"entries": [_entries copy] }; }
    NSString *path = _path;
    dispatch_async(_ioQueue, ^{
        if (![NSJSONSerialization isValidJSONObject:snapshot]) return;
        NSData *data = [NSJSONSerialization dataWithJSONObject:snapshot options:0 error:NULL];
        [NSFileManager.defaultManager createDirectoryAtPath:path.stringByDeletingLastPathComponent withIntermediateDirectories:YES
                                                 attributes:@{ NSFilePosixPermissions: @0700 } error:NULL];
        if (data) GHWritePrivateFile(path, data, NULL);
    });
}

- (void)waitForWrites {
    dispatch_sync(_ioQueue, ^{});
}

- (void)removeAll {
    @synchronized (self) { [_entries removeAllObjects]; }
    [self persist];
}

- (NSUInteger)count {
    @synchronized (self) { return _entries.count; }
}

@end

#pragma mark - client

@interface GHServerClient ()
@property (atomic, readwrite, nullable) NSNumber *lastLatencyMs;
@property (atomic, readwrite, copy, nullable) NSString *lastErrorCode;
@end

@implementation GHServerClient {
    GHCore *_core;
    NSURLSession *_session;
    GHStreamRouter *_router;
    NSString *_baseURLString;
}

- (instancetype)initWithBaseURLString:(NSString *)baseURLString core:(GHCore *)core
                        configuration:(NSURLSessionConfiguration *)configuration cache:(GHFormCache *)cache {
    if (!(self = [super init])) return nil;
    _core = core;
    _cache = cache;
    _baseURLString = [GHServerClient normalizedServerURL:baseURLString ?: @"http://127.0.0.1:8787"];
    NSURLSessionConfiguration *config = [configuration copy] ?: [NSURLSessionConfiguration ephemeralSessionConfiguration];
    config.timeoutIntervalForRequest = GHServerRequestTimeout;
    config.HTTPCookieStorage = nil;
    config.HTTPShouldSetCookies = NO;
    config.URLCache = nil;
    config.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
    config.URLCredentialStorage = nil;
    _router = [[GHStreamRouter alloc] init];
    _session = [NSURLSession sessionWithConfiguration:config delegate:_router delegateQueue:nil];
    return self;
}

- (void)dealloc {
    [_session invalidateAndCancel];
}

+ (NSString *)normalizedServerURL:(NSString *)raw {
    NSString *trimmed = [raw stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    NSURLComponents *parts = trimmed.length ? [NSURLComponents componentsWithString:trimmed] : nil;
    if (!parts.host.length || parts.user || parts.password) return nil;
    if (![parts.scheme isEqualToString:@"http"] && ![parts.scheme isEqualToString:@"https"]) return nil;
    NSString *path = parts.path ?: @"";
    while ([path hasSuffix:@"/"]) path = [path substringToIndex:path.length - 1];
    NSString *port = parts.port ? [NSString stringWithFormat:@":%@", parts.port] : @"";
    return [NSString stringWithFormat:@"%@://%@%@%@", parts.scheme, parts.host, port, path];
}

- (NSString *)baseURLString {
    @synchronized (self) { return _baseURLString; }
}

- (void)setBaseURLString:(NSString *)baseURLString {
    @synchronized (self) { _baseURLString = [GHServerClient normalizedServerURL:baseURLString]; }
}

+ (NSString *)originForBundleId:(NSString *)bundleId pageURL:(NSString *)pageURL windowTitle:(NSString *)windowTitle {
    // The window title is never used: it names documents, mailboxes and tabs ("Q3-layoffs.docx", an address), and
    // the origin travels to the server and into the model's state. Without a web page's host it is the app alone.
    NSString *app = bundleId.length ? bundleId : @"unknown";
    NSString *host = pageURL.length ? [NSURLComponents componentsWithString:pageURL].host : nil;
    NSString *origin = host.length ? [NSString stringWithFormat:@"app://%@/%@", app, host.lowercaseString] : [NSString stringWithFormat:@"app://%@", app];
    return origin.length > 300 ? [origin substringToIndex:300] : origin;
}

#pragma mark requests

- (NSMutableURLRequest *)requestForPath:(NSString *)path body:(NSData *)body accept:(NSString *)accept {
    NSString *base = self.baseURLString;
    NSURL *url = base ? [NSURL URLWithString:[base stringByAppendingString:path]] : nil;
    if (!url) return nil;
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    request.HTTPMethod = body ? @"POST" : @"GET";
    request.HTTPShouldHandleCookies = NO;
    request.cachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
    request.timeoutInterval = GHServerRequestTimeout;
    [request setValue:accept forHTTPHeaderField:@"Accept"];
    if (body) {
        // The server refuses POSTs that are not application/json. No Origin header: this is not a page.
        [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
        request.HTTPBody = body;
    }
    return request;
}

/// One JSON round trip. `completion` runs on the main queue with a dictionary or a short error code.
- (void)sendJSON:(NSString *)path body:(NSData *)body completion:(void (^)(NSDictionary *json, NSString *errorCode, double elapsedMs))completion {
    NSMutableURLRequest *request = [self requestForPath:path body:body accept:@"application/json"];
    if (!request) {
        self.lastErrorCode = @"no-server-url";
        dispatch_async(dispatch_get_main_queue(), ^{ completion(nil, @"no-server-url", 0); });
        return;
    }
    CFAbsoluteTime started = CFAbsoluteTimeGetCurrent();
    __weak GHServerClient *weakSelf = self;
    NSURLSessionDataTask *task = [_session dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        double elapsed = (CFAbsoluteTimeGetCurrent() - started) * 1000.0;
        NSInteger status = [response isKindOfClass:[NSHTTPURLResponse class]] ? ((NSHTTPURLResponse *)response).statusCode : 0;
        NSString *code = nil;
        NSDictionary *json = nil;
        if (error) code = GHErrorCode(error);
        else if (status < 200 || status > 299) code = [NSString stringWithFormat:@"http-%ld", (long)status];
        else {
            id parsed = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
            if ([parsed isKindOfClass:[NSDictionary class]]) json = parsed; else code = @"bad-response";
        }
        GHServerClient *client = weakSelf;
        client.lastErrorCode = code;
        if (!code) client.lastLatencyMs = @(round(elapsed));
        // Numbers and names only: never a body.
        GHLog(@"server: %@ %@ %.0fms", path, code ?: @"ok", elapsed);
        dispatch_async(dispatch_get_main_queue(), ^{ completion(json, code, elapsed); });
    }];
    [task resume];
}

- (void)predictFormForFields:(NSArray<GHField *> *)fields factKeys:(NSArray<NSString *> *)factKeys origin:(NSString *)origin
               formSignature:(NSString *)formSignature completion:(void (^)(GHFormPrediction *, NSString *))completion {
    CFAbsoluteTime started = CFAbsoluteTimeGetCurrent();
    // Wire objects carry no value, and GhostCore.formRequest rebuilds them once more (kinds, limits, sensitivity).
    NSData *body = [_core formRequestBodyForFieldObjects:[GHField wireJSONObjectsForFields:fields] factKeys:factKeys origin:origin formSignature:formSignature];
    if (!body) {
        dispatch_async(dispatch_get_main_queue(), ^{ completion(nil, @"bad-request"); });
        return;
    }
    NSDictionary *cached = [self.cache entryForOrigin:origin formSignature:formSignature factKeys:factKeys];
    if (cached) {
        GHFormPrediction *hit = [[GHFormPrediction alloc] init];
        hit.assignments = [_core cleanAssignments:cached[@"assignments"]];
        hit.provider = [cached[@"provider"] isKindOfClass:[NSString class]] ? cached[@"provider"] : @"unknown";
        hit.calibrated = [cached[@"calibrated"] isKindOfClass:[NSNumber class]] && [cached[@"calibrated"] boolValue];
        hit.fromCache = YES;
        hit.elapsedMs = (CFAbsoluteTimeGetCurrent() - started) * 1000.0;
        if (hit.assignments.count > 0) {
            GHLog(@"server: /v1/predict/form cache=hit assignments=%lu", (unsigned long)hit.assignments.count);
            dispatch_async(dispatch_get_main_queue(), ^{ completion(hit, nil); });
            return;
        }
    }
    GHCore *core = _core;
    GHFormCache *cache = self.cache;
    [self sendJSON:@"/v1/predict/form" body:body completion:^(NSDictionary *json, NSString *errorCode, double elapsedMs) {
        if (!json) { completion(nil, errorCode); return; }
        if (![json[@"assignments"] isKindOfClass:[NSArray class]] || ![json[@"provider"] isKindOfClass:[NSString class]]) { completion(nil, @"bad-response"); return; }
        GHFormPrediction *prediction = [[GHFormPrediction alloc] init];
        prediction.assignments = [core cleanAssignments:json[@"assignments"]];
        prediction.provider = GHClip(json[@"provider"], 40) ?: @"unknown";
        prediction.calibrated = [json[@"calibrated"] isEqual:@YES];
        prediction.serverLatencyMs = [json[@"latencyMs"] isKindOfClass:[NSNumber class]] ? json[@"latencyMs"] : nil;
        prediction.fallbackFrom = GHClip(json[@"fallbackFrom"], 40);
        prediction.elapsedMs = elapsedMs;
        if (prediction.assignments.count == 0) { completion(nil, @"empty"); return; }
        // The server's fallback after a provider failure is the heuristic we already ran: not worth pinning.
        if (!prediction.fallbackFrom) {
            [cache saveAssignments:prediction.assignments provider:prediction.provider calibrated:prediction.calibrated
                         forOrigin:origin formSignature:formSignature factKeys:factKeys];
        }
        completion(prediction, nil);
    }];
}

- (void)checkHealthWithCompletion:(void (^)(GHServerHealth *, NSString *))completion {
    [self sendJSON:@"/v1/health" body:nil completion:^(NSDictionary *json, NSString *errorCode, double elapsedMs) {
        if (!json) { completion(nil, errorCode); return; }
        if (![json[@"ok"] isEqual:@YES] || ![json[@"provider"] isKindOfClass:[NSString class]]) { completion(nil, @"bad-response"); return; }
        GHServerHealth *health = [[GHServerHealth alloc] init];
        health.provider = GHClip(json[@"provider"], 40) ?: @"unknown";
        health.calibrated = [json[@"calibrated"] isEqual:@YES];
        health.textProvider = GHClip(json[@"textProvider"], 40) ?: @"unknown";
        health.model = GHClip(json[@"model"], 80);
        health.version = GHClip(json[@"version"], 40);
        completion(health, nil);
    }];
}

- (void)fetchPresenceWithCompletion:(void (^)(GHPresence *, NSString *))completion {
    [self sendJSON:@"/v1/presence" body:nil completion:^(NSDictionary *json, NSString *errorCode, double elapsedMs) {
        if (!json) { completion(nil, errorCode); return; }
        completion([GHPresence presenceFromJSONObject:json now:[NSDate date]], nil);
    }];
}

#pragma mark outcome telemetry

/// The wire schema's confidence buckets (shared/src/walkTelemetry.ts). A number never leaves as a number:
/// a confidence attached to one field is a fingerprint of what Ghost saw on screen.
static NSString *GHConfidenceBucket(double confidence) {
    if (confidence >= 0.95) return @"95-plus";
    if (confidence >= 0.85) return @"85-94";
    if (confidence >= 0.70) return @"70-84";
    if (confidence >= 0.55) return @"55-69";
    return @"under-55";
}

/// WALK_ACTIONS has no "upload": an upload is a click that opens a panel, so it is reported as one.
static NSString *GHWireAction(NSString *action) {
    if ([action isEqualToString:@"fill"] || [action isEqualToString:@"select"] ||
        [action isEqualToString:@"check"] || [action isEqualToString:@"click"]) return action;
    return @"click";
}

static NSString *GHWireSource(NSString *source) {
    if ([source isEqualToString:@"offline"] || [source isEqualToString:@"server"] || [source isEqualToString:@"cache"] ||
        [source isEqualToString:@"llm"] || [source isEqualToString:@"loop"]) return source;
    return @"offline";
}

- (void)reportGhostOutcomeWithAction:(NSString *)action
                              source:(NSString *)source
                          confidence:(double)confidence
                              locked:(BOOL)locked
                             outcome:(NSString *)outcome {
    if (outcome.length == 0 || !self.baseURLString) return;
    BOOL accepted = [outcome isEqualToString:@"accepted"];
    BOOL dismissed = [outcome isEqualToString:@"escaped"] || [outcome isEqualToString:@"refused"];

    NSDictionary *proposal = @{
        @"index": @1,
        @"action": GHWireAction(action ?: @"click"),
        @"source": GHWireSource(source ?: @"offline"),
        // The desktop ranker is local, so nothing here carries a calibrated probability.
        @"calibrated": @NO,
        @"confidence": GHConfidenceBucket(confidence),
        @"locked": locked ? @YES : @NO,
        @"outcome": outcome,
    };
    NSDictionary *payload = @{
        @"schemaVersion": @"ghost.walk-outcome.v1",
        @"runId": [[NSUUID UUID] UUIDString].lowercaseString,
        // One press is its own walk: the user answered, so it is parked rather than abandoned.
        @"state": accepted ? @"parked" : @"abandoned",
        @"reason": accepted ? @"locked-action" : @"other",
        @"duration": @"under-250ms",
        @"provider": @"none",
        @"latency": @"none",
        @"proposals": @[proposal],
        @"summary": @{ @"shown": @1, @"accepted": accepted ? @1 : @0, @"dismissed": dismissed ? @1 : @0, @"locked": locked ? @1 : @0 },
    };

    NSData *body = [NSJSONSerialization dataWithJSONObject:payload options:0 error:NULL];
    NSMutableURLRequest *request = body ? [self requestForPath:@"/v1/walk/outcomes" body:body accept:@"application/json"] : nil;
    if (!request) return;
    // The surface tag the server reads; without it every desktop ghost would be counted as the browser's.
    [request setValue:@"desktop" forHTTPHeaderField:@"x-ghost-surface"];
    [[_session dataTaskWithRequest:request] resume];
}

#pragma mark streaming

- (NSData *)ghostTextBodyForLabel:(NSString *)label signature:(NSString *)signature pageContext:(NSDictionary *)pageContext
                          profile:(NSDictionary *)profile maxChars:(NSUInteger)maxChars {
    NSMutableDictionary *body = [NSMutableDictionary dictionary];
    body[@"fieldLabel"] = label;
    body[@"fieldSignature"] = signature;
    NSMutableDictionary *context = [NSMutableDictionary dictionary];
    NSString *company = GHClip(pageContext[@"company"], kNameMax), *role = GHClip(pageContext[@"role"], kNameMax);
    NSString *description = GHClip(pageContext[@"description"], kDescriptionMax);
    if (company) context[@"company"] = company;
    if (role) context[@"role"] = role;
    if (description) context[@"description"] = description;
    body[@"pageContext"] = context;
    // The allowlist lives in the core: contact details, LinkedIn, work authorization never leave for a draft.
    body[@"facts"] = [_core textFactsForProfile:profile];
    // Filtered in the core too: only answers to similar questions, never contact data, EEO or work authorization.
    NSMutableArray *answers = [NSMutableArray array];
    for (NSDictionary *item in [_core pastAnswersForProfile:profile label:label]) {
        if (answers.count >= kPastAnswersMax) break;
        NSString *question = GHClip(item[@"question"], kQuestionMax), *answer = GHClip(item[@"answer"], kAnswerMax);
        if (question && answer) [answers addObject:@{ @"question": question, @"answer": answer }];
    }
    body[@"pastAnswers"] = answers;
    if (maxChars >= kMinMaxChars) body[@"maxChars"] = @(MIN(maxChars, kMaxMaxChars));
    return [NSJSONSerialization dataWithJSONObject:body options:0 error:NULL];
}

- (GHGhostTextStream *)streamGhostTextForFieldLabel:(NSString *)fieldLabel fieldSignature:(NSString *)fieldSignature
                                        pageContext:(NSDictionary<NSString *, NSString *> *)pageContext
                                            profile:(NSDictionary<NSString *, id> *)profile maxChars:(NSUInteger)maxChars
                                           delegate:(id<GHGhostTextStreamDelegate>)delegate {
    GHGhostTextStream *stream = [[GHGhostTextStream alloc] init];
    stream.fieldSignature = fieldSignature ?: @"";
    stream.delegate = delegate;
    stream.received = [NSMutableString string];
    NSString *label = GHClip(fieldLabel, kLabelMax), *signature = GHClip(fieldSignature, kSignatureMax);
    NSString *refusal = nil;
    if (!label || !signature) refusal = @"bad-request";
    else if ([_core isSensitive:@{ @"label": label }]) refusal = @"sensitive";
    NSData *body = refusal ? nil : [self ghostTextBodyForLabel:label signature:signature pageContext:pageContext ?: @{} profile:profile ?: @{} maxChars:maxChars];
    NSMutableURLRequest *request = body ? [self requestForPath:@"/v1/ghost-text" body:body accept:@"text/event-stream"] : nil;
    if (!refusal && !request) refusal = body ? @"no-server-url" : @"bad-request";
    if (refusal) {
        dispatch_async(dispatch_get_main_queue(), ^{ [stream finishWithCode:refusal text:nil provider:nil latencyMs:nil]; });
        return nil;
    }
    request.timeoutInterval = GHServerStreamTimeout;
    __weak GHGhostTextStream *weakStream = stream;
    stream.parser = [[GHSSEParser alloc] initWithHandler:^(NSString *data) { [weakStream handleEventData:data]; }];
    stream.task = [_session dataTaskWithRequest:request];
    [_router addStream:stream];
    GHLog(@"server: /v1/ghost-text started label=%@", GHLogLabel(label));
    [stream.task resume];
    return stream;
}

- (void)cancelAll {
    for (GHGhostTextStream *stream in [_router allStreams]) [stream cancel];
    [_session getTasksWithCompletionHandler:^(NSArray *dataTasks, NSArray *uploadTasks, NSArray *downloadTasks) {
        for (NSURLSessionTask *task in dataTasks) [task cancel];
    }];
}

@end
