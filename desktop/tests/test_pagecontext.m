// GHPageContext against the redacted real Greenhouse fixture (Safari, Viam) and small hand-built trees.
#import "GHTest.h"
#import "GHPageContext.h"

#pragma mark - fixture loader

/// Same shape as `ghostctl dump-tree`: role, subrole, roleDescription, title, description, identifier, text
/// (AXStaticText), enabled, rect, children. Values of inputs are lengths only and are not needed here.
static GHFakeAXNode *PCNodeFromFixture(NSDictionary *raw) {
    GHFakeAXNode *node = [GHFakeAXNode nodeWithRole:raw[@"role"] ?: @"AXUnknown"];
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

static GHFakeAXNode *PCGreenhouseWindow(void) {
    NSString *path = [@(__FILE__).stringByDeletingLastPathComponent stringByAppendingPathComponent:@"fixtures/greenhouse-safari-viam.json"];
    NSData *data = [NSData dataWithContentsOfFile:path];
    if (!data) return nil;
    NSDictionary *fixture = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
    return [fixture[@"tree"] isKindOfClass:NSDictionary.class] ? PCNodeFromFixture(fixture[@"tree"]) : nil;
}

static GHFakeAXNode *PCText(NSString *text) { return [GHFakeAXNode staticText:text frame:CGRectZero]; }

static GHFakeAXNode *PCNode(NSString *role, NSString *title) {
    GHFakeAXNode *node = [GHFakeAXNode nodeWithRole:role];
    node.title = title;
    return node;
}

static GHFakeAXNode *PCHeading(NSString *text) {
    GHFakeAXNode *heading = PCNode(@"AXHeading", text);
    [heading addChild:PCText(text)];
    return heading;
}

#pragma mark - the real page

GH_TEST(pagecontext_reads_role_and_company_from_the_real_greenhouse_page) {
    GHFakeAXNode *window = PCGreenhouseWindow();
    GH_ASSERT(window != nil);
    GHPageContext *context = [GHPageContext contextFromNode:window];
    GH_ASSERT_EQUAL_OBJECTS(context.role, @"Software Engineering Intern (Summer 2027)");
    GH_ASSERT_EQUAL_OBJECTS(context.company, @"Viam");
    GH_ASSERT_FALSE(context.truncated);
    GH_ASSERT_EQUAL_OBJECTS(context.dictionary[@"company"], @"Viam");
    GH_ASSERT_EQUAL_OBJECTS(context.dictionary[@"role"], @"Software Engineering Intern (Summer 2027)");
}

GH_TEST(pagecontext_description_is_the_posting_text_above_apply_for_this_job) {
    GHPageContext *context = [GHPageContext contextFromNode:PCGreenhouseWindow()];
    NSString *text = context.jobDescription;
    GH_ASSERT(text.length > 200);
    GH_ASSERT(text.length <= GHPageContextMaxDescription);
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
    GHFakeAXNode *window = PCGreenhouseWindow();
    // window > split group > tab group > group > group > scroll area > web area
    id<GHAXNode> web = window.children[0].children[0].children[0].children[0].children[0].children[0];
    GH_ASSERT_EQUAL_OBJECTS(web.role, @"AXWebArea");
    GHPageContext *context = [GHPageContext contextFromNode:web];
    GH_ASSERT_EQUAL_OBJECTS(context.company, @"Viam");
    GH_ASSERT_EQUAL_OBJECTS(context.role, @"Software Engineering Intern (Summer 2027)");
}

#pragma mark - rules on small trees

GH_TEST(pagecontext_company_falls_back_to_the_logo_and_never_the_job_board) {
    GHFakeAXNode *web = PCNode(@"AXWebArea", nil);   // no "Job Application for" title
    GHFakeAXNode *main = [web addChild:PCNode(@"AXGroup", nil)];
    GHFakeAXNode *logo = [main addChild:PCNode(@"AXLink", @"Acme Robotics Logo")];
    [logo addChild:PCNode(@"AXImage", nil)];
    [main addChild:PCHeading(@"Firmware Engineer")];
    [main addChild:PCText(@"Build things.")];
    GHFakeAXNode *footer = [web addChild:PCNode(@"AXGroup", nil)];
    footer.subrole = @"AXLandmarkContentInfo";
    [footer addChild:PCNode(@"AXLink", @"Greenhouse logo")];

    GHPageContext *context = [GHPageContext contextFromNode:web];
    GH_ASSERT_EQUAL_OBJECTS(context.company, @"Acme Robotics");
    GH_ASSERT_EQUAL_OBJECTS(context.role, @"Firmware Engineer");
    GH_ASSERT_EQUAL_OBJECTS(context.jobDescription, @"Build things.");

    // Only the job board's logo on the page: no company rather than the wrong one.
    GHFakeAXNode *bare = PCNode(@"AXWebArea", nil);
    [bare addChild:PCNode(@"AXLink", @"Greenhouse logo")];
    [bare addChild:PCNode(@"AXImage", @"Lever Logo")];
    [bare addChild:PCHeading(@"Designer")];
    GH_ASSERT([GHPageContext contextFromNode:bare].company == nil);
}

GH_TEST(pagecontext_company_and_role_patterns) {
    GH_ASSERT_EQUAL_OBJECTS([GHPageContext companyFromTitle:@"Job Application for Software Engineering Intern (Summer 2027) at Viam" role:nil], @"Viam");
    // The role itself says " at ": the known role wins over the last " at ".
    GH_ASSERT_EQUAL_OBJECTS([GHPageContext companyFromTitle:@"Job Application for Engineer at Scale at Foo Labs" role:@"Engineer at Scale"], @"Foo Labs");
    GH_ASSERT_EQUAL_OBJECTS([GHPageContext companyFromTitle:@"job application for  Data   Analyst at  Initech " role:nil], @"Initech");
    GH_ASSERT([GHPageContext companyFromTitle:@"Careers at Viam" role:nil] == nil);
    GH_ASSERT([GHPageContext companyFromTitle:@"Job Application for Designer" role:nil] == nil);
    GH_ASSERT([GHPageContext companyFromTitle:nil role:nil] == nil);

    GH_ASSERT_EQUAL_OBJECTS([GHPageContext companyFromLogoText:@"Viam Logo"], @"Viam");
    GH_ASSERT_EQUAL_OBJECTS([GHPageContext companyFromLogoText:@"  Hooli   logo "], @"Hooli");
    GH_ASSERT([GHPageContext companyFromLogoText:@"Greenhouse logo"] == nil);
    GH_ASSERT([GHPageContext companyFromLogoText:@"Workday Logo"] == nil);
    GH_ASSERT([GHPageContext companyFromLogoText:@"Logo"] == nil);
    GH_ASSERT([GHPageContext companyFromLogoText:@"Viam"] == nil);

    // No heading: the role comes from the title pattern.
    GHFakeAXNode *web = PCNode(@"AXWebArea", nil);
    web.axDescription = @"Job Application for Product Manager at Globex";
    [web addChild:PCText(@"We make things.")];
    GHPageContext *context = [GHPageContext contextFromNode:web];
    GH_ASSERT_EQUAL_OBJECTS(context.role, @"Product Manager");
    GH_ASSERT_EQUAL_OBJECTS(context.company, @"Globex");
}

GH_TEST(pagecontext_without_apply_heading_stops_at_the_first_form_control) {
    GHFakeAXNode *web = PCNode(@"AXWebArea", nil);
    [web addChild:PCHeading(@"Barista")];
    [web addChild:PCText(@"Pour coffee.")];
    GHFakeAXNode *form = [web addChild:PCNode(@"AXGroup", nil)];
    [form addChild:PCText(@"First Name")];
    [form addChild:PCNode(@"AXTextField", @"First Name")];
    [web addChild:PCText(@"Equal opportunity statement")];
    GHPageContext *context = [GHPageContext contextFromNode:web];
    GH_ASSERT_EQUAL_OBJECTS(context.jobDescription, @"Pour coffee.\nFirst Name");   // the field's own label precedes it

    GHFakeAXNode *withForm = PCNode(@"AXWebArea", nil);
    [withForm addChild:PCHeading(@"Barista")];
    [withForm addChild:PCText(@"Pour coffee.")];
    GHFakeAXNode *landmark = [withForm addChild:PCNode(@"AXGroup", nil)];
    landmark.subrole = @"AXLandmarkForm";
    [landmark addChild:PCText(@"First Name")];
    GH_ASSERT_EQUAL_OBJECTS([GHPageContext contextFromNode:withForm].jobDescription, @"Pour coffee.");
}

GH_TEST(pagecontext_description_is_capped_at_2000_without_splitting_characters) {
    GHFakeAXNode *web = PCNode(@"AXWebArea", nil);
    [web addChild:PCHeading(@"Role")];
    NSMutableString *long1 = [NSMutableString string];
    for (int i = 0; i < 400; i++) [long1 appendString:@"word "];
    [web addChild:PCText(long1)];
    [web addChild:PCText([@"" stringByPaddingToLength:900 withString:@"\U0001F600" startingAtIndex:0])];   // 450 emoji, no spaces
    [web addChild:PCHeading(@"Apply for this job")];
    [web addChild:PCText(@"after the heading")];
    GHPageContext *context = [GHPageContext contextFromNode:web];
    GH_ASSERT(context.jobDescription.length <= GHPageContextMaxDescription);
    GH_ASSERT(context.jobDescription.length > 1500);
    GH_ASSERT_FALSE([context.jobDescription containsString:@"after the heading"]);

    NSString *emoji = [@"" stringByPaddingToLength:30 withString:@"\U0001F600" startingAtIndex:0];
    NSString *cut = [GHPageContext text:emoji cappedAt:7];
    GH_ASSERT(cut.length <= 7);
    GH_ASSERT_EQUAL_INT(cut.length % 2, 0);   // whole surrogate pairs only
    GH_ASSERT_EQUAL_OBJECTS([GHPageContext text:@"alpha beta gamma" cappedAt:12], @"alpha beta");
    GH_ASSERT_EQUAL_OBJECTS([GHPageContext text:@"short" cappedAt:12], @"short");
    GH_ASSERT_EQUAL_OBJECTS([GHPageContext normalizedText:@"  a \n\t b  "], @"a b");
}

GH_TEST(pagecontext_never_reads_input_values_and_respects_the_node_budget) {
    GHFakeAXNode *web = PCNode(@"AXWebArea", nil);
    [web addChild:PCHeading(@"Role")];
    GHFakeAXNode *field = [web addChild:PCNode(@"AXTextArea", @"Notes")];
    field.value = @"private text the user typed";
    [web addChild:PCText(@"after")];
    GHPageContext *context = [GHPageContext contextFromNode:web];
    GH_ASSERT_FALSE([context.jobDescription containsString:@"private"]);

    GHFakeAXNode *big = PCNode(@"AXWebArea", nil);
    for (int i = 0; i < 50; i++) [big addChild:PCText([NSString stringWithFormat:@"line %d", i])];
    GHPageContext *limited = [GHPageContext contextFromNode:big maxNodes:10];
    GH_ASSERT(limited.truncated);
    GH_ASSERT_EQUAL_INT(limited.visitedNodes, 10);
    GH_ASSERT_FALSE([limited.jobDescription containsString:@"line 20"]);

    GHPageContext *empty = [GHPageContext contextFromNode:PCNode(@"AXWindow", nil)];
    GH_ASSERT(empty.company == nil && empty.role == nil);
    GH_ASSERT_EQUAL_OBJECTS(empty.jobDescription, @"");
    GH_ASSERT_EQUAL_INT(empty.dictionary.count, 0);
}

GH_TEST(pagecontext_walk_stops_at_a_hung_app) {
    GHFakeAXNode *web = PCNode(@"AXWebArea", nil);
    [web addChild:PCNode(@"AXHeading", @"Robotics Intern")];
    [web addChild:PCText(@"We build friendly robots.")];
    GHFakeAXNode *hung = [web addChild:PCNode(@"AXGroup", nil)];
    hung.lastError = kAXErrorCannotComplete;
    GHFakeAXNode *after = [web addChild:PCNode(@"AXGroup", nil)];
    [after addChild:PCText(@"Never read.")];
    GHPageContext *context = [GHPageContext contextFromNode:web];
    GH_ASSERT(context.truncated);
    GH_ASSERT_EQUAL_OBJECTS(context.role, @"Robotics Intern");
    GH_ASSERT([context.jobDescription containsString:@"friendly robots"]);
    GH_ASSERT_FALSE([context.jobDescription containsString:@"Never read"]);
    GH_ASSERT_EQUAL_INT(after.childrenReadCount, 0);
    GH_ASSERT(GHPageContextMaxSeconds > 0 && GHPageContextMaxSeconds <= 0.5);
}
