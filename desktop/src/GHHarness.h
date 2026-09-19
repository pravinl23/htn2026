// GHHarness: the agent-drivable test and debug harness (docs/desktop-realworld.md section 2).
//
//   --trust                       { "trusted": bool }
//   --dump                        captured fields of the frontmost window: labels, kinds, options, rects, locked. NO values.
//   --dump-tree [--depth 60]      raw AX tree; every value is reduced to its length
//   --autotab N [--interval 450]  posts N real, untagged Tab presses through the event tap and records each step
//   --frontmost "App"             bring an app forward first          --delay S   wait before looking
//   --out FILE                    write the JSON answer here (LaunchServices launches have no stdout)
//
// Rules that hold in every mode:
//   - Untrusted: the answer is { "error": "not trusted", "trusted": false } at once. Nothing waits, nothing prompts.
//   - The only key this file can post is Tab (GHAutotabKeyPosting has no other method). Never Return, Enter or Space.
//   - --autotab refuses to press Tab while the current ghost is locked, and stops there.
//   - No field value is ever written to the answer or to the log: lengths, labels and short codes only.
//
// A second `open -n` instance shares nothing with the agent that is already running, so --dump, --dump-tree and
// --autotab travel to that agent as a JSON file (GHHarnessChannel) and the agent writes --out. Without a running
// agent they run in the launched process (--autotab then starts the whole pipeline for the length of the run).
//
// Everything that decides something is pure and tested with fakes (request parsing and encoding, the channel,
// the tree redaction, the autotab loop); the live part only wires those to AX, CGEventPost and the controller.
#import <Foundation/Foundation.h>
#import "GHAXNode.h"

@class GHController;

NS_ASSUME_NONNULL_BEGIN

extern NSString *const GHHarnessModeTrust;
extern NSString *const GHHarnessModeDump;
extern NSString *const GHHarnessModeDumpTree;
extern NSString *const GHHarnessModeAutotab;

extern const NSInteger GHHarnessMaxAutotabCount;        // 200
extern const NSInteger GHHarnessDefaultIntervalMs;      // 450
extern const NSInteger GHHarnessDefaultDepth;           // 60
extern const NSUInteger GHHarnessMaxTreeNodes;          // 8000
extern const NSUInteger GHHarnessMaxTextLength;         // 120: titles, descriptions and static text are cut here
extern const NSTimeInterval GHHarnessRequestMaxAge;     // 120 s: an older request file is dropped, never run

#pragma mark - request and response

/// One harness invocation. Built from argv in the launched process; travels as JSON to a running agent.
@interface GHHarnessRequest : NSObject
@property (nonatomic, copy) NSString *identifier;          // file-name safe: [A-Za-z0-9-]{1,64}
@property (nonatomic, copy) NSString *mode;
@property (nonatomic) NSInteger count;                     // autotab: 1...200
@property (nonatomic) NSInteger intervalMs;                // autotab: 50...5000
@property (nonatomic) NSInteger depth;                     // dump-tree: 1...200
@property (nonatomic) NSTimeInterval delay;                // 0...60 s
@property (nonatomic, copy, nullable) NSString *frontmost; // app name or bundle id
@property (nonatomic, copy, nullable) NSString *outPath;   // absolute
@property (nonatomic) NSTimeInterval createdAt;            // seconds since 1970

/// nil with *error == nil when `arguments` holds no harness flag at all. nil with a short *error for a harness
/// invocation that is malformed (two modes, count out of range, relative --out, a flag without its value...).
+ (nullable instancetype)requestWithArguments:(NSArray<NSString *> *)arguments error:(NSString *_Nullable *_Nullable)error;
/// The --out of an invocation, even a malformed one, so the error has somewhere to go.
+ (nullable NSString *)outPathInArguments:(NSArray<NSString *> *)arguments;
/// Same validation as the argv path: a request file is input from outside the process.
+ (nullable instancetype)requestWithDictionary:(nullable NSDictionary<NSString *, id> *)dictionary error:(NSString *_Nullable *_Nullable)error;
+ (nullable instancetype)requestWithData:(nullable NSData *)data error:(NSString *_Nullable *_Nullable)error;
- (NSDictionary<NSString *, id> *)dictionary;
- (NSData *)data;
/// Upper bound for the whole run (delay + steps + slack): the client's and the watchdog's deadline.
@property (nonatomic, readonly) NSTimeInterval deadline;
/// The share of `deadline` the autotab loop itself may use before it stops with "timeout".
@property (nonatomic, readonly) NSTimeInterval autotabBudget;
@end

/// { "error": "not trusted", "trusted": false }
NSDictionary<NSString *, id> *GHHarnessNotTrustedResponse(void);
NSDictionary<NSString *, id> *GHHarnessErrorResponse(NSString *code, NSString *_Nullable detail);
/// Pretty printed, sorted keys. Something that is not JSON becomes an "encoding-failed" error, never a crash.
NSData *GHHarnessEncodeResponse(NSDictionary<NSString *, id> *response);
/// Atomic (rename), so a reader that sees the file sees all of it. With a nil path the JSON goes to stdout.
BOOL GHHarnessWriteResponse(NSDictionary<NSString *, id> *response, NSString *_Nullable outPath);

#pragma mark - talking to the agent that is already running

/// File channel in ~/Library/Application Support/Ghost/harness (0700):
///   requests/<id>.json   written by the launched process, claimed (read + deleted) by the agent
///   responses/<id>.json  only for a request without --out: the launched process prints it
///   agent.lock           flock()ed by the agent for as long as it lives, so "is an agent running" survives crashes
@interface GHHarnessChannel : NSObject
- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithDirectory:(NSString *)directory NS_DESIGNATED_INITIALIZER;
+ (instancetype)defaultChannel;
@property (nonatomic, readonly, copy) NSString *directory;
@property (nonatomic, readonly, copy) NSString *requestsDirectory;

// launched process
- (BOOL)sendRequest:(GHHarnessRequest *)request;
/// Still unclaimed: no agent has picked it up (yet).
- (BOOL)requestIsPending:(NSString *)identifier;
- (void)withdrawRequest:(NSString *)identifier;
- (NSString *)responsePathForIdentifier:(NSString *)identifier;
/// Somebody holds agent.lock.
- (BOOL)agentIsRunning;

// agent
/// NO when another agent holds the lock. The lock goes away with the process.
- (BOOL)acquireAgentLock;
- (void)releaseAgentLock;
/// Reads, validates and DELETES every request file, oldest first. Malformed and stale files are dropped.
- (NSArray<GHHarnessRequest *> *)claimPendingRequests;
@end

/// Distributed notification the launched process posts after writing a request (the agent also watches the folder).
extern NSString *const GHHarnessRequestNotification;

/// The agent's side: watches the channel, runs one request at a time, writes each answer to the request's --out.
@interface GHHarnessServer : NSObject
- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithChannel:(GHHarnessChannel *)channel controller:(GHController *_Nullable (^)(void))controller NS_DESIGNATED_INITIALIZER;
- (void)start;
- (void)stop;
/// Tests: how a request is performed (default: +[GHHarness performRequest:controller:completion:]).
@property (nonatomic, copy) void (^perform)(GHHarnessRequest *request, void (^completion)(NSDictionary<NSString *, id> *response));
/// Claims and runs whatever is waiting. Called by the folder watch and the notification; tests call it directly.
- (void)drain;
@property (nonatomic, readonly) NSUInteger servedCount;
@end

#pragma mark - --dump-tree

@interface GHHarnessTree : NSObject
/// Nested dictionaries: role, subrole, roleDescription, title, description, placeholder, help, identifier, classes,
/// actions, labelledBy (form controls only), rect, children; enabled only when false, focused and required only
/// when true. AXValue never appears: `valueLength` stands in for it, and is left out as well for secure and
/// sensitive-looking elements (those carry "sensitive": true). AXStaticText is page text, not input, so it is
/// kept (cut to GHHarnessMaxTextLength) as `text`. Any text that looks like contact data (an e-mail address, a
/// phone number) is replaced by "[redacted:<length>]". `actions` reads the action names of a node (nil for
/// none); the live path passes AXUIElementCopyActionNames.
+ (NSDictionary<NSString *, id> *)treeFromNode:(id<GHAXNode>)root
                                      maxDepth:(NSUInteger)maxDepth
                                      maxNodes:(NSUInteger)maxNodes
                                       actions:(nullable NSArray<NSString *> *_Nullable (^)(id<GHAXNode> node))actions
                                       visited:(nullable NSUInteger *)visited
                                     truncated:(nullable BOOL *)truncated;
/// The same with a wall-clock budget in seconds (0 = none): the live path, where one AX call can take 1 s.
+ (NSDictionary<NSString *, id> *)treeFromNode:(id<GHAXNode>)root
                                      maxDepth:(NSUInteger)maxDepth
                                      maxNodes:(NSUInteger)maxNodes
                                       actions:(nullable NSArray<NSString *> *_Nullable (^)(id<GHAXNode> node))actions
                                       visited:(nullable NSUInteger *)visited
                                     truncated:(nullable BOOL *)truncated
                                    timeBudget:(NSTimeInterval)timeBudget;
/// The text rule on its own (exposed for tests): single line, cut, contact data redacted. nil for empty text.
+ (nullable NSString *)safeText:(nullable NSString *)text;
@end

#pragma mark - --autotab

/// What the loop reads. GHController is one; tests pass a fake.
@protocol GHAutotabSubject <NSObject>
@property (nonatomic, readonly) NSUInteger stepCount;
@property (nonatomic, readonly, copy, nullable) NSDictionary<NSString *, id> *lastStep;
@property (nonatomic, readonly) BOOL busy;
- (NSDictionary<NSString *, id> *)harnessState;
@end

/// The ONLY thing the harness can do to the keyboard.
@protocol GHAutotabKeyPosting <NSObject>
/// One unmodified Tab press (down + up). NO when it could not be posted.
- (BOOL)postTab;
@end

/// Live poster: a plain HID-state event source, no GHSyntheticEventUserData tag, no modifier flags, so the press
/// goes through Ghost's own event tap exactly like the user's. Key code 48 is hard-wired.
@interface GHHarnessTabPoster : NSObject <GHAutotabKeyPosting>
/// Every key code this class can post: @[ @48 ]. Pinned by a test so that Return (36), Enter (76) and Space (49)
/// can never slip in.
+ (NSArray<NSNumber *> *)postableKeyCodes;
@end

@interface GHAutotabRunner : NSObject
- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithSubject:(id<GHAutotabSubject>)subject poster:(id<GHAutotabKeyPosting>)poster NS_DESIGNATED_INITIALIZER;
/// Defaults: dispatch_after on the main queue, and the monotonic clock. Tests run both by hand.
@property (nonatomic, copy) void (^after)(NSTimeInterval delay, dispatch_block_t block);
@property (nonatomic, copy) NSTimeInterval (^clock)(void);
/// How long a step may stay busy past its interval (a draft wait, a slow app) before it is recorded as it is. 8 s.
@property (nonatomic) NSTimeInterval maxSettle;
/// Whole-run budget; 0 = none. Checked before every press ("timeout").
@property (nonatomic) NSTimeInterval maxDuration;
/// Before EVERY press, in this order: not active -> stops "inactive"; current ghost locked -> "locked" (the press
/// is refused; `lockedLabel` names it); `count` presses done -> "count"; no current ghost -> "no-ghost"; three
/// presses in a row that Ghost did not consume -> "stalled"; over budget -> "timeout". A press that could not be
/// posted stops with "post-failed".
/// Report: { requested, posted, stopped, lockedLabel?, steps: [{ step, ghost, action, consumed, outcome, verified,
/// reason?, ms, writeMs?, next? }], final: <harnessState> }.
- (void)runCount:(NSInteger)count intervalMs:(NSInteger)intervalMs completion:(void (^)(NSDictionary<NSString *, id> *report))completion;
@end

#pragma mark - live

@interface GHHarness : NSObject
/// Runs a dump, dump-tree or autotab request in THIS process and calls back on the main queue with the answer.
/// Never blocks the main queue (the event tap delivers through it): the AX walks run on a background queue.
/// `controller` is the running pipeline, needed by autotab only. Trust is checked first: untrusted answers
/// GHHarnessNotTrustedResponse at once.
+ (void)performRequest:(GHHarnessRequest *)request controller:(nullable GHController *)controller
            completion:(void (^)(NSDictionary<NSString *, id> *response))completion;
/// { "trusted": bool, "pid", "library" } plus "error": "not trusted" when it is not.
+ (NSDictionary<NSString *, id> *)trustResponse;
+ (BOOL)processIsTrusted;
/// Tests replace AXIsProcessTrusted(); nil restores it.
+ (void)setTrustProbe:(nullable BOOL (^)(void))probe;
/// Path of the image this code was loaded from (libghost.dylib, or the test runner).
+ (nullable NSString *)libraryPath;
@end

NS_ASSUME_NONNULL_END
