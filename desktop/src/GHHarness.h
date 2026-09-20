// GHHarness: the agent-drivable test and debug harness (docs/desktop-realworld.md section 2).
//
//   --trust                       { "trusted": bool }
//   --dump                        captured fields of the frontmost window: labels, kinds, options, rects, locked. NO values.
//   --dump-tree [--depth 60]      raw AX tree; every value is reduced to its length
//   --next                        what Ghost would PROPOSE here (docs/anywhere.md): page kind, ranked roles, the top
//                                 row. Read-only: it never posts a key and never presses anything.
//   --autotab N [--interval 450]  posts N real, untagged Tab presses through the event tap and records each step
//   --frontmost "App"             bring an app forward first          --delay S   wait before looking
//   --expect-field "First Name"   the page guard: a captured label must match this, or nothing is sent
//   --probe-combobox "How did"    open ONE combo box, write down what the tree then shows, close it again (GHProbe)
//   --out FILE                    write the JSON answer here (LaunchServices launches have no stdout)
//
// Rules that hold in every mode:
//   - Untrusted: the answer is { "error": "not trusted", "trusted": false } at once. Nothing waits, nothing prompts.
//   - The only key this file can post is Tab (GHAutotabKeyPosting has no other method). Never Return, Enter or Space.
//   - --autotab refuses to press Tab while the current ghost is locked, and stops there.
//   - No field value is ever written to the answer or to the log: lengths, labels and short codes only.
//
// --expect-field pins the PAGE, not just the app. `--frontmost Safari` only promises that Safari is in front; the
// user's frontmost TAB may be anything. With --expect-field the harness re-captures the frontmost window before the
// first Tab AND before every later press, and refuses to post unless some captured field label still matches. A
// window or tab that changed under the run therefore costs at most zero keystrokes: the run stops with
// "expect-field-missing" and sends nothing. --dump and --dump-tree report the same check instead of stopping a walk.
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
extern NSString *const GHHarnessModeNext;
extern NSString *const GHHarnessModeAutotab;
/// Take the ghost that is on screen right now, exactly as the Ghost key does. The ONE harness mode that
/// actuates: it presses a real control in a real app. Read-only everywhere else.
extern NSString *const GHHarnessModeAccept;
extern NSString *const GHHarnessModeProbeComboBox;

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
@property (nonatomic, copy, nullable) NSString *expectField; // page guard: 1...200 chars, one line
@property (nonatomic, copy, nullable) NSString *probeLabel;  // --probe-combobox: which combo box to open
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

/// Does any captured label satisfy `expectation`? Case-insensitive, diacritic-insensitive, whitespace collapsed,
/// and the trailing `*` / ` (Required)` decoration Greenhouse and Workday add to labels does not matter because the
/// test is "contains". An empty expectation is satisfied by anything (no guard); an expectation with no matching
/// label is NOT satisfied, and neither is one against an empty label list (a page that captured nothing is exactly
/// the case the guard exists for).
BOOL GHHarnessLabelsMeetExpectation(NSArray<NSString *> *_Nullable labels, NSString *_Nullable expectation);

/// { "error": "not trusted", "trusted": false }
NSDictionary<NSString *, id> *GHHarnessNotTrustedResponse(void);
NSDictionary<NSString *, id> *GHHarnessErrorResponse(NSString *code, NSString *_Nullable detail);
/// Pretty printed, sorted keys. Something that is not JSON becomes an "encoding-failed" error, never a crash.
NSData *GHHarnessEncodeResponse(NSDictionary<NSString *, id> *response);
/// Atomic (a fresh 0600 temporary file renamed onto the name), so a reader that sees the file sees all of it and
/// nobody else can read it. Refuses a path that fails GHHarnessProblemWithOutPath. With a nil path the JSON goes
/// to stdout.
BOOL GHHarnessWriteResponse(NSDictionary<NSString *, id> *response, NSString *_Nullable outPath);
/// nil when `path` may receive an answer: absolute, normalized, a `.json` name inside an EXISTING directory owned by
/// this user, and not a directory, link or device already. Else a short reason.
NSString *_Nullable GHHarnessProblemWithOutPath(NSString *_Nullable path);
/// Removes an old answer at `path` before a run: only a plain file owned by this user (unlink, never recursive,
/// never through a link). YES when nothing is left there.
BOOL GHHarnessRemoveOldAnswer(NSString *_Nullable path);

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
/// when true. AXValue never appears: `valueLength` stands in for it. A secure or sensitive-looking element is
/// ONLY { role, "sensitive": true }: no label, no length, no subtree. Window, document and tab titles are never
/// written (AXWindow title, AXWebArea title and description, the outer AXTabGroup's), and browser chrome outside
/// the page (toolbars, tab-bar items, the address field) is { role, "omitted": "browser-chrome" }; the path to the
/// AXWebArea is walked. Text-entry controls and chosen-value widgets are not entered (`childrenOmitted`): what is
/// inside them is input. Other AXStaticText is page text and is kept (cut to GHHarnessMaxTextLength) as `text`.
/// Any text that looks like contact data (an e-mail address, a phone number) is replaced by "[redacted:<length>]".
/// `actions` reads the action names of a node (nil for none); the live path passes AXUIElementCopyActionNames.
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
/// --expect-field. Asked once more right before EVERY press, after every cheaper check has passed, so it costs a
/// capture only when a Tab is actually about to go out. It answers nil to allow the press, or the stop code to
/// refuse it ("expect-field-missing", "frontmost-changed"...): the press is then never posted. Nil block = no guard.
@property (nonatomic, copy, nullable) void (^precondition)(void (^allow)(NSString *_Nullable problem));
/// Copied into the report so a record says which page it was pinned to. Purely descriptive; `precondition` decides.
@property (nonatomic, copy, nullable) NSString *expectField;
/// Before EVERY press, in this order: not active -> stops "inactive"; current ghost locked -> "locked" (the press
/// is refused; `lockedLabel` names it); `count` presses done -> "count"; no current ghost -> "no-ghost"; three
/// presses in a row that Ghost did not consume -> "stalled"; over budget -> "timeout"; then `precondition`. A press
/// that could not be posted stops with "post-failed".
/// Report: { requested, posted, stopped, lockedLabel?, expectField?, steps: [{ step, ghost, action, consumed,
/// outcome, verified, reason?, ms, writeMs?, next? }], final: <harnessState> }.
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
/// --dump / --dump-tree refuse an app on the built-in pause list OR the user's own list (settings.json). nil bundle
/// ids count as paused.
+ (BOOL)bundleIdentifierIsPaused:(nullable NSString *)bundleId;
/// Tests replace the pause check; nil restores it.
+ (void)setPauseCheck:(nullable BOOL (^)(NSString *_Nullable bundleId))check;
/// Path of the image this code was loaded from (libghost.dylib, or the test runner).
+ (nullable NSString *)libraryPath;
@end

NS_ASSUME_NONNULL_END
