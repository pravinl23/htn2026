// Ghost anywhere on the native side (docs/anywhere.md): GHAffordance's hints, GHNextAction's proposal and the
// role memory on disk, all of it through the REAL ghost-core.js in JavaScriptCore (DESKTOP_CORE_PATH, set by
// `make test`) and against fake accessibility trees.
//
// Every window here is synthetic and generic: a player, a grid, a shop header, a plain app window. Nothing in
// this file names a website, an app or a brand, because nothing in the code under test may read one.
#import "GHTest.h"
#import "GHAXNode.h"
#import "GHAffordance.h"
#import "GHCapture.h"
#import "GHCore.h"
#import "GHField.h"
#import "GHController.h"
#import "GHNextAction.h"
#import "GHWalkState.h"
#import "GHVision.h"
#import "GHWriter.h"

#pragma mark - fixtures

/// Knows nothing: the shared rules in the core do the safety work, and these tests prove they still apply.
@interface GHAnywhereSafety : NSObject <GHSafetyChecking>
@property (nonatomic, strong) GHCore *core;
@end

@implementation GHAnywhereSafety
- (BOOL)isSensitiveProbe:(NSDictionary<NSString *, id> *)probe { return [self.core isSensitive:probe]; }
- (BOOL)isLockedProbe:(NSDictionary<NSString *, id> *)probe { return [self.core isLockedAction:probe]; }
@end

static GHCore *Core(void) {
    static GHCore *core;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSString *path = [GHCore defaultBundlePath];
        core = path ? [[GHCore alloc] initWithBundlePath:path error:NULL] : nil;
    });
    return core;
}

static GHCapture *Capture(void) {
    GHAnywhereSafety *safety = [[GHAnywhereSafety alloc] init];
    safety.core = Core();
    GHCapture *capture = [[GHCapture alloc] initWithSafety:safety];
    capture.capturesUnnamedControls = YES;   // docs/anywhere.md: an icon-only control is the whole point
    return capture;
}

static GHFakeAXNode *Node(NSString *role, NSString *title, CGRect frame) {
    return [GHFakeAXNode nodeWithRole:role title:title frame:frame];
}

/// An icon-only control: no title, no description, only the identifier a design system gave it.
static GHFakeAXNode *Glyph(NSString *identifier, CGRect frame) {
    GHFakeAXNode *node = Node(@"AXButton", nil, frame);
    node.identifier = identifier;
    return node;
}

static GHFakeAXNode *Text(NSString *text, CGRect frame) {
    return [GHFakeAXNode staticText:text frame:frame];
}

/**
 * A video player window. `playing` decides which way the player's own toggle points, which is the only generic
 * evidence there is that something is playing. Every control is icon-only: no text anywhere in the tree.
 */
static GHFakeAXNode *PlayerWindow(BOOL playing, BOOL fullscreen) {
    CGRect windowFrame = CGRectMake(0, 0, 800, 600);
    GHFakeAXNode *window = Node(@"AXWindow", @"", windowFrame);
    GHFakeAXNode *player = [window addChild:Node(@"AXGroup", nil, CGRectMake(0, 0, 800, fullscreen ? 600 : 450))];
    [player addChild:Node(@"AXVideo", nil, CGRectMake(0, 0, 800, fullscreen ? 600 : 450))];
    GHFakeAXNode *bar = [player addChild:Node(@"AXGroup", nil, CGRectMake(0, 400, 800, 44))];
    [bar addChild:Glyph(playing ? @"player-pause-button" : @"player-play-button", CGRectMake(10, 405, 36, 36))];
    GHFakeAXNode *scrubber = [bar addChild:Node(@"AXSlider", nil, CGRectMake(60, 415, 600, 12))];
    scrubber.value = @"0:42";
    [bar addChild:Text(@"0:42", CGRectMake(60, 430, 40, 12))];
    [bar addChild:Glyph(@"player-next-button", CGRectMake(670, 405, 36, 36))];
    [bar addChild:Glyph(@"player-fullscreen-button", CGRectMake(750, 405, 36, 36))];
    return window;
}

/// A window whose main region is a grid of items, with a small navigation bar above it.
static GHFakeAXNode *GridWindow(void) {
    GHFakeAXNode *window = Node(@"AXWindow", @"", CGRectMake(0, 0, 1000, 800));
    GHFakeAXNode *nav = [window addChild:Node(@"AXGroup", nil, CGRectMake(0, 0, 1000, 40))];
    for (NSUInteger i = 0; i < 5; i++) {
        GHFakeAXNode *item = [nav addChild:Node(@"AXGroup", nil, CGRectMake(20 + 80 * i, 8, 70, 24))];
        [item addChild:Node(@"AXLink", [NSString stringWithFormat:@"Section %lu", (unsigned long)i + 1], CGRectMake(20 + 80 * i, 8, 70, 24))];
    }
    GHFakeAXNode *main = [window addChild:Node(@"AXGroup", nil, CGRectMake(0, 60, 1000, 700))];
    for (NSUInteger i = 0; i < 6; i++) {
        CGRect tile = CGRectMake(20 + 320 * (i % 3), 80 + 240 * (i / 3), 300, 220);
        GHFakeAXNode *card = [main addChild:Node(@"AXGroup", nil, tile)];
        [card addChild:Node(@"AXLink", [NSString stringWithFormat:@"Item number %lu", (unsigned long)i + 1], tile)];
        [card addChild:Text([NSString stringWithFormat:@"%lu minutes", (unsigned long)i + 3], CGRectMake(tile.origin.x, CGRectGetMaxY(tile) - 16, 80, 14))];
    }
    return window;
}

/// The same grid, except the list leads with a heading that names the rows under it -- which is exactly how a
/// real notes list and a real file list publish their groups: same list, same index space as the rows.
static GHFakeAXNode *GridWindowLedByAHeading(void) {
    GHFakeAXNode *window = Node(@"AXWindow", @"", CGRectMake(0, 0, 1000, 800));
    GHFakeAXNode *main = [window addChild:Node(@"AXGroup", nil, CGRectMake(0, 60, 1000, 700))];
    for (NSUInteger i = 0; i < 7; i++) {
        CGRect tile = CGRectMake(20 + 320 * (i % 3), 80 + 240 * (i / 3), 300, 220);
        GHFakeAXNode *card = [main addChild:Node(@"AXGroup", nil, tile)];
        // Row zero is the heading; every other row is an ordinary item with the same shape.
        NSString *label = i == 0 ? @"Today" : [NSString stringWithFormat:@"Item number %lu", (unsigned long)i];
        [card addChild:Node(@"AXLink", label, tile)];
        [card addChild:Text([NSString stringWithFormat:@"%lu minutes", (unsigned long)i + 3], CGRectMake(tile.origin.x, CGRectGetMaxY(tile) - 16, 80, 14))];
    }
    return window;
}

/// A shop header: a search box, a cart carrying a count, prices, and a checkout that must stay locked.
static GHFakeAXNode *ShopWindow(NSUInteger inCart) {
    GHFakeAXNode *window = Node(@"AXWindow", @"", CGRectMake(0, 0, 1000, 800));
    GHFakeAXNode *header = [window addChild:Node(@"AXGroup", nil, CGRectMake(0, 0, 1000, 60))];
    GHFakeAXNode *search = [header addChild:Node(@"AXTextField", nil, CGRectMake(200, 16, 500, 28))];
    search.subrole = @"AXSearchField";
    search.placeholder = @"Search";
    GHFakeAXNode *cart = [header addChild:Node(@"AXButton", @"Cart", CGRectMake(920, 16, 40, 28))];
    if (inCart > 0) [cart addChild:Text([NSString stringWithFormat:@"%lu", (unsigned long)inCart], CGRectMake(944, 14, 14, 14))];
    GHFakeAXNode *main = [window addChild:Node(@"AXGroup", nil, CGRectMake(0, 60, 1000, 700))];
    for (NSUInteger i = 0; i < 3; i++) {
        CGRect tile = CGRectMake(20 + 320 * i, 80, 300, 220);
        GHFakeAXNode *card = [main addChild:Node(@"AXGroup", nil, tile)];
        [card addChild:Node(@"AXLink", [NSString stringWithFormat:@"Product %lu", (unsigned long)i + 1], tile)];
        [card addChild:Text([NSString stringWithFormat:@"$%lu.99", (unsigned long)i + 12], CGRectMake(tile.origin.x, CGRectGetMaxY(tile) - 16, 60, 14))];
    }
    [main addChild:Node(@"AXButton", @"Proceed to checkout", CGRectMake(800, 700, 160, 36))];
    return window;
}

/// A window Ghost cannot place: a couple of plain controls and nothing that says what kind of place it is.
static GHFakeAXNode *PlainWindow(void) {
    GHFakeAXNode *window = Node(@"AXWindow", @"", CGRectMake(0, 0, 600, 400));
    GHFakeAXNode *group = [window addChild:Node(@"AXGroup", nil, CGRectMake(0, 0, 600, 400))];
    GHFakeAXNode *search = [group addChild:Node(@"AXTextField", nil, CGRectMake(20, 20, 300, 24))];
    search.placeholder = @"Search";
    [group addChild:Node(@"AXButton", @"Inspector", CGRectMake(400, 20, 100, 24))];
    return window;
}

static GHNextAction *Engine(GHRoleMemoryStore *memory) {
    return [[GHNextAction alloc] initWithCore:Core() memory:memory];
}

static GHRoleMemoryStore *TempMemory(void) {
    NSString *path = [GHTestTempDirectory() stringByAppendingPathComponent:@"memory.json"];
    return [[GHRoleMemoryStore alloc] initWithPath:path core:Core()];
}

static GHNextProposal *ProposalFor(GHNextAction *engine, GHFakeAXNode *window, GHPageSignals *signals) {
    GHCaptureResult *result = [Capture() captureWindow:window];
    return [engine proposeForResult:result window:window signals:signals];
}

static GHNextProposal *RankedRole(GHNextAction *engine, NSString *role) {
    for (GHNextProposal *proposal in engine.ranked) if ([proposal.role isEqualToString:role]) return proposal;
    return nil;
}

#pragma mark - capture: the extra signals

GH_TEST(anywhere_capture_keeps_icon_only_controls_only_when_asked) {
    GHAnywhereSafety *safety = [[GHAnywhereSafety alloc] init];
    safety.core = Core();
    GHCapture *strict = [[GHCapture alloc] initWithSafety:safety];
    GHCaptureResult *without = [strict captureWindow:PlayerWindow(YES, NO)];
    GH_ASSERT_EQUAL_INT(without.fields.count, 0);   // nothing at all: the form walk can do nothing with a glyph

    GHCaptureResult *with = [Capture() captureWindow:PlayerWindow(YES, NO)];
    NSUInteger unnamed = 0;
    for (GHField *field in with.fields) if (field.unnamed) unnamed++;
    GH_ASSERT_EQUAL_INT(unnamed, 3);
    for (GHField *field in with.fields) {
        if (!field.unnamed) continue;
        GH_ASSERT_EQUAL_INT(field.label.length, 0);
        GH_ASSERT(field.identifier.length > 0);
    }
}

GH_TEST(anywhere_capture_marks_controls_inside_a_media_cluster) {
    // A capture of one tree annotated against ANOTHER tree annotates nothing: a hint is only ever a fact about
    // the very nodes the capture came from.
    GHCaptureResult *stale = [Capture() captureWindow:PlayerWindow(YES, NO)];
    [GHAffordance annotateResult:stale window:PlayerWindow(YES, NO)];
    for (GHField *field in stale.fields) GH_ASSERT_FALSE(field.insideMediaControls);

    GHFakeAXNode *window = PlayerWindow(YES, NO);
    GHCaptureResult *result = [Capture() captureWindow:window];
    GHPageSignals *signals = [GHAffordance annotateResult:result window:window];
    GH_ASSERT(signals.hasMediaElement);
    GH_ASSERT_FALSE(signals.isFullscreen);
    for (GHField *field in result.fields) GH_ASSERT_MSG(field.insideMediaControls, @"%@ is in the player's bar", field.signature);
}

GH_TEST(anywhere_capture_sees_a_video_that_already_fills_the_window) {
    GHFakeAXNode *window = PlayerWindow(YES, YES);
    GHCaptureResult *result = [Capture() captureWindow:window];
    GHPageSignals *signals = [GHAffordance annotateResult:result window:window];
    GH_ASSERT(signals.isFullscreen);
}

GH_TEST(anywhere_capture_finds_the_main_list_and_not_the_navigation_bar) {
    GHFakeAXNode *window = GridWindow();
    GHCaptureResult *result = [Capture() captureWindow:window];
    GHPageSignals *signals = [GHAffordance annotateResult:result window:window];
    GH_ASSERT_EQUAL_INT(signals.mainRegionRepeats, 6);
    GH_ASSERT(signals.mainListSignature.length > 0);

    // The navigation bar is not a list at all now, which is the stronger version of what this test always
    // meant. Its items are 70 x 24; the grid's tiles are 300 x 220. A thing you OPEN is drawn at a size
    // somebody would aim a whole click at, and a row of small controls is a toolbar. Measured in a chat
    // client, where the compose bar's three icon buttons formed a "list" whose first member then outranked
    // every conversation in the window.
    NSMutableSet<NSString *> *lists = [NSMutableSet set];
    for (GHField *field in result.fields) if (field.listSignature) [lists addObject:field.listSignature];
    GH_ASSERT_EQUAL_INT(lists.count, 1);
    GH_ASSERT([lists containsObject:signals.mainListSignature]);

    NSUInteger inMain = 0;
    for (GHField *field in result.fields) if ([field.listSignature isEqualToString:signals.mainListSignature]) inMain++;
    GH_ASSERT_EQUAL_INT(inMain, 6);
}

GH_TEST(anywhere_capture_reads_a_badge_and_a_price_without_keeping_the_text) {
    GHFakeAXNode *window = ShopWindow(2);
    GHCaptureResult *result = [Capture() captureWindow:window];
    [GHAffordance annotateResult:result window:window];
    GHField *cart = nil;
    NSUInteger priced = 0;
    for (GHField *field in result.fields) {
        if ([field.label isEqualToString:@"Cart"]) cart = field;
        if (field.nearbyPrice) priced++;
    }
    GH_ASSERT(cart != nil);
    GH_ASSERT_EQUAL_INT(cart.badgeCount, 2);
    GH_ASSERT_EQUAL_INT(priced, 3);
    // The hint is a number and a flag; the price string itself is never carried anywhere.
    NSDictionary *candidate = [cart toCandidateJSONObject];
    GH_ASSERT_EQUAL_OBJECTS(candidate[@"badgeCount"], @2);
    GH_ASSERT(candidate[@"value"] == nil);
}

GH_TEST(anywhere_capture_measures_text_density_without_keeping_text) {
    GHFakeAXNode *window = Node(@"AXWindow", @"", CGRectMake(0, 0, 800, 900));
    GHFakeAXNode *article = [window addChild:Node(@"AXGroup", nil, CGRectMake(0, 0, 800, 900))];
    for (NSUInteger i = 0; i < 12; i++) {
        NSString *paragraph = [@"" stringByPaddingToLength:400 withString:@"a sentence that goes on " startingAtIndex:0];
        [article addChild:Text(paragraph, CGRectMake(20, 20 + 60 * i, 760, 50))];
    }
    [article addChild:Node(@"AXButton", @"Share", CGRectMake(700, 860, 80, 24))];
    GHCaptureResult *result = [Capture() captureWindow:window];
    GHPageSignals *signals = [GHAffordance annotateResult:result window:window];
    GH_ASSERT_MSG(signals.textDensity > 0.6, @"a page of prose is dense, got %g", signals.textDensity);

    GHPageSignals *grid = [GHAffordance annotateResult:[Capture() captureWindow:GridWindow()] window:GridWindow()];
    GH_ASSERT_MSG(grid.textDensity < 0.6, @"a grid of controls is not prose, got %g", grid.textDensity);
}

GH_TEST(anywhere_price_and_duration_and_badge_patterns_are_currency_agnostic) {
    GH_ASSERT([GHAffordance looksLikePrice:@"$12.99"]);
    GH_ASSERT([GHAffordance looksLikePrice:@"€ 9,50"]);
    GH_ASSERT([GHAffordance looksLikePrice:@"1299 JPY"]);
    GH_ASSERT([GHAffordance looksLikePrice:@"₹ 499"]);
    GH_ASSERT_FALSE([GHAffordance looksLikePrice:@"12 items"]);
    GH_ASSERT_FALSE([GHAffordance looksLikePrice:@"2026"]);
    GH_ASSERT([GHAffordance looksLikeDuration:@"0:42"]);
    GH_ASSERT([GHAffordance looksLikeDuration:@"1:03:11"]);
    GH_ASSERT_FALSE([GHAffordance looksLikeDuration:@"12:99"]);
    GH_ASSERT_EQUAL_INT([GHAffordance countInBadgeText:@"3"], 3);
    GH_ASSERT_EQUAL_INT([GHAffordance countInBadgeText:@"12 items"], 12);
    GH_ASSERT_EQUAL_INT([GHAffordance countInBadgeText:@"2026"], 0);
    GH_ASSERT_EQUAL_INT([GHAffordance countInBadgeText:@"$4"], 0);
}

#pragma mark - the proposal

GH_TEST(anywhere_playing_video_is_offered_fullscreen) {
    GHNextAction *engine = Engine(TempMemory());
    GHNextProposal *top = ProposalFor(engine, PlayerWindow(YES, NO), nil);
    GH_ASSERT(top != nil);
    GH_ASSERT_EQUAL_OBJECTS(engine.pageKind, @"media");
    GH_ASSERT_EQUAL_OBJECTS(top.role, @"fullscreen");
    GH_ASSERT_FALSE(top.locked);
    GH_ASSERT(top.confidence >= 0.7);
    GH_ASSERT(top.reason.length > 0);
    // A reason is built from roles and places only: it can never carry what the window says.
    GH_ASSERT_FALSE([top.reason containsString:@"player"]);
}

GH_TEST(anywhere_paused_video_is_offered_play_first) {
    GHNextAction *engine = Engine(TempMemory());
    GHNextProposal *top = ProposalFor(engine, PlayerWindow(NO, NO), nil);
    GH_ASSERT(top != nil);
    GH_ASSERT_EQUAL_OBJECTS(top.role, @"play");
}

GH_TEST(anywhere_a_video_already_fullscreen_is_never_offered_fullscreen_again) {
    // docs/always-propose.md: a window with controls on it always gets a proposal. What the gate decides is how
    // it LOOKS. Someone already watching fullscreen is not offered fullscreen a second time (the classic wrong
    // ghost); what is left is a dim guess they ignore with one keystroke.
    GHNextAction *engine = Engine(TempMemory());
    GHNextProposal *top = ProposalFor(engine, PlayerWindow(YES, YES), nil);
    GH_ASSERT_MSG(top != nil, @"a window with controls always proposes something");
    GH_ASSERT_MSG(![top.role isEqualToString:@"fullscreen"], @"already fullscreen: proposing it again is the wrong ghost");
    GH_ASSERT_MSG(top.guess, @"below the gate it is drawn as a guess, not withheld");
    GH_ASSERT(top.confidence < engine.threshold);
    GH_ASSERT_FALSE(top.locked);
}

GH_TEST(anywhere_grid_window_offers_the_first_item) {
    GHNextAction *engine = Engine(TempMemory());
    GHFakeAXNode *window = GridWindow();
    GHCaptureResult *result = [Capture() captureWindow:window];
    GHNextProposal *top = [engine proposeForResult:result window:window signals:nil];
    GH_ASSERT(top != nil);
    GH_ASSERT_EQUAL_OBJECTS(engine.pageKind, @"feed");
    GH_ASSERT_EQUAL_OBJECTS(top.role, @"primary-item");
    GHField *chosen = nil;
    for (GHField *field in result.fields) if ([field.signature isEqualToString:top.signature]) chosen = field;
    GH_ASSERT(chosen != nil);
    GH_ASSERT_EQUAL_OBJECTS(chosen.label, @"Item number 1");   // the FIRST item, not a navigation entry
}

GH_TEST(anywhere_never_offers_the_heading_a_list_leads_with) {
    // Measured live before this existed: a notes list put "Pinned" at the top of its own list and Ghost proposed
    // it, top of the window. A heading names the rows under it; pressing one does nothing at all.
    GHNextAction *engine = Engine(TempMemory());
    GHFakeAXNode *window = GridWindowLedByAHeading();
    GHCaptureResult *result = [Capture() captureWindow:window];
    GHNextProposal *top = [engine proposeForResult:result window:window signals:nil];
    GH_ASSERT(top != nil);
    GHField *chosen = nil;
    for (GHField *field in result.fields) if ([field.signature isEqualToString:top.signature]) chosen = field;
    GH_ASSERT(chosen != nil);
    GH_ASSERT_MSG(![chosen.label isEqualToString:@"Today"], @"a heading is not something to press");
    GH_ASSERT_MSG(![top.role isEqualToString:@"section"], @"a heading can never be the proposal");
    GH_ASSERT_EQUAL_OBJECTS(top.role, @"primary-item");
    GH_ASSERT_EQUAL_OBJECTS(chosen.label, @"Item number 1");
}

GH_TEST(anywhere_shop_with_a_full_cart_offers_the_cart_and_locks_checkout) {
    GHNextAction *engine = Engine(TempMemory());
    GHNextProposal *top = ProposalFor(engine, ShopWindow(2), nil);
    GH_ASSERT(top != nil);
    GH_ASSERT_EQUAL_OBJECTS(engine.pageKind, @"commerce");
    GH_ASSERT_EQUAL_OBJECTS(top.role, @"cart");
    GH_ASSERT_FALSE(top.locked);

    GHNextProposal *checkout = RankedRole(engine, @"checkout");
    GH_ASSERT(checkout != nil);
    GH_ASSERT_MSG(checkout.locked, @"checkout is irreversible and must carry the lock");
    GH_ASSERT_MSG(![checkout.signature isEqualToString:top.signature], @"a locked control is never the proposal");
    // Rule 2 through the one rule that decides every Tab: a locked ghost is parked on, never pressed.
    GHGhost *ghost = [checkout ghostWithDisplayText:@"Proceed to checkout"];
    GH_ASSERT(ghost.locked);
    GHWalkSnapshot snapshot = { .active = YES, .hasCurrent = YES, .currentVisible = YES, .currentLocked = YES, .focusInWalk = YES };
    GH_ASSERT_EQUAL_INT(GHDecideTab(snapshot, GHKeyModifierNone, NO, NULL), GHKeyDecisionPark);
}

/// An empty cart used to send the shopper to the search box, and "it always goes to search on shopping
/// sites" was the result. A shopper still looking wants to look at a product; Ghost cannot know what anyone
/// is about to type, so a search box is the one thing it can never usefully offer.
GH_TEST(anywhere_empty_cart_offers_a_product_not_the_search_box) {
    GHNextAction *engine = Engine(TempMemory());
    GHNextProposal *top = ProposalFor(engine, ShopWindow(0), nil);
    GH_ASSERT(top != nil);
    GH_ASSERT_FALSE([top.role isEqualToString:@"search"]);
}

GH_TEST(anywhere_a_window_ghost_cannot_place_still_proposes_as_a_guess) {
    // The window Ghost has no idea about is exactly where silence used to happen, and exactly where the owner
    // noticed it: "it should just know what I'd click". The proposal exists; only the chip changes.
    GHNextAction *engine = Engine(TempMemory());
    GHNextProposal *top = ProposalFor(engine, PlainWindow(), nil);
    GH_ASSERT_MSG(top != nil, @"docs/always-propose.md: a place Ghost cannot name still gets a proposal");
    GH_ASSERT_EQUAL_OBJECTS(engine.pageKind, @"app");
    GH_ASSERT(top.confidence < 0.7);
    GH_ASSERT_MSG(top.guess, @"under the gate it is a guess");

    // The same row, with the user's gate lowered under it, is an ordinary ghost rather than a guess.
    GHNextAction *eager = Engine(TempMemory());
    eager.threshold = 0.5;
    GHNextProposal *confident = ProposalFor(eager, PlainWindow(), nil);
    GH_ASSERT(confident != nil);
    GH_ASSERT_EQUAL_OBJECTS(confident.role, top.role);
    GH_ASSERT_FALSE(confident.guess);
}

GH_TEST(anywhere_nothing_is_proposed_for_a_window_with_no_controls) {
    GHNextAction *engine = Engine(TempMemory());
    GHFakeAXNode *empty = Node(@"AXWindow", @"", CGRectMake(0, 0, 400, 300));
    GH_ASSERT(ProposalFor(engine, empty, nil) == nil);
}

GH_TEST(anywhere_signals_the_app_knows_win_over_the_tree) {
    GHNextAction *engine = Engine(TempMemory());
    GHPageSignals *signals = [[GHPageSignals alloc] init];
    signals.appBundleId = @"example.test.app";
    signals.pathPattern = @"/watch/:id";
    signals.isFullscreen = YES;
    GHNextProposal *top = ProposalFor(engine, PlayerWindow(YES, NO), signals);
    GH_ASSERT(top != nil);
    GH_ASSERT_MSG(![top.role isEqualToString:@"fullscreen"], @"the app said the video is already fullscreen");
    GH_ASSERT_EQUAL_OBJECTS(engine.lastSignals.appBundleId, @"example.test.app");
    GH_ASSERT_EQUAL_OBJECTS(engine.lastSignals.pathPattern, @"/watch/:id");
}

#pragma mark - role memory

GH_TEST(anywhere_two_accepts_change_the_order) {
    GHRoleMemoryStore *memory = TempMemory();
    GHNextAction *engine = Engine(memory);
    GHNextProposal *first = ProposalFor(engine, PlayerWindow(YES, NO), nil);
    GH_ASSERT_EQUAL_OBJECTS(first.role, @"fullscreen");

    GHNextProposal *captions = [[GHNextProposal alloc] init];
    captions.role = @"next";
    captions.pageKind = @"media";
    [engine recordOutcome:GHRoleOutcomeAccepted forProposal:captions];
    GHNextProposal *middle = ProposalFor(engine, PlayerWindow(YES, NO), nil);
    GH_ASSERT_MSG([middle.role isEqualToString:@"fullscreen"], @"one accept ties the strongest prior but does not reorder it");

    [engine recordOutcome:GHRoleOutcomeAccepted forProposal:captions];
    GHNextProposal *after = ProposalFor(engine, PlayerWindow(YES, NO), nil);
    GH_ASSERT_MSG([after.role isEqualToString:@"next"], @"twice is a habit: got %@", after.role);
    GH_ASSERT(after.confidence > 0.8);
    GH_ASSERT_EQUAL_OBJECTS(after.source, @"memory");
}

GH_TEST(anywhere_refusals_push_a_role_back_down) {
    GHRoleMemoryStore *memory = TempMemory();
    GHNextAction *engine = Engine(memory);
    GHNextProposal *fullscreen = [[GHNextProposal alloc] init];
    fullscreen.role = @"fullscreen";
    fullscreen.pageKind = @"media";
    for (int i = 0; i < 2; i++) [engine recordOutcome:GHRoleOutcomeDismissed forProposal:fullscreen];
    GHNextProposal *top = ProposalFor(engine, PlayerWindow(YES, NO), nil);
    GH_ASSERT_MSG(top == nil || ![top.role isEqualToString:@"fullscreen"], @"a role the user keeps refusing sinks");
}

GH_TEST(anywhere_memory_is_written_privately_and_survives_a_reload) {
    NSString *path = [GHTestTempDirectory() stringByAppendingPathComponent:@"memory.json"];
    GHRoleMemoryStore *memory = [[GHRoleMemoryStore alloc] initWithPath:path core:Core()];
    GH_ASSERT_EQUAL_INT(memory.snapshotJSON.length, 0);
    [memory record:@{ @"pageKind": @"media", @"role": @"fullscreen", @"previousRole": @"play" } outcome:GHRoleOutcomeAccepted];

    GH_ASSERT([NSFileManager.defaultManager fileExistsAtPath:path]);
    NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:path error:NULL];
    GH_ASSERT_EQUAL_INT([attributes[NSFilePosixPermissions] integerValue], 0600);

    GHRoleMemoryStore *reopened = [[GHRoleMemoryStore alloc] initWithPath:path core:Core()];
    NSDictionary *snapshot = GHJSONParse(reopened.snapshotJSON);
    NSArray *entries = snapshot[@"entries"];
    GH_ASSERT_EQUAL_INT(entries.count, 1);
    GH_ASSERT_EQUAL_OBJECTS(entries.firstObject[@"role"], @"fullscreen");
    GH_ASSERT_EQUAL_OBJECTS(entries.firstObject[@"previousRole"], @"play");
    GH_ASSERT_EQUAL_OBJECTS(entries.firstObject[@"stat"][@"accepted"], @1);
    // Nothing that could identify a window, an app or a control is in the file.
    NSString *text = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:NULL];
    GH_ASSERT_FALSE([text containsString:@"AX"]);
    GH_ASSERT_FALSE([text containsString:@"|"]);
}

GH_TEST(anywhere_a_corrupt_memory_file_is_simply_no_history) {
    NSString *path = [GHTestTempDirectory() stringByAppendingPathComponent:@"memory.json"];
    [@"{not json at all" writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    GHRoleMemoryStore *memory = [[GHRoleMemoryStore alloc] initWithPath:path core:Core()];
    GHNextAction *engine = Engine(memory);
    GHNextProposal *top = ProposalFor(engine, PlayerWindow(YES, NO), nil);
    GH_ASSERT_MSG(top != nil, @"a broken memory file must never stop Ghost from proposing");
    GH_ASSERT_EQUAL_OBJECTS(top.role, @"fullscreen");

    // And the next accept repairs the file rather than appending to the rubbish.
    [engine recordOutcome:GHRoleOutcomeAccepted forProposal:top];
    NSDictionary *snapshot = GHJSONParse([NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:NULL]);
    GH_ASSERT([snapshot[@"entries"] isKindOfClass:[NSArray class]]);
}

GH_TEST(anywhere_an_unknown_role_is_never_recorded) {
    NSString *path = [GHTestTempDirectory() stringByAppendingPathComponent:@"memory.json"];
    GHRoleMemoryStore *memory = [[GHRoleMemoryStore alloc] initWithPath:path core:Core()];
    GHNextAction *engine = Engine(memory);
    GHNextProposal *nothing = [[GHNextProposal alloc] init];   // role "unknown"
    [engine recordOutcome:GHRoleOutcomeAccepted forProposal:nothing];
    [engine recordOutcome:GHRoleOutcomeAccepted forProposal:nil];
    GH_ASSERT_FALSE([NSFileManager.defaultManager fileExistsAtPath:path]);
}

#pragma mark - the ghost the walk gets

GH_TEST(anywhere_proposal_becomes_a_click_ghost_the_walk_can_take) {
    GHNextAction *engine = Engine(TempMemory());
    GHFakeAXNode *window = PlayerWindow(YES, NO);
    GHCaptureResult *result = [Capture() captureWindow:window];
    GHNextProposal *top = [engine proposeForResult:result window:window signals:nil];
    GH_ASSERT(top != nil);
    GHGhost *ghost = [top ghostWithDisplayText:@"Fullscreen"];
    GH_ASSERT_EQUAL_OBJECTS(ghost.action, GHGhostActionClick);
    GH_ASSERT_EQUAL_OBJECTS(ghost.signature, top.signature);
    GH_ASSERT_FALSE(ghost.locked);
    GH_ASSERT(ghost.value == nil);   // a click ghost never carries a value

    GHWalkState *walk = [[GHWalkState alloc] init];
    [walk rescanWithGhosts:@[ ghost ]];
    GH_ASSERT_EQUAL_OBJECTS(walk.current.signature, top.signature);
    GHHoldState hold = { .walking = NO, .halted = NO };
    GH_ASSERT([walk shouldConsumeTabWithModifiers:GHKeyModifierNone isRepeat:NO focusSignature:nil currentVisible:YES hold:&hold]);
    [walk dismiss:ghost.signature];
    GH_ASSERT(walk.current == nil);   // Escape leaves nothing behind
}

GH_TEST(anywhere_the_proposal_always_names_a_control_of_this_capture) {
    GHNextAction *engine = Engine(TempMemory());
    GHFakeAXNode *window = ShopWindow(2);
    GHCaptureResult *result = [Capture() captureWindow:window];
    GHNextProposal *top = [engine proposeForResult:result window:window signals:nil];
    GH_ASSERT(top != nil);
    GH_ASSERT_MSG([result nodeForSignature:top.signature] != nil, @"a proposal Ghost cannot reach is no proposal");
    for (GHNextProposal *row in engine.ranked) GH_ASSERT([result nodeForSignature:row.signature] != nil);
}

#pragma mark - the vision fallback (docs/anywhere.md section 4)

/// A 1x1 image stands in for a screenshot: these tests never touch the screen, and never need the permission.
static CGImageRef PixelImage(void) {
    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = CGBitmapContextCreate(NULL, 8, 8, 8, 0, space, kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(space);
    CGContextSetRGBFillColor(context, 0.2, 0.2, 0.2, 1);
    CGContextFillRect(context, CGRectMake(0, 0, 8, 8));
    CGImageRef image = CGBitmapContextCreateImage(context);
    CGContextRelease(context);
    return image;
}

static GHVision *Vision(NSMutableArray<NSURLRequest *> *sent, NSString *replyJSON) {
    GHVision *vision = [[GHVision alloc] initWithBaseURLString:@"http://127.0.0.1:8787"];
    vision.screenshot = ^CGImageRef(CGRect rect) { return PixelImage(); };
    vision.transport = ^(NSURLRequest *request, void (^done)(NSData *, NSInteger)) {
        [sent addObject:request];
        done([replyJSON dataUsingEncoding:NSUTF8StringEncoding], 200);
    };
    return vision;
}

static NSArray<GHVisionBox *> *GlyphBoxes(void) {
    return @[
        [GHVisionBox boxWithSignature:@"AXButton||0" rect:CGRectMake(10, 405, 36, 36)],
        [GHVisionBox boxWithSignature:@"AXButton||1" rect:CGRectMake(750, 405, 36, 36)],
    ];
}

GH_TEST(anywhere_vision_only_crops_controls_nothing_could_name) {
    GHFakeAXNode *window = PlayerWindow(YES, NO);
    GHCaptureResult *result = [Capture() captureWindow:window];
    GHNextAction *engine = Engine(TempMemory());
    [engine proposeForResult:result window:window signals:nil];
    // The player's glyphs DO resolve from their identifiers, so there is nothing for the model to do here.
    GH_ASSERT_EQUAL_INT([GHVision boxesForFields:result.fields unnamed:engine.unnamedSignatures sensitiveOnScreen:NO].count, 0);

    GHField *mystery = [GHField fieldWithSignature:@"AXButton||9" label:@"" kind:GHKindButton];
    mystery.unnamed = YES;
    mystery.rect = CGRectMake(40, 40, 32, 32);
    NSArray<GHVisionBox *> *boxes = [GHVision boxesForFields:@[ mystery ] unnamed:@[ @"AXButton||9" ] sensitiveOnScreen:NO];
    GH_ASSERT_EQUAL_INT(boxes.count, 1);
    GH_ASSERT_EQUAL_OBJECTS(boxes.firstObject.signature, @"AXButton||9");
}

GH_TEST(anywhere_vision_refuses_a_window_with_a_sensitive_field_on_screen) {
    GHField *glyph = [GHField fieldWithSignature:@"AXButton||9" label:@"" kind:GHKindButton];
    glyph.rect = CGRectMake(40, 40, 32, 32);
    NSArray<GHVisionBox *> *boxes = [GHVision boxesForFields:@[ glyph ] unnamed:@[ @"AXButton||9" ] sensitiveOnScreen:YES];
    GH_ASSERT_MSG(boxes.count == 0, @"not one pixel of a window with a password on screen");
}

GH_TEST(anywhere_vision_skips_controls_too_small_or_too_large_to_be_controls) {
    GHField *speck = [GHField fieldWithSignature:@"a" label:@"" kind:GHKindButton];
    speck.rect = CGRectMake(0, 0, 4, 4);
    GHField *region = [GHField fieldWithSignature:@"b" label:@"" kind:GHKindButton];
    region.rect = CGRectMake(0, 0, 900, 700);
    GHField *control = [GHField fieldWithSignature:@"c" label:@"" kind:GHKindButton];
    control.rect = CGRectMake(0, 0, 36, 36);
    NSArray<GHVisionBox *> *boxes = [GHVision boxesForFields:@[ speck, region, control ] unnamed:(@[ @"a", @"b", @"c" ]) sensitiveOnScreen:NO];
    GH_ASSERT_EQUAL_INT(boxes.count, 1);
    GH_ASSERT_EQUAL_OBJECTS(boxes.firstObject.signature, @"c");
}

GH_TEST(anywhere_vision_says_when_screen_recording_is_missing) {
    GHVision *vision = [[GHVision alloc] initWithBaseURLString:nil];
    // No screenshot block and (in the test runner) no permission: the fallback reports itself unavailable and
    // nothing is captured or sent.
    if (vision.screenRecordingAllowed) return;   // a machine that HAS granted it: nothing to prove here
    GH_ASSERT_EQUAL_OBJECTS(vision.unavailableReason, GHVisionReasonScreenRecording);
    __block NSString *reason = nil;
    __block NSUInteger answered = 0;
    [vision labelBoxes:GlyphBoxes() pageKey:@"p1" completion:^(NSDictionary *labels, NSSet *locked, NSString *why) {
        reason = why;
        answered = labels.count;
    }];
    GH_ASSERT(GHTestWaitUntil(1.0, ^BOOL { return reason != nil; }));
    GH_ASSERT_EQUAL_OBJECTS(reason, GHVisionReasonScreenRecording);
    GH_ASSERT_EQUAL_INT(answered, 0);
    GH_ASSERT_EQUAL_INT(vision.calls, 0);
}

GH_TEST(anywhere_vision_names_icons_once_per_page_and_then_from_the_cache) {
    NSMutableArray<NSURLRequest *> *sent = [NSMutableArray array];
    NSString *reply = @"{\"labels\":[{\"id\":\"AXButton||0\",\"label\":\"Play\",\"role\":\"button\",\"affordance\":\"play\",\"irreversible\":false,\"sensitive\":false,\"confidence\":0.94},"
                       "{\"id\":\"AXButton||1\",\"label\":\"Fullscreen\",\"role\":\"button\",\"affordance\":\"fullscreen\",\"irreversible\":false,\"sensitive\":false,\"confidence\":0.91}]}";
    GHVision *vision = Vision(sent, reply);

    __block NSDictionary<NSString *, NSString *> *labels = nil;
    [vision labelBoxes:GlyphBoxes() pageKey:@"p1" completion:^(NSDictionary *got, NSSet *locked, NSString *why) { labels = got; }];
    GH_ASSERT(GHTestWaitUntil(1.0, ^BOOL { return labels != nil; }));
    GH_ASSERT_EQUAL_INT(labels.count, 2);
    GH_ASSERT_EQUAL_OBJECTS(labels[@"AXButton||0"], @"Play");
    GH_ASSERT_EQUAL_OBJECTS(labels[@"AXButton||1"], @"Fullscreen");
    GH_ASSERT_EQUAL_INT(sent.count, 1);

    // The request carries the strip and the boxes, and NOTHING else: no window title, no page text, no app name.
    NSDictionary *body = GHJSONParse([[NSString alloc] initWithData:sent.firstObject.HTTPBody encoding:NSUTF8StringEncoding]);
    GH_ASSERT_EQUAL_INT(body.count, 2);
    GH_ASSERT([body[@"image"] hasPrefix:@"data:image/png;base64,"]);
    GH_ASSERT_EQUAL_INT([body[@"boxes"] count], 2);
    GH_ASSERT(body[@"context"] == nil);
    GH_ASSERT(body[@"page"] == nil);

    // Second look at the same page: answered from the cache, no second call.
    labels = nil;
    [vision labelBoxes:GlyphBoxes() pageKey:@"p1" completion:^(NSDictionary *got, NSSet *locked, NSString *why) { labels = got; }];
    GH_ASSERT(GHTestWaitUntil(1.0, ^BOOL { return labels != nil; }));
    GH_ASSERT_EQUAL_INT(sent.count, 1);
    GH_ASSERT_EQUAL_INT(vision.cacheHits, 1);
    GH_ASSERT_EQUAL_INT(labels.count, 2);
}

GH_TEST(anywhere_vision_one_call_per_page_view_even_when_the_controls_move) {
    NSMutableArray<NSURLRequest *> *sent = [NSMutableArray array];
    GHVision *vision = Vision(sent, @"{\"labels\":[]}");
    [vision labelBoxes:GlyphBoxes() pageKey:@"p1" completion:^(NSDictionary *l, NSSet *k, NSString *w) {}];
    NSArray<GHVisionBox *> *moved = @[ [GHVisionBox boxWithSignature:@"AXButton||0" rect:CGRectMake(10, 500, 36, 36)] ];
    [vision labelBoxes:moved pageKey:@"p1" completion:^(NSDictionary *l, NSSet *k, NSString *w) {}];
    GH_ASSERT(GHTestWaitUntil(1.0, ^BOOL { return sent.count >= 1; }));
    GH_ASSERT_EQUAL_INT(sent.count, 1);

    [vision forgetPage];   // a new page view
    [vision labelBoxes:moved pageKey:@"p1" completion:^(NSDictionary *l, NSSet *k, NSString *w) {}];
    GH_ASSERT(GHTestWaitUntil(1.0, ^BOOL { return sent.count >= 2; }));
    GH_ASSERT_EQUAL_INT(sent.count, 2);
}

GH_TEST(anywhere_vision_locks_what_it_must_and_drops_what_it_may_not_name) {
    NSString *reply = @"{\"labels\":[{\"id\":\"a\",\"label\":\"Place order\",\"role\":\"button\",\"irreversible\":true,\"sensitive\":false,\"confidence\":0.9},"
                       "{\"id\":\"b\",\"label\":\"Card number\",\"role\":\"field\",\"irreversible\":false,\"sensitive\":true,\"confidence\":0.9},"
                       "{\"id\":\"c\",\"label\":null,\"role\":\"other\",\"irreversible\":false,\"sensitive\":false,\"confidence\":0}]}";
    NSMutableSet<NSString *> *locked = [NSMutableSet set];
    NSDictionary<NSString *, NSString *> *labels = [GHVision labelsFromReply:GHJSONParse(reply) locked:locked];
    GH_ASSERT_EQUAL_INT(labels.count, 1);
    GH_ASSERT_EQUAL_OBJECTS(labels[@"a"], @"Place order");
    GH_ASSERT([locked containsObject:@"a"]);
    GH_ASSERT_MSG(labels[@"b"] == nil, @"a sensitive control is never named, never drawn, never filled");
    GH_ASSERT_MSG(labels[@"c"] == nil, @"a box the model could not read stays unnamed");

    // Rubbish is simply no labels.
    GH_ASSERT_EQUAL_INT([GHVision labelsFromReply:@"not a reply" locked:locked].count, 0);
    GH_ASSERT_EQUAL_INT([GHVision labelsFromReply:nil locked:locked].count, 0);
}

GH_TEST(anywhere_vision_cache_key_changes_when_a_control_moves) {
    NSString *before = [GHVision cacheKeyForPage:@"p1" boxes:GlyphBoxes()];
    NSArray<GHVisionBox *> *moved = @[ GlyphBoxes().firstObject, [GHVisionBox boxWithSignature:@"AXButton||1" rect:CGRectMake(751, 405, 36, 36)] ];
    GH_ASSERT_FALSE([before isEqualToString:[GHVision cacheKeyForPage:@"p1" boxes:moved]]);
    GH_ASSERT_FALSE([before isEqualToString:[GHVision cacheKeyForPage:@"p2" boxes:GlyphBoxes()]]);
    GH_ASSERT_EQUAL_OBJECTS(before, [GHVision cacheKeyForPage:@"p1" boxes:GlyphBoxes()]);
}

#pragma mark - the one press (rule 2 at the writer)

/// The smallest actuator that can answer a press. Everything else refuses, so a test can only ever prove the
/// press path; nothing here can type, fill or drive a panel.
@interface GHPressOnlyActuator : NSObject <GHAXActuating>
@property (nonatomic) NSUInteger presses;
@property (nonatomic) NSUInteger clicks;
@property (nonatomic) NSUInteger opens;
/// NO makes this element one of the many that publish no AXPress at all, so the writer must click it.
@property (nonatomic) BOOL publishesPress;
@end

@implementation GHPressOnlyActuator
- (instancetype)init { if ((self = [super init])) _publishesPress = YES; return self; }
- (id<GHAXNode>)refreshedNode:(id<GHAXNode>)node { return node; }
- (BOOL)focusNode:(id<GHAXNode>)node { return YES; }
- (BOOL)setValue:(NSString *)value ofNode:(id<GHAXNode>)node { return NO; }
- (BOOL)selectAllInNode:(id<GHAXNode>)node { return NO; }
- (BOOL)replaceSelectionWithText:(NSString *)text inNode:(id<GHAXNode>)node { return NO; }
- (BOOL)typeText:(NSString *)text intoNode:(id<GHAXNode>)node { return NO; }
- (BOOL)pressNode:(id<GHAXNode>)node { self.presses++; return YES; }
- (BOOL)nodeAcceptsPress:(id<GHAXNode>)node { return self.publishesPress; }
- (BOOL)clickNode:(id<GHAXNode>)node { self.clicks++; return YES; }
- (BOOL)openNode:(id<GHAXNode>)node { self.opens++; return YES; }
- (BOOL)dismissMenuOfPopup:(id<GHAXNode>)popup stillWanted:(BOOL (^)(void))stillWanted { return NO; }
- (BOOL)scrollToVisible:(id<GHAXNode>)node { return NO; }
@end

static GHWriteResult *WriteClick(GHWriter *writer, GHGhost *ghost, GHField *field, id<GHAXNode> node) {
    __block GHWriteResult *result = nil;
    [writer executeGhost:ghost field:field node:node optionNode:nil completion:^(GHWriteResult *got) { result = got; }];
    GHTestWaitUntil(1.0, ^BOOL { return result != nil; });
    return result;
}

GH_TEST(anywhere_an_unlocked_proposal_is_pressed_exactly_once_and_only_with_a_live_lock_check) {
    GHFakeAXNode *node = Node(@"AXButton", @"Full screen", CGRectMake(750, 405, 36, 36));
    GHField *field = [GHField fieldWithSignature:@"AXButton|full|0" label:@"Full screen" kind:GHKindButton];
    field.rect = node.frame;
    GHGhost *ghost = [[GHGhost alloc] init];
    ghost.signature = field.signature;
    ghost.action = GHGhostActionClick;
    ghost.displayText = field.label;
    ghost.confidence = 0.7;

    GHPressOnlyActuator *actuator = [[GHPressOnlyActuator alloc] init];
    GHWriter *writer = [[GHWriter alloc] initWithActuator:actuator];
    writer.isNodeSensitive = ^BOOL(id<GHAXNode> n) { return NO; };
    writer.after = ^(NSTimeInterval delay, dispatch_block_t block) { block(); };

    // No lock check: nothing is pressed, ever. The form walk's own click ghost is the locked Submit.
    GHWriteResult *refused = WriteClick(writer, ghost, field, node);
    GH_ASSERT_FALSE(refused.ok);
    GH_ASSERT_EQUAL_OBJECTS(refused.reason, GHWriteReasonLocked);
    GH_ASSERT_EQUAL_INT(actuator.presses, 0);

    // A check that says "irreversible after all": still nothing pressed.
    writer.isNodeLocked = ^BOOL(id<GHAXNode> n) { return YES; };
    GHWriteResult *locked = WriteClick(writer, ghost, field, node);
    GH_ASSERT_FALSE(locked.ok);
    GH_ASSERT_EQUAL_OBJECTS(locked.reason, GHWriteReasonLocked);
    GH_ASSERT_EQUAL_INT(actuator.presses, 0);

    // A plainly reversible control: one press, and the result says so.
    writer.isNodeLocked = ^BOOL(id<GHAXNode> n) { return NO; };
    GHWriteResult *pressed = WriteClick(writer, ghost, field, node);
    GH_ASSERT(pressed.ok);
    GH_ASSERT_EQUAL_OBJECTS(pressed.method, GHWriteMethodPress);
    GH_ASSERT_EQUAL_INT(actuator.presses, 1);

    // A ghost the core locked, or a control capture locked, is refused before the check is even asked.
    ghost.locked = YES;
    GH_ASSERT_EQUAL_OBJECTS(WriteClick(writer, ghost, field, node).reason, GHWriteReasonLocked);
    ghost.locked = NO;
    field.locked = YES;
    GH_ASSERT_EQUAL_OBJECTS(WriteClick(writer, ghost, field, node).reason, GHWriteReasonLocked);
    GH_ASSERT_EQUAL_INT(actuator.presses, 1);
}

/// A proposal carries no value, so its display text is the control's own name. That names an ACTION on a
/// button ("Play") and is the placeholder on anything you interact with by value, which is how a search box
/// saying "Search" got a ghost saying "Search" beside it. Shown here for the kind that survived the first
/// attempt at this: a search box WITH A DROPDOWN is a combobox, not a text field.
GH_TEST(anywhere_only_a_control_whose_name_is_an_action_shows_it) {
    NSArray<NSString *> *silent = @[ GHKindText, GHKindTextArea, GHKindSelect, GHKindCheckbox, GHKindRadio ];
    for (NSString *kind in silent) {
        GHField *field = [GHField fieldWithSignature:@"s|0" label:@"Search" kind:kind];
        GH_ASSERT_MSG(GHProposalDisplayText(field).length == 0, @"%@ must say nothing", kind);
    }
    for (NSString *kind in @[ GHKindButton, GHKindLink, GHKindItem ]) {
        GHField *field = [GHField fieldWithSignature:@"a|0" label:@"Play" kind:kind];
        GH_ASSERT_EQUAL_OBJECTS(GHProposalDisplayText(field), @"Play");
    }
}

/// A chat app opening a new message puts the cursor in `To`, and Ghost used to offer that box back: press to
/// move the cursor to where the cursor is. Worse, the step after it -- knowing who to write to -- is the one
/// thing Ghost cannot help with at all, so the whole chain ended in a shrug.
GH_TEST(anywhere_the_box_the_cursor_is_already_in_is_not_an_action) {
    GHFakeAXNode *node = Node(@"AXTextField", @"To", CGRectMake(300, 40, 600, 28));
    GHField *field = [GHField fieldWithSignature:@"ax|AXTextField|to|0" label:@"To" kind:GHKindText];
    field.rect = node.frame;
    field.focused = YES;

    GHCaptureResult *result = [[GHCaptureResult alloc] init];
    [result setValue:@[ field ] forKey:@"fields"];
    [result setValue:@{ field.signature: node } forKey:@"nodes"];

    GHNextAction *engine = [[GHNextAction alloc] initWithCore:[GHCore sharedCore] memory:nil];
    GHNextProposal *proposal = [engine proposeForResult:result window:node signals:nil];
    // Whatever the ranking says, a focused empty box is never handed back as something to press.
    GH_ASSERT(proposal == nil || ![proposal.signature isEqualToString:field.signature]);

    // The same box, NOT focused, is an ordinary offer again: putting the cursor there is a real action.
    field.focused = NO;
    GHNextProposal *unfocused = [engine proposeForResult:result window:node signals:nil];
    (void)unfocused;   // the ranking decides whether it wins; the point is that it is no longer refused
}

/// "Pick, never generate." A box with the app's own answers listed under it does not want a cursor in it --
/// nobody types a name they can see. Measured as the bug: a search box whose placeholder said "Go to file"
/// got a ghost that said "Go to file", because a proposal's display text names its control and a search
/// box's name IS its placeholder.
GH_TEST(anywhere_a_box_with_the_answers_under_it_is_not_the_proposal) {
    GHCaptureResult *result = [[GHCaptureResult alloc] init];
    GHField *box = [GHField fieldWithSignature:@"ax|AXTextField|goto|0" label:@"Go to file" kind:GHKindText];
    box.rect = CGRectMake(300, 100, 400, 32);
    box.focused = YES;
    NSMutableArray<GHField *> *fields = [NSMutableArray arrayWithObject:box];
    for (NSUInteger i = 0; i < 3; i++) {
        GHField *row = [GHField fieldWithSignature:[NSString stringWithFormat:@"ax|AXRow|r%lu|0", (unsigned long)i]
                                             label:[NSString stringWithFormat:@"File %lu.ts", (unsigned long)i] kind:GHKindItem];
        row.rect = CGRectMake(300, (CGFloat)(140 + i * 28), 400, 26);
        [fields addObject:row];
    }
    [result setValue:fields forKey:@"fields"];
    GH_ASSERT([GHNextAction result:result showsCandidatesUnder:box.signature]);

    // A sidebar BESIDE the box is a different thing entirely, and so is a list far below it.
    GHCaptureResult *beside = [[GHCaptureResult alloc] init];
    NSMutableArray<GHField *> *other = [NSMutableArray arrayWithObject:box];
    for (NSUInteger i = 0; i < 3; i++) {
        GHField *row = [GHField fieldWithSignature:[NSString stringWithFormat:@"ax|AXRow|s%lu|0", (unsigned long)i]
                                             label:@"Sidebar" kind:GHKindItem];
        row.rect = CGRectMake(0, (CGFloat)(140 + i * 28), 280, 26);   // left of the box, no overlap
        [other addObject:row];
    }
    [beside setValue:other forKey:@"fields"];
    GH_ASSERT_FALSE([GHNextAction result:beside showsCandidatesUnder:box.signature]);

    // And a box with nothing under it keeps the cursor: there is simply nothing to pick from.
    GHCaptureResult *bare = [[GHCaptureResult alloc] init];
    [bare setValue:@[ box ] forKey:@"fields"];
    GH_ASSERT_FALSE([GHNextAction result:bare showsCandidatesUnder:box.signature]);
}

/// Most of the desktop does not implement AXPress: a Finder row, a Spotify tile, a Discord channel, anything
/// custom-drawn. Before this, `press` was the only actuation Ghost had, and on all of those the accept did
/// nothing at all -- and still reported ok, because kAXErrorCannotComplete was being counted as success.
GH_TEST(anywhere_a_control_that_does_not_implement_press_is_really_clicked) {
    GHFakeAXNode *node = Node(@"AXButton", @"Full screen", CGRectMake(0, 120, 300, 64));
    GHField *field = [GHField fieldWithSignature:@"AXButton|fullscreen|0" label:@"Full screen" kind:GHKindButton];
    field.rect = node.frame;
    GHGhost *ghost = [[GHGhost alloc] init];
    ghost.signature = field.signature;
    ghost.action = GHGhostActionClick;
    ghost.displayText = field.label;
    ghost.confidence = 0.8;

    GHPressOnlyActuator *actuator = [[GHPressOnlyActuator alloc] init];
    actuator.publishesPress = NO;   // the element lists no AXPress at all
    GHWriter *writer = [[GHWriter alloc] initWithActuator:actuator];
    writer.isNodeSensitive = ^BOOL(id<GHAXNode> n) { return NO; };
    writer.isNodeLocked = ^BOOL(id<GHAXNode> n) { return NO; };
    writer.after = ^(NSTimeInterval delay, dispatch_block_t block) { block(); };

    GHWriteResult *clicked = WriteClick(writer, ghost, field, node);
    GH_ASSERT(clicked.ok);
    GH_ASSERT_EQUAL_OBJECTS(clicked.method, GHWriteMethodClick);
    GH_ASSERT_EQUAL_INT(actuator.clicks, 1);
    GH_ASSERT_EQUAL_INT(actuator.presses, 0);   // never pressed something that cannot be pressed

    // And a locked control is still never touched, by either route.
    field.locked = YES;
    GH_ASSERT_EQUAL_OBJECTS(WriteClick(writer, ghost, field, node).reason, GHWriteReasonLocked);
    GH_ASSERT_EQUAL_INT(actuator.clicks, 1);
}

/// A row is not a button. AXPress on one SELECTS it: measured on Spotify, where pressing a playlist
/// highlighted it and opened nothing at all. Activating a row is an OPEN -- AXOpen, or a double click.
GH_TEST(anywhere_a_list_entry_is_opened_and_never_merely_pressed) {
    GHFakeAXNode *node = Node(@"AXRow", nil, CGRectMake(0, 120, 300, 64));
    GHField *field = [GHField fieldWithSignature:@"ax|AXRow|playlist|0" label:@"pre grrr" kind:GHKindItem];
    field.rect = node.frame;
    GHGhost *ghost = [[GHGhost alloc] init];
    ghost.signature = field.signature;
    ghost.action = GHGhostActionClick;
    ghost.displayText = field.label;

    GHPressOnlyActuator *actuator = [[GHPressOnlyActuator alloc] init];
    GHWriter *writer = [[GHWriter alloc] initWithActuator:actuator];
    writer.isNodeSensitive = ^BOOL(id<GHAXNode> n) { return NO; };
    writer.isNodeLocked = ^BOOL(id<GHAXNode> n) { return NO; };
    writer.after = ^(NSTimeInterval delay, dispatch_block_t block) { block(); };

    GHWriteResult *opened = WriteClick(writer, ghost, field, node);
    GH_ASSERT(opened.ok);
    GH_ASSERT_EQUAL_OBJECTS(opened.method, GHWriteMethodOpen);
    GH_ASSERT_EQUAL_INT(actuator.opens, 1);
    GH_ASSERT_EQUAL_INT(actuator.presses, 0);
    GH_ASSERT_EQUAL_INT(actuator.clicks, 0);

    // A locked row is refused before any of that.
    field.locked = YES;
    GH_ASSERT_EQUAL_OBJECTS(WriteClick(writer, ghost, field, node).reason, GHWriteReasonLocked);
    GH_ASSERT_EQUAL_INT(actuator.opens, 1);
}

/// The real click is the fallback, never the first choice: AXPress is the app's own default action, it needs
/// no pointer, and it cannot land on whatever happens to be under the mouse.
GH_TEST(anywhere_press_is_preferred_and_the_click_is_the_fallback) {
    GHFakeAXNode *node = Node(@"AXButton", @"Play", CGRectMake(700, 400, 36, 36));
    GHField *field = [GHField fieldWithSignature:@"AXButton|play|0" label:@"Play" kind:GHKindButton];
    field.rect = node.frame;
    GHGhost *ghost = [[GHGhost alloc] init];
    ghost.signature = field.signature;
    ghost.action = GHGhostActionClick;
    ghost.displayText = field.label;

    GHPressOnlyActuator *actuator = [[GHPressOnlyActuator alloc] init];
    GHWriter *writer = [[GHWriter alloc] initWithActuator:actuator];
    writer.isNodeSensitive = ^BOOL(id<GHAXNode> n) { return NO; };
    writer.isNodeLocked = ^BOOL(id<GHAXNode> n) { return NO; };
    writer.after = ^(NSTimeInterval delay, dispatch_block_t block) { block(); };

    GHWriteResult *pressed = WriteClick(writer, ghost, field, node);
    GH_ASSERT_EQUAL_OBJECTS(pressed.method, GHWriteMethodPress);
    GH_ASSERT_EQUAL_INT(actuator.presses, 1);
    GH_ASSERT_EQUAL_INT(actuator.clicks, 0);
}

GH_TEST(anywhere_a_search_box_proposal_moves_the_cursor_and_presses_nothing) {
    GHFakeAXNode *node = Node(@"AXTextField", nil, CGRectMake(200, 16, 500, 28));
    node.subrole = @"AXSearchField";
    node.placeholder = @"Search";
    GHField *field = [GHField fieldWithSignature:@"AXTextField|search|0" label:@"Search" kind:GHKindText];
    field.rect = node.frame;
    GHGhost *ghost = [[GHGhost alloc] init];
    ghost.signature = field.signature;
    ghost.action = GHGhostActionClick;
    ghost.displayText = @"Search";

    GHPressOnlyActuator *actuator = [[GHPressOnlyActuator alloc] init];
    GHWriter *writer = [[GHWriter alloc] initWithActuator:actuator];
    writer.isNodeSensitive = ^BOOL(id<GHAXNode> n) { return NO; };
    writer.isNodeLocked = ^BOOL(id<GHAXNode> n) { return NO; };
    writer.after = ^(NSTimeInterval delay, dispatch_block_t block) { block(); };

    GHWriteResult *result = WriteClick(writer, ghost, field, node);
    GH_ASSERT(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.method, GHWriteMethodFocus);
    GH_ASSERT_MSG(actuator.presses == 0, @"a text box is never pressed; the cursor going there is the whole action");
    GH_ASSERT_MSG(ghost.value == nil, @"and nothing is ever typed into it");
}

GH_TEST(anywhere_an_ordinary_form_field_is_never_proposed_as_a_click) {
    // A window whose only controls are ordinary fields: the form walk fills those. The next-action path must
    // not put a "Tab to click" cursor on a text box (and on this window it has nothing else to offer).
    GHFakeAXNode *window = Node(@"AXWindow", @"", CGRectMake(0, 0, 600, 400));
    GHFakeAXNode *group = [window addChild:Node(@"AXGroup", nil, CGRectMake(0, 0, 600, 400))];
    for (NSUInteger i = 0; i < 4; i++) {
        GHFakeAXNode *label = [group addChild:Text([NSString stringWithFormat:@"Detail %lu", (unsigned long)i + 1], CGRectMake(20, 20 + 40 * i, 120, 18))];
        (void)label;
        GHFakeAXNode *input = [group addChild:Node(@"AXTextField", [NSString stringWithFormat:@"Detail %lu", (unsigned long)i + 1], CGRectMake(150, 20 + 40 * i, 300, 24))];
        input.value = @"already filled";
    }
    GHNextAction *engine = Engine(TempMemory());
    GHNextProposal *top = ProposalFor(engine, window, nil);
    GH_ASSERT_MSG(top == nil, @"got %@", top);
    for (GHNextProposal *row in engine.ranked) GH_ASSERT_FALSE([row.role isEqualToString:@"field"]);
}

#pragma mark - always propose (docs/always-propose.md)

GH_TEST(anywhere_one_nameless_icon_is_still_a_proposal) {
    // The owner's complaint, in its smallest form: a window Ghost can say nothing about must still put the
    // cursor somewhere. One icon, no text anywhere, no page kind: propose it, as a guess.
    GHFakeAXNode *window = Node(@"AXWindow", @"", CGRectMake(0, 0, 500, 400));
    GHFakeAXNode *bar = [window addChild:Node(@"AXGroup", nil, CGRectMake(0, 0, 500, 44))];
    [bar addChild:Glyph(@"tool-a", CGRectMake(12, 6, 32, 32))];

    GHNextAction *engine = Engine(TempMemory());
    GHNextProposal *top = ProposalFor(engine, window, nil);
    GH_ASSERT_MSG(top != nil, @"silence is only right when there is nothing actionable at all");
    GH_ASSERT(top.guess);
    GH_ASSERT_FALSE(top.locked);
    GH_ASSERT_EQUAL_INT(engine.unnamedSignatures.count, 1);   // and this is what the vision fallback is for
}

GH_TEST(anywhere_a_window_whose_only_control_is_irreversible_proposes_it_locked) {
    // Proposing is not doing. The only thing on offer is irreversible, so it is proposed WITH its lock, and the
    // one rule that decides every accept key parks on it instead of pressing it.
    GHFakeAXNode *window = Node(@"AXWindow", @"", CGRectMake(0, 0, 400, 200));
    GHFakeAXNode *group = [window addChild:Node(@"AXGroup", nil, CGRectMake(0, 0, 400, 200))];
    [group addChild:Node(@"AXButton", @"Delete everything", CGRectMake(120, 80, 160, 32))];

    GHNextAction *engine = Engine(TempMemory());
    GHNextProposal *top = ProposalFor(engine, window, nil);
    GH_ASSERT(top != nil);
    GH_ASSERT_MSG(top.locked, @"an irreversible control keeps its lock even as the only proposal");
    GHWalkSnapshot snapshot = { .active = YES, .hasCurrent = YES, .currentVisible = YES, .currentLocked = YES, .focusInWalk = YES };
    GH_ASSERT_EQUAL_INT(GHDecideTab(snapshot, GHKeyModifierNone, NO, NULL), GHKeyDecisionPark);
}

GH_TEST(anywhere_a_confident_row_is_not_marked_a_guess) {
    // The chip is the only thing the gate controls, so the ordinary case must stay ordinary.
    GHNextAction *engine = Engine(TempMemory());
    GHNextProposal *top = ProposalFor(engine, PlayerWindow(YES, NO), nil);
    GH_ASSERT(top != nil);
    GH_ASSERT_EQUAL_OBJECTS(top.role, @"fullscreen");
    GH_ASSERT(top.confidence >= engine.threshold);
    GH_ASSERT_FALSE(top.guess);
}

GH_TEST(anywhere_every_ranked_row_carries_its_own_guess_flag) {
    GHNextAction *engine = Engine(TempMemory());
    GHNextProposal *top = ProposalFor(engine, ShopWindow(2), nil);
    GH_ASSERT(top != nil);
    GH_ASSERT(engine.ranked.count > 1);
    for (GHNextProposal *row in engine.ranked) {
        GH_ASSERT_EQUAL_INT(row.guess, row.confidence < engine.threshold);
    }
}
