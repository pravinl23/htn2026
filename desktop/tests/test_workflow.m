#import "GHTest.h"
#import "GHWorkflowCoordinator.h"

GH_TEST(workflow_context_is_compact_and_drops_sensitive_fields) {
    GHField *field = [GHField fieldWithSignature:@"reply" label:@"Reply" kind:GHKindTextArea];
    field.identifier = @"reply-box";
    NSDictionary *snapshot = [GHWorkflowContextBuilder snapshotWithApplicationName:@"Mail" bundleIdentifier:@"com.apple.mail"
                                                                        windowTitle:@"Quick chat?" focusedField:field
                                                                          nearbyText:@[ @"Can we meet Thursday?", @"Second line" ]
                                                                   safeValueToInsert:@"Thursday works" connectedToolkits:@[ @"GMail", @"googlecalendar", @"gmail" ] workflow:nil];
    GH_ASSERT_EQUAL_OBJECTS(snapshot[@"activeApplication"][@"bundleIdentifier"], @"com.apple.mail");
    GH_ASSERT_EQUAL_OBJECTS(snapshot[@"focusedElement"][@"safeValueToInsert"], @"Thursday works");
    GH_ASSERT_EQUAL_OBJECTS(snapshot[@"connectedToolkits"], (@[ @"gmail", @"googlecalendar" ]));
    GH_ASSERT(snapshot[@"timestamp"] != nil);

    GHField *card = [GHField fieldWithSignature:@"card" label:@"Card number" kind:GHKindText];
    card.value = @"4111111111111111";
    NSDictionary *sensitive = [GHWorkflowContextBuilder snapshotWithApplicationName:@"Browser" bundleIdentifier:@"com.example.browser"
                                                                         windowTitle:nil focusedField:card nearbyText:nil safeValueToInsert:@"x"
                                                                    connectedToolkits:nil workflow:nil];
    GH_ASSERT(sensitive[@"focusedElement"] == nil);
    GH_ASSERT_FALSE([[sensitive description] containsString:@"4111111111111111"]);
}

GH_TEST(workflow_context_caps_nearby_text_and_preserves_only_workflow_shape) {
    NSMutableArray *lines = [NSMutableArray array];
    for (NSInteger i = 0; i < 30; i++) [lines addObject:[NSString stringWithFormat:@"line %ld", (long)i]];
    NSDictionary *snapshot = [GHWorkflowContextBuilder snapshotWithApplicationName:@"Notes" bundleIdentifier:@"com.apple.Notes" windowTitle:nil
                                                                        focusedField:nil nearbyText:lines safeValueToInsert:nil connectedToolkits:nil
                                                                            workflow:@{ @"id": @"wf-1", @"kind": @"meeting", @"step": @"draft-response", @"status": @"active", @"secret": @"drop" }];
    GH_ASSERT_EQUAL_INT([snapshot[@"nearbyText"] count], 10);
    GH_ASSERT_EQUAL_OBJECTS(snapshot[@"workflow"], (@{ @"id": @"wf-1", @"kind": @"meeting", @"step": @"draft-response", @"status": @"active" }));
}
