// GHServerClient: the only place Ghost Desktop talks to the local prediction server (default
// http://127.0.0.1:8787, from settings.serverUrl).
//
// Privacy rules enforced here, not left to callers:
//   - POST /v1/predict/form carries fact KEYS and value-free, non-sensitive fields. Never a profile value,
//     never a field's current value. The body is built by GhostCore.formRequest (same rules as the extension).
//   - POST /v1/ghost-text carries only GhostCore.textFacts (no contact details) and is refused locally for
//     sensitive labels.
//   - `Content-Type: application/json`, no `Origin` header, no cookies, no URL cache.
//   - 3 s timeout, silent offline fallback: errors are short codes ("timeout", "unreachable", "http-500",
//     "bad-response", "bad-request", "no-server-url"), never response or request content.
// All completion handlers and delegate callbacks arrive on the main queue.
#import <Foundation/Foundation.h>
#import "GHField.h"

@class GHCore, GHGhostTextStream;

NS_ASSUME_NONNULL_BEGIN

extern const NSTimeInterval GHServerRequestTimeout;      // 3 s
extern const NSTimeInterval GHServerStreamTimeout;       // 30 s
extern const NSTimeInterval GHPresenceFreshSeconds;      // 90 s

#pragma mark - results

@interface GHFormPrediction : NSObject
/// Cleaned { signature, factKey, confidence, source?, calibrated? } dictionaries.
@property (nonatomic, readonly, copy) NSArray<NSDictionary<NSString *, id> *> *assignments;
@property (nonatomic, readonly, copy) NSString *provider;
@property (nonatomic, readonly) BOOL calibrated;
/// The server's own figure; nil for cache hits.
@property (nonatomic, readonly, nullable) NSNumber *serverLatencyMs;
/// What the user waited for: the cache read or the whole round trip.
@property (nonatomic, readonly) double elapsedMs;
@property (nonatomic, readonly) BOOL fromCache;
@property (nonatomic, readonly, copy, nullable) NSString *fallbackFrom;
/// "cache" or "server": the GhostSource to hand to GHCore.
@property (nonatomic, readonly) NSString *ghostSource;
@end

@interface GHServerHealth : NSObject
@property (nonatomic, readonly, copy) NSString *provider;
@property (nonatomic, readonly) BOOL calibrated;
@property (nonatomic, readonly, copy) NSString *textProvider;
@property (nonatomic, readonly, copy, nullable) NSString *model;
@property (nonatomic, readonly, copy, nullable) NSString *version;
@end

/// GET /v1/presence: which browser extensions sent a heartbeat lately.
/// Expected reply: { "clients": [ { "client": "extension", "browser": "chrome", "ageMs": 1200 } ] }
/// (`lastSeen` in epoch milliseconds is accepted in place of `ageMs`).
@interface GHPresence : NSObject
/// browser name (lower case) -> seconds since its last heartbeat.
@property (nonatomic, readonly, copy) NSDictionary<NSString *, NSNumber *> *extensionAges;
/// YES when the extension of the browser with this bundle id checked in less than 90 s ago.
- (BOOL)isExtensionActiveForBundleId:(nullable NSString *)bundleId;
/// "chrome", "arc", "firefox"... or nil for apps that are not a known browser.
+ (nullable NSString *)browserNameForBundleId:(nullable NSString *)bundleId;
+ (instancetype)presenceFromJSONObject:(nullable id)json now:(NSDate *)now;
@end

#pragma mark - SSE

/// Incremental Server-Sent Events reader. Events end at a blank line; the `data:` lines of one event are
/// joined with "\n". Works on BYTES, so a chunk boundary in the middle of a line, of a CRLF or of a
/// multi-byte UTF-8 character loses nothing.
@interface GHSSEParser : NSObject
- (instancetype)initWithHandler:(void (^)(NSString *data))handler NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;
- (void)appendData:(NSData *)chunk;
/// End of body: a last event without its blank line still counts.
- (void)finish;
@end

#pragma mark - streaming drafts

@protocol GHGhostTextStreamDelegate <NSObject>
- (void)ghostTextStream:(GHGhostTextStream *)stream didReceiveDelta:(NSString *)delta;
- (void)ghostTextStream:(GHGhostTextStream *)stream didFinishWithText:(NSString *)text provider:(NSString *)provider latencyMs:(nullable NSNumber *)latencyMs;
/// `code` is a short code ("aborted", "timeout", "unreachable", "http-400", "server-error", "stream-ended-early", "sensitive").
- (void)ghostTextStream:(GHGhostTextStream *)stream didFailWithCode:(NSString *)code;
@end

@interface GHGhostTextStream : NSObject
@property (nonatomic, readonly, copy) NSString *fieldSignature;
/// Text received so far.
@property (nonatomic, readonly, copy) NSString *text;
@property (nonatomic, readonly) BOOL finished;
/// Typing, Escape, app switch: stop the draft. The delegate gets didFailWithCode:@"aborted" once.
- (void)cancel;
@end

#pragma mark - per-window cache

/// Assignments per (origin, form signature, fact keys), in memory and in form-cache.json (0600).
/// Entries hold signatures, fact KEYS and confidences: never values.
@interface GHFormCache : NSObject
/// nil path = memory only.
- (instancetype)initWithPath:(nullable NSString *)path NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;
@property (nonatomic) NSUInteger maxEntries;      // 200
@property (nonatomic) NSTimeInterval maxAge;      // 30 days
- (nullable NSDictionary<NSString *, id> *)entryForOrigin:(NSString *)origin formSignature:(NSString *)formSignature factKeys:(NSArray<NSString *> *)factKeys;
- (void)saveAssignments:(NSArray<NSDictionary *> *)assignments provider:(NSString *)provider calibrated:(BOOL)calibrated
              forOrigin:(NSString *)origin formSignature:(NSString *)formSignature factKeys:(NSArray<NSString *> *)factKeys;
- (void)removeAll;
@property (nonatomic, readonly) NSUInteger count;
/// Blocks until queued disk writes are done (tests, and right before exit).
- (void)waitForWrites;
@end

#pragma mark - client

@interface GHServerClient : NSObject

/// `configuration` is injectable for tests (protocolClasses with a stub). nil = ephemeral, no cookies, no cache.
- (instancetype)initWithBaseURLString:(nullable NSString *)baseURLString
                                 core:(GHCore *)core
                        configuration:(nullable NSURLSessionConfiguration *)configuration
                                cache:(nullable GHFormCache *)cache NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

/// Plain http(s) URL without credentials, trailing slashes removed. Setting an invalid one makes every
/// call fail with "no-server-url".
@property (atomic, copy, nullable) NSString *baseURLString;
+ (nullable NSString *)normalizedServerURL:(nullable NSString *)raw;

@property (nonatomic, readonly, nullable) GHFormCache *cache;
/// Last successful round trip in milliseconds, and the last error code (nil after a success).
@property (atomic, readonly, nullable) NSNumber *lastLatencyMs;
@property (atomic, readonly, copy, nullable) NSString *lastErrorCode;

/// The cache key part that stands for "where", and what the server sees as the form's origin: "app://<bundle
/// id>/<host>" when the page URL has a host, else "app://<bundle id>". Never a path or a query, and never anything
/// from the window title (`windowTitle` is ignored: titles name documents, mailboxes and tabs).
+ (NSString *)originForBundleId:(nullable NSString *)bundleId pageURL:(nullable NSString *)pageURL windowTitle:(nullable NSString *)windowTitle;

/// Cache first (zero calls on a repeat visit), then ONE POST /v1/predict/form for the whole form.
/// `prediction` is nil when there is nothing to ask or the server did not answer usefully; `errorCode`
/// then says why. A server fallback answer (`fallbackFrom`) is returned but not cached.
- (void)predictFormForFields:(NSArray<GHField *> *)fields
                    factKeys:(NSArray<NSString *> *)factKeys
                      origin:(NSString *)origin
               formSignature:(NSString *)formSignature
                  completion:(void (^)(GHFormPrediction *_Nullable prediction, NSString *_Nullable errorCode))completion;
/// Local learned answers are removed before the value-free request is built; the snapshot itself never leaves.
- (void)predictFormForFields:(NSArray<GHField *> *)fields
                    factKeys:(NSArray<NSString *> *)factKeys
              learnedAnswers:(nullable NSDictionary<NSString *, id> *)learnedAnswers
                      origin:(NSString *)origin
               formSignature:(NSString *)formSignature
                  completion:(void (^)(GHFormPrediction *_Nullable prediction, NSString *_Nullable errorCode))completion;

- (void)checkHealthWithCompletion:(void (^)(GHServerHealth *_Nullable health, NSString *_Nullable errorCode))completion;
- (void)fetchPresenceWithCompletion:(void (^)(GHPresence *_Nullable presence, NSString *_Nullable errorCode))completion;

/// Streams one free-text draft. `profile` is the full profile; only GhostCore.textFacts of it and at most
/// three past answers leave the process. Returns nil (after telling the delegate why) when the label is
/// sensitive or there is no server URL.
- (nullable GHGhostTextStream *)streamGhostTextForFieldLabel:(NSString *)fieldLabel
                                              fieldSignature:(NSString *)fieldSignature
                                                 pageContext:(nullable NSDictionary<NSString *, NSString *> *)pageContext
                                                     profile:(NSDictionary<NSString *, id> *)profile
                                                    maxChars:(NSUInteger)maxChars
                                                    delegate:(id<GHGhostTextStreamDelegate>)delegate;

/// Cancels every in-flight request and stream (app switch, disable, quit).
- (void)cancelAll;

@end

NS_ASSUME_NONNULL_END
