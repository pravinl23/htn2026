// A REAL Greenhouse application (Viam, Software Engineering Intern Summer 2027) captured in Safari with
// `ghostctl dump-tree` and sanitized (values are lengths only, browser chrome removed): replayed through
// GHFakeAXNode -> GHCapture -> the real ghost-core.js, so the real page is a regression test.
// Plus the Desktop core rules it exercises: upload ghosts, lazy selects, and the shared answer engine's verdict
// on the EEO questions and on another country's work authorization (docs/answers.md), under the shared gate
// (docs/incremental.md). Everything uses the fictional Alex Chen profile and a fictional resume path.
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
    // EVERY question on the page gets a ghost, in reading order. What is missing is the Submit: the page marks
    // the work-authorization question required (AXRequired) and it is not answered yet, so the gate withholds it.
    NSArray *expected = @[
        @"First Name", @"Last Name", @"Email", @"Country", @"Phone", @"Resume/CV",
        @"LinkedIn Profile", @"Github", @"Website", @"How did you hear about this opportunity at Viam?",
        @"Are you legally authorized to work in the United States for any employer?",
        @"Gender", @"Are you Hispanic/Latino?", @"Veteran Status", @"Disability Status",
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
    // The live list is LinkedIn / Indeed / A friend / TikTok / Instagram / Twitter / Meetup-Event / Other, which
    // does not offer "Hack the North" at all. An ordinary question is still answered: the list's own neutral
    // option (docs/answers.md section 3). Country is ordinary too, and its own name wins there.
    GH_ASSERT_EQUAL_OBJECTS(referral[@"lazyMatch"], @"neutral");
    GH_ASSERT_EQUAL_OBJECTS(country[@"lazyMatch"], @"neutral");
    // A declaration has no neutral side: its answer is matched literally against Yes / No.
    GH_ASSERT_EQUAL_OBJECTS(byLabel[@"Are you legally authorized to work in the United States for any employer?"][@"lazyMatch"], @"text");

    // The profile covers Canada only. The US question is answered with the conservative inference -- "No", the
    // side that claims the least -- as a VISIBLE guess that hold-Tab will not take (docs/answers.md section 1).
    NSDictionary *usAuth = byLabel[@"Are you legally authorized to work in the United States for any employer?"];
    GH_ASSERT(usAuth != nil);
    GH_ASSERT_EQUAL_OBJECTS(usAuth[@"displayText"], @"No");
    GH_ASSERT_EQUAL_OBJECTS(usAuth[@"guess"], @YES);
    GH_ASSERT_EQUAL_OBJECTS(usAuth[@"needsReview"], @YES);
    GH_ASSERT_EQUAL_OBJECTS(usAuth[@"answerClass"], @"declaration");
    GH_ASSERT_EQUAL_OBJECTS(usAuth[@"answerSource"], @"guess");
    GH_ASSERT_EQUAL_OBJECTS(usAuth[@"lazy"], @YES);

    // The four EEO questions are answered with the form's OWN way of declining: a true answer for anyone, and
    // never a characteristic Ghost invented. The option list does not exist yet, so the ghost says "match
    // whichever option MEANS decline" rather than this exact wording.
    for (NSString *eeo in @[ @"Gender", @"Are you Hispanic/Latino?", @"Veteran Status", @"Disability Status" ]) {
        NSDictionary *ghost = byLabel[eeo];
        GH_ASSERT_MSG(ghost != nil, @"EEO question %@ must be answered with a decline", eeo);
        GH_ASSERT_EQUAL_OBJECTS(ghost[@"answerClass"], @"protected");
        GH_ASSERT_EQUAL_OBJECTS(ghost[@"answerSource"], @"fact");   // declining is not a guess about anybody
        GH_ASSERT_EQUAL_OBJECTS(ghost[@"lazyMatch"], @"decline");
        // Sourced as a fact, but at 0.8 it is under the confident tier, so it wears a "check this" chip and
        // a held accept key stops on it (docs/always-propose.md).
        GH_ASSERT_EQUAL_OBJECTS(ghost[@"tier"], @"guess");
    }
    GH_ASSERT(byLabel[@"Cover Letter"] == nil); // no coverLetterPath in the profile
    GH_ASSERT(byLabel[@"Apply"] == nil);

    // No Submit ghost while a required field is unanswered, and the gate says why.
    GH_ASSERT(byLabel[@"Submit application"] == nil);
    for (NSDictionary *ghost in ghosts) GH_ASSERT_EQUAL_OBJECTS(ghost[@"locked"], @NO);
    NSArray<NSDictionary *> *fieldObjects = [GHField JSONObjectsForFields:result.fields];
    NSDictionary *gate = [FixtureCore() gateForFieldObjects:fieldObjects ghosts:ghosts accepted:@[]];
    GH_ASSERT_EQUAL_OBJECTS(gate[@"terminalAllowed"], @NO);
    GH_ASSERT_EQUAL_OBJECTS(gate[@"firstUnmetLabel"], @"First Name");
    GH_ASSERT_EQUAL_INT([gate[@"unmetRequired"] count], 4);   // First Name, Last Name, Email, US work authorization
}

GH_TEST(fixture_greenhouse_submit_is_gated_until_every_required_field_is_answered) {
    GHCaptureResult *result = CaptureGreenhouse();
    GH_ASSERT(result != nil);
    GHCore *core = FixtureCore();
    NSDictionary *profile = ProfileWith(@{ @"resumePath": kResumePath });
    NSArray<NSDictionary *> *fieldObjects = [GHField JSONObjectsForFields:result.fields];

    // What the sanitized Safari tree exposes as required: three text fields and the work-authorization question.
    NSMutableArray<NSString *> *required = [NSMutableArray array];
    for (GHField *field in result.fields) if (field.required) [required addObject:field.label];
    GH_ASSERT_EQUAL_OBJECTS(required, (@[ @"First Name", @"Last Name", @"Email",
                                          @"Are you legally authorized to work in the United States for any employer?" ]));

    // A pending ghost meets nothing: holding Tab can never unlock Submit through a guess.
    NSArray<NSDictionary *> *ghosts = OfflineGhosts(result.fields, profile);
    NSDictionary *labels = LabelsBySignature(result.fields);
    for (NSDictionary *ghost in ghosts) GH_ASSERT_FALSE([labels[ghost[@"signature"]] isEqualToString:@"Submit application"]);

    // The user takes each of them: with the last one accepted, the Submit ghost appears, parked and locked.
    NSMutableArray<NSString *> *accepted = [NSMutableArray array];
    for (GHField *field in result.fields) if (field.required) [accepted addObject:field.signature];
    for (NSUInteger taken = 0; taken < accepted.count; taken++) {
        NSArray *some = [accepted subarrayWithRange:NSMakeRange(0, taken)];
        NSDictionary *gate = [core gateForFieldObjects:fieldObjects ghosts:ghosts accepted:some];
        GH_ASSERT_MSG([gate[@"terminalAllowed"] boolValue] == NO, @"Submit was allowed with %lu of %lu answered",
                      (unsigned long)taken, (unsigned long)accepted.count);
    }
    NSDictionary *open = [core gateForFieldObjects:fieldObjects ghosts:ghosts accepted:accepted];
    GH_ASSERT_EQUAL_OBJECTS(open[@"terminalAllowed"], @YES);
    GH_ASSERT(open[@"reason"] == nil);

    NSArray *assignments = [core mapFields:result.fields factKeys:KeysOf(profile)];
    NSArray<NSDictionary *> *final = [core ghostsForFields:result.fields assignments:assignments profile:profile
                                                  settings:[core defaultSettings] source:@"offline"
                                                   options:@{ @"accepted": accepted }];
    NSDictionary *lock = final.lastObject;
    GH_ASSERT_EQUAL_OBJECTS(labels[lock[@"signature"]], @"Submit application");
    GH_ASSERT_EQUAL_OBJECTS(lock[@"locked"], @YES);
    GH_ASSERT_EQUAL_OBJECTS(lock[@"action"], @"click");
}

GH_TEST(fixture_greenhouse_a_correction_changes_the_next_proposal) {
    GHCaptureResult *result = CaptureGreenhouse();
    GH_ASSERT(result != nil);
    GHCore *core = FixtureCore();
    NSDictionary *profile = ProfileWith(@{ @"resumePath": kResumePath });
    GHField *usAuth = Labelled(result.fields, @"Are you legally authorized to work in the United States for any employer?");
    GH_ASSERT(usAuth != nil);

    // Before: the conservative guess.
    NSArray<NSDictionary *> *before = [core proposeAnswersForFieldObjects:@[ [usAuth toJSONObject] ] profile:profile
                                                                  answers:@"" settings:[core defaultSettings]];
    GH_ASSERT_EQUAL_INT(before.count, 1);
    GH_ASSERT_EQUAL_OBJECTS(before.firstObject[@"source"], @"guess");
    GH_ASSERT_EQUAL_OBJECTS(before.firstObject[@"value"], @"No");

    // The user says Yes once. It is learned, keyed by the QUESTION, and never sent anywhere.
    NSDictionary *learned = [core recordCorrectionForFieldObject:[usAuth toJSONObject] value:@"Yes" answers:@"" at:nil];
    GH_ASSERT_EQUAL_OBJECTS(learned[@"changed"], @"added");
    GH_ASSERT_EQUAL_OBJECTS(learned[@"counter"], @"answer.corrected.declaration");
    NSString *answersJSON = GHJSONString(learned[@"answers"]);
    GH_ASSERT(answersJSON != nil);

    // After: the same question is answered "Yes", from the correction, and it is no longer a guess.
    NSArray<NSDictionary *> *after = [core proposeAnswersForFieldObjects:@[ [usAuth toJSONObject] ] profile:profile
                                                                 answers:answersJSON settings:[core defaultSettings]];
    GH_ASSERT_EQUAL_OBJECTS(after.firstObject[@"source"], @"learned");
    GH_ASSERT_EQUAL_OBJECTS(after.firstObject[@"value"], @"Yes");
    GH_ASSERT_EQUAL_OBJECTS(after.firstObject[@"needsReview"], @NO);

    // And the walk itself shows it: no guess badge on that ghost any more.
    NSArray *assignments = [core mapFields:result.fields factKeys:KeysOf(profile)];
    NSArray<NSDictionary *> *ghosts = [core ghostsForFields:result.fields assignments:assignments profile:profile
                                                   settings:[core defaultSettings] source:@"offline"
                                                    options:@{ @"answers": answersJSON }];
    for (NSDictionary *ghost in ghosts) {
        if (![ghost[@"signature"] isEqualToString:usAuth.signature]) continue;
        GH_ASSERT_EQUAL_OBJECTS(ghost[@"displayText"], @"Yes");
        // The user's own answer, not an inference: what changed is the SOURCE, not how loud it is drawn.
        GH_ASSERT_EQUAL_OBJECTS(ghost[@"answerSource"], @"learned");
    }

    // A secret is never learned, whatever the user typed.
    GHField *secret = CoreField(@"txt|card", @"Card number", GHKindText);
    NSDictionary *refused = [core recordCorrectionForFieldObject:[secret toJSONObject] value:@"4111 1111 1111 1111" answers:@"" at:nil];
    GH_ASSERT_EQUAL_OBJECTS(refused[@"changed"], @"refused");
    GH_ASSERT_EQUAL_INT([refused[@"answers"][@"answers"] count], 0);
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
    // 8 personal fields + the referral question + the US work-authorization guess + the four EEO declines.
    // No lock: a required field is still unanswered (see the gate test above).
    GH_ASSERT_EQUAL_INT(ghosts.count, 14);
}

GH_TEST(fixture_greenhouse_server_answers_never_put_a_fact_where_it_does_not_belong) {
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
    NSMutableDictionary<NSString *, NSDictionary *> *byLabel = [NSMutableDictionary dictionary];
    for (NSDictionary *ghost in ghosts) byLabel[labels[ghost[@"signature"]]] = ghost;

    // A path never lands in a text field and an upload only ever takes the path it asks for, whatever a
    // (compromised, confused, or simply wrong) server says.
    GH_ASSERT(byLabel[@"Website"] == nil);
    GH_ASSERT(byLabel[@"Cover Letter"] == nil);
    // A protected question is answered by the local rules alone: the server's "put the first name here" is
    // ignored, and the answer stays the form's own way of declining.
    for (NSString *eeo in @[ @"Gender", @"Are you Hispanic/Latino?", @"Veteran Status", @"Disability Status" ]) {
        NSDictionary *ghost = byLabel[eeo];
        GH_ASSERT_MSG(ghost != nil, @"%@ should be declined", eeo);
        GH_ASSERT_EQUAL_OBJECTS(ghost[@"answerClass"], @"protected");
        GH_ASSERT_EQUAL_OBJECTS(ghost[@"lazyMatch"], @"decline");
        GH_ASSERT_FALSE([ghost[@"displayText"] isEqualToString:profile[@"facts"][@"firstName"]]);
    }
    // Same for a declaration: the server naming `workAuthorization` cannot turn the Canadian profile's "yes"
    // into a claim about the United States. The conservative guess stands.
    NSDictionary *usAuth = byLabel[@"Are you legally authorized to work in the United States for any employer?"];
    GH_ASSERT(usAuth != nil);
    GH_ASSERT_EQUAL_OBJECTS(usAuth[@"displayText"], @"No");
    GH_ASSERT_EQUAL_OBJECTS(usAuth[@"guess"], @YES);
    GH_ASSERT(byLabel[@"Resume/CV"] != nil);
    GH_ASSERT(byLabel[@"First Name"] != nil);
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

GH_TEST(core_work_authorization_answers_another_country_conservatively_and_visibly) {
    // Authorization is a fact about ONE country. The Canadian demo profile says nothing about the United
    // States or the UK, so those questions are answered the way that claims the LEAST -- and every such answer
    // is a visible guess the user is asked to check (docs/answers.md sections 1 and 2).
    NSArray<NSString *> *authorization = @[
        @"Are you legally authorized to work in the United States for any employer?",
        @"Are you authorized to work in the U.S.?",
        @"Do you have the right to work in the UK?",
    ];
    NSString *sponsorship = @"Will you require visa sponsorship to work in the United States?";
    NSArray<NSString *> *home = @[ @"Are you legally authorized to work in Canada?", @"Are you legally eligible to work for us?" ];
    NSMutableArray<GHField *> *fields = [NSMutableArray array];
    NSUInteger index = 0;
    for (NSString *label in [[authorization arrayByAddingObject:sponsorship] arrayByAddingObjectsFromArray:home]) {
        GHField *field = CoreField([NSString stringWithFormat:@"q|%lu", (unsigned long)index++], label, GHKindRadio);
        field.options = @[ @{ @"value": @"Yes", @"label": @"Yes" }, @{ @"value": @"No", @"label": @"No" } ];
        [fields addObject:field];
    }
    NSDictionary *map = GhostMap(OfflineGhosts(fields, [FixtureCore() demoProfile]));
    for (NSUInteger i = 0; i < authorization.count; i++) {
        NSDictionary *ghost = map[fields[i].signature];
        GH_ASSERT_MSG(ghost != nil, @"%@ must still be answered", authorization[i]);
        GH_ASSERT_MSG([ghost[@"value"] isEqualToString:@"No"], @"%@ must be answered conservatively", authorization[i]);
        GH_ASSERT_EQUAL_OBJECTS(ghost[@"guess"], @YES);
        GH_ASSERT_EQUAL_OBJECTS(ghost[@"needsReview"], @YES);
    }
    // Needing sponsorship is the conservative side of the same coin.
    NSDictionary *needsVisa = map[fields[authorization.count].signature];
    GH_ASSERT_EQUAL_OBJECTS(needsVisa[@"value"], @"Yes");
    GH_ASSERT_EQUAL_OBJECTS(needsVisa[@"guess"], @YES);

    // Its own country is a fact, not a guess.
    NSDictionary *canada = map[fields[authorization.count + 1].signature];
    GH_ASSERT_EQUAL_OBJECTS(canada[@"value"], @"Yes");
    GH_ASSERT_EQUAL_OBJECTS(canada[@"answerSource"], @"fact");
    GH_ASSERT_EQUAL_OBJECTS(map[fields[authorization.count + 2].signature][@"value"], @"Yes"); // "us" is a pronoun

    // A profile that lives in the United States states the US fact instead: the same questions stop being
    // guesses. `workAuthorization.CA` is still an explicit fact, so Canada keeps its "Yes" either way.
    NSDictionary *american = GhostMap(OfflineGhosts(fields, ProfileWith(@{ @"country": @"United States" })));
    GH_ASSERT_EQUAL_OBJECTS(american[fields[0].signature][@"value"], @"Yes");
    GH_ASSERT_EQUAL_OBJECTS(american[fields[0].signature][@"answerSource"], @"fact");
    GH_ASSERT_EQUAL_OBJECTS(american[fields[1].signature][@"value"], @"Yes");
    GH_ASSERT_EQUAL_OBJECTS(american[fields[authorization.count + 1].signature][@"value"], @"Yes");
    GH_ASSERT_EQUAL_OBJECTS(american[fields[authorization.count + 1].signature][@"answerSource"], @"fact");

    // Drop the qualified key and the UK question has nothing to stand on: a conservative guess again.
    NSMutableDictionary *noCanada = [ProfileWith(@{ @"country": @"United States" }) mutableCopy];
    NSMutableDictionary *trimmed = [noCanada[@"facts"] mutableCopy];
    [trimmed removeObjectForKey:@"workAuthorization.CA"];
    [trimmed removeObjectForKey:@"workAuthorization"];
    noCanada[@"facts"] = trimmed;
    NSDictionary *silent = GhostMap(OfflineGhosts(fields, noCanada));
    GH_ASSERT_EQUAL_OBJECTS(silent[fields[authorization.count + 1].signature][@"value"], @"No");
    GH_ASSERT_EQUAL_OBJECTS(silent[fields[authorization.count + 1].signature][@"guess"], @YES);

    // One correction settles it for every site afterwards.
    GHCore *core = FixtureCore();
    NSDictionary *learned = [core recordCorrectionForFieldObject:[fields[0] toJSONObject] value:@"Yes" answers:@"" at:nil];
    NSString *answersJSON = GHJSONString(learned[@"answers"]);
    NSArray *assignments = [core mapFields:fields factKeys:KeysOf([core demoProfile])];
    NSDictionary *after = GhostMap([core ghostsForFields:fields assignments:assignments profile:[core demoProfile]
                                                settings:[core defaultSettings] source:@"offline"
                                                 options:@{ @"answers": answersJSON }]);
    GH_ASSERT_EQUAL_OBJECTS(after[fields[0].signature][@"value"], @"Yes");
    GH_ASSERT(after[fields[0].signature][@"guess"] == nil);
    GH_ASSERT_EQUAL_OBJECTS(after[fields[0].signature][@"answerSource"], @"learned");
    // The correction is keyed by the QUESTION, not by the field or the site: the same question on the next
    // ATS (another signature, another option wording) is answered from it too.
    GHField *elsewhereSameQuestion = CoreField(@"other-site|auth", authorization[0], GHKindSelect);
    elsewhereSameQuestion.options = @[ @{ @"value": @"y", @"label": @"Yes" }, @{ @"value": @"n", @"label": @"No" } ];
    NSDictionary *carried = GhostMap([core ghostsForFields:@[ elsewhereSameQuestion ]
                                              assignments:[core mapFields:@[ elsewhereSameQuestion ] factKeys:KeysOf([core demoProfile])]
                                                  profile:[core demoProfile] settings:[core defaultSettings] source:@"offline"
                                                  options:@{ @"answers": answersJSON }]);
    GH_ASSERT_EQUAL_OBJECTS(carried[@"other-site|auth"][@"value"], @"y");
    GH_ASSERT_EQUAL_OBJECTS(carried[@"other-site|auth"][@"answerSource"], @"learned");
    // A question that is worded differently is a different question: it keeps the conservative guess.
    GH_ASSERT_EQUAL_OBJECTS(after[fields[1].signature][@"value"], @"No");
    GH_ASSERT_EQUAL_OBJECTS(after[fields[1].signature][@"guess"], @YES);
}

GH_TEST(core_eeo_questions_are_declined_never_invented) {
    // A protected question with NO way to decline is the one case where Ghost proposes nothing: inventing a
    // characteristic is worse than an empty field (docs/answers.md section 1). These are free-text questions.
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
    // The server is never told which fact could answer a protected question.
    for (NSDictionary *assignment in [core mapFields:fields factKeys:KeysOf(profile)]) {
        if (![assignment[@"signature"] isEqualToString:@"txt|first"]) GH_ASSERT_EQUAL_OBJECTS(assignment[@"factKey"], @"none");
    }
    NSArray *direct = [core ghostsForFields:fields assignments:served profile:profile settings:[core defaultSettings] source:@"server" options:nil];
    NSArray *upgraded = [core upgradeGhostsForFields:fields served:served profile:profile settings:[core defaultSettings] source:@"server" options:nil];
    for (NSArray *list in @[ direct, upgraded ]) {
        GH_ASSERT_EQUAL_INT(list.count, 1);
        GH_ASSERT_EQUAL_OBJECTS([list.firstObject objectForKey:@"signature"], @"txt|first");
    }

    // The same questions WITH a decline option are answered with it: a true answer for anyone, and the form
    // is finished. Ghost picks the form's own wording, never a characteristic.
    GHField *gender = CoreField(@"sel|gender", @"Gender", GHKindSelect);
    gender.options = @[ @{ @"value": @"", @"label": @"Select..." }, @{ @"value": @"m", @"label": @"Male" },
                        @{ @"value": @"f", @"label": @"Female" }, @{ @"value": @"d", @"label": @"Decline To Self Identify" } ];
    GHField *disability = CoreField(@"sel|disability", @"Disability Status", GHKindSelect);
    disability.options = @[ @{ @"value": @"y", @"label": @"Yes, I have a disability" },
                            @{ @"value": @"n", @"label": @"No, I do not have a disability" },
                            @{ @"value": @"x", @"label": @"I do not want to answer" } ];
    NSDictionary *declined = GhostMap(OfflineGhosts(@[ gender, disability ], profile));
    GH_ASSERT_EQUAL_OBJECTS(declined[@"sel|gender"][@"value"], @"d");
    GH_ASSERT_EQUAL_OBJECTS(declined[@"sel|gender"][@"answerClass"], @"protected");
    GH_ASSERT_EQUAL_OBJECTS(declined[@"sel|gender"][@"answerSource"], @"fact");   // declining claims nothing about anybody
    GH_ASSERT_EQUAL_OBJECTS(declined[@"sel|disability"][@"value"], @"x");

    // Turn the setting off and those questions go back to being the user's alone: no ANSWER is proposed for
    // either of them. The screen is not left blank (docs/always-propose.md) -- with nothing to answer, Ghost
    // offers only to take the cursor to the first control, which on the native side is a parked click that
    // Ghost never presses (GHWalkState treats every click ghost as locked).
    NSMutableDictionary *settings = [[core defaultSettings] mutableCopy];
    settings[@"answerProtectedWithDecline"] = @NO;
    NSArray<NSDictionary *> *quiet = [core ghostsForFields:@[ gender, disability ]
                               assignments:[core mapFields:@[ gender, disability ] factKeys:KeysOf(profile)]
                                   profile:profile settings:settings source:@"offline" options:nil];
    for (NSDictionary *ghost in quiet) {
        GH_ASSERT_EQUAL_OBJECTS(ghost[@"action"], @"click");
        GH_ASSERT(ghost[@"value"] == nil);
        GH_ASSERT(ghost[@"answerClass"] == nil);
    }
}

GH_TEST(core_demographic_facts_stay_local_and_a_server_can_never_point_at_one) {
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
    NSDictionary *map = GhostMap([core upgradeGhostsForFields:fields served:served profile:profile settings:[core defaultSettings] source:@"server" options:nil]);
    // The profile DOES state these facts, so the questions are answered from the profile -- by the local rules,
    // never because a server pointed at them. "How do you identify?" has no decline option among Man / Woman /
    // Non-binary, and the profile says "Woman": that is the user's own word, and it is used.
    GH_ASSERT_EQUAL_OBJECTS(map[identify.signature][@"value"], @"woman");
    GH_ASSERT_EQUAL_OBJECTS(map[identify.signature][@"answerSource"], @"fact");   // the user's own word, from the profile
    // "Have you served?" offers only two full sentences and no way to decline: the profile's "No" cannot be
    // tied to "I am not a protected veteran" with confidence -- so Ghost proposes the option that claims the
    // least, as a flagged long shot, rather than leaving the form unfinishable (docs/always-propose.md).
    GH_ASSERT(map[service.signature] != nil);
    GH_ASSERT_EQUAL_OBJECTS(map[service.signature][@"answerSource"], @"guess");
    GH_ASSERT_EQUAL_OBJECTS(map[service.signature][@"tier"], @"long-shot");
    GH_ASSERT_EQUAL_OBJECTS(map[service.signature][@"needsReview"], @YES);
    // A date of birth is never typed into a free-text field by inference, and the country list is not demographic.
    GH_ASSERT(map[born.signature] == nil);
    GH_ASSERT_EQUAL_OBJECTS(map[country.signature][@"value"], @"CA");

    // Take the demographic facts away and the same questions fall back to the local rules, never to a
    // server's idea. Neither offers a way to decline, so each gets the least specific option it does offer,
    // flagged and dimmed -- a guess the user fixes in one keystroke, never a server's guess (docs/answers.md
    // section 1, docs/always-propose.md). A date of birth still has nothing to propose: it is free text.
    NSDictionary *plain = [core demoProfile];
    NSDictionary *without = GhostMap([core upgradeGhostsForFields:fields served:served profile:plain settings:[core defaultSettings] source:@"server" options:nil]);
    GH_ASSERT(without[born.signature] == nil);
    for (GHField *field in @[ identify, service ]) {
        NSDictionary *ghost = without[field.signature];
        GH_ASSERT_MSG(ghost != nil, @"%@ must still be proposed for", field.label);
        GH_ASSERT_EQUAL_OBJECTS(ghost[@"answerSource"], @"guess");
        GH_ASSERT_EQUAL_OBJECTS(ghost[@"tier"], @"long-shot");
        GH_ASSERT_EQUAL_OBJECTS(ghost[@"needsReview"], @YES);
    }

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
