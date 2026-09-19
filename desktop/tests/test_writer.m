// GHWriter against fake nodes and a fake actuator: every branch of the accept path without a single AX call.
#import "GHTest.h"
#import "GHCapture.h"
#import "GHWriter.h"

#pragma mark - helpers

static GHFakeAXNode *TextField(NSString *title) {
    GHFakeAXNode *node = [GHFakeAXNode nodeWithRole:@"AXTextField" title:title frame:CGRectMake(100, 100, 300, 30)];
    node.value = @"";
    return node;
}

static GHField *FieldFor(NSString *label, NSString *kind) {
    GHField *field = [GHField fieldWithSignature:[@"sig-" stringByAppendingString:label] label:label kind:kind];
    field.rect = CGRectMake(100, 100, 300, 30);
    return field;
}

static GHGhost *GhostFor(GHField *field, NSString *action, NSString *value) {
    GHGhost *ghost = [[GHGhost alloc] init];
    ghost.signature = field.signature;
    ghost.action = action;
    ghost.value = value;
    ghost.displayText = value;
    ghost.confidence = 0.95;
    return ghost;
}

static GHWriter *Writer(GHFakeAXActuator *actuator) {
    GHWriter *writer = [[GHWriter alloc] initWithActuator:actuator];
    writer.after = ^(NSTimeInterval delay, dispatch_block_t block) { block(); };   // no waiting in tests
    writer.isNodeSensitive = ^BOOL(id<GHAXNode> node) {
        return [GHCapture nativeLooksSensitive:node.title] || [GHCapture nativeLooksSensitive:node.axDescription] || [GHCapture nativeLooksSensitive:node.identifier];
    };
    return writer;
}

static GHWriteResult *Run(GHWriter *writer, GHGhost *ghost, GHField *field, id<GHAXNode> node, id<GHAXNode> option) {
    __block GHWriteResult *result = nil;
    __block int calls = 0;
    [writer executeGhost:ghost field:field node:node optionNode:option completion:^(GHWriteResult *r) { result = r; calls++; }];
    if (calls != 1) return nil;   // the completion runs exactly once
    return result;
}

#pragma mark - fill

GH_TEST(writer_fill_sets_the_value_and_verifies) {
    GHFakeAXActuator *actuator = [[GHFakeAXActuator alloc] init];
    GHWriter *writer = Writer(actuator);
    GHFakeAXNode *node = TextField(@"First name");
    GHField *field = FieldFor(@"First name", GHKindText);
    GHWriteResult *result = Run(writer, GhostFor(field, GHGhostActionFill, @"Alex"), field, node, nil);
    GH_ASSERT(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.method, GHWriteMethodValue);
    GH_ASSERT_EQUAL_OBJECTS(node.value, @"Alex");
    GH_ASSERT(node.isFocused);                       // focus went to the field first
    GH_ASSERT_EQUAL_INT(actuator.typeCount, 0);      // no key events when AXValue held
    GH_ASSERT_EQUAL_INT(actuator.pressedNodes.count, 0);
    GH_ASSERT_FALSE(writer.busy);
}

GH_TEST(writer_fill_accepts_the_pages_own_spelling) {
    GHFakeAXActuator *actuator = [[GHFakeAXActuator alloc] init];
    actuator.reformat = ^NSString *(NSString *value) { return @"(519) 555-0142"; };   // a phone mask that drops the country code
    GHFakeAXNode *node = TextField(@"Phone");
    GHField *field = FieldFor(@"Phone", GHKindTel);
    GHWriteResult *result = Run(Writer(actuator), GhostFor(field, GHGhostActionFill, @"+1 519 555 0142"), field, node, nil);
    GH_ASSERT(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.method, GHWriteMethodValue);

    GH_ASSERT([GHWriter value:@"ALEX.CHEN@EXAMPLE.COM " holds:@"alex.chen@example.com"]);
    GH_ASSERT([GHWriter value:@"N2L 3G1" holds:@"n2l3g1"]);
    GH_ASSERT_FALSE([GHWriter value:@"" holds:@"Alex"]);
    GH_ASSERT_FALSE([GHWriter value:nil holds:@"Alex"]);
    GH_ASSERT_FALSE([GHWriter value:@"Al" holds:@"Alexander Chen"]);      // too little of it
    GH_ASSERT_FALSE([GHWriter value:@"Jordan" holds:@"Alex"]);            // unrelated content
    GH_ASSERT([GHWriter value:@"--" holds:@"--"]);
    GH_ASSERT_FALSE([GHWriter value:@"-" holds:@"--"]);                   // nothing but punctuation: exact only
    GH_ASSERT_EQUAL_OBJECTS([GHWriter comparable:@" +1 (519) 555-0142 "], @"15195550142");
}

GH_TEST(writer_fill_falls_back_to_typing_when_the_value_does_not_stick) {
    GHFakeAXActuator *actuator = [[GHFakeAXActuator alloc] init];
    actuator.valueSticks = NO;                       // a React input that reverts programmatic writes
    GHFakeAXNode *node = TextField(@"Email");
    GHField *field = FieldFor(@"Email", GHKindEmail);
    GHWriteResult *result = Run(Writer(actuator), GhostFor(field, GHGhostActionFill, @"alex.chen@example.com"), field, node, nil);
    GH_ASSERT(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.method, GHWriteMethodTyping);
    GH_ASSERT_EQUAL_OBJECTS(node.value, @"alex.chen@example.com");
    GH_ASSERT_EQUAL_INT(actuator.setValueCount, 1);
    GH_ASSERT_EQUAL_INT(actuator.replaceSelectionCount, 1);   // the cheap middle step was tried and refused
    GH_ASSERT_EQUAL_INT(actuator.typeCount, 1);
}

GH_TEST(writer_fill_uses_selected_text_before_typing_when_the_app_supports_it) {
    GHFakeAXActuator *actuator = [[GHFakeAXActuator alloc] init];
    actuator.valueSticks = NO;
    actuator.selectedTextSticks = YES;
    GHFakeAXNode *node = TextField(@"City");
    GHField *field = FieldFor(@"City", GHKindText);
    GHWriteResult *result = Run(Writer(actuator), GhostFor(field, GHGhostActionFill, @"Waterloo"), field, node, nil);
    GH_ASSERT(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.method, GHWriteMethodSelectedText);
    GH_ASSERT_EQUAL_INT(actuator.typeCount, 0);
}

GH_TEST(writer_fill_reports_failure_when_even_typing_does_not_hold) {
    GHFakeAXActuator *actuator = [[GHFakeAXActuator alloc] init];
    actuator.valueSticks = NO;
    actuator.typingSticks = NO;
    GHFakeAXNode *node = TextField(@"Email");
    GHField *field = FieldFor(@"Email", GHKindEmail);
    GHWriter *writer = Writer(actuator);
    GHWriteResult *result = Run(writer, GhostFor(field, GHGhostActionFill, @"alex.chen@example.com"), field, node, nil);
    GH_ASSERT(result != nil && !result.ok);
    GH_ASSERT_FALSE(result.refused);                 // something was tried: the controller stops the walk
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHWriteReasonDidNotHold);
    GH_ASSERT_EQUAL_OBJECTS(result.method, GHWriteMethodTyping);
    GH_ASSERT_EQUAL_OBJECTS(node.value, @"");
    GH_ASSERT_FALSE(writer.busy);
}

GH_TEST(writer_never_types_into_something_that_is_not_focused) {
    GHFakeAXActuator *actuator = [[GHFakeAXActuator alloc] init];
    actuator.valueSticks = NO;
    actuator.focusWorks = NO;                        // the app ignores AXFocused: key events would land somewhere else
    GHFakeAXNode *other = TextField(@"Search");
    other.isFocused = YES;
    actuator.focusedNode = other;
    GHFakeAXNode *node = TextField(@"Email");
    GHField *field = FieldFor(@"Email", GHKindEmail);
    GHWriteResult *result = Run(Writer(actuator), GhostFor(field, GHGhostActionFill, @"alex.chen@example.com"), field, node, nil);
    GH_ASSERT(result != nil && !result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHWriteReasonNotFocused);
    GH_ASSERT_EQUAL_INT(actuator.typeCount, 0);
    GH_ASSERT_EQUAL_OBJECTS(other.value, @"");       // nothing leaked into the focused search box
}

GH_TEST(writer_never_overwrites_a_value) {
    GHFakeAXActuator *actuator = [[GHFakeAXActuator alloc] init];
    GHFakeAXNode *node = TextField(@"First name");
    node.value = @" ";                               // whitespace counts: the user typed it
    GHField *field = FieldFor(@"First name", GHKindText);
    GHWriteResult *result = Run(Writer(actuator), GhostFor(field, GHGhostActionFill, @"Alex"), field, node, nil);
    GH_ASSERT(result != nil && !result.ok && result.refused);
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHWriteReasonHasValue);
    GH_ASSERT_EQUAL_OBJECTS(node.value, @" ");
    GH_ASSERT_EQUAL_INT(actuator.setValueCount + actuator.typeCount + actuator.focusCount, 0);
}

#pragma mark - refusals

GH_TEST(writer_refuses_locked_targets_and_never_presses_a_button) {
    GHFakeAXActuator *actuator = [[GHFakeAXActuator alloc] init];
    GHWriter *writer = Writer(actuator);
    GHFakeAXNode *button = [GHFakeAXNode nodeWithRole:@"AXButton" title:@"Submit application" frame:CGRectMake(100, 400, 160, 32)];
    GHField *field = FieldFor(@"Submit application", GHKindButton);
    field.locked = YES;
    GHGhost *lock = GhostFor(field, GHGhostActionClick, nil);
    lock.locked = YES;
    GHWriteResult *result = Run(writer, lock, field, button, nil);
    GH_ASSERT(result != nil && !result.ok && result.refused);
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHWriteReasonLocked);

    // Whatever the ghost claims to be: a fill aimed at a button, an unlocked click, a locked field.
    GH_ASSERT_EQUAL_OBJECTS(Run(writer, GhostFor(field, GHGhostActionFill, @"x"), field, button, nil).reason, GHWriteReasonLocked);
    GHField *plainButton = FieldFor(@"Next", GHKindButton);
    GH_ASSERT_EQUAL_OBJECTS(Run(writer, GhostFor(plainButton, GHGhostActionClick, nil), plainButton, button, nil).reason, GHWriteReasonLocked);
    GH_ASSERT_EQUAL_INT(actuator.pressedNodes.count, 0);

    // Parking only moves focus there, so an explicit Enter can confirm.
    GH_ASSERT([writer focusLockedNode:button]);
    GH_ASSERT(button.isFocused);
    GH_ASSERT_EQUAL_INT(actuator.pressedNodes.count, 0);
}

GH_TEST(writer_rechecks_sensitivity_right_before_writing) {
    GHFakeAXActuator *actuator = [[GHFakeAXActuator alloc] init];
    GHWriter *writer = Writer(actuator);
    // The field was an ordinary text field at capture time and turned into a password field since.
    GHFakeAXNode *secure = TextField(@"Code");
    secure.role = @"AXSecureTextField";
    GHField *field = FieldFor(@"Code", GHKindText);
    GHWriteResult *result = Run(writer, GhostFor(field, GHGhostActionFill, @"Alex"), field, secure, nil);
    GH_ASSERT(result != nil && !result.ok && result.refused);
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHWriteReasonSensitive);

    GHFakeAXNode *renamed = TextField(@"Card number");
    GH_ASSERT_EQUAL_OBJECTS(Run(writer, GhostFor(field, GHGhostActionFill, @"Alex"), field, renamed, nil).reason, GHWriteReasonSensitive);
    GH_ASSERT_EQUAL_OBJECTS(renamed.value, @"");
    GH_ASSERT_FALSE([writer focusNode:secure]);      // not even focus goes there
    GH_ASSERT_EQUAL_INT(actuator.setValueCount + actuator.typeCount + actuator.focusCount, 0);

    // A writer nobody gave a safety check to writes nowhere (fail closed).
    GHWriter *unwired = [[GHWriter alloc] initWithActuator:actuator];
    unwired.after = ^(NSTimeInterval delay, dispatch_block_t block) { block(); };
    GHFakeAXNode *plain = TextField(@"First name");
    GH_ASSERT_EQUAL_OBJECTS(Run(unwired, GhostFor(field, GHGhostActionFill, @"Alex"), field, plain, nil).reason, GHWriteReasonSensitive);
    GH_ASSERT_EQUAL_OBJECTS(plain.value, @"");
}

GH_TEST(writer_refuses_pending_gone_and_disabled) {
    GHFakeAXActuator *actuator = [[GHFakeAXActuator alloc] init];
    GHWriter *writer = Writer(actuator);
    GHFakeAXNode *node = TextField(@"Why us?");
    GHField *field = FieldFor(@"Why us?", GHKindTextArea);
    GHGhost *draft = GhostFor(field, GHGhostActionFill, @"I build");
    draft.pending = YES;
    GH_ASSERT_EQUAL_OBJECTS(Run(writer, draft, field, node, nil).reason, GHWriteReasonPending);
    GH_ASSERT_EQUAL_OBJECTS(node.value, @"");        // half a draft is never written

    GHGhost *ready = GhostFor(field, GHGhostActionFill, @"I build fast tools.");
    GH_ASSERT_EQUAL_OBJECTS(Run(writer, ready, field, nil, nil).reason, GHWriteReasonGone);
    [actuator.goneNodes addObject:node];
    GH_ASSERT_EQUAL_OBJECTS(Run(writer, ready, field, node, nil).reason, GHWriteReasonGone);
    [actuator.goneNodes removeAllObjects];
    node.enabled = NO;
    GH_ASSERT_EQUAL_OBJECTS(Run(writer, ready, field, node, nil).reason, GHWriteReasonDisabled);
    node.enabled = YES;
    GH_ASSERT(Run(writer, ready, field, node, nil).ok);
}

GH_TEST(writer_multiline_draft_survives_the_typing_fallback_without_an_enter) {
    GHFakeAXActuator *actuator = [[GHFakeAXActuator alloc] init];
    actuator.valueSticks = NO;
    GHFakeAXNode *area = [GHFakeAXNode nodeWithRole:@"AXTextArea" title:@"Why do you want to work here?" frame:CGRectMake(100, 300, 400, 120)];
    area.value = @"";
    GHField *field = FieldFor(@"Why do you want to work here?", GHKindTextArea);
    GHWriteResult *result = Run(Writer(actuator), GhostFor(field, GHGhostActionFill, @"I build fast tools.\nI ship."), field, area, nil);
    GH_ASSERT(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.method, GHWriteMethodTyping);
    GH_ASSERT_EQUAL_OBJECTS(area.value, @"I build fast tools. I ship.");   // the line break became a space: never an Enter key
}

#pragma mark - check, radio, select

GH_TEST(writer_checkbox_is_only_pressed_when_the_state_differs) {
    GHFakeAXActuator *actuator = [[GHFakeAXActuator alloc] init];
    GHWriter *writer = Writer(actuator);
    GHFakeAXNode *box = [GHFakeAXNode nodeWithRole:@"AXCheckBox" title:@"I am authorized to work in Canada" frame:CGRectMake(100, 100, 20, 20)];
    box.value = @"0";
    GHField *field = FieldFor(@"I am authorized to work in Canada", GHKindCheckbox);
    GHGhost *tick = GhostFor(field, GHGhostActionCheck, @"true");
    GHWriteResult *result = Run(writer, tick, field, box, nil);
    GH_ASSERT(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.method, GHWriteMethodPress);
    GH_ASSERT_EQUAL_OBJECTS(box.value, @"1");
    GH_ASSERT_EQUAL_INT(actuator.pressedNodes.count, 1);

    // Already ticked: success without a press (a press would untick it).
    result = Run(writer, tick, field, box, nil);
    GH_ASSERT(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.method, GHWriteMethodNone);
    GH_ASSERT_EQUAL_OBJECTS(box.value, @"1");
    GH_ASSERT_EQUAL_INT(actuator.pressedNodes.count, 1);

    // Ghost never unticks.
    result = Run(writer, GhostFor(field, GHGhostActionCheck, @"false"), field, box, nil);
    GH_ASSERT(result != nil && !result.ok);
    GH_ASSERT_EQUAL_OBJECTS(box.value, @"1");
    GH_ASSERT_EQUAL_INT(actuator.pressedNodes.count, 1);

    // A press the app ignores is a verification failure.
    box.value = @"0";
    actuator.pressWorks = NO;
    result = Run(writer, tick, field, box, nil);
    GH_ASSERT(result != nil && !result.ok && !result.refused);
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHWriteReasonDidNotHold);
}

GH_TEST(writer_radio_presses_the_matching_option_only) {
    GHFakeAXActuator *actuator = [[GHFakeAXActuator alloc] init];
    GHWriter *writer = Writer(actuator);
    GHFakeAXNode *group = [GHFakeAXNode nodeWithRole:@"AXRadioGroup" title:@"Will you require sponsorship?" frame:CGRectMake(100, 100, 300, 30)];
    GHFakeAXNode *yes = [group addChild:[GHFakeAXNode nodeWithRole:@"AXRadioButton" title:@"Yes" frame:CGRectMake(100, 100, 60, 30)]];
    GHFakeAXNode *no = [group addChild:[GHFakeAXNode nodeWithRole:@"AXRadioButton" title:@"No" frame:CGRectMake(180, 100, 60, 30)]];
    yes.value = @"0";
    no.value = @"0";
    GHField *field = FieldFor(@"Will you require sponsorship?", GHKindRadio);
    GHGhost *ghost = GhostFor(field, GHGhostActionSelect, @"No");
    GHWriteResult *result = Run(writer, ghost, field, group, no);
    GH_ASSERT(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(no.value, @"1");
    GH_ASSERT_EQUAL_OBJECTS(yes.value, @"0");
    GH_ASSERT_EQUAL_INT(actuator.pressedNodes.count, 1);
    GH_ASSERT(actuator.pressedNodes.firstObject == (id)no);

    result = Run(writer, ghost, field, group, no);   // already chosen: nothing to press
    GH_ASSERT(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.method, GHWriteMethodNone);
    GH_ASSERT_EQUAL_INT(actuator.pressedNodes.count, 1);
    GH_ASSERT_EQUAL_OBJECTS(Run(writer, ghost, field, group, nil).reason, GHWriteReasonOptionNotFound);
}

static GHFakeAXNode *Popup(NSArray<NSString *> *titles) {
    GHFakeAXNode *popup = [GHFakeAXNode nodeWithRole:@"AXPopUpButton" title:@"How did you hear about us?" frame:CGRectMake(100, 100, 300, 30)];
    popup.value = @"Select an option";
    GHFakeAXNode *menu = [popup addChild:[GHFakeAXNode nodeWithRole:@"AXMenu"]];
    for (NSString *title in titles) [menu addChild:[GHFakeAXNode nodeWithRole:@"AXMenuItem" title:title frame:CGRectMake(100, 130, 300, 22)]];
    return popup;
}

GH_TEST(writer_select_opens_the_popup_and_presses_the_matching_item) {
    GHFakeAXActuator *actuator = [[GHFakeAXActuator alloc] init];
    GHWriter *writer = Writer(actuator);
    GHFakeAXNode *popup = Popup(@[ @"Select an option", @"LinkedIn", @"Hack the North", @"Other" ]);
    GHField *field = FieldFor(@"How did you hear about us?", GHKindSelect);
    GHGhost *ghost = GhostFor(field, GHGhostActionSelect, @"Hack the North");
    GHWriteResult *result = Run(writer, ghost, field, popup, nil);
    GH_ASSERT(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.method, GHWriteMethodPress);
    GH_ASSERT_EQUAL_OBJECTS(popup.value, @"Hack the North");
    GH_ASSERT_EQUAL_INT(actuator.pressedNodes.count, 2);   // the popup, then the item
    GH_ASSERT_EQUAL_INT(actuator.dismissMenuCount, 0);

    // A choice that is already made is never changed.
    GHGhost *other = GhostFor(field, GHGhostActionSelect, @"LinkedIn");
    GH_ASSERT_EQUAL_OBJECTS(Run(writer, other, field, popup, nil).reason, GHWriteReasonHasValue);
    GH_ASSERT_EQUAL_OBJECTS(popup.value, @"Hack the North");

    // No such item: the menu Ghost opened is closed again and the walk stops.
    GHFakeAXNode *short_ = Popup(@[ @"Select an option", @"Other" ]);
    result = Run(writer, ghost, field, short_, nil);
    GH_ASSERT(result != nil && !result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHWriteReasonOptionNotFound);
    GH_ASSERT_EQUAL_INT(actuator.dismissMenuCount, 1);
    GH_ASSERT_EQUAL_OBJECTS(short_.value, @"Select an option");

    // A popup that takes AXValue needs no menu at all.
    GHFakeAXActuator *direct = [[GHFakeAXActuator alloc] init];
    direct.popupValueSettable = YES;
    GHFakeAXNode *settable = Popup(@[ @"Hack the North" ]);
    result = Run(Writer(direct), ghost, field, settable, nil);
    GH_ASSERT(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.method, GHWriteMethodValue);
    GH_ASSERT_EQUAL_INT(direct.pressedNodes.count, 0);

    GH_ASSERT([GHWriter isPlaceholderChoice:@""] && [GHWriter isPlaceholderChoice:@"  Choose one"] && [GHWriter isPlaceholderChoice:@"-- none --"]);
    GH_ASSERT_FALSE([GHWriter isPlaceholderChoice:@"Canada"]);
}

GH_TEST(writer_runs_one_write_at_a_time) {
    GHFakeAXActuator *actuator = [[GHFakeAXActuator alloc] init];
    GHWriter *writer = [[GHWriter alloc] initWithActuator:actuator];
    writer.isNodeSensitive = ^BOOL(id<GHAXNode> node) { return NO; };
    NSMutableArray<dispatch_block_t> *queued = [NSMutableArray array];
    writer.after = ^(NSTimeInterval delay, dispatch_block_t block) { [queued addObject:[block copy]]; };   // verification is pending
    GHFakeAXNode *first = TextField(@"First name"), *last = TextField(@"Last name");
    GHField *firstField = FieldFor(@"First name", GHKindText), *lastField = FieldFor(@"Last name", GHKindText);
    __block GHWriteResult *a = nil, *b = nil;
    [writer executeGhost:GhostFor(firstField, GHGhostActionFill, @"Alex") field:firstField node:first optionNode:nil completion:^(GHWriteResult *r) { a = r; }];
    GH_ASSERT(writer.busy && a == nil);
    [writer executeGhost:GhostFor(lastField, GHGhostActionFill, @"Chen") field:lastField node:last optionNode:nil completion:^(GHWriteResult *r) { b = r; }];
    GH_ASSERT_EQUAL_OBJECTS(b.reason, GHWriteReasonBusy);
    GH_ASSERT_EQUAL_OBJECTS(last.value, @"");
    GH_ASSERT_EQUAL_INT(queued.count, 1);
    queued.firstObject();
    GH_ASSERT(a.ok);
    GH_ASSERT_FALSE(writer.busy);
}
