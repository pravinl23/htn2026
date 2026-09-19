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
    GH_ASSERT_EQUAL_OBJECTS(FieldLabelled(result, @"LinkedIn profile").kind, GHKindText);
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

GH_TEST(capture_never_enters_browser_chrome) {
    GHFakeAXNode *toolbar = nil;
    GHCaptureResult *result = [Capture([[GHFakeSafety alloc] init]) captureWindow:JobApplicationWindow(@"", &toolbar)];
    GH_ASSERT_EQUAL_INT(toolbar.childrenReadCount, 0);
    GH_ASSERT(FieldLabelled(result, @"Address and search bar") == nil);
    GH_ASSERT(FieldLabelled(result, @"Reload this page") == nil);

    // The same roles INSIDE a page are content (an ARIA toolbar or tablist) and are walked.
    GHFakeAXNode *web = Node(@"AXWebArea", nil, 0, 0, 800, 600);
    GHFakeAXNode *pageTabs = [web addChild:Node(@"AXTabGroup", nil, 0, 0, 800, 200)];
    [pageTabs addChild:Node(@"AXTextField", @"City", 10, 10, 300, 30)];
    GHCaptureResult *page = [Capture([[GHFakeSafety alloc] init]) captureWindow:web];
    GH_ASSERT(FieldLabelled(page, @"City") != nil);
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
    GH_ASSERT_MSG(core != nil, @"ghost-core.js is not loadable (run make core; DESKTOP_CORE_PATH points at it in make test)");
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
    NSDictionary *last = ghosts.lastObject;
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
    GHFakeAXNode *web = Node(@"AXWebArea", nil, 0, 0, 800, 600);
    [web addChild:Node(@"AXTextField", @"City", 10, 10, 300, 30)];
    for (NSUInteger i = 0; i < 1000; i++) [web addChild:Text(@"row", 10, 50)];
    [web addChild:Node(@"AXTextField", @"Country", 10, 100, 300, 30)];
    GHCapture *capture = Capture([[GHFakeSafety alloc] init]);
    __block NSTimeInterval now = 1000;
    capture.clock = ^NSTimeInterval { now += 0.001; return now; }; // every look at the clock costs a millisecond
    GHCaptureResult *result = [capture captureWindow:web];
    GH_ASSERT_EQUAL_INT(result.stop, GHCaptureStopTime);
    GH_ASSERT(result.partial);
    GH_ASSERT(result.visitedNodes > 50 && result.visitedNodes < 200);
    NSArray *expected = @[ @"City" ];
    GH_ASSERT_EQUAL_OBJECTS(Labels(result, NO), expected);
    GH_ASSERT(result.elapsed > 0.120);
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
                                @"dev.ghost.desktop", @"COM.APPLE.TERMINAL" ]) {
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
    NSString *native = [root stringByAppendingPathComponent:@"Native.app"];
    [[NSFileManager defaultManager] createDirectoryAtPath:[native stringByAppendingPathComponent:@"Contents/Frameworks"] withIntermediateDirectories:YES attributes:nil error:NULL];
    GH_ASSERT([GHAccessibility bundleAtURLUsesElectron:[NSURL fileURLWithPath:electron]]);
    GH_ASSERT([GHAccessibility appNeedsEnhancedUserInterface:@"com.example.notes" bundleURL:[NSURL fileURLWithPath:electron]]);
    GH_ASSERT_FALSE([GHAccessibility bundleAtURLUsesElectron:[NSURL fileURLWithPath:native]]);
    GH_ASSERT_FALSE([GHAccessibility bundleAtURLUsesElectron:nil]);
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
