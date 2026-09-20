// GHAXNode, GHCapture and GHAccessibility against fake accessibility trees. No AX permission needed:
// nothing here talks to another process except the "untrusted" tests, which expect every call to fail.
#import "GHTest.h"
#import <AppKit/AppKit.h>
#import "GHAXNode.h"
#import "GHCapture.h"
#import "GHAccessibility.h"
#import "GHCore.h"

#pragma mark - Fakes

/// Records every probe. Knows nothing by default, so tests also prove the native patterns stand on their own.
@interface GHFakeSafety : NSObject <GHSafetyChecking>
@property (nonatomic, strong) NSMutableArray<NSDictionary *> *sensitiveProbes;
@property (nonatomic, strong) NSMutableArray<NSDictionary *> *lockProbes;
@property (nonatomic, copy, nullable) NSString *sensitiveWord;
@property (nonatomic, copy, nullable) NSString *lockedWord;
@end

@implementation GHFakeSafety

- (instancetype)init {
    if ((self = [super init])) {
        _sensitiveProbes = [NSMutableArray array];
        _lockProbes = [NSMutableArray array];
    }
    return self;
}

- (BOOL)isSensitiveProbe:(NSDictionary<NSString *, id> *)probe {
    [self.sensitiveProbes addObject:probe];
    if (!self.sensitiveWord) return NO;
    for (id value in probe.allValues) {
        if ([value isKindOfClass:[NSString class]] && [[value lowercaseString] containsString:self.sensitiveWord]) return YES;
    }
    return NO;
}

- (BOOL)isLockedProbe:(NSDictionary<NSString *, id> *)probe {
    [self.lockProbes addObject:probe];
    NSString *text = probe[@"text"];
    return self.lockedWord != nil && [text.lowercaseString containsString:self.lockedWord];
}

@end

static GHFakeAXNode *Node(NSString *role, NSString *title, CGFloat x, CGFloat y, CGFloat w, CGFloat h) {
    return [GHFakeAXNode nodeWithRole:role title:title frame:CGRectMake(x, y, w, h)];
}

static GHFakeAXNode *Text(NSString *text, CGFloat x, CGFloat y) {
    return [GHFakeAXNode staticText:text frame:CGRectMake(x, y, 300, 18)];
}

static GHFakeAXNode *Radio(NSString *title, BOOL selected, CGFloat x, CGFloat y) {
    GHFakeAXNode *radio = Node(@"AXRadioButton", title, x, y, 18, 18);
    radio.value = selected ? @"1" : @"0";
    return radio;
}

static GHCapture *Capture(GHFakeSafety *safety) {
    return [[GHCapture alloc] initWithSafety:safety];
}

static GHField *FieldLabelled(GHCaptureResult *result, NSString *label) {
    for (GHField *field in result.fields) if ([field.label isEqualToString:label]) return field;
    return nil;
}

static NSArray<NSString *> *Labels(GHCaptureResult *result, BOOL valueFieldsOnly) {
    NSMutableArray<NSString *> *labels = [NSMutableArray array];
    for (GHField *field in result.fields) {
        BOOL action = [field.kind isEqualToString:GHKindButton] || [field.kind isEqualToString:GHKindLink];
        if (!valueFieldsOnly || !action) [labels addObject:field.label];
    }
    return labels;
}

static NSString *DumpJSON(GHCaptureResult *result) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:[GHField JSONObjectsForFields:result.fields] options:0 error:NULL];
    return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

/// A Safari-like window: browser chrome, then AXScrollArea > AXWebArea > groups > static texts + fields.
/// `firstName` is what the user already typed into the first field ("" for a fresh page).
static GHFakeAXNode *JobApplicationWindow(NSString *firstName, GHFakeAXNode *__strong *outToolbar) {
    GHFakeAXNode *window = Node(@"AXWindow", @"Careers at Initech", 0, 0, 1200, 1400);

    GHFakeAXNode *toolbar = [window addChild:Node(@"AXToolbar", nil, 0, 0, 1200, 52)];
    GHFakeAXNode *address = [toolbar addChild:Node(@"AXTextField", @"Address and search bar", 300, 10, 600, 32)];
    address.value = @"https://careers.example.com/apply";
    [toolbar addChild:Node(@"AXButton", @"Reload this page", 250, 10, 32, 32)];
    if (outToolbar) *outToolbar = toolbar;

    GHFakeAXNode *tabs = [window addChild:Node(@"AXTabGroup", nil, 0, 52, 1200, 40)];
    [tabs addChild:Radio(@"Careers at Initech", YES, 10, 60)];
    [tabs addChild:Radio(@"Inbox", NO, 210, 60)];

    GHFakeAXNode *menuBar = [window addChild:Node(@"AXMenuBar", nil, 0, 0, 1200, 24)];
    [menuBar addChild:Node(@"AXMenuBarItem", @"File", 0, 0, 40, 24)];

    GHFakeAXNode *split = [window addChild:Node(@"AXGroup", nil, 0, 92, 1200, 1308)];
    GHFakeAXNode *scroll = [split addChild:Node(@"AXScrollArea", nil, 0, 92, 1200, 1308)];
    GHFakeAXNode *web = [scroll addChild:Node(@"AXWebArea", @"Apply", 0, 92, 1200, 2400)];

    [web addChild:Node(@"AXHeading", @"Apply: Software Engineer Intern", 100, 110, 800, 40)];
    GHFakeAXNode *form = [web addChild:Node(@"AXGroup", nil, 100, 160, 1000, 1200)];

    // Row 1: two fields side by side. "Last name" is added FIRST to prove the order comes from rects.
    GHFakeAXNode *lastLabel = [form addChild:Text(@"Last name *", 600, 180)];
    GHFakeAXNode *last = [form addChild:Node(@"AXTextField", nil, 600, 204, 400, 32)];
    last.titleUIElement = lastLabel;
    last.value = @"";
    [form addChild:Text(@"First name", 100, 180)];
    GHFakeAXNode *first = [form addChild:Node(@"AXTextField", @"First name", 100, 202, 400, 32)]; // 2px off: same row
    first.value = firstName;
    first.identifier = @"first-name";

    GHFakeAXNode *email = [form addChild:Node(@"AXTextField", nil, 100, 270, 400, 32)];
    email.axDescription = @"Contact address";
    email.roleDescription = @"email field";
    email.value = @"";

    GHFakeAXNode *phone = [form addChild:Node(@"AXTextField", nil, 100, 340, 400, 32)];
    phone.placeholder = @"Phone";
    phone.value = @"";

    // No explicit name at all: the label is the static text right before it, inside an anonymous wrapper.
    GHFakeAXNode *wrapper = [form addChild:Node(@"AXGroup", nil, 100, 400, 1000, 60)];
    [wrapper addChild:Text(@"LinkedIn profile:", 100, 400)];
    GHFakeAXNode *linkedin = [wrapper addChild:Node(@"AXTextField", nil, 100, 424, 400, 32)];
    linkedin.value = @"";

    GHFakeAXNode *password = [form addChild:Node(@"AXSecureTextField", @"Create a password", 100, 480, 400, 32)];
    password.value = @"hunter2-not-real";
    GHFakeAXNode *hiddenSecure = [form addChild:Node(@"AXTextField", @"Portal key", 600, 480, 400, 32)];
    hiddenSecure.subrole = @"AXSecureTextField";

    [form addChild:Text(@"Social Insurance Number", 100, 530)];
    GHFakeAXNode *sin = [form addChild:Node(@"AXTextField", nil, 100, 554, 400, 32)];
    sin.value = @"";

    // HTML radios without role=radiogroup: a titled group (the fieldset legend) holding loose radios.
    GHFakeAXNode *fieldset = [form addChild:Node(@"AXGroup", @"Are you legally authorized to work in Canada?", 100, 610, 1000, 50)];
    [fieldset addChild:Radio(@"Yes", NO, 100, 636)];
    [fieldset addChild:Text(@"Yes", 124, 636)];
    [fieldset addChild:Radio(@"No", NO, 220, 636)];
    [fieldset addChild:Text(@"No", 244, 636)];

    GHFakeAXNode *radioGroup = [form addChild:Node(@"AXRadioGroup", nil, 100, 680, 1000, 50)];
    radioGroup.axDescription = @"Will you require sponsorship?";
    [radioGroup addChild:Radio(@"Yes", NO, 100, 706)];
    [radioGroup addChild:Radio(@"No", YES, 220, 706)];

    GHFakeAXNode *popup = [form addChild:Node(@"AXPopUpButton", @"How did you hear about us?", 100, 760, 400, 32)];
    popup.value = @"Select an option";
    GHFakeAXNode *menu = [popup addChild:Node(@"AXMenu", nil, 100, 760, 400, 200)];
    for (NSString *item in @[ @"Select an option", @"Hack the North", @"LinkedIn", @"A friend" ]) {
        [menu addChild:Node(@"AXMenuItem", item, 100, 760, 400, 24)];
    }

    GHFakeAXNode *essay = [form addChild:Node(@"AXTextArea", @"Why do you want to work here?", 100, 830, 900, 160)];
    essay.value = @"";

    GHFakeAXNode *terms = [form addChild:Node(@"AXCheckBox", nil, 100, 1010, 18, 18)];
    terms.value = @"0";
    [form addChild:Text(@"I agree to the terms", 124, 1010)];

    [form addChild:Node(@"AXButton", @"Save draft", 100, 1060, 140, 40)];
    [form addChild:Node(@"AXButton", @"Submit application", 260, 1060, 200, 40)];
    GHFakeAXNode *link = [form addChild:Node(@"AXLink", nil, 100, 1120, 120, 18)];
    [link addChild:Text(@"Privacy policy", 100, 1120)];
    return window;
}

#pragma mark - GHAXNode

GH_TEST(axnode_fake_tree_wires_parents_and_counts_child_reads) {
    GHFakeAXNode *parent = [GHFakeAXNode nodeWithRole:@"AXGroup"];
    GHFakeAXNode *child = [parent addChild:[GHFakeAXNode staticText:@"Hello" frame:CGRectMake(1, 2, 3, 4)]];
    GH_ASSERT(child.parent == parent);
    GH_ASSERT(child.enabled);
    GH_ASSERT_EQUAL_OBJECTS(child.value, @"Hello");
    GH_ASSERT_EQUAL_INT(parent.childrenReadCount, 0);
    GH_ASSERT_EQUAL_INT(parent.children.count, 1);
    GH_ASSERT_EQUAL_INT(parent.childrenReadCount, 1);
    GH_ASSERT([child isSameNode:child]);
    GH_ASSERT_FALSE([child isSameNode:parent]);
    GH_ASSERT(child.axElement == NULL);
}

GH_TEST(axnode_live_node_survives_a_process_without_permission) {
    GH_ASSERT([GHAXElementNode nodeWithElement:NULL] == nil);
    [GHAXElementNode applyMessagingTimeout];
    AXUIElementRef application = AXUIElementCreateApplication([NSProcessInfo processInfo].processIdentifier);
    GHAXElementNode *node = [GHAXElementNode nodeWithElement:application];
    CFRelease(application);
    GH_ASSERT(node != nil);
    // Untrusted (-25211) or a process with no AX server: every read must degrade to "nothing", never crash.
    GH_ASSERT_EQUAL_INT(node.children.count, 0);
    GH_ASSERT(node.titleUIElement == nil);
    GH_ASSERT(CGRectEqualToRect(node.frame, CGRectZero) || node.frame.size.width >= 0);
    GH_ASSERT(node.enabled);
    GH_ASSERT_FALSE(node.isFocused);
    GH_ASSERT([node isSameNode:node]);
    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:node];
    GH_ASSERT_EQUAL_INT(result.fields.count, 0);
}

#pragma mark - GHCapture: the job application

GH_TEST(capture_job_application_labels_kinds_and_order) {
    GHFakeSafety *safety = [[GHFakeSafety alloc] init];
    GHCaptureResult *result = [Capture(safety) captureWindow:JobApplicationWindow(@"", NULL)];
    GH_ASSERT_FALSE(result.partial);
    GH_ASSERT(result.sawWebArea);
    GH_ASSERT_EQUAL_OBJECTS(result.webAreaNode.title, @"Apply");

    NSArray<NSString *> *expected = @[
        @"First name", @"Last name", @"Contact address", @"Phone", @"LinkedIn profile",
        @"Are you legally authorized to work in Canada?", @"Will you require sponsorship?",
        @"How did you hear about us?", @"Why do you want to work here?", @"I agree to the terms",
        @"Save draft", @"Submit application", @"Privacy policy",
    ];
    GH_ASSERT_EQUAL_OBJECTS(Labels(result, NO), expected);

    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(result, @"First name").kind, GHKindText);
    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(result, @"First name").identifier, @"first-name");
    GH_ASSERT(FieldLabelled(result, @"Last name").required); // "Last name *"
    GH_ASSERT_FALSE(FieldLabelled(result, @"First name").required);
    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(result, @"Contact address").kind, GHKindEmail); // from "email field"
    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(result, @"Contact address").inputType, @"email");
    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(result, @"Phone").kind, GHKindTel); // from the label
    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(result, @"Phone").placeholder, @"Phone");
    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(result, @"LinkedIn profile").kind, GHKindURL); // a profile-site name wants a link
    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(result, @"Why do you want to work here?").kind, GHKindTextArea);
    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(result, @"I agree to the terms").kind, GHKindCheckbox);
    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(result, @"I agree to the terms").value, @"false");
    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(result, @"Privacy policy").kind, GHKindLink);
    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(result, @"First name").context, @"Apply: Software Engineer Intern");
    GH_ASSERT(FieldLabelled(result, @"Privacy policy").context == nil);

    // The rect is what the overlay draws on: global, top-left origin, untouched.
    GH_ASSERT(CGRectEqualToRect(FieldLabelled(result, @"First name").rect, CGRectMake(100, 202, 400, 32)));
    GH_ASSERT([result nodeForSignature:FieldLabelled(result, @"First name").signature] != nil);
}

GH_TEST(capture_secure_and_sensitive_fields_never_appear) {
    GHFakeSafety *safety = [[GHFakeSafety alloc] init]; // knows nothing: the native patterns must hold alone
    GHCaptureResult *result = [Capture(safety) captureWindow:JobApplicationWindow(@"", NULL)];
    NSString *json = DumpJSON(result).lowercaseString;
    for (NSString *banned in @[ @"password", @"social insurance", @"portal key", @"hunter2" ]) {
        GH_ASSERT_MSG(![json containsString:banned], @"captured JSON mentions \"%@\"", banned);
    }
    for (GHField *field in result.fields) {
        GH_ASSERT_MSG(![field.signature.lowercaseString containsString:@"insurance"], @"signature leaks a sensitive label");
    }
    // The secure field was never even offered to the checker.
    for (NSDictionary *probe in safety.sensitiveProbes) {
        GH_ASSERT_FALSE([[probe[@"label"] lowercaseString] containsString:@"create a password"]);
    }
}

GH_TEST(capture_asks_the_shared_safety_rules_too) {
    GHFakeSafety *safety = [[GHFakeSafety alloc] init];
    safety.sensitiveWord = @"linkedin"; // something the native patterns would never flag
    safety.lockedWord = @"save draft";
    GHCaptureResult *result = [Capture(safety) captureWindow:JobApplicationWindow(@"", NULL)];
    GH_ASSERT(FieldLabelled(result, @"LinkedIn profile") == nil);
    GH_ASSERT(FieldLabelled(result, @"Save draft").locked);
    GH_ASSERT(safety.sensitiveProbes.count > 0);
    GH_ASSERT(safety.lockProbes.count > 0);
}

GH_TEST(capture_probes_never_carry_values) {
    GHFakeSafety *safety = [[GHFakeSafety alloc] init];
    [Capture(safety) captureWindow:JobApplicationWindow(@"Zebulon-typed-value", NULL)];
    NSArray *all = [safety.sensitiveProbes arrayByAddingObjectsFromArray:safety.lockProbes];
    NSData *data = [NSJSONSerialization dataWithJSONObject:all options:0 error:NULL];
    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    GH_ASSERT_FALSE([json containsString:@"Zebulon"]);
    GH_ASSERT_FALSE([json containsString:@"careers.example.com"]);
}

GH_TEST(capture_radio_group_becomes_one_field) {
    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:JobApplicationWindow(@"", NULL)];
    NSUInteger radios = 0;
    for (GHField *field in result.fields) if ([field.kind isEqualToString:GHKindRadio]) radios++;
    GH_ASSERT_EQUAL_INT(radios, 2);

    GHField *loose = FieldLabelled(result, @"Are you legally authorized to work in Canada?");
    NSArray *yesNo = @[ @{ @"value": @"Yes", @"label": @"Yes" }, @{ @"value": @"No", @"label": @"No" } ];
    GH_ASSERT_EQUAL_OBJECTS(loose.options, yesNo);
    GH_ASSERT_EQUAL_OBJECTS(loose.value, @"");
    GH_ASSERT(CGRectEqualToRect(loose.rect, CGRectMake(100, 636, 138, 18))); // union of the two radios

    GHField *declared = FieldLabelled(result, @"Will you require sponsorship?");
    GH_ASSERT_EQUAL_OBJECTS(declared.options, yesNo);
    GH_ASSERT_EQUAL_OBJECTS(declared.value, @"No"); // already answered: the core will not ghost it
    id<GHAXNode> no = [result radioNodeForSignature:declared.signature optionLabel:@"No"];
    GH_ASSERT_EQUAL_OBJECTS(no.title, @"No");
    GH_ASSERT_EQUAL_OBJECTS([result nodeForSignature:declared.signature].role, @"AXRadioGroup");
    // The browser's tab strip is made of radio buttons too: never a field.
    GH_ASSERT(FieldLabelled(result, @"Careers at Initech") == nil);
}

GH_TEST(capture_flat_radios_split_into_questions) {
    // No fieldset, no radiogroup: question text, radio, option text, radio, option text, next question...
    GHFakeAXNode *web = Node(@"AXWebArea", nil, 0, 0, 800, 600);
    [web addChild:Text(@"Are you authorized to work?", 10, 10)];
    GHFakeAXNode *r1 = [web addChild:Radio(nil, YES, 10, 40)];
    [web addChild:Text(@"Yes", 34, 40)];
    GHFakeAXNode *r2 = [web addChild:Radio(nil, NO, 110, 40)];
    [web addChild:Text(@"No", 134, 40)];
    [web addChild:Text(@"Do you need sponsorship?", 10, 80)];
    [web addChild:Radio(nil, NO, 10, 110)];
    [web addChild:Text(@"Yes", 34, 110)];
    [web addChild:Radio(nil, NO, 110, 110)];
    [web addChild:Text(@"No", 134, 110)];
    (void)r1; (void)r2;
    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:web];
    NSArray *expected = @[ @"Are you authorized to work?", @"Do you need sponsorship?" ];
    GH_ASSERT_EQUAL_OBJECTS(Labels(result, YES), expected);
    GH_ASSERT_EQUAL_OBJECTS(result.fields[0].value, @"Yes");
    GH_ASSERT_EQUAL_OBJECTS(result.fields[1].value, @"");
    GH_ASSERT_EQUAL_INT(result.fields[1].options.count, 2);
}

GH_TEST(capture_signatures_are_stable_and_value_free) {
    GHCaptureResult *fresh = [Capture([[GHFakeSafety alloc] init]) captureWindow:JobApplicationWindow(@"", NULL)];
    GHCaptureResult *typed = [Capture([[GHFakeSafety alloc] init]) captureWindow:JobApplicationWindow(@"Zebulon", NULL)];
    GH_ASSERT_EQUAL_INT(fresh.fields.count, typed.fields.count);
    NSMutableSet<NSString *> *unique = [NSMutableSet set];
    for (NSUInteger i = 0; i < fresh.fields.count; i++) {
        GH_ASSERT_EQUAL_OBJECTS(fresh.fields[i].signature, typed.fields[i].signature);
        GH_ASSERT_FALSE([typed.fields[i].signature containsString:@"Zebulon"]);
        GH_ASSERT_FALSE([typed.fields[i].label containsString:@"Zebulon"]);
        [unique addObject:fresh.fields[i].signature];
    }
    GH_ASSERT_EQUAL_INT(unique.count, fresh.fields.count);
    GH_ASSERT_EQUAL_OBJECTS(fresh.formSignature, typed.formSignature);
    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(typed, @"First name").value, @"Zebulon"); // the value lives in `value` only
    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(fresh, @"First name").signature, @"ax|AXTextField||first name|first-name|0");
    GH_ASSERT_FALSE([[FieldLabelled(typed, @"First name") toWireJSONObject].description containsString:@"Zebulon"]);
}

GH_TEST(capture_same_label_siblings_get_an_index_and_unstable_ids_are_dropped) {
    GHFakeAXNode *web = Node(@"AXWebArea", nil, 0, 0, 800, 600);
    GHFakeAXNode *a = [web addChild:Node(@"AXTextField", @"Reference name", 10, 10, 300, 30)];
    GHFakeAXNode *b = [web addChild:Node(@"AXTextField", @"Reference name", 10, 60, 300, 30)];
    a.identifier = @":r1:";            // React useId
    b.identifier = @"input-48213907";  // generated
    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:web];
    GH_ASSERT_EQUAL_INT(result.fields.count, 2);
    GH_ASSERT_EQUAL_OBJECTS(result.fields[0].signature, @"ax|AXTextField||reference name||0");
    GH_ASSERT_EQUAL_OBJECTS(result.fields[1].signature, @"ax|AXTextField||reference name||1");
}

GH_TEST(capture_locked_submit_is_detected) {
    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:JobApplicationWindow(@"", NULL)];
    GHField *submit = FieldLabelled(result, @"Submit application");
    GH_ASSERT_EQUAL_OBJECTS(submit.kind, GHKindButton);
    GH_ASSERT(submit.locked);
    GH_ASSERT_FALSE(FieldLabelled(result, @"Save draft").locked);
    GH_ASSERT_FALSE(FieldLabelled(result, @"First name").locked);
    for (NSString *text in @[ @"Send", @"Pay now", @"Delete account", @"Place your order", @"Confirm" ]) {
        GH_ASSERT_MSG([GHCapture nativeLooksLocked:text], @"\"%@\" should lock", text);
    }
    GH_ASSERT_FALSE([GHCapture nativeLooksLocked:@"Next"]);
}

/// A toolbar is no longer skipped by role: in a native app it is where the app keeps the thing you came to
/// press. In a BROWSER window nothing outside the page survives anyway, because the walk saw a web area.
GH_TEST(capture_never_offers_browser_chrome) {
    GHFakeAXNode *toolbar = nil;
    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:JobApplicationWindow(@"", &toolbar)];
    GH_ASSERT(FieldLabelled(result, @"Address and search bar") == nil);
    GH_ASSERT(FieldLabelled(result, @"Reload this page") == nil);

    // The same roles INSIDE a page are content (an ARIA toolbar or tablist) and are walked.
    GHFakeAXNode *web = Node(@"AXWebArea", nil, 0, 0, 800, 600);
    GHFakeAXNode *pageTabs = [web addChild:Node(@"AXTabGroup", nil, 0, 0, 800, 200)];
    [pageTabs addChild:Node(@"AXTextField", @"City", 10, 10, 300, 30)];
    GHCaptureResult *page = [Capture([[GHFakeSafety alloc] init]) captureWindow:web];
    GH_ASSERT(FieldLabelled(page, @"City") != nil);
}

/// Measured before this existed: Finder exposed 3,269 accessibility nodes and Ghost found ZERO candidates in
/// it, because a conversation, a track, a file and a mail message are all AXRow and nothing mapped AXRow.
GH_TEST(capture_reads_the_rows_of_a_native_list) {
    GHFakeAXNode *window = Node(@"AXWindow", @"Messages", 0, 0, 900, 600);
    GHFakeAXNode *outline = [window addChild:Node(@"AXOutline", nil, 0, 52, 300, 548)];
    NSArray<NSString *> *people = @[ @"Tahseen Rayhan", @"Mum", @"Standup" ];
    for (NSUInteger i = 0; i < people.count; i++) {
        GHFakeAXNode *row = [outline addChild:Node(@"AXRow", nil, 0, (CGFloat)(60 + i * 64), 300, 64)];
        GHFakeAXNode *cell = [row addChild:Node(@"AXCell", nil, 0, (CGFloat)(60 + i * 64), 300, 64)];
        [cell addChild:Text(people[i], 8, (CGFloat)(66 + i * 64))];
    }
    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:window];
    GHField *first = FieldLabelled(result, @"Tahseen Rayhan");
    GH_ASSERT(first != nil);
    GH_ASSERT_EQUAL_OBJECTS(first.kind, GHKindItem);
    GH_ASSERT(FieldLabelled(result, @"Standup") != nil);
    // A row is a place to go, never a value: it must not join the form signature or the fill walk.
    GH_ASSERT_FALSE(first.locked);
    // The row is the unit. Its cell is never a second candidate for the same line.
    NSUInteger rows = 0;
    for (GHField *field in result.fields) if ([field.kind isEqualToString:GHKindItem]) rows++;
    GH_ASSERT_EQUAL_INT(rows, 3);
}

/// Measured before this existed: one open Messages conversation came back as twenty-one text areas, so Ghost
/// saw a twenty-one field form and offered to fill the other person's messages.
GH_TEST(capture_read_only_text_is_content_not_a_field) {
    GHFakeAXNode *window = Node(@"AXWindow", @"Messages", 0, 0, 900, 600);
    GHFakeAXNode *transcript = [window addChild:Node(@"AXGroup", nil, 0, 52, 900, 700)];
    for (NSUInteger i = 0; i < 4; i++) {
        // Nameless, exactly as Messages publishes them: the words are on an ancestor group, not on the box.
        GHFakeAXNode *bubble = [transcript addChild:Node(@"AXTextArea", nil, 60, (CGFloat)(60 + i * 40), 300, 33)];
        bubble.value = @"a message somebody already sent";
    }
    // And one that IS named but cannot be written to: a reading pane.
    GHFakeAXNode *reading = [window addChild:Node(@"AXTextArea", @"Message body", 400, 60, 400, 300)];
    reading.value = @"something already received";
    reading.valueIsSettable = NO;
    GHFakeAXNode *compose = [window addChild:Node(@"AXTextField", @"Message", 60, 560, 700, 33)];
    compose.valueIsSettable = YES;

    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:window];
    GH_ASSERT_EQUAL_INT(result.fields.count, 1);
    GH_ASSERT_EQUAL_OBJECTS(result.fields[0].label, @"Message");

    // Inside a web area neither test is applied: forms there do omit labels, a web input often refuses
    // AXValue and is filled by typing instead, and no form may lose a field to this.
    GHFakeAXNode *web = Node(@"AXWebArea", nil, 0, 0, 900, 600);
    GHFakeAXNode *input = [web addChild:Node(@"AXTextField", @"First name", 10, 10, 300, 30)];
    input.valueIsSettable = NO;
    GHFakeAXNode *bare = [web addChild:Node(@"AXTextField", nil, 10, 60, 300, 30)];
    bare.valueIsSettable = NO;
    GHCaptureResult *page = [Capture([[GHFakeSafety alloc] init]) captureWindow:web];
    GH_ASSERT(FieldLabelled(page, @"First name") != nil);
    GH_ASSERT_EQUAL_INT(page.fields.count, 2);   // the unnamed one survives too
}

/// A playlist or a folder has thousands of rows; nobody is about to click the 900th, and walking them all
/// spends the entire time budget before the walk ever reaches the part of the window that matters.
GH_TEST(capture_keeps_only_the_first_rows_of_a_long_list) {
    GHFakeAXNode *window = Node(@"AXWindow", @"Player", 0, 0, 900, 600);
    GHFakeAXNode *table = [window addChild:Node(@"AXTable", nil, 0, 52, 900, 548)];
    for (NSUInteger i = 0; i < 400; i++) {
        GHFakeAXNode *row = [table addChild:Node(@"AXRow", nil, 0, (CGFloat)(60 + i * 24), 900, 24)];
        [row addChild:Text([NSString stringWithFormat:@"Track %lu", (unsigned long)i], 8, (CGFloat)(62 + i * 24))];
    }
    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:window];
    NSUInteger rows = 0;
    for (GHField *field in result.fields) if ([field.kind isEqualToString:GHKindItem]) rows++;
    GH_ASSERT_EQUAL_INT(rows, [GHCaptureLimits defaultLimits].maxListRows);
    GH_ASSERT(FieldLabelled(result, @"Track 0") != nil);
    GH_ASSERT(FieldLabelled(result, @"Track 300") == nil);
}

/// The other half of the same rule: a native window has no web area, so its toolbar IS the offer. Messages
/// keeps Compose there, Finder keeps New Folder and Share. Skipping AXToolbar hid all of them.
GH_TEST(capture_reads_the_toolbar_of_a_native_window) {
    GHFakeAXNode *window = Node(@"AXWindow", @"Messages", 0, 0, 900, 600);
    GHFakeAXNode *toolbar = [window addChild:Node(@"AXToolbar", nil, 0, 0, 900, 52)];
    GHFakeAXNode *compose = [toolbar addChild:Node(@"AXButton", @"New Message", 820, 10, 32, 32)];
    compose.subrole = @"AXToolbarButton";
    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:window];
    GHField *found = FieldLabelled(result, @"New Message");
    GH_ASSERT(found != nil);
    GH_ASSERT_EQUAL_OBJECTS(found.kind, GHKindButton);
}

GH_TEST(capture_in_a_browser_window_only_the_page_counts) {
    GHFakeAXNode *window = Node(@"AXWindow", nil, 0, 0, 800, 600);
    [window addChild:Node(@"AXTextField", @"Find in page", 500, 60, 200, 24)]; // chrome outside any toolbar
    GHFakeAXNode *web = [window addChild:Node(@"AXWebArea", nil, 0, 100, 800, 500)];
    [web addChild:Node(@"AXTextField", @"City", 10, 120, 300, 30)];
    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:window];
    NSArray *expected = @[ @"City" ];
    GH_ASSERT_EQUAL_OBJECTS(Labels(result, NO), expected);

    // A native window has no web area: its fields count.
    GHFakeAXNode *native = Node(@"AXWindow", nil, 0, 0, 800, 600);
    [native addChild:Node(@"AXTextField", @"Full name", 10, 40, 300, 24)];
    GHCaptureResult *nativeResult = [Capture([[GHFakeSafety alloc] init]) captureWindow:native];
    GH_ASSERT_FALSE(nativeResult.sawWebArea);
    GH_ASSERT(FieldLabelled(nativeResult, @"Full name") != nil);
}

GH_TEST(capture_output_feeds_the_real_core) {
    // End to end without AX: fake Safari tree -> GHCapture (real shared safety rules) -> mapping -> ghosts.
    GHCore *core = [GHCore sharedCore];
    GH_ASSERT_MSG(core != nil, @"shabang-core.js is not loadable (run make core; DESKTOP_CORE_PATH points at it in make test)");
    GHCaptureResult *result = [[[GHCapture alloc] initWithSafety:core] captureWindow:JobApplicationWindow(@"", NULL)];
    NSString *json = DumpJSON(result).lowercaseString;
    GH_ASSERT_FALSE([json containsString:@"password"]);
    GH_ASSERT_FALSE([json containsString:@"social insurance"]);

    NSDictionary *profile = [core demoProfile];
    NSArray<NSString *> *factKeys = [profile[@"facts"] allKeys];
    NSArray<NSDictionary *> *assignments = [core mapFields:result.fields factKeys:factKeys];
    NSArray<NSDictionary *> *ghosts = [core ghostsForFields:result.fields assignments:assignments profile:profile
                                                   settings:[core defaultSettings] source:@"offline" options:nil];
    NSMutableDictionary<NSString *, NSDictionary *> *byLabel = [NSMutableDictionary dictionary];
    for (NSDictionary *ghost in ghosts) {
        for (GHField *field in result.fields) if ([field.signature isEqualToString:ghost[@"signature"]]) byLabel[field.label] = ghost;
    }
    GH_ASSERT_EQUAL_OBJECTS(byLabel[@"First name"][@"value"], @"Alex");
    GH_ASSERT_EQUAL_OBJECTS(byLabel[@"Last name"][@"value"], @"Chen");
    GH_ASSERT_EQUAL_OBJECTS(byLabel[@"Phone"][@"value"], @"+1 519 555 0142");
    GH_ASSERT_EQUAL_OBJECTS(byLabel[@"Are you legally authorized to work in Canada?"][@"value"], @"Yes");
    GH_ASSERT(byLabel[@"Will you require sponsorship?"] == nil); // already answered on the page
    GH_ASSERT_EQUAL_OBJECTS(byLabel[@"How did you hear about us?"][@"value"], @"Hack the North");
    GH_ASSERT(byLabel[@"I agree to the terms"] == nil);          // consent is the user's to give

    // "Last name *" is required and still empty, so the Submit ghost is withheld and the walk ends on the last
    // question instead (docs/incremental.md). The gate says exactly why.
    GH_ASSERT(byLabel[@"Submit application"] == nil);
    NSArray<NSDictionary *> *fieldObjects = [GHField JSONObjectsForFields:result.fields];
    NSDictionary *gate = [core gateForFieldObjects:fieldObjects ghosts:ghosts accepted:@[]];
    GH_ASSERT_EQUAL_OBJECTS(gate[@"terminalAllowed"], @NO);
    GH_ASSERT_EQUAL_OBJECTS(gate[@"firstUnmetLabel"], @"Last name");   // the marker is stripped for the HUD
    GH_ASSERT([gate[@"reason"] containsString:@"required field"]);

    // The user takes the ghost for it: the gate opens and the parked Submit is proposed, last and locked.
    GHField *lastName = FieldLabelled(result, @"Last name");
    NSDictionary *opened = [core gateForFieldObjects:fieldObjects ghosts:ghosts accepted:@[ lastName.signature ]];
    GH_ASSERT_EQUAL_OBJECTS(opened[@"terminalAllowed"], @YES);
    NSArray<NSDictionary *> *withSubmit = [core ghostsForFields:result.fields assignments:assignments profile:profile
                                                       settings:[core defaultSettings] source:@"offline"
                                                        options:@{ @"accepted": @[ lastName.signature ] }];
    NSDictionary *last = withSubmit.lastObject;
    GH_ASSERT_EQUAL_OBJECTS(last[@"signature"], FieldLabelled(result, @"Submit application").signature);
    GH_ASSERT_EQUAL_OBJECTS(last[@"locked"], @YES);
}

#pragma mark - GHCapture: what is skipped

GH_TEST(capture_skips_disabled_zero_size_and_off_window) {
    GHFakeAXNode *window = Node(@"AXWindow", nil, 100, 100, 800, 600);
    GHFakeAXNode *web = [window addChild:Node(@"AXWebArea", nil, 100, 150, 800, 3000)];
    [web addChild:Node(@"AXTextField", @"City", 120, 200, 300, 30)];
    GHFakeAXNode *disabled = [web addChild:Node(@"AXTextField", @"Country", 120, 250, 300, 30)];
    disabled.enabled = NO;
    [web addChild:Node(@"AXTextField", @"School", 120, 300, 0, 0)];          // zero size
    [web addChild:Node(@"AXTextField", @"Degree", 120, 350, 1, 1)];          // under the 2px floor (honeypot)
    [web addChild:Node(@"AXTextField", @"Major", 120, 1500, 300, 30)];       // below the fold
    [web addChild:Node(@"AXTextField", @"Website", -9999, 200, 300, 30)];    // parked off screen
    [web addChild:Node(@"AXButton", @"Submit", 120, 2000, 100, 30)];        // below the fold

    GHCapture *capture = Capture([[GHFakeSafety alloc] init]);
    NSArray *visible = @[ @"City" ];
    GH_ASSERT_EQUAL_OBJECTS(Labels([capture captureWindow:window], NO), visible);

    // Opt-in: fields scrolled out of view stay (the walk can reach them), parked honeypots still do not.
    capture.keepsScrolledOutFields = YES;
    NSArray *reachable = @[ @"City", @"Major", @"Submit" ];
    GH_ASSERT_EQUAL_OBJECTS(Labels([capture captureWindow:window], NO), reachable);
}

GH_TEST(capture_card_fields_under_a_payment_heading_are_dropped) {
    GHFakeAXNode *web = Node(@"AXWebArea", nil, 0, 0, 800, 600);
    [web addChild:Node(@"AXHeading", @"Card details", 10, 10, 300, 30)];
    [web addChild:Node(@"AXTextField", @"Number", 10, 50, 300, 30)];
    [web addChild:Node(@"AXTextField", @"Expiry", 10, 90, 300, 30)];
    [web addChild:Node(@"AXTextField", @"Name", 10, 130, 300, 30)];
    [web addChild:Node(@"AXTextField", @"Billing city", 10, 170, 300, 30)];
    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:web];
    NSArray *expected = @[ @"Billing city" ];
    GH_ASSERT_EQUAL_OBJECTS(Labels(result, NO), expected);

    // The same bare "Name" under an ordinary heading is just a name.
    GHFakeAXNode *plain = Node(@"AXWebArea", nil, 0, 0, 800, 600);
    [plain addChild:Node(@"AXHeading", @"About you", 10, 10, 300, 30)];
    [plain addChild:Node(@"AXTextField", @"Name", 10, 50, 300, 30)];
    GH_ASSERT(FieldLabelled([Capture([[GHFakeSafety alloc] init]) captureWindow:plain], @"Name") != nil);
}

GH_TEST(capture_every_naming_source_is_checked_and_sensitive_headings_are_not_context) {
    GHFakeAXNode *web = Node(@"AXWebArea", nil, 0, 0, 800, 600);
    GHFakeAXNode *sneaky = [web addChild:Node(@"AXTextField", @"Reference", 10, 10, 300, 30)];
    sneaky.help = @"Your passport number"; // the winning label is benign, the help text is not
    GHFakeAXNode *byId = [web addChild:Node(@"AXTextField", @"Number", 10, 50, 300, 30)];
    byId.identifier = @"cardNumber";
    [web addChild:Node(@"AXHeading", @"Password and security", 10, 90, 300, 30)];
    [web addChild:Node(@"AXTextField", @"Nickname", 10, 130, 300, 30)];
    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:web];
    NSArray *expected = @[ @"Nickname" ];
    GH_ASSERT_EQUAL_OBJECTS(Labels(result, NO), expected);
    GH_ASSERT(result.fields[0].context == nil);

    GHCapture *capture = Capture([[GHFakeSafety alloc] init]);
    GH_ASSERT([capture isNodeSensitive:sneaky]);
    GH_ASSERT([capture isNodeSensitive:Node(@"AXSecureTextField", @"Anything", 0, 0, 10, 10)]);
    GH_ASSERT_FALSE([capture isNodeSensitive:Node(@"AXTextField", @"First name", 0, 0, 10, 10)]);
    for (NSString *text in @[ @"S.I.N.", @"card_number", @"cvv", @"Social Security Number", @"apiKey", @"One-time code" ]) {
        GH_ASSERT_MSG([GHCapture nativeLooksSensitive:text], @"\"%@\" should be sensitive", text);
    }
    GH_ASSERT_FALSE([GHCapture nativeLooksSensitive:@"First name"]);
}

#pragma mark - GHCapture: bounds

GH_TEST(capture_node_budget_aborts_and_keeps_partial_results) {
    GHFakeAXNode *web = Node(@"AXWebArea", nil, 0, 0, 800, 600);
    [web addChild:Node(@"AXTextField", @"City", 10, 10, 300, 30)];
    for (NSUInteger i = 0; i < 5000; i++) [web addChild:Text(@"row", 10, 50)];
    [web addChild:Node(@"AXTextField", @"Country", 10, 100, 300, 30)]; // node 5002: never reached
    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:web];
    GH_ASSERT_EQUAL_INT(result.visitedNodes, 1500);
    GH_ASSERT_EQUAL_INT(result.stop, GHCaptureStopNodes);
    GH_ASSERT(result.partial);
    NSArray *expected = @[ @"City" ];
    GH_ASSERT_EQUAL_OBJECTS(Labels(result, NO), expected);
}

GH_TEST(capture_time_budget_aborts_and_keeps_partial_results) {
    GHFakeAXNode *window = Node(@"AXWindow", nil, 0, 0, 800, 600);
    [window addChild:Node(@"AXTextField", @"City", 10, 10, 300, 30)];
    for (NSUInteger i = 0; i < 1000; i++) [window addChild:Text(@"row", 10, 50)];
    [window addChild:Node(@"AXTextField", @"Country", 10, 100, 300, 30)];
    GHCapture *capture = Capture([[GHFakeSafety alloc] init]);
    __block NSTimeInterval now = 1000;
    capture.clock = ^NSTimeInterval { now += 0.001; return now; }; // every look at the clock costs a millisecond
    GHCaptureResult *result = [capture captureWindow:window];
    GH_ASSERT_EQUAL_INT(result.stop, GHCaptureStopTime);
    GH_ASSERT(result.partial);
    // 350 ms at a millisecond per clock reading. The budget was 120 ms while Ghost only ever looked at web
    // pages; a native window is a slower tree with more nodes, and 120 ms stopped Finder a tenth of the way in.
    GH_ASSERT(result.visitedNodes > 200 && result.visitedNodes < 500);
    NSArray *expected = @[ @"City" ];
    GH_ASSERT_EQUAL_OBJECTS(Labels(result, NO), expected);
    GH_ASSERT(result.elapsed > 0.350);
}

/// Live, Safari: the controller's 120 ms walk of the Greenhouse posting stopped at ~270 of ~380 nodes (about 0.4 ms of
/// IPC per node), so the bottom of the form and the locked Submit were missing and the form signature changed with
/// every rescan. A walk that has met a web area gets the web-area budget instead.
GH_TEST(capture_web_area_gets_its_own_budget_so_a_long_posting_reaches_submit) {
    GHFakeAXNode *window = Node(@"AXWindow", nil, 0, 0, 1470, 810);
    GHFakeAXNode *tabs = [window addChild:Node(@"AXTabGroup", nil, 0, 34, 1470, 810)];
    GHFakeAXNode *web = [tabs addChild:Node(@"AXWebArea", nil, 0, 124, 1453, 720)];
    [web addChild:Node(@"AXTextField", @"First Name", 300, 200, 600, 35)];
    for (NSUInteger i = 0; i < 360; i++) [web addChild:Text(@"posting text", 300, 260)];
    GHFakeAXNode *submit = [web addChild:Node(@"AXButton", @"Submit application", 900, 700, 190, 41)];
    (void)submit;
    GHCapture *capture = Capture([[GHFakeSafety alloc] init]);
    __block NSTimeInterval now = 1000;
    capture.clock = ^NSTimeInterval { now += 0.0004; return now; };
    GHCaptureResult *result = [capture captureWindow:window];
    GH_ASSERT_EQUAL_INT(result.stop, GHCaptureStopNone);
    GH_ASSERT_FALSE(result.partial);
    GH_ASSERT(result.elapsed > 0.120);   // the native budget alone would have cut this walk short
    GH_ASSERT([Labels(result, NO) containsObject:@"Submit application"]);
    GH_ASSERT(FieldLabelled(result, @"Submit application").locked);

    // Still bounded: a page that never ends stops at the web-area budget and keeps what it found.
    GHFakeAXNode *huge = Node(@"AXWebArea", nil, 0, 0, 800, 600);
    [huge addChild:Node(@"AXTextField", @"City", 10, 10, 300, 30)];
    for (NSUInteger i = 0; i < 1400; i++) [huge addChild:Text(@"row", 10, 50)];
    now = 1000;
    capture.clock = ^NSTimeInterval { now += 0.001; return now; };
    GHCaptureResult *bounded = [capture captureWindow:huge];
    GH_ASSERT_EQUAL_INT(bounded.stop, GHCaptureStopTime);
    GH_ASSERT(bounded.partial);
    GH_ASSERT(bounded.elapsed > 0.600 && bounded.elapsed < 0.700);
    GH_ASSERT_EQUAL_OBJECTS(Labels(bounded, NO), (@[ @"City" ]));

    // The web-area budget never shortens a caller's larger budget (the harness walks with 2 s).
    GHCaptureLimits *limits = [GHCaptureLimits defaultLimits];
    GH_ASSERT(limits.webAreaTimeBudget > limits.timeBudget);
    limits.timeBudget = 2.0;
    capture.limits = limits;
    now = 1000;
    GHCaptureResult *harness = [capture captureWindow:huge];
    GH_ASSERT_EQUAL_INT(harness.stop, GHCaptureStopNone);
}

GH_TEST(capture_depth_bound_stops_descending) {
    GHFakeAXNode *web = Node(@"AXWebArea", nil, 0, 0, 800, 600);
    GHFakeAXNode *cursor = web;
    for (NSUInteger i = 0; i < 60; i++) {
        cursor = [cursor addChild:Node(@"AXGroup", nil, 0, 0, 800, 600)];
        if (i == 10) [cursor addChild:Node(@"AXTextField", @"Shallow", 10, 10, 300, 30)];
    }
    [cursor addChild:Node(@"AXTextField", @"Deep", 10, 60, 300, 30)];
    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:web];
    NSArray *expected = @[ @"Shallow" ];
    GH_ASSERT_EQUAL_OBJECTS(Labels(result, NO), expected);
    GH_ASSERT(result.partial);
    GH_ASSERT_EQUAL_INT(result.stop, GHCaptureStopNone);
}

#pragma mark - GHCapture: pieces

GH_TEST(capture_role_to_kind) {
    GH_ASSERT_EQUAL_OBJECTS([GHCapture kindForRole:@"AXTextField" subrole:nil], GHKindText);
    GH_ASSERT_EQUAL_OBJECTS([GHCapture kindForRole:@"AXTextArea" subrole:nil], GHKindTextArea);
    GH_ASSERT_EQUAL_OBJECTS([GHCapture kindForRole:@"AXComboBox" subrole:nil], GHKindSelect);
    GH_ASSERT_EQUAL_OBJECTS([GHCapture kindForRole:@"AXPopUpButton" subrole:nil], GHKindSelect);
    GH_ASSERT_EQUAL_OBJECTS([GHCapture kindForRole:@"AXCheckBox" subrole:nil], GHKindCheckbox);
    GH_ASSERT_EQUAL_OBJECTS([GHCapture kindForRole:@"AXRadioGroup" subrole:nil], GHKindRadio);
    GH_ASSERT_EQUAL_OBJECTS([GHCapture kindForRole:@"AXRadioButton" subrole:nil], GHKindRadio);
    GH_ASSERT_EQUAL_OBJECTS([GHCapture kindForRole:@"AXButton" subrole:nil], GHKindButton);
    GH_ASSERT_EQUAL_OBJECTS([GHCapture kindForRole:@"AXLink" subrole:nil], GHKindLink);
    GH_ASSERT([GHCapture kindForRole:@"AXSecureTextField" subrole:nil] == nil);
    GH_ASSERT([GHCapture kindForRole:@"AXTextField" subrole:@"AXSecureTextField"] == nil);
    GH_ASSERT([GHCapture kindForRole:@"AXGroup" subrole:nil] == nil);
    GH_ASSERT([GHCapture kindForRole:nil subrole:nil] == nil);
}

GH_TEST(capture_text_kind_inference_is_defensive) {
    GHFakeAXNode *web = Node(@"AXWebArea", nil, 0, 0, 800, 900);
    GHFakeAXNode *tel = [web addChild:Node(@"AXTextField", @"Reach you at", 10, 10, 300, 30)];
    tel.roleDescription = @"telephone number field";
    GHFakeAXNode *url = [web addChild:Node(@"AXTextField", @"Link", 10, 50, 300, 30)];
    url.roleDescription = @"URL field";
    GHFakeAXNode *byClass = [web addChild:Node(@"AXTextField", @"Contact", 10, 90, 300, 30)];
    byClass.domClassList = @[ @"form-control", @"email-input" ];
    GHFakeAXNode *notTel = [web addChild:Node(@"AXTextField", @"Hostel", 10, 130, 300, 30)];
    notTel.domClassList = @[ @"telemetry" ]; // contains "tel" but is not the token "tel"
    [web addChild:Node(@"AXTextField", @"Portfolio website", 10, 170, 300, 30)];
    GHFakeAXNode *date = [web addChild:Node(@"AXTextField", @"Start", 10, 210, 300, 30)];
    date.roleDescription = @"date field";
    GHFakeAXNode *search = [web addChild:Node(@"AXTextField", @"Search jobs", 10, 250, 300, 30)];
    search.subrole = @"AXSearchField";
    GHFakeAXNode *number = [web addChild:Node(@"AXTextField", @"Years", 10, 290, 300, 30)];
    number.roleDescription = @"number field";

    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:web];
    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(result, @"Reach you at").kind, GHKindTel);
    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(result, @"Link").kind, GHKindURL);
    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(result, @"Contact").kind, GHKindEmail);
    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(result, @"Hostel").kind, GHKindText);
    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(result, @"Portfolio website").kind, GHKindURL);
    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(result, @"Start").kind, GHKindOther); // never type into a date picker
    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(result, @"Search jobs").kind, GHKindText);
    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(result, @"Search jobs").inputType, @"search");
    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(result, @"Years").kind, GHKindNumber);
}

GH_TEST(capture_select_options_placeholder_and_lazy_menus) {
    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:JobApplicationWindow(@"", NULL)];
    GHField *select = FieldLabelled(result, @"How did you hear about us?");
    GH_ASSERT_EQUAL_OBJECTS(select.kind, GHKindSelect);
    GH_ASSERT_EQUAL_INT(select.options.count, 4);
    GH_ASSERT_EQUAL_OBJECTS(select.options[1][@"label"], @"Hack the North");
    GH_ASSERT_EQUAL_OBJECTS(select.value, @""); // "Select an option" means nothing is chosen

    GHFakeAXNode *web = Node(@"AXWebArea", nil, 0, 0, 800, 600);
    GHFakeAXNode *closed = [web addChild:Node(@"AXPopUpButton", @"Province", 10, 10, 300, 30)]; // Safari: no menu until opened
    closed.value = @"Ontario";
    GHFakeAXNode *huge = [web addChild:Node(@"AXPopUpButton", @"Country", 10, 60, 300, 30)];
    GHFakeAXNode *menu = [huge addChild:Node(@"AXMenu", nil, 10, 60, 300, 400)];
    for (NSUInteger i = 0; i < 300; i++) [menu addChild:Node(@"AXMenuItem", [NSString stringWithFormat:@"Country %lu", (unsigned long)i], 10, 60, 300, 20)];
    GHCapture *capture = Capture([[GHFakeSafety alloc] init]);
    GHCaptureResult *lazy = [capture captureWindow:web];
    GH_ASSERT(FieldLabelled(lazy, @"Province").options == nil);
    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(lazy, @"Province").value, @"Ontario");
    GH_ASSERT(FieldLabelled(lazy, @"Country").options == nil); // too many round trips for a capture
    GH_ASSERT_EQUAL_INT([capture optionsForSelectNode:huge].count, 255); // read lazily, capped at Jev's choice limit
}

GH_TEST(capture_a_value_never_becomes_a_label) {
    GHFakeAXNode *web = Node(@"AXWebArea", nil, 0, 0, 800, 600);
    [web addChild:Text(@"Province", 10, 10)];
    GHFakeAXNode *popup = [web addChild:Node(@"AXPopUpButton", @"Ontario", 10, 34, 300, 30)]; // native popups title themselves with the selection
    popup.value = @"Ontario";
    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:web];
    GH_ASSERT_EQUAL_INT(result.fields.count, 1);
    GH_ASSERT_EQUAL_OBJECTS(result.fields[0].label, @"Province");
    GH_ASSERT_FALSE([result.fields[0].signature.lowercaseString containsString:@"ontario"]);
}

GH_TEST(capture_preceding_text_stops_at_other_fields_and_headings) {
    GHFakeAXNode *web = Node(@"AXWebArea", nil, 0, 0, 800, 600);
    [web addChild:Text(@"City", 10, 10)];
    [web addChild:Node(@"AXTextField", nil, 10, 34, 300, 30)];
    [web addChild:Node(@"AXTextField", nil, 10, 80, 300, 30)]; // "City" belongs to the field above, not to this one
    [web addChild:Node(@"AXHeading", @"Education", 10, 130, 300, 30)];
    [web addChild:Node(@"AXTextField", nil, 10, 170, 300, 30)]; // a heading is not a label
    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:web];
    NSArray *expected = @[ @"City", @"", @"" ];
    GH_ASSERT_EQUAL_OBJECTS(Labels(result, NO), expected);
    GH_ASSERT_EQUAL_OBJECTS(result.fields[2].context, @"Education");
}

GH_TEST(capture_context_keeps_the_legend_and_the_section_heading) {
    // "Voluntary Self-Identification" must reach the EEO guard even though the question sits in a titled group.
    GHFakeAXNode *web = Node(@"AXWebArea", nil, 0, 0, 800, 600);
    [web addChild:Node(@"AXHeading", @"Voluntary Self-Identification", 10, 10, 400, 30)];
    GHFakeAXNode *group = [web addChild:Node(@"AXGroup", @"How do you identify?", 10, 60, 400, 120)];
    [group addChild:Text(@"Please select one", 10, 70)];
    [group addChild:Node(@"AXTextField", nil, 10, 100, 300, 30)];
    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:web];
    GH_ASSERT_EQUAL_INT(result.fields.count, 1);
    NSString *context = result.fields[0].context;
    GH_ASSERT_MSG([context containsString:@"How do you identify?"] && [context containsString:@"Voluntary Self-Identification"], @"context: %@", context);
    GH_ASSERT(context.length <= 83);
}

GH_TEST(capture_label_cleaning_and_normalizing) {
    GH_ASSERT_EQUAL_OBJECTS([GHCapture cleanLabel:@"  First   name * "], @"First name");
    GH_ASSERT_EQUAL_OBJECTS([GHCapture cleanLabel:@"Email (required)"], @"Email");
    GH_ASSERT_EQUAL_OBJECTS([GHCapture cleanLabel:@"Phone:"], @"Phone");
    GH_ASSERT_EQUAL_OBJECTS([GHCapture cleanLabel:nil], @"");
    GH_ASSERT_EQUAL_INT([GHCapture cleanLabel:[@"" stringByPaddingToLength:500 withString:@"ab " startingAtIndex:0]].length <= 160, 1);
    GH_ASSERT_EQUAL_OBJECTS([GHCapture normalizedLabel:@"firstName"], @"first name");
    GH_ASSERT_EQUAL_OBJECTS([GHCapture normalizedLabel:@"E-mail_Address:"], @"e mail address");
}

GH_TEST(capture_reading_order_uses_rows_with_half_height_tolerance) {
    NSArray<NSArray *> *specs = @[
        @[ @"C", @(40), @(100) ], @[ @"B", @(300), @(14) ], @[ @"A", @(20), @(0) ], @[ @"D", @(300), @(108) ], @[ @"E", @(20), @(140) ],
    ];
    NSMutableArray<GHField *> *fields = [NSMutableArray array];
    for (NSArray *spec in specs) {
        GHField *field = [GHField fieldWithSignature:spec[0] label:spec[0] kind:GHKindText];
        field.rect = CGRectMake([spec[1] doubleValue], [spec[2] doubleValue], 200, 30);
        [fields addObject:field];
    }
    NSMutableArray<NSString *> *order = [NSMutableArray array];
    for (GHField *field in [GHCapture fieldsInReadingOrder:fields]) [order addObject:field.label];
    // A and B share a row (14px apart, tolerance 15). C and D share a row. E is 40px below C: next row.
    NSArray *expected = @[ @"A", @"B", @"C", @"D", @"E" ];
    GH_ASSERT_EQUAL_OBJECTS(order, expected);
}

GH_TEST(capture_limits_links_to_keep_the_state_small) {
    GHFakeAXNode *web = Node(@"AXWebArea", nil, 0, 0, 800, 6000);
    for (NSUInteger i = 0; i < 100; i++) [web addChild:Node(@"AXLink", [NSString stringWithFormat:@"Story %lu", (unsigned long)i], 10, 10 + 30 * (CGFloat)i, 200, 20)];
    [web addChild:Node(@"AXTextField", @"City", 10, 4000, 300, 30)];
    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:web];
    GH_ASSERT_EQUAL_INT(result.fields.count, 41);
    GH_ASSERT(FieldLabelled(result, @"City") != nil);
}

#pragma mark - GHAccessibility

GH_TEST(accessibility_default_pause_list) {
    GHAccessibility *accessibility = [[GHAccessibility alloc] init];
    for (NSString *bundle in @[ @"com.1password.1password", @"com.1password.safari-helper", @"com.bitwarden.desktop", @"com.lastpass.LastPass",
                                @"com.dashlane.Dashlane", @"org.keepassxc.keepassxc", @"com.apple.Terminal", @"com.googlecode.iterm2",
                                @"com.apple.keychainaccess", @"com.apple.systempreferences", @"com.apple.Passwords", @"com.apple.loginwindow",
                                @"dev.shabang.desktop", @"COM.APPLE.TERMINAL" ]) {
        GH_ASSERT_MSG([accessibility isBundleIdentifierPaused:bundle], @"%@ should be paused", bundle);
    }
    GH_ASSERT([accessibility isBundleIdentifierPaused:nil]);  // unknown app: stay out
    GH_ASSERT([accessibility isBundleIdentifierPaused:@""]);
    for (NSString *bundle in @[ @"com.apple.Safari", @"com.google.Chrome", @"org.mozilla.firefox", @"com.apple.mail" ]) {
        GH_ASSERT_MSG(![accessibility isBundleIdentifierPaused:bundle], @"%@ should not be paused", bundle);
    }
    accessibility.userPausedBundleIdentifiers = [NSSet setWithObject:@"com.apple.Safari"];
    GH_ASSERT([accessibility isBundleIdentifierPaused:@"com.apple.Safari"]);
    accessibility.userPausedBundleIdentifiers = [NSSet set];
    GH_ASSERT_FALSE([accessibility isBundleIdentifierPaused:@"com.apple.Safari"]);
}

GH_TEST(accessibility_chromium_and_electron_detection) {
    for (NSString *bundle in @[ @"com.google.Chrome", @"com.brave.Browser", @"com.microsoft.edgemac", @"company.thebrowser.Browser",
                                @"com.operasoftware.Opera", @"com.vivaldi.Vivaldi", @"org.chromium.Chromium" ]) {
        GH_ASSERT_MSG([GHAccessibility appNeedsEnhancedUserInterface:bundle bundleURL:nil], @"%@ is Chromium", bundle);
    }
    GH_ASSERT_FALSE([GHAccessibility appNeedsEnhancedUserInterface:@"com.apple.Safari" bundleURL:nil]);
    GH_ASSERT_FALSE([GHAccessibility appNeedsEnhancedUserInterface:nil bundleURL:nil]);

    NSString *root = GHTestTempDirectory();
    NSString *electron = [root stringByAppendingPathComponent:@"Notes.app"];
    NSString *framework = [electron stringByAppendingPathComponent:@"Contents/Frameworks/Electron Framework.framework"];
    [[NSFileManager defaultManager] createDirectoryAtPath:framework withIntermediateDirectories:YES attributes:nil error:NULL];
    // Spotify and friends are CEF, not Electron. Detecting only Electron left them at 15 accessibility nodes.
    NSString *cef = [root stringByAppendingPathComponent:@"Player.app"];
    NSString *cefFramework = [cef stringByAppendingPathComponent:@"Contents/Frameworks/Chromium Embedded Framework.framework"];
    [[NSFileManager defaultManager] createDirectoryAtPath:cefFramework withIntermediateDirectories:YES attributes:nil error:NULL];
    NSString *native = [root stringByAppendingPathComponent:@"Native.app"];
    [[NSFileManager defaultManager] createDirectoryAtPath:[native stringByAppendingPathComponent:@"Contents/Frameworks"] withIntermediateDirectories:YES attributes:nil error:NULL];
    GH_ASSERT([GHAccessibility bundleAtURLUsesChromium:[NSURL fileURLWithPath:electron]]);
    GH_ASSERT([GHAccessibility appNeedsEnhancedUserInterface:@"com.example.notes" bundleURL:[NSURL fileURLWithPath:electron]]);
    GH_ASSERT([GHAccessibility bundleAtURLUsesChromium:[NSURL fileURLWithPath:cef]]);
    GH_ASSERT([GHAccessibility appNeedsEnhancedUserInterface:@"com.example.player" bundleURL:[NSURL fileURLWithPath:cef]]);
    GH_ASSERT_FALSE([GHAccessibility bundleAtURLUsesChromium:[NSURL fileURLWithPath:native]]);
    GH_ASSERT_FALSE([GHAccessibility bundleAtURLUsesChromium:nil]);
}

GH_TEST(accessibility_notification_reasons) {
    GH_ASSERT_EQUAL_INT([GHAccessibility reasonForNotification:(__bridge NSString *)kAXFocusedWindowChangedNotification], GHRescanReasonWindowChanged);
    GH_ASSERT_EQUAL_INT([GHAccessibility reasonForNotification:(__bridge NSString *)kAXFocusedUIElementChangedNotification], GHRescanReasonFocusChanged);
    GH_ASSERT_EQUAL_INT([GHAccessibility reasonForNotification:(__bridge NSString *)kAXValueChangedNotification], GHRescanReasonValueChanged);
    GH_ASSERT_EQUAL_INT([GHAccessibility reasonForNotification:(__bridge NSString *)kAXLayoutChangedNotification], GHRescanReasonLayoutChanged);
    GH_ASSERT_EQUAL_INT([GHAccessibility reasonForNotification:(__bridge NSString *)kAXWindowMovedNotification], GHRescanReasonWindowGeometry);
    GH_ASSERT_EQUAL_INT([GHAccessibility reasonForNotification:(__bridge NSString *)kAXWindowResizedNotification], GHRescanReasonWindowGeometry);
    GH_ASSERT_EQUAL_INT([GHAccessibility reasonForNotification:(__bridge NSString *)kAXUIElementDestroyedNotification], GHRescanReasonElementGone);
    GH_ASSERT_EQUAL_INT([GHAccessibility reasonForNotification:@"AXSomethingElse"], GHRescanReasonNone);
    for (NSString *notification in [GHAccessibility observedNotifications]) {
        GH_ASSERT_MSG([GHAccessibility reasonForNotification:notification] != GHRescanReasonNone, @"%@ is observed but means nothing", notification);
    }
}

GH_TEST(accessibility_debouncer_coalesces_a_burst_into_one_call) {
    GH_ASSERT_NEAR([GHDebouncer waitForBurstStartedAt:10.0 now:10.0 delay:0.15 ceiling:0.6], 0.15, 1e-9);
    GH_ASSERT_NEAR([GHDebouncer waitForBurstStartedAt:10.0 now:10.5 delay:0.15 ceiling:0.6], 0.10, 1e-9); // the ceiling wins
    GH_ASSERT_NEAR([GHDebouncer waitForBurstStartedAt:10.0 now:11.0 delay:0.15 ceiling:0.6], 0.0, 1e-9);

    __block NSUInteger calls = 0;
    __block NSUInteger seen = 0;
    GHDebouncer *debouncer = [[GHDebouncer alloc] initWithDelay:0.05 ceiling:0.3 handler:^(NSUInteger flags) {
        calls++;
        seen = flags;
    }];
    [debouncer poke:GHRescanReasonValueChanged];
    [debouncer poke:GHRescanReasonLayoutChanged];
    [debouncer poke:GHRescanReasonFocusChanged];
    GH_ASSERT(debouncer.pending);
    GH_ASSERT_EQUAL_INT(calls, 0);
    GH_ASSERT(GHTestWaitUntil(1.0, ^BOOL { return calls > 0; }));
    GHTestWaitUntil(0.15, ^BOOL { return NO; }); // no second call trailing behind
    GH_ASSERT_EQUAL_INT(calls, 1);
    GH_ASSERT_EQUAL_INT(seen, GHRescanReasonValueChanged | GHRescanReasonLayoutChanged | GHRescanReasonFocusChanged);
    GH_ASSERT_FALSE(debouncer.pending);

    [debouncer poke:GHRescanReasonManual];
    [debouncer cancel];
    GHTestWaitUntil(0.15, ^BOOL { return NO; });
    GH_ASSERT_EQUAL_INT(calls, 1);
}

@interface GHFakeAccessibilityDelegate : NSObject <GHAccessibilityDelegate>
@property (nonatomic) NSUInteger trustChanges;
@property (nonatomic) GHTrustState lastTrust;
@end
@implementation GHFakeAccessibilityDelegate
- (void)accessibility:(GHAccessibility *)accessibility trustDidChange:(GHTrustState)state {
    self.trustChanges++;
    self.lastTrust = state;
}
@end

GH_TEST(accessibility_untrusted_state_attempts_nothing) {
    GHAccessibility *accessibility = [[GHAccessibility alloc] init];
    GHFakeAccessibilityDelegate *delegate = [[GHFakeAccessibilityDelegate alloc] init];
    accessibility.delegate = delegate;
    accessibility.trustProbe = ^BOOL { return NO; };
    GH_ASSERT_EQUAL_INT(accessibility.trustState, GHTrustStateUnknown);
    [accessibility start];
    GH_ASSERT(accessibility.running);
    GH_ASSERT_EQUAL_INT(accessibility.trustState, GHTrustStateUntrusted);
    GH_ASSERT_FALSE(accessibility.trusted);
    GH_ASSERT_EQUAL_INT(delegate.trustChanges, 1);
    GH_ASSERT_EQUAL_INT(delegate.lastTrust, GHTrustStateUntrusted);
    GH_ASSERT_EQUAL_OBJECTS(accessibility.statusLine, @"Needs Accessibility permission");
    GH_ASSERT_FALSE(accessibility.observing);
    GH_ASSERT([accessibility focusedWindowNode] == nil);
    GH_ASSERT([accessibility focusedElementNode] == nil);
    GH_ASSERT([accessibility focusedWindowTitle] == nil);
    GH_ASSERT([accessibility captureFocusedWindowWithCapture:Capture([[GHFakeSafety alloc] init])] == nil);
    [accessibility stop];
    GH_ASSERT_FALSE(accessibility.running);
    [accessibility stop]; // idempotent
}

GH_TEST(capture_safari_tab_group_discovers_page_without_returning_chrome) {
    GHFakeAXNode *window = Node(@"AXWindow", nil, 0, 0, 800, 600);
    GHFakeAXNode *tabs = [window addChild:Node(@"AXTabGroup", nil, 0, 0, 800, 600)];
    [tabs addChild:Radio(@"Private browser tab", YES, 0, 0)];
    [tabs addChild:Node(@"AXTextField", @"Browser search", 0, 40, 200, 30)];
    GHFakeAXNode *scroll = [tabs addChild:Node(@"AXScrollArea", nil, 0, 100, 800, 500)];
    GHFakeAXNode *web = [scroll addChild:Node(@"AXWebArea", nil, 0, 100, 800, 500)];
    [web addChild:Node(@"AXTextField", @"First name", 10, 120, 300, 30)];
    [web addChild:Node(@"AXButton", @"Submit application", 10, 170, 300, 30)];

    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:window];
    GH_ASSERT(result.sawWebArea);
    GH_ASSERT_EQUAL_INT(result.fields.count, 2);
    GH_ASSERT(FieldLabelled(result, @"First name") != nil);
    GH_ASSERT(FieldLabelled(result, @"Submit application").locked);
    GH_ASSERT_FALSE([DumpJSON(result) containsString:@"Private browser tab"]);
    GH_ASSERT_FALSE([DumpJSON(result) containsString:@"Browser search"]);

    GHCapture *limited = Capture([[GHFakeSafety alloc] init]);
    limited.limits.maxNodes = 4; // stop before AXWebArea: provisional browser controls must fail closed
    GHCaptureResult *partial = [limited captureWindow:window];
    GH_ASSERT(partial.partial);
    GH_ASSERT_EQUAL_INT(partial.fields.count, 0);

    // AXTabGroup is also a normal native-app container. A complete walk with no web area keeps it.
    GHFakeAXNode *nativeWindow = Node(@"AXWindow", nil, 0, 0, 800, 600);
    GHFakeAXNode *nativeTabs = [nativeWindow addChild:Node(@"AXTabGroup", nil, 0, 0, 800, 600)];
    [nativeTabs addChild:Node(@"AXTextField", @"Project title", 10, 40, 300, 30)];
    GHCaptureResult *nativeResult = [Capture([[GHFakeSafety alloc] init]) captureWindow:nativeWindow];
    GH_ASSERT_FALSE(nativeResult.sawWebArea);
    GH_ASSERT(FieldLabelled(nativeResult, @"Project title") != nil);
}

#pragma mark - Browser chrome

GH_TEST(capture_never_turns_tab_bar_items_or_the_address_field_into_fields) {
    // A browser window whose page has no web area yet (a start page), walked completely: without the chrome
    // rules the tab items would be one radio group and the address field a text field.
    GHFakeAXNode *window = Node(@"AXWindow", nil, 0, 0, 800, 600);
    GHFakeAXNode *tabs = [window addChild:Node(@"AXTabGroup", nil, 0, 0, 800, 600)];
    GHFakeAXNode *first = [tabs addChild:Radio(@"Private tab one", YES, 0, 0)];
    first.subrole = @"AXTabButton";
    GHFakeAXNode *second = [tabs addChild:Radio(@"Private tab two", NO, 200, 0)];
    second.subrole = @"AXTabButton";
    GHFakeAXNode *address = [window addChild:Node(@"AXTextField", @"Smart Search field", 100, 40, 500, 30)];
    address.identifier = @"WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD";
    [tabs addChild:Node(@"AXTextField", @"Notes", 10, 100, 300, 30)];

    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:window];
    GH_ASSERT_FALSE(result.partial);
    GH_ASSERT_EQUAL_OBJECTS(Labels(result, NO), (@[ @"Notes" ]));
    GH_ASSERT_FALSE([DumpJSON(result) containsString:@"Private tab"]);
    GH_ASSERT_FALSE([DumpJSON(result) containsString:@"radio"]);

    // Inside a web area the same identifier is the page's business (an app may use any id it likes).
    GHFakeAXNode *page = Node(@"AXWebArea", nil, 0, 0, 800, 600);
    GHFakeAXNode *field = [page addChild:Node(@"AXTextField", @"Search our jobs", 10, 10, 300, 30)];
    field.identifier = @"WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD";
    GH_ASSERT(FieldLabelled([Capture([[GHFakeSafety alloc] init]) captureWindow:page], @"Search our jobs") != nil);
}

#pragma mark - Real-form rules

GH_TEST(capture_label_prefers_title_then_description_then_title_element) {
    GHFakeAXNode *web = Node(@"AXWebArea", nil, 0, 0, 800, 600);
    GHFakeAXNode *titled = [web addChild:Node(@"AXTextField", @"First Name", 10, 10, 300, 30)];
    titled.axDescription = @"Given name (description)";
    titled.titleUIElement = [GHFakeAXNode staticText:@"First Name *" frame:CGRectZero];
    GHFakeAXNode *described = [web addChild:Node(@"AXTextField", nil, 10, 60, 300, 30)];
    described.axDescription = @"Last Name";
    described.titleUIElement = [GHFakeAXNode staticText:@"Surname label" frame:CGRectZero];
    GHFakeAXNode *labelled = [web addChild:Node(@"AXTextField", nil, 10, 110, 300, 30)];
    labelled.titleUIElement = [GHFakeAXNode staticText:@"Email *" frame:CGRectZero];

    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:web];
    GH_ASSERT_EQUAL_OBJECTS(Labels(result, NO), (@[ @"First Name", @"Last Name", @"Email" ]));
    GH_ASSERT(FieldLabelled(result, @"Email").required); // the asterisk of the title element still counts
}

GH_TEST(capture_profile_site_labels_are_url_fields) {
    GHFakeAXNode *web = Node(@"AXWebArea", nil, 0, 0, 800, 800);
    NSArray<NSString *> *urls = @[ @"LinkedIn Profile", @"Github", @"GitHub URL", @"Website", @"Portfolio link", @"Personal website" ];
    NSArray<NSString *> *texts = @[ @"GitHub username", @"How did you hear about us (LinkedIn, a friend...)?", @"LinkedIn headline" ];
    CGFloat y = 10;
    for (NSString *label in [urls arrayByAddingObjectsFromArray:texts]) {
        [web addChild:Node(@"AXTextField", label, 10, y, 300, 30)];
        y += 40;
    }
    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:web];
    for (NSString *label in urls) GH_ASSERT_MSG([FieldLabelled(result, label).kind isEqualToString:GHKindURL], @"%@ should be a url field", label);
    for (NSString *label in texts) GH_ASSERT_MSG([FieldLabelled(result, label).kind isEqualToString:GHKindText], @"%@ should stay text", label);
}

/// react-select as WebKit exposes it: label text, a 2 px live region, the placeholder (or chosen value) group,
/// the 4 px input (AXComboBox) and the "Toggle flyout" button, all siblings.
static GHFakeAXNode *ReactSelect(GHFakeAXNode *parent, NSString *label, CGFloat y, NSString *_Nullable chosen) {
    [parent addChild:Text(label, 16, y)];
    GHFakeAXNode *live = [parent addChild:Node(@"AXGroup", nil, 0, y + 18, 2, 2)];
    live.subrole = @"AXEmptyGroup";
    GHFakeAXNode *shown = [parent addChild:Node(@"AXGroup", nil, 16, y + 22, 537, 21)];
    shown.domClassList = chosen ? @[ @"select__single-value" ] : @[ @"select__placeholder" ];
    [shown addChild:Text(chosen ?: @"Select...", 16, y + 22)];
    GHFakeAXNode *combo = [parent addChild:Node(@"AXComboBox", label, 16, y + 22, 4, 21)];
    combo.axDescription = label;
    combo.value = @"";
    [parent addChild:Node(@"AXButton", @"Toggle flyout", 568, y + 12, 25, 25)];
    return combo;
}

GH_TEST(capture_react_select_is_one_lazy_select_with_a_visible_box) {
    GHFakeAXNode *web = Node(@"AXWebArea", nil, 0, 0, 800, 800);
    GHFakeAXNode *form = [web addChild:Node(@"AXGroup", nil, 0, 0, 800, 800)];
    ReactSelect(form, @"How did you hear about us?", 10, nil);
    ReactSelect(form, @"Country", 100, @"Canada");
    // A native combo box that lists its options keeps them and is not lazy.
    GHFakeAXNode *native = [form addChild:Node(@"AXComboBox", @"Size", 16, 200, 200, 24)];
    GHFakeAXNode *list = [native addChild:Node(@"AXList", nil, 16, 224, 200, 60)];
    for (NSString *item in @[ @"Small", @"Large" ]) [list addChild:Text(item, 16, 230)];

    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:web];
    GH_ASSERT_EQUAL_OBJECTS(Labels(result, NO), (@[ @"How did you hear about us?", @"Country", @"Size" ]));
    GHField *heard = FieldLabelled(result, @"How did you hear about us?");
    GH_ASSERT_EQUAL_OBJECTS(heard.kind, GHKindSelect);
    GH_ASSERT(heard.lazyOptions);
    GH_ASSERT(heard.options == nil);
    GH_ASSERT_EQUAL_OBJECTS(heard.value, @"");
    GH_ASSERT_EQUAL_INT((NSInteger)heard.rect.origin.x, 16);
    GH_ASSERT_EQUAL_INT((NSInteger)CGRectGetMaxX(heard.rect), 593); // placeholder + toggle: the box the user sees
    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(result, @"Country").value, @"Canada"); // chosen: a filled select
    GH_ASSERT_FALSE(FieldLabelled(result, @"Size").lazyOptions);
    GH_ASSERT_EQUAL_INT(FieldLabelled(result, @"Size").options.count, 2);
    GH_ASSERT_FALSE([DumpJSON(result) containsString:@"Toggle flyout"]);
    GH_ASSERT([[heard toJSONObject][@"lazyOptions"] isEqual:@YES]);
}

GH_TEST(capture_toggle_after_an_unrelated_field_stays_a_button) {
    GHFakeAXNode *web = Node(@"AXWebArea", nil, 0, 0, 800, 800);
    GHFakeAXNode *combo = [web addChild:Node(@"AXComboBox", @"Team", 16, 10, 4, 21)];
    combo.value = @"";
    [web addChild:Node(@"AXTextField", @"Notes", 100, 10, 300, 21)];
    [web addChild:Node(@"AXButton", @"Toggle flyout", 500, 10, 25, 25)];
    [web addChild:Node(@"AXButton", @"Open menu", 16, 400, 25, 25)]; // not next to any combo box
    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:web];
    GH_ASSERT(FieldLabelled(result, @"Toggle flyout") != nil);
    GH_ASSERT(FieldLabelled(result, @"Open menu") != nil);
}

GH_TEST(capture_ignores_a_sites_own_autofill_button) {
    GHFakeAXNode *web = Node(@"AXWebArea", nil, 0, 0, 800, 800);
    [web addChild:Node(@"AXButton", @"Autofill my application", 10, 10, 200, 40)];
    [web addChild:Node(@"AXButton", @"Auto-fill with resume", 10, 60, 200, 40)];
    [web addChild:Node(@"AXTextField", @"First Name", 10, 110, 300, 30)];
    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:web];
    GH_ASSERT_EQUAL_OBJECTS(Labels(result, NO), (@[ @"First Name" ]));
}

#pragma mark - File uploads

/// Greenhouse's upload widget: a named group, its label, Attach + the 2 px file input, cloud alternatives.
static GHFakeAXNode *UploadWidget(GHFakeAXNode *parent, NSString *title, NSString *identifier, CGFloat y, NSString *_Nullable attached) {
    GHFakeAXNode *widget = [parent addChild:Node(@"AXGroup", title, 300, y, 853, 252)];
    widget.subrole = @"AXApplicationGroup";
    widget.axDescription = title;
    widget.domClassList = @[ @"file-upload" ];
    GHFakeAXNode *label = [widget addChild:Node(@"AXGroup", nil, 300, y, 853, 19)];
    [label addChild:Text(title, 300, y)];
    GHFakeAXNode *row = [widget addChild:Node(@"AXGroup", nil, 300, y + 30, 301, 51)];
    [row addChild:Node(@"AXButton", @"Attach", 300, y + 30, 301, 43)];
    GHFakeAXNode *input = [row addChild:Node(@"AXButton", nil, 599, y + 29, 2, 2)];
    input.subrole = @"AXFileUploadButton";
    input.roleDescription = @"file upload button";
    input.identifier = identifier;
    for (NSString *alternative in @[ @"Dropbox", @"Google Drive", @"Enter manually" ]) {
        GHFakeAXNode *wrap = [widget addChild:Node(@"AXGroup", nil, 300, y + 80, 301, 51)];
        [wrap addChild:Node(@"AXButton", alternative, 300, y + 80, 301, 43)];
        y += 50;
    }
    if (attached) {
        GHFakeAXNode *chip = [widget addChild:Node(@"AXGroup", nil, 300, y + 90, 301, 22)];
        [chip addChild:Text(attached, 300, y + 90)];
        [chip addChild:Node(@"AXButton", @"Remove file", 560, y + 90, 22, 22)];
    }
    [widget addChild:Text(@"Accepted file types: pdf, doc, docx, txt, rtf", 300, y + 120)];
    return input;
}

GH_TEST(capture_upload_widget_is_one_file_field_acted_on_through_attach) {
    GHFakeAXNode *web = Node(@"AXWebArea", nil, 0, 0, 1400, 2000);
    GHFakeAXNode *form = [web addChild:Node(@"AXGroup", nil, 0, 0, 1400, 2000)];
    [form addChild:Node(@"AXTextField", @"Email", 300, 10, 600, 35)];
    GHFakeAXNode *resume = UploadWidget(form, @"Resume/CV", @"resume", 100, nil);
    UploadWidget(form, @"Cover Letter", @"cover_letter", 400, @"letter-draft.pdf");
    [form addChild:Node(@"AXButton", @"Submit application", 900, 900, 190, 41)];

    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:web];
    GH_ASSERT_EQUAL_OBJECTS(Labels(result, NO), (@[ @"Email", @"Resume/CV", @"Cover Letter", @"Submit application" ]));
    GHField *file = FieldLabelled(result, @"Resume/CV");
    GH_ASSERT_EQUAL_OBJECTS(file.kind, GHKindFile);
    GH_ASSERT_EQUAL_OBJECTS(file.uploadKind, GHUploadKindResume);
    GH_ASSERT_EQUAL_OBJECTS(file.identifier, @"resume");
    GH_ASSERT_EQUAL_OBJECTS(file.value, @"");
    GH_ASSERT_EQUAL_INT((NSInteger)file.rect.size.width, 301); // the visible Attach button, not the 2 px input
    GHFakeAXNode *attach = (GHFakeAXNode *)[result nodeForSignature:file.signature];
    GH_ASSERT_EQUAL_OBJECTS(attach.title, @"Attach");
    GH_ASSERT([result uploadNodeForSignature:file.signature] == resume);
    GH_ASSERT([file.signature containsString:@"AXFileUploadButton"]);

    GHField *letter = FieldLabelled(result, @"Cover Letter");
    GH_ASSERT_EQUAL_OBJECTS(letter.uploadKind, GHUploadKindCoverLetter);
    GH_ASSERT_EQUAL_OBJECTS(letter.value, @"letter-draft.pdf"); // already attached: filled, never offered again
    GH_ASSERT_FALSE([[letter toWireJSONObject] objectForKey:@"value"] != nil);
    for (NSString *swallowed in @[ @"Attach", @"Dropbox", @"Google Drive", @"Enter manually", @"Remove file" ]) {
        GH_ASSERT_MSG(FieldLabelled(result, swallowed) == nil, @"%@ must be part of the upload field", swallowed);
    }
    GH_ASSERT(FieldLabelled(result, @"Submit application").locked);
}

GH_TEST(capture_upload_label_sources_and_boundaries) {
    GHFakeAXNode *web = Node(@"AXWebArea", nil, 0, 0, 1400, 2000);
    // A bare <label for=cv>Curriculum vitae</label><input type=file>: the browser's "Choose File" never names it.
    GHFakeAXNode *bare = [web addChild:Node(@"AXButton", @"Choose File", 10, 10, 120, 24)];
    bare.subrole = @"AXFileUploadButton";
    bare.titleUIElement = [GHFakeAXNode staticText:@"Curriculum vitae" frame:CGRectZero];
    // A wrapper that also holds a text field is NOT the upload's widget: the field stays, the input stands alone.
    GHFakeAXNode *mixed = [web addChild:Node(@"AXGroup", nil, 10, 100, 600, 200)];
    [mixed addChild:Node(@"AXTextField", @"Portfolio URL", 10, 100, 300, 30)];
    GHFakeAXNode *other = [mixed addChild:Node(@"AXButton", @"Writing sample", 10, 150, 200, 30)];
    other.subrole = @"AXFileUploadButton";
    other.identifier = @"attachment_3";

    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:web];
    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(result, @"Curriculum vitae").uploadKind, GHUploadKindResume);
    GH_ASSERT([result nodeForSignature:FieldLabelled(result, @"Curriculum vitae").signature] == bare); // no Attach: the input itself
    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(result, @"Portfolio URL").kind, GHKindURL);
    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(result, @"Writing sample").uploadKind, GHUploadKindOther);
}

GH_TEST(capture_sensitive_upload_is_dropped_with_its_widget) {
    GHFakeAXNode *web = Node(@"AXWebArea", nil, 0, 0, 1400, 2000);
    UploadWidget(web, @"Passport scan", @"passport", 100, nil);
    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:web];
    GH_ASSERT_EQUAL_INT(result.fields.count, 0);
    GH_ASSERT_FALSE([DumpJSON(result) containsString:@"Passport"]);
}

#pragma mark - Dump-tree loader

GH_TEST(axnode_dump_tree_loader_rebuilds_nodes_without_values) {
    NSDictionary *dump = @{ @"tree": @{
        @"role": @"AXWindow", @"rect": @{ @"x": @0, @"y": @34, @"width": @800, @"height": @600 },
        @"children": @[
            @{ @"role": @"AXStaticText", @"text": @"First Name", @"identifier": @"first_name-label" },
            @{ @"role": @"AXTextField", @"title": @"First Name", @"description": @"Given", @"identifier": @"first_name",
               @"roleDescription": @"text field", @"valueLength": @3, @"required": @YES, @"classes": @[ @"input", @4 ],
               @"labelledBy": @"First Name", @"actions": @[ @"AXPress" ], @"rect": @{ @"x": @1, @"y": @2, @"width": @3, @"height": @4 } },
            @{ @"role": @"AXTextField", @"title": @"Card number", @"sensitive": @YES, @"enabled": @NO, @"focused": @YES },
            @{ @"note": @"no role: dropped" },
        ] } };
    GHFakeAXNode *window = [GHFakeAXNode nodeWithDumpTree:dump];
    GH_ASSERT(window != nil);
    GH_ASSERT_EQUAL_OBJECTS(window.role, @"AXWindow");
    GH_ASSERT_EQUAL_INT((NSInteger)window.frame.origin.y, 34);
    GH_ASSERT_EQUAL_INT(window.children.count, 3);
    GHFakeAXNode *label = (GHFakeAXNode *)window.children[0], *field = (GHFakeAXNode *)window.children[1], *card = (GHFakeAXNode *)window.children[2];
    GH_ASSERT_EQUAL_OBJECTS(label.value, @"First Name");
    GH_ASSERT_EQUAL_OBJECTS(field.value, @"xxx"); // length only, never the real value
    GH_ASSERT_EQUAL_OBJECTS(field.axDescription, @"Given");
    GH_ASSERT_EQUAL_OBJECTS(field.domClassList, (@[ @"input" ]));
    GH_ASSERT_EQUAL_OBJECTS(field.titleUIElement.value, @"First Name");
    GH_ASSERT(field.required);
    GH_ASSERT(field.parent == window);
    GH_ASSERT(CGRectEqualToRect(field.frame, CGRectMake(1, 2, 3, 4)));
    GH_ASSERT(card.value == nil);
    GH_ASSERT_FALSE(card.enabled);
    GH_ASSERT(card.isFocused);
    // A bare node works too; garbage does not.
    GH_ASSERT_EQUAL_OBJECTS([GHFakeAXNode nodeWithDumpTree:@{ @"role": @"AXGroup" }].role, @"AXGroup");
    GH_ASSERT([GHFakeAXNode nodeWithDumpTree:@{ @"tree": @"nope" }] == nil);
    GH_ASSERT([GHFakeAXNode nodeWithDumpTree:(NSDictionary *)@[]] == nil);
    GH_ASSERT([GHFakeAXNode nodeWithDumpTreeFile:@"/nonexistent/ghost-dump.json"] == nil);
}
