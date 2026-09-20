// Core bridge tests: the real build/ghost-core.js running in JavaScriptCore (DESKTOP_CORE_PATH, set by `make test`).
// These pin the rules ported into desktop/core/predict.ts, so a drift from the extension shows up here.
#import "GHTest.h"
#import "GHCore.h"
#import "GHField.h"
#import "GHLog.h"

static GHCore *Core(void) {
    static GHCore *core;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSString *path = [GHCore defaultBundlePath];
        core = path ? [[GHCore alloc] initWithBundlePath:path error:NULL] : nil;
    });
    return core;
}

static GHField *Field(NSString *signature, NSString *label, NSString *kind) {
    GHField *field = [GHField fieldWithSignature:signature label:label kind:kind];
    field.rect = CGRectMake(40, 40, 320, 28);
    return field;
}

static NSArray<NSDictionary<NSString *, NSString *> *> *Options(NSArray<NSString *> *labels) {
    NSMutableArray *options = [NSMutableArray array];
    for (NSString *label in labels) [options addObject:@{ @"value": [label hasPrefix:@"Select"] ? @"" : label, @"label": label }];
    return options;
}

/// A job application as capture would hand it over: reading order, locked Submit at the end.
static NSArray<GHField *> *JobApplication(void) {
    GHField *authorized = Field(@"sel|authorized", @"Are you legally authorized to work in this country?", GHKindSelect);
    authorized.options = Options(@[ @"Select an option", @"Yes", @"No" ]);
    authorized.value = @"";
    GHField *sponsorship = Field(@"radio|sponsorship", @"Will you require sponsorship?", GHKindRadio);
    sponsorship.options = Options(@[ @"Yes", @"No" ]);
    GHField *cancel = Field(@"btn|cancel", @"Cancel", GHKindButton);
    GHField *submit = Field(@"btn|submit", @"Submit application", GHKindButton);
    submit.locked = YES;
    return @[
        Field(@"txt|first", @"First name", GHKindText),
        Field(@"txt|last", @"Last name", GHKindText),
        Field(@"txt|email", @"Email address", GHKindEmail),
        Field(@"txt|phone", @"Phone", GHKindTel),
        Field(@"txt|linkedin", @"LinkedIn profile", GHKindURL),
        Field(@"txt|github", @"GitHub", GHKindText),
        Field(@"txt|school", @"University", GHKindText),
        authorized, sponsorship,
        Field(@"area|why", @"Why do you want to work here?", GHKindTextArea),
        Field(@"link|privacy", @"Privacy policy", GHKindLink),
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

static NSArray<NSDictionary *> *GhostsFor(NSArray<GHField *> *fields, NSDictionary *settings, NSDictionary *options) {
    GHCore *core = Core();
    NSDictionary *profile = [core demoProfile];
    NSArray *assignments = [core mapFields:fields factKeys:FactKeys(profile)];
    return [core ghostsForFields:fields assignments:assignments profile:profile settings:settings ?: [core defaultSettings] source:@"offline" options:options];
}

#pragma mark - loading

GH_TEST(core_loads_bundle_and_demo_profile) {
    GH_ASSERT_MSG(Core() != nil, @"ghost-core.js did not load; DESKTOP_CORE_PATH=%s", getenv("DESKTOP_CORE_PATH") ?: "(unset)");
    NSDictionary *facts = [Core() demoProfile][@"facts"];
    GH_ASSERT_EQUAL_OBJECTS(facts[@"firstName"], @"Alex");
    GH_ASSERT_EQUAL_OBJECTS(facts[@"lastName"], @"Chen");
    GH_ASSERT_EQUAL_OBJECTS([Core() defaultSettings][@"confidenceThreshold"], @0.7);
}

GH_TEST(core_missing_bundle_reports_error) {
    NSError *error;
    GHCore *core = [[GHCore alloc] initWithBundlePath:@"/nonexistent/ghost-core.js" error:&error];
    GH_ASSERT(core == nil);
    GH_ASSERT_EQUAL_INT(error.code, GHCoreErrorBundleNotFound);
}

GH_TEST(core_bundle_is_pinned_to_the_one_built_with_the_library) {
    NSString *pinned = GHCorePinnedSHA256();
    GH_ASSERT_EQUAL_INT(pinned.length, 64);                           // make lib / make test embed it
    NSString *built = [GHCore defaultBundlePath];                     // the test runner: DESKTOP_CORE_PATH, the fresh build
    GH_ASSERT(built != nil);
    GH_ASSERT_EQUAL_OBJECTS(GHCoreSHA256OfFile(built), pinned);
    GH_ASSERT(GHCoreBundleMatchesPin(built, pinned));
    // A swapped core (same exports, different rules) is refused; so is a missing one. Only an unpinned build skips it.
    NSString *swapped = [GHTestTempDirectory() stringByAppendingPathComponent:@"ghost-core.js"];
    NSString *source = [[NSString stringWithContentsOfFile:built encoding:NSUTF8StringEncoding error:NULL] stringByAppendingString:@"\n// changed\n"];
    GH_ASSERT([source writeToFile:swapped atomically:YES encoding:NSUTF8StringEncoding error:NULL]);
    GH_ASSERT_FALSE(GHCoreBundleMatchesPin(swapped, pinned));
    GH_ASSERT_FALSE(GHCoreBundleMatchesPin([GHTestTempDirectory() stringByAppendingPathComponent:@"missing.js"], pinned));
    GH_ASSERT(GHCoreBundleMatchesPin(swapped, @""));
    GH_ASSERT([GHCoreSHA256OfFile(nil) length] == 0);
}

GH_TEST(core_rejects_bundle_with_missing_export) {
    NSError *error;
    GHCore *core = [[GHCore alloc] initWithSource:@"var GhostCore = { demoProfile: function () { return '{}'; } };" error:&error];
    GH_ASSERT(core == nil);
    GH_ASSERT_EQUAL_INT(error.code, GHCoreErrorMissingExport);
    GH_ASSERT([error.localizedDescription containsString:@"ghostsFor"]);
}

GH_TEST(core_rejects_bundle_that_throws) {
    NSError *error;
    GHCore *core = [[GHCore alloc] initWithSource:@"document.title = 'needs a DOM';" error:&error];
    GH_ASSERT(core == nil);
    GH_ASSERT_EQUAL_INT(error.code, GHCoreErrorEvaluationFailed);
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
    NSArray<GHField *> *fields = @[ Field(@"txt|first", @"First name", GHKindText), Field(@"txt|site", @"Website", GHKindText) ];
    NSArray *assignments = @[ @{ @"signature": @"txt|first", @"factKey": @"firstName", @"confidence": @0.95 },
                              @{ @"signature": @"txt|site", @"factKey": @"website", @"confidence": @0.8 } ];
    return [Core() ghostsForFields:fields assignments:assignments profile:[Core() demoProfile] settings:settings source:@"server" options:nil];
}

GH_TEST(core_ghostsFor_gates_by_threshold) {
    NSMutableDictionary *settings = [[Core() defaultSettings] mutableCopy];
    settings[@"confidenceThreshold"] = @0.9;
    NSDictionary *strict = BySignature(GhostsWithConfidences(settings));
    GH_ASSERT(strict[@"txt|first"] != nil);
    GH_ASSERT(strict[@"txt|site"] == nil);
    GH_ASSERT_NEAR([strict[@"txt|first"][@"confidence"] doubleValue], 0.95, 1e-9);
    settings[@"confidenceThreshold"] = @0.7;
    GH_ASSERT(BySignature(GhostsWithConfidences(settings))[@"txt|site"] != nil);
    settings[@"confidenceThreshold"] = @0.99;
    GH_ASSERT_EQUAL_INT(GhostsWithConfidences(settings).count, 0);
}

GH_TEST(core_ghostsFor_confidence_includes_option_match_quality) {
    // 0.75 for the fact times 0.88 for a fuzzy option match is below the default 0.7.
    GHField *select = Field(@"sel|school", @"School", GHKindSelect);
    select.options = @[ @{ @"value": @"", @"label": @"Select" }, @{ @"value": @"uw", @"label": @"University of Waterloo (Ontario)" } ];
    NSArray *assignments = @[ @{ @"signature": @"sel|school", @"factKey": @"school", @"confidence": @0.75 } ];
    GHCore *core = Core();
    GH_ASSERT_EQUAL_INT([core ghostsForFields:@[ select ] assignments:assignments profile:[core demoProfile] settings:[core defaultSettings] source:@"server" options:nil].count, 0);
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
    NSArray<GHField *> *fields = @[ Field(@"txt|first", @"First name", GHKindText) ];
    NSArray *weak = @[ @{ @"signature": @"txt|first", @"factKey": @"firstName", @"confidence": @0.6 } ];
    GH_ASSERT_EQUAL_INT([Core() ghostsForFields:fields assignments:weak profile:[Core() demoProfile] settings:@{ @"confidenceThreshold": @"broken" } source:@"server" options:nil].count, 0);
}

GH_TEST(core_ghostsFor_skips_filled_fields) {
    GHField *typed = Field(@"txt|first", @"First name", GHKindText);
    typed.value = @"Sam";
    GHField *blank = Field(@"txt|last", @"Last name", GHKindText);
    blank.value = @"";
    GHField *whitespace = Field(@"txt|email", @"Email", GHKindEmail);
    whitespace.value = @" ";
    GHField *chosen = Field(@"sel|authorized", @"Are you authorized to work in Canada?", GHKindSelect);
    chosen.options = Options(@[ @"Select an option", @"Yes", @"No" ]);
    chosen.value = @"No";
    NSDictionary *map = BySignature(GhostsFor(@[ typed, blank, whitespace, chosen ], nil, nil));
    GH_ASSERT(map[@"txt|first"] == nil);
    GH_ASSERT(map[@"txt|last"] != nil);
    GH_ASSERT(map[@"txt|email"] == nil);      // whitespace counts as a value: never overwrite
    GH_ASSERT(map[@"sel|authorized"] == nil); // the user already chose
}

GH_TEST(core_learned_answer_replays_across_greenhouse_amazon_and_airbnb_without_jev) {
    GHCore *core = Core();
    GHField *greenhouse = Field(@"gh-auth", @"Are you legally authorized to work in Canada for any employer?", GHKindSelect);
    greenhouse.options = @[ @{ @"value": @"0", @"label": @"No" }, @{ @"value": @"1", @"label": @"Yes" } ];
    NSDictionary *result = [core recordAnswerCorrectionForFieldObject:[greenhouse toJSONObject]
                                                                 value:@"1" optionLabel:@"Yes" origin:@"https://greenhouse.example"
                                                               answers:[core cleanLearnedAnswers:@{}]];
    NSDictionary *answers = result[@"snapshot"];
    GH_ASSERT_EQUAL_OBJECTS(result[@"changed"], @"added");
    GH_ASSERT_EQUAL_INT([answers[@"answers"] count], 1);

    GHField *amazon = Field(@"amazon-auth", @"Are you authorized to work in Canada for any employer?", GHKindSelect);
    amazon.options = @[ @{ @"value": @"not_authorized", @"label": @"No" }, @{ @"value": @"authorized", @"label": @"Yes" } ];
    GHField *airbnb = Field(@"airbnb-auth", @"Are you legally authorized to work in Canada?", GHKindRadio);
    airbnb.options = @[ @{ @"value": @"n", @"label": @"No" }, @{ @"value": @"y", @"label": @"Yes" } ];
    NSDictionary *profile = [core demoProfile];
    for (GHField *target in @[ amazon, airbnb ]) {
        NSArray *assignments = [core mapFields:@[ target ] factKeys:FactKeys(profile)];
        NSDictionary *ghost = [core ghostsForFields:@[ target ] assignments:assignments profile:profile settings:[core defaultSettings]
                                               source:@"offline" options:@{ @"answers": answers }].firstObject;
        GH_ASSERT(ghost != nil);
        GH_ASSERT_EQUAL_OBJECTS(ghost[@"answer"][@"source"], @"learned");
        GH_ASSERT_EQUAL_OBJECTS(ghost[@"displayText"], @"Yes");
    }
    NSArray *amazonAssignments = [core mapFields:@[ amazon ] factKeys:FactKeys(profile)];
    NSDictionary *amazonGhost = [core ghostsForFields:@[ amazon ] assignments:amazonAssignments profile:profile settings:[core defaultSettings]
                                                  source:@"offline" options:@{ @"answers": answers }].firstObject;
    GH_ASSERT_EQUAL_OBJECTS(amazonGhost[@"value"], @"authorized");
    NSArray *airbnbAssignments = [core mapFields:@[ airbnb ] factKeys:FactKeys(profile)];
    NSDictionary *airbnbGhost = [core ghostsForFields:@[ airbnb ] assignments:airbnbAssignments profile:profile settings:[core defaultSettings]
                                                  source:@"offline" options:@{ @"answers": answers }].firstObject;
    GH_ASSERT_EQUAL_OBJECTS(airbnbGhost[@"value"], @"y");

    GHField *first = Field(@"first", @"First name", GHKindText);
    NSData *body = [core formRequestBodyForFieldObjects:[GHField wireJSONObjectsForFields:@[ amazon, first ]]
                                               factKeys:FactKeys(profile) origin:@"app://com.google.Chrome/amazon.jobs"
                                          formSignature:@"amazon-form" learnedAnswers:answers];
    NSDictionary *wire = [NSJSONSerialization JSONObjectWithData:body options:0 error:NULL];
    NSDictionary *fields = BySignature(wire[@"fields"]);
    GH_ASSERT(fields[@"amazon-auth"] == nil); // answered locally: even its label stays away from JEV
    GH_ASSERT(fields[@"first"] != nil);
}

GH_TEST(core_ghostsFor_treats_placeholder_choice_as_empty) {
    GHField *select = Field(@"sel|country", @"Country", GHKindSelect);
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
    GHCore *core = Core();
    NSMutableDictionary *profile = [[core demoProfile] mutableCopy];
    NSMutableDictionary *facts = [profile[@"facts"] mutableCopy];
    facts[@"secretFact"] = @"4111 1111 1111 1111";
    profile[@"facts"] = facts;

    GHField *password = Field(@"txt|pw", @"Email", GHKindText);
    password.inputType = @"password";
    GHField *card = Field(@"txt|card", @"Card number", GHKindText);
    GHField *sin = Field(@"txt|sin", @"Social Insurance Number", GHKindText);
    GHField *cvv = Field(@"txt|cvv", @"Name", GHKindText);
    cvv.identifier = @"cc-cvv";
    GHField *placeholder = Field(@"txt|ph", @"Phone", GHKindTel);
    placeholder.placeholder = @"Your passport number";
    GHField *named = Field(@"txt|named", @"First name", GHKindText);
    named.name = @"card_number";
    GHField *fine = Field(@"txt|first", @"First name", GHKindText);
    NSArray<GHField *> *fields = @[ password, card, sin, cvv, placeholder, named, fine ];

    // A hostile or buggy server answer that points real facts at every sensitive field.
    NSMutableArray *assignments = [NSMutableArray array];
    for (GHField *field in fields) [assignments addObject:@{ @"signature": field.signature, @"factKey": field == card ? @"secretFact" : @"email", @"confidence": @1.0 }];
    NSArray<NSDictionary *> *ghosts = [core ghostsForFields:fields assignments:assignments profile:profile settings:[core defaultSettings] source:@"server" options:nil];
    GH_ASSERT_EQUAL_INT(ghosts.count, 1);
    GH_ASSERT_EQUAL_OBJECTS(ghosts.firstObject[@"signature"], @"txt|first");
    GH_ASSERT_EQUAL_OBJECTS(ghosts.firstObject[@"source"], @"server");
}

GH_TEST(core_ghostsFor_only_ticks_checkboxes) {
    GHCore *core = Core();
    NSDictionary *profile = @{ @"facts": @{ @"workAuthorization": @"yes", @"requiresSponsorship": @"no" }, @"pastAnswers": @[] };
    GHField *authorized = Field(@"chk|auth", @"I am authorized to work in Canada", GHKindCheckbox);
    authorized.value = @"false";
    GHField *alreadyTicked = Field(@"chk|auth2", @"Legally authorized to work", GHKindCheckbox);
    alreadyTicked.value = @"true";
    GHField *sponsorship = Field(@"chk|sponsor", @"I require sponsorship", GHKindCheckbox);
    sponsorship.value = @"true"; // fact says no: Ghost must not untick
    GHField *consent = Field(@"chk|terms", @"I agree to the terms", GHKindCheckbox);
    NSArray<GHField *> *fields = @[ authorized, alreadyTicked, sponsorship, consent ];
    NSArray *assignments = [core mapFields:fields factKeys:@[ @"workAuthorization", @"requiresSponsorship" ]];
    NSArray<NSDictionary *> *ghosts = [core ghostsForFields:fields assignments:assignments profile:profile settings:[core defaultSettings] source:@"offline" options:nil];
    GH_ASSERT_EQUAL_INT(ghosts.count, 1);
    GH_ASSERT_EQUAL_OBJECTS(ghosts.firstObject[@"signature"], @"chk|auth");
    GH_ASSERT_EQUAL_OBJECTS(ghosts.firstObject[@"action"], @"check");
    GH_ASSERT_EQUAL_OBJECTS(ghosts.firstObject[@"value"], @"true");
}

GH_TEST(core_ghostsFor_lock_rules) {
    GHField *first = Field(@"txt|first", @"First name", GHKindText);
    GHField *deleteAll = Field(@"btn|delete", @"Delete draft", GHKindButton);
    deleteAll.locked = YES;
    GHField *submit = Field(@"btn|submit", @"Submit", GHKindButton);
    submit.locked = YES;
    GHField *lockedLink = Field(@"link|send", @"Send", GHKindLink);
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
    GHCore *core = Core();
    NSArray *junk = @[ @{ @"signature": @"a" }, @{ @"factKey": @"email", @"confidence": @"high" }, @"string", @{ @"signature": @"txt|first", @"factKey": @"email; drop", @"confidence": @1 } ];
    NSArray *ghosts = [core ghostsForFields:@[ Field(@"txt|first", @"First name", GHKindText) ] assignments:junk profile:[core demoProfile] settings:@{} source:@"bogus" options:nil];
    GH_ASSERT_EQUAL_INT(ghosts.count, 0);
    NSString *raw = [core callString:@"ghostsFor" arguments:@[ @"[]", @"[]", @"{}", @"{}", @"offline" ]];
    GH_ASSERT_EQUAL_OBJECTS(raw, @"[]");
}

GH_TEST(core_upgradeGhosts_merges_server_answer) {
    GHCore *core = Core();
    NSDictionary *profile = [core demoProfile];
    GHField *first = Field(@"txt|first", @"First name", GHKindText);
    GHField *handle = Field(@"txt|handle", @"Where can we see your code?", GHKindText); // the heuristic has no idea
    NSArray<GHField *> *fields = @[ first, handle ];

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
    GHCore *core = Core();
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
    GHCore *core = Core();
    // Not serializable: the answer must be the safe one.
    GH_ASSERT([core isSensitive:@{ @"label": [NSDate date] }]);
    GH_ASSERT([core isLockedAction:@{ @"text": [NSDate date] }]);
    GH_ASSERT([core isLockedAction:@{}]); // no text at all: lock
    GH_ASSERT([core callBool:@"isSensitive" arguments:@[ @"not json" ] fallback:YES]);
    GH_ASSERT([core callBool:@"isSensitive" arguments:@[ @"[1,2]" ] fallback:NO]); // non-object probe
}

GH_TEST(core_isLockedAction_matches_shared_rules) {
    GHCore *core = Core();
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
        GH_ASSERT_MSG(facts[key] == nil, @"%@ must not reach /v1/ghost-text", key);
    }
    // An allowlisted key whose VALUE is contact data is dropped too.
    NSDictionary *sneaky = @{ @"facts": @{ @"website": @"mail me at alex.chen.dev@example.com", @"location": @"+1 519 555 0142", @"major": @"Computer Science" } };
    NSDictionary *clean = [Core() textFactsForProfile:sneaky];
    GH_ASSERT(clean[@"website"] == nil);
    GH_ASSERT(clean[@"location"] == nil);
    GH_ASSERT_EQUAL_OBJECTS(clean[@"major"], @"Computer Science");
}

GH_TEST(core_formRequest_is_value_free) {
    GHCore *core = Core();
    NSDictionary *profile = [core demoProfile];
    NSMutableArray<GHField *> *fields = [JobApplication() mutableCopy];
    fields[0].value = @"TYPED-BY-USER";
    GHField *card = Field(@"txt|card", @"Card number", GHKindText);
    [fields addObject:card];
    // Even the value-carrying JSON must come out clean.
    NSData *body = [core formRequestBodyForFieldObjects:[GHField JSONObjectsForFields:fields] factKeys:FactKeys(profile) origin:@"app://com.apple.Safari/example.com" formSignature:@"form-1"];
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
    GH_ASSERT([core formRequestBodyForFieldObjects:[GHField JSONObjectsForFields:fields] factKeys:@[ @"alex.chen.dev@example.com", @"42" ] origin:@"o" formSignature:@"s"] == nil);
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

#pragma mark - GHField

GH_TEST(field_json_round_trip) {
    GHField *field = Field(@"sel|country", @"Country", GHKindSelect);
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
    GHField *back = [GHField fieldFromJSONObject:json];
    GH_ASSERT_EQUAL_OBJECTS([back toJSONObject], json);
    GH_ASSERT([field toWireJSONObject][@"value"] == nil);
    GH_ASSERT([GHField fieldFromJSONObject:@{ @"label": @"no signature" }] == nil);
}

GH_TEST(field_survives_broken_geometry_and_options) {
    GHField *field = Field(@"txt|x", @"X", GHKindText);
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
        GHField *field = Field(@"txt|x", @"X", GHKindText);
        field.axElement = element;
        field.axElement = element; // same element twice: no double retain
        GH_ASSERT_EQUAL_INT(CFGetRetainCount(element), before + 1);
        GHField *copy = [field copy];
        GH_ASSERT(copy.axElement == element);
        GH_ASSERT_EQUAL_INT(CFGetRetainCount(element), before + 2);
        field.axElement = NULL;
        GH_ASSERT_EQUAL_INT(CFGetRetainCount(element), before + 1);
    }
    GH_ASSERT_EQUAL_INT(CFGetRetainCount(element), before);
    CFRelease(element);
}

#pragma mark - GHLog

GH_TEST(log_writes_private_file_and_masks_labels) {
    NSString *previous = GHLogPath();
    NSString *path = [GHTestTempDirectory() stringByAppendingPathComponent:@"logs/desktop.log"];
    GHLogSetPath(path);
    GHLog(@"test: ghost for label=%@", GHLogLabel(@"First name"));
    GHLog(@"test: label=%@", GHLogLabel(@"Card number"));
    GHLog(@"test: label=%@", GHLogLabel(@"A very long label that goes on and on well past the forty character limit"));
    GHLogFlush();
    NSString *text = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:NULL];
    GHLogSetPath(previous);
    GH_ASSERT([text containsString:@"label=First name"]);
    GH_ASSERT([text containsString:@"label=[sensitive]"]);
    GH_ASSERT_FALSE([text containsString:@"Card number"]);
    GH_ASSERT_FALSE([text containsString:@"forty character limit"]);
    GH_ASSERT_EQUAL_INT([[text componentsSeparatedByString:@"\n"] count], 4);
    NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:path error:NULL];
    GH_ASSERT_EQUAL_INT([attributes[NSFilePosixPermissions] intValue], 0600);
    GH_ASSERT_EQUAL_OBJECTS(GHLogLabel(nil), @"(no label)");
}
