// Ghost Desktop entry point.
//   Ghost                 menu-bar agent (accessory app, no Dock icon)
//   Ghost --selftest      loads the core, maps a built-in sample form, prints PASS/FAIL. No permissions needed.
//   Ghost --trust         prints whether the process is trusted for Accessibility; exit 0 (yes) or 1 (no)
//   Ghost --dump          fields of the frontmost window as JSON (labels only, never values), after 3 s
//   Ghost --help
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import "GHAppDelegate.h"
#import "GHCore.h"
#import "GHField.h"
#import "GHLog.h"
#import "GHServerClient.h"

#if __has_include("GHCapture.h")
#import "GHCapture.h"
#define GH_HAS_CAPTURE_HEADER 1
#else
#define GH_HAS_CAPTURE_HEADER 0
#endif

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

#pragma mark - --trust

static int GHTrust(void) {
    BOOL trusted = AXIsProcessTrusted();
    GHPrint(@"accessibility trusted: %@", trusted ? @"yes" : @"no");
    if (!trusted) GHPrint(@"Grant it in System Settings -> Privacy & Security -> Accessibility -> Ghost, then run this again.");
    return trusted ? 0 : 1;
}

#pragma mark - --dump

static void GHSpinRunLoop(NSTimeInterval seconds) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
    }
}

static int GHDump(void) {
    GHLogSetMirrorToStderr(NO);
    if (!AXIsProcessTrusted()) {
        fprintf(stderr, "Ghost is not trusted for Accessibility (AX calls return -25211).\n"
                        "Grant it in System Settings -> Privacy & Security -> Accessibility -> Ghost, then run --dump again.\n");
        return 2;
    }
#if GH_HAS_CAPTURE_HEADER
    Class captureClass = NSClassFromString(@"GHCapture");
    Class nodeClass = NSClassFromString(@"GHAXElementNode");
    GHCore *core = [GHCore sharedCore];
    if (!captureClass || !nodeClass || !core) {
        fprintf(stderr, "--dump needs the capture module and the core bundle; this build has %s.\n", core ? "no GHCapture" : "no core");
        return 3;
    }
    fprintf(stderr, "Focus the window to dump. Capturing in 3 seconds...\n");
    GHSpinRunLoop(3.0);

    NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!front) { fprintf(stderr, "No frontmost application.\n"); return 4; }
    AXUIElementRef app = AXUIElementCreateApplication(front.processIdentifier);
    AXUIElementSetMessagingTimeout(app, 1.0);
    // Chromium and Electron only build their web accessibility tree when asked.
    NSString *browser = [GHPresence browserNameForBundleId:front.bundleIdentifier];
    BOOL chromium = browser && ![browser isEqualToString:@"safari"] && ![browser isEqualToString:@"firefox"];
    if (chromium) AXUIElementSetAttributeValue(app, CFSTR("AXEnhancedUserInterface"), kCFBooleanTrue);
    AXUIElementSetAttributeValue(app, CFSTR("AXManualAccessibility"), kCFBooleanTrue);
    GHSpinRunLoop(0.6);

    CFTypeRef window = NULL;
    AXError axError = AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute, &window);
    if (axError != kAXErrorSuccess || !window) {
        fprintf(stderr, "Could not read the focused window of %s (AXError %d).\n", front.localizedName.UTF8String ?: "?", (int)axError);
        CFRelease(app);
        return 4;
    }
    id<GHAXNode> node = [nodeClass nodeWithElement:(AXUIElementRef)window];
    GHCapture *capture = [(GHCapture *)[captureClass alloc] initWithSafety:core];
    GHCaptureResult *result = [capture captureWindow:node];
    NSDictionary *output = @{
        @"app": front.bundleIdentifier ?: @"unknown",
        @"formSignature": result.formSignature ?: @"",
        @"visitedNodes": @(result.visitedNodes),
        @"partial": @(result.partial),
        @"elapsedMs": @(round(result.elapsed * 1000.0)),
        @"fields": [GHField wireJSONObjectsForFields:result.fields], // wire objects: never a value
    };
    NSData *json = [NSJSONSerialization dataWithJSONObject:output options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys | NSJSONWritingWithoutEscapingSlashes error:NULL];
    GHPrint(@"%@", [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding]);
    CFRelease(window);
    CFRelease(app);
    return 0;
#else
    fprintf(stderr, "--dump needs the capture module (GHCapture), which is not part of this build.\n");
    return 3;
#endif
}

#pragma mark - main

static BOOL GHAnotherInstanceIsRunning(void) {
    NSString *bundleId = NSBundle.mainBundle.bundleIdentifier;
    if (!bundleId) return NO;
    for (NSRunningApplication *app in [NSRunningApplication runningApplicationsWithBundleIdentifier:bundleId]) {
        if (app.processIdentifier != getpid()) return YES;
    }
    return NO;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSArray<NSString *> *args = NSProcessInfo.processInfo.arguments;
        if ([args containsObject:@"--selftest"]) return GHSelfTest();
        if ([args containsObject:@"--trust"]) return GHTrust();
        if ([args containsObject:@"--dump"]) return GHDump();
        if ([args containsObject:@"--help"] || [args containsObject:@"-h"]) {
            GHPrint(@"Ghost Desktop\n  (no flag)    run the menu-bar agent\n  --selftest   core + mapping self-test, no permissions needed\n"
                    @"  --trust      is the process trusted for Accessibility? exit 0/1\n  --dump       JSON of the frontmost window's fields (labels only), after 3 s");
            return 0;
        }
        if (GHAnotherInstanceIsRunning()) {
            GHLog(@"app: another Ghost is already running; exiting");
            GHLogFlush();
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
        app.delegate = delegate;
        [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
        [app run];
    }
    return 0;
}
