#import "SBTest.h"
#import "SBWorkflowCoordinator.h"

GH_TEST(workflow_context_is_compact_and_drops_sensitive_fields) {
    SBField *field = [SBField fieldWithSignature:@"reply" label:@"Reply" kind:SBKindTextArea];
    field.identifier = @"reply-box";
    NSDictionary *snapshot = [SBWorkflowContextBuilder snapshotWithApplicationName:@"Mail" bundleIdentifier:@"com.apple.mail"
                                                                        windowTitle:@"Quick chat?" focusedField:field
                                                                          nearbyText:@[ @"Can we meet Thursday?", @"Second line" ]
                                                                   safeValueToInsert:@"Thursday works" connectedToolkits:@[ @"GMail", @"googlecalendar", @"gmail" ] workflow:nil];
    GH_ASSERT_EQUAL_OBJECTS(snapshot[@"activeApplication"][@"bundleIdentifier"], @"com.apple.mail");
    GH_ASSERT_EQUAL_OBJECTS(snapshot[@"focusedElement"][@"safeValueToInsert"], @"Thursday works");
    GH_ASSERT_EQUAL_OBJECTS(snapshot[@"connectedToolkits"], (@[ @"gmail", @"googlecalendar" ]));
    GH_ASSERT(snapshot[@"timestamp"] != nil);

    SBField *card = [SBField fieldWithSignature:@"card" label:@"Card number" kind:SBKindText];
    card.value = @"4111111111111111";
    NSDictionary *sensitive = [SBWorkflowContextBuilder snapshotWithApplicationName:@"Browser" bundleIdentifier:@"com.example.browser"
                                                                         windowTitle:nil focusedField:card nearbyText:nil safeValueToInsert:@"x"
                                                                    connectedToolkits:nil workflow:nil];
    GH_ASSERT(sensitive[@"focusedElement"] == nil);
    GH_ASSERT_FALSE([[sensitive description] containsString:@"4111111111111111"]);
}

GH_TEST(workflow_context_caps_nearby_text_and_preserves_only_workflow_shape) {
    NSMutableArray *lines = [NSMutableArray array];
    for (NSInteger i = 0; i < 30; i++) [lines addObject:[NSString stringWithFormat:@"line %ld", (long)i]];
    NSDictionary *snapshot = [SBWorkflowContextBuilder snapshotWithApplicationName:@"Notes" bundleIdentifier:@"com.apple.Notes" windowTitle:nil
                                                                        focusedField:nil nearbyText:lines safeValueToInsert:nil connectedToolkits:nil
                                                                            workflow:@{ @"id": @"wf-1", @"kind": @"meeting", @"step": @"draft-response", @"status": @"active", @"secret": @"drop" }];
    GH_ASSERT_EQUAL_INT([snapshot[@"nearbyText"] count], 10);
    GH_ASSERT_EQUAL_OBJECTS(snapshot[@"workflow"], (@{ @"id": @"wf-1", @"kind": @"meeting", @"step": @"draft-response", @"status": @"active" }));
}

GH_TEST(workflow_context_never_carries_titles_values_or_private_fields) {
    SBField *reply = [SBField fieldWithSignature:@"reply" label:@"Reply" kind:SBKindTextArea];
    reply.value = @"Half-written private reply to my manager";
    NSDictionary *snapshot = [SBWorkflowContextBuilder snapshotWithApplicationName:@"Mail" bundleIdentifier:@"com.apple.mail"
                                                                        windowTitle:@"Inbox - alex.chen@gmail.com - Q3 layoffs"
                                                                       focusedField:reply
                                                                         nearbyText:@[ @"Can we meet Thursday?", @"Call me at +1 416 555 0142", @"Card number ending 4242",
                                                                                       @"Gender identity survey", @"Write to alex@example.com" ]
                                                                  safeValueToInsert:nil connectedToolkits:nil workflow:nil];
    GH_ASSERT(snapshot[@"windowTitle"] == nil);
    GH_ASSERT(snapshot[@"focusedElement"][@"editableValue"] == nil);
    GH_ASSERT_EQUAL_OBJECTS(snapshot[@"focusedElement"][@"hasValue"], @YES);
    GH_ASSERT_EQUAL_OBJECTS(snapshot[@"nearbyText"], (@[ @"Can we meet Thursday?" ]));
    NSString *wire = [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:snapshot options:0 error:NULL] encoding:NSUTF8StringEncoding];
    for (NSString *secret in @[ @"Inbox", @"layoffs", @"gmail.com", @"Half-written", @"555 0142", @"4242", @"Gender", @"example.com" ]) {
        GH_ASSERT_MSG(![wire containsString:secret], @"%@ crossed the wire", secret);
    }

    // An EEO question (by its label or by its section) is not described at all.
    SBField *eeo = [SBField fieldWithSignature:@"g" label:@"How do you identify?" kind:SBKindSelect];
    eeo.context = @"Voluntary self-identification: gender";
    NSDictionary *withEEO = [SBWorkflowContextBuilder snapshotWithApplicationName:@"Safari" bundleIdentifier:@"com.apple.Safari" windowTitle:nil
                                                                     focusedField:eeo nearbyText:nil safeValueToInsert:nil connectedToolkits:nil workflow:nil];
    GH_ASSERT(withEEO[@"focusedElement"] == nil);
    SBField *secret = [SBField fieldWithSignature:@"p" label:@"Password" kind:SBKindText];
    secret.inputType = @"password";
    GH_ASSERT([SBWorkflowContextBuilder snapshotWithApplicationName:@"App" bundleIdentifier:@"a.b" windowTitle:nil focusedField:secret
                                                         nearbyText:nil safeValueToInsert:nil connectedToolkits:nil workflow:nil][@"focusedElement"] == nil);
}
