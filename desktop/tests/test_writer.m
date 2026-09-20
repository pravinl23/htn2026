// GHWriter against fake nodes and a fake actuator: every branch of the accept path without a single AX call.
#import "GHTest.h"
#import "GHCapture.h"
#import "GHKeyPoster.h"
#import "GHOpenPanelDriver.h"
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

GH_TEST(writer_allows_only_an_exact_audited_locked_workflow_milestone) {
    GHFakeAXActuator *actuator = [[GHFakeAXActuator alloc] init];
    GHWriter *writer = Writer(actuator);
    writer.isNodeLocked = ^BOOL(id<GHAXNode> node) { return YES; };
    GHField *field = FieldFor(@"7:00 p.m. Reserve table at Waterloo Grill restaurant", GHKindButton);
    field.locked = YES;
    GHFakeAXNode *button = [GHFakeAXNode nodeWithRole:@"AXButton" title:field.label frame:CGRectMake(100, 400, 240, 32)];
    GHGhost *ghost = GhostFor(field, GHGhostActionClick, nil);
    ghost.source = @"workflow";
    ghost.auditedLockedLabel = field.label;

    GHWriteResult *result = Run(writer, ghost, field, button, nil);
    GH_ASSERT(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.method, GHWriteMethodPress);
    GH_ASSERT_EQUAL_INT(actuator.pressedNodes.count, 1);

    // A terminal control replacing that exact intermediate milestone fails closed even with the local flag.
    GHFakeAXNode *changed = [GHFakeAXNode nodeWithRole:@"AXButton" title:@"Complete reservation" frame:button.frame];
    result = Run(writer, ghost, field, changed, nil);
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHWriteReasonLocked);
    GH_ASSERT_EQUAL_INT(actuator.pressedNodes.count, 1);

    // Prediction dictionaries cannot manufacture the exception.
    NSMutableDictionary *wire = [[ghost dictionary] mutableCopy];
    wire[@"auditedLockedLabel"] = field.label;
    GH_ASSERT([GHGhost ghostWithDictionary:wire].auditedLockedLabel == nil);
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

GH_TEST(writer_popup_escape_only_closes_a_menu_that_is_really_open) {
    // Pure: an AXMenu under the popup, or focus on a menu item inside it. Nothing else counts as "open".
    GHFakeAXNode *popup = Popup(@[ @"Other" ]);
    GH_ASSERT([GHWriter menuIsOpenForPopup:popup focused:nil]);
    GHFakeAXNode *listbox = [GHFakeAXNode nodeWithRole:@"AXPopUpButton" title:@"Country" frame:CGRectMake(100, 100, 300, 30)];
    listbox.value = @"Select...";
    [listbox addChild:[GHFakeAXNode staticText:@"Canada" frame:CGRectZero]];   // an ARIA listbox: options, no AXMenu
    GH_ASSERT_FALSE([GHWriter menuIsOpenForPopup:listbox focused:nil]);
    GHFakeAXNode *item = [[listbox addChild:[GHFakeAXNode nodeWithRole:@"AXGroup"]] addChild:[GHFakeAXNode nodeWithRole:@"AXMenuItem" title:@"Canada" frame:CGRectZero]];
    GH_ASSERT([GHWriter menuIsOpenForPopup:listbox focused:item]);
    GHFakeAXNode *strayItem = [GHFakeAXNode nodeWithRole:@"AXMenuItem" title:@"Quit" frame:CGRectZero];
    GH_ASSERT_FALSE([GHWriter menuIsOpenForPopup:listbox focused:strayItem]);   // some other menu: not ours
    GH_ASSERT_FALSE([GHWriter menuIsOpenForPopup:nil focused:item]);

    // A popup whose "menu" never shows up as an AXMenu (a slow app, an ARIA listbox): no match, and no Escape either.
    GHFakeAXActuator *actuator = [[GHFakeAXActuator alloc] init];
    GHWriter *writer = Writer(actuator);
    GHField *field = FieldFor(@"Country", GHKindSelect);
    GHGhost *ghost = GhostFor(field, GHGhostActionSelect, @"Canada");
    GHFakeAXNode *bare = [GHFakeAXNode nodeWithRole:@"AXPopUpButton" title:@"Country" frame:CGRectMake(100, 100, 300, 30)];
    bare.value = @"Select...";
    GHWriteResult *result = Run(writer, ghost, field, bare, nil);
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHWriteReasonOptionNotFound);
    GH_ASSERT_EQUAL_INT(actuator.dismissMenuCount, 0);

    // The menu is open, but the user pressed a key while it was up: the key was theirs, no Escape follows it.
    GHFakeAXActuator *keyed = [[GHFakeAXActuator alloc] init];
    GHWriter *interrupted = Writer(keyed);
    __weak GHWriter *weakWriter = interrupted;
    interrupted.after = ^(NSTimeInterval delay, dispatch_block_t block) { [weakWriter noteUserKeyEvent]; block(); };
    result = Run(interrupted, ghost, field, Popup(@[ @"Select an option", @"Other" ]), nil);
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHWriteReasonOptionNotFound);
    GH_ASSERT_EQUAL_INT(keyed.dismissMenuCount, 0);
    // A key outside a pick changes nothing for the next one.
    interrupted.after = ^(NSTimeInterval delay, dispatch_block_t block) { block(); };
    result = Run(interrupted, ghost, field, Popup(@[ @"Select an option", @"Other" ]), nil);
    GH_ASSERT_EQUAL_INT(keyed.dismissMenuCount, 1);
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

#pragma mark - typing through GHKeyPoster, uploads, lazy selects

GH_TEST(writer_live_actuator_types_only_through_the_key_poster_into_the_focused_node) {
    GHFakeDesktopState *state = [[GHFakeDesktopState alloc] init];
    state.frontmostPID = 321;
    GHFakeKeyPoster *poster = [[GHFakeKeyPoster alloc] initWithState:state];
    GHAXLiveActuator *actuator = [[GHAXLiveActuator alloc] initWithPoster:poster];
    GH_ASSERT(actuator.poster == poster);
    GHFakeAXNode *field = TextField(@"Why us?");
    GHFakeAXNode *elsewhere = TextField(@"Search");
    state.focusedNode = field;
    // A line break is typed as a space: never an Enter. Every chunk re-checks focus and the app.
    GH_ASSERT([actuator typeText:@"Fast tools.\nLow latency, always and everywhere." intoNode:field]);
    GH_ASSERT_EQUAL_OBJECTS(poster.typedText, @"Fast tools. Low latency, always and everywhere.");
    GH_ASSERT(poster.guardCalls >= 3);
    GH_ASSERT_EQUAL_INT([poster countOfKind:GHKeyStrokeKindReturn], 0);
    // Focus moves after the first chunk: the rest is never typed.
    __block NSUInteger posts = 0;
    poster.onPost = ^(GHKeyStroke *stroke) { if (++posts == 1) state.focusedNode = elsewhere; };
    NSUInteger before = poster.posted.count;
    GH_ASSERT_FALSE([actuator typeText:[@"" stringByPaddingToLength:50 withString:@"y" startingAtIndex:0] intoNode:field]);
    GH_ASSERT_EQUAL_INT(poster.posted.count, before + 1);
    // Another app in front: nothing at all.
    poster.onPost = nil;
    state.focusedNode = field;
    before = poster.posted.count;
    __block BOOL switched = NO;
    poster.onPost = ^(GHKeyStroke *stroke) { if (!switched) { switched = YES; state.frontmostPID = 999; } };
    GH_ASSERT_FALSE([actuator typeText:[@"" stringByPaddingToLength:30 withString:@"z" startingAtIndex:0] intoNode:field]);
    GH_ASSERT_EQUAL_INT(poster.posted.count, before + 1);
    // Fakes have no element: presses, focus and scrolling report failure without touching anything.
    GH_ASSERT_FALSE([actuator pressNode:field]);
    GH_ASSERT_FALSE([actuator scrollToVisible:field]);
    NSUInteger posted = poster.posted.count;
    GH_ASSERT_FALSE([actuator dismissMenuOfPopup:field stillWanted:nil]);   // no menu of ours is open: no Escape
    GH_ASSERT_EQUAL_INT(poster.posted.count, posted);
}

GH_TEST(writer_typing_fallback_goes_through_the_actuator_focus_check) {
    GHFakeAXActuator *actuator = [[GHFakeAXActuator alloc] init];
    GHFakeAXNode *node = TextField(@"First name");
    GHFakeAXNode *other = TextField(@"Other");
    GH_ASSERT([actuator focusNode:other]);
    GH_ASSERT_FALSE([actuator typeText:@"Alex" intoNode:node]);   // focus is elsewhere: refused
    GH_ASSERT_EQUAL_OBJECTS(node.value, @"");
    GH_ASSERT_EQUAL_OBJECTS(other.value, @"");
    GH_ASSERT([actuator focusNode:node]);
    GH_ASSERT([actuator typeText:@"Alex" intoNode:node]);
    GH_ASSERT_EQUAL_OBJECTS(node.value, @"Alex");
    GH_ASSERT_EQUAL_OBJECTS(actuator.focusRequests, (@[ other, node ]));
}

static GHFakeAXNode *UploadWidget(GHFakeAXNode **attach, GHFakeAXNode **input) {
    GHFakeAXNode *widget = [GHFakeAXNode nodeWithRole:@"AXGroup" title:@"Resume/CV" frame:CGRectMake(100, 100, 600, 200)];
    GHFakeAXNode *row = [widget addChild:[GHFakeAXNode nodeWithRole:@"AXGroup" title:nil frame:CGRectMake(100, 130, 300, 50)]];
    *attach = [row addChild:[GHFakeAXNode nodeWithRole:@"AXButton" title:@"Attach" frame:CGRectMake(100, 130, 300, 43)]];
    *input = [row addChild:[GHFakeAXNode nodeWithRole:@"AXButton" title:nil frame:CGRectMake(398, 130, 2, 2)]];
    (*input).subrole = @"AXFileUploadButton";
    (*input).identifier = @"resume";
    [widget addChild:[GHFakeAXNode nodeWithRole:@"AXButton" title:@"Dropbox" frame:CGRectMake(100, 180, 300, 43)]];
    return widget;
}

GH_TEST(writer_upload_widget_helpers_read_page_text_and_remove_controls) {
    GHFakeAXNode *attach = nil, *input = nil;
    GHFakeAXNode *widget = UploadWidget(&attach, &input);
    GH_ASSERT([GHWriter uploadWidgetOfInput:input] == widget);   // climbs past the unnamed row to "Resume/CV"
    GH_ASSERT_FALSE([GHWriter widget:widget mentionsFile:@"resume-alex-chen.pdf"]);
    GH_ASSERT_FALSE([GHWriter widgetHasRemoveControl:widget]);
    GHFakeAXNode *typed = [widget addChild:TextField(@"Notes")];
    typed.value = @"resume-alex-chen.pdf";                          // a field's value is never read
    GH_ASSERT_FALSE([GHWriter widget:widget mentionsFile:@"resume-alex-chen.pdf"]);
    [widget addChild:[GHFakeAXNode staticText:@"RESUME-ALEX-CHEN.PDF" frame:CGRectZero]];
    GH_ASSERT([GHWriter widget:widget mentionsFile:@"resume-alex-chen.pdf"]);
    [widget addChild:[GHFakeAXNode nodeWithRole:@"AXButton" title:@"Remove file" frame:CGRectZero]];
    GH_ASSERT([GHWriter widgetHasRemoveControl:widget]);
    GH_ASSERT([GHWriter uploadWidgetOfInput:nil] == nil);
    GH_ASSERT_FALSE([GHWriter widget:nil mentionsFile:@"x.pdf"]);
}

GH_TEST(writer_upload_and_lazy_select_are_refused_without_their_drivers) {
    GHFakeAXActuator *actuator = [[GHFakeAXActuator alloc] init];
    GHWriter *writer = Writer(actuator);
    GHFakeAXNode *attach = nil, *input = nil;
    (void)UploadWidget(&attach, &input);
    GHField *file = FieldFor(@"Resume/CV", GHKindFile);
    GHGhost *upload = GhostFor(file, GHGhostActionUpload, @"/Users/example/resume-alex-chen.pdf");
    upload.displayText = @"resume-alex-chen.pdf";
    GHWriteResult *result = Run(writer, upload, file, attach, input);
    GH_ASSERT(result.refused);
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHWriteReasonUnsupported);
    GH_ASSERT_EQUAL_INT(actuator.pressedNodes.count, 0);

    // A lazy select on a react-select input without the combobox driver is never typed as free text.
    GHFakeAXNode *combo = [GHFakeAXNode nodeWithRole:@"AXComboBox" title:@"Country" frame:CGRectMake(100, 100, 300, 30)];
    combo.value = @"";
    GHField *select = FieldFor(@"Country", GHKindSelect);
    select.lazyOptions = YES;
    GHGhost *lazy = GhostFor(select, GHGhostActionSelect, @"Canada");
    lazy.lazy = YES;
    GHWriteResult *refused = Run(writer, lazy, select, combo, nil);
    GH_ASSERT(refused.refused);
    GH_ASSERT_EQUAL_OBJECTS(refused.reason, GHWriteReasonUnsupported);
    GH_ASSERT_EQUAL_INT(actuator.setValueCount + actuator.typeCount + actuator.focusCount, 0);
    GH_ASSERT_EQUAL_OBJECTS(combo.value, @"");

    // A path never goes into a file field any other way, and an upload never into anything but a file field.
    GH_ASSERT_EQUAL_OBJECTS(Run(writer, GhostFor(file, GHGhostActionFill, @"/Users/example/r.pdf"), file, attach, input).reason, GHWriteReasonUnsupported);
    GHField *text = FieldFor(@"Website", GHKindText);
    GHFakeAXNode *website = TextField(@"Website");
    GHGhost *wrong = GhostFor(text, GHGhostActionUpload, @"/Users/example/r.pdf");
    GH_ASSERT(Run(writer, wrong, text, website, nil).refused);
    GH_ASSERT_EQUAL_OBJECTS(website.value, @"");

    GH_ASSERT([GHWriter ghostRunsSequence:upload field:file]);
    GH_ASSERT([GHWriter ghostRunsSequence:lazy field:select]);
    GH_ASSERT_FALSE([GHWriter ghostRunsSequence:GhostFor(text, GHGhostActionFill, @"x") field:text]);
    select.lazyOptions = NO;
    GH_ASSERT_FALSE([GHWriter ghostRunsSequence:lazy field:select]);   // a native popup is picked, not driven
}

GH_TEST(writer_upload_checks_path_target_and_existing_file_before_the_driver) {
    GHFakeAXActuator *actuator = [[GHFakeAXActuator alloc] init];
    GHWriter *writer = Writer(actuator);
    GHFakeDesktopState *state = [[GHFakeDesktopState alloc] init];
    GHFakeKeyPoster *poster = [[GHFakeKeyPoster alloc] initWithState:state];
    writer.openPanelDriver = [[GHOpenPanelDriver alloc] initWithActuator:actuator poster:poster state:state];
    GHFakeAXNode *attach = nil, *input = nil;
    (void)UploadWidget(&attach, &input);
    GHField *file = FieldFor(@"Resume/CV", GHKindFile);
    NSString *path = [GHTestTempDirectory() stringByAppendingPathComponent:@"resume-alex-chen.pdf"];
    [@"%PDF-1.4 fictional" writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:NULL];

    GHGhost *missing = GhostFor(file, GHGhostActionUpload, @"/nonexistent/ghost/resume.pdf");
    GH_ASSERT_EQUAL_OBJECTS(Run(writer, missing, file, attach, input).reason, @"upload-invalid-path");
    file.value = @"resume-old.pdf";                                   // the widget already holds a file
    GH_ASSERT_EQUAL_OBJECTS(Run(writer, GhostFor(file, GHGhostActionUpload, path), file, attach, input).reason, GHWriteReasonHasValue);
    file.value = @"";
    // "Attach" renamed into something that is not an upload control: the file input is the fallback target.
    attach.title = @"Dropbox";
    state.frontmostPID = 0;                                           // the driver then refuses: no app in front
    GHWriteResult *fallback = Run(writer, GhostFor(file, GHGhostActionUpload, path), file, attach, input);
    GH_ASSERT_EQUAL_OBJECTS(fallback.reason, @"upload-no-frontmost-app");
    GH_ASSERT(fallback.refused);
    GH_ASSERT(fallback.sequence);
    input.subrole = nil;                                              // and with no upload control at all
    GH_ASSERT_EQUAL_OBJECTS(Run(writer, GhostFor(file, GHGhostActionUpload, path), file, attach, input).reason, @"upload-no-upload-target");
    GH_ASSERT_EQUAL_INT(actuator.pressedNodes.count, 0);
    GH_ASSERT_EQUAL_INT(poster.posted.count, 0);
}
