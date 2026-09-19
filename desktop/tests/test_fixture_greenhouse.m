// A REAL Greenhouse application (Viam, Software Engineering Intern Summer 2027) captured in Safari with
// `ghostctl dump-tree` and sanitized (values are lengths only, browser chrome removed): replayed through
// GHFakeAXNode -> GHCapture -> the real ghost-core.js, so the real page is a regression test.
// Plus the Desktop core rules it exercises: upload ghosts, lazy selects, EEO questions, another country's
// work authorization. Everything uses the fictional Alex Chen profile and a fictional resume path.
#import "GHTest.h"
#import "GHAXNode.h"
#import "GHCapture.h"
#import "GHCore.h"
#import "GHField.h"

static NSString *const kResumePath = @"/Users/example/Documents/resume-alex-chen.pdf";

static GHCore *FixtureCore(void) {
    static GHCore *core;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSString *path = [GHCore defaultBundlePath];
        core = path ? [[GHCore alloc] initWithBundlePath:path error:NULL] : nil;
    });
    return core;
}

static NSString *FixturePath(NSString *name) {
    return [[@(__FILE__) stringByDeletingLastPathComponent] stringByAppendingPathComponent:[@"fixtures" stringByAppendingPathComponent:name]];
}

/// The fixture as the running controller sees it: the real core as the safety oracle, the whole form kept.
static GHCaptureResult *CaptureGreenhouse(void) {
    GHFakeAXNode *window = [GHFakeAXNode nodeWithDumpTreeFile:FixturePath(@"greenhouse-safari-viam.json")];
    if (!window || !FixtureCore()) return nil;
    GHCapture *capture = [[GHCapture alloc] initWithSafety:FixtureCore()];
    capture.keepsScrolledOutFields = YES;
    capture.clock = ^NSTimeInterval { return 0; }; // a saved tree has no latency: the node budget still applies
    return [capture captureWindow:window];
}

static NSDictionary *ProfileWith(NSDictionary<NSString *, NSString *> *extra) {
    NSMutableDictionary *profile = [[FixtureCore() demoProfile] mutableCopy];
    NSMutableDictionary *facts = [profile[@"facts"] mutableCopy];
    [facts addEntriesFromDictionary:extra];
    profile[@"facts"] = facts;
    return profile;
}

static NSArray<NSString *> *KeysOf(NSDictionary *profile) {
    return [[profile[@"facts"] allKeys] sortedArrayUsingSelector:@selector(compare:)];
}

static NSArray<NSDictionary *> *OfflineGhosts(NSArray<GHField *> *fields, NSDictionary *profile) {
    GHCore *core = FixtureCore();
    NSArray *assignments = [core mapFields:fields factKeys:KeysOf(profile)];
    return [core ghostsForFields:fields assignments:assignments profile:profile settings:[core defaultSettings] source:@"offline" options:nil];
}

static NSDictionary<NSString *, NSString *> *LabelsBySignature(NSArray<GHField *> *fields) {
    NSMutableDictionary *labels = [NSMutableDictionary dictionary];
    for (GHField *field in fields) labels[field.signature] = field.label;
    return labels;
}

static GHField *Labelled(NSArray<GHField *> *fields, NSString *label) {
    for (GHField *field in fields) if ([field.label isEqualToString:label]) return field;
    return nil;
}

static GHField *CoreField(NSString *signature, NSString *label, NSString *kind) {
    GHField *field = [GHField fieldWithSignature:signature label:label kind:kind];
    field.rect = CGRectMake(40, 40, 320, 28);
    field.value = @"";
    return field;
}

static GHField *LazySelect(NSString *signature, NSString *label) {
    GHField *field = CoreField(signature, label, GHKindSelect);
    field.lazyOptions = YES;
    return field;
}

static GHField *Upload(NSString *signature, NSString *label, NSString *_Nullable uploadKind) {
    GHField *field = CoreField(signature, label, GHKindFile);
    field.uploadKind = uploadKind;
    return field;
}

static NSDictionary<NSString *, NSDictionary *> *GhostMap(NSArray<NSDictionary *> *ghosts) {
    NSMutableDictionary *map = [NSMutableDictionary dictionary];
    for (NSDictionary *ghost in ghosts) map[ghost[@"signature"]] = ghost;
    return map;
}

#pragma mark - capture of the real page

GH_TEST(fixture_greenhouse_capture_yields_the_form_in_reading_order) {
    GHCaptureResult *result = CaptureGreenhouse();
    GH_ASSERT_MSG(result != nil, @"fixture or ghost-core.js did not load (DESKTOP_CORE_PATH=%s)", getenv("DESKTOP_CORE_PATH") ?: "(unset)");
    GH_ASSERT(result.sawWebArea);
    GH_ASSERT_FALSE(result.partial);
    GH_ASSERT(result.visitedNodes > 300); // the whole page, not the 17 nodes of the tab-group bug

    NSMutableArray<NSString *> *form = [NSMutableArray array];
    NSMutableArray<NSString *> *kinds = [NSMutableArray array];
    for (GHField *field in result.fields) {
        if ([field.kind isEqualToString:GHKindLink]) continue;
        if ([field.kind isEqualToString:GHKindButton] && [field.label isEqualToString:@"Apply"]) continue; // top of the page
        [form addObject:field.label];
        [kinds addObject:field.kind];
    }
    NSArray *expected = @[
        @"First Name", @"Last Name", @"Email", @"Country", @"Phone", @"Resume/CV", @"Cover Letter",
        @"LinkedIn Profile", @"Github", @"Website",
        @"How did you hear about this opportunity at Viam?",
        @"Are you legally authorized to work in the United States for any employer?",
        @"Gender", @"Are you Hispanic/Latino?", @"Veteran Status", @"Disability Status",
        @"Submit application",
    ];
    GH_ASSERT_EQUAL_OBJECTS(form, expected);
    NSArray *expectedKinds = @[
        GHKindText, GHKindText, GHKindEmail, GHKindSelect, GHKindTel, GHKindFile, GHKindFile,
        GHKindURL, GHKindURL, GHKindURL, GHKindSelect, GHKindSelect,
        GHKindSelect, GHKindSelect, GHKindSelect, GHKindSelect, GHKindButton,
    ];
    GH_ASSERT_EQUAL_OBJECTS(kinds, expectedKinds);

    NSArray<GHField *> *fields = result.fields;
    GH_ASSERT(Labelled(fields, @"Submit application").locked);
    GH_ASSERT(Labelled(fields, @"Apply").locked); // captured and locked, but never a ghost (see below)
    GH_ASSERT_EQUAL_OBJECTS(Labelled(fields, @"First Name").identifier, @"first_name");
    GH_ASSERT_EQUAL_OBJECTS(Labelled(fields, @"Phone").inputType, @"tel");
    for (NSString *label in @[ @"Country", @"How did you hear about this opportunity at Viam?", @"Gender", @"Disability Status" ]) {
        GHField *select = Labelled(fields, label);
        GH_ASSERT_MSG(select.lazyOptions && select.options == nil, @"%@ should be a lazy select", label);
        GH_ASSERT_MSG(select.rect.size.width > 100, @"%@ should have the visible box, not the 4 px input", label);
    }
    GHField *resume = Labelled(fields, @"Resume/CV");
    GH_ASSERT_EQUAL_OBJECTS(resume.uploadKind, GHUploadKindResume);
    GH_ASSERT_EQUAL_OBJECTS(resume.identifier, @"resume");
    GH_ASSERT_EQUAL_OBJECTS([(GHFakeAXNode *)[result nodeForSignature:resume.signature] title], @"Attach");
    GH_ASSERT_EQUAL_OBJECTS([result uploadNodeForSignature:resume.signature].identifier, @"resume");
    GH_ASSERT_EQUAL_OBJECTS(Labelled(fields, @"Cover Letter").uploadKind, GHUploadKindCoverLetter);

    // What never becomes a field: the combo boxes' toggles, the upload alternatives, Greenhouse's own autofill.
    for (NSString *absent in @[ @"Toggle flyout", @"Attach", @"Dropbox", @"Google Drive", @"Enter manually", @"Autofill my application" ]) {
        GH_ASSERT_MSG(Labelled(fields, absent) == nil, @"%@ must not be a field", absent);
    }
    // No private text leaves through a dump either: labels only, never a value.
    NSData *wire = [NSJSONSerialization dataWithJSONObject:[GHField wireJSONObjectsForFields:fields] options:0 error:NULL];
    NSString *json = [[NSString alloc] initWithData:wire encoding:NSUTF8StringEncoding];
    GH_ASSERT_FALSE([json containsString:@"\"value\""]);
}

GH_TEST(fixture_greenhouse_capture_is_stable_across_replays) {
    GHCaptureResult *first = CaptureGreenhouse(), *second = CaptureGreenhouse();
    GH_ASSERT(first != nil && second != nil);
    GH_ASSERT_EQUAL_OBJECTS(first.formSignature, second.formSignature);
    NSMutableArray *a = [NSMutableArray array], *b = [NSMutableArray array];
    for (GHField *field in first.fields) [a addObject:field.signature];
    for (GHField *field in second.fields) [b addObject:field.signature];
    GH_ASSERT_EQUAL_OBJECTS(a, b);
    GH_ASSERT_EQUAL_INT([[NSSet setWithArray:a] count], a.count); // signatures are unique
}

GH_TEST(fixture_greenhouse_budget_still_applies) {
    GHFakeAXNode *window = [GHFakeAXNode nodeWithDumpTreeFile:FixturePath(@"greenhouse-safari-viam.json")];
    GH_ASSERT(window != nil && FixtureCore() != nil);
    GHCapture *capture = [[GHCapture alloc] initWithSafety:FixtureCore()];
    capture.keepsScrolledOutFields = YES;
    capture.clock = ^NSTimeInterval { return 0; };
    capture.limits.maxNodes = 40; // stops inside the job description, long before the form
    GHCaptureResult *result = [capture captureWindow:window];
    GH_ASSERT(result.partial);
    GH_ASSERT_EQUAL_INT(result.stop, GHCaptureStopNodes);
    GH_ASSERT_EQUAL_INT(result.visitedNodes, 40);
    GH_ASSERT(Labelled(result.fields, @"First Name") == nil);
}

#pragma mark - ghosts for the real page

GH_TEST(fixture_greenhouse_ghosts_for_alex_chen_with_a_resume) {
    GHCaptureResult *result = CaptureGreenhouse();
    GH_ASSERT(result != nil);
    NSDictionary *profile = ProfileWith(@{ @"resumePath": kResumePath });
    NSArray<NSDictionary *> *ghosts = OfflineGhosts(result.fields, profile);
    NSDictionary<NSString *, NSString *> *labels = LabelsBySignature(result.fields);
    NSMutableArray<NSString *> *order = [NSMutableArray array];
    NSMutableDictionary<NSString *, NSDictionary *> *byLabel = [NSMutableDictionary dictionary];
    for (NSDictionary *ghost in ghosts) {
        NSString *label = labels[ghost[@"signature"]];
        GH_ASSERT(label != nil);
        [order addObject:label];
        byLabel[label] = ghost;
    }
    NSArray *expected = @[
        @"First Name", @"Last Name", @"Email", @"Country", @"Phone", @"Resume/CV",
        @"LinkedIn Profile", @"Github", @"Website", @"How did you hear about this opportunity at Viam?",
        @"Submit application",
    ];
    GH_ASSERT_EQUAL_OBJECTS(order, expected);

    NSDictionary *facts = profile[@"facts"];
    GH_ASSERT_EQUAL_OBJECTS(byLabel[@"First Name"][@"value"], facts[@"firstName"]);
    GH_ASSERT_EQUAL_OBJECTS(byLabel[@"Last Name"][@"value"], facts[@"lastName"]);
    GH_ASSERT_EQUAL_OBJECTS(byLabel[@"Email"][@"value"], facts[@"email"]);
    GH_ASSERT_EQUAL_OBJECTS(byLabel[@"Phone"][@"value"], facts[@"phone"]);
    GH_ASSERT_EQUAL_OBJECTS(byLabel[@"LinkedIn Profile"][@"value"], facts[@"linkedin"]);
    GH_ASSERT_EQUAL_OBJECTS(byLabel[@"Github"][@"value"], facts[@"github"]);
    GH_ASSERT_EQUAL_OBJECTS(byLabel[@"Website"][@"value"], facts[@"website"]);

    NSDictionary *upload = byLabel[@"Resume/CV"];
    GH_ASSERT_EQUAL_OBJECTS(upload[@"action"], @"upload");
    GH_ASSERT_EQUAL_OBJECTS(upload[@"value"], kResumePath);
    GH_ASSERT_EQUAL_OBJECTS(upload[@"displayText"], @"resume-alex-chen.pdf"); // the file name only
    GH_ASSERT(fabs([upload[@"confidence"] doubleValue] - 0.9) < 1e-9);

    NSDictionary *country = byLabel[@"Country"];
    GH_ASSERT_EQUAL_OBJECTS(country[@"action"], @"select");
    GH_ASSERT_EQUAL_OBJECTS(country[@"displayText"], @"Canada");
    GH_ASSERT_EQUAL_OBJECTS(country[@"lazy"], @YES);
    NSDictionary *referral = byLabel[@"How did you hear about this opportunity at Viam?"];
    GH_ASSERT_EQUAL_OBJECTS(referral[@"displayText"], @"Hack the North");
    GH_ASSERT_EQUAL_OBJECTS(referral[@"value"], @"Hack the North");
    GH_ASSERT_EQUAL_OBJECTS(referral[@"lazy"], @YES);

    // The profile covers Canada only: the US work-authorization question is left to the applicant.
    GH_ASSERT(byLabel[@"Are you legally authorized to work in the United States for any employer?"] == nil);
    for (NSString *eeo in @[ @"Gender", @"Are you Hispanic/Latino?", @"Veteran Status", @"Disability Status" ]) {
        GH_ASSERT_MSG(byLabel[eeo] == nil, @"EEO question %@ must never get a ghost", eeo);
    }
    GH_ASSERT(byLabel[@"Cover Letter"] == nil); // no coverLetterPath in the profile
    GH_ASSERT(byLabel[@"Apply"] == nil);

    NSDictionary *lock = ghosts.lastObject;
    GH_ASSERT_EQUAL_OBJECTS(labels[lock[@"signature"]], @"Submit application");
    GH_ASSERT_EQUAL_OBJECTS(lock[@"locked"], @YES);
    GH_ASSERT_EQUAL_OBJECTS(lock[@"action"], @"click");
    for (NSDictionary *ghost in ghosts) if (ghost != lock) GH_ASSERT_EQUAL_OBJECTS(ghost[@"locked"], @NO);
}

GH_TEST(fixture_greenhouse_without_a_resume_path_offers_no_upload) {
    GHCaptureResult *result = CaptureGreenhouse();
    GH_ASSERT(result != nil);
    NSArray<NSDictionary *> *ghosts = OfflineGhosts(result.fields, [FixtureCore() demoProfile]);
    NSDictionary<NSString *, NSString *> *labels = LabelsBySignature(result.fields);
    for (NSDictionary *ghost in ghosts) {
        GH_ASSERT_FALSE([ghost[@"action"] isEqualToString:@"upload"]);
        GH_ASSERT_FALSE([labels[ghost[@"signature"]] isEqualToString:@"Resume/CV"]);
    }
    GH_ASSERT_EQUAL_INT(ghosts.count, 10); // the 9 personal / choice ghosts + the lock
}

GH_TEST(fixture_greenhouse_server_answers_cannot_reach_eeo_or_another_country) {
    GHCaptureResult *result = CaptureGreenhouse();
    GH_ASSERT(result != nil);
    GHCore *core = FixtureCore();
    NSDictionary *profile = ProfileWith(@{ @"resumePath": kResumePath });
    NSMutableArray *served = [NSMutableArray array];
    for (GHField *field in result.fields) {
        NSString *fact = nil;
        if ([@[ @"Gender", @"Are you Hispanic/Latino?", @"Veteran Status", @"Disability Status" ] containsObject:field.label]) fact = @"firstName";
        if ([field.label hasPrefix:@"Are you legally authorized"]) fact = @"workAuthorization";
        if ([field.label isEqualToString:@"Website"]) fact = @"resumePath"; // a path never lands in a text field
        if ([field.label isEqualToString:@"Cover Letter"]) fact = @"email"; // an upload only takes a path
        if (fact) [served addObject:@{ @"signature": field.signature, @"factKey": fact, @"confidence": @0.99, @"calibrated": @YES }];
    }
    NSArray *ghosts = [core upgradeGhostsForFields:result.fields served:served profile:profile settings:[core defaultSettings] source:@"server" options:nil];
    NSDictionary<NSString *, NSString *> *labels = LabelsBySignature(result.fields);
    NSMutableSet<NSString *> *ghosted = [NSMutableSet set];
    for (NSDictionary *ghost in ghosts) [ghosted addObject:labels[ghost[@"signature"]]];
    for (NSString *never in @[ @"Gender", @"Are you Hispanic/Latino?", @"Veteran Status", @"Disability Status", @"Website", @"Cover Letter",
                               @"Are you legally authorized to work in the United States for any employer?" ]) {
        GH_ASSERT_MSG(![ghosted containsObject:never], @"%@ must stay ghost-less", never);
    }
    GH_ASSERT([ghosted containsObject:@"Resume/CV"]);
    GH_ASSERT([ghosted containsObject:@"First Name"]);
}

GH_TEST(fixture_greenhouse_form_request_leaves_out_eeo_and_file_paths) {
    GHCaptureResult *result = CaptureGreenhouse();
    GH_ASSERT(result != nil);
    NSDictionary *profile = ProfileWith(@{ @"resumePath": kResumePath, @"coverLetterPath": @"/Users/example/Documents/cover.pdf" });
    NSData *body = [FixtureCore() formRequestBodyForFieldObjects:[GHField JSONObjectsForFields:result.fields] factKeys:KeysOf(profile)
                                                          origin:@"https://job-boards.greenhouse.io" formSignature:result.formSignature];
    GH_ASSERT(body != nil);
    NSDictionary *json = [NSJSONSerialization JSONObjectWithData:body options:0 error:NULL];
    NSMutableArray<NSString *> *sent = [NSMutableArray array];
    for (NSDictionary *field in json[@"fields"]) [sent addObject:field[@"label"]];
    GH_ASSERT([sent containsObject:@"First Name"]);
    GH_ASSERT([sent containsObject:@"Country"]);
    for (NSString *never in @[ @"Gender", @"Are you Hispanic/Latino?", @"Veteran Status", @"Disability Status", @"Resume/CV", @"Cover Letter" ]) {
        GH_ASSERT_MSG(![sent containsObject:never], @"%@ must not be sent to the server", never);
    }
    GH_ASSERT_FALSE([json[@"factKeys"] containsObject:@"resumePath"]);
    GH_ASSERT_FALSE([json[@"factKeys"] containsObject:@"coverLetterPath"]);
    NSString *text = [[NSString alloc] initWithData:body encoding:NSUTF8StringEncoding];
    GH_ASSERT_FALSE([text containsString:@"/Users/"]);
}

#pragma mark - core rules, one at a time

GH_TEST(core_upload_ghost_needs_a_usable_absolute_path) {
    GHField *resume = Upload(@"file|resume", @"Resume/CV", GHUploadKindResume);
    GHField *letter = Upload(@"file|letter", @"Cover Letter", GHUploadKindCoverLetter);
    GHField *inferred = Upload(@"file|cv", @"Upload your CV", nil);          // no uploadKind: read from the label
    GHField *either = Upload(@"file|either", @"Resume or cover letter", nil); // which file is a guess
    GHField *other = Upload(@"file|other", @"Transcript", GHUploadKindOther);
    NSArray<GHField *> *fields = @[ resume, letter, inferred, either, other ];

    NSDictionary *profile = ProfileWith(@{ @"resumePath": kResumePath, @"coverLetterPath": @"/Users/example/Letters/Cover Letter.docx" });
    NSDictionary *map = GhostMap(OfflineGhosts(fields, profile));
    GH_ASSERT_EQUAL_OBJECTS(map[@"file|resume"][@"displayText"], @"resume-alex-chen.pdf");
    GH_ASSERT_EQUAL_OBJECTS(map[@"file|letter"][@"action"], @"upload");
    GH_ASSERT_EQUAL_OBJECTS(map[@"file|letter"][@"displayText"], @"Cover Letter.docx");
    GH_ASSERT_EQUAL_OBJECTS(map[@"file|cv"][@"value"], kResumePath);
    GH_ASSERT(map[@"file|either"] == nil);
    GH_ASSERT(map[@"file|other"] == nil);

    // An upload that already holds a file is never offered again.
    resume.value = @"old-resume.pdf";
    GH_ASSERT(GhostMap(OfflineGhosts(@[ resume ], profile))[@"file|resume"] == nil);
    resume.value = @"";

    for (NSString *bad in @[ @"resume-alex-chen.pdf", @"~/resume.pdf", @"/Users/example/../../etc/resume.pdf", @"/Users/example/resume.exe",
                             @"/Users/example/resume\n.pdf", @"/Users/example/resume.pdf\r" ]) {
        NSDictionary *broken = ProfileWith(@{ @"resumePath": bad });
        GH_ASSERT_MSG(GhostMap(OfflineGhosts(@[ resume ], broken))[@"file|resume"] == nil, @"path of length %lu must be refused", (unsigned long)bad.length);
    }
    // The mapping itself only names the file facts when the profile has them.
    NSArray *assignments = [FixtureCore() mapFields:@[ resume ] factKeys:@[ @"firstName" ]];
    GH_ASSERT_EQUAL_OBJECTS(assignments.firstObject[@"factKey"], @"none");
}

GH_TEST(core_lazy_select_carries_the_intended_answer) {
    GHField *country = LazySelect(@"sel|country", @"Country");
    GHField *heard = LazySelect(@"sel|heard", @"How did you hear about us?");
    GHField *canada = LazySelect(@"sel|auth-ca", @"Are you legally authorized to work in Canada?");
    GHField *graduation = LazySelect(@"sel|grad", @"Expected graduation date");
    GHField *chosen = LazySelect(@"sel|chosen", @"Current country");
    chosen.value = @"Canada"; // react-select shows a chosen value: filled
    NSDictionary *map = GhostMap(OfflineGhosts(@[ country, heard, canada, graduation, chosen ], [FixtureCore() demoProfile]));
    GH_ASSERT_EQUAL_OBJECTS(map[@"sel|country"][@"value"], @"Canada");
    GH_ASSERT_EQUAL_OBJECTS(map[@"sel|country"][@"lazy"], @YES);
    GH_ASSERT_EQUAL_OBJECTS(map[@"sel|heard"][@"displayText"], @"Hack the North");
    GH_ASSERT_EQUAL_OBJECTS(map[@"sel|auth-ca"][@"displayText"], @"Yes"); // yes/no facts read as the option they pick
    GH_ASSERT(map[@"sel|grad"] == nil);   // a date's option format is unknown until the list opens
    GH_ASSERT(map[@"sel|chosen"] == nil);
    GH_ASSERT([map[@"sel|country"][@"confidence"] doubleValue] < 0.9); // unverified options cost confidence

    // A select whose options ARE known keeps the exact shared matching and is not lazy.
    GHField *known = CoreField(@"sel|known", @"Country", GHKindSelect);
    known.options = @[ @{ @"value": @"", @"label": @"Select..." }, @{ @"value": @"CA", @"label": @"Canada" } ];
    known.lazyOptions = YES;
    NSDictionary *exact = GhostMap(OfflineGhosts(@[ known ], [FixtureCore() demoProfile]))[@"sel|known"];
    GH_ASSERT_EQUAL_OBJECTS(exact[@"value"], @"CA");
    GH_ASSERT(exact[@"lazy"] == nil);
}

GH_TEST(core_work_authorization_speaks_for_the_profiles_country_only) {
    NSArray<NSString *> *elsewhere = @[
        @"Are you legally authorized to work in the United States for any employer?",
        @"Are you authorized to work in the U.S.?",
        @"Are you legally eligible to work in the US or Canada?", // two countries: which one is a guess
        @"Do you have the right to work in the UK?",
        @"Will you require visa sponsorship to work in the United States?",
    ];
    NSArray<NSString *> *home = @[ @"Are you legally authorized to work in Canada?", @"Are you legally eligible to work for us?" ];
    NSMutableArray<GHField *> *fields = [NSMutableArray array];
    NSUInteger index = 0;
    for (NSString *label in [elsewhere arrayByAddingObjectsFromArray:home]) {
        GHField *field = CoreField([NSString stringWithFormat:@"q|%lu", (unsigned long)index++], label, GHKindRadio);
        field.options = @[ @{ @"value": @"Yes", @"label": @"Yes" }, @{ @"value": @"No", @"label": @"No" } ];
        [fields addObject:field];
    }
    NSDictionary *map = GhostMap(OfflineGhosts(fields, [FixtureCore() demoProfile]));
    for (NSUInteger i = 0; i < elsewhere.count; i++) {
        GH_ASSERT_MSG(map[fields[i].signature] == nil, @"%@ must not be answered for a Canadian profile", elsewhere[i]);
    }
    GH_ASSERT_EQUAL_OBJECTS(map[fields[elsewhere.count].signature][@"value"], @"Yes");
    GH_ASSERT_EQUAL_OBJECTS(map[fields[elsewhere.count + 1].signature][@"value"], @"Yes"); // "us" is a pronoun

    // A US profile answers the US question and not the Canadian one.
    NSDictionary *american = GhostMap(OfflineGhosts(fields, ProfileWith(@{ @"country": @"United States" })));
    GH_ASSERT_EQUAL_OBJECTS(american[fields[0].signature][@"value"], @"Yes");
    GH_ASSERT_EQUAL_OBJECTS(american[fields[1].signature][@"value"], @"Yes");
    GH_ASSERT(american[fields[elsewhere.count].signature] == nil);
}

GH_TEST(core_eeo_questions_never_get_a_ghost) {
    NSArray<NSString *> *questions = @[ @"Gender", @"Are you Hispanic/Latino?", @"Race", @"Veteran Status", @"Disability Status",
                                        @"Pronouns", @"Sexual orientation", @"Date of birth", @"What is your age?" ];
    NSMutableArray<GHField *> *fields = [NSMutableArray array];
    NSMutableArray *served = [NSMutableArray array];
    NSUInteger index = 0;
    for (NSString *label in questions) {
        GHField *field = CoreField([NSString stringWithFormat:@"eeo|%lu", (unsigned long)index++], label, GHKindText);
        [fields addObject:field];
        [served addObject:@{ @"signature": field.signature, @"factKey": @"firstName", @"confidence": @0.99, @"calibrated": @YES }];
    }
    // A question in the self-identification section is protected by its section even with a bland label.
    GHField *inSection = CoreField(@"eeo|section", @"Please select one", GHKindText);
    inSection.context = @"Voluntary Self-Identification";
    [fields addObject:inSection];
    [served addObject:@{ @"signature": inSection.signature, @"factKey": @"city", @"confidence": @0.99, @"calibrated": @YES }];
    GHField *first = CoreField(@"txt|first", @"First name", GHKindText);
    [fields addObject:first];

    GHCore *core = FixtureCore();
    NSDictionary *profile = [core demoProfile];
    for (NSDictionary *assignment in [core mapFields:fields factKeys:KeysOf(profile)]) {
        if (![assignment[@"signature"] isEqualToString:@"txt|first"]) GH_ASSERT_EQUAL_OBJECTS(assignment[@"factKey"], @"none");
    }
    NSArray *direct = [core ghostsForFields:fields assignments:served profile:profile settings:[core defaultSettings] source:@"server" options:nil];
    NSArray *upgraded = [core upgradeGhostsForFields:fields served:served profile:profile settings:[core defaultSettings] source:@"server" options:nil];
    GH_ASSERT_EQUAL_INT(direct.count, 0);
    GH_ASSERT_EQUAL_INT(upgraded.count, 1);
    GH_ASSERT_EQUAL_OBJECTS([upgraded.firstObject objectForKey:@"signature"], @"txt|first");
}

GH_TEST(core_demographic_answers_and_facts_are_never_offered_whatever_the_question_says) {
    GHCore *core = FixtureCore();
    NSMutableDictionary *profile = [[core demoProfile] mutableCopy];
    NSMutableDictionary *facts = [profile[@"facts"] mutableCopy];
    facts[@"gender"] = @"Woman";                 // a profile that happens to hold demographic facts
    facts[@"veteranStatus"] = @"No";
    facts[@"dateOfBirth"] = @"2004-02-29";
    profile[@"facts"] = facts;

    // A bland question in a titled group, recognisable only by what it offers.
    GHField *identify = CoreField(@"sel|identify", @"How do you identify?", GHKindSelect);
    identify.options = @[ @{ @"value": @"", @"label": @"Select..." }, @{ @"value": @"man", @"label": @"Man" },
                          @{ @"value": @"woman", @"label": @"Woman" }, @{ @"value": @"nb", @"label": @"Non-binary" } ];
    identify.value = @"";
    GHField *service = CoreField(@"sel|service", @"Have you served?", GHKindSelect);
    service.options = @[ @{ @"value": @"a", @"label": @"I am a protected veteran" }, @{ @"value": @"b", @"label": @"I am not a protected veteran" } ];
    service.value = @"";
    // A free-text question the server maps to a demographic fact.
    GHField *born = CoreField(@"txt|born", @"When were you born?", GHKindText);
    // A country list with "Isle of Man" is NOT demographic.
    GHField *country = CoreField(@"sel|country", @"Country", GHKindSelect);
    country.options = @[ @{ @"value": @"", @"label": @"Select..." }, @{ @"value": @"IM", @"label": @"Isle of Man" }, @{ @"value": @"CA", @"label": @"Canada" } ];
    country.value = @"";
    NSArray<GHField *> *fields = @[ identify, service, born, country ];
    NSArray *served = @[
        @{ @"signature": identify.signature, @"factKey": @"gender", @"confidence": @0.99, @"calibrated": @YES },
        @{ @"signature": service.signature, @"factKey": @"veteranStatus", @"confidence": @0.99, @"calibrated": @YES },
        @{ @"signature": born.signature, @"factKey": @"dateOfBirth", @"confidence": @0.99, @"calibrated": @YES },
    ];
    NSArray *ghosts = [core upgradeGhostsForFields:fields served:served profile:profile settings:[core defaultSettings] source:@"server" options:nil];
    NSArray<NSString *> *protectedSignatures = @[ identify.signature, service.signature, born.signature ];
    for (NSDictionary *ghost in ghosts) {
        GH_ASSERT_MSG(![protectedSignatures containsObject:ghost[@"signature"]], @"%@ got a ghost", ghost[@"signature"]);
    }
    NSArray *direct = [core ghostsForFields:fields assignments:served profile:profile settings:[core defaultSettings] source:@"server" options:nil];
    GH_ASSERT_EQUAL_INT(direct.count, 0);
    for (NSDictionary *assignment in [core mapFields:fields factKeys:[facts.allKeys sortedArrayUsingSelector:@selector(compare:)]]) {
        if (![assignment[@"signature"] isEqualToString:country.signature]) GH_ASSERT_EQUAL_OBJECTS(assignment[@"factKey"], @"none");
    }

    // The server is not asked about them, and never offered the demographic facts as possible answers.
    NSMutableArray *objects = [NSMutableArray array];
    for (GHField *field in fields) [objects addObject:[field toWireJSONObject]];
    NSData *body = [core formRequestBodyForFieldObjects:objects factKeys:[facts.allKeys sortedArrayUsingSelector:@selector(compare:)]
                                                 origin:@"app://com.apple.Safari/example.com" formSignature:@"eeo-form"];
    NSDictionary *json = body ? [NSJSONSerialization JSONObjectWithData:body options:0 error:NULL] : nil;
    GH_ASSERT(json != nil);
    NSMutableArray *asked = [NSMutableArray array];
    for (NSDictionary *field in json[@"fields"]) [asked addObject:field[@"signature"]];
    GH_ASSERT_FALSE([asked containsObject:identify.signature]);
    GH_ASSERT_FALSE([asked containsObject:service.signature]);
    GH_ASSERT([asked containsObject:country.signature]);
    for (NSString *key in @[ @"gender", @"veteranStatus", @"dateOfBirth" ]) GH_ASSERT_FALSE([json[@"factKeys"] containsObject:key]);
    GH_ASSERT([json[@"factKeys"] containsObject:@"firstName"]);
}

#pragma mark - GHField

GH_TEST(field_json_round_trips_upload_kind_and_lazy_options) {
    GHField *field = Upload(@"file|resume", @"Resume/CV", GHUploadKindResume);
    GHField *select = LazySelect(@"sel|country", @"Country");
    GH_ASSERT_EQUAL_OBJECTS([field toJSONObject][@"uploadKind"], @"resume");
    GH_ASSERT([select toJSONObject][@"uploadKind"] == nil);
    GH_ASSERT([field toJSONObject][@"lazyOptions"] == nil);
    GH_ASSERT_EQUAL_OBJECTS([select toWireJSONObject][@"lazyOptions"], @YES);
    GHField *back = [GHField fieldFromJSONObject:[field toJSONObject]];
    GH_ASSERT_EQUAL_OBJECTS(back.uploadKind, GHUploadKindResume);
    GH_ASSERT([GHField fieldFromJSONObject:[select toJSONObject]].lazyOptions);
    GHField *copy = [select copy];
    GH_ASSERT(copy.lazyOptions);
    GH_ASSERT_EQUAL_OBJECTS(((GHField *)[field copy]).uploadKind, GHUploadKindResume);
    GH_ASSERT_FALSE([GHField fieldFromJSONObject:@{ @"signature": @"s", @"lazyOptions": @"yes" }].lazyOptions);
}
