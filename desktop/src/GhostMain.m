// GhostMain: the entry point of libghost.dylib. The host (desktop/host/main.m, the only code inside Ghost.app)
// dlopen()s the library and calls this, so everything here can change without touching the host's code hash
// and with it the Accessibility grant (docs/desktop-realworld.md section 1).
//   Ghost                 menu-bar agent (accessory app, no Dock icon)
//   Ghost --selftest      loads the core, maps a built-in sample form, prints PASS/FAIL. No permissions needed.
//   Ghost --trust | --dump | --dump-tree | --autotab N   the harness, see GHHarness.h. Answers go to --out FILE.
//   Ghost --help
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import "GHAppDelegate.h"
#import "GHCore.h"
#import "GHHarness.h"
#import "GHLog.h"

static void GHPrint(NSString *format, ...) NS_FORMAT_FUNCTION(1, 2);
static void GHPrint(NSString *format, ...) {
    va_list args;
    va_start(args, format);
    NSString *line = [[NSString alloc] initWithFormat:format arguments:args];
    va_end(args);
    printf("%s\n", line.UTF8String);
}

#pragma mark - --selftest

static NSDictionary *GHSampleField(NSString *signature, NSString *label, NSString *kind, CGFloat y) {
    return @{ @"signature": signature, @"label": label, @"kind": kind, @"rect": @{ @"x": @40, @"y": @(y), @"width": @320, @"height": @28 } };
}

static NSArray<NSDictionary *> *GHSampleForm(void) {
    NSMutableDictionary *password = [GHSampleField(@"AXTextField||password|0", @"Password", @"text", 200) mutableCopy];
    password[@"inputType"] = @"password";
    NSMutableDictionary *filled = [GHSampleField(@"AXTextField||city|0", @"City", @"text", 240) mutableCopy];
    filled[@"value"] = @"already typed";
    NSMutableDictionary *authorized = [GHSampleField(@"AXPopUpButton||authorized|0", @"Are you legally authorized to work in Canada?", @"select", 280) mutableCopy];
    authorized[@"options"] = @[ @{ @"value": @"", @"label": @"Select an option" }, @{ @"value": @"Yes", @"label": @"Yes" }, @{ @"value": @"No", @"label": @"No" } ];
    authorized[@"value"] = @"";
    NSMutableDictionary *submit = [GHSampleField(@"AXButton||submit application|0", @"Submit application", @"button", 400) mutableCopy];
    submit[@"locked"] = @YES;
    return @[
        GHSampleField(@"AXTextField||first name|0", @"First name", @"text", 40),
        GHSampleField(@"AXTextField||last name|0", @"Last name", @"text", 80),
        GHSampleField(@"AXTextField||email|0", @"Email", @"email", 120),
        GHSampleField(@"AXTextField||linkedin|0", @"LinkedIn profile", @"url", 160),
        password, filled, authorized,
        GHSampleField(@"AXTextArea||why|0", @"Why do you want to work here?", @"textarea", 320),
        submit,
    ];
}

static int GHSelfTest(void) {
    GHLogSetMirrorToStderr(NO);
    __block int failures = 0;
    void (^check)(BOOL, NSString *) = ^(BOOL ok, NSString *what) {
        GHPrint(@"  %@ %@", ok ? @"ok  " : @"FAIL", what);
        if (!ok) failures++;
    };

    NSString *path = [GHCore defaultBundlePath];
    NSError *error;
    GHCore *core = path ? [[GHCore alloc] initWithBundlePath:path error:&error] : nil;
    GHPrint(@"Ghost Desktop self-test");
    GHPrint(@"  core bundle: %@", path ?: @"(not found)");
    if (!core) {
        GHPrint(@"FAIL: %@", error.localizedDescription ?: @"ghost-core.js not found; run `make core`");
        return 1;
    }

    NSDictionary *profile = [core demoProfile];
    NSDictionary *facts = profile[@"facts"];
    check([facts[@"firstName"] isEqual:@"Alex"], @"demo profile loads (fictional Alex Chen)");

    NSArray *form = GHSampleForm();
    NSArray *keys = [facts.allKeys sortedArrayUsingSelector:@selector(compare:)];
    CFAbsoluteTime started = CFAbsoluteTimeGetCurrent();
    NSArray<NSDictionary *> *assignments = [core mapFieldObjects:form factKeys:keys];
    NSArray<NSDictionary *> *ghosts = [core ghostsForFieldObjects:form assignments:assignments profile:profile settings:[core defaultSettings] source:@"offline" options:nil];
    double ms = (CFAbsoluteTimeGetCurrent() - started) * 1000.0;

    NSMutableDictionary<NSString *, NSString *> *mapped = [NSMutableDictionary dictionary];
    for (NSDictionary *a in assignments) mapped[a[@"signature"]] = a[@"factKey"];
    check([mapped[@"AXTextField||first name|0"] isEqual:@"firstName"], @"First name -> firstName");
    check([mapped[@"AXTextField||last name|0"] isEqual:@"lastName"], @"Last name -> lastName");
    check([mapped[@"AXTextField||email|0"] isEqual:@"email"], @"Email -> email");
    check([mapped[@"AXTextField||linkedin|0"] isEqual:@"linkedin"], @"LinkedIn profile -> linkedin");
    check([mapped[@"AXTextArea||why|0"] isEqual:@"needs_text"], @"essay question -> needs_text (no ghost offline)");

    NSMutableDictionary<NSString *, NSDictionary *> *bySignature = [NSMutableDictionary dictionary];
    for (NSDictionary *g in ghosts) bySignature[g[@"signature"]] = g;
    check(ghosts.count == 6, [NSString stringWithFormat:@"6 ghosts (got %lu)", (unsigned long)ghosts.count]);
    check([bySignature[@"AXTextField||first name|0"][@"value"] isEqual:facts[@"firstName"]], @"first name ghost carries the profile value");
    check([bySignature[@"AXPopUpButton||authorized|0"][@"action"] isEqual:@"select"] && [bySignature[@"AXPopUpButton||authorized|0"][@"value"] isEqual:@"Yes"], @"work authorization selects Yes over the placeholder");
    check(bySignature[@"AXTextField||password|0"] == nil, @"password field never gets a ghost");
    check(bySignature[@"AXTextField||city|0"] == nil, @"filled field is left alone");
    NSDictionary *last = ghosts.lastObject;
    check([last[@"locked"] isEqual:@YES] && [last[@"action"] isEqual:@"click"] && [last[@"signature"] isEqual:@"AXButton||submit application|0"], @"lock ghost (Submit application) is last");
    check([core isSensitive:@{ @"label": @"Card number" }] && [core isSensitive:@{ @"label": @"Social Insurance Number" }], @"sensitive labels are recognised");
    check(![core isSensitive:@{ @"label": @"First name" }], @"ordinary labels are not sensitive");
    check([core isLockedActionText:@"Place order"] && ![core isLockedActionText:@"Show more"], @"locked actions are recognised");
    NSDictionary *textFacts = [core textFactsForProfile:profile];
    check(textFacts[@"school"] != nil && textFacts[@"email"] == nil && textFacts[@"phone"] == nil, @"draft facts leave contact details out");
    NSData *body = [core formRequestBodyForFieldObjects:form factKeys:keys origin:@"app://selftest" formSignature:@"selftest"];
    NSString *bodyText = body ? [[NSString alloc] initWithData:body encoding:NSUTF8StringEncoding] : @"";
    check(body != nil && ![bodyText containsString:@"already typed"] && ![bodyText containsString:facts[@"email"]] && ![bodyText containsString:@"Password"],
          @"server request has no field values, no profile values, no sensitive field");

    GHPrint(@"  map + ghosts took %.2f ms", ms);
    GHPrint(@"  accessibility trusted: %@", AXIsProcessTrusted() ? @"yes" : @"no (grant it to Ghost.app to see ghosts)");
    if (failures == 0) GHPrint(@"PASS"); else GHPrint(@"FAIL (%d)", failures);
    return failures == 0 ? 0 : 1;
}

#pragma mark - harness (launched process)

static const NSTimeInterval kClaimTimeout = 3.0;   // an agent that watches the channel claims a request within milliseconds

/// Runs the main run loop (and with it the main queue) until `done()` or the deadline. NO on a timeout.
static BOOL GHWaitUntil(NSTimeInterval timeout, BOOL (^done)(void)) {
    // A run loop without a source returns at once: the timer keeps this from spinning hot.
    NSTimer *keepAlive = [NSTimer scheduledTimerWithTimeInterval:0.05 repeats:YES block:^(NSTimer *timer) {}];
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    [keepAlive invalidate];
    return done();
}

static int GHHarnessExitCode(NSDictionary *response) {
    if (!response[@"error"]) return 0;
    return [response[@"trusted"] isEqual:@NO] ? 1 : 2;
}

static int GHAnswer(NSDictionary *response, GHHarnessRequest *request, NSString *agent) {
    NSMutableDictionary *answer = [response mutableCopy];
    answer[@"mode"] = request.mode;
    if (agent) answer[@"agent"] = agent;
    GHHarnessWriteResponse(answer, request.outPath);
    GHLog(@"harness: %@ id=%@ agent=%@ error=%@", request.mode, request.identifier, agent ?: @"none", response[@"error"] ?: @"none");
    GHLogFlush();
    return GHHarnessExitCode(response);
}

/// Hands the request to the agent that is already running. 0 = answered (the agent wrote --out), -1 = nobody
/// claimed it (the caller may run it here instead), 2 = claimed but never answered.
static int GHForwardToAgent(GHHarnessChannel *channel, GHHarnessRequest *request) {
    NSFileManager *fm = NSFileManager.defaultManager;
    NSString *userOut = request.outPath;
    if (!userOut) request.outPath = [channel responsePathForIdentifier:request.identifier];
    NSString *answerPath = request.outPath;
    BOOL sent = [channel sendRequest:request];
    BOOL claimed = sent && GHWaitUntil(kClaimTimeout, ^BOOL { return ![channel requestIsPending:request.identifier] || [fm fileExistsAtPath:answerPath]; });
    if (!claimed) {
        [channel withdrawRequest:request.identifier];
        request.outPath = userOut;
        GHLog(@"harness: the running agent did not claim %@ id=%@", request.mode, request.identifier);
        return -1;
    }
    BOOL answered = GHWaitUntil(request.deadline, ^BOOL { return [fm fileExistsAtPath:answerPath]; });
    request.outPath = userOut;
    if (!answered) return GHAnswer(GHHarnessErrorResponse(@"timeout", @"the running agent took the request and never answered"), request, @"running");
    if (!userOut) {   // no --out: the agent wrote into the channel, this process prints it
        NSData *data = [NSData dataWithContentsOfFile:answerPath];
        fwrite(data.bytes, 1, data.length, stdout);
        fflush(stdout);
        [fm removeItemAtPath:answerPath error:NULL];
    }
    GHLog(@"harness: %@ id=%@ answered by the running agent", request.mode, request.identifier);
    GHLogFlush();
    return 0;
}

static int GHRunAgent(GHHarnessChannel *channel, GHHarnessRequest *launchRequest);

static int GHRunHarness(GHHarnessRequest *request) {
    if (request.outPath) [NSFileManager.defaultManager removeItemAtPath:request.outPath error:NULL];   // whoever waits for --out must not see an old answer
    if ([request.mode isEqualToString:GHHarnessModeTrust]) return GHAnswer([GHHarness trustResponse], request, nil);
    // Untrusted: say so at once. Nothing below can work, and nothing may hang or prompt.
    if (![GHHarness processIsTrusted]) return GHAnswer(GHHarnessNotTrustedResponse(), request, nil);

    GHHarnessChannel *channel = [GHHarnessChannel defaultChannel];
    BOOL autotab = [request.mode isEqualToString:GHHarnessModeAutotab];
    if ([channel agentIsRunning]) {
        int forwarded = GHForwardToAgent(channel, request);
        if (forwarded >= 0) return forwarded;
        // A second pipeline next to a live one would handle every Tab twice: only the looking modes fall back.
        if (autotab) return GHAnswer(GHHarnessErrorResponse(@"agent-not-responding", @"quit Ghost (ghostctl quit) and run this again"), request, @"running");
    }
    if (autotab) return GHRunAgent(channel, request);

    __block NSDictionary *response = nil;
    [GHHarness performRequest:request controller:nil completion:^(NSDictionary<NSString *, id> *answer) { response = answer; }];
    GHWaitUntil(request.deadline, ^BOOL { return response != nil; });
    return GHAnswer(response ?: GHHarnessErrorResponse(@"timeout", nil), request, @"standalone");
}

#pragma mark - agent

/// The menu-bar agent. With `launchRequest` (a standalone --autotab) it lives for that one request.
static int GHRunAgent(GHHarnessChannel *channel, GHHarnessRequest *launchRequest) {
    if (![channel acquireAgentLock]) {
        GHLog(@"app: another Ghost is already running; exiting");
        GHLogFlush();
        if (launchRequest) return GHAnswer(GHHarnessErrorResponse(@"agent-not-responding", nil), launchRequest, @"running");
        return 0;
    }
    NSApplication *app = [NSApplication sharedApplication];
    // launchd stops a LaunchAgent with SIGTERM: quit through AppKit so the event tap, the overlay and
    // the observers are torn down (applicationWillTerminate:) instead of dying mid-write.
    static dispatch_source_t signalSources[2];
    int signals[2] = { SIGTERM, SIGINT };
    for (int i = 0; i < 2; i++) {
        signal(signals[i], SIG_IGN);
        signalSources[i] = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, (uintptr_t)signals[i], 0, dispatch_get_main_queue());
        dispatch_source_set_event_handler(signalSources[i], ^{ [NSApp terminate:nil]; });
        dispatch_resume(signalSources[i]);
    }
    GHAppDelegate *delegate = [[GHAppDelegate alloc] init];
    delegate.harnessChannel = channel;
    delegate.launchRequest = launchRequest;
    app.delegate = delegate;
    [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [app run];
    return 0;
}

#pragma mark - GhostMain

__attribute__((visibility("default"))) int GhostMain(int argc, const char **argv);

int GhostMain(int argc, const char **argv) {
    @autoreleasepool {
        NSMutableArray<NSString *> *args = [NSMutableArray array];
        for (int i = 0; i < argc; i++) [args addObject:@(argv[i] ?: "")];
        if ([args containsObject:@"--selftest"]) return GHSelfTest();
        if ([args containsObject:@"--help"] || [args containsObject:@"-h"]) {
            GHPrint(@"Ghost Desktop (library: %@)\n  (no flag)      run the menu-bar agent\n  --selftest     core + mapping self-test, no permissions needed\n"
                    @"  --trust        { \"trusted\": bool }\n  --dump         captured fields of the frontmost window (labels, never values)\n"
                    @"  --dump-tree    raw AX tree, values reduced to their length [--depth 60]\n"
                    @"  --autotab N    post N real Tab presses and record each step [--interval 450]; stops at a locked ghost\n"
                    @"  --frontmost \"App\"  --delay S  --out FILE\n"
                    @"Launch through LaunchServices (tools/ghostctl): a binary started from a shell is judged by the terminal's permissions.",
                    [GHHarness libraryPath] ?: @"?");
            return 0;
        }
        NSString *problem = nil;
        GHHarnessRequest *request = [GHHarnessRequest requestWithArguments:args error:&problem];
        if (problem) {
            GHLog(@"harness: bad invocation (%@)", problem);
            GHLogFlush();
            GHHarnessWriteResponse(GHHarnessErrorResponse(@"bad-arguments", problem), [GHHarnessRequest outPathInArguments:args]);
            return 64;
        }
        if (request) return GHRunHarness(request);
        return GHRunAgent([GHHarnessChannel defaultChannel], nil);
    }
}
