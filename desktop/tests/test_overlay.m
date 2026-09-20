// Overlay: coordinate conversion across display arrangements, the visibility threshold, the pure view-model,
// keyed diffing and layer reuse. No window is ever put on screen and no Accessibility permission is needed.
#import "GHTest.h"
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import "GHGeometry.h"
#import "GHOverlayModel.h"
#import "GHOverlayLayers.h"
#import "GHOverlayWindow.h"
#import "GHField.h"

#define GH_ASSERT_RECT(actual, x_, y_, w_, h_) \
    do { \
        CGRect gh_r = (actual); \
        if (fabs(gh_r.origin.x - (x_)) > 0.01 || fabs(gh_r.origin.y - (y_)) > 0.01 || \
            fabs(gh_r.size.width - (w_)) > 0.01 || fabs(gh_r.size.height - (h_)) > 0.01) { \
            GH_FAIL(@"%s: got %@, expected {{%g, %g}, {%g, %g}}", #actual, NSStringFromRect(gh_r), (double)(x_), (double)(y_), (double)(w_), (double)(h_)); \
        } \
    } while (0)

static NSValue *R(CGFloat x, CGFloat y, CGFloat w, CGFloat h) { return [NSValue valueWithRect:CGRectMake(x, y, w, h)]; }

/// One Retina laptop display.
static GHScreenLayout *OneDisplay(void) {
    return [GHScreenLayout layoutWithFrames:@[ R(0, 0, 1440, 900) ] scales:@[ @2 ]];
}

/// Laptop (primary, Retina) plus a 1x monitor ABOVE and to the LEFT: negative x in both spaces, negative y in AX space.
static GHScreenLayout *TwoDisplays(void) {
    return [GHScreenLayout layoutWithFrames:@[ R(0, 0, 1440, 900), R(-1920, 900, 1920, 1080) ] scales:@[ @2, @1 ]];
}

/// Left 1x monitor (taller, hanging below the primary), primary Retina, right 1x monitor raised by 200 pt.
static GHScreenLayout *ThreeDisplays(void) {
    return [GHScreenLayout layoutWithFrames:@[ R(0, 0, 1728, 1117), R(-2560, -323, 2560, 1440), R(1728, 200, 1920, 1080) ]
                                     scales:@[ @2, @1, @1 ]];
}

static GHOverlayEntry *Entry(NSString *signature, NSString *kind, NSString *text, CGRect ax) {
    return [GHOverlayEntry entryWithSignature:signature kind:kind displayText:text axRect:ax locked:NO];
}

/// Three text fields and a locked Submit inside a 1000 x 700 window at (100, 100).
static GHOverlayInput *FormInput(NSInteger current) {
    GHOverlayInput *input = [[GHOverlayInput alloc] init];
    GHOverlayEntry *submit = Entry(@"submit", @"button", @"Submit", CGRectMake(140, 420, 160, 44));
    submit.locked = YES;
    input.entries = @[
        Entry(@"first", @"text", @"Alex", CGRectMake(140, 200, 300, 40)),
        Entry(@"email", @"email", @"alex.chen@example.com", CGRectMake(140, 260, 300, 40)),
        Entry(@"why", @"textarea", @"Because latency is the product.", CGRectMake(140, 320, 600, 90)),
        submit,
    ];
    input.currentIndex = current;
    input.windowAXFrame = CGRectMake(100, 100, 1000, 700);
    return input;
}

static NSArray<NSString *> *Keys(NSArray<GHDrawItem *> *items) { return [items valueForKey:@"key"]; }

#pragma mark - Geometry

GH_TEST(overlay_geometry_single_display_flips_y) {
    GHScreenLayout *layout = OneDisplay();
    GH_ASSERT_EQUAL_INT(layout.count, 1);
    GH_ASSERT_NEAR(layout.primaryHeight, 900, 0.001);
    GH_ASSERT_RECT([layout appKitRectFromAXRect:CGRectMake(100, 200, 300, 40)], 100, 660, 300, 40);
    GH_ASSERT_RECT([layout localRectFromAXRect:CGRectMake(100, 200, 300, 40) screen:0], 100, 660, 300, 40);
    GH_ASSERT_RECT([layout axFrameAtIndex:0], 0, 0, 1440, 900);
    CGPoint p = [layout localPointFromAXPoint:CGPointMake(10, 20) screen:0];
    GH_ASSERT_NEAR(p.x, 10, 0.001);
    GH_ASSERT_NEAR(p.y, 880, 0.001);
}

GH_TEST(overlay_geometry_round_trips) {
    GHScreenLayout *layout = ThreeDisplays();
    CGRect ax = CGRectMake(-1234.5, 345.25, 210, 33);
    CGRect back = [layout axRectFromAppKitRect:[layout appKitRectFromAXRect:ax]];
    GH_ASSERT_RECT(back, ax.origin.x, ax.origin.y, ax.size.width, ax.size.height);
}

GH_TEST(overlay_geometry_secondary_above_left_has_negative_origins) {
    GHScreenLayout *layout = TwoDisplays();
    // AppKit puts the monitor at y = +900; AX (y down) puts the same monitor at y = -1080.
    GH_ASSERT_RECT([layout axFrameAtIndex:1], -1920, -1080, 1920, 1080);
    CGRect field = CGRectMake(-1800, -1000, 200, 30);  // 120 pt from the monitor's left edge, 80 pt from its top
    GH_ASSERT_EQUAL_INT([layout screenIndexForAXRect:field], 1);
    GH_ASSERT_RECT([layout appKitRectFromAXRect:field], -1800, 1870, 200, 30);
    // Panel coordinates are bottom-left: 1080 - 80 - 30 = 970.
    GH_ASSERT_RECT([layout localRectFromAXRect:field screen:1], 120, 970, 200, 30);
    // A field on the laptop display is untouched by the second monitor.
    GH_ASSERT_EQUAL_INT([layout screenIndexForAXRect:CGRectMake(100, 200, 300, 40)], 0);
    GH_ASSERT_RECT([layout localRectFromAXRect:CGRectMake(100, 200, 300, 40) screen:0], 100, 660, 300, 40);
}

GH_TEST(overlay_geometry_three_displays_each_get_local_coordinates) {
    GHScreenLayout *layout = ThreeDisplays();
    GH_ASSERT_RECT([layout axFrameAtIndex:0], 0, 0, 1728, 1117);
    GH_ASSERT_RECT([layout axFrameAtIndex:1], -2560, 0, 2560, 1440);    // 1117 - (-323) - 1440 = 0
    GH_ASSERT_RECT([layout axFrameAtIndex:2], 1728, -163, 1920, 1080);  // 1117 - 200 - 1080 = -163

    CGRect left = CGRectMake(-2000, 1300, 400, 50);  // below the primary's bottom edge: only the left monitor has it
    GH_ASSERT_EQUAL_INT([layout screenIndexForAXRect:left], 1);
    GH_ASSERT_RECT([layout localRectFromAXRect:left screen:1], 560, 90, 400, 50);

    CGRect right = CGRectMake(2000, -100, 300, 40);  // above the primary's top edge: only the right monitor has it
    GH_ASSERT_EQUAL_INT([layout screenIndexForAXRect:right], 2);
    GH_ASSERT_RECT([layout localRectFromAXRect:right screen:2], 272, 977, 300, 40);

    GH_ASSERT_EQUAL_INT([layout screenIndexForAXRect:CGRectMake(800, 500, 100, 30)], 0);
    GH_ASSERT_EQUAL_INT([layout screenIndexForAXRect:CGRectMake(9000, 9000, 100, 30)], NSNotFound);
}

GH_TEST(overlay_geometry_spanning_rect_goes_to_the_display_showing_most_of_it) {
    GHScreenLayout *layout = ThreeDisplays();
    GH_ASSERT_EQUAL_INT([layout screenIndexForAXRect:CGRectMake(1628, 300, 300, 40)], 2);  // 100 on primary, 200 on right
    GH_ASSERT_EQUAL_INT([layout screenIndexForAXRect:CGRectMake(1528, 300, 300, 40)], 0);  // 200 on primary, 100 on right
}

GH_TEST(overlay_geometry_snaps_to_each_displays_pixel_grid) {
    GH_ASSERT_RECT(GHRectPixelAligned(CGRectMake(10.3, 20.7, 100.2, 30.1), 1), 10, 21, 101, 30);   // edges 110.5 -> 111, 50.8 -> 51
    GH_ASSERT_RECT(GHRectPixelAligned(CGRectMake(10.3, 20.7, 100.2, 30.1), 2), 10.5, 20.5, 100, 30.5);
    GHScreenLayout *layout = TwoDisplays();
    CGRect retina = [layout localRectFromAXRect:CGRectMake(100.26, 200.26, 300, 40) screen:0];
    GH_ASSERT_NEAR(fmod(retina.origin.x * 2, 1), 0, 0.0001);  // half points are fine at 2x
    GH_ASSERT_NEAR(retina.origin.x, 100.5, 0.0001);
    CGRect plain = [layout localRectFromAXRect:CGRectMake(-1800.26, -1000.26, 200, 30) screen:1];
    GH_ASSERT_NEAR(plain.origin.x, round(plain.origin.x), 0.0001);  // whole points only at 1x
    GH_ASSERT_NEAR(plain.origin.y, round(plain.origin.y), 0.0001);
}

GH_TEST(overlay_geometry_visible_enough_is_sixty_percent) {
    CGRect screen = CGRectMake(0, 0, 1440, 900), window = CGRectMake(100, 100, 800, 600);
    GH_ASSERT_NEAR(GHVisibleFraction(CGRectMake(200, 200, 300, 40), window, screen), 1.0, 0.0001);
    // 100 pt tall field hanging over the window's bottom edge (y = 700).
    GH_ASSERT_NEAR(GHVisibleFraction(CGRectMake(200, 640, 300, 100), window, screen), 0.6, 0.0001);
    GH_ASSERT_NEAR(GHVisibleFraction(CGRectMake(200, 641, 300, 100), window, screen), 0.59, 0.0001);
    GH_ASSERT_NEAR(GHVisibleFraction(CGRectMake(2000, 200, 300, 40), window, screen), 0, 0.0001);

    GHScreenLayout *layout = OneDisplay();
    GH_ASSERT([layout isAXRectVisibleEnough:CGRectMake(200, 640, 300, 100) inWindow:window]);
    GH_ASSERT_FALSE([layout isAXRectVisibleEnough:CGRectMake(200, 641, 300, 100) inWindow:window]);
    // Unknown window: only the display clips. 50 of 100 pt below the display's bottom edge is not enough.
    GH_ASSERT([layout isAXRectVisibleEnough:CGRectMake(200, 641, 300, 100) inWindow:CGRectNull]);
    GH_ASSERT_FALSE([layout isAXRectVisibleEnough:CGRectMake(200, 850, 300, 100) inWindow:CGRectNull]);
    GH_ASSERT_RECT([layout visiblePartOfAXRect:CGRectMake(200, 640, 300, 100) inWindow:window screen:0], 200, 640, 300, 60);
}

GH_TEST(overlay_geometry_rejects_unusable_rects) {
    GHScreenLayout *layout = OneDisplay();
    GH_ASSERT_FALSE(GHRectIsUsable(CGRectNull));
    GH_ASSERT_FALSE(GHRectIsUsable(CGRectMake(10, 10, 0, 40)));
    GH_ASSERT_FALSE(GHRectIsUsable(CGRectMake(10, 10, -5, 40)));
    GH_ASSERT_FALSE(GHRectIsUsable(CGRectMake(NAN, 10, 50, 40)));
    GH_ASSERT_FALSE(GHRectIsUsable(CGRectMake(10, 10, INFINITY, 40)));
    GH_ASSERT_EQUAL_INT([layout screenIndexForAXRect:CGRectMake(NAN, 10, 50, 40)], NSNotFound);
    GH_ASSERT_NEAR([layout visibleFractionOfAXRect:CGRectMake(10, 10, 0, 0) inWindow:CGRectNull], 0, 0.0001);
    GHScreenLayout *none = [GHScreenLayout layoutWithFrames:@[] scales:nil];
    GH_ASSERT_EQUAL_INT([none screenIndexForAXRect:CGRectMake(10, 10, 50, 40)], NSNotFound);
    GH_ASSERT_NEAR(none.primaryHeight, 0, 0.0001);
}

GH_TEST(overlay_geometry_fingerprint_tracks_arrangement_and_scale) {
    GH_ASSERT_EQUAL_OBJECTS(TwoDisplays().fingerprint, TwoDisplays().fingerprint);
    GH_ASSERT_FALSE([OneDisplay().fingerprint isEqualToString:TwoDisplays().fingerprint]);
    GHScreenLayout *lowRes = [GHScreenLayout layoutWithFrames:@[ R(0, 0, 1440, 900) ] scales:@[ @1 ]];
    GH_ASSERT_FALSE([OneDisplay().fingerprint isEqualToString:lowRes.fingerprint]);
}

#pragma mark - View-model

GH_TEST(overlay_model_font_size_follows_field_height_within_clamps) {
    GH_ASSERT_NEAR(GHGhostFontSize(10, NO), 11, 0.001);    // clamp low
    GH_ASSERT_NEAR(GHGhostFontSize(22, NO), 11, 0.001);    // native macOS field: 10.1 -> 11
    GH_ASSERT_NEAR(GHGhostFontSize(30, NO), 14, 0.001);    // 13.8 -> 14
    GH_ASSERT_NEAR(GHGhostFontSize(32, NO), 14.5, 0.001);
    GH_ASSERT_NEAR(GHGhostFontSize(40, NO), 17, 0.001);    // 18.4 -> clamp high
    GH_ASSERT_NEAR(GHGhostFontSize(400, NO), 17, 0.001);
    GH_ASSERT_NEAR(GHGhostFontSize(NAN, NO), 13, 0.001);
    GH_ASSERT_NEAR(GHGhostFontSize(90, YES), 13, 0.001);   // text areas never scale with their height
    GH_ASSERT_NEAR(GHGhostFontSize(20, YES), 13, 0.001);
    GH_ASSERT_NEAR(GHGhostTextPadding(40), 8, 0.001);
    GH_ASSERT_NEAR(GHGhostTextPadding(22), 7, 0.001);
    GH_ASSERT_NEAR(GHGhostTextPadding(8), 4, 0.001);
}

GH_TEST(overlay_model_kind_decides_how_a_ghost_is_shown) {
    GH_ASSERT_EQUAL_INT(GHOverlayModeForKind(@"text"), GHOverlayModeText);
    GH_ASSERT_EQUAL_INT(GHOverlayModeForKind(@"email"), GHOverlayModeText);
    GH_ASSERT_EQUAL_INT(GHOverlayModeForKind(@"textarea"), GHOverlayModeMultiline);
    GH_ASSERT_EQUAL_INT(GHOverlayModeForKind(@"select"), GHOverlayModeSelectPill);
    GH_ASSERT_EQUAL_INT(GHOverlayModeForKind(@"radio"), GHOverlayModePill);
    GH_ASSERT_EQUAL_INT(GHOverlayModeForKind(@"checkbox"), GHOverlayModePill);
    GH_ASSERT_EQUAL_INT(GHOverlayModeForKind(@"button"), GHOverlayModeTarget);
    GH_ASSERT_EQUAL_INT(GHOverlayModeForKind(nil), GHOverlayModeText);
}

GH_TEST(overlay_model_current_text_field_gets_text_ring_keycap_cursor) {
    GHScreenLayout *layout = OneDisplay();
    GHOverlayModel *model = [GHOverlayModel modelWithInput:FormInput(0) layout:layout];
    GH_ASSERT_EQUAL_OBJECTS(Keys(model.items), (@[ @"text:first", @"text:email", @"text:why", @"ring", @"keycap", @"cursor" ]));
    GH_ASSERT(model.currentVisible);

    GHDrawItem *text = [model itemWithKey:@"text:first" screen:0];
    GH_ASSERT_RECT(text.frame, 140, 660, 300, 40);  // 900 - 200 - 40
    GH_ASSERT_RECT(text.clipRect, 140, 660, 300, 40);
    GH_ASSERT(text.current);
    GH_ASSERT_NEAR(text.fontSize, 17, 0.001);
    GH_ASSERT_NEAR(text.padLeft, 8, 0.001);
    GH_ASSERT(text.padRight > 40);  // room for the keycap
    GH_ASSERT_NEAR(text.scale, 2, 0.001);

    GHDrawItem *other = [model itemWithKey:@"text:email" screen:0];
    GH_ASSERT_FALSE(other.current);
    GH_ASSERT_NEAR(other.padRight, other.padLeft, 0.001);
    GHDrawItem *area = [model itemWithKey:@"text:why" screen:0];
    GH_ASSERT(area.multiline);
    GH_ASSERT_NEAR(area.fontSize, 13, 0.001);

    GHDrawItem *ring = [model itemWithKey:@"ring" screen:0];
    GH_ASSERT_RECT(ring.frame, 137, 657, 306, 46);  // hugs the field with a 3 pt gap
    GH_ASSERT_EQUAL_OBJECTS(ring.targetSignature, @"first");
    GH_ASSERT_FALSE(ring.locked);

    GHDrawItem *keycap = [model itemWithKey:@"keycap" screen:0];
    GH_ASSERT(CGRectContainsRect(text.frame, keycap.frame));                                       // inside the field
    GH_ASSERT_NEAR(CGRectGetMaxX(text.frame) - CGRectGetMaxX(keycap.frame), 8, 0.001);             // at its right edge
    GH_ASSERT_NEAR(CGRectGetMidY(keycap.frame), CGRectGetMidY(text.frame), 0.001);                 // vertically centered
    GH_ASSERT(CGRectGetMinX(keycap.frame) >= CGRectGetMaxX(text.frame) - text.padRight - 0.001);   // text stops before it
}

GH_TEST(overlay_model_cursor_tip_points_into_the_field) {
    GHScreenLayout *layout = OneDisplay();
    GHOverlayInput *input = FormInput(1);
    GHOverlayModel *model = [GHOverlayModel modelWithInput:input layout:layout];
    GHDrawItem *cursor = [model itemWithKey:@"cursor" screen:0];
    GHDrawItem *text = [model itemWithKey:@"text:email" screen:0];
    GHDrawItem *keycap = [model itemWithKey:@"keycap" screen:0];
    GH_ASSERT(CGRectContainsPoint(text.frame, cursor.tip));
    GH_ASSERT(cursor.tip.x < CGRectGetMinX(keycap.frame));  // never under the keycap
    // The tip sits at (5, 3.5) from the TOP-left of the 28 pt pointer box.
    GH_ASSERT_NEAR(cursor.tip.x - cursor.frame.origin.x, 5, 0.001);
    GH_ASSERT_NEAR(CGRectGetMaxY(cursor.frame) - cursor.tip.y, 3.5, 0.001);
    GH_ASSERT_RECT(cursor.frame, cursor.frame.origin.x, cursor.frame.origin.y, 28, 28);
    // Same point in AX space, for the event tap and the logs.
    CGPoint back = [layout localPointFromAXPoint:model.currentTipAX screen:0];
    GH_ASSERT_NEAR(back.x, cursor.tip.x, 0.001);
    GH_ASSERT_NEAR(back.y, cursor.tip.y, 0.001);
    GH_ASSERT(CGRectContainsPoint(input.entries[1].axRect, model.currentTipAX));
    // Short text: the pointer rests past it, at 62% of the width.
    GHOverlayModel *shortText = [GHOverlayModel modelWithInput:FormInput(0) layout:layout];
    GH_ASSERT_NEAR([shortText itemWithKey:@"cursor" screen:0].tip.x, 140 + 300 * 0.62, 0.001);
}

/// A locked target gets the ring and nothing else: no keycap, no badge, and NO GHOST CURSOR. Ghost is never
/// going to press it, so a cursor that means "take this" is the wrong thing to draw there, and its absence
/// beside the same purple ring everything else gets is the whole signal. The badge that used to spell out
/// "Enter to confirm" is gone: a ghost's vocabulary is a ring and a cursor, and a pill of instructions is
/// not part of it.
GH_TEST(overlay_model_locked_target_gets_the_ring_alone) {
    GHOverlayModel *model = [GHOverlayModel modelWithInput:FormInput(3) layout:OneDisplay()];
    GH_ASSERT_EQUAL_OBJECTS(Keys(model.items), (@[ @"text:first", @"text:email", @"text:why", @"ring" ]));
    GH_ASSERT([model itemWithKey:@"lock" screen:0] == nil);
    GH_ASSERT([model itemWithKey:@"cursor" screen:0] == nil);
    GH_ASSERT([model itemWithKey:@"keycap" screen:0] == nil);
    GH_ASSERT([model itemWithKey:@"ring" screen:0].locked);
    // The ring is still drawn, and still where the button is.
    GH_ASSERT(model.currentVisible);
}

GH_TEST(overlay_model_draws_nothing_for_fields_the_user_cannot_see) {
    GHOverlayInput *input = FormInput(0);
    // The current field is scrolled almost out of the window (top edge at y = 100): 10 of 40 pt visible.
    input.entries[0].axRect = CGRectMake(140, 70, 300, 40);
    GHOverlayModel *model = [GHOverlayModel modelWithInput:input layout:OneDisplay()];
    GH_ASSERT_FALSE(model.currentVisible);  // so Tab stays native
    GH_ASSERT_EQUAL_OBJECTS(Keys(model.items), (@[ @"text:email", @"text:why" ]));

    // 30 of 40 pt visible: drawn, but clipped to what can be seen, and the ring hugs the visible part.
    input.entries[0].axRect = CGRectMake(140, 90, 300, 40);
    model = [GHOverlayModel modelWithInput:input layout:OneDisplay()];
    GH_ASSERT(model.currentVisible);
    GHDrawItem *text = [model itemWithKey:@"text:first" screen:0];
    GH_ASSERT_RECT(text.frame, 140, 770, 300, 40);
    GH_ASSERT_RECT(text.clipRect, 140, 770, 300, 30);
    GH_ASSERT_RECT([model itemWithKey:@"ring" screen:0].frame, 137, 767, 306, 36);
    GH_ASSERT([model itemWithKey:@"keycap" screen:0] != nil);  // cut at the top only: the keycap is still in full view

    // Cut at the RIGHT (window ends at x = 1100): 200 of 300 pt visible. The keycap would sit in the hidden part,
    // so it is dropped, and the text does not give up room for it.
    input.entries[0].axRect = CGRectMake(900, 200, 300, 40);
    model = [GHOverlayModel modelWithInput:input layout:OneDisplay()];
    GH_ASSERT(model.currentVisible);
    GH_ASSERT([model itemWithKey:@"keycap" screen:0] == nil);
    text = [model itemWithKey:@"text:first" screen:0];
    GH_ASSERT_RECT(text.clipRect, 900, 660, 200, 40);
    GH_ASSERT_NEAR(text.padRight, text.padLeft, 0.001);
    GH_ASSERT(CGRectContainsPoint(text.clipRect, [model itemWithKey:@"cursor" screen:0].tip));  // the pointer stays in view

    // Nothing current, no rect, garbage rect: no chrome, no crash.
    input.currentIndex = -1;
    input.entries[1].axRect = CGRectNull;
    input.entries[2].axRect = CGRectMake(NAN, 0, 10, 10);
    model = [GHOverlayModel modelWithInput:input layout:OneDisplay()];
    GH_ASSERT_EQUAL_OBJECTS(Keys(model.items), (@[ @"text:first" ]));
    GH_ASSERT_EQUAL_INT([GHOverlayModel modelWithInput:FormInput(0) layout:[GHScreenLayout layoutWithFrames:@[] scales:nil]].items.count, 0);
}

GH_TEST(overlay_model_pills_for_selects_and_toggles) {
    GHOverlayInput *input = [[GHOverlayInput alloc] init];
    input.entries = @[
        Entry(@"country", @"select", @"United States", CGRectMake(140, 200, 300, 36)),
        Entry(@"updates", @"checkbox", @"Check", CGRectMake(140, 260, 20, 20)),
        Entry(@"edge", @"checkbox", @"Check", CGRectMake(1000, 300, 90, 20)),  // touches the window's right edge
    ];
    input.currentIndex = 0;
    input.windowAXFrame = CGRectMake(100, 100, 1000, 700);
    GHOverlayModel *model = [GHOverlayModel modelWithInput:input layout:OneDisplay()];
    GHDrawItem *select = [model itemWithKey:@"pill:country" screen:0];
    GH_ASSERT_EQUAL_INT(select.kind, GHDrawKindPill);
    GH_ASSERT_EQUAL_INT(select.anchor, GHDrawAnchorRightCenter);
    GH_ASSERT(select.showsKeycap);
    GH_ASSERT_NEAR(CGRectGetMaxX(select.frame), 140 + 300 - 30, 0.001);  // left of the popup arrow
    GH_ASSERT([model itemWithKey:@"keycap" screen:0] == nil);             // the pill carries its own
    GH_ASSERT([model itemWithKey:@"text:country" screen:0] == nil);

    GHDrawItem *box = [model itemWithKey:@"pill:updates" screen:0];
    GH_ASSERT_EQUAL_INT(box.anchor, GHDrawAnchorLeftCenter);
    GH_ASSERT_NEAR(CGRectGetMinX(box.frame), 168, 0.001);  // 8 pt past the control
    GH_ASSERT_FALSE(box.showsKeycap);
    GHDrawItem *edge = [model itemWithKey:@"pill:edge" screen:0];
    GH_ASSERT_EQUAL_INT(edge.anchor, GHDrawAnchorRightCenter);  // no room outside the window: tucked inside
    GH_ASSERT(CGRectGetMaxX(edge.frame) <= 1090);
}

GH_TEST(overlay_model_hud_sits_bottom_right_of_the_main_display_above_the_dock) {
    GHScreenLayout *layout = [[GHScreenLayout alloc] initWithFrames:@[ R(0, 0, 1440, 900), R(1440, 0, 1920, 1080) ]
                                                             scales:@[ @2, @1 ]
                                                      visibleFrames:@[ R(0, 70, 1440, 805), R(1440, 0, 1920, 1055) ]];
    GHOverlayInput *input = [[GHOverlayInput alloc] init];
    input.hud = [GHOverlayHUDInfo infoWithProvider:@"offline-heuristic" latencyMs:nil cache:@"offline" keystrokesSaved:12];
    GHOverlayModel *model = [GHOverlayModel modelWithInput:input layout:layout];
    GH_ASSERT_EQUAL_OBJECTS(Keys(model.items), (@[ @"hud" ]));
    GHDrawItem *hud = model.items[0];
    GH_ASSERT_EQUAL_INT(hud.screenIndex, 0);
    GH_ASSERT_EQUAL_INT(hud.anchor, GHDrawAnchorBottomRight);
    GH_ASSERT_NEAR(CGRectGetMaxX(hud.frame), 1440 - 14, 0.001);
    GH_ASSERT_NEAR(CGRectGetMinY(hud.frame), 70 + 14, 0.001);  // above the Dock
    GH_ASSERT_EQUAL_OBJECTS(hud.hud.segments, (@[ @"via", @"offline-heuristic", @"last", @"—", @"cache", @"offline", @"saved", @"12 keys" ]));
    input.hud.latencyMs = @181.6;
    GH_ASSERT_EQUAL_OBJECTS(input.hud.segments[3], @"182 ms");

    input.error = @"Email: the value did not stick";
    model = [GHOverlayModel modelWithInput:input layout:layout];
    GH_ASSERT_EQUAL_OBJECTS(Keys(model.items), (@[ @"hud", @"hud-error" ]));
    GH_ASSERT(CGRectGetMinY(model.items[1].frame) >= CGRectGetMaxY(model.items[0].frame));  // stacked above
    input.hud = nil;
    input.error = @"";
    GH_ASSERT_EQUAL_INT([GHOverlayModel modelWithInput:input layout:layout].items.count, 0);
}

GH_TEST(overlay_model_places_items_on_the_display_that_shows_the_field) {
    GHScreenLayout *layout = TwoDisplays();
    GHOverlayInput *input = [[GHOverlayInput alloc] init];
    input.entries = @[ Entry(@"first", @"text", @"Alex", CGRectMake(-1800, -1000, 300, 40)) ];
    input.currentIndex = 0;
    input.hud = [GHOverlayHUDInfo infoWithProvider:@"jev" latencyMs:@90 cache:@"hit" keystrokesSaved:0];
    GHOverlayModel *model = [GHOverlayModel modelWithInput:input layout:layout];
    GH_ASSERT_EQUAL_OBJECTS(Keys([model itemsForScreen:0]), (@[ @"hud" ]));  // the HUD stays on the main display
    GH_ASSERT_EQUAL_OBJECTS(Keys([model itemsForScreen:1]), (@[ @"text:first", @"ring", @"keycap", @"cursor" ]));
    GHDrawItem *text = [model itemWithKey:@"text:first" screen:1];
    GH_ASSERT_RECT(text.frame, 120, 960, 300, 40);
    GH_ASSERT_NEAR(text.scale, 1, 0.001);
    GH_ASSERT_NEAR([model itemWithKey:@"hud" screen:0].scale, 2, 0.001);
    GH_ASSERT_EQUAL_OBJECTS(model.layoutFingerprint, layout.fingerprint);
}

GH_TEST(overlay_model_entry_from_field_and_core_ghost) {
    GHField *field = [GHField fieldWithSignature:@"AXTextField|email|0" label:@"Email" kind:GHKindEmail];
    field.rect = CGRectMake(10, 20, 300, 40);
    GHOverlayEntry *entry = [GHOverlayEntry entryWithField:field ghost:@{ @"signature" : field.signature, @"displayText" : @"alex.chen@example.com", @"locked" : @NO, @"pending" : @YES } keyName:@"Tab"];
    GH_ASSERT_EQUAL_OBJECTS(entry.signature, @"AXTextField|email|0");
    GH_ASSERT_EQUAL_OBJECTS(entry.kind, @"email");
    GH_ASSERT_EQUAL_OBJECTS(entry.displayText, @"alex.chen@example.com");
    GH_ASSERT(entry.streaming);
    GH_ASSERT_FALSE(entry.locked);
    GH_ASSERT_RECT(entry.axRect, 10, 20, 300, 40);
    field.locked = YES;
    GHOverlayEntry *bare = [GHOverlayEntry entryWithField:field ghost:@{ @"displayText" : NSNull.null } keyName:nil];
    GH_ASSERT(bare.locked);  // falls back to the field's own flag
    GH_ASSERT_EQUAL_OBJECTS(bare.displayText, @"");
}

#pragma mark - Diffing

GH_TEST(overlay_diff_same_model_twice_is_empty) {
    GHScreenLayout *layout = OneDisplay();
    GHOverlayModel *a = [GHOverlayModel modelWithInput:FormInput(0) layout:layout];
    GHOverlayModel *b = [GHOverlayModel modelWithInput:FormInput(0) layout:layout];
    GHOverlayDiff *diff = [GHOverlayDiff diffFromItems:a.items toItems:b.items];
    GH_ASSERT(diff.isEmpty);
    GH_ASSERT_EQUAL_INT(diff.unchanged.count, a.items.count);
    GHOverlayDiff *first = [GHOverlayDiff diffFromItems:@[] toItems:a.items];
    GH_ASSERT_EQUAL_INT(first.added.count, a.items.count);
    GH_ASSERT_FALSE(first.isEmpty);
}

GH_TEST(overlay_diff_advancing_reuses_ring_cursor_and_keycap) {
    GHScreenLayout *layout = OneDisplay();
    GHOverlayModel *a = [GHOverlayModel modelWithInput:FormInput(0) layout:layout];
    GHOverlayModel *b = [GHOverlayModel modelWithInput:FormInput(1) layout:layout];
    GHOverlayDiff *diff = [GHOverlayDiff diffFromItems:a.items toItems:b.items];
    GH_ASSERT_EQUAL_INT(diff.added.count, 0);
    GH_ASSERT_EQUAL_INT(diff.removedKeys.count, 0);
    // Both text items changed status (current <-> waiting); the text area did not change at all.
    GH_ASSERT_EQUAL_OBJECTS(Keys(diff.changed), (@[ @"text:first", @"text:email", @"ring", @"keycap", @"cursor" ]));
    GH_ASSERT_EQUAL_OBJECTS(Keys(diff.unchanged), (@[ @"text:why" ]));
    GH_ASSERT_EQUAL_OBJECTS([b itemWithKey:@"ring" screen:0].targetSignature, @"email");
}

GH_TEST(overlay_diff_accepting_a_ghost_removes_only_its_text) {
    GHScreenLayout *layout = OneDisplay();
    GHOverlayInput *before = FormInput(0), *after = FormInput(0);
    after.entries = [after.entries subarrayWithRange:NSMakeRange(1, 3)];  // "first" was accepted; "email" is current
    GHOverlayDiff *diff = [GHOverlayDiff diffFromItems:[GHOverlayModel modelWithInput:before layout:layout].items
                                               toItems:[GHOverlayModel modelWithInput:after layout:layout].items];
    GH_ASSERT_EQUAL_OBJECTS(diff.removedKeys, (@[ @"text:first" ]));
    GH_ASSERT_EQUAL_INT(diff.added.count, 0);
    // Walking onto the lock takes the keycap AND the ghost cursor away, and adds nothing: the ring is all
    // that is left, because Ghost is not going to press it.
    GHOverlayDiff *toLock = [GHOverlayDiff diffFromItems:[GHOverlayModel modelWithInput:FormInput(2) layout:layout].items
                                                 toItems:[GHOverlayModel modelWithInput:FormInput(3) layout:layout].items];
    GH_ASSERT_EQUAL_OBJECTS(toLock.removedKeys, (@[ @"keycap", @"cursor" ]));
    GH_ASSERT_EQUAL_INT(toLock.added.count, 0);
}

GH_TEST(overlay_diff_tracks_text_changes_without_keeping_the_text) {
    GHScreenLayout *layout = OneDisplay();
    GHOverlayInput *a = FormInput(2), *b = FormInput(2);
    b.entries[2].displayText = @"Because latency is the product. And because";  // streaming grew
    GHOverlayDiff *diff = [GHOverlayDiff diffFromItems:[GHOverlayModel modelWithInput:a layout:layout].items
                                               toItems:[GHOverlayModel modelWithInput:b layout:layout].items];
    GH_ASSERT_EQUAL_OBJECTS(Keys(diff.changed), (@[ @"text:why" ]));
    for (GHDrawItem *item in [GHOverlayModel modelWithInput:FormInput(1) layout:layout].items) {
        GH_ASSERT_FALSE([item.contentSignature containsString:@"alex.chen"]);  // signatures may be logged; values may not
        GH_ASSERT_FALSE([item.description containsString:@"alex.chen"]);
    }
}

GH_TEST(overlay_diff_keys_stay_unique_with_duplicate_signatures) {
    GHOverlayInput *input = FormInput(0);
    input.entries = [input.entries arrayByAddingObject:Entry(@"first", @"text", @"Again", CGRectMake(140, 500, 300, 40))];
    NSArray<NSString *> *keys = Keys([GHOverlayModel modelWithInput:input layout:OneDisplay()].items);
    GH_ASSERT_EQUAL_INT(keys.count, [NSSet setWithArray:keys].count);
}

#pragma mark - Layers (off screen)

GH_TEST(overlay_layers_anchor_content_inside_the_room) {
    CGRect room = CGRectMake(100, 50, 200, 22);
    GH_ASSERT_RECT(GHAnchoredFrame(room, CGSizeMake(80, 22), GHDrawAnchorLeftCenter, 2), 100, 50, 80, 22);
    GH_ASSERT_RECT(GHAnchoredFrame(room, CGSizeMake(80, 22), GHDrawAnchorRightCenter, 2), 220, 50, 80, 22);
    GH_ASSERT_RECT(GHAnchoredFrame(room, CGSizeMake(80, 10), GHDrawAnchorTopLeft, 2), 100, 62, 80, 10);
    GH_ASSERT_RECT(GHAnchoredFrame(room, CGSizeMake(80, 10), GHDrawAnchorBottomRight, 2), 220, 50, 80, 10);
    GH_ASSERT_RECT(GHAnchoredFrame(room, CGSizeMake(500, 22), GHDrawAnchorRightCenter, 2), 100, 50, 200, 22);  // never wider than the room
    GH_ASSERT_RECT(GHAnchoredFrame(room, CGSizeMake(80, 22), GHDrawAnchorFill, 2), 100, 50, 200, 22);
}

GH_TEST(overlay_window_reuses_layers_between_renders) {
    GHScreenLayout *layout = TwoDisplays();
    GHOverlayWindow *overlay = [[GHOverlayWindow alloc] initWithLayout:layout];
    overlay.reduceMotionOverride = @YES;
    GH_ASSERT_EQUAL_INT(overlay.panelCount, 2);
    GH_ASSERT([overlay panelAtIndex:0] == nil);  // fixed layout: layers only, never a window
    GH_ASSERT_FALSE(overlay.isVisible);

    [overlay render:[GHOverlayModel modelWithInput:FormInput(0) layout:layout]];
    GH_ASSERT_EQUAL_OBJECTS([overlay layerKeysAtIndex:0], (@[ @"cursor", @"keycap", @"ring", @"text:email", @"text:first", @"text:why" ]));
    GH_ASSERT_EQUAL_INT([overlay layerKeysAtIndex:1].count, 0);
    CALayer *ring = [overlay layerForKey:@"ring" atIndex:0], *cursor = [overlay layerForKey:@"cursor" atIndex:0];
    CALayer *why = [overlay layerForKey:@"text:why" atIndex:0];
    GH_ASSERT_RECT(ring.frame, 137, 657, 306, 46);
    GH_ASSERT([ring isKindOfClass:GHRingLayer.class]);
    GH_ASSERT(cursor.zPosition > ring.zPosition && ring.zPosition > why.zPosition);

    // Same model again: nothing is rebuilt. Advancing: the same ring and cursor layers move to the next field.
    [overlay render:[GHOverlayModel modelWithInput:FormInput(0) layout:layout]];
    GH_ASSERT([overlay layerForKey:@"ring" atIndex:0] == ring);
    [overlay render:[GHOverlayModel modelWithInput:FormInput(1) layout:layout]];
    GH_ASSERT([overlay layerForKey:@"ring" atIndex:0] == ring);
    GH_ASSERT([overlay layerForKey:@"cursor" atIndex:0] == cursor);
    GH_ASSERT([overlay layerForKey:@"text:why" atIndex:0] == why);
    GH_ASSERT_RECT(ring.frame, 137, 597, 306, 46);
    GH_ASSERT_EQUAL_INT([overlay rootLayerAtIndex:0].sublayers.count, 6);

    // The lock: keycap and cursor both out, no badge in, and their layers really leave the tree.
    [overlay render:[GHOverlayModel modelWithInput:FormInput(3) layout:layout]];
    GH_ASSERT([overlay layerForKey:@"keycap" atIndex:0] == nil);
    GH_ASSERT([overlay layerForKey:@"cursor" atIndex:0] == nil);
    GH_ASSERT([overlay layerForKey:@"lock" atIndex:0] == nil);
    GH_ASSERT_EQUAL_INT([overlay rootLayerAtIndex:0].sublayers.count, 4);

    [overlay hideImmediately];
    GH_ASSERT([overlay rootLayerAtIndex:0].hidden);
    [overlay render:[GHOverlayModel modelWithInput:FormInput(3) layout:layout]];
    GH_ASSERT_FALSE([overlay rootLayerAtIndex:0].hidden);

    [overlay render:[GHOverlayModel emptyModel]];
    GH_ASSERT_EQUAL_INT([overlay layerKeysAtIndex:0].count, 0);
    GH_ASSERT_EQUAL_INT([overlay rootLayerAtIndex:0].sublayers.count, 0);
    [overlay invalidate];
    GH_ASSERT_EQUAL_INT(overlay.panelCount, 0);
}

GH_TEST(overlay_window_refuses_a_model_built_for_other_displays) {
    GHOverlayWindow *overlay = [[GHOverlayWindow alloc] initWithLayout:OneDisplay()];
    overlay.reduceMotionOverride = @YES;
    [overlay render:[GHOverlayModel modelWithInput:FormInput(0) layout:OneDisplay()]];
    GH_ASSERT_FALSE([overlay rootLayerAtIndex:0].hidden);
    [overlay render:[GHOverlayModel modelWithInput:FormInput(0) layout:TwoDisplays()]];  // stale arrangement
    GH_ASSERT([overlay rootLayerAtIndex:0].hidden);
    [overlay invalidate];
}

GH_TEST(overlay_window_draws_items_on_the_second_display) {
    GHScreenLayout *layout = TwoDisplays();
    GHOverlayWindow *overlay = [[GHOverlayWindow alloc] initWithLayout:layout];
    overlay.reduceMotionOverride = @YES;
    GHOverlayInput *input = [[GHOverlayInput alloc] init];
    input.entries = @[ Entry(@"first", @"text", @"Alex", CGRectMake(-1800, -1000, 300, 40)) ];
    input.currentIndex = 0;
    input.hud = [GHOverlayHUDInfo infoWithProvider:@"jev" latencyMs:@90 cache:@"hit" keystrokesSaved:4];
    [overlay renderInput:input];
    GH_ASSERT_EQUAL_OBJECTS([overlay layerKeysAtIndex:0], (@[ @"hud" ]));
    GH_ASSERT_EQUAL_OBJECTS([overlay layerKeysAtIndex:1], (@[ @"cursor", @"keycap", @"ring", @"text:first" ]));
    GH_ASSERT_RECT([overlay layerForKey:@"text:first" atIndex:1].frame, 120, 960, 300, 40);
    CALayer *hud = [overlay layerForKey:@"hud" atIndex:0];
    GH_ASSERT_NEAR(CGRectGetMaxX(hud.frame), 1440 - 14, 0.51);  // hugs its text, anchored bottom-right
    GH_ASSERT_NEAR(CGRectGetMinY(hud.frame), 14, 0.51);
    GH_ASSERT(hud.frame.size.width > 200 && hud.frame.size.width < 700);
    [overlay invalidate];
}

GH_TEST(overlay_model_upload_ghost_is_a_file_name_pill_and_progress_is_a_hud_chip) {
    GH_ASSERT_EQUAL_INT(GHOverlayModeForKind(@"file"), GHOverlayModePill);
    GHOverlayInput *input = [[GHOverlayInput alloc] init];
    input.entries = @[ Entry(@"resume", @"file", @"resume-alex-chen.pdf", CGRectMake(140, 200, 300, 43)) ];
    input.currentIndex = 0;
    input.windowAXFrame = CGRectMake(100, 100, 1000, 700);
    GHOverlayModel *model = [GHOverlayModel modelWithInput:input layout:OneDisplay()];
    GHDrawItem *pill = [model itemWithKey:@"pill:resume" screen:0];
    GH_ASSERT_EQUAL_INT(pill.kind, GHDrawKindPill);
    GH_ASSERT_EQUAL_OBJECTS(pill.text, @"resume-alex-chen.pdf");
    GH_ASSERT(pill.showsKeycap);
    GH_ASSERT(model.currentVisible);

    input.status = @"Picking resume-alex-chen.pdf";
    model = [GHOverlayModel modelWithInput:input layout:OneDisplay()];
    GHDrawItem *chip = [model itemWithKey:@"hud-status" screen:0];
    GH_ASSERT_EQUAL_INT(chip.kind, GHDrawKindHUDStatus);
    GH_ASSERT_EQUAL_OBJECTS(chip.text, @"Picking resume-alex-chen.pdf");
    GH_ASSERT_EQUAL_INT(chip.anchor, GHDrawAnchorBottomRight);
    // Stacked above the HUD and the error chip when they are there too.
    input.hud = [GHOverlayHUDInfo infoWithProvider:@"offline-heuristic" latencyMs:nil cache:@"offline" keystrokesSaved:3];
    input.error = @"Ghost could not fill this field (upload-panel-timeout)";
    model = [GHOverlayModel modelWithInput:input layout:OneDisplay()];
    GHDrawItem *hud = [model itemWithKey:@"hud" screen:0], *error = [model itemWithKey:@"hud-error" screen:0];
    chip = [model itemWithKey:@"hud-status" screen:0];
    GH_ASSERT(CGRectGetMinY(error.frame) >= CGRectGetMaxY(hud.frame));
    GH_ASSERT(CGRectGetMinY(chip.frame) >= CGRectGetMaxY(error.frame));
    // The layer for it exists and sits with the HUD.
    GH_ASSERT([[GHOverlayItemLayer layerForItem:chip] isKindOfClass:[GHOverlayItemLayer class]]);
    GH_ASSERT_EQUAL_INT([GHOverlayItemLayer zPositionForKind:GHDrawKindHUDStatus], 0);
    // A status alone is enough to draw something.
    GHOverlayInput *only = [[GHOverlayInput alloc] init];
    only.currentIndex = -1;
    only.status = @"Attached resume-alex-chen.pdf";
    GH_ASSERT_EQUAL_OBJECTS(Keys([GHOverlayModel modelWithInput:only layout:OneDisplay()].items), (@[ @"hud-status" ]));
}

#pragma mark - the guess marker (docs/answers.md section 3)

GH_TEST(overlay_marks_a_guess_and_leaves_a_fact_alone) {
    GHOverlayInput *input = FormInput(0);
    NSMutableArray<GHOverlayEntry *> *entries = [input.entries mutableCopy];
    GHOverlayEntry *guess = Entry(@"auth", @"select", @"No", CGRectMake(140, 480, 300, 40));
    guess.guess = YES;
    [entries addObject:guess];
    input.entries = entries;

    GHOverlayModel *model = [GHOverlayModel modelWithInput:input layout:OneDisplay()];
    GHDrawItem *marked = [model itemWithKey:@"pill:auth" screen:0];
    GH_ASSERT(marked != nil);
    GH_ASSERT(marked.guess);
    // A fact is drawn exactly as before: no badge, no underline.
    GH_ASSERT_FALSE([model itemWithKey:@"text:first" screen:0].guess);
    GH_ASSERT_FALSE([model itemWithKey:@"text:email" screen:0].guess);

    // The marker is part of what the layer is: turning it off redraws, it does not reuse the old layer.
    NSString *marker = marked.contentSignature;
    guess.guess = NO;
    GHOverlayModel *plain = [GHOverlayModel modelWithInput:input layout:OneDisplay()];
    GH_ASSERT_FALSE([plain itemWithKey:@"pill:auth" screen:0].guess);
    GH_ASSERT_FALSE([marker isEqualToString:[plain itemWithKey:@"pill:auth" screen:0].contentSignature]);

    // Ghost text carries it too, and the layers accept it without complaint.
    GHOverlayEntry *guessedText = Entry(@"why2", @"text", @"a guessed draft", CGRectMake(140, 540, 300, 40));
    guessedText.guess = YES;
    input.entries = @[ guessedText ];
    input.currentIndex = 0;
    GHOverlayModel *textModel = [GHOverlayModel modelWithInput:input layout:OneDisplay()];
    GHDrawItem *item = [textModel itemWithKey:@"text:why2" screen:0];
    GH_ASSERT(item != nil && item.guess);
    GHGhostTextLayer *layer = [[GHGhostTextLayer alloc] init];
    [layer applyItem:item glide:NO reduceMotion:YES];
    GH_ASSERT(layer.sublayers.count >= 2);   // the label plus the dotted rule
}
