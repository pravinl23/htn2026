// SBWriter against fake nodes and a fake actuator: every branch of the accept path without a single AX call.
#import "SBTest.h"
#import "SBCapture.h"
#import "SBKeyPoster.h"
#import "SBOpenPanelDriver.h"
#import "SBWriter.h"

#pragma mark - helpers

static SBFakeAXNode *TextField(NSString *title) {
    SBFakeAXNode *node = [SBFakeAXNode nodeWithRole:@"AXTextField" title:title frame:CGRectMake(100, 100, 300, 30)];
    node.value = @"";
    return node;
}

static SBField *FieldFor(NSString *label, NSString *kind) {
    SBField *field = [SBField fieldWithSignature:[@"sig-" stringByAppendingString:label] label:label kind:kind];
    field.rect = CGRectMake(100, 100, 300, 30);
    return field;
}

static SBGhost *GhostFor(SBField *field, NSString *action, NSString *value) {
    SBGhost *ghost = [[SBGhost alloc] init];
    ghost.signature = field.signature;
    ghost.action = action;
    ghost.value = value;
    ghost.displayText = value;
    ghost.confidence = 0.95;
    return ghost;
}

static SBWriter *Writer(SBFakeAXActuator *actuator) {
    SBWriter *writer = [[SBWriter alloc] initWithActuator:actuator];
    writer.after = ^(NSTimeInterval delay, dispatch_block_t block) { block(); };   // no waiting in tests
    writer.isNodeSensitive = ^BOOL(id<SBAXNode> node) {
        return [SBCapture nativeLooksSensitive:node.title] || [SBCapture nativeLooksSensitive:node.axDescription] || [SBCapture nativeLooksSensitive:node.identifier];
    };
    return writer;
}

static SBWriteResult *Run(SBWriter *writer, SBGhost *ghost, SBField *field, id<SBAXNode> node, id<SBAXNode> option) {
    __block SBWriteResult *result = nil;
    __block int calls = 0;
    [writer executeGhost:ghost field:field node:node optionNode:option completion:^(SBWriteResult *r) { result = r; calls++; }];
    if (calls != 1) return nil;   // the completion runs exactly once
    return result;
}

#pragma mark - fill

GH_TEST(writer_fill_sets_the_value_and_verifies) {
    SBFakeAXActuator *actuator = [[SBFakeAXActuator alloc] init];
    SBWriter *writer = Writer(actuator);
    SBFakeAXNode *node = TextField(@"First name");
    SBField *field = FieldFor(@"First name", SBKindText);
    SBWriteResult *result = Run(writer, GhostFor(field, SBGhostActionFill, @"Alex"), field, node, nil);
    GH_ASSERT(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.method, SBWriteMethodValue);
    GH_ASSERT_EQUAL_OBJECTS(node.value, @"Alex");
    GH_ASSERT(node.isFocused);                       // focus went to the field first
    GH_ASSERT_EQUAL_INT(actuator.typeCount, 0);      // no key events when AXValue held
    GH_ASSERT_EQUAL_INT(actuator.pressedNodes.count, 0);
    GH_ASSERT_FALSE(writer.busy);
}

GH_TEST(writer_fill_accepts_the_pages_own_spelling) {
    SBFakeAXActuator *actuator = [[SBFakeAXActuator alloc] init];
    actuator.reformat = ^NSString *(NSString *value) { return @"(519) 555-0142"; };   // a phone mask that drops the country code
    SBFakeAXNode *node = TextField(@"Phone");
    SBField *field = FieldFor(@"Phone", SBKindTel);
    SBWriteResult *result = Run(Writer(actuator), GhostFor(field, SBGhostActionFill, @"+1 519 555 0142"), field, node, nil);
    GH_ASSERT(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.method, SBWriteMethodValue);

    GH_ASSERT([SBWriter value:@"ALEX.CHEN@EXAMPLE.COM " holds:@"alex.chen@example.com"]);
    GH_ASSERT([SBWriter value:@"N2L 3G1" holds:@"n2l3g1"]);
    GH_ASSERT_FALSE([SBWriter value:@"" holds:@"Alex"]);
    GH_ASSERT_FALSE([SBWriter value:nil holds:@"Alex"]);
    GH_ASSERT_FALSE([SBWriter value:@"Al" holds:@"Alexander Chen"]);      // too little of it
    GH_ASSERT_FALSE([SBWriter value:@"Jordan" holds:@"Alex"]);            // unrelated content
    GH_ASSERT([SBWriter value:@"--" holds:@"--"]);
    GH_ASSERT_FALSE([SBWriter value:@"-" holds:@"--"]);                   // nothing but punctuation: exact only
    GH_ASSERT_EQUAL_OBJECTS([SBWriter comparable:@" +1 (519) 555-0142 "], @"15195550142");
}

GH_TEST(writer_fill_falls_back_to_typing_when_the_value_does_not_stick) {
    SBFakeAXActuator *actuator = [[SBFakeAXActuator alloc] init];
    actuator.valueSticks = NO;                       // a React input that reverts programmatic writes
    SBFakeAXNode *node = TextField(@"Email");
    SBField *field = FieldFor(@"Email", SBKindEmail);
    SBWriteResult *result = Run(Writer(actuator), GhostFor(field, SBGhostActionFill, @"alex.chen@example.com"), field, node, nil);
    GH_ASSERT(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.method, SBWriteMethodTyping);
    GH_ASSERT_EQUAL_OBJECTS(node.value, @"alex.chen@example.com");
    GH_ASSERT_EQUAL_INT(actuator.setValueCount, 1);
    GH_ASSERT_EQUAL_INT(actuator.replaceSelectionCount, 1);   // the cheap middle step was tried and refused
    GH_ASSERT_EQUAL_INT(actuator.typeCount, 1);
}

GH_TEST(writer_fill_uses_selected_text_before_typing_when_the_app_supports_it) {
    SBFakeAXActuator *actuator = [[SBFakeAXActuator alloc] init];
    actuator.valueSticks = NO;
    actuator.selectedTextSticks = YES;
    SBFakeAXNode *node = TextField(@"City");
    SBField *field = FieldFor(@"City", SBKindText);
    SBWriteResult *result = Run(Writer(actuator), GhostFor(field, SBGhostActionFill, @"Waterloo"), field, node, nil);
    GH_ASSERT(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.method, SBWriteMethodSelectedText);
    GH_ASSERT_EQUAL_INT(actuator.typeCount, 0);
}

GH_TEST(writer_fill_reports_failure_when_even_typing_does_not_hold) {
    SBFakeAXActuator *actuator = [[SBFakeAXActuator alloc] init];
    actuator.valueSticks = NO;
    actuator.typingSticks = NO;
    SBFakeAXNode *node = TextField(@"Email");
    SBField *field = FieldFor(@"Email", SBKindEmail);
    SBWriter *writer = Writer(actuator);
    SBWriteResult *result = Run(writer, GhostFor(field, SBGhostActionFill, @"alex.chen@example.com"), field, node, nil);
    GH_ASSERT(result != nil && !result.ok);
    GH_ASSERT_FALSE(result.refused);                 // something was tried: the controller stops the walk
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBWriteReasonDidNotHold);
    GH_ASSERT_EQUAL_OBJECTS(result.method, SBWriteMethodTyping);
    GH_ASSERT_EQUAL_OBJECTS(node.value, @"");
    GH_ASSERT_FALSE(writer.busy);
}

GH_TEST(writer_never_types_into_something_that_is_not_focused) {
    SBFakeAXActuator *actuator = [[SBFakeAXActuator alloc] init];
    actuator.valueSticks = NO;
    actuator.focusWorks = NO;                        // the app ignores AXFocused: key events would land somewhere else
    SBFakeAXNode *other = TextField(@"Search");
    other.isFocused = YES;
    actuator.focusedNode = other;
    SBFakeAXNode *node = TextField(@"Email");
    SBField *field = FieldFor(@"Email", SBKindEmail);
    SBWriteResult *result = Run(Writer(actuator), GhostFor(field, SBGhostActionFill, @"alex.chen@example.com"), field, node, nil);
    GH_ASSERT(result != nil && !result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBWriteReasonNotFocused);
    GH_ASSERT_EQUAL_INT(actuator.typeCount, 0);
    GH_ASSERT_EQUAL_OBJECTS(other.value, @"");       // nothing leaked into the focused search box
}

GH_TEST(writer_never_overwrites_a_value) {
    SBFakeAXActuator *actuator = [[SBFakeAXActuator alloc] init];
    SBFakeAXNode *node = TextField(@"First name");
    node.value = @" ";                               // whitespace counts: the user typed it
    SBField *field = FieldFor(@"First name", SBKindText);
    SBWriteResult *result = Run(Writer(actuator), GhostFor(field, SBGhostActionFill, @"Alex"), field, node, nil);
    GH_ASSERT(result != nil && !result.ok && result.refused);
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBWriteReasonHasValue);
    GH_ASSERT_EQUAL_OBJECTS(node.value, @" ");
    GH_ASSERT_EQUAL_INT(actuator.setValueCount + actuator.typeCount + actuator.focusCount, 0);
}

#pragma mark - refusals

GH_TEST(writer_refuses_locked_targets_and_never_presses_a_button) {
    SBFakeAXActuator *actuator = [[SBFakeAXActuator alloc] init];
    SBWriter *writer = Writer(actuator);
    SBFakeAXNode *button = [SBFakeAXNode nodeWithRole:@"AXButton" title:@"Submit application" frame:CGRectMake(100, 400, 160, 32)];
    SBField *field = FieldFor(@"Submit application", SBKindButton);
    field.locked = YES;
    SBGhost *lock = GhostFor(field, SBGhostActionClick, nil);
    lock.locked = YES;
    SBWriteResult *result = Run(writer, lock, field, button, nil);
    GH_ASSERT(result != nil && !result.ok && result.refused);
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBWriteReasonLocked);

    // Whatever the ghost claims to be: a fill aimed at a button, an unlocked click, a locked field.
    GH_ASSERT_EQUAL_OBJECTS(Run(writer, GhostFor(field, SBGhostActionFill, @"x"), field, button, nil).reason, SBWriteReasonLocked);
    SBField *plainButton = FieldFor(@"Next", SBKindButton);
    GH_ASSERT_EQUAL_OBJECTS(Run(writer, GhostFor(plainButton, SBGhostActionClick, nil), plainButton, button, nil).reason, SBWriteReasonLocked);
    GH_ASSERT_EQUAL_INT(actuator.pressedNodes.count, 0);

    // Parking only moves focus there, so an explicit Enter can confirm.
    GH_ASSERT([writer focusLockedNode:button]);
    GH_ASSERT(button.isFocused);
    GH_ASSERT_EQUAL_INT(actuator.pressedNodes.count, 0);
}

GH_TEST(writer_rechecks_sensitivity_right_before_writing) {
    SBFakeAXActuator *actuator = [[SBFakeAXActuator alloc] init];
    SBWriter *writer = Writer(actuator);
    // The field was an ordinary text field at capture time and turned into a password field since.
    SBFakeAXNode *secure = TextField(@"Code");
    secure.role = @"AXSecureTextField";
    SBField *field = FieldFor(@"Code", SBKindText);
    SBWriteResult *result = Run(writer, GhostFor(field, SBGhostActionFill, @"Alex"), field, secure, nil);
    GH_ASSERT(result != nil && !result.ok && result.refused);
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBWriteReasonSensitive);

    SBFakeAXNode *renamed = TextField(@"Card number");
    GH_ASSERT_EQUAL_OBJECTS(Run(writer, GhostFor(field, SBGhostActionFill, @"Alex"), field, renamed, nil).reason, SBWriteReasonSensitive);
    GH_ASSERT_EQUAL_OBJECTS(renamed.value, @"");
    GH_ASSERT_FALSE([writer focusNode:secure]);      // not even focus goes there
    GH_ASSERT_EQUAL_INT(actuator.setValueCount + actuator.typeCount + actuator.focusCount, 0);

    // A writer nobody gave a safety check to writes nowhere (fail closed).
    SBWriter *unwired = [[SBWriter alloc] initWithActuator:actuator];
    unwired.after = ^(NSTimeInterval delay, dispatch_block_t block) { block(); };
    SBFakeAXNode *plain = TextField(@"First name");
    GH_ASSERT_EQUAL_OBJECTS(Run(unwired, GhostFor(field, SBGhostActionFill, @"Alex"), field, plain, nil).reason, SBWriteReasonSensitive);
    GH_ASSERT_EQUAL_OBJECTS(plain.value, @"");
}

GH_TEST(writer_refuses_pending_gone_and_disabled) {
    SBFakeAXActuator *actuator = [[SBFakeAXActuator alloc] init];
    SBWriter *writer = Writer(actuator);
    SBFakeAXNode *node = TextField(@"Why us?");
    SBField *field = FieldFor(@"Why us?", SBKindTextArea);
    SBGhost *draft = GhostFor(field, SBGhostActionFill, @"I build");
    draft.pending = YES;
    GH_ASSERT_EQUAL_OBJECTS(Run(writer, draft, field, node, nil).reason, SBWriteReasonPending);
    GH_ASSERT_EQUAL_OBJECTS(node.value, @"");        // half a draft is never written

    SBGhost *ready = GhostFor(field, SBGhostActionFill, @"I build fast tools.");
    GH_ASSERT_EQUAL_OBJECTS(Run(writer, ready, field, nil, nil).reason, SBWriteReasonGone);
    [actuator.goneNodes addObject:node];
    GH_ASSERT_EQUAL_OBJECTS(Run(writer, ready, field, node, nil).reason, SBWriteReasonGone);
    [actuator.goneNodes removeAllObjects];
    node.enabled = NO;
    GH_ASSERT_EQUAL_OBJECTS(Run(writer, ready, field, node, nil).reason, SBWriteReasonDisabled);
    node.enabled = YES;
    GH_ASSERT(Run(writer, ready, field, node, nil).ok);
}

GH_TEST(writer_multiline_draft_survives_the_typing_fallback_without_an_enter) {
    SBFakeAXActuator *actuator = [[SBFakeAXActuator alloc] init];
    actuator.valueSticks = NO;
    SBFakeAXNode *area = [SBFakeAXNode nodeWithRole:@"AXTextArea" title:@"Why do you want to work here?" frame:CGRectMake(100, 300, 400, 120)];
    area.value = @"";
    SBField *field = FieldFor(@"Why do you want to work here?", SBKindTextArea);
    SBWriteResult *result = Run(Writer(actuator), GhostFor(field, SBGhostActionFill, @"I build fast tools.\nI ship."), field, area, nil);
    GH_ASSERT(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.method, SBWriteMethodTyping);
    GH_ASSERT_EQUAL_OBJECTS(area.value, @"I build fast tools. I ship.");   // the line break became a space: never an Enter key
}

#pragma mark - check, radio, select

GH_TEST(writer_checkbox_is_only_pressed_when_the_state_differs) {
    SBFakeAXActuator *actuator = [[SBFakeAXActuator alloc] init];
    SBWriter *writer = Writer(actuator);
    SBFakeAXNode *box = [SBFakeAXNode nodeWithRole:@"AXCheckBox" title:@"I am authorized to work in Canada" frame:CGRectMake(100, 100, 20, 20)];
    box.value = @"0";
    SBField *field = FieldFor(@"I am authorized to work in Canada", SBKindCheckbox);
    SBGhost *tick = GhostFor(field, SBGhostActionCheck, @"true");
    SBWriteResult *result = Run(writer, tick, field, box, nil);
    GH_ASSERT(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.method, SBWriteMethodPress);
    GH_ASSERT_EQUAL_OBJECTS(box.value, @"1");
    GH_ASSERT_EQUAL_INT(actuator.pressedNodes.count, 1);

    // Already ticked: success without a press (a press would untick it).
    result = Run(writer, tick, field, box, nil);
    GH_ASSERT(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.method, SBWriteMethodNone);
    GH_ASSERT_EQUAL_OBJECTS(box.value, @"1");
    GH_ASSERT_EQUAL_INT(actuator.pressedNodes.count, 1);

    // Shabang never unticks.
    result = Run(writer, GhostFor(field, SBGhostActionCheck, @"false"), field, box, nil);
    GH_ASSERT(result != nil && !result.ok);
    GH_ASSERT_EQUAL_OBJECTS(box.value, @"1");
    GH_ASSERT_EQUAL_INT(actuator.pressedNodes.count, 1);

    // A press the app ignores is a verification failure.
    box.value = @"0";
    actuator.pressWorks = NO;
    result = Run(writer, tick, field, box, nil);
    GH_ASSERT(result != nil && !result.ok && !result.refused);
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBWriteReasonDidNotHold);
}

GH_TEST(writer_radio_presses_the_matching_option_only) {
    SBFakeAXActuator *actuator = [[SBFakeAXActuator alloc] init];
    SBWriter *writer = Writer(actuator);
    SBFakeAXNode *group = [SBFakeAXNode nodeWithRole:@"AXRadioGroup" title:@"Will you require sponsorship?" frame:CGRectMake(100, 100, 300, 30)];
    SBFakeAXNode *yes = [group addChild:[SBFakeAXNode nodeWithRole:@"AXRadioButton" title:@"Yes" frame:CGRectMake(100, 100, 60, 30)]];
    SBFakeAXNode *no = [group addChild:[SBFakeAXNode nodeWithRole:@"AXRadioButton" title:@"No" frame:CGRectMake(180, 100, 60, 30)]];
    yes.value = @"0";
    no.value = @"0";
    SBField *field = FieldFor(@"Will you require sponsorship?", SBKindRadio);
    SBGhost *ghost = GhostFor(field, SBGhostActionSelect, @"No");
    SBWriteResult *result = Run(writer, ghost, field, group, no);
    GH_ASSERT(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(no.value, @"1");
    GH_ASSERT_EQUAL_OBJECTS(yes.value, @"0");
    GH_ASSERT_EQUAL_INT(actuator.pressedNodes.count, 1);
    GH_ASSERT(actuator.pressedNodes.firstObject == (id)no);

    result = Run(writer, ghost, field, group, no);   // already chosen: nothing to press
    GH_ASSERT(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.method, SBWriteMethodNone);
    GH_ASSERT_EQUAL_INT(actuator.pressedNodes.count, 1);
    GH_ASSERT_EQUAL_OBJECTS(Run(writer, ghost, field, group, nil).reason, SBWriteReasonOptionNotFound);
}

static SBFakeAXNode *Popup(NSArray<NSString *> *titles) {
    SBFakeAXNode *popup = [SBFakeAXNode nodeWithRole:@"AXPopUpButton" title:@"How did you hear about us?" frame:CGRectMake(100, 100, 300, 30)];
    popup.value = @"Select an option";
    SBFakeAXNode *menu = [popup addChild:[SBFakeAXNode nodeWithRole:@"AXMenu"]];
    for (NSString *title in titles) [menu addChild:[SBFakeAXNode nodeWithRole:@"AXMenuItem" title:title frame:CGRectMake(100, 130, 300, 22)]];
    return popup;
}

GH_TEST(writer_select_opens_the_popup_and_presses_the_matching_item) {
    SBFakeAXActuator *actuator = [[SBFakeAXActuator alloc] init];
    SBWriter *writer = Writer(actuator);
    SBFakeAXNode *popup = Popup(@[ @"Select an option", @"LinkedIn", @"Hack the North", @"Other" ]);
    SBField *field = FieldFor(@"How did you hear about us?", SBKindSelect);
    SBGhost *ghost = GhostFor(field, SBGhostActionSelect, @"Hack the North");
    SBWriteResult *result = Run(writer, ghost, field, popup, nil);
    GH_ASSERT(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.method, SBWriteMethodPress);
    GH_ASSERT_EQUAL_OBJECTS(popup.value, @"Hack the North");
    GH_ASSERT_EQUAL_INT(actuator.pressedNodes.count, 2);   // the popup, then the item
    GH_ASSERT_EQUAL_INT(actuator.dismissMenuCount, 0);

    // A choice that is already made is never changed.
    SBGhost *other = GhostFor(field, SBGhostActionSelect, @"LinkedIn");
    GH_ASSERT_EQUAL_OBJECTS(Run(writer, other, field, popup, nil).reason, SBWriteReasonHasValue);
    GH_ASSERT_EQUAL_OBJECTS(popup.value, @"Hack the North");

    // No such item: the menu Shabang opened is closed again and the walk stops.
    SBFakeAXNode *short_ = Popup(@[ @"Select an option", @"Other" ]);
    result = Run(writer, ghost, field, short_, nil);
    GH_ASSERT(result != nil && !result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBWriteReasonOptionNotFound);
    GH_ASSERT_EQUAL_INT(actuator.dismissMenuCount, 1);
    GH_ASSERT_EQUAL_OBJECTS(short_.value, @"Select an option");

    // A popup that takes AXValue needs no menu at all.
    SBFakeAXActuator *direct = [[SBFakeAXActuator alloc] init];
    direct.popupValueSettable = YES;
    SBFakeAXNode *settable = Popup(@[ @"Hack the North" ]);
    result = Run(Writer(direct), ghost, field, settable, nil);
    GH_ASSERT(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.method, SBWriteMethodValue);
    GH_ASSERT_EQUAL_INT(direct.pressedNodes.count, 0);

    GH_ASSERT([SBWriter isPlaceholderChoice:@""] && [SBWriter isPlaceholderChoice:@"  Choose one"] && [SBWriter isPlaceholderChoice:@"-- none --"]);
    GH_ASSERT_FALSE([SBWriter isPlaceholderChoice:@"Canada"]);
}

GH_TEST(writer_popup_escape_only_closes_a_menu_that_is_really_open) {
    // Pure: an AXMenu under the popup, or focus on a menu item inside it. Nothing else counts as "open".
    SBFakeAXNode *popup = Popup(@[ @"Other" ]);
    GH_ASSERT([SBWriter menuIsOpenForPopup:popup focused:nil]);
    SBFakeAXNode *listbox = [SBFakeAXNode nodeWithRole:@"AXPopUpButton" title:@"Country" frame:CGRectMake(100, 100, 300, 30)];
    listbox.value = @"Select...";
    [listbox addChild:[SBFakeAXNode staticText:@"Canada" frame:CGRectZero]];   // an ARIA listbox: options, no AXMenu
    GH_ASSERT_FALSE([SBWriter menuIsOpenForPopup:listbox focused:nil]);
    SBFakeAXNode *item = [[listbox addChild:[SBFakeAXNode nodeWithRole:@"AXGroup"]] addChild:[SBFakeAXNode nodeWithRole:@"AXMenuItem" title:@"Canada" frame:CGRectZero]];
    GH_ASSERT([SBWriter menuIsOpenForPopup:listbox focused:item]);
    SBFakeAXNode *strayItem = [SBFakeAXNode nodeWithRole:@"AXMenuItem" title:@"Quit" frame:CGRectZero];
    GH_ASSERT_FALSE([SBWriter menuIsOpenForPopup:listbox focused:strayItem]);   // some other menu: not ours
    GH_ASSERT_FALSE([SBWriter menuIsOpenForPopup:nil focused:item]);

    // A popup whose "menu" never shows up as an AXMenu (a slow app, an ARIA listbox): no match, and no Escape either.
    SBFakeAXActuator *actuator = [[SBFakeAXActuator alloc] init];
    SBWriter *writer = Writer(actuator);
    SBField *field = FieldFor(@"Country", SBKindSelect);
    SBGhost *ghost = GhostFor(field, SBGhostActionSelect, @"Canada");
    SBFakeAXNode *bare = [SBFakeAXNode nodeWithRole:@"AXPopUpButton" title:@"Country" frame:CGRectMake(100, 100, 300, 30)];
    bare.value = @"Select...";
    SBWriteResult *result = Run(writer, ghost, field, bare, nil);
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBWriteReasonOptionNotFound);
    GH_ASSERT_EQUAL_INT(actuator.dismissMenuCount, 0);

    // The menu is open, but the user pressed a key while it was up: the key was theirs, no Escape follows it.
    SBFakeAXActuator *keyed = [[SBFakeAXActuator alloc] init];
    SBWriter *interrupted = Writer(keyed);
    __weak SBWriter *weakWriter = interrupted;
    interrupted.after = ^(NSTimeInterval delay, dispatch_block_t block) { [weakWriter noteUserKeyEvent]; block(); };
    result = Run(interrupted, ghost, field, Popup(@[ @"Select an option", @"Other" ]), nil);
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBWriteReasonOptionNotFound);
    GH_ASSERT_EQUAL_INT(keyed.dismissMenuCount, 0);
    // A key outside a pick changes nothing for the next one.
    interrupted.after = ^(NSTimeInterval delay, dispatch_block_t block) { block(); };
    result = Run(interrupted, ghost, field, Popup(@[ @"Select an option", @"Other" ]), nil);
    GH_ASSERT_EQUAL_INT(keyed.dismissMenuCount, 1);
}

GH_TEST(writer_runs_one_write_at_a_time) {
    SBFakeAXActuator *actuator = [[SBFakeAXActuator alloc] init];
    SBWriter *writer = [[SBWriter alloc] initWithActuator:actuator];
    writer.isNodeSensitive = ^BOOL(id<SBAXNode> node) { return NO; };
    NSMutableArray<dispatch_block_t> *queued = [NSMutableArray array];
    writer.after = ^(NSTimeInterval delay, dispatch_block_t block) { [queued addObject:[block copy]]; };   // verification is pending
    SBFakeAXNode *first = TextField(@"First name"), *last = TextField(@"Last name");
    SBField *firstField = FieldFor(@"First name", SBKindText), *lastField = FieldFor(@"Last name", SBKindText);
    __block SBWriteResult *a = nil, *b = nil;
    [writer executeGhost:GhostFor(firstField, SBGhostActionFill, @"Alex") field:firstField node:first optionNode:nil completion:^(SBWriteResult *r) { a = r; }];
    GH_ASSERT(writer.busy && a == nil);
    [writer executeGhost:GhostFor(lastField, SBGhostActionFill, @"Chen") field:lastField node:last optionNode:nil completion:^(SBWriteResult *r) { b = r; }];
    GH_ASSERT_EQUAL_OBJECTS(b.reason, SBWriteReasonBusy);
    GH_ASSERT_EQUAL_OBJECTS(last.value, @"");
    GH_ASSERT_EQUAL_INT(queued.count, 1);
    queued.firstObject();
    GH_ASSERT(a.ok);
    GH_ASSERT_FALSE(writer.busy);
}

#pragma mark - typing through SBKeyPoster, uploads, lazy selects

GH_TEST(writer_live_actuator_types_only_through_the_key_poster_into_the_focused_node) {
    SBFakeDesktopState *state = [[SBFakeDesktopState alloc] init];
    state.frontmostPID = 321;
    SBFakeKeyPoster *poster = [[SBFakeKeyPoster alloc] initWithState:state];
    SBAXLiveActuator *actuator = [[SBAXLiveActuator alloc] initWithPoster:poster];
    GH_ASSERT(actuator.poster == poster);
    SBFakeAXNode *field = TextField(@"Why us?");
    SBFakeAXNode *elsewhere = TextField(@"Search");
    state.focusedNode = field;
    // A line break is typed as a space: never an Enter. Every chunk re-checks focus and the app.
    GH_ASSERT([actuator typeText:@"Fast tools.\nLow latency, always and everywhere." intoNode:field]);
    GH_ASSERT_EQUAL_OBJECTS(poster.typedText, @"Fast tools. Low latency, always and everywhere.");
    GH_ASSERT(poster.guardCalls >= 3);
    GH_ASSERT_EQUAL_INT([poster countOfKind:SBKeyStrokeKindReturn], 0);
    // Focus moves after the first chunk: the rest is never typed.
    __block NSUInteger posts = 0;
    poster.onPost = ^(SBKeyStroke *stroke) { if (++posts == 1) state.focusedNode = elsewhere; };
    NSUInteger before = poster.posted.count;
    GH_ASSERT_FALSE([actuator typeText:[@"" stringByPaddingToLength:50 withString:@"y" startingAtIndex:0] intoNode:field]);
    GH_ASSERT_EQUAL_INT(poster.posted.count, before + 1);
    // Another app in front: nothing at all.
    poster.onPost = nil;
    state.focusedNode = field;
    before = poster.posted.count;
    __block BOOL switched = NO;
    poster.onPost = ^(SBKeyStroke *stroke) { if (!switched) { switched = YES; state.frontmostPID = 999; } };
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
    SBFakeAXActuator *actuator = [[SBFakeAXActuator alloc] init];
    SBFakeAXNode *node = TextField(@"First name");
    SBFakeAXNode *other = TextField(@"Other");
    GH_ASSERT([actuator focusNode:other]);
    GH_ASSERT_FALSE([actuator typeText:@"Alex" intoNode:node]);   // focus is elsewhere: refused
    GH_ASSERT_EQUAL_OBJECTS(node.value, @"");
    GH_ASSERT_EQUAL_OBJECTS(other.value, @"");
    GH_ASSERT([actuator focusNode:node]);
    GH_ASSERT([actuator typeText:@"Alex" intoNode:node]);
    GH_ASSERT_EQUAL_OBJECTS(node.value, @"Alex");
    GH_ASSERT_EQUAL_OBJECTS(actuator.focusRequests, (@[ other, node ]));
}

static SBFakeAXNode *UploadWidget(SBFakeAXNode **attach, SBFakeAXNode **input) {
    SBFakeAXNode *widget = [SBFakeAXNode nodeWithRole:@"AXGroup" title:@"Resume/CV" frame:CGRectMake(100, 100, 600, 200)];
    SBFakeAXNode *row = [widget addChild:[SBFakeAXNode nodeWithRole:@"AXGroup" title:nil frame:CGRectMake(100, 130, 300, 50)]];
    *attach = [row addChild:[SBFakeAXNode nodeWithRole:@"AXButton" title:@"Attach" frame:CGRectMake(100, 130, 300, 43)]];
    *input = [row addChild:[SBFakeAXNode nodeWithRole:@"AXButton" title:nil frame:CGRectMake(398, 130, 2, 2)]];
    (*input).subrole = @"AXFileUploadButton";
    (*input).identifier = @"resume";
    [widget addChild:[SBFakeAXNode nodeWithRole:@"AXButton" title:@"Dropbox" frame:CGRectMake(100, 180, 300, 43)]];
    return widget;
}

GH_TEST(writer_upload_widget_helpers_read_page_text_and_remove_controls) {
    SBFakeAXNode *attach = nil, *input = nil;
    SBFakeAXNode *widget = UploadWidget(&attach, &input);
    GH_ASSERT([SBWriter uploadWidgetOfInput:input] == widget);   // climbs past the unnamed row to "Resume/CV"
    GH_ASSERT_FALSE([SBWriter widget:widget mentionsFile:@"resume-alex-chen.pdf"]);
    GH_ASSERT_FALSE([SBWriter widgetHasRemoveControl:widget]);
    SBFakeAXNode *typed = [widget addChild:TextField(@"Notes")];
    typed.value = @"resume-alex-chen.pdf";                          // a field's value is never read
    GH_ASSERT_FALSE([SBWriter widget:widget mentionsFile:@"resume-alex-chen.pdf"]);
    [widget addChild:[SBFakeAXNode staticText:@"RESUME-ALEX-CHEN.PDF" frame:CGRectZero]];
    GH_ASSERT([SBWriter widget:widget mentionsFile:@"resume-alex-chen.pdf"]);
    [widget addChild:[SBFakeAXNode nodeWithRole:@"AXButton" title:@"Remove file" frame:CGRectZero]];
    GH_ASSERT([SBWriter widgetHasRemoveControl:widget]);
    GH_ASSERT([SBWriter uploadWidgetOfInput:nil] == nil);
    GH_ASSERT_FALSE([SBWriter widget:nil mentionsFile:@"x.pdf"]);
}

GH_TEST(writer_upload_and_lazy_select_are_refused_without_their_drivers) {
    SBFakeAXActuator *actuator = [[SBFakeAXActuator alloc] init];
    SBWriter *writer = Writer(actuator);
    SBFakeAXNode *attach = nil, *input = nil;
    (void)UploadWidget(&attach, &input);
    SBField *file = FieldFor(@"Resume/CV", SBKindFile);
    SBGhost *upload = GhostFor(file, SBGhostActionUpload, @"/Users/example/resume-alex-chen.pdf");
    upload.displayText = @"resume-alex-chen.pdf";
    SBWriteResult *result = Run(writer, upload, file, attach, input);
    GH_ASSERT(result.refused);
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBWriteReasonUnsupported);
    GH_ASSERT_EQUAL_INT(actuator.pressedNodes.count, 0);

    // A lazy select on a react-select input without the combobox driver is never typed as free text.
    SBFakeAXNode *combo = [SBFakeAXNode nodeWithRole:@"AXComboBox" title:@"Country" frame:CGRectMake(100, 100, 300, 30)];
    combo.value = @"";
    SBField *select = FieldFor(@"Country", SBKindSelect);
    select.lazyOptions = YES;
    SBGhost *lazy = GhostFor(select, SBGhostActionSelect, @"Canada");
    lazy.lazy = YES;
    SBWriteResult *refused = Run(writer, lazy, select, combo, nil);
    GH_ASSERT(refused.refused);
    GH_ASSERT_EQUAL_OBJECTS(refused.reason, SBWriteReasonUnsupported);
    GH_ASSERT_EQUAL_INT(actuator.setValueCount + actuator.typeCount + actuator.focusCount, 0);
    GH_ASSERT_EQUAL_OBJECTS(combo.value, @"");

    // A path never goes into a file field any other way, and an upload never into anything but a file field.
    GH_ASSERT_EQUAL_OBJECTS(Run(writer, GhostFor(file, SBGhostActionFill, @"/Users/example/r.pdf"), file, attach, input).reason, SBWriteReasonUnsupported);
    SBField *text = FieldFor(@"Website", SBKindText);
    SBFakeAXNode *website = TextField(@"Website");
    SBGhost *wrong = GhostFor(text, SBGhostActionUpload, @"/Users/example/r.pdf");
    GH_ASSERT(Run(writer, wrong, text, website, nil).refused);
    GH_ASSERT_EQUAL_OBJECTS(website.value, @"");

    GH_ASSERT([SBWriter ghostRunsSequence:upload field:file]);
    GH_ASSERT([SBWriter ghostRunsSequence:lazy field:select]);
    GH_ASSERT_FALSE([SBWriter ghostRunsSequence:GhostFor(text, SBGhostActionFill, @"x") field:text]);
    select.lazyOptions = NO;
    GH_ASSERT_FALSE([SBWriter ghostRunsSequence:lazy field:select]);   // a native popup is picked, not driven
}

GH_TEST(writer_upload_checks_path_target_and_existing_file_before_the_driver) {
    SBFakeAXActuator *actuator = [[SBFakeAXActuator alloc] init];
    SBWriter *writer = Writer(actuator);
    SBFakeDesktopState *state = [[SBFakeDesktopState alloc] init];
    SBFakeKeyPoster *poster = [[SBFakeKeyPoster alloc] initWithState:state];
    writer.openPanelDriver = [[SBOpenPanelDriver alloc] initWithActuator:actuator poster:poster state:state];
    SBFakeAXNode *attach = nil, *input = nil;
    (void)UploadWidget(&attach, &input);
    SBField *file = FieldFor(@"Resume/CV", SBKindFile);
    NSString *path = [SBTestTempDirectory() stringByAppendingPathComponent:@"resume-alex-chen.pdf"];
    [@"%PDF-1.4 fictional" writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:NULL];

    SBGhost *missing = GhostFor(file, SBGhostActionUpload, @"/nonexistent/ghost/resume.pdf");
    GH_ASSERT_EQUAL_OBJECTS(Run(writer, missing, file, attach, input).reason, @"upload-invalid-path");
    file.value = @"resume-old.pdf";                                   // the widget already holds a file
    GH_ASSERT_EQUAL_OBJECTS(Run(writer, GhostFor(file, SBGhostActionUpload, path), file, attach, input).reason, SBWriteReasonHasValue);
    file.value = @"";
    // "Attach" renamed into something that is not an upload control: the file input is the fallback target.
    attach.title = @"Dropbox";
    state.frontmostPID = 0;                                           // the driver then refuses: no app in front
    SBWriteResult *fallback = Run(writer, GhostFor(file, SBGhostActionUpload, path), file, attach, input);
    GH_ASSERT_EQUAL_OBJECTS(fallback.reason, @"upload-no-frontmost-app");
    GH_ASSERT(fallback.refused);
    GH_ASSERT(fallback.sequence);
    input.subrole = nil;                                              // and with no upload control at all
    GH_ASSERT_EQUAL_OBJECTS(Run(writer, GhostFor(file, SBGhostActionUpload, path), file, attach, input).reason, @"upload-no-upload-target");
    GH_ASSERT_EQUAL_INT(actuator.pressedNodes.count, 0);
    GH_ASSERT_EQUAL_INT(poster.posted.count, 0);
}
