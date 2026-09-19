// GHHarness without AX, without a keyboard and without the real ~/Library: request parsing and encoding, the file
// channel, the agent-side server, the tree redaction and the autotab loop (fake controller, fake key poster, a
// clock and a timer the test runs by hand).
#import "GHTest.h"
#import "GHHarness.h"
#import <objc/runtime.h>

#pragma mark - fakes

/// A scripted walk: each entry is { label, action, locked, consumes (default YES), outcome (default accepted) }.
@interface GHFakeAutotabSubject : NSObject <GHAutotabSubject>
@property (nonatomic, copy) NSArray<NSDictionary *> *ghosts;
@property (nonatomic) NSUInteger index;
@property (nonatomic) BOOL active;
@property (nonatomic, readwrite) NSUInteger stepCount;
@property (nonatomic, readwrite, copy, nullable) NSDictionary<NSString *, id> *lastStep;
@property (nonatomic, readwrite) BOOL busy;
@property (nonatomic) NSUInteger tabsSeen;
- (void)tabArrived;
@end

@implementation GHFakeAutotabSubject

- (NSDictionary *)current {
    return self.index < self.ghosts.count ? self.ghosts[self.index] : nil;
}

- (NSDictionary<NSString *, id> *)harnessState {
    NSMutableDictionary *state = [@{ @"active": @(self.active), @"ghosts": @(self.ghosts.count) } mutableCopy];
    NSDictionary *current = [self current];
    if (current) state[@"current"] = @{ @"label": current[@"label"], @"action": current[@"action"] ?: @"fill", @"locked": current[@"locked"] ?: @NO };
    return state;
}

- (void)tabArrived {
    self.tabsSeen++;
    NSDictionary *current = [self current];
    if (!current || [current[@"consumes"] isEqual:@NO]) return;   // a native Tab: Ghost did not take it
    NSString *outcome = current[@"outcome"] ?: @"accepted";
    self.lastStep = @{ @"label": current[@"label"], @"action": current[@"action"] ?: @"fill", @"outcome": outcome,
                       @"verified": @([outcome isEqualToString:@"accepted"]), @"ms": @7 };
    self.stepCount++;
    if ([outcome isEqualToString:@"accepted"]) self.index++;
}

@end

@interface GHFakeTabPoster : NSObject <GHAutotabKeyPosting>
@property (nonatomic, weak) GHFakeAutotabSubject *subject;
@property (nonatomic) NSUInteger posted;
@property (nonatomic) BOOL fails;
@end

@implementation GHFakeTabPoster
- (BOOL)postTab {
    if (self.fails) return NO;
    self.posted++;
    [self.subject tabArrived];
    return YES;
}
@end

/// Runs a runner to the end with a hand-driven timer and clock. Returns the report (nil if it never finished).
static NSDictionary *RunAutotab(GHFakeAutotabSubject *subject, GHFakeTabPoster *poster, NSInteger count, void (^configure)(GHAutotabRunner *)) {
    poster.subject = subject;
    GHAutotabRunner *runner = [[GHAutotabRunner alloc] initWithSubject:subject poster:poster];
    NSMutableArray<dispatch_block_t> *timers = [NSMutableArray array];
    __block NSTimeInterval now = 1000;
    runner.after = ^(NSTimeInterval delay, dispatch_block_t block) { now += delay; [timers addObject:[block copy]]; };
    runner.clock = ^NSTimeInterval { return now; };
    if (configure) configure(runner);
    __block NSDictionary *report = nil;
    [runner runCount:count intervalMs:100 completion:^(NSDictionary<NSString *, id> *r) { report = r; }];
    for (NSUInteger guard = 0; !report && timers.count && guard < 10000; guard++) {
        dispatch_block_t next = timers.firstObject;
        [timers removeObjectAtIndex:0];
        next();
    }
    return report;
}

static NSDictionary *Ghost(NSString *label, BOOL locked) {
    return @{ @"label": label, @"action": locked ? @"click" : @"fill", @"locked": @(locked) };
}

static GHFakeAutotabSubject *Subject(NSArray<NSDictionary *> *ghosts) {
    GHFakeAutotabSubject *subject = [[GHFakeAutotabSubject alloc] init];
    subject.ghosts = ghosts;
    subject.active = YES;
    return subject;
}

#pragma mark - request parsing

GH_TEST(harness_request_is_nil_without_a_harness_flag) {
    NSString *error = @"untouched";
    GH_ASSERT([GHHarnessRequest requestWithArguments:@[ @"/path/Ghost", @"-NSDocumentRevisionsDebugMode", @"YES" ] error:&error] == nil);
    GH_ASSERT(error == nil);
}

GH_TEST(harness_request_parses_autotab_with_every_option) {
    NSString *error;
    GHHarnessRequest *request = [GHHarnessRequest requestWithArguments:@[ @"Ghost", @"--autotab", @"12", @"--interval", @"300", @"--delay", @"1.5",
                                                                           @"--frontmost", @"Safari", @"--out", @"/tmp/a.json" ] error:&error];
    GH_ASSERT_MSG(request != nil, @"%@", error);
    GH_ASSERT_EQUAL_OBJECTS(request.mode, GHHarnessModeAutotab);
    GH_ASSERT_EQUAL_INT(request.count, 12);
    GH_ASSERT_EQUAL_INT(request.intervalMs, 300);
    GH_ASSERT_NEAR(request.delay, 1.5, 0.0001);
    GH_ASSERT_EQUAL_OBJECTS(request.frontmost, @"Safari");
    GH_ASSERT_EQUAL_OBJECTS(request.outPath, @"/tmp/a.json");
    GH_ASSERT(request.identifier.length > 0 && request.createdAt > 0);
    GH_ASSERT(request.deadline > request.autotabBudget);
}

GH_TEST(harness_request_defaults) {
    GHHarnessRequest *tree = [GHHarnessRequest requestWithArguments:@[ @"Ghost", @"--dump-tree" ] error:NULL];
    GH_ASSERT_EQUAL_OBJECTS(tree.mode, GHHarnessModeDumpTree);
    GH_ASSERT_EQUAL_INT(tree.depth, GHHarnessDefaultDepth);
    GH_ASSERT_EQUAL_INT(tree.intervalMs, GHHarnessDefaultIntervalMs);
    GH_ASSERT_NEAR(tree.delay, 0, 0.0001);
    GH_ASSERT(tree.outPath == nil && tree.frontmost == nil);
    GHHarnessRequest *trust = [GHHarnessRequest requestWithArguments:@[ @"Ghost", @"--trust" ] error:NULL];
    GHHarnessRequest *dump = [GHHarnessRequest requestWithArguments:@[ @"Ghost", @"--dump" ] error:NULL];
    GH_ASSERT_EQUAL_OBJECTS(trust.mode, GHHarnessModeTrust);
    GH_ASSERT_EQUAL_OBJECTS(dump.mode, GHHarnessModeDump);
}

GH_TEST(harness_request_rejects_malformed_invocations) {
    NSArray<NSArray<NSString *> *> *bad = @[
        @[ @"--dump", @"--trust" ],                    // two modes
        @[ @"--autotab" ],                             // no count
        @[ @"--autotab", @"--out" ],                   // a flag where the count belongs
        @[ @"--autotab", @"0" ], @[ @"--autotab", @"201" ], @[ @"--autotab", @"3.5" ], @[ @"--autotab", @"many" ],
        @[ @"--autotab", @"3", @"--interval", @"10" ], @[ @"--autotab", @"3", @"--interval", @"9000" ],
        @[ @"--dump", @"--out", @"relative.json" ],
        @[ @"--dump", @"--delay", @"-1" ], @[ @"--dump", @"--delay", @"61" ],
        @[ @"--dump-tree", @"--depth", @"0" ], @[ @"--dump-tree", @"--depth", @"500" ],
        @[ @"--out", @"/tmp/x.json" ],                 // harness flag, no mode
    ];
    for (NSArray<NSString *> *arguments in bad) {
        NSString *error = nil;
        GHHarnessRequest *request = [GHHarnessRequest requestWithArguments:[@[ @"Ghost" ] arrayByAddingObjectsFromArray:arguments] error:&error];
        GH_ASSERT_MSG(request == nil && error.length > 0, @"%@ should be rejected", [arguments componentsJoinedByString:@" "]);
    }
}

GH_TEST(harness_out_path_survives_a_malformed_invocation) {
    GH_ASSERT_EQUAL_OBJECTS([GHHarnessRequest outPathInArguments:(@[ @"Ghost", @"--autotab", @"999", @"--out", @"/tmp/e.json" ])], @"/tmp/e.json");
    GH_ASSERT([GHHarnessRequest outPathInArguments:(@[ @"Ghost", @"--dump", @"--out", @"relative.json" ])] == nil);
    GH_ASSERT([GHHarnessRequest outPathInArguments:(@[ @"Ghost", @"--dump", @"--out" ])] == nil);
}

#pragma mark - encoding

GH_TEST(harness_request_round_trips_through_json) {
    GHHarnessRequest *request = [GHHarnessRequest requestWithArguments:@[ @"Ghost", @"--autotab", @"7", @"--interval", @"250", @"--delay", @"2",
                                                                           @"--frontmost", @"com.apple.Safari", @"--out", @"/tmp/r.json" ] error:NULL];
    NSString *error;
    GHHarnessRequest *copy = [GHHarnessRequest requestWithData:[request data] error:&error];
    GH_ASSERT_MSG(copy != nil, @"%@", error);
    GH_ASSERT_EQUAL_OBJECTS([copy dictionary], [request dictionary]);
    GH_ASSERT_EQUAL_OBJECTS(copy.identifier, request.identifier);
    GH_ASSERT_EQUAL_INT(copy.count, 7);
    // Only what the mode needs travels: a dump carries no count.
    GHHarnessRequest *dump = [GHHarnessRequest requestWithArguments:@[ @"Ghost", @"--dump" ] error:NULL];
    GH_ASSERT([dump dictionary][@"count"] == nil && [dump dictionary][@"out"] == nil);
}

GH_TEST(harness_request_file_is_validated_like_argv) {
    NSDictionary *good = @{ @"id": @"abc-123", @"mode": @"autotab", @"count": @3 };
    GH_ASSERT([GHHarnessRequest requestWithDictionary:good error:NULL] != nil);
    NSArray<NSDictionary *> *bad = @[
        @{ @"id": @"../../etc/x", @"mode": @"dump" },              // the id becomes a file name
        @{ @"id": @"", @"mode": @"dump" }, @{ @"mode": @"dump" },
        @{ @"id": @"a", @"mode": @"submit" }, @{ @"id": @"a", @"mode": @7 },
        @{ @"id": @"a", @"mode": @"autotab" },                     // no count
        @{ @"id": @"a", @"mode": @"autotab", @"count": @YES },     // a JSON boolean is not a count
        @{ @"id": @"a", @"mode": @"autotab", @"count": @"3" },
        @{ @"id": @"a", @"mode": @"autotab", @"count": @5000 },
        @{ @"id": @"a", @"mode": @"dump", @"out": @"relative" }, @{ @"id": @"a", @"mode": @"dump", @"out": @[ @"/x" ] },
        @{ @"id": @"a", @"mode": @"dump", @"frontmost": @"two\nlines" },
    ];
    for (NSDictionary *dictionary in bad) {
        NSString *error = nil;
        GH_ASSERT_MSG([GHHarnessRequest requestWithDictionary:dictionary error:&error] == nil && error.length > 0, @"%@ should be rejected", dictionary);
    }
    GH_ASSERT([GHHarnessRequest requestWithData:[@"not json" dataUsingEncoding:NSUTF8StringEncoding] error:NULL] == nil);
    GH_ASSERT([GHHarnessRequest requestWithData:nil error:NULL] == nil);
    GH_ASSERT([GHHarnessRequest requestWithDictionary:(id)@[ @"array" ] error:NULL] == nil);
}

GH_TEST(harness_response_encoding) {
    GH_ASSERT_EQUAL_OBJECTS(GHHarnessNotTrustedResponse(), (@{ @"error": @"not trusted", @"trusted": @NO }));
    GH_ASSERT_EQUAL_OBJECTS(GHHarnessErrorResponse(@"timeout", nil), (@{ @"error": @"timeout" }));
    GH_ASSERT_EQUAL_OBJECTS(GHHarnessErrorResponse(@"no-window", @"AXError -25204"), (@{ @"error": @"no-window", @"detail": @"AXError -25204" }));
    NSString *text = [[NSString alloc] initWithData:GHHarnessEncodeResponse(GHHarnessNotTrustedResponse()) encoding:NSUTF8StringEncoding];
    // ghostctl decides its exit status on this exact shape: a top-level "error" key, two spaces in.
    GH_ASSERT([text containsString:@"\n  \"error\" : \"not trusted\""]);
    GH_ASSERT([text hasSuffix:@"}\n"]);
    GH_ASSERT_EQUAL_OBJECTS([NSJSONSerialization JSONObjectWithData:[text dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL], GHHarnessNotTrustedResponse());
    // Something that is not JSON must not crash the agent.
    NSDictionary *decoded = [NSJSONSerialization JSONObjectWithData:GHHarnessEncodeResponse(@{ @"when": NSDate.date }) options:0 error:NULL];
    GH_ASSERT_EQUAL_OBJECTS(decoded[@"error"], @"encoding-failed");
}

GH_TEST(harness_response_is_written_whole) {
    NSString *path = [[GHTestTempDirectory() stringByAppendingPathComponent:@"deep/er"] stringByAppendingPathComponent:@"out.json"];
    GH_ASSERT(GHHarnessWriteResponse(@{ @"trusted": @YES, @"fields": @[] }, path));
    NSDictionary *read = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:path] options:0 error:NULL];
    GH_ASSERT_EQUAL_OBJECTS(read, (@{ @"trusted": @YES, @"fields": @[] }));
}

#pragma mark - untrusted

GH_TEST(harness_untrusted_answers_at_once_in_every_mode) {
    [GHHarness setTrustProbe:^BOOL { return NO; }];
    for (NSArray<NSString *> *arguments in @[ @[ @"--dump", @"--delay", @"30" ], @[ @"--dump-tree", @"--frontmost", @"Safari" ], @[ @"--autotab", @"5" ] ]) {
        GHHarnessRequest *request = [GHHarnessRequest requestWithArguments:[@[ @"Ghost" ] arrayByAddingObjectsFromArray:arguments] error:NULL];
        __block NSDictionary *response = nil;
        [GHHarness performRequest:request controller:nil completion:^(NSDictionary<NSString *, id> *answer) { response = answer; }];
        // Synchronously: no delay is waited out, no app is brought forward, nothing is posted.
        if (![response isEqual:GHHarnessNotTrustedResponse()]) { [GHHarness setTrustProbe:nil]; GH_FAIL(@"%@ answered %@", request.mode, response); }
    }
    NSDictionary *trust = [GHHarness trustResponse];
    [GHHarness setTrustProbe:nil];
    GH_ASSERT_EQUAL_OBJECTS(trust[@"trusted"], @NO);
    GH_ASSERT_EQUAL_OBJECTS(trust[@"error"], @"not trusted");
    GH_ASSERT([trust[@"pid"] intValue] == getpid());
}

GH_TEST(harness_trusted_trust_response_has_no_error) {
    [GHHarness setTrustProbe:^BOOL { return YES; }];
    NSDictionary *trust = [GHHarness trustResponse];
    [GHHarness setTrustProbe:nil];
    GH_ASSERT_EQUAL_OBJECTS(trust[@"trusted"], @YES);
    GH_ASSERT(trust[@"error"] == nil);
    GH_ASSERT([trust[@"library"] length] > 0);
}

#pragma mark - channel

static GHHarnessRequest *DumpRequest(void) {
    return [GHHarnessRequest requestWithArguments:@[ @"Ghost", @"--dump", @"--out", @"/tmp/ghost-test-out.json" ] error:NULL];
}

GH_TEST(harness_channel_send_claim_once) {
    GHHarnessChannel *channel = [[GHHarnessChannel alloc] initWithDirectory:GHTestTempDirectory()];
    GHHarnessRequest *request = DumpRequest();
    GH_ASSERT_FALSE([channel requestIsPending:request.identifier]);
    GH_ASSERT([channel sendRequest:request]);
    GH_ASSERT([channel requestIsPending:request.identifier]);
    NSArray<GHHarnessRequest *> *claimed = [channel claimPendingRequests];
    GH_ASSERT_EQUAL_INT(claimed.count, 1);
    GH_ASSERT_EQUAL_OBJECTS([claimed.firstObject dictionary], [request dictionary]);
    GH_ASSERT_FALSE([channel requestIsPending:request.identifier]);      // claimed = gone
    GH_ASSERT_EQUAL_INT([channel claimPendingRequests].count, 0);        // and never run twice
}

GH_TEST(harness_channel_withdraw) {
    GHHarnessChannel *channel = [[GHHarnessChannel alloc] initWithDirectory:GHTestTempDirectory()];
    GHHarnessRequest *request = DumpRequest();
    [channel sendRequest:request];
    [channel withdrawRequest:request.identifier];
    GH_ASSERT_EQUAL_INT([channel claimPendingRequests].count, 0);
}

GH_TEST(harness_channel_drops_malformed_stale_and_misnamed_requests) {
    GHHarnessChannel *channel = [[GHHarnessChannel alloc] initWithDirectory:GHTestTempDirectory()];
    NSString *requests = channel.requestsDirectory;
    [@"{ not json" writeToFile:[requests stringByAppendingPathComponent:@"junk.json"] atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    NSData *stale = [NSJSONSerialization dataWithJSONObject:@{ @"id": @"old", @"mode": @"autotab", @"count": @50, @"createdAt": @(NSDate.date.timeIntervalSince1970 - 3600) } options:0 error:NULL];
    [stale writeToFile:[requests stringByAppendingPathComponent:@"old.json"] atomically:YES];
    NSData *misnamed = [NSJSONSerialization dataWithJSONObject:@{ @"id": @"someone-else", @"mode": @"dump" } options:0 error:NULL];
    [misnamed writeToFile:[requests stringByAppendingPathComponent:@"mine.json"] atomically:YES];
    [@"ignored" writeToFile:[requests stringByAppendingPathComponent:@"notes.txt"] atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    GHHarnessRequest *good = DumpRequest();
    [channel sendRequest:good];

    NSArray<GHHarnessRequest *> *claimed = [channel claimPendingRequests];
    GH_ASSERT_EQUAL_INT(claimed.count, 1);
    GH_ASSERT_EQUAL_OBJECTS(claimed.firstObject.identifier, good.identifier);
    // An hour-old autotab must never start pressing keys now; the bad files are gone rather than re-read forever.
    NSArray *left = [NSFileManager.defaultManager contentsOfDirectoryAtPath:requests error:NULL];
    GH_ASSERT_EQUAL_OBJECTS(left, (@[ @"notes.txt" ]));
}

GH_TEST(harness_channel_agent_lock) {
    NSString *directory = GHTestTempDirectory();
    GHHarnessChannel *agent = [[GHHarnessChannel alloc] initWithDirectory:directory];
    GHHarnessChannel *launched = [[GHHarnessChannel alloc] initWithDirectory:directory];
    GH_ASSERT_FALSE([launched agentIsRunning]);
    GH_ASSERT([agent acquireAgentLock]);
    GH_ASSERT([agent acquireAgentLock]);                 // idempotent
    GH_ASSERT([launched agentIsRunning]);
    GH_ASSERT_FALSE([launched acquireAgentLock]);        // a second agent gives up
    [agent releaseAgentLock];
    GH_ASSERT_FALSE([launched agentIsRunning]);          // a probe leaves no lock behind
    GH_ASSERT([launched acquireAgentLock]);
    [launched releaseAgentLock];
}

#pragma mark - server

GH_TEST(harness_server_runs_one_request_at_a_time_and_writes_out) {
    NSString *directory = GHTestTempDirectory();
    GHHarnessChannel *channel = [[GHHarnessChannel alloc] initWithDirectory:directory];
    GHHarnessServer *server = [[GHHarnessServer alloc] initWithChannel:channel controller:^GHController *{ return nil; }];
    NSMutableArray<NSString *> *started = [NSMutableArray array];
    NSMutableArray<void (^)(NSDictionary *)> *completions = [NSMutableArray array];
    server.perform = ^(GHHarnessRequest *request, void (^completion)(NSDictionary<NSString *, id> *)) {
        [started addObject:request.mode];
        [completions addObject:[completion copy]];
    };
    NSString *firstOut = [directory stringByAppendingPathComponent:@"first.json"], *secondOut = [directory stringByAppendingPathComponent:@"second.json"];
    GHHarnessRequest *first = [GHHarnessRequest requestWithDictionary:@{ @"id": @"first", @"mode": @"autotab", @"count": @2, @"out": firstOut, @"createdAt": @(NSDate.date.timeIntervalSince1970 - 1) } error:NULL];
    GHHarnessRequest *second = [GHHarnessRequest requestWithDictionary:@{ @"id": @"second", @"mode": @"dump", @"out": secondOut } error:NULL];
    [channel sendRequest:first];
    [channel sendRequest:second];

    [server drain];
    GH_ASSERT_EQUAL_OBJECTS(started, (@[ @"autotab" ]));            // oldest first, and the dump waits for it
    GH_ASSERT_FALSE([NSFileManager.defaultManager fileExistsAtPath:firstOut]);
    completions[0](@{ @"stopped": @"locked", @"posted": @2 });
    GH_ASSERT_EQUAL_OBJECTS(started, (@[ @"autotab", @"dump" ]));
    completions[1](GHHarnessNotTrustedResponse());
    GH_ASSERT_EQUAL_INT(server.servedCount, 2);

    NSDictionary *a = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:firstOut] options:0 error:NULL];
    GH_ASSERT_EQUAL_OBJECTS(a[@"stopped"], @"locked");
    GH_ASSERT_EQUAL_OBJECTS(a[@"mode"], @"autotab");
    GH_ASSERT_EQUAL_OBJECTS(a[@"agent"], @"running");
    NSDictionary *b = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:secondOut] options:0 error:NULL];
    GH_ASSERT_EQUAL_OBJECTS(b[@"error"], @"not trusted");
    GH_ASSERT_EQUAL_OBJECTS(b[@"trusted"], @NO);
}

GH_TEST(harness_server_answers_into_the_channel_without_out) {
    GHHarnessChannel *channel = [[GHHarnessChannel alloc] initWithDirectory:GHTestTempDirectory()];
    GHHarnessServer *server = [[GHHarnessServer alloc] initWithChannel:channel controller:^GHController *{ return nil; }];
    server.perform = ^(GHHarnessRequest *request, void (^completion)(NSDictionary<NSString *, id> *)) { completion(@{ @"trusted": @YES }); };
    GHHarnessRequest *request = [GHHarnessRequest requestWithArguments:@[ @"Ghost", @"--dump" ] error:NULL];
    [channel sendRequest:request];
    [server drain];
    NSData *data = [NSData dataWithContentsOfFile:[channel responsePathForIdentifier:request.identifier]];
    GH_ASSERT_EQUAL_OBJECTS([NSJSONSerialization JSONObjectWithData:data options:0 error:NULL][@"mode"], @"dump");
}

#pragma mark - --dump-tree redaction

static NSString *TreeJSON(NSDictionary *tree) {
    return [[NSString alloc] initWithData:GHHarnessEncodeResponse(tree) encoding:NSUTF8StringEncoding];
}

static NSDictionary *ChildWithRole(NSDictionary *tree, NSString *role, NSString *title) {
    for (NSDictionary *child in tree[@"children"]) {
        if ([child[@"role"] isEqualToString:role] && (!title || [child[@"title"] isEqualToString:title])) return child;
    }
    return nil;
}

GH_TEST(harness_tree_reduces_values_to_their_length) {
    GHFakeAXNode *window = [GHFakeAXNode nodeWithRole:@"AXWindow" title:@"Apply" frame:CGRectMake(0, 0, 800, 600)];
    GHFakeAXNode *name = [window addChild:[GHFakeAXNode nodeWithRole:@"AXTextField" title:@"First name" frame:CGRectMake(40, 40, 300, 28)]];
    name.value = @"Alexandria-Typed-Value";
    name.placeholder = @"Your first name";
    name.identifier = @"first_name";
    name.domClassList = @[ @"input", @"input--text" ];
    name.required = YES;
    name.isFocused = YES;
    GHFakeAXNode *essay = [window addChild:[GHFakeAXNode nodeWithRole:@"AXTextArea" title:@"Why us?" frame:CGRectMake(40, 80, 300, 90)]];
    essay.value = @"A long private answer nobody should see in a dump file.";
    GHFakeAXNode *checkbox = [window addChild:[GHFakeAXNode nodeWithRole:@"AXCheckBox" title:@"Remote" frame:CGRectMake(40, 180, 20, 20)]];
    checkbox.value = @"1";
    [window addChild:[GHFakeAXNode staticText:@"Tell us about yourself" frame:CGRectMake(40, 10, 300, 20)]];

    NSUInteger visited = 0;
    BOOL truncated = YES;
    NSDictionary *tree = [GHHarnessTree treeFromNode:window maxDepth:60 maxNodes:GHHarnessMaxTreeNodes
                                             actions:^NSArray<NSString *> *(id<GHAXNode> node) { return [node.role isEqualToString:@"AXCheckBox"] ? @[ @"AXPress" ] : nil; }
                                             visited:&visited truncated:&truncated];
    GH_ASSERT_EQUAL_INT(visited, 5);
    GH_ASSERT_FALSE(truncated);
    NSDictionary *field = ChildWithRole(tree, @"AXTextField", @"First name");
    GH_ASSERT_EQUAL_OBJECTS(field[@"valueLength"], @22);
    GH_ASSERT(field[@"value"] == nil);
    GH_ASSERT_EQUAL_OBJECTS(field[@"placeholder"], @"Your first name");
    GH_ASSERT_EQUAL_OBJECTS(field[@"identifier"], @"first_name");
    GH_ASSERT_EQUAL_OBJECTS(field[@"classes"], (@[ @"input", @"input--text" ]));
    GH_ASSERT_EQUAL_OBJECTS(field[@"required"], @YES);
    GH_ASSERT_EQUAL_OBJECTS(field[@"focused"], @YES);
    GH_ASSERT_EQUAL_OBJECTS(field[@"rect"], (@{ @"x": @40, @"y": @40, @"width": @300, @"height": @28 }));
    GH_ASSERT_EQUAL_OBJECTS(ChildWithRole(tree, @"AXTextArea", nil)[@"valueLength"], @55);
    GH_ASSERT_EQUAL_OBJECTS(ChildWithRole(tree, @"AXCheckBox", nil)[@"actions"], (@[ @"AXPress" ]));
    // Page text is not input: a label has to survive, or the dump is useless for designing capture.
    GH_ASSERT_EQUAL_OBJECTS(ChildWithRole(tree, @"AXStaticText", nil)[@"text"], @"Tell us about yourself");

    NSString *json = TreeJSON(tree);
    GH_ASSERT_FALSE([json containsString:@"Alexandria"]);
    GH_ASSERT_FALSE([json containsString:@"private answer"]);
    GH_ASSERT_FALSE([json containsString:@"\"value\""]);
}

GH_TEST(harness_tree_says_nothing_about_secure_and_sensitive_fields) {
    GHFakeAXNode *window = [GHFakeAXNode nodeWithRole:@"AXWindow"];
    GHFakeAXNode *password = [window addChild:[GHFakeAXNode nodeWithRole:@"AXSecureTextField" title:@"Password" frame:CGRectMake(0, 0, 200, 28)]];
    password.value = @"hunter2-secret";
    GHFakeAXNode *subroled = [window addChild:[GHFakeAXNode nodeWithRole:@"AXTextField" title:@"Login" frame:CGRectMake(0, 40, 200, 28)]];
    subroled.subrole = @"AXSecureTextField";
    subroled.value = @"another-secret";
    GHFakeAXNode *card = [window addChild:[GHFakeAXNode nodeWithRole:@"AXTextField" title:@"Card number" frame:CGRectMake(0, 80, 200, 28)]];
    card.value = @"4111111111111111";
    GHFakeAXNode *sin = [window addChild:[GHFakeAXNode nodeWithRole:@"AXTextField" title:@"" frame:CGRectMake(0, 120, 200, 28)]];
    sin.placeholder = @"Social Insurance Number";
    sin.value = @"046454286";
    GHFakeAXNode *labelled = [window addChild:[GHFakeAXNode nodeWithRole:@"AXTextField" title:@"" frame:CGRectMake(0, 160, 200, 28)]];
    labelled.titleUIElement = [GHFakeAXNode staticText:@"Passport number" frame:CGRectMake(0, 150, 200, 10)];
    labelled.value = @"X1234567";

    NSDictionary *tree = [GHHarnessTree treeFromNode:window maxDepth:60 maxNodes:100 actions:nil visited:NULL truncated:NULL];
    NSArray<NSDictionary *> *children = tree[@"children"];
    GH_ASSERT_EQUAL_INT(children.count, 5);
    for (NSDictionary *child in children) {
        GH_ASSERT_MSG([child[@"sensitive"] isEqual:@YES], @"%@ should be marked sensitive", child);
        GH_ASSERT_MSG(child[@"valueLength"] == nil, @"%@ leaks a length", child);   // not even how long the secret is
    }
    GH_ASSERT_EQUAL_OBJECTS(children[4][@"labelledBy"], @"Passport number");
    NSString *json = TreeJSON(tree);
    for (NSString *secret in @[ @"hunter2", @"another-secret", @"4111", @"046454286", @"X1234567" ]) {
        GH_ASSERT_MSG(![json containsString:secret], @"%@ leaked", secret);
    }
}

GH_TEST(harness_tree_redacts_contact_data_and_cuts_long_text) {
    GH_ASSERT_EQUAL_OBJECTS([GHHarnessTree safeText:@"  Submit\n application  "], @"Submit application");
    GH_ASSERT([GHHarnessTree safeText:@""] == nil && [GHHarnessTree safeText:@" \n "] == nil && [GHHarnessTree safeText:nil] == nil);
    GH_ASSERT_EQUAL_OBJECTS([GHHarnessTree safeText:@"Signed in as alex.chen@example.com"], @"[redacted:34]");
    GH_ASSERT_EQUAL_OBJECTS([GHHarnessTree safeText:@"Call +1 (416) 555-0199"], @"[redacted:22]");
    GH_ASSERT_EQUAL_OBJECTS([GHHarnessTree safeText:@"Step 2 of 5"], @"Step 2 of 5");
    NSString *longText = [@"" stringByPaddingToLength:400 withString:@"lorem ipsum " startingAtIndex:0];
    NSString *cut = [GHHarnessTree safeText:longText];
    GH_ASSERT_EQUAL_INT(cut.length, GHHarnessMaxTextLength + 3);
    GH_ASSERT([cut hasSuffix:@"..."]);

    GHFakeAXNode *window = [GHFakeAXNode nodeWithRole:@"AXWindow" title:@"Inbox (alex.chen@example.com)" frame:CGRectZero];
    [window addChild:[GHFakeAXNode staticText:@"Reach me at 416-555-0199" frame:CGRectZero]];
    NSString *json = TreeJSON([GHHarnessTree treeFromNode:window maxDepth:5 maxNodes:10 actions:nil visited:NULL truncated:NULL]);
    GH_ASSERT_FALSE([json containsString:@"example.com"]);
    GH_ASSERT_FALSE([json containsString:@"555-0199"]);
}

GH_TEST(harness_tree_respects_depth_and_node_limits) {
    GHFakeAXNode *root = [GHFakeAXNode nodeWithRole:@"AXWindow"];
    GHFakeAXNode *level1 = [root addChild:[GHFakeAXNode nodeWithRole:@"AXGroup"]];
    GHFakeAXNode *level2 = [level1 addChild:[GHFakeAXNode nodeWithRole:@"AXGroup"]];
    [level2 addChild:[GHFakeAXNode nodeWithRole:@"AXButton"]];
    [level2 addChild:[GHFakeAXNode nodeWithRole:@"AXButton"]];

    NSUInteger visited = 0;
    BOOL truncated = NO;
    NSDictionary *shallow = [GHHarnessTree treeFromNode:root maxDepth:2 maxNodes:100 actions:nil visited:&visited truncated:&truncated];
    GH_ASSERT_EQUAL_INT(visited, 3);
    GH_ASSERT(truncated);
    NSDictionary *deepest = [shallow[@"children"][0][@"children"] firstObject];
    GH_ASSERT_EQUAL_OBJECTS(deepest[@"childrenOmitted"], @2);
    GH_ASSERT(deepest[@"children"] == nil);

    GHFakeAXNode *wide = [GHFakeAXNode nodeWithRole:@"AXWindow"];
    for (int i = 0; i < 50; i++) [wide addChild:[GHFakeAXNode nodeWithRole:@"AXButton"]];
    NSDictionary *capped = [GHHarnessTree treeFromNode:wide maxDepth:60 maxNodes:10 actions:nil visited:&visited truncated:&truncated];
    GH_ASSERT_EQUAL_INT(visited, 10);
    GH_ASSERT(truncated);
    GH_ASSERT_EQUAL_INT([capped[@"children"] count], 9);
    GH_ASSERT_EQUAL_OBJECTS(capped[@"childrenOmitted"], @41);
}

#pragma mark - --autotab

GH_TEST(harness_autotab_stops_at_the_lock_and_never_presses_it) {
    GHFakeAutotabSubject *subject = Subject(@[ Ghost(@"First name", NO), Ghost(@"Email", NO), Ghost(@"Submit application", YES) ]);
    GHFakeTabPoster *poster = [[GHFakeTabPoster alloc] init];
    NSDictionary *report = RunAutotab(subject, poster, 30, nil);
    GH_ASSERT(report != nil);
    GH_ASSERT_EQUAL_OBJECTS(report[@"stopped"], @"locked");
    GH_ASSERT_EQUAL_OBJECTS(report[@"lockedLabel"], @"Submit application");
    GH_ASSERT_EQUAL_OBJECTS(report[@"requested"], @30);
    GH_ASSERT_EQUAL_OBJECTS(report[@"posted"], @2);
    GH_ASSERT_EQUAL_INT(poster.posted, 2);              // two fields, and NOT a third press onto Submit
    GH_ASSERT_EQUAL_INT(subject.tabsSeen, 2);
    NSArray<NSDictionary *> *steps = report[@"steps"];
    GH_ASSERT_EQUAL_INT(steps.count, 2);
    GH_ASSERT_EQUAL_OBJECTS(steps[0][@"ghost"], @"First name");
    GH_ASSERT_EQUAL_OBJECTS(steps[0][@"action"], @"fill");
    GH_ASSERT_EQUAL_OBJECTS(steps[0][@"consumed"], @YES);
    GH_ASSERT_EQUAL_OBJECTS(steps[0][@"outcome"], @"accepted");
    GH_ASSERT_EQUAL_OBJECTS(steps[0][@"verified"], @YES);
    GH_ASSERT_EQUAL_OBJECTS(steps[0][@"next"], @"Email");
    GH_ASSERT_EQUAL_OBJECTS(steps[0][@"writeMs"], @7);
    GH_ASSERT([steps[0][@"ms"] doubleValue] >= 100);
    GH_ASSERT_EQUAL_OBJECTS(steps[1][@"next"], @"Submit application");
    GH_ASSERT_EQUAL_OBJECTS(report[@"final"][@"current"][@"locked"], @YES);
}

GH_TEST(harness_autotab_refuses_the_very_first_press_on_a_locked_ghost) {
    GHFakeAutotabSubject *subject = Subject(@[ Ghost(@"Place order", YES) ]);
    GHFakeTabPoster *poster = [[GHFakeTabPoster alloc] init];
    NSDictionary *report = RunAutotab(subject, poster, 5, nil);
    GH_ASSERT_EQUAL_OBJECTS(report[@"stopped"], @"locked");
    GH_ASSERT_EQUAL_OBJECTS(report[@"lockedLabel"], @"Place order");
    GH_ASSERT_EQUAL_INT(poster.posted, 0);
    GH_ASSERT_EQUAL_INT([report[@"steps"] count], 0);
}

GH_TEST(harness_autotab_lock_wins_over_the_count) {
    // Exactly as many presses as fields: the run still reports where it ended, parked at the lock.
    GHFakeAutotabSubject *subject = Subject(@[ Ghost(@"City", NO), Ghost(@"Send", YES) ]);
    GHFakeTabPoster *poster = [[GHFakeTabPoster alloc] init];
    NSDictionary *report = RunAutotab(subject, poster, 1, nil);
    GH_ASSERT_EQUAL_OBJECTS(report[@"stopped"], @"locked");
    GH_ASSERT_EQUAL_INT(poster.posted, 1);
}

GH_TEST(harness_autotab_stops_after_count_presses) {
    GHFakeAutotabSubject *subject = Subject(@[ Ghost(@"A", NO), Ghost(@"B", NO), Ghost(@"C", NO), Ghost(@"D", NO) ]);
    GHFakeTabPoster *poster = [[GHFakeTabPoster alloc] init];
    NSDictionary *report = RunAutotab(subject, poster, 2, nil);
    GH_ASSERT_EQUAL_OBJECTS(report[@"stopped"], @"count");
    GH_ASSERT_EQUAL_INT(poster.posted, 2);
    GH_ASSERT(report[@"lockedLabel"] == nil);
}

GH_TEST(harness_autotab_presses_nothing_when_ghost_is_inactive_or_has_no_ghost) {
    GHFakeAutotabSubject *paused = Subject(@[ Ghost(@"A", NO) ]);
    paused.active = NO;
    GHFakeTabPoster *poster = [[GHFakeTabPoster alloc] init];
    GH_ASSERT_EQUAL_OBJECTS(RunAutotab(paused, poster, 5, nil)[@"stopped"], @"inactive");
    GH_ASSERT_EQUAL_INT(poster.posted, 0);

    GHFakeTabPoster *second = [[GHFakeTabPoster alloc] init];
    GH_ASSERT_EQUAL_OBJECTS(RunAutotab(Subject(@[]), second, 5, nil)[@"stopped"], @"no-ghost");
    GH_ASSERT_EQUAL_INT(second.posted, 0);

    // The walk runs out half way: the run ends there instead of tabbing on through the page.
    GHFakeTabPoster *third = [[GHFakeTabPoster alloc] init];
    NSDictionary *report = RunAutotab(Subject(@[ Ghost(@"Only", NO) ]), third, 9, nil);
    GH_ASSERT_EQUAL_OBJECTS(report[@"stopped"], @"no-ghost");
    GH_ASSERT_EQUAL_INT(third.posted, 1);
}

GH_TEST(harness_autotab_gives_up_when_ghost_stops_consuming) {
    NSMutableDictionary *native = [Ghost(@"Elsewhere", NO) mutableCopy];
    native[@"consumes"] = @NO;
    GHFakeAutotabSubject *subject = Subject(@[ native ]);
    GHFakeTabPoster *poster = [[GHFakeTabPoster alloc] init];
    NSDictionary *report = RunAutotab(subject, poster, 50, nil);
    GH_ASSERT_EQUAL_OBJECTS(report[@"stopped"], @"stalled");
    GH_ASSERT_EQUAL_INT(poster.posted, 3);
    NSDictionary *step = [report[@"steps"] firstObject];
    GH_ASSERT_EQUAL_OBJECTS(step[@"consumed"], @NO);
    GH_ASSERT_EQUAL_OBJECTS(step[@"outcome"], @"not-consumed");
    GH_ASSERT_EQUAL_OBJECTS(step[@"verified"], @NO);
}

GH_TEST(harness_autotab_records_a_failed_write_as_unverified) {
    NSMutableDictionary *stubborn = [Ghost(@"Phone", NO) mutableCopy];
    stubborn[@"outcome"] = @"failed";
    GHFakeAutotabSubject *subject = Subject(@[ stubborn ]);
    GHFakeTabPoster *poster = [[GHFakeTabPoster alloc] init];
    NSDictionary *report = RunAutotab(subject, poster, 1, nil);
    NSDictionary *step = [report[@"steps"] firstObject];
    GH_ASSERT_EQUAL_OBJECTS(step[@"consumed"], @YES);
    GH_ASSERT_EQUAL_OBJECTS(step[@"outcome"], @"failed");
    GH_ASSERT_EQUAL_OBJECTS(step[@"verified"], @NO);
}

GH_TEST(harness_autotab_reports_a_press_that_could_not_be_posted) {
    GHFakeAutotabSubject *subject = Subject(@[ Ghost(@"A", NO) ]);
    GHFakeTabPoster *poster = [[GHFakeTabPoster alloc] init];
    poster.fails = YES;
    NSDictionary *report = RunAutotab(subject, poster, 3, nil);
    GH_ASSERT_EQUAL_OBJECTS(report[@"stopped"], @"post-failed");
    GH_ASSERT_EQUAL_OBJECTS(report[@"posted"], @0);
}

GH_TEST(harness_autotab_waits_for_a_busy_step_but_not_forever) {
    GHFakeAutotabSubject *subject = Subject(@[ Ghost(@"Essay", NO), Ghost(@"Next", NO) ]);
    subject.busy = YES;   // a draft that never arrives
    GHFakeTabPoster *poster = [[GHFakeTabPoster alloc] init];
    NSDictionary *report = RunAutotab(subject, poster, 1, ^(GHAutotabRunner *runner) { runner.maxSettle = 1.0; });
    GH_ASSERT(report != nil);
    NSDictionary *step = [report[@"steps"] firstObject];
    GH_ASSERT([step[@"ms"] doubleValue] >= 1100);        // interval + maxSettle, then recorded as it is
    GH_ASSERT([step[@"ms"] doubleValue] < 1400);
}

GH_TEST(harness_autotab_respects_its_time_budget) {
    GHFakeAutotabSubject *subject = Subject(@[ Ghost(@"A", NO), Ghost(@"B", NO), Ghost(@"C", NO), Ghost(@"D", NO), Ghost(@"E", NO) ]);
    GHFakeTabPoster *poster = [[GHFakeTabPoster alloc] init];
    NSDictionary *report = RunAutotab(subject, poster, 5, ^(GHAutotabRunner *runner) { runner.maxDuration = 0.25; });
    GH_ASSERT_EQUAL_OBJECTS(report[@"stopped"], @"timeout");
    GH_ASSERT_EQUAL_INT(poster.posted, 3);               // presses at 0, 0.1 and 0.2 s; over budget at 0.3 s
}

GH_TEST(harness_can_only_ever_post_tab) {
    GH_ASSERT_EQUAL_OBJECTS([GHHarnessTabPoster postableKeyCodes], (@[ @48 ]));
    for (NSNumber *forbidden in @[ @36 /* Return */, @76 /* Enter */, @49 /* Space */ ]) {
        GH_ASSERT_FALSE([[GHHarnessTabPoster postableKeyCodes] containsObject:forbidden]);
    }
    // The protocol is the whole keyboard surface of the harness: one method, and it is Tab.
    unsigned int required = 0, optional = 0;
    struct objc_method_description *methods = protocol_copyMethodDescriptionList(@protocol(GHAutotabKeyPosting), YES, YES, &required);
    struct objc_method_description *optionals = protocol_copyMethodDescriptionList(@protocol(GHAutotabKeyPosting), NO, YES, &optional);
    NSString *only = required == 1 ? NSStringFromSelector(methods[0].name) : nil;
    free(methods);
    free(optionals);
    GH_ASSERT_EQUAL_INT(required, 1);
    GH_ASSERT_EQUAL_INT(optional, 0);
    GH_ASSERT_EQUAL_OBJECTS(only, @"postTab");
}
