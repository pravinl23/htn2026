#import "GHTest.h"
#import "GHField.h"
#import "GHSeededWorkflow.h"
#import "GHWalkState.h"

static GHField *SeedField(NSString *signature, NSString *label, NSString *kind, NSString *value) {
    GHField *field = [GHField fieldWithSignature:signature label:label kind:kind];
    field.value = value ?: @"";
    return field;
}

static GHGhost *OpenTableGhost(NSArray<GHField *> *fields) {
    return [GHSeededWorkflow ghostForOrigin:@"https://www.opentable.ca" fields:fields];
}

GH_TEST(seeded_workflow_is_strictly_scoped_to_opentable) {
    GHField *location = SeedField(@"location", @"Location, Restaurant, or Cuisine", GHKindText, @"");
    GH_ASSERT([GHSeededWorkflow ghostForOrigin:@"https://www.opentable.ca" fields:@[ location ]] != nil);
    GH_ASSERT([GHSeededWorkflow ghostForOrigin:@"app://com.google.Chrome/www.opentable.ca" fields:@[ location ]] != nil);
    GH_ASSERT([GHSeededWorkflow ghostForOrigin:@"https://example.com" fields:@[ location ]] == nil);
    GH_ASSERT([GHSeededWorkflow ghostForOrigin:@"app://com.google.Chrome" fields:@[ location ]] == nil);
}

GH_TEST(seeded_opentable_starts_by_filling_waterloo) {
    GHField *location = SeedField(@"location", @"Please input a Location, Restaurant or Cuisine", GHKindText, @"");
    GHGhost *ghost = OpenTableGhost(@[ location, SeedField(@"go", @"Let’s go", GHKindButton, nil) ]);
    GH_ASSERT_EQUAL_OBJECTS(ghost.signature, @"location");
    GH_ASSERT_EQUAL_OBJECTS(ghost.action, GHGhostActionFill);
    GH_ASSERT_EQUAL_OBJECTS(ghost.value, @"Waterloo");
    GH_ASSERT_FALSE(ghost.locked);
}

GH_TEST(seeded_opentable_drives_an_autocomplete_as_a_lazy_select) {
    // This is the shape Chrome exposes on the real homepage: the name lives on a child textbox, while the
    // actionable combobox itself is unnamed but has OpenTable's stable accessibility identifier.
    GHField *location = SeedField(@"location", @"", GHKindSelect, @"");
    location.identifier = @"home-autocomplete-label";
    location.lazyOptions = YES;
    GHGhost *ghost = OpenTableGhost(@[ location ]);
    GH_ASSERT_EQUAL_OBJECTS(ghost.action, GHGhostActionSelect);
    GH_ASSERT_EQUAL_OBJECTS(ghost.value, @"Waterloo");
    GH_ASSERT(ghost.lazy);
}

GH_TEST(seeded_opentable_fills_the_real_editor_inside_a_combobox_wrapper) {
    GHField *location = SeedField(@"location-editor", @"Please input a Location, Restaurant or Cuisine", GHKindText, @"");
    location.identifier = @"home-autocomplete-input";
    GHGhost *ghost = OpenTableGhost(@[ location ]);
    GH_ASSERT_EQUAL_OBJECTS(ghost.action, GHGhostActionFill);
    GH_ASSERT_EQUAL_OBJECTS(ghost.value, @"Waterloo");
    GH_ASSERT_FALSE(ghost.lazy);
}

GH_TEST(seeded_opentable_searches_only_after_waterloo_is_present) {
    GHField *location = SeedField(@"location", @"Location, Restaurant, or Cuisine", GHKindText, @"Waterloo, Ontario");
    GHGhost *ghost = OpenTableGhost(@[ location, SeedField(@"go", @"Let’s go", GHKindButton, nil) ]);
    GH_ASSERT_EQUAL_OBJECTS(ghost.signature, @"go");
    GH_ASSERT_EQUAL_OBJECTS(ghost.action, GHGhostActionClick);
    GH_ASSERT(OpenTableGhost(@[ SeedField(@"go-alone", @"Let’s go", GHKindButton, nil) ]) == nil);
}

GH_TEST(seeded_opentable_chooses_first_reservation_slot_at_seven_pm) {
    GHField *selector = SeedField(@"selector", @"Time selector", GHKindSelect, @"7:00 p.m.");
    GHField *first = SeedField(@"first", @"7:00 p.m. Reserve table at Waterloo Grill restaurant", GHKindButton, nil);
    first.locked = YES; // generic capture locks "reserve"; this audited intermediate milestone is reversible
    GHField *second = SeedField(@"second", @"7:00 PM Reserve table at Another restaurant", GHKindButton, nil);
    GHGhost *ghost = OpenTableGhost(@[ selector, first, second ]);
    GH_ASSERT_EQUAL_OBJECTS(ghost.signature, @"first");
    GH_ASSERT_EQUAL_OBJECTS(ghost.action, GHGhostActionClick);
    GH_ASSERT(first.locked);
    GH_ASSERT_EQUAL_OBJECTS(ghost.auditedLockedLabel, first.label);
}

GH_TEST(seeded_opentable_advances_through_standard_and_birthday) {
    GHGhost *standard = OpenTableGhost(@[ SeedField(@"standard", @"Standard seating", GHKindButton, nil) ]);
    GH_ASSERT_EQUAL_OBJECTS(standard.signature, @"standard");
    GH_ASSERT_EQUAL_OBJECTS(standard.action, GHGhostActionClick);

    GHField *details = SeedField(@"details", @"Reservation details", GHKindSelect, @"Select an occasion");
    details.lazyOptions = YES;
    GHGhost *birthday = OpenTableGhost(@[ details ]);
    GH_ASSERT_EQUAL_OBJECTS(birthday.signature, @"details");
    GH_ASSERT_EQUAL_OBJECTS(birthday.action, GHGhostActionSelect);
    GH_ASSERT_EQUAL_OBJECTS(birthday.value, @"Birthday");
    GH_ASSERT(birthday.lazy);
}

GH_TEST(seeded_opentable_never_activates_complete_reservation) {
    GHField *complete = SeedField(@"complete", @"Complete reservation", GHKindButton, nil);
    complete.locked = NO; // The seed adds its own safety belt even if capture wording changes its classification.
    GHGhost *ghost = OpenTableGhost(@[ complete ]);
    GH_ASSERT_EQUAL_OBJECTS(ghost.signature, @"complete");
    GH_ASSERT_EQUAL_OBJECTS(ghost.action, GHGhostActionClick);
    GH_ASSERT(ghost.locked);

    GHWalkState *walk = [[GHWalkState alloc] init];
    [walk rescanWithGhosts:@[ ghost ]];
    GH_ASSERT(walk.current.locked);
}
