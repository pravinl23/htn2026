// Core bridge tests: the real build/shabang-core.js running in JavaScriptCore (DESKTOP_CORE_PATH, set by `make test`).
// These pin the rules ported into desktop/core/predict.ts, so a drift from the extension shows up here.
#import "SBTest.h"
#import "SBCore.h"
#import "SBField.h"
#import "SBLog.h"

static SBCore *Core(void) {
    static SBCore *core;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSString *path = [SBCore defaultBundlePath];
        core = path ? [[SBCore alloc] initWithBundlePath:path error:NULL] : nil;
    });
    return core;
}

static SBField *Field(NSString *signature, NSString *label, NSString *kind) {
    SBField *field = [SBField fieldWithSignature:signature label:label kind:kind];
    field.rect = CGRectMake(40, 40, 320, 28);
    return field;
}

static NSArray<NSDictionary<NSString *, NSString *> *> *Options(NSArray<NSString *> *labels) {
    NSMutableArray *options = [NSMutableArray array];
    for (NSString *label in labels) [options addObject:@{ @"value": [label hasPrefix:@"Select"] ? @"" : label, @"label": label }];
    return options;
}

/// A job application as capture would hand it over: reading order, locked Submit at the end.
static NSArray<SBField *> *JobApplication(void) {
    SBField *authorized = Field(@"sel|authorized", @"Are you legally authorized to work in this country?", SBKindSelect);
    authorized.options = Options(@[ @"Select an option", @"Yes", @"No" ]);
    authorized.value = @"";
    SBField *sponsorship = Field(@"radio|sponsorship", @"Will you require sponsorship?", SBKindRadio);
    sponsorship.options = Options(@[ @"Yes", @"No" ]);
    SBField *cancel = Field(@"btn|cancel", @"Cancel", SBKindButton);
    SBField *submit = Field(@"btn|submit", @"Submit application", SBKindButton);
    submit.locked = YES;
    return @[
        Field(@"txt|first", @"First name", SBKindText),
        Field(@"txt|last", @"Last name", SBKindText),
        Field(@"txt|email", @"Email address", SBKindEmail),
        Field(@"txt|phone", @"Phone", SBKindTel),
        Field(@"txt|linkedin", @"LinkedIn profile", SBKindURL),
        Field(@"txt|github", @"GitHub", SBKindText),
        Field(@"txt|school", @"University", SBKindText),
        authorized, sponsorship,
        Field(@"area|why", @"Why do you want to work here?", SBKindTextArea),
        Field(@"link|privacy", @"Privacy policy", SBKindLink),
        cancel, submit,
    ];
}

static NSDictionary<NSString *, NSDictionary *> *BySignature(NSArray<NSDictionary *> *items) {
    NSMutableDictionary *map = [NSMutableDictionary dictionary];
    for (NSDictionary *item in items) map[item[@"signature"]] = item;
    return map;
}

static NSArray<NSString *> *FactKeys(NSDictionary *profile) {
    return [[profile[@"facts"] allKeys] sortedArrayUsingSelector:@selector(compare:)];
}

static NSArray<NSDictionary *> *GhostsFor(NSArray<SBField *> *fields, NSDictionary *settings, NSDictionary *options) {
    SBCore *core = Core();
    NSDictionary *profile = [core demoProfile];
    NSArray *assignments = [core mapFields:fields factKeys:FactKeys(profile)];
    return [core ghostsForFields:fields assignments:assignments profile:profile settings:settings ?: [core defaultSettings] source:@"offline" options:options];
}

#pragma mark - loading

GH_TEST(core_loads_bundle_and_demo_profile) {
    GH_ASSERT_MSG(Core() != nil, @"shabang-core.js did not load; DESKTOP_CORE_PATH=%s", getenv("DESKTOP_CORE_PATH") ?: "(unset)");
    NSDictionary *facts = [Core() demoProfile][@"facts"];
    GH_ASSERT_EQUAL_OBJECTS(facts[@"firstName"], @"Alex");
    GH_ASSERT_EQUAL_OBJECTS(facts[@"lastName"], @"Chen");
    GH_ASSERT_EQUAL_OBJECTS([Core() defaultSettings][@"confidenceThreshold"], @0.7);
}

GH_TEST(core_missing_bundle_reports_error) {
    NSError *error;
    SBCore *core = [[SBCore alloc] initWithBundlePath:@"/nonexistent/shabang-core.js" error:&error];
    GH_ASSERT(core == nil);
    GH_ASSERT_EQUAL_INT(error.code, SBCoreErrorBundleNotFound);
}

GH_TEST(core_bundle_is_pinned_to_the_one_built_with_the_library) {
    NSString *pinned = SBCorePinnedSHA256();
    GH_ASSERT_EQUAL_INT(pinned.length, 64);                           // make lib / make test embed it
    NSString *built = [SBCore defaultBundlePath];                     // the test runner: DESKTOP_CORE_PATH, the fresh build
    GH_ASSERT(built != nil);
    GH_ASSERT_EQUAL_OBJECTS(SBCoreSHA256OfFile(built), pinned);
    GH_ASSERT(SBCoreBundleMatchesPin(built, pinned));
    // A swapped core (same exports, different rules) is refused; so is a missing one. Only an unpinned build skips it.
    NSString *swapped = [SBTestTempDirectory() stringByAppendingPathComponent:@"shabang-core.js"];
    NSString *source = [[NSString stringWithContentsOfFile:built encoding:NSUTF8StringEncoding error:NULL] stringByAppendingString:@"\n// changed\n"];
    GH_ASSERT([source writeToFile:swapped atomically:YES encoding:NSUTF8StringEncoding error:NULL]);
    GH_ASSERT_FALSE(SBCoreBundleMatchesPin(swapped, pinned));
    GH_ASSERT_FALSE(SBCoreBundleMatchesPin([SBTestTempDirectory() stringByAppendingPathComponent:@"missing.js"], pinned));
    GH_ASSERT(SBCoreBundleMatchesPin(swapped, @""));
    GH_ASSERT([SBCoreSHA256OfFile(nil) length] == 0);
}

GH_TEST(core_rejects_bundle_with_missing_export) {
    NSError *error;
    SBCore *core = [[SBCore alloc] initWithSource:@"var GhostCore = { demoProfile: function () { return '{}'; } };" error:&error];
    GH_ASSERT(core == nil);
    GH_ASSERT_EQUAL_INT(error.code, SBCoreErrorMissingExport);
    GH_ASSERT([error.localizedDescription containsString:@"ghostsFor"]);
}

GH_TEST(core_rejects_bundle_that_throws) {
    NSError *error;
    SBCore *core = [[SBCore alloc] initWithSource:@"document.title = 'needs a DOM';" error:&error];
    GH_ASSERT(core == nil);
    GH_ASSERT_EQUAL_INT(error.code, SBCoreErrorEvaluationFailed);
}

GH_TEST(core_exception_never_echoes_arguments) {
    NSString *secretish = @"{ not json: alex.chen.dev@example.com";
    NSString *result = [Core() callString:@"textFacts" arguments:@[ secretish ]];
    GH_ASSERT(result == nil);
    GH_ASSERT(Core().lastError != nil);
    GH_ASSERT_FALSE([Core().lastError containsString:@"alex"]);
    GH_ASSERT([Core().lastError containsString:@"textFacts"]);
    // The next clean call clears it.
    [Core() demoProfile];
    GH_ASSERT(Core().lastError == nil);
}

#pragma mark - mapForm

GH_TEST(core_mapForm_maps_job_application) {
    NSDictionary *profile = [Core() demoProfile];
    NSDictionary *map = BySignature([Core() mapFields:JobApplication() factKeys:FactKeys(profile)]);
    GH_ASSERT_EQUAL_OBJECTS(map[@"txt|first"][@"factKey"], @"firstName");
    GH_ASSERT_EQUAL_OBJECTS(map[@"txt|last"][@"factKey"], @"lastName");
    GH_ASSERT_EQUAL_OBJECTS(map[@"txt|email"][@"factKey"], @"email");
    GH_ASSERT_EQUAL_OBJECTS(map[@"txt|phone"][@"factKey"], @"phone");
    GH_ASSERT_EQUAL_OBJECTS(map[@"txt|linkedin"][@"factKey"], @"linkedin");
    GH_ASSERT_EQUAL_OBJECTS(map[@"txt|github"][@"factKey"], @"github");
    GH_ASSERT_EQUAL_OBJECTS(map[@"txt|school"][@"factKey"], @"school");
    GH_ASSERT_EQUAL_OBJECTS(map[@"sel|authorized"][@"factKey"], @"workAuthorization");
    GH_ASSERT_EQUAL_OBJECTS(map[@"radio|sponsorship"][@"factKey"], @"requiresSponsorship");
    GH_ASSERT_EQUAL_OBJECTS(map[@"area|why"][@"factKey"], @"needs_text");
    GH_ASSERT_EQUAL_OBJECTS(map[@"btn|submit"][@"factKey"], @"none");
    GH_ASSERT([map[@"txt|first"][@"confidence"] doubleValue] >= 0.9);
}

GH_TEST(core_mapForm_only_offers_known_fact_keys) {
    NSDictionary *map = BySignature([Core() mapFields:JobApplication() factKeys:@[ @"email", @"firstName" ]]);
    GH_ASSERT_EQUAL_OBJECTS(map[@"txt|email"][@"factKey"], @"email");
    GH_ASSERT_EQUAL_OBJECTS(map[@"txt|first"][@"factKey"], @"firstName");
    GH_ASSERT_EQUAL_OBJECTS(map[@"txt|last"][@"factKey"], @"none");
    GH_ASSERT_EQUAL_OBJECTS(map[@"txt|linkedin"][@"factKey"], @"none");
}

#pragma mark - ghostsFor

GH_TEST(core_ghostsFor_walks_form_with_lock_last) {
    NSArray<NSDictionary *> *ghosts = GhostsFor(JobApplication(), nil, nil);
    NSDictionary *map = BySignature(ghosts);
    NSDictionary *facts = [Core() demoProfile][@"facts"];
    GH_ASSERT_EQUAL_INT(ghosts.count, 10); // 9 value ghosts + the parked Submit
    GH_ASSERT_EQUAL_OBJECTS(ghosts.firstObject[@"signature"], @"txt|first");
    GH_ASSERT_EQUAL_OBJECTS(map[@"txt|first"][@"action"], @"fill");
    GH_ASSERT_EQUAL_OBJECTS(map[@"txt|first"][@"value"], facts[@"firstName"]);
    GH_ASSERT_EQUAL_OBJECTS(map[@"txt|first"][@"displayText"], facts[@"firstName"]);
    GH_ASSERT_EQUAL_OBJECTS(map[@"txt|email"][@"value"], facts[@"email"]);
    GH_ASSERT_EQUAL_OBJECTS(map[@"txt|linkedin"][@"value"], facts[@"linkedin"]);
    GH_ASSERT_EQUAL_OBJECTS(map[@"sel|authorized"][@"action"], @"select");
    GH_ASSERT_EQUAL_OBJECTS(map[@"sel|authorized"][@"value"], @"Yes");
    GH_ASSERT_EQUAL_OBJECTS(map[@"radio|sponsorship"][@"value"], @"No");
    GH_ASSERT(map[@"area|why"] == nil);       // needs_text: no ghost offline
    GH_ASSERT(map[@"link|privacy"] == nil);   // links never get a ghost
    GH_ASSERT(map[@"btn|cancel"] == nil);     // unlocked buttons never get a ghost
    NSDictionary *last = ghosts.lastObject;
    GH_ASSERT_EQUAL_OBJECTS(last[@"signature"], @"btn|submit");
    GH_ASSERT_EQUAL_OBJECTS(last[@"action"], @"click");
    GH_ASSERT_EQUAL_OBJECTS(last[@"locked"], @YES);
    for (NSDictionary *ghost in ghosts) {
        if (ghost != last) GH_ASSERT_EQUAL_OBJECTS(ghost[@"locked"], @NO);
        GH_ASSERT_EQUAL_OBJECTS(ghost[@"source"], @"offline");
    }
}

/// Hand-made assignments: the gate is tested on its own, whatever confidences the shared heuristic uses this week.
static NSArray<NSDictionary *> *GhostsWithConfidences(NSDictionary *settings) {
    NSArray<SBField *> *fields = @[ Field(@"txt|first", @"First name", SBKindText), Field(@"txt|site", @"Website", SBKindText) ];
    NSArray *assignments = @[ @{ @"signature": @"txt|first", @"factKey": @"firstName", @"confidence": @0.95 },
                              @{ @"signature": @"txt|site", @"factKey": @"website", @"confidence": @0.8 } ];
    return [Core() ghostsForFields:fields assignments:assignments profile:[Core() demoProfile] settings:settings source:@"server" options:nil];
}

// docs/always-propose.md: the threshold picks the TIER a ghost is drawn at. It never removes one.
GH_TEST(core_ghostsFor_tiers_by_threshold_and_never_drops) {
    NSMutableDictionary *settings = [[Core() defaultSettings] mutableCopy];
    settings[@"confidenceThreshold"] = @0.9;
    NSDictionary *strict = BySignature(GhostsWithConfidences(settings));
    GH_ASSERT(strict[@"txt|first"] != nil);
    GH_ASSERT(strict[@"txt|site"] != nil); // 0.8 is under the bar: dimmed, not gone
    GH_ASSERT_EQUAL_OBJECTS(strict[@"txt|site"][@"tier"], @"long-shot");
    GH_ASSERT_EQUAL_OBJECTS(strict[@"txt|site"][@"guess"], @YES);
    GH_ASSERT_EQUAL_OBJECTS(strict[@"txt|first"][@"tier"], @"confident");
    GH_ASSERT_NEAR([strict[@"txt|first"][@"confidence"] doubleValue], 0.95, 1e-9);
    settings[@"confidenceThreshold"] = @0.7;
    NSDictionary *loose = BySignature(GhostsWithConfidences(settings));
    GH_ASSERT(loose[@"txt|site"] != nil);
    GH_ASSERT_EQUAL_OBJECTS(loose[@"txt|site"][@"tier"], @"guess");
    settings[@"confidenceThreshold"] = @0.99;
    NSArray<NSDictionary *> *all = GhostsWithConfidences(settings);
    GH_ASSERT_EQUAL_INT(all.count, 2);
    for (NSDictionary *ghost in all) GH_ASSERT_EQUAL_OBJECTS(ghost[@"tier"], @"long-shot");
}

GH_TEST(core_ghostsFor_confidence_includes_option_match_quality) {
    // 0.75 for the fact times 0.88 for a fuzzy option match is below the default 0.7: a long shot, not a silence.
    SBField *select = Field(@"sel|school", @"School", SBKindSelect);
    select.options = @[ @{ @"value": @"", @"label": @"Select" }, @{ @"value": @"uw", @"label": @"University of Waterloo (Ontario)" } ];
    NSArray *assignments = @[ @{ @"signature": @"sel|school", @"factKey": @"school", @"confidence": @0.75 } ];
    SBCore *core = Core();
    NSArray<NSDictionary *> *weak = [core ghostsForFields:@[ select ] assignments:assignments profile:[core demoProfile] settings:[core defaultSettings] source:@"server" options:nil];
    GH_ASSERT_EQUAL_INT(weak.count, 1);
    GH_ASSERT_EQUAL_OBJECTS(weak[0][@"tier"], @"long-shot");
    GH_ASSERT_EQUAL_OBJECTS(weak[0][@"value"], @"uw");
    assignments = @[ @{ @"signature": @"sel|school", @"factKey": @"school", @"confidence": @0.95 } ];
    NSArray<NSDictionary *> *ghosts = [core ghostsForFields:@[ select ] assignments:assignments profile:[core demoProfile] settings:[core defaultSettings] source:@"server" options:nil];
    GH_ASSERT_EQUAL_INT(ghosts.count, 1);
    GH_ASSERT_EQUAL_OBJECTS(ghosts[0][@"value"], @"uw");
    GH_ASSERT([ghosts[0][@"confidence"] doubleValue] < 0.95);
}

GH_TEST(core_ghostsFor_broken_threshold_falls_back_to_default) {
    // 0.95 passes and 0.8 passes the default 0.7; a broken setting must behave exactly like the default,
    // not like 0 (everything) and not like 1 (nothing).
    for (id bad in @[ @"zero", @(-1), @5, [NSNull null] ]) {
        NSMutableDictionary *settings = [[Core() defaultSettings] mutableCopy];
        settings[@"confidenceThreshold"] = bad;
        GH_ASSERT_EQUAL_INT(GhostsWithConfidences(settings).count, 2);
    }
    NSArray<SBField *> *fields = @[ Field(@"txt|first", @"First name", SBKindText) ];
    NSArray *weak = @[ @{ @"signature": @"txt|first", @"factKey": @"firstName", @"confidence": @0.6 } ];
    // Under the default 0.7, so it is drawn as a long shot -- a broken setting still must not silence it.
    NSArray<NSDictionary *> *dim = [Core() ghostsForFields:fields assignments:weak profile:[Core() demoProfile] settings:@{ @"confidenceThreshold": @"broken" } source:@"server" options:nil];
    GH_ASSERT_EQUAL_INT(dim.count, 1);
    GH_ASSERT_EQUAL_OBJECTS(dim[0][@"tier"], @"long-shot");
}

GH_TEST(core_ghostsFor_skips_filled_fields) {
    SBField *typed = Field(@"txt|first", @"First name", SBKindText);
    typed.value = @"Sam";
    SBField *blank = Field(@"txt|last", @"Last name", SBKindText);
    blank.value = @"";
    SBField *whitespace = Field(@"txt|email", @"Email", SBKindEmail);
    whitespace.value = @" ";
    SBField *chosen = Field(@"sel|authorized", @"Are you authorized to work in Canada?", SBKindSelect);
    chosen.options = Options(@[ @"Select an option", @"Yes", @"No" ]);
    chosen.value = @"No";
    NSDictionary *map = BySignature(GhostsFor(@[ typed, blank, whitespace, chosen ], nil, nil));
    GH_ASSERT(map[@"txt|first"] == nil);
    GH_ASSERT(map[@"txt|last"] != nil);
    GH_ASSERT(map[@"txt|email"] == nil);      // whitespace counts as a value: never overwrite
    GH_ASSERT(map[@"sel|authorized"] == nil); // the user already chose
}

GH_TEST(core_ghostsFor_treats_placeholder_choice_as_empty) {
    SBField *select = Field(@"sel|country", @"Country", SBKindSelect);
    select.options = @[ @{ @"value": @"placeholder", @"label": @"Choose a country" }, @{ @"value": @"CA", @"label": @"Canada" }, @{ @"value": @"US", @"label": @"United States" } ];
    select.value = @"placeholder";
    NSDictionary *ghost = BySignature(GhostsFor(@[ select ], nil, nil))[@"sel|country"];
    GH_ASSERT(ghost != nil);
    GH_ASSERT_EQUAL_OBJECTS(ghost[@"value"], @"CA");
    GH_ASSERT_EQUAL_OBJECTS(ghost[@"displayText"], @"Canada");
    GH_ASSERT([Core() isPlaceholderValue:@"" label:@"anything"]);
    GH_ASSERT([Core() isPlaceholderValue:@"x" label:@"-- pick one --"]);
    GH_ASSERT_FALSE([Core() isPlaceholderValue:@"CA" label:@"Canada"]);
}

GH_TEST(core_ghostsFor_never_produces_ghosts_for_sensitive_probes) {
    SBCore *core = Core();
    NSMutableDictionary *profile = [[core demoProfile] mutableCopy];
    NSMutableDictionary *facts = [profile[@"facts"] mutableCopy];
    facts[@"secretFact"] = @"4111 1111 1111 1111";
    profile[@"facts"] = facts;

    SBField *password = Field(@"txt|pw", @"Email", SBKindText);
    password.inputType = @"password";
    SBField *card = Field(@"txt|card", @"Card number", SBKindText);
    SBField *sin = Field(@"txt|sin", @"Social Insurance Number", SBKindText);
    SBField *cvv = Field(@"txt|cvv", @"Name", SBKindText);
    cvv.identifier = @"cc-cvv";
    SBField *placeholder = Field(@"txt|ph", @"Phone", SBKindTel);
    placeholder.placeholder = @"Your passport number";
    SBField *named = Field(@"txt|named", @"First name", SBKindText);
    named.name = @"card_number";
    SBField *fine = Field(@"txt|first", @"First name", SBKindText);
    NSArray<SBField *> *fields = @[ password, card, sin, cvv, placeholder, named, fine ];

    // A hostile or buggy server answer that points real facts at every sensitive field.
    NSMutableArray *assignments = [NSMutableArray array];
    for (SBField *field in fields) [assignments addObject:@{ @"signature": field.signature, @"factKey": field == card ? @"secretFact" : @"email", @"confidence": @1.0 }];
    NSArray<NSDictionary *> *ghosts = [core ghostsForFields:fields assignments:assignments profile:profile settings:[core defaultSettings] source:@"server" options:nil];
    GH_ASSERT_EQUAL_INT(ghosts.count, 1);
    GH_ASSERT_EQUAL_OBJECTS(ghosts.firstObject[@"signature"], @"txt|first");
    GH_ASSERT_EQUAL_OBJECTS(ghosts.firstObject[@"source"], @"server");
}

GH_TEST(core_ghostsFor_only_ticks_checkboxes) {
    SBCore *core = Core();
    // The country matters: an unqualified `workAuthorization` only answers a question that names a country
    // when the profile says it lives there (docs/answers.md section 2).
    NSDictionary *profile = @{ @"facts": @{ @"workAuthorization": @"yes", @"requiresSponsorship": @"no", @"country": @"Canada" }, @"pastAnswers": @[] };
    SBField *authorized = Field(@"chk|auth", @"I am authorized to work in Canada", SBKindCheckbox);
    authorized.value = @"false";
    SBField *alreadyTicked = Field(@"chk|auth2", @"Legally authorized to work", SBKindCheckbox);
    alreadyTicked.value = @"true";
    SBField *sponsorship = Field(@"chk|sponsor", @"I require sponsorship", SBKindCheckbox);
    sponsorship.value = @"true"; // fact says no: Shabang must not untick
    SBField *consent = Field(@"chk|terms", @"I agree to the terms", SBKindCheckbox);
    NSArray<SBField *> *fields = @[ authorized, alreadyTicked, sponsorship, consent ];
    NSArray *assignments = [core mapFields:fields factKeys:@[ @"workAuthorization", @"requiresSponsorship", @"country" ]];
    NSArray<NSDictionary *> *ghosts = [core ghostsForFields:fields assignments:assignments profile:profile settings:[core defaultSettings] source:@"offline" options:nil];
    GH_ASSERT_EQUAL_INT(ghosts.count, 1);
    GH_ASSERT_EQUAL_OBJECTS(ghosts.firstObject[@"signature"], @"chk|auth");
    GH_ASSERT_EQUAL_OBJECTS(ghosts.firstObject[@"action"], @"check");
    GH_ASSERT_EQUAL_OBJECTS(ghosts.firstObject[@"value"], @"true");

    // Without a country, the same profile says nothing about Canada: the conservative answer is "not
    // authorized", and an unticked box is already that, so Shabang offers nothing rather than unticking.
    NSDictionary *noCountry = @{ @"facts": @{ @"workAuthorization": @"yes", @"requiresSponsorship": @"no" }, @"pastAnswers": @[] };
    NSArray *quiet = [core ghostsForFields:@[ authorized ] assignments:assignments profile:noCountry settings:[core defaultSettings] source:@"offline" options:nil];
    GH_ASSERT_EQUAL_INT(quiet.count, 0);
}

GH_TEST(core_ghostsFor_lock_rules) {
    SBField *first = Field(@"txt|first", @"First name", SBKindText);
    SBField *deleteAll = Field(@"btn|delete", @"Delete draft", SBKindButton);
    deleteAll.locked = YES;
    SBField *submit = Field(@"btn|submit", @"Submit", SBKindButton);
    submit.locked = YES;
    SBField *lockedLink = Field(@"link|send", @"Send", SBKindLink);
    lockedLink.locked = YES;

    // Prefers the primary-looking locked button after the last value ghost; links never get the lock ghost.
    NSArray<NSDictionary *> *ghosts = GhostsFor(@[ first, submit, deleteAll, lockedLink ], nil, nil);
    GH_ASSERT_EQUAL_INT(ghosts.count, 2);
    GH_ASSERT_EQUAL_OBJECTS(ghosts.lastObject[@"signature"], @"btn|submit");

    // No value ghosts: no lock ghost either (a page with only a Delete button gets nothing).
    first.value = @"Alex";
    GH_ASSERT_EQUAL_INT(GhostsFor(@[ first, submit, deleteAll ], nil, nil).count, 0);

    // keepLock after a walk: only the Submit the walk was heading for survives, never another button.
    NSArray<NSDictionary *> *kept = GhostsFor(@[ first, submit, deleteAll ], nil, @{ @"keepLock": @YES, @"lockSignature": @"btn|submit" });
    GH_ASSERT_EQUAL_INT(kept.count, 1);
    GH_ASSERT_EQUAL_OBJECTS(kept.firstObject[@"signature"], @"btn|submit");
    GH_ASSERT_EQUAL_INT(GhostsFor(@[ first, deleteAll ], nil, @{ @"keepLock": @YES, @"lockSignature": @"btn|submit" }).count, 0);
}

GH_TEST(core_ghostsFor_survives_garbage_input) {
    SBCore *core = Core();
    NSArray *junk = @[ @{ @"signature": @"a" }, @{ @"factKey": @"email", @"confidence": @"high" }, @"string", @{ @"signature": @"txt|first", @"factKey": @"email; drop", @"confidence": @1 } ];
    NSArray *ghosts = [core ghostsForFields:@[ Field(@"txt|first", @"First name", SBKindText) ] assignments:junk profile:[core demoProfile] settings:@{} source:@"bogus" options:nil];
    // Every malformed assignment is dropped, and the answer engine still answers the question from the profile:
    // Shabang never gives up on a field because a server said something unusable (docs/answers.md section 1).
    GH_ASSERT_EQUAL_INT(ghosts.count, 1);
    GH_ASSERT_EQUAL_OBJECTS(ghosts.firstObject[@"value"], @"Alex");
    GH_ASSERT_EQUAL_OBJECTS(ghosts.firstObject[@"answerSource"], @"fact");
    GH_ASSERT(ghosts.firstObject[@"guess"] == nil);
    // No fields at all is still nothing at all.
    NSString *raw = [core callString:@"ghostsFor" arguments:@[ @"[]", @"[]", @"{}", @"{}", @"offline" ]];
    GH_ASSERT_EQUAL_OBJECTS(raw, @"[]");
    // And a profile with nothing in it still proposes: with no answer to give, Shabang offers to go there
    // (docs/always-propose.md), as a long shot that commits nothing.
    NSArray *empty = [core ghostsForFields:@[ Field(@"txt|first", @"First name", SBKindText) ] assignments:junk
                                    profile:@{ @"facts": @{}, @"pastAnswers": @[] } settings:@{} source:@"bogus" options:nil];
    GH_ASSERT_EQUAL_INT(empty.count, 1);
    GH_ASSERT_EQUAL_OBJECTS(empty.firstObject[@"action"], @"click");
    GH_ASSERT_EQUAL_OBJECTS(empty.firstObject[@"tier"], @"long-shot");
}

GH_TEST(core_upgradeGhosts_merges_server_answer) {
    SBCore *core = Core();
    NSDictionary *profile = [core demoProfile];
    SBField *first = Field(@"txt|first", @"First name", SBKindText);
    SBField *handle = Field(@"txt|handle", @"Where can we see your code?", SBKindText); // the heuristic has no idea
    NSArray<SBField *> *fields = @[ first, handle ];

    // Uncalibrated answer that disagrees with a confident offline ghost: the offline one stays.
    NSArray *uncalibrated = @[ @{ @"signature": @"txt|first", @"factKey": @"lastName", @"confidence": @0.8, @"calibrated": @NO },
                               @{ @"signature": @"txt|handle", @"factKey": @"github", @"confidence": @0.9, @"calibrated": @NO } ];
    NSDictionary *merged = BySignature([core upgradeGhostsForFields:fields served:uncalibrated profile:profile settings:[core defaultSettings] source:@"server" options:nil]);
    GH_ASSERT_EQUAL_OBJECTS(merged[@"txt|first"][@"value"], @"Alex");
    GH_ASSERT_EQUAL_OBJECTS(merged[@"txt|first"][@"source"], @"offline");
    GH_ASSERT_EQUAL_OBJECTS(merged[@"txt|handle"][@"value"], profile[@"facts"][@"github"]);
    GH_ASSERT_EQUAL_OBJECTS(merged[@"txt|handle"][@"source"], @"server");

    // A calibrated answer wins.
    NSArray *calibrated = @[ @{ @"signature": @"txt|first", @"factKey": @"fullName", @"confidence": @0.97, @"calibrated": @YES } ];
    merged = BySignature([core upgradeGhostsForFields:fields served:calibrated profile:profile settings:[core defaultSettings] source:@"cache" options:nil]);
    GH_ASSERT_EQUAL_OBJECTS(merged[@"txt|first"][@"value"], @"Alex Chen");
    GH_ASSERT_EQUAL_OBJECTS(merged[@"txt|first"][@"source"], @"cache");
}

#pragma mark - safety probes

GH_TEST(core_isSensitive_matches_shared_rules) {
    SBCore *core = Core();
    for (NSString *label in @[ @"Password", @"Card number", @"CVV", @"Social Insurance Number", @"S.I.N.", @"Passport number",
                               @"Driver's license", @"Expiry (MM/YY)", @"Routing number", @"API key", @"One-time code", @"Security code" ]) {
        GH_ASSERT_MSG([core isSensitive:@{ @"label": label }], @"%@ should be sensitive", label);
    }
    for (NSString *label in @[ @"First name", @"Email", @"LinkedIn profile", @"City", @"Why do you want to work here?" ]) {
        GH_ASSERT_MSG(![core isSensitive:@{ @"label": label }], @"%@ should not be sensitive", label);
    }
    GH_ASSERT([core isSensitive:@{ @"label": @"Email", @"inputType": @"password" }]);
    GH_ASSERT([core isSensitive:@{ @"label": @"Number", @"autocomplete": @"cc-number" }]);
    GH_ASSERT([core isSensitive:@{ @"label": @"Notes", @"markedSensitive": @YES }]);
    GH_ASSERT([core isSensitiveLabel:@"Name" placeholder:nil identifier:@"cardholder-name"]);
    GH_ASSERT([core isSensitiveProbe:@{ @"placeholder": @"Your SSN" }]);
}

GH_TEST(core_safety_probes_fail_closed) {
    SBCore *core = Core();
    // Not serializable: the answer must be the safe one.
    GH_ASSERT([core isSensitive:@{ @"label": [NSDate date] }]);
    GH_ASSERT([core isLockedAction:@{ @"text": [NSDate date] }]);
    GH_ASSERT([core isLockedAction:@{}]); // no text at all: lock
    GH_ASSERT([core callBool:@"isSensitive" arguments:@[ @"not json" ] fallback:YES]);
    GH_ASSERT([core callBool:@"isSensitive" arguments:@[ @"[1,2]" ] fallback:NO]); // non-object probe
}

GH_TEST(core_isLockedAction_matches_shared_rules) {
    SBCore *core = Core();
    for (NSString *text in @[ @"Submit application", @"Send", @"Pay now", @"Place order", @"Delete", @"Confirm", @"Apply", @"Unsubscribe" ]) {
        GH_ASSERT_MSG([core isLockedActionText:text], @"%@ should be locked", text);
    }
    for (NSString *text in @[ @"Show more", @"Next section", @"Add another", @"Back" ]) {
        GH_ASSERT_MSG(![core isLockedActionText:text], @"%@ should not be locked", text);
    }
    GH_ASSERT([core isLockedProbe:@{ @"text": @"Go", @"buttonType": @"submit" }]);
    GH_ASSERT([core isLockedProbe:@{ @"text": @"Go", @"markedLocked": @YES }]);
}

#pragma mark - what may leave the process

GH_TEST(core_textFacts_excludes_contact_details) {
    NSDictionary *facts = [Core() textFactsForProfile:[Core() demoProfile]];
    GH_ASSERT_EQUAL_OBJECTS(facts[@"school"], @"University of Waterloo");
    GH_ASSERT_EQUAL_OBJECTS(facts[@"fullName"], @"Alex Chen");
    for (NSString *key in @[ @"email", @"phone", @"linkedin", @"workAuthorization", @"requiresSponsorship", @"city" ]) {
        GH_ASSERT_MSG(facts[key] == nil, @"%@ must not reach /v1/shabang-text", key);
    }
    // An allowlisted key whose VALUE is contact data is dropped too.
    NSDictionary *sneaky = @{ @"facts": @{ @"website": @"mail me at alex.chen.dev@example.com", @"location": @"+1 519 555 0142", @"major": @"Computer Science" } };
    NSDictionary *clean = [Core() textFactsForProfile:sneaky];
    GH_ASSERT(clean[@"website"] == nil);
    GH_ASSERT(clean[@"location"] == nil);
    GH_ASSERT_EQUAL_OBJECTS(clean[@"major"], @"Computer Science");
}

GH_TEST(core_formRequest_is_value_free) {
    SBCore *core = Core();
    NSDictionary *profile = [core demoProfile];
    NSMutableArray<SBField *> *fields = [JobApplication() mutableCopy];
    fields[0].value = @"TYPED-BY-USER";
    SBField *card = Field(@"txt|card", @"Card number", SBKindText);
    [fields addObject:card];
    // Even the value-carrying JSON must come out clean.
    NSData *body = [core formRequestBodyForFieldObjects:[SBField JSONObjectsForFields:fields] factKeys:FactKeys(profile) origin:@"app://com.apple.Safari/example.com" formSignature:@"form-1"];
    GH_ASSERT(body != nil);
    NSString *text = [[NSString alloc] initWithData:body encoding:NSUTF8StringEncoding];
    GH_ASSERT_FALSE([text containsString:@"TYPED-BY-USER"]);
    for (NSString *value in [profile[@"facts"] allValues]) {
        if (value.length < 4) continue; // "yes"/"no" appear as option labels
        GH_ASSERT_MSG(![text containsString:value], @"profile value leaked into the request: fact of length %lu", (unsigned long)value.length);
    }
    NSDictionary *json = [NSJSONSerialization JSONObjectWithData:body options:0 error:NULL];
    GH_ASSERT_EQUAL_OBJECTS(json[@"origin"], @"app://com.apple.Safari/example.com");
    GH_ASSERT_EQUAL_OBJECTS(json[@"formSignature"], @"form-1");
    GH_ASSERT([json[@"factKeys"] containsObject:@"firstName"]);
    NSDictionary *wire = BySignature(json[@"fields"]);
    GH_ASSERT(wire[@"txt|first"] != nil);
    GH_ASSERT(wire[@"txt|first"][@"value"] == nil);
    GH_ASSERT(wire[@"txt|card"] == nil);      // sensitive: not even its label leaves
    GH_ASSERT(wire[@"btn|submit"] == nil);    // buttons and links never reach the server
    GH_ASSERT(wire[@"link|privacy"] == nil);
    GH_ASSERT_EQUAL_OBJECTS(wire[@"txt|first"][@"rect"][@"width"], @0);

    GH_ASSERT([core formRequestBodyForFieldObjects:@[] factKeys:FactKeys(profile) origin:@"o" formSignature:@"s"] == nil);
    GH_ASSERT([core formRequestBodyForFieldObjects:[SBField JSONObjectsForFields:fields] factKeys:@[ @"alex.chen.dev@example.com", @"42" ] origin:@"o" formSignature:@"s"] == nil);
}

GH_TEST(core_cleanAssignments_keeps_well_formed_entries) {
    NSArray *raw = @[ @{ @"signature": @"a", @"factKey": @"email", @"confidence": @1.7, @"calibrated": @YES, @"source": @"jev", @"value": @"x" },
                      @{ @"signature": @"b", @"factKey": @"bad key!", @"confidence": @0.5 }, @{ @"signature": @"", @"factKey": @"email", @"confidence": @0.5 }, @42 ];
    NSArray<NSDictionary *> *clean = [Core() cleanAssignments:raw];
    GH_ASSERT_EQUAL_INT(clean.count, 1);
    GH_ASSERT_EQUAL_OBJECTS(clean[0][@"confidence"], @1);
    GH_ASSERT_EQUAL_OBJECTS(clean[0][@"calibrated"], @YES);
    GH_ASSERT(clean[0][@"value"] == nil);
    GH_ASSERT_EQUAL_INT([Core() cleanAssignments:@"nope"].count, 0);
}

#pragma mark - SBField

GH_TEST(field_json_round_trip) {
    SBField *field = Field(@"sel|country", @"Country", SBKindSelect);
    field.inputType = @"popup";
    field.name = @"country";
    field.identifier = @"country-select";
    field.placeholder = @"Choose";
    field.options = @[ @{ @"value": @"CA", @"label": @"Canada" } ];
    field.required = YES;
    field.value = @"CA";
    field.locked = NO;
    field.context = @"Address";
    field.rect = CGRectMake(10.5, 20, 300, 24);
    NSDictionary *json = [field toJSONObject];
    GH_ASSERT([NSJSONSerialization isValidJSONObject:json]);
    GH_ASSERT_EQUAL_OBJECTS(json[@"id"], @"country-select");
    GH_ASSERT_EQUAL_OBJECTS(json[@"value"], @"CA");
    GH_ASSERT_EQUAL_OBJECTS(json[@"rect"][@"x"], @10.5);
    GH_ASSERT(json[@"axElement"] == nil);
    GH_ASSERT(json[@"locked"] == nil); // optional flags are omitted when false, like the TypeScript side
    SBField *back = [SBField fieldFromJSONObject:json];
    GH_ASSERT_EQUAL_OBJECTS([back toJSONObject], json);
    GH_ASSERT([field toWireJSONObject][@"value"] == nil);
    GH_ASSERT([SBField fieldFromJSONObject:@{ @"label": @"no signature" }] == nil);
}

GH_TEST(field_survives_broken_geometry_and_options) {
    SBField *field = Field(@"txt|x", @"X", SBKindText);
    field.rect = CGRectMake(NAN, INFINITY, -INFINITY, 10);
    field.options = (NSArray *)@[ @"not a dictionary", @{ @"value": @1, @"label": @"One" } ];
    NSDictionary *json = [field toJSONObject];
    GH_ASSERT([NSJSONSerialization isValidJSONObject:json]);
    GH_ASSERT_EQUAL_OBJECTS(json[@"rect"][@"x"], @0);
    GH_ASSERT_EQUAL_OBJECTS(json[@"options"], (@[ @{ @"value": @"", @"label": @"One" } ]));
    GH_ASSERT_FALSE([field.description containsString:@"value="]);
}

GH_TEST(field_retains_ax_element_safely) {
    AXUIElementRef element = AXUIElementCreateSystemWide(); // creating the reference needs no permission
    CFIndex before = CFGetRetainCount(element);
    @autoreleasepool {
        SBField *field = Field(@"txt|x", @"X", SBKindText);
        field.axElement = element;
        field.axElement = element; // same element twice: no double retain
        GH_ASSERT_EQUAL_INT(CFGetRetainCount(element), before + 1);
        SBField *copy = [field copy];
        GH_ASSERT(copy.axElement == element);
        GH_ASSERT_EQUAL_INT(CFGetRetainCount(element), before + 2);
        field.axElement = NULL;
        GH_ASSERT_EQUAL_INT(CFGetRetainCount(element), before + 1);
    }
    GH_ASSERT_EQUAL_INT(CFGetRetainCount(element), before);
    CFRelease(element);
}

#pragma mark - SBLog

GH_TEST(log_writes_private_file_and_masks_labels) {
    NSString *previous = SBLogPath();
    NSString *path = [SBTestTempDirectory() stringByAppendingPathComponent:@"logs/desktop.log"];
    SBLogSetPath(path);
    SBLog(@"test: ghost for label=%@", SBLogLabel(@"First name"));
    SBLog(@"test: label=%@", SBLogLabel(@"Card number"));
    SBLog(@"test: label=%@", SBLogLabel(@"A very long label that goes on and on well past the forty character limit"));
    SBLogFlush();
    NSString *text = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:NULL];
    SBLogSetPath(previous);
    GH_ASSERT([text containsString:@"label=First name"]);
    GH_ASSERT([text containsString:@"label=[sensitive]"]);
    GH_ASSERT_FALSE([text containsString:@"Card number"]);
    GH_ASSERT_FALSE([text containsString:@"forty character limit"]);
    GH_ASSERT_EQUAL_INT([[text componentsSeparatedByString:@"\n"] count], 4);
    NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:path error:NULL];
    GH_ASSERT_EQUAL_INT([attributes[NSFilePosixPermissions] intValue], 0600);
    GH_ASSERT_EQUAL_OBJECTS(SBLogLabel(nil), @"(no label)");
}
