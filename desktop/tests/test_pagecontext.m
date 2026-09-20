// SBPageContext against the redacted real Greenhouse fixture (Safari, Viam) and small hand-built trees.
#import "SBTest.h"
#import "SBPageContext.h"

#pragma mark - fixture loader

/// Same shape as `shabangctl dump-tree`: role, subrole, roleDescription, title, description, identifier, text
/// (AXStaticText), enabled, rect, children. Values of inputs are lengths only and are not needed here.
static SBFakeAXNode *PCNodeFromFixture(NSDictionary *raw) {
    SBFakeAXNode *node = [SBFakeAXNode nodeWithRole:raw[@"role"] ?: @"AXUnknown"];
    NSDictionary *rect = raw[@"rect"];
    if ([rect isKindOfClass:NSDictionary.class]) {
        node.frame = CGRectMake([rect[@"x"] doubleValue], [rect[@"y"] doubleValue], [rect[@"width"] doubleValue], [rect[@"height"] doubleValue]);
    }
    NSDictionary *keys = @{ @"title": @"title", @"subrole": @"subrole", @"description": @"axDescription", @"roleDescription": @"roleDescription",
                            @"identifier": @"identifier", @"text": @"value" };
    for (NSString *key in keys) {
        if ([raw[key] isKindOfClass:NSString.class]) [node setValue:raw[key] forKey:keys[key]];
    }
    if (raw[@"enabled"]) node.enabled = [raw[@"enabled"] boolValue];
    for (NSDictionary *child in raw[@"children"]) [node addChild:PCNodeFromFixture(child)];
    return node;
}

static SBFakeAXNode *PCGreenhouseWindow(void) {
    NSString *path = [@(__FILE__).stringByDeletingLastPathComponent stringByAppendingPathComponent:@"fixtures/greenhouse-safari-viam.json"];
    NSData *data = [NSData dataWithContentsOfFile:path];
    if (!data) return nil;
    NSDictionary *fixture = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
    return [fixture[@"tree"] isKindOfClass:NSDictionary.class] ? PCNodeFromFixture(fixture[@"tree"]) : nil;
}

static SBFakeAXNode *PCText(NSString *text) { return [SBFakeAXNode staticText:text frame:CGRectZero]; }

static SBFakeAXNode *PCNode(NSString *role, NSString *title) {
    SBFakeAXNode *node = [SBFakeAXNode nodeWithRole:role];
    node.title = title;
    return node;
}

static SBFakeAXNode *PCHeading(NSString *text) {
    SBFakeAXNode *heading = PCNode(@"AXHeading", text);
    [heading addChild:PCText(text)];
    return heading;
}

#pragma mark - the real page

GH_TEST(pagecontext_reads_role_and_company_from_the_real_greenhouse_page) {
    SBFakeAXNode *window = PCGreenhouseWindow();
    GH_ASSERT(window != nil);
    SBPageContext *context = [SBPageContext contextFromNode:window];
    GH_ASSERT_EQUAL_OBJECTS(context.role, @"Software Engineering Intern (Summer 2027)");
    GH_ASSERT_EQUAL_OBJECTS(context.company, @"Viam");
    GH_ASSERT_FALSE(context.truncated);
    GH_ASSERT_EQUAL_OBJECTS(context.dictionary[@"company"], @"Viam");
    GH_ASSERT_EQUAL_OBJECTS(context.dictionary[@"role"], @"Software Engineering Intern (Summer 2027)");
}

GH_TEST(pagecontext_description_is_the_posting_text_above_apply_for_this_job) {
    SBPageContext *context = [SBPageContext contextFromNode:PCGreenhouseWindow()];
    NSString *text = context.jobDescription;
    GH_ASSERT(text.length > 200);
    GH_ASSERT(text.length <= SBPageContextMaxDescription);
    GH_ASSERT([text hasPrefix:@"New York, NY"]);                 // the role heading itself is not repeated
    GH_ASSERT([text containsString:@"About Viam"]);
    GH_ASSERT([text containsString:@"Working across the stack"]);
    GH_ASSERT_FALSE([text containsString:@"Back to jobs"]);      // link text is navigation
    GH_ASSERT_FALSE([text containsString:@"Create alert"]);
    GH_ASSERT_FALSE([text containsString:@"Apply for this job"]);
    GH_ASSERT_FALSE([text containsString:@"First Name"]);        // nothing from the form below the heading
    GH_ASSERT_FALSE([text containsString:@"Veteran Status"]);
    GH_ASSERT_FALSE([text containsString:@"Powered by"]);
    GH_ASSERT_FALSE([text containsString:@"  "]);
    GH_ASSERT([context.dictionary[@"description"] isEqualToString:text]);
}

GH_TEST(pagecontext_accepts_the_web_area_itself_as_root) {
    SBFakeAXNode *window = PCGreenhouseWindow();
    // window > split group > tab group > group > group > scroll area > web area
    id<SBAXNode> web = window.children[0].children[0].children[0].children[0].children[0].children[0];
    GH_ASSERT_EQUAL_OBJECTS(web.role, @"AXWebArea");
    SBPageContext *context = [SBPageContext contextFromNode:web];
    GH_ASSERT_EQUAL_OBJECTS(context.company, @"Viam");
    GH_ASSERT_EQUAL_OBJECTS(context.role, @"Software Engineering Intern (Summer 2027)");
}

#pragma mark - rules on small trees

GH_TEST(pagecontext_company_falls_back_to_the_logo_and_never_the_job_board) {
    SBFakeAXNode *web = PCNode(@"AXWebArea", nil);   // no "Job Application for" title
    SBFakeAXNode *main = [web addChild:PCNode(@"AXGroup", nil)];
    SBFakeAXNode *logo = [main addChild:PCNode(@"AXLink", @"Acme Robotics Logo")];
    [logo addChild:PCNode(@"AXImage", nil)];
    [main addChild:PCHeading(@"Firmware Engineer")];
    [main addChild:PCText(@"Build things.")];
    SBFakeAXNode *footer = [web addChild:PCNode(@"AXGroup", nil)];
    footer.subrole = @"AXLandmarkContentInfo";
    [footer addChild:PCNode(@"AXLink", @"Greenhouse logo")];

    SBPageContext *context = [SBPageContext contextFromNode:web];
    GH_ASSERT_EQUAL_OBJECTS(context.company, @"Acme Robotics");
    GH_ASSERT_EQUAL_OBJECTS(context.role, @"Firmware Engineer");
    GH_ASSERT_EQUAL_OBJECTS(context.jobDescription, @"Build things.");

    // Only the job board's logo on the page: no company rather than the wrong one.
    SBFakeAXNode *bare = PCNode(@"AXWebArea", nil);
    [bare addChild:PCNode(@"AXLink", @"Greenhouse logo")];
    [bare addChild:PCNode(@"AXImage", @"Lever Logo")];
    [bare addChild:PCHeading(@"Designer")];
    GH_ASSERT([SBPageContext contextFromNode:bare].company == nil);
}

GH_TEST(pagecontext_company_and_role_patterns) {
    GH_ASSERT_EQUAL_OBJECTS([SBPageContext companyFromTitle:@"Job Application for Software Engineering Intern (Summer 2027) at Viam" role:nil], @"Viam");
    // The role itself says " at ": the known role wins over the last " at ".
    GH_ASSERT_EQUAL_OBJECTS([SBPageContext companyFromTitle:@"Job Application for Engineer at Scale at Foo Labs" role:@"Engineer at Scale"], @"Foo Labs");
    GH_ASSERT_EQUAL_OBJECTS([SBPageContext companyFromTitle:@"job application for  Data   Analyst at  Initech " role:nil], @"Initech");
    GH_ASSERT([SBPageContext companyFromTitle:@"Careers at Viam" role:nil] == nil);
    GH_ASSERT([SBPageContext companyFromTitle:@"Job Application for Designer" role:nil] == nil);
    GH_ASSERT([SBPageContext companyFromTitle:nil role:nil] == nil);

    GH_ASSERT_EQUAL_OBJECTS([SBPageContext companyFromLogoText:@"Viam Logo"], @"Viam");
    GH_ASSERT_EQUAL_OBJECTS([SBPageContext companyFromLogoText:@"  Hooli   logo "], @"Hooli");
    GH_ASSERT([SBPageContext companyFromLogoText:@"Greenhouse logo"] == nil);
    GH_ASSERT([SBPageContext companyFromLogoText:@"Workday Logo"] == nil);
    GH_ASSERT([SBPageContext companyFromLogoText:@"Logo"] == nil);
    GH_ASSERT([SBPageContext companyFromLogoText:@"Viam"] == nil);

    // No heading: the role comes from the title pattern.
    SBFakeAXNode *web = PCNode(@"AXWebArea", nil);
    web.axDescription = @"Job Application for Product Manager at Globex";
    [web addChild:PCText(@"We make things.")];
    SBPageContext *context = [SBPageContext contextFromNode:web];
    GH_ASSERT_EQUAL_OBJECTS(context.role, @"Product Manager");
    GH_ASSERT_EQUAL_OBJECTS(context.company, @"Globex");
}

GH_TEST(pagecontext_without_apply_heading_stops_at_the_first_form_control) {
    SBFakeAXNode *web = PCNode(@"AXWebArea", nil);
    [web addChild:PCHeading(@"Barista")];
    [web addChild:PCText(@"Pour coffee.")];
    SBFakeAXNode *form = [web addChild:PCNode(@"AXGroup", nil)];
    [form addChild:PCText(@"First Name")];
    [form addChild:PCNode(@"AXTextField", @"First Name")];
    [web addChild:PCText(@"Equal opportunity statement")];
    SBPageContext *context = [SBPageContext contextFromNode:web];
    GH_ASSERT_EQUAL_OBJECTS(context.jobDescription, @"Pour coffee.\nFirst Name");   // the field's own label precedes it

    SBFakeAXNode *withForm = PCNode(@"AXWebArea", nil);
    [withForm addChild:PCHeading(@"Barista")];
    [withForm addChild:PCText(@"Pour coffee.")];
    SBFakeAXNode *landmark = [withForm addChild:PCNode(@"AXGroup", nil)];
    landmark.subrole = @"AXLandmarkForm";
    [landmark addChild:PCText(@"First Name")];
    GH_ASSERT_EQUAL_OBJECTS([SBPageContext contextFromNode:withForm].jobDescription, @"Pour coffee.");
}

GH_TEST(pagecontext_description_is_capped_at_2000_without_splitting_characters) {
    SBFakeAXNode *web = PCNode(@"AXWebArea", nil);
    [web addChild:PCHeading(@"Role")];
    NSMutableString *long1 = [NSMutableString string];
    for (int i = 0; i < 400; i++) [long1 appendString:@"word "];
    [web addChild:PCText(long1)];
    [web addChild:PCText([@"" stringByPaddingToLength:900 withString:@"\U0001F600" startingAtIndex:0])];   // 450 emoji, no spaces
    [web addChild:PCHeading(@"Apply for this job")];
    [web addChild:PCText(@"after the heading")];
    SBPageContext *context = [SBPageContext contextFromNode:web];
    GH_ASSERT(context.jobDescription.length <= SBPageContextMaxDescription);
    GH_ASSERT(context.jobDescription.length > 1500);
    GH_ASSERT_FALSE([context.jobDescription containsString:@"after the heading"]);

    NSString *emoji = [@"" stringByPaddingToLength:30 withString:@"\U0001F600" startingAtIndex:0];
    NSString *cut = [SBPageContext text:emoji cappedAt:7];
    GH_ASSERT(cut.length <= 7);
    GH_ASSERT_EQUAL_INT(cut.length % 2, 0);   // whole surrogate pairs only
    GH_ASSERT_EQUAL_OBJECTS([SBPageContext text:@"alpha beta gamma" cappedAt:12], @"alpha beta");
    GH_ASSERT_EQUAL_OBJECTS([SBPageContext text:@"short" cappedAt:12], @"short");
    GH_ASSERT_EQUAL_OBJECTS([SBPageContext normalizedText:@"  a \n\t b  "], @"a b");
}

GH_TEST(pagecontext_never_reads_input_values_and_respects_the_node_budget) {
    SBFakeAXNode *web = PCNode(@"AXWebArea", nil);
    [web addChild:PCHeading(@"Role")];
    SBFakeAXNode *field = [web addChild:PCNode(@"AXTextArea", @"Notes")];
    field.value = @"private text the user typed";
    [web addChild:PCText(@"after")];
    SBPageContext *context = [SBPageContext contextFromNode:web];
    GH_ASSERT_FALSE([context.jobDescription containsString:@"private"]);

    SBFakeAXNode *big = PCNode(@"AXWebArea", nil);
    for (int i = 0; i < 50; i++) [big addChild:PCText([NSString stringWithFormat:@"line %d", i])];
    SBPageContext *limited = [SBPageContext contextFromNode:big maxNodes:10];
    GH_ASSERT(limited.truncated);
    GH_ASSERT_EQUAL_INT(limited.visitedNodes, 10);
    GH_ASSERT_FALSE([limited.jobDescription containsString:@"line 20"]);

    SBPageContext *empty = [SBPageContext contextFromNode:PCNode(@"AXWindow", nil)];
    GH_ASSERT(empty.company == nil && empty.role == nil);
    GH_ASSERT_EQUAL_OBJECTS(empty.jobDescription, @"");
    GH_ASSERT_EQUAL_INT(empty.dictionary.count, 0);
}

GH_TEST(pagecontext_walk_stops_at_a_hung_app) {
    SBFakeAXNode *web = PCNode(@"AXWebArea", nil);
    [web addChild:PCNode(@"AXHeading", @"Robotics Intern")];
    [web addChild:PCText(@"We build friendly robots.")];
    SBFakeAXNode *hung = [web addChild:PCNode(@"AXGroup", nil)];
    hung.lastError = kAXErrorCannotComplete;
    SBFakeAXNode *after = [web addChild:PCNode(@"AXGroup", nil)];
    [after addChild:PCText(@"Never read.")];
    SBPageContext *context = [SBPageContext contextFromNode:web];
    GH_ASSERT(context.truncated);
    GH_ASSERT_EQUAL_OBJECTS(context.role, @"Robotics Intern");
    GH_ASSERT([context.jobDescription containsString:@"friendly robots"]);
    GH_ASSERT_FALSE([context.jobDescription containsString:@"Never read"]);
    GH_ASSERT_EQUAL_INT(after.childrenReadCount, 0);
    GH_ASSERT(SBPageContextMaxSeconds > 0 && SBPageContextMaxSeconds <= 0.5);
}
