// GHWalkState (the pure walk), the Tab / Escape rule, and the event tap's callback logic. No AX, no real tap.
#import "GHTest.h"
#import "GHEventTap.h"
#import "GHKeyPoster.h"
#import "GHWalkState.h"

#pragma mark - helpers

static GHGhost *Fill(NSString *signature, NSString *value) {
    GHGhost *ghost = [[GHGhost alloc] init];
    ghost.signature = signature;
    ghost.action = GHGhostActionFill;
    ghost.value = value;
    ghost.displayText = value;
    ghost.confidence = 0.95;
    return ghost;
}

static GHGhost *Lock(NSString *signature) {
    GHGhost *ghost = [[GHGhost alloc] init];
    ghost.signature = signature;
    ghost.action = GHGhostActionClick;
    ghost.displayText = @"Submit";
    ghost.confidence = 1;
    ghost.locked = YES;
    return ghost;
}

static GHGhost *Pending(NSString *signature) {
    GHGhost *ghost = Fill(signature, @"");
    ghost.pending = YES;
    ghost.source = @"llm";
    return ghost;
}

static NSArray<GHGhost *> *Form(void) {
    return @[ Fill(@"first", @"Alex"), Fill(@"last", @"Chen"), Fill(@"email", @"alex.chen@example.com"), Lock(@"submit") ];
}

static NSArray<NSString *> *Signatures(GHWalkState *walk) {
    return [walk.ghosts valueForKey:@"signature"];
}

static GHWalkSnapshot Ready(void) {
    GHWalkSnapshot s = { 0 };
    s.active = YES;
    s.hasCurrent = YES;
    s.currentVisible = YES;
    s.focusInWalk = YES;
    return s;
}

#pragma mark - GHGhost

GH_TEST(walk_ghost_parses_core_dictionaries) {
    GHGhost *ghost = [GHGhost ghostWithDictionary:@{ @"signature": @"a", @"action": @"fill", @"value": @"Alex", @"displayText": @"Alex",
                                                     @"confidence": @0.9, @"locked": @NO, @"source": @"server" }];
    GH_ASSERT_EQUAL_OBJECTS(ghost.value, @"Alex");
    GH_ASSERT_EQUAL_OBJECTS(ghost.source, @"server");
    GH_ASSERT_EQUAL_INT(ghost.keystrokes, 4);
    GH_ASSERT_EQUAL_OBJECTS([ghost dictionary][@"displayText"], @"Alex");
    GH_ASSERT([GHGhost ghostWithDictionary:@{ @"action": @"fill" }] == nil);
    GH_ASSERT([GHGhost ghostWithDictionary:@{ @"signature": @"a", @"action": @"submit" }] == nil);
    // A click ghost is the parked lock, whatever its `locked` flag says: it can never become an accept.
    GHGhost *click = [GHGhost ghostWithDictionary:@{ @"signature": @"b", @"action": @"click", @"locked": @NO }];
    GH_ASSERT(click.locked);
    GH_ASSERT_FALSE([[ghost description] containsString:@"Alex"]);
    GH_ASSERT_EQUAL_INT([GHGhost ghostsWithDictionaries:(@[ @{ @"signature": @"a", @"action": @"check" }, @"junk", @{} ])].count, 1);
}

#pragma mark - state

GH_TEST(walk_rescan_parks_lock_last_and_starts_on_first_ghost) {
    GHWalkState *walk = [[GHWalkState alloc] init];
    [walk rescanWithGhosts:@[ Lock(@"submit"), Fill(@"first", @"Alex"), Fill(@"last", @"Chen") ]];
    NSArray *expected = @[ @"first", @"last", @"submit" ];
    GH_ASSERT_EQUAL_OBJECTS(Signatures(walk), expected);
    GH_ASSERT_EQUAL_INT(walk.currentIndex, 0);
    GH_ASSERT_EQUAL_OBJECTS(walk.lockSignature, @"submit");
    GH_ASSERT(walk.hasUnlocked);
    GH_ASSERT_FALSE(walk.keepLock);
}

GH_TEST(walk_accept_advances_counts_and_leaves_the_field) {
    GHWalkState *walk = [[GHWalkState alloc] init];
    [walk rescanWithGhosts:Form()];
    [walk accept:@"first"];
    GH_ASSERT_EQUAL_INT(walk.accepted, 1);
    GH_ASSERT_EQUAL_INT(walk.keystrokesSaved, 4);
    GH_ASSERT_EQUAL_OBJECTS(walk.current.signature, @"last");
    GH_ASSERT_EQUAL_OBJECTS(walk.leftSignature, @"first");
    [walk accept:@"last"];
    [walk accept:@"email"];
    GH_ASSERT_EQUAL_INT(walk.keystrokesSaved, 4 + 4 + 21);
    // Only now is the lock ghost current, and it can never be accepted.
    GH_ASSERT(walk.current.locked);
    GH_ASSERT(walk.finished);
    [walk accept:@"submit"];
    GH_ASSERT_EQUAL_INT(walk.accepted, 3);
    GH_ASSERT_EQUAL_OBJECTS(walk.current.signature, @"submit");
}

GH_TEST(walk_lock_is_never_current_while_unlocked_ghosts_remain) {
    GHWalkState *walk = [[GHWalkState alloc] init];
    [walk rescanWithGhosts:Form()];
    [walk focusMoved:@"submit"];            // the user clicked the button early
    GH_ASSERT_EQUAL_OBJECTS(walk.current.signature, @"first");
    GH_ASSERT_FALSE([walk makeCurrent:@"submit"]);
    [walk rescanWithGhosts:Form()];         // a rescan with focus on the button changes nothing either
    GH_ASSERT_EQUAL_OBJECTS(walk.current.signature, @"first");
    [walk dismiss:@"first"];
    [walk dismiss:@"last"];
    GH_ASSERT_EQUAL_OBJECTS(walk.current.signature, @"email");
}

GH_TEST(walk_rescan_keeps_current_accepted_and_never_resurrects_dismissed) {
    GHWalkState *walk = [[GHWalkState alloc] init];
    [walk rescanWithGhosts:Form()];
    [walk accept:@"first"];
    [walk dismiss:@"last"];
    GH_ASSERT_EQUAL_OBJECTS(walk.current.signature, @"email");
    // The page re-rendered: the core offers everything again, plus a new field in front.
    [walk rescanWithGhosts:@[ Fill(@"phone", @"+1 519 555 0142"), Fill(@"last", @"Chen"), Fill(@"email", @"alex.chen@example.com"), Lock(@"submit") ]];
    NSArray *expected = @[ @"phone", @"email", @"submit" ];
    GH_ASSERT_EQUAL_OBJECTS(Signatures(walk), expected);
    GH_ASSERT_EQUAL_OBJECTS(walk.current.signature, @"email");
    GH_ASSERT_EQUAL_INT(walk.accepted, 1);
    GH_ASSERT([walk.dismissed containsObject:@"last"]);
    // The current ghost disappeared: focus decides, then the first unlocked ghost.
    [walk noteFocus:@"phone"];
    [walk rescanWithGhosts:@[ Fill(@"city", @"Waterloo"), Fill(@"phone", @"+1 519 555 0142"), Lock(@"submit") ]];
    GH_ASSERT_EQUAL_OBJECTS(walk.current.signature, @"phone");
    [walk noteFocus:nil];
    [walk rescanWithGhosts:@[ Fill(@"city", @"Waterloo"), Lock(@"submit") ]];
    GH_ASSERT_EQUAL_OBJECTS(walk.current.signature, @"city");
}

GH_TEST(walk_wraps_around_to_ghosts_the_user_skipped) {
    GHWalkState *walk = [[GHWalkState alloc] init];
    [walk rescanWithGhosts:Form()];
    [walk focusMoved:@"email"];             // the user jumped ahead
    GH_ASSERT_EQUAL_OBJECTS(walk.current.signature, @"email");
    [walk accept:@"email"];
    GH_ASSERT_EQUAL_OBJECTS(walk.current.signature, @"first");   // not the lock: two unlocked ghosts are left
    [walk accept:@"first"];
    GH_ASSERT_EQUAL_OBJECTS(walk.current.signature, @"last");
}

GH_TEST(walk_typing_overrides_for_good) {
    GHWalkState *walk = [[GHWalkState alloc] init];
    [walk rescanWithGhosts:Form()];
    [walk typedOver:@"first"];
    GH_ASSERT([walk ghostWithSignature:@"first"] == nil);
    GH_ASSERT_EQUAL_OBJECTS(walk.leftSignature, @"first");
    GH_ASSERT_EQUAL_OBJECTS(walk.current.signature, @"last");
    // A field that had no ghost when the user typed in it never gets one later either (rule 9).
    [walk typedOver:@"phone"];
    [walk typedOver:GHWalkFocusElsewhere];
    [walk rescanWithGhosts:[Form() arrayByAddingObject:Fill(@"phone", @"+1 519 555 0142")]];
    NSArray *expected = @[ @"last", @"email", @"submit" ];
    GH_ASSERT_EQUAL_OBJECTS(Signatures(walk), expected);
    GH_ASSERT_FALSE([walk.dismissed containsObject:GHWalkFocusElsewhere]);
}

GH_TEST(walk_focus_follows_the_user) {
    GHWalkState *walk = [[GHWalkState alloc] init];
    [walk rescanWithGhosts:Form()];
    [walk focusMoved:@"last"];
    GH_ASSERT_EQUAL_OBJECTS(walk.current.signature, @"last");
    [walk focusMoved:GHWalkFocusElsewhere];
    GH_ASSERT_EQUAL_OBJECTS(walk.current.signature, @"last");
    GH_ASSERT_EQUAL_OBJECTS(walk.focusSignature, GHWalkFocusElsewhere);
    [walk focusMoved:nil];
    GH_ASSERT(walk.focusSignature == nil);
}

GH_TEST(walk_lone_lock_needs_an_accept_and_strangers_are_dropped) {
    GHWalkState *walk = [[GHWalkState alloc] init];
    [walk rescanWithGhosts:@[ Lock(@"delete-all") ]];
    GH_ASSERT_EQUAL_INT(walk.ghosts.count, 0);          // a lone locked button is never a ghost on its own
    GH_ASSERT_EQUAL_INT(walk.currentIndex, -1);

    [walk rescanWithGhosts:@[ Fill(@"first", @"Alex"), Lock(@"submit") ]];
    [walk dismiss:@"first"];
    GH_ASSERT_EQUAL_INT(walk.ghosts.count, 0);          // nothing accepted: the lock goes with the last value ghost

    [walk reset];
    [walk rescanWithGhosts:@[ Fill(@"first", @"Alex"), Lock(@"submit") ]];
    [walk accept:@"first"];
    GH_ASSERT(walk.keepLock);
    GH_ASSERT_EQUAL_OBJECTS(walk.current.signature, @"submit");
    [walk rescanWithGhosts:@[ Lock(@"submit") ]];       // keepLock rescan: still parked
    GH_ASSERT_EQUAL_OBJECTS(walk.current.signature, @"submit");
    [walk rescanWithGhosts:@[ Lock(@"delete-all") ]];   // a later view's locked button never inherits the lock ghost
    GH_ASSERT_EQUAL_INT(walk.ghosts.count, 0);
}

GH_TEST(walk_failure_stops_with_a_reason_and_the_next_accept_clears_it) {
    GHWalkState *walk = [[GHWalkState alloc] init];
    [walk rescanWithGhosts:Form()];
    [walk fail:@"first" reason:@"did-not-hold"];
    GH_ASSERT([walk.error containsString:@"did-not-hold"]);
    GH_ASSERT_FALSE([walk.error containsString:@"Alex"]);
    GH_ASSERT([walk.dismissed containsObject:@"first"]);   // Tab cannot get stuck on the failed ghost
    GH_ASSERT_EQUAL_OBJECTS(walk.current.signature, @"last");
    GH_ASSERT_EQUAL_INT(walk.accepted, 0);
    [walk accept:@"last"];
    GH_ASSERT(walk.error == nil);
}

GH_TEST(walk_pending_drafts_update_in_place_and_are_skipped_by_a_hold) {
    GHWalkState *walk = [[GHWalkState alloc] init];
    [walk rescanWithGhosts:@[ Pending(@"why"), Fill(@"first", @"Alex"), Pending(@"cover"), Lock(@"submit") ]];
    GH_ASSERT(walk.current.pending);
    GH_ASSERT([walk skipPendingCurrent]);
    GH_ASSERT_EQUAL_OBJECTS(walk.current.signature, @"first");
    [walk accept:@"first"];
    GH_ASSERT_EQUAL_OBJECTS(walk.current.signature, @"cover");
    GH_ASSERT_FALSE([walk skipPendingCurrent]);         // only pending drafts and the lock are left
    GH_ASSERT_EQUAL_OBJECTS(walk.current.signature, @"cover");

    GHGhost *done = Fill(@"cover", @"I build fast tools.");
    done.source = @"llm";
    GH_ASSERT([walk updateGhost:done]);
    GH_ASSERT_FALSE(walk.current.pending);
    GH_ASSERT_EQUAL_OBJECTS(walk.current.signature, @"cover");
    GH_ASSERT_FALSE([walk updateGhost:Fill(@"unknown", @"x")]);
    GH_ASSERT_FALSE([walk updateGhost:Fill(@"submit", @"x")]);   // the lock is never replaced by a value ghost
}

GH_TEST(walk_drop_and_reset) {
    GHWalkState *walk = [[GHWalkState alloc] init];
    [walk rescanWithGhosts:Form()];
    [walk accept:@"first"];
    [walk drop:@"last"];                                 // the element vanished: not a dismissal, not a "left" field
    GH_ASSERT_FALSE([walk.dismissed containsObject:@"last"]);
    GH_ASSERT_EQUAL_OBJECTS(walk.leftSignature, @"first");
    [walk noteFocus:@"email"];
    [walk reset];
    GH_ASSERT_EQUAL_INT(walk.ghosts.count, 0);
    GH_ASSERT_EQUAL_INT(walk.accepted, 0);
    GH_ASSERT_EQUAL_INT(walk.keystrokesSaved, 0);
    GH_ASSERT_EQUAL_INT(walk.dismissed.count, 0);
    GH_ASSERT(walk.leftSignature == nil && walk.lockSignature == nil && walk.error == nil);
    GH_ASSERT_EQUAL_OBJECTS(walk.focusSignature, @"email");   // where the keyboard is has nothing to do with the walk
}

#pragma mark - the Tab rule

GH_TEST(tab_is_native_unless_every_condition_holds) {
    GHHoldState hold = { NO, NO };
    GH_ASSERT_EQUAL_INT(GHDecideTab(Ready(), GHKeyModifierNone, NO, &hold), GHKeyDecisionAccept);
    GH_ASSERT(hold.walking);

    GHWalkSnapshot s = Ready();
    s.active = NO;                                        // disabled, untrusted or paused app
    GH_ASSERT_EQUAL_INT(GHDecideTab(s, GHKeyModifierNone, NO, &hold), GHKeyDecisionPass);
    GH_ASSERT_FALSE(hold.walking);
    s = Ready(); s.hasCurrent = NO;
    GH_ASSERT_EQUAL_INT(GHDecideTab(s, GHKeyModifierNone, NO, &hold), GHKeyDecisionPass);
    s = Ready(); s.currentVisible = NO;                   // no write the user cannot see
    GH_ASSERT_EQUAL_INT(GHDecideTab(s, GHKeyModifierNone, NO, &hold), GHKeyDecisionPass);
    s = Ready(); s.focusInWalk = NO;                      // a search box, an essay, a code editor
    GH_ASSERT_EQUAL_INT(GHDecideTab(s, GHKeyModifierNone, NO, &hold), GHKeyDecisionPass);
    GH_ASSERT_FALSE(hold.walking);

    for (NSNumber *modifier in @[ @(GHKeyModifierShift), @(GHKeyModifierControl), @(GHKeyModifierOption), @(GHKeyModifierCommand),
                                  @(GHKeyModifierShift | GHKeyModifierCommand) ]) {
        GH_ASSERT_EQUAL_INT(GHDecideTab(Ready(), (GHKeyModifiers)modifier.unsignedIntegerValue, NO, &hold), GHKeyDecisionPass);
    }
    GH_ASSERT_EQUAL_INT(GHDecideTab(Ready(), GHKeyModifierNone, NO, NULL), GHKeyDecisionAccept);   // NULL hold is allowed
}

/// Tab is the most overloaded key on the keyboard. Ghost takes it ONLY where it is already doing what Tab
/// does -- walking a form, focus on the ghost's own field. A next-action proposal never changes that, however
/// convenient it looks: everywhere else the Ghost key is the accept key, and it has no conflict surface.
GH_TEST(tab_is_never_taken_from_an_app_for_a_proposal) {
    GHHoldState hold = { NO, NO };
    GHWalkSnapshot s = Ready();
    s.focusInWalk = NO;
    s.currentIsProposal = YES;
    GH_ASSERT_EQUAL_INT(GHDecideTab(s, GHKeyModifierNone, NO, &hold), GHKeyDecisionPass);
    GH_ASSERT_FALSE(hold.walking);

    // Focus in a text box, same answer.
    hold = (GHHoldState){ NO, NO };
    s.focusOnTypeable = YES;
    GH_ASSERT_EQUAL_INT(GHDecideTab(s, GHKeyModifierNone, NO, &hold), GHKeyDecisionPass);

    // With focus on the ghost's own field it IS the form case, and Tab is Ghost's.
    hold = (GHHoldState){ NO, NO };
    s = Ready();
    s.currentIsProposal = YES;
    GH_ASSERT_EQUAL_INT(GHDecideTab(s, GHKeyModifierNone, NO, &hold), GHKeyDecisionAccept);
}

/// The Ghost key is a choice, and both choices are a lone right-hand modifier tap: nothing macOS or any app
/// binds, and holding the key is untouched because a chord is never a tap.
GH_TEST(ghost_key_choice_maps_to_a_key_code_a_flag_and_a_name) {
    GH_ASSERT_EQUAL_INT(GHGhostKeyFromName(@"right-command"), GHGhostKeyRightCommand);
    GH_ASSERT_EQUAL_INT(GHGhostKeyFromName(@"right-option"), GHGhostKeyRightOption);
    // Anything unknown leaves the default in place rather than turning the accept key off.
    GH_ASSERT_EQUAL_INT(GHGhostKeyFromName(@"f19"), GHGhostKeyRightOption);
    GH_ASSERT_EQUAL_INT(GHGhostKeyFromName(nil), GHGhostKeyRightOption);

    GH_ASSERT_EQUAL_INT(GHGhostKeyCode(GHGhostKeyRightOption), GHKeyCodeRightOption);
    GH_ASSERT_EQUAL_INT(GHGhostKeyCode(GHGhostKeyRightCommand), GHKeyCodeRightCommand);
    GH_ASSERT(GHGhostKeyFlagMask(GHGhostKeyRightOption) == kCGEventFlagMaskAlternate);
    GH_ASSERT(GHGhostKeyFlagMask(GHGhostKeyRightCommand) == kCGEventFlagMaskCommand);
    GH_ASSERT(GHGhostKeyDisplayName(GHGhostKeyRightOption).length > 0);
    GH_ASSERT_FALSE([GHGhostKeyDisplayName(GHGhostKeyRightOption) isEqualToString:GHGhostKeyDisplayName(GHGhostKeyRightCommand)]);
}

GH_TEST(tab_hold_only_counts_when_ghost_took_the_first_press) {
    GHHoldState hold = { NO, NO };
    // A native hold (focus was elsewhere) that wanders onto a ghosted field never starts accepting.
    GHWalkSnapshot elsewhere = Ready();
    elsewhere.focusInWalk = NO;
    GH_ASSERT_EQUAL_INT(GHDecideTab(elsewhere, GHKeyModifierNone, NO, &hold), GHKeyDecisionPass);
    GH_ASSERT_EQUAL_INT(GHDecideTab(Ready(), GHKeyModifierNone, YES, &hold), GHKeyDecisionPass);

    // A hold Ghost owns: every repeat accepts, even though focus is wherever the last write left it.
    GH_ASSERT_EQUAL_INT(GHDecideTab(Ready(), GHKeyModifierNone, NO, &hold), GHKeyDecisionAccept);
    GHWalkSnapshot moved = Ready();
    moved.focusInWalk = NO;
    GH_ASSERT_EQUAL_INT(GHDecideTab(moved, GHKeyModifierNone, YES, &hold), GHKeyDecisionAccept);

    // The walk ran out (or the next ghost is off screen) mid-hold: swallowed, focus must not race off natively.
    GHWalkSnapshot empty = Ready();
    empty.hasCurrent = NO;
    GH_ASSERT_EQUAL_INT(GHDecideTab(empty, GHKeyModifierNone, YES, &hold), GHKeyDecisionSwallow);
    // Shift pressed mid-hold: the chord is the app's and the hold is over.
    GH_ASSERT_EQUAL_INT(GHDecideTab(Ready(), GHKeyModifierShift, YES, &hold), GHKeyDecisionPass);
    GH_ASSERT_EQUAL_INT(GHDecideTab(Ready(), GHKeyModifierNone, YES, &hold), GHKeyDecisionPass);
}

GH_TEST(tab_never_activates_a_lock_and_swallows_the_rest_of_the_hold) {
    GHHoldState hold = { NO, NO };
    GHWalkSnapshot locked = Ready();
    locked.currentLocked = YES;
    GH_ASSERT_EQUAL_INT(GHDecideTab(locked, GHKeyModifierNone, NO, &hold), GHKeyDecisionPark);
    GH_ASSERT(hold.halted);
    for (int i = 0; i < 5; i++) GH_ASSERT_EQUAL_INT(GHDecideTab(locked, GHKeyModifierNone, YES, &hold), GHKeyDecisionSwallow);
    // Over-pressing is harmless: a fresh press parks again, it never becomes an accept.
    GH_ASSERT_EQUAL_INT(GHDecideTab(locked, GHKeyModifierNone, NO, &hold), GHKeyDecisionPark);
    // Once the user moved into another control, Tab is native again.
    locked.focusInWalk = NO;
    GH_ASSERT_EQUAL_INT(GHDecideTab(locked, GHKeyModifierNone, NO, &hold), GHKeyDecisionPass);
}

GH_TEST(tab_during_a_write_is_queued_and_repeats_are_dropped) {
    GHHoldState hold = { NO, NO };
    GHWalkSnapshot busy = Ready();
    busy.busy = YES;
    GH_ASSERT_EQUAL_INT(GHDecideTab(busy, GHKeyModifierNone, NO, &hold), GHKeyDecisionQueue);
    GH_ASSERT(hold.walking);
    GH_ASSERT_EQUAL_INT(GHDecideTab(busy, GHKeyModifierNone, YES, &hold), GHKeyDecisionSwallow);
    // The queued press owns the hold that follows it.
    GH_ASSERT_EQUAL_INT(GHDecideTab(Ready(), GHKeyModifierNone, YES, &hold), GHKeyDecisionAccept);
    GHHoldState native = { NO, NO };
    GH_ASSERT_EQUAL_INT(GHDecideTab(busy, GHKeyModifierNone, YES, &native), GHKeyDecisionPass);
    // Mid-write, a Tab in another app or another field is that app's: never queued, never swallowed.
    GHWalkSnapshot away = busy;
    away.focusInWalk = NO;
    GHHoldState elsewhere = { NO, NO };
    GH_ASSERT_EQUAL_INT(GHDecideTab(away, GHKeyModifierNone, NO, &elsewhere), GHKeyDecisionPass);
    GH_ASSERT_FALSE(elsewhere.walking);
    GH_ASSERT_EQUAL_INT(GHDecideTab(away, GHKeyModifierNone, YES, &elsewhere), GHKeyDecisionPass);
}

GH_TEST(tab_jumps_to_an_off_screen_ghost_only_on_a_fresh_press_in_the_walk) {
    GHHoldState hold = { NO, NO };
    GHWalkSnapshot offscreen = Ready();
    offscreen.currentVisible = NO;
    offscreen.canJump = YES;
    GH_ASSERT_EQUAL_INT(GHDecideTab(offscreen, GHKeyModifierNone, NO, &hold), GHKeyDecisionJump);
    GH_ASSERT(hold.walking);
    // A repeat never jumps (the hold is swallowed until the ghost is on screen), a locked current ghost jumps too.
    GH_ASSERT_EQUAL_INT(GHDecideTab(offscreen, GHKeyModifierNone, YES, &hold), GHKeyDecisionSwallow);
    GHWalkSnapshot lock = offscreen;
    lock.currentLocked = YES;
    GH_ASSERT_EQUAL_INT(GHDecideTab(lock, GHKeyModifierNone, NO, &hold), GHKeyDecisionJump);
    // Not after a jump that failed (canJump off), not with focus in another control, not with a modifier, not busy.
    GHWalkSnapshot failed = offscreen;
    failed.canJump = NO;
    GH_ASSERT_EQUAL_INT(GHDecideTab(failed, GHKeyModifierNone, NO, &hold), GHKeyDecisionPass);
    GHWalkSnapshot elsewhere = offscreen;
    elsewhere.focusInWalk = NO;
    GH_ASSERT_EQUAL_INT(GHDecideTab(elsewhere, GHKeyModifierNone, NO, &hold), GHKeyDecisionPass);
    GH_ASSERT_EQUAL_INT(GHDecideTab(offscreen, GHKeyModifierShift, NO, &hold), GHKeyDecisionPass);
    GHWalkSnapshot busy = offscreen;
    busy.busy = YES;
    GH_ASSERT_EQUAL_INT(GHDecideTab(busy, GHKeyModifierNone, NO, &hold), GHKeyDecisionQueue);
    GHWalkSnapshot none = offscreen;
    none.hasCurrent = NO;
    GH_ASSERT_EQUAL_INT(GHDecideTab(none, GHKeyModifierNone, NO, &hold), GHKeyDecisionPass);
    // The tap packs the bit.
    GHEventTap *tap = [[GHEventTap alloc] init];
    [tap publishSnapshot:offscreen];
    GH_ASSERT([tap publishedSnapshot].canJump);
}

GH_TEST(ghost_upload_and_lazy_round_trip) {
    GHGhost *upload = [GHGhost ghostWithDictionary:@{ @"signature": @"s", @"action": @"upload", @"value": @"/tmp/r.pdf", @"displayText": @"r.pdf" }];
    GH_ASSERT_EQUAL_OBJECTS(upload.action, GHGhostActionUpload);
    GH_ASSERT_FALSE(upload.locked);
    GH_ASSERT_EQUAL_INT(upload.keystrokes, 1);
    GHGhost *lazy = [GHGhost ghostWithDictionary:@{ @"signature": @"c", @"action": @"select", @"value": @"Canada", @"lazy": @YES }];
    GH_ASSERT(lazy.lazy);
    GH_ASSERT([[lazy copy] lazy]);
    GH_ASSERT_EQUAL_OBJECTS([lazy dictionary][@"lazy"], @YES);
    GH_ASSERT([upload dictionary][@"lazy"] == nil);
    // Only a select can be lazy; an unknown action is still no ghost at all.
    GH_ASSERT_FALSE([GHGhost ghostWithDictionary:@{ @"signature": @"f", @"action": @"fill", @"lazy": @YES }].lazy);
    GH_ASSERT([GHGhost ghostWithDictionary:@{ @"signature": @"x", @"action": @"press" }] == nil);
    GH_ASSERT_FALSE([lazy.description containsString:@"Canada"]);
}

GH_TEST(escape_is_only_consumed_when_a_ghost_is_dismissed) {
    BOOL owned = NO;
    GH_ASSERT_EQUAL_INT(GHDecideEscape(Ready(), GHKeyModifierNone, NO, &owned), GHKeyDecisionDismiss);
    GH_ASSERT(owned);
    // Auto-repeat of that Escape never dismisses a second ghost, and never reaches the app half-way.
    GH_ASSERT_EQUAL_INT(GHDecideEscape(Ready(), GHKeyModifierNone, YES, &owned), GHKeyDecisionSwallow);

    GHWalkSnapshot s = Ready(); s.focusInWalk = NO;       // the page's own modal or menu keeps its Escape
    GH_ASSERT_EQUAL_INT(GHDecideEscape(s, GHKeyModifierNone, NO, &owned), GHKeyDecisionPass);
    GH_ASSERT_FALSE(owned);
    GH_ASSERT_EQUAL_INT(GHDecideEscape(Ready(), GHKeyModifierNone, YES, &owned), GHKeyDecisionPass);
    s = Ready(); s.hasCurrent = NO;
    GH_ASSERT_EQUAL_INT(GHDecideEscape(s, GHKeyModifierNone, NO, &owned), GHKeyDecisionPass);
    s = Ready(); s.currentVisible = NO;
    GH_ASSERT_EQUAL_INT(GHDecideEscape(s, GHKeyModifierNone, NO, &owned), GHKeyDecisionPass);
    s = Ready(); s.busy = YES;
    GH_ASSERT_EQUAL_INT(GHDecideEscape(s, GHKeyModifierNone, NO, &owned), GHKeyDecisionPass);
    s = Ready(); s.active = NO;
    GH_ASSERT_EQUAL_INT(GHDecideEscape(s, GHKeyModifierNone, NO, &owned), GHKeyDecisionPass);
    GH_ASSERT_EQUAL_INT(GHDecideEscape(Ready(), GHKeyModifierCommand, NO, &owned), GHKeyDecisionPass);
}

GH_TEST(walk_decides_from_where_focus_is) {
    GHWalkState *walk = [[GHWalkState alloc] init];
    GHHoldState hold = { NO, NO };
    GH_ASSERT_FALSE([walk shouldConsumeTabWithModifiers:GHKeyModifierNone isRepeat:NO focusSignature:nil currentVisible:YES hold:&hold]);   // no ghosts at all
    [walk rescanWithGhosts:Form()];
    GH_ASSERT([walk shouldConsumeTabWithModifiers:GHKeyModifierNone isRepeat:NO focusSignature:nil currentVisible:YES hold:&hold]);           // the window itself
    GH_ASSERT([walk shouldConsumeTabWithModifiers:GHKeyModifierNone isRepeat:NO focusSignature:@"first" currentVisible:YES hold:&hold]);      // the current ghost's element
    GH_ASSERT_FALSE([walk shouldConsumeTabWithModifiers:GHKeyModifierNone isRepeat:NO focusSignature:@"email" currentVisible:YES hold:&hold]); // another field
    GH_ASSERT_FALSE([walk shouldConsumeTabWithModifiers:GHKeyModifierNone isRepeat:NO focusSignature:GHWalkFocusElsewhere currentVisible:YES hold:&hold]);
    GH_ASSERT_FALSE([walk shouldConsumeTabWithModifiers:GHKeyModifierNone isRepeat:NO focusSignature:nil currentVisible:NO hold:&hold]);
    GH_ASSERT_FALSE([walk shouldConsumeTabWithModifiers:GHKeyModifierShift isRepeat:NO focusSignature:nil currentVisible:YES hold:&hold]);

    [walk accept:@"first"];   // focus is still in the field the walk just left: the next Tab is Ghost's
    GH_ASSERT([walk shouldConsumeTabWithModifiers:GHKeyModifierNone isRepeat:NO focusSignature:@"first" currentVisible:YES hold:&hold]);
    GH_ASSERT([walk shouldConsumeEscapeWithModifiers:GHKeyModifierNone focusSignature:@"first" currentVisible:YES]);
    GH_ASSERT_FALSE([walk shouldConsumeEscapeWithModifiers:GHKeyModifierNone focusSignature:GHWalkFocusElsewhere currentVisible:YES]);
    GH_ASSERT_FALSE([walk shouldConsumeEscapeWithModifiers:GHKeyModifierShift focusSignature:nil currentVisible:YES]);

    [walk noteFocus:@"last"];
    GHWalkSnapshot snapshot = [walk snapshotWithActive:YES currentVisible:YES busy:NO];
    GH_ASSERT(snapshot.hasCurrent && snapshot.focusInWalk && snapshot.focusOnField && !snapshot.currentLocked && !snapshot.currentPending);
    [walk noteFocus:GHWalkFocusElsewhere];
    snapshot = [walk snapshotWithActive:YES currentVisible:YES busy:NO];
    GH_ASSERT_FALSE(snapshot.focusInWalk || snapshot.focusOnField);
}

#pragma mark - event tap logic

@interface GHTapRecorder : NSObject <GHEventTapDelegate>
@property (nonatomic) NSMutableArray<NSString *> *events;
@end

@implementation GHTapRecorder
- (instancetype)init { if ((self = [super init])) _events = [NSMutableArray array]; return self; }
- (void)eventTap:(GHEventTap *)tap didConsumeTab:(GHKeyDecision)decision isRepeat:(BOOL)isRepeat {
    [self.events addObject:[NSString stringWithFormat:@"tab:%ld:%d", (long)decision, isRepeat]];
}
- (void)eventTapDidConsumeEscape:(GHEventTap *)tap { [self.events addObject:@"escape"]; }
- (void)eventTapDidTapGhostKey:(GHEventTap *)tap { [self.events addObject:@"ghost-key"]; }
- (void)eventTapDidSeeTypingInField:(GHEventTap *)tap { [self.events addObject:@"typing"]; }
- (void)eventTapDidSeeScroll:(GHEventTap *)tap { [self.events addObject:@"scroll"]; }
@end

static GHEventTap *Tap(GHTapRecorder *recorder) {
    GHEventTap *tap = [[GHEventTap alloc] init];   // never installed: no real CGEventTap in tests
    tap.delegate = recorder;
    tap.deliversSynchronously = YES;
    return tap;
}

GH_TEST(tap_consumes_nothing_until_a_snapshot_says_active) {
    GHTapRecorder *recorder = [[GHTapRecorder alloc] init];
    GHEventTap *tap = Tap(recorder);
    GH_ASSERT_FALSE([tap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:NO userData:0 printable:NO]);
    GH_ASSERT_FALSE([tap handleKeyDown:GHKeyCodeEscape flags:0 isRepeat:NO userData:0 printable:NO]);
    GH_ASSERT_FALSE([tap handleKeyDown:0 flags:0 isRepeat:NO userData:0 printable:YES]);
    [tap handleScroll];
    GH_ASSERT_EQUAL_INT(recorder.events.count, 0);
    GH_ASSERT_FALSE(tap.installed);

    GHWalkSnapshot snapshot = Ready();
    snapshot.currentPending = YES;
    snapshot.focusOnField = YES;
    [tap publishSnapshot:snapshot];
    GHWalkSnapshot back = [tap publishedSnapshot];
    GH_ASSERT(back.active && back.hasCurrent && back.currentVisible && back.currentPending && back.focusInWalk && back.focusOnField);
    GH_ASSERT_FALSE(back.currentLocked || back.busy);
}

GH_TEST(tap_consumes_plain_tab_and_passes_everything_else) {
    GHTapRecorder *recorder = [[GHTapRecorder alloc] init];
    GHEventTap *tap = Tap(recorder);
    [tap publishSnapshot:Ready()];
    GH_ASSERT([tap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:NO userData:0 printable:NO]);
    GH_ASSERT([tap handleKeyDown:GHKeyCodeTab flags:kCGEventFlagMaskAlphaShift | kCGEventFlagMaskSecondaryFn isRepeat:NO userData:0 printable:NO]);   // Caps Lock is no modifier
    GH_ASSERT_FALSE([tap handleKeyDown:GHKeyCodeTab flags:kCGEventFlagMaskShift isRepeat:NO userData:0 printable:NO]);
    GH_ASSERT_FALSE([tap handleKeyDown:GHKeyCodeTab flags:kCGEventFlagMaskCommand isRepeat:NO userData:0 printable:NO]);
    GH_ASSERT_FALSE([tap handleKeyDown:GHKeyCodeTab flags:kCGEventFlagMaskControl isRepeat:NO userData:0 printable:NO]);
    GH_ASSERT_FALSE([tap handleKeyDown:GHKeyCodeTab flags:kCGEventFlagMaskAlternate isRepeat:NO userData:0 printable:NO]);
    GH_ASSERT_FALSE([tap handleKeyDown:36 flags:0 isRepeat:NO userData:0 printable:NO]);   // Return is always the user's
    GH_ASSERT([tap handleKeyDown:GHKeyCodeEscape flags:0 isRepeat:NO userData:0 printable:NO]);
    NSArray *expected = @[ @"tab:1:0", @"tab:1:0", @"escape" ];
    GH_ASSERT_EQUAL_OBJECTS(recorder.events, expected);
}

GH_TEST(tap_ignores_the_events_ghost_posted_itself) {
    GHTapRecorder *recorder = [[GHTapRecorder alloc] init];
    GHEventTap *tap = Tap(recorder);
    GHWalkSnapshot snapshot = Ready();
    snapshot.focusOnField = YES;
    [tap publishSnapshot:snapshot];
    GH_ASSERT_FALSE([tap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:NO userData:GHSyntheticEventUserData printable:NO]);
    GH_ASSERT_FALSE([tap handleKeyDown:GHKeyCodeEscape flags:0 isRepeat:NO userData:GHSyntheticEventUserData printable:NO]);
    GH_ASSERT_FALSE([tap handleKeyDown:0 flags:0 isRepeat:NO userData:GHSyntheticEventUserData printable:YES]);   // our typing is not the user's typing
    GH_ASSERT_EQUAL_INT(recorder.events.count, 0);
}

GH_TEST(tap_reports_typing_only_inside_a_captured_field_and_never_consumes_it) {
    GHTapRecorder *recorder = [[GHTapRecorder alloc] init];
    GHEventTap *tap = Tap(recorder);
    [tap publishSnapshot:Ready()];                        // focus on the window itself
    GH_ASSERT_FALSE([tap handleKeyDown:0 flags:0 isRepeat:NO userData:0 printable:YES]);
    GH_ASSERT_EQUAL_INT(recorder.events.count, 0);
    GHWalkSnapshot snapshot = Ready();
    snapshot.focusOnField = YES;
    [tap publishSnapshot:snapshot];
    GH_ASSERT_FALSE([tap handleKeyDown:0 flags:kCGEventFlagMaskShift isRepeat:NO userData:0 printable:YES]);   // a capital letter
    GH_ASSERT_FALSE([tap handleKeyDown:9 flags:kCGEventFlagMaskCommand isRepeat:NO userData:0 printable:YES]);  // Cmd+V is a shortcut
    GH_ASSERT_FALSE([tap handleKeyDown:123 flags:0 isRepeat:NO userData:0 printable:NO]);                        // an arrow key
    NSArray *expected = @[ @"typing" ];
    GH_ASSERT_EQUAL_OBJECTS(recorder.events, expected);
}

GH_TEST(tap_hold_accepts_until_halted_and_key_up_ends_it) {
    GHTapRecorder *recorder = [[GHTapRecorder alloc] init];
    GHEventTap *tap = Tap(recorder);
    [tap publishSnapshot:Ready()];
    GH_ASSERT_FALSE([tap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:YES userData:0 printable:NO]);   // a hold Ghost never owned
    GH_ASSERT([tap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:NO userData:0 printable:NO]);
    GH_ASSERT([tap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:YES userData:0 printable:NO]);
    [tap haltHold];                                       // the controller: the write failed / the lock was reached
    GH_ASSERT([tap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:YES userData:0 printable:NO]);
    GH_ASSERT([tap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:YES userData:0 printable:NO]);
    NSArray *expected = @[ @"tab:1:0", @"tab:1:1" ];
    GH_ASSERT_EQUAL_OBJECTS(recorder.events, expected);   // swallowed repeats are not reported
    [tap handleKeyUp:GHKeyCodeTab userData:0];
    GH_ASSERT_FALSE([tap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:YES userData:0 printable:NO]);
    // A fresh press after a halt accepts again.
    GH_ASSERT([tap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:NO userData:0 printable:NO]);
    [tap handleFlagsChanged:kCGEventFlagMaskShift keyCode:56];  // left Shift went down mid-hold
    GH_ASSERT_FALSE([tap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:YES userData:0 printable:NO]);
}

// docs/accept-key.md: Tab belongs to the app on most screens, so a lone tap of right Option accepts too.
// The modifier event is never consumed, so every one of these presses still reaches the app.

GH_TEST(ghost_key_tap_accepts_the_current_ghost) {
    GHTapRecorder *recorder = [[GHTapRecorder alloc] init];
    GHEventTap *tap = Tap(recorder);
    [tap publishSnapshot:Ready()];
    [tap handleFlagsChanged:kCGEventFlagMaskAlternate keyCode:GHKeyCodeRightOption];   // down
    [tap handleFlagsChanged:0 keyCode:GHKeyCodeRightOption];                            // up, straight away
    NSArray *expected = @[ @"ghost-key" ];
    GH_ASSERT_EQUAL_OBJECTS(recorder.events, expected);
}

GH_TEST(ghost_key_follows_the_setting) {
    GHTapRecorder *recorder = [[GHTapRecorder alloc] init];
    GHEventTap *tap = Tap(recorder);
    tap.ghostKey = GHGhostKeyRightCommand;
    [tap publishSnapshot:Ready()];
    // Right Option is no longer the key: tapping it does nothing at all.
    [tap handleFlagsChanged:kCGEventFlagMaskAlternate keyCode:GHKeyCodeRightOption];
    [tap handleFlagsChanged:0 keyCode:GHKeyCodeRightOption];
    GH_ASSERT_EQUAL_INT(recorder.events.count, 0);
    // Right Command is.
    [tap handleFlagsChanged:kCGEventFlagMaskCommand keyCode:GHKeyCodeRightCommand];
    [tap handleFlagsChanged:0 keyCode:GHKeyCodeRightCommand];
    NSArray *expected = @[ @"ghost-key" ];
    GH_ASSERT_EQUAL_OBJECTS(recorder.events, expected);
}

GH_TEST(ghost_key_does_nothing_when_no_ghost_is_on_screen) {
    GHTapRecorder *recorder = [[GHTapRecorder alloc] init];
    GHEventTap *tap = Tap(recorder);
    GHWalkSnapshot none = Ready();
    none.hasCurrent = NO;
    [tap publishSnapshot:none];
    [tap handleFlagsChanged:kCGEventFlagMaskAlternate keyCode:GHKeyCodeRightOption];
    [tap handleFlagsChanged:0 keyCode:GHKeyCodeRightOption];
    GH_ASSERT_EQUAL_INT(recorder.events.count, 0);
}

GH_TEST(ghost_key_held_with_another_key_is_a_chord_not_a_tap) {
    GHTapRecorder *recorder = [[GHTapRecorder alloc] init];
    GHEventTap *tap = Tap(recorder);
    [tap publishSnapshot:Ready()];
    [tap handleFlagsChanged:kCGEventFlagMaskAlternate keyCode:GHKeyCodeRightOption];
    // Right Option plus a letter: an accented character, or somebody's shortcut. Never ours.
    [tap handleKeyDown:0 flags:kCGEventFlagMaskAlternate isRepeat:NO userData:0 printable:YES];
    [tap handleFlagsChanged:0 keyCode:GHKeyCodeRightOption];
    GH_ASSERT_FALSE([recorder.events containsObject:@"ghost-key"]);
}

GH_TEST(ghost_key_ignores_the_left_option_and_other_modifiers) {
    GHTapRecorder *recorder = [[GHTapRecorder alloc] init];
    GHEventTap *tap = Tap(recorder);
    [tap publishSnapshot:Ready()];
    [tap handleFlagsChanged:kCGEventFlagMaskAlternate keyCode:58];   // left Option
    [tap handleFlagsChanged:0 keyCode:58];
    [tap handleFlagsChanged:kCGEventFlagMaskCommand keyCode:55];     // Command
    [tap handleFlagsChanged:0 keyCode:55];
    GH_ASSERT_EQUAL_INT(recorder.events.count, 0);
}

GH_TEST(tap_scroll_is_reported_only_while_ghosts_exist) {
    GHTapRecorder *recorder = [[GHTapRecorder alloc] init];
    GHEventTap *tap = Tap(recorder);
    GHWalkSnapshot none = Ready();
    none.hasCurrent = NO;
    [tap publishSnapshot:none];
    [tap handleScroll];
    GH_ASSERT_EQUAL_INT(recorder.events.count, 0);
    [tap publishSnapshot:Ready()];
    [tap handleScroll];
    [tap handleScroll];
    NSArray *expected = @[ @"scroll", @"scroll" ];
    GH_ASSERT_EQUAL_OBJECTS(recorder.events, expected);
}

GH_TEST(tap_typing_chunks_never_carry_enter_or_split_a_character) {
    NSArray<NSString *> *chunks = [GHEventTap chunksForText:@"Line one\nLine two\r\n\tdone"];
    GH_ASSERT_EQUAL_OBJECTS([chunks componentsJoinedByString:@""], @"Line one Line two done");
    for (NSString *chunk in chunks) {
        GH_ASSERT(chunk.length <= 20);
        GH_ASSERT([chunk rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location == NSNotFound);
    }
    NSMutableString *emoji = [NSMutableString string];
    for (int i = 0; i < 15; i++) [emoji appendString:@"a\U0001F47B"];   // 3 UTF-16 units each, pairs straddle every boundary
    NSArray<NSString *> *pieces = [GHEventTap chunksForText:emoji];
    GH_ASSERT_EQUAL_OBJECTS([pieces componentsJoinedByString:@""], emoji);
    for (NSString *piece in pieces) {
        GH_ASSERT(piece.length <= 20);
        GH_ASSERT_FALSE(CFStringIsSurrogateLowCharacter([piece characterAtIndex:0]));
        GH_ASSERT_FALSE(CFStringIsSurrogateHighCharacter([piece characterAtIndex:piece.length - 1]));
    }
    GH_ASSERT_EQUAL_INT([GHEventTap chunksForText:@"\n\n"].count, 0);
    GH_ASSERT_EQUAL_INT(GHKeyModifiersFromFlags(kCGEventFlagMaskShift | kCGEventFlagMaskAlphaShift), GHKeyModifierShift);
}

GH_TEST(tap_reports_every_untagged_key_down_to_the_sequence_observer) {
    GHTapRecorder *recorder = [[GHTapRecorder alloc] init];
    GHEventTap *tap = Tap(recorder);
    __block NSUInteger seen = 0;
    tap.userKeyObserver = ^{ seen++; };
    // Inactive, consumed or passed: the user's key-downs are all reported; Ghost's own (tagged) never are.
    [tap handleKeyDown:0 flags:0 isRepeat:NO userData:0 printable:YES];
    [tap publishSnapshot:Ready()];
    GH_ASSERT([tap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:NO userData:0 printable:NO]);
    [tap handleKeyDown:GHKeyCodeEscape flags:0 isRepeat:NO userData:0 printable:NO];
    [tap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:YES userData:0 printable:NO];
    GH_ASSERT_EQUAL_INT(seen, 4);
    GH_ASSERT_FALSE([tap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:NO userData:GHSyntheticEventUserData printable:NO]);
    [tap handleKeyDown:0 flags:0 isRepeat:NO userData:GHSyntheticEventUserData printable:YES];
    GH_ASSERT_EQUAL_INT(seen, 4);
    tap.userKeyObserver = nil;
    [tap handleKeyDown:0 flags:0 isRepeat:NO userData:0 printable:YES];
    GH_ASSERT_EQUAL_INT(seen, 4);
}

GH_TEST(tests_can_never_post_a_real_key_event) {
    // The runner switched synthetic input off before the first test: every live posting path refuses.
    GH_ASSERT(GHRealKeyEventsForbidden());
    GH_ASSERT_FALSE([GHEventTap postKeyCode:GHKeyCodeEscape]);
    GHTaggedKeyEventSink *sink = [[GHTaggedKeyEventSink alloc] init];
    GH_ASSERT_FALSE([sink sendKeyCode:GHKeyCodeEscape flags:0 text:nil]);
    GHKeyPoster *live = [GHKeyPoster livePoster];
    GHKeyBurstResult *burst = [live postBurst:@[ [GHKeyStroke escape] ] guard:^BOOL(GHKeyStroke *s, pid_t p, id<GHAXNode> f) { return YES; }];
    GH_ASSERT_FALSE(burst.ok);
    GH_ASSERT_EQUAL_OBJECTS(burst.reason, GHKeyBurstReasonPostFailed);
}
