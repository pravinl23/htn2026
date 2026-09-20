// Shabang anywhere on the native side (docs/anywhere.md): SBAffordance's hints, SBNextAction's proposal and the
// role memory on disk, all of it through the REAL shabang-core.js in JavaScriptCore (DESKTOP_CORE_PATH, set by
// `make test`) and against fake accessibility trees.
//
// Every window here is synthetic and generic: a player, a grid, a shop header, a plain app window. Nothing in
// this file names a website, an app or a brand, because nothing in the code under test may read one.
#import "SBTest.h"
#import "SBAXNode.h"
#import "SBAffordance.h"
#import "SBCapture.h"
#import "SBCore.h"
#import "SBField.h"
#import "SBController.h"
#import "SBNextAction.h"
#import "SBWalkState.h"
#import "SBVision.h"
#import "SBWriter.h"

#pragma mark - fixtures

/// Knows nothing: the shared rules in the core do the safety work, and these tests prove they still apply.
@interface SBAnywhereSafety : NSObject <SBSafetyChecking>
@property (nonatomic, strong) SBCore *core;
@end

@implementation SBAnywhereSafety
- (BOOL)isSensitiveProbe:(NSDictionary<NSString *, id> *)probe { return [self.core isSensitive:probe]; }
- (BOOL)isLockedProbe:(NSDictionary<NSString *, id> *)probe { return [self.core isLockedAction:probe]; }
@end

static SBCore *Core(void) {
    static SBCore *core;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSString *path = [SBCore defaultBundlePath];
        core = path ? [[SBCore alloc] initWithBundlePath:path error:NULL] : nil;
    });
    return core;
}

static SBCapture *Capture(void) {
    SBAnywhereSafety *safety = [[SBAnywhereSafety alloc] init];
    safety.core = Core();
    SBCapture *capture = [[SBCapture alloc] initWithSafety:safety];
    capture.capturesUnnamedControls = YES;   // docs/anywhere.md: an icon-only control is the whole point
    return capture;
}

static SBFakeAXNode *Node(NSString *role, NSString *title, CGRect frame) {
    return [SBFakeAXNode nodeWithRole:role title:title frame:frame];
}

/// An icon-only control: no title, no description, only the identifier a design system gave it.
static SBFakeAXNode *Glyph(NSString *identifier, CGRect frame) {
    SBFakeAXNode *node = Node(@"AXButton", nil, frame);
    node.identifier = identifier;
    return node;
}

static SBFakeAXNode *Text(NSString *text, CGRect frame) {
    return [SBFakeAXNode staticText:text frame:frame];
}

/**
 * A video player window. `playing` decides which way the player's own toggle points, which is the only generic
 * evidence there is that something is playing. Every control is icon-only: no text anywhere in the tree.
 */
static SBFakeAXNode *PlayerWindow(BOOL playing, BOOL fullscreen) {
    CGRect windowFrame = CGRectMake(0, 0, 800, 600);
    SBFakeAXNode *window = Node(@"AXWindow", @"", windowFrame);
    SBFakeAXNode *player = [window addChild:Node(@"AXGroup", nil, CGRectMake(0, 0, 800, fullscreen ? 600 : 450))];
    [player addChild:Node(@"AXVideo", nil, CGRectMake(0, 0, 800, fullscreen ? 600 : 450))];
    SBFakeAXNode *bar = [player addChild:Node(@"AXGroup", nil, CGRectMake(0, 400, 800, 44))];
    [bar addChild:Glyph(playing ? @"player-pause-button" : @"player-play-button", CGRectMake(10, 405, 36, 36))];
    SBFakeAXNode *scrubber = [bar addChild:Node(@"AXSlider", nil, CGRectMake(60, 415, 600, 12))];
    scrubber.value = @"0:42";
    [bar addChild:Text(@"0:42", CGRectMake(60, 430, 40, 12))];
    [bar addChild:Glyph(@"player-next-button", CGRectMake(670, 405, 36, 36))];
    [bar addChild:Glyph(@"player-fullscreen-button", CGRectMake(750, 405, 36, 36))];
    return window;
}

/// A window whose main region is a grid of items, with a small navigation bar above it.
static SBFakeAXNode *GridWindow(void) {
    SBFakeAXNode *window = Node(@"AXWindow", @"", CGRectMake(0, 0, 1000, 800));
    SBFakeAXNode *nav = [window addChild:Node(@"AXGroup", nil, CGRectMake(0, 0, 1000, 40))];
    for (NSUInteger i = 0; i < 5; i++) {
        SBFakeAXNode *item = [nav addChild:Node(@"AXGroup", nil, CGRectMake(20 + 80 * i, 8, 70, 24))];
        [item addChild:Node(@"AXLink", [NSString stringWithFormat:@"Section %lu", (unsigned long)i + 1], CGRectMake(20 + 80 * i, 8, 70, 24))];
    }
    SBFakeAXNode *main = [window addChild:Node(@"AXGroup", nil, CGRectMake(0, 60, 1000, 700))];
    for (NSUInteger i = 0; i < 6; i++) {
        CGRect tile = CGRectMake(20 + 320 * (i % 3), 80 + 240 * (i / 3), 300, 220);
        SBFakeAXNode *card = [main addChild:Node(@"AXGroup", nil, tile)];
        [card addChild:Node(@"AXLink", [NSString stringWithFormat:@"Item number %lu", (unsigned long)i + 1], tile)];
        [card addChild:Text([NSString stringWithFormat:@"%lu minutes", (unsigned long)i + 3], CGRectMake(tile.origin.x, CGRectGetMaxY(tile) - 16, 80, 14))];
    }
    return window;
}

/// The same grid, except the list leads with a heading that names the rows under it -- which is exactly how a
/// real notes list and a real file list publish their groups: same list, same index space as the rows.
static SBFakeAXNode *GridWindowLedByAHeading(void) {
    SBFakeAXNode *window = Node(@"AXWindow", @"", CGRectMake(0, 0, 1000, 800));
    SBFakeAXNode *main = [window addChild:Node(@"AXGroup", nil, CGRectMake(0, 60, 1000, 700))];
    for (NSUInteger i = 0; i < 7; i++) {
        CGRect tile = CGRectMake(20 + 320 * (i % 3), 80 + 240 * (i / 3), 300, 220);
        SBFakeAXNode *card = [main addChild:Node(@"AXGroup", nil, tile)];
        // Row zero is the heading; every other row is an ordinary item with the same shape.
        NSString *label = i == 0 ? @"Today" : [NSString stringWithFormat:@"Item number %lu", (unsigned long)i];
        [card addChild:Node(@"AXLink", label, tile)];
        [card addChild:Text([NSString stringWithFormat:@"%lu minutes", (unsigned long)i + 3], CGRectMake(tile.origin.x, CGRectGetMaxY(tile) - 16, 80, 14))];
    }
    return window;
}

/// A shop header: a search box, a cart carrying a count, prices, and a checkout that must stay locked.
static SBFakeAXNode *ShopWindow(NSUInteger inCart) {
    SBFakeAXNode *window = Node(@"AXWindow", @"", CGRectMake(0, 0, 1000, 800));
    SBFakeAXNode *header = [window addChild:Node(@"AXGroup", nil, CGRectMake(0, 0, 1000, 60))];
    SBFakeAXNode *search = [header addChild:Node(@"AXTextField", nil, CGRectMake(200, 16, 500, 28))];
    search.subrole = @"AXSearchField";
    search.placeholder = @"Search";
    SBFakeAXNode *cart = [header addChild:Node(@"AXButton", @"Cart", CGRectMake(920, 16, 40, 28))];
    if (inCart > 0) [cart addChild:Text([NSString stringWithFormat:@"%lu", (unsigned long)inCart], CGRectMake(944, 14, 14, 14))];
    SBFakeAXNode *main = [window addChild:Node(@"AXGroup", nil, CGRectMake(0, 60, 1000, 700))];
    for (NSUInteger i = 0; i < 3; i++) {
        CGRect tile = CGRectMake(20 + 320 * i, 80, 300, 220);
        SBFakeAXNode *card = [main addChild:Node(@"AXGroup", nil, tile)];
        [card addChild:Node(@"AXLink", [NSString stringWithFormat:@"Product %lu", (unsigned long)i + 1], tile)];
        [card addChild:Text([NSString stringWithFormat:@"$%lu.99", (unsigned long)i + 12], CGRectMake(tile.origin.x, CGRectGetMaxY(tile) - 16, 60, 14))];
    }
    [main addChild:Node(@"AXButton", @"Proceed to checkout", CGRectMake(800, 700, 160, 36))];
    return window;
}

/// A window Shabang cannot place: a couple of plain controls and nothing that says what kind of place it is.
static SBFakeAXNode *PlainWindow(void) {
    SBFakeAXNode *window = Node(@"AXWindow", @"", CGRectMake(0, 0, 600, 400));
    SBFakeAXNode *group = [window addChild:Node(@"AXGroup", nil, CGRectMake(0, 0, 600, 400))];
    SBFakeAXNode *search = [group addChild:Node(@"AXTextField", nil, CGRectMake(20, 20, 300, 24))];
    search.placeholder = @"Search";
    [group addChild:Node(@"AXButton", @"Inspector", CGRectMake(400, 20, 100, 24))];
    return window;
}

static SBNextAction *Engine(SBRoleMemoryStore *memory) {
    return [[SBNextAction alloc] initWithCore:Core() memory:memory];
}

static SBRoleMemoryStore *TempMemory(void) {
    NSString *path = [SBTestTempDirectory() stringByAppendingPathComponent:@"memory.json"];
    return [[SBRoleMemoryStore alloc] initWithPath:path core:Core()];
}

static SBNextProposal *ProposalFor(SBNextAction *engine, SBFakeAXNode *window, SBPageSignals *signals) {
    SBCaptureResult *result = [Capture() captureWindow:window];
    return [engine proposeForResult:result window:window signals:signals];
}

static SBNextProposal *RankedRole(SBNextAction *engine, NSString *role) {
    for (SBNextProposal *proposal in engine.ranked) if ([proposal.role isEqualToString:role]) return proposal;
    return nil;
}

#pragma mark - capture: the extra signals

GH_TEST(anywhere_capture_keeps_icon_only_controls_only_when_asked) {
    SBAnywhereSafety *safety = [[SBAnywhereSafety alloc] init];
    safety.core = Core();
    SBCapture *strict = [[SBCapture alloc] initWithSafety:safety];
    SBCaptureResult *without = [strict captureWindow:PlayerWindow(YES, NO)];
    GH_ASSERT_EQUAL_INT(without.fields.count, 0);   // nothing at all: the form walk can do nothing with a glyph

    SBCaptureResult *with = [Capture() captureWindow:PlayerWindow(YES, NO)];
    NSUInteger unnamed = 0;
    for (SBField *field in with.fields) if (field.unnamed) unnamed++;
    GH_ASSERT_EQUAL_INT(unnamed, 3);
    for (SBField *field in with.fields) {
        if (!field.unnamed) continue;
        GH_ASSERT_EQUAL_INT(field.label.length, 0);
        GH_ASSERT(field.identifier.length > 0);
    }
}

GH_TEST(anywhere_capture_marks_controls_inside_a_media_cluster) {
    // A capture of one tree annotated against ANOTHER tree annotates nothing: a hint is only ever a fact about
    // the very nodes the capture came from.
    SBCaptureResult *stale = [Capture() captureWindow:PlayerWindow(YES, NO)];
    [SBAffordance annotateResult:stale window:PlayerWindow(YES, NO)];
    for (SBField *field in stale.fields) GH_ASSERT_FALSE(field.insideMediaControls);

    SBFakeAXNode *window = PlayerWindow(YES, NO);
    SBCaptureResult *result = [Capture() captureWindow:window];
    SBPageSignals *signals = [SBAffordance annotateResult:result window:window];
    GH_ASSERT(signals.hasMediaElement);
    GH_ASSERT_FALSE(signals.isFullscreen);
    for (SBField *field in result.fields) GH_ASSERT_MSG(field.insideMediaControls, @"%@ is in the player's bar", field.signature);
}

GH_TEST(anywhere_capture_sees_a_video_that_already_fills_the_window) {
    SBFakeAXNode *window = PlayerWindow(YES, YES);
    SBCaptureResult *result = [Capture() captureWindow:window];
    SBPageSignals *signals = [SBAffordance annotateResult:result window:window];
    GH_ASSERT(signals.isFullscreen);
}

GH_TEST(anywhere_capture_finds_the_main_list_and_not_the_navigation_bar) {
    SBFakeAXNode *window = GridWindow();
    SBCaptureResult *result = [Capture() captureWindow:window];
    SBPageSignals *signals = [SBAffordance annotateResult:result window:window];
    GH_ASSERT_EQUAL_INT(signals.mainRegionRepeats, 6);
    GH_ASSERT(signals.mainListSignature.length > 0);

    // The navigation bar is not a list at all now, which is the stronger version of what this test always
    // meant. Its items are 70 x 24; the grid's tiles are 300 x 220. A thing you OPEN is drawn at a size
    // somebody would aim a whole click at, and a row of small controls is a toolbar. Measured in a chat
    // client, where the compose bar's three icon buttons formed a "list" whose first member then outranked
    // every conversation in the window.
    NSMutableSet<NSString *> *lists = [NSMutableSet set];
    for (SBField *field in result.fields) if (field.listSignature) [lists addObject:field.listSignature];
    GH_ASSERT_EQUAL_INT(lists.count, 1);
    GH_ASSERT([lists containsObject:signals.mainListSignature]);

    NSUInteger inMain = 0;
    for (SBField *field in result.fields) if ([field.listSignature isEqualToString:signals.mainListSignature]) inMain++;
    GH_ASSERT_EQUAL_INT(inMain, 6);
}

GH_TEST(anywhere_capture_reads_a_badge_and_a_price_without_keeping_the_text) {
    SBFakeAXNode *window = ShopWindow(2);
    SBCaptureResult *result = [Capture() captureWindow:window];
    [SBAffordance annotateResult:result window:window];
    SBField *cart = nil;
    NSUInteger priced = 0;
    for (SBField *field in result.fields) {
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
    SBFakeAXNode *window = Node(@"AXWindow", @"", CGRectMake(0, 0, 800, 900));
    SBFakeAXNode *article = [window addChild:Node(@"AXGroup", nil, CGRectMake(0, 0, 800, 900))];
    for (NSUInteger i = 0; i < 12; i++) {
        NSString *paragraph = [@"" stringByPaddingToLength:400 withString:@"a sentence that goes on " startingAtIndex:0];
        [article addChild:Text(paragraph, CGRectMake(20, 20 + 60 * i, 760, 50))];
    }
    [article addChild:Node(@"AXButton", @"Share", CGRectMake(700, 860, 80, 24))];
    SBCaptureResult *result = [Capture() captureWindow:window];
    SBPageSignals *signals = [SBAffordance annotateResult:result window:window];
    GH_ASSERT_MSG(signals.textDensity > 0.6, @"a page of prose is dense, got %g", signals.textDensity);

    SBPageSignals *grid = [SBAffordance annotateResult:[Capture() captureWindow:GridWindow()] window:GridWindow()];
    GH_ASSERT_MSG(grid.textDensity < 0.6, @"a grid of controls is not prose, got %g", grid.textDensity);
}

GH_TEST(anywhere_price_and_duration_and_badge_patterns_are_currency_agnostic) {
    GH_ASSERT([SBAffordance looksLikePrice:@"$12.99"]);
    GH_ASSERT([SBAffordance looksLikePrice:@"€ 9,50"]);
    GH_ASSERT([SBAffordance looksLikePrice:@"1299 JPY"]);
    GH_ASSERT([SBAffordance looksLikePrice:@"₹ 499"]);
    GH_ASSERT_FALSE([SBAffordance looksLikePrice:@"12 items"]);
    GH_ASSERT_FALSE([SBAffordance looksLikePrice:@"2026"]);
    GH_ASSERT([SBAffordance looksLikeDuration:@"0:42"]);
    GH_ASSERT([SBAffordance looksLikeDuration:@"1:03:11"]);
    GH_ASSERT_FALSE([SBAffordance looksLikeDuration:@"12:99"]);
    GH_ASSERT_EQUAL_INT([SBAffordance countInBadgeText:@"3"], 3);
    GH_ASSERT_EQUAL_INT([SBAffordance countInBadgeText:@"12 items"], 12);
    GH_ASSERT_EQUAL_INT([SBAffordance countInBadgeText:@"2026"], 0);
    GH_ASSERT_EQUAL_INT([SBAffordance countInBadgeText:@"$4"], 0);
}

#pragma mark - the proposal

GH_TEST(anywhere_playing_video_is_offered_fullscreen) {
    SBNextAction *engine = Engine(TempMemory());
    SBNextProposal *top = ProposalFor(engine, PlayerWindow(YES, NO), nil);
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
    SBNextAction *engine = Engine(TempMemory());
    SBNextProposal *top = ProposalFor(engine, PlayerWindow(NO, NO), nil);
    GH_ASSERT(top != nil);
    GH_ASSERT_EQUAL_OBJECTS(top.role, @"play");
}

GH_TEST(anywhere_a_video_already_fullscreen_is_never_offered_fullscreen_again) {
    // docs/always-propose.md: a window with controls on it always gets a proposal. What the gate decides is how
    // it LOOKS. Someone already watching fullscreen is not offered fullscreen a second time (the classic wrong
    // ghost); what is left is a dim guess they ignore with one keystroke.
    SBNextAction *engine = Engine(TempMemory());
    SBNextProposal *top = ProposalFor(engine, PlayerWindow(YES, YES), nil);
    GH_ASSERT_MSG(top != nil, @"a window with controls always proposes something");
    GH_ASSERT_MSG(![top.role isEqualToString:@"fullscreen"], @"already fullscreen: proposing it again is the wrong ghost");
    GH_ASSERT_MSG(top.guess, @"below the gate it is drawn as a guess, not withheld");
    GH_ASSERT(top.confidence < engine.threshold);
    GH_ASSERT_FALSE(top.locked);
}

GH_TEST(anywhere_grid_window_offers_the_first_item) {
    SBNextAction *engine = Engine(TempMemory());
    SBFakeAXNode *window = GridWindow();
    SBCaptureResult *result = [Capture() captureWindow:window];
    SBNextProposal *top = [engine proposeForResult:result window:window signals:nil];
    GH_ASSERT(top != nil);
    GH_ASSERT_EQUAL_OBJECTS(engine.pageKind, @"feed");
    GH_ASSERT_EQUAL_OBJECTS(top.role, @"primary-item");
    SBField *chosen = nil;
    for (SBField *field in result.fields) if ([field.signature isEqualToString:top.signature]) chosen = field;
    GH_ASSERT(chosen != nil);
    GH_ASSERT_EQUAL_OBJECTS(chosen.label, @"Item number 1");   // the FIRST item, not a navigation entry
}

GH_TEST(anywhere_never_offers_the_heading_a_list_leads_with) {
    // Measured live before this existed: a notes list put "Pinned" at the top of its own list and Shabang proposed
    // it, top of the window. A heading names the rows under it; pressing one does nothing at all.
    SBNextAction *engine = Engine(TempMemory());
    SBFakeAXNode *window = GridWindowLedByAHeading();
    SBCaptureResult *result = [Capture() captureWindow:window];
    SBNextProposal *top = [engine proposeForResult:result window:window signals:nil];
    GH_ASSERT(top != nil);
    SBField *chosen = nil;
    for (SBField *field in result.fields) if ([field.signature isEqualToString:top.signature]) chosen = field;
    GH_ASSERT(chosen != nil);
    GH_ASSERT_MSG(![chosen.label isEqualToString:@"Today"], @"a heading is not something to press");
    GH_ASSERT_MSG(![top.role isEqualToString:@"section"], @"a heading can never be the proposal");
    GH_ASSERT_EQUAL_OBJECTS(top.role, @"primary-item");
    GH_ASSERT_EQUAL_OBJECTS(chosen.label, @"Item number 1");
}

GH_TEST(anywhere_shop_with_a_full_cart_offers_the_cart_and_locks_checkout) {
    SBNextAction *engine = Engine(TempMemory());
    SBNextProposal *top = ProposalFor(engine, ShopWindow(2), nil);
    GH_ASSERT(top != nil);
    GH_ASSERT_EQUAL_OBJECTS(engine.pageKind, @"commerce");
    GH_ASSERT_EQUAL_OBJECTS(top.role, @"cart");
    GH_ASSERT_FALSE(top.locked);

    SBNextProposal *checkout = RankedRole(engine, @"checkout");
    GH_ASSERT(checkout != nil);
    GH_ASSERT_MSG(checkout.locked, @"checkout is irreversible and must carry the lock");
    GH_ASSERT_MSG(![checkout.signature isEqualToString:top.signature], @"a locked control is never the proposal");
    // Rule 2 through the one rule that decides every Tab: a locked ghost is parked on, never pressed.
    SBGhost *ghost = [checkout ghostWithDisplayText:@"Proceed to checkout"];
    GH_ASSERT(ghost.locked);
    SBWalkSnapshot snapshot = { .active = YES, .hasCurrent = YES, .currentVisible = YES, .currentLocked = YES, .focusInWalk = YES };
    GH_ASSERT_EQUAL_INT(SBDecideTab(snapshot, SBKeyModifierNone, NO, NULL), SBKeyDecisionPark);
}

/// An empty cart used to send the shopper to the search box, and "it always goes to search on shopping
/// sites" was the result. A shopper still looking wants to look at a product; Shabang cannot know what anyone
/// is about to type, so a search box is the one thing it can never usefully offer.
GH_TEST(anywhere_empty_cart_offers_a_product_not_the_search_box) {
    SBNextAction *engine = Engine(TempMemory());
    SBNextProposal *top = ProposalFor(engine, ShopWindow(0), nil);
    GH_ASSERT(top != nil);
    GH_ASSERT_FALSE([top.role isEqualToString:@"search"]);
}

GH_TEST(anywhere_a_window_ghost_cannot_place_still_proposes_as_a_guess) {
    // The window Shabang has no idea about is exactly where silence used to happen, and exactly where the owner
    // noticed it: "it should just know what I'd click". The proposal exists; only the chip changes.
    SBNextAction *engine = Engine(TempMemory());
    SBNextProposal *top = ProposalFor(engine, PlainWindow(), nil);
    GH_ASSERT_MSG(top != nil, @"docs/always-propose.md: a place Shabang cannot name still gets a proposal");
    GH_ASSERT_EQUAL_OBJECTS(engine.pageKind, @"app");
    GH_ASSERT(top.confidence < 0.7);
    GH_ASSERT_MSG(top.guess, @"under the gate it is a guess");

    // The same row, with the user's gate lowered under it, is an ordinary ghost rather than a guess.
    SBNextAction *eager = Engine(TempMemory());
    eager.threshold = 0.5;
    SBNextProposal *confident = ProposalFor(eager, PlainWindow(), nil);
    GH_ASSERT(confident != nil);
    GH_ASSERT_EQUAL_OBJECTS(confident.role, top.role);
    GH_ASSERT_FALSE(confident.guess);
}

GH_TEST(anywhere_nothing_is_proposed_for_a_window_with_no_controls) {
    SBNextAction *engine = Engine(TempMemory());
    SBFakeAXNode *empty = Node(@"AXWindow", @"", CGRectMake(0, 0, 400, 300));
    GH_ASSERT(ProposalFor(engine, empty, nil) == nil);
}

GH_TEST(anywhere_signals_the_app_knows_win_over_the_tree) {
    SBNextAction *engine = Engine(TempMemory());
    SBPageSignals *signals = [[SBPageSignals alloc] init];
    signals.appBundleId = @"example.test.app";
    signals.pathPattern = @"/watch/:id";
    signals.isFullscreen = YES;
    SBNextProposal *top = ProposalFor(engine, PlayerWindow(YES, NO), signals);
    GH_ASSERT(top != nil);
    GH_ASSERT_MSG(![top.role isEqualToString:@"fullscreen"], @"the app said the video is already fullscreen");
    GH_ASSERT_EQUAL_OBJECTS(engine.lastSignals.appBundleId, @"example.test.app");
    GH_ASSERT_EQUAL_OBJECTS(engine.lastSignals.pathPattern, @"/watch/:id");
}

#pragma mark - role memory

GH_TEST(anywhere_two_accepts_change_the_order) {
    SBRoleMemoryStore *memory = TempMemory();
    SBNextAction *engine = Engine(memory);
    SBNextProposal *first = ProposalFor(engine, PlayerWindow(YES, NO), nil);
    GH_ASSERT_EQUAL_OBJECTS(first.role, @"fullscreen");

    SBNextProposal *captions = [[SBNextProposal alloc] init];
    captions.role = @"next";
    captions.pageKind = @"media";
    [engine recordOutcome:SBRoleOutcomeAccepted forProposal:captions];
    SBNextProposal *middle = ProposalFor(engine, PlayerWindow(YES, NO), nil);
    GH_ASSERT_MSG([middle.role isEqualToString:@"fullscreen"], @"one accept ties the strongest prior but does not reorder it");

    [engine recordOutcome:SBRoleOutcomeAccepted forProposal:captions];
    SBNextProposal *after = ProposalFor(engine, PlayerWindow(YES, NO), nil);
    GH_ASSERT_MSG([after.role isEqualToString:@"next"], @"twice is a habit: got %@", after.role);
    GH_ASSERT(after.confidence > 0.8);
    GH_ASSERT_EQUAL_OBJECTS(after.source, @"memory");
}

GH_TEST(anywhere_refusals_push_a_role_back_down) {
    SBRoleMemoryStore *memory = TempMemory();
    SBNextAction *engine = Engine(memory);
    SBNextProposal *fullscreen = [[SBNextProposal alloc] init];
    fullscreen.role = @"fullscreen";
    fullscreen.pageKind = @"media";
    for (int i = 0; i < 2; i++) [engine recordOutcome:SBRoleOutcomeDismissed forProposal:fullscreen];
    SBNextProposal *top = ProposalFor(engine, PlayerWindow(YES, NO), nil);
    GH_ASSERT_MSG(top == nil || ![top.role isEqualToString:@"fullscreen"], @"a role the user keeps refusing sinks");
}

GH_TEST(anywhere_memory_is_written_privately_and_survives_a_reload) {
    NSString *path = [SBTestTempDirectory() stringByAppendingPathComponent:@"memory.json"];
    SBRoleMemoryStore *memory = [[SBRoleMemoryStore alloc] initWithPath:path core:Core()];
    GH_ASSERT_EQUAL_INT(memory.snapshotJSON.length, 0);
    [memory record:@{ @"pageKind": @"media", @"role": @"fullscreen", @"previousRole": @"play" } outcome:SBRoleOutcomeAccepted];

    GH_ASSERT([NSFileManager.defaultManager fileExistsAtPath:path]);
    NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:path error:NULL];
    GH_ASSERT_EQUAL_INT([attributes[NSFilePosixPermissions] integerValue], 0600);

    SBRoleMemoryStore *reopened = [[SBRoleMemoryStore alloc] initWithPath:path core:Core()];
    NSDictionary *snapshot = SBJSONParse(reopened.snapshotJSON);
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
    NSString *path = [SBTestTempDirectory() stringByAppendingPathComponent:@"memory.json"];
    [@"{not json at all" writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    SBRoleMemoryStore *memory = [[SBRoleMemoryStore alloc] initWithPath:path core:Core()];
    SBNextAction *engine = Engine(memory);
    SBNextProposal *top = ProposalFor(engine, PlayerWindow(YES, NO), nil);
    GH_ASSERT_MSG(top != nil, @"a broken memory file must never stop Shabang from proposing");
    GH_ASSERT_EQUAL_OBJECTS(top.role, @"fullscreen");

    // And the next accept repairs the file rather than appending to the rubbish.
    [engine recordOutcome:SBRoleOutcomeAccepted forProposal:top];
    NSDictionary *snapshot = SBJSONParse([NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:NULL]);
    GH_ASSERT([snapshot[@"entries"] isKindOfClass:[NSArray class]]);
}

GH_TEST(anywhere_an_unknown_role_is_never_recorded) {
    NSString *path = [SBTestTempDirectory() stringByAppendingPathComponent:@"memory.json"];
    SBRoleMemoryStore *memory = [[SBRoleMemoryStore alloc] initWithPath:path core:Core()];
    SBNextAction *engine = Engine(memory);
    SBNextProposal *nothing = [[SBNextProposal alloc] init];   // role "unknown"
    [engine recordOutcome:SBRoleOutcomeAccepted forProposal:nothing];
    [engine recordOutcome:SBRoleOutcomeAccepted forProposal:nil];
    GH_ASSERT_FALSE([NSFileManager.defaultManager fileExistsAtPath:path]);
}

#pragma mark - the ghost the walk gets

GH_TEST(anywhere_proposal_becomes_a_click_ghost_the_walk_can_take) {
    SBNextAction *engine = Engine(TempMemory());
    SBFakeAXNode *window = PlayerWindow(YES, NO);
    SBCaptureResult *result = [Capture() captureWindow:window];
    SBNextProposal *top = [engine proposeForResult:result window:window signals:nil];
    GH_ASSERT(top != nil);
    SBGhost *ghost = [top ghostWithDisplayText:@"Fullscreen"];
    GH_ASSERT_EQUAL_OBJECTS(ghost.action, SBGhostActionClick);
    GH_ASSERT_EQUAL_OBJECTS(ghost.signature, top.signature);
    GH_ASSERT_FALSE(ghost.locked);
    GH_ASSERT(ghost.value == nil);   // a click ghost never carries a value

    SBWalkState *walk = [[SBWalkState alloc] init];
    [walk rescanWithGhosts:@[ ghost ]];
    GH_ASSERT_EQUAL_OBJECTS(walk.current.signature, top.signature);
    SBHoldState hold = { .walking = NO, .halted = NO };
    GH_ASSERT([walk shouldConsumeTabWithModifiers:SBKeyModifierNone isRepeat:NO focusSignature:nil currentVisible:YES hold:&hold]);
    [walk dismiss:ghost.signature];
    GH_ASSERT(walk.current == nil);   // Escape leaves nothing behind
}

GH_TEST(anywhere_the_proposal_always_names_a_control_of_this_capture) {
    SBNextAction *engine = Engine(TempMemory());
    SBFakeAXNode *window = ShopWindow(2);
    SBCaptureResult *result = [Capture() captureWindow:window];
    SBNextProposal *top = [engine proposeForResult:result window:window signals:nil];
    GH_ASSERT(top != nil);
    GH_ASSERT_MSG([result nodeForSignature:top.signature] != nil, @"a proposal Shabang cannot reach is no proposal");
    for (SBNextProposal *row in engine.ranked) GH_ASSERT([result nodeForSignature:row.signature] != nil);
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

static SBVision *Vision(NSMutableArray<NSURLRequest *> *sent, NSString *replyJSON) {
    SBVision *vision = [[SBVision alloc] initWithBaseURLString:@"http://127.0.0.1:8787"];
    vision.screenshot = ^CGImageRef(CGRect rect) { return PixelImage(); };
    vision.transport = ^(NSURLRequest *request, void (^done)(NSData *, NSInteger)) {
        [sent addObject:request];
        done([replyJSON dataUsingEncoding:NSUTF8StringEncoding], 200);
    };
    return vision;
}

static NSArray<SBVisionBox *> *GlyphBoxes(void) {
    return @[
        [SBVisionBox boxWithSignature:@"AXButton||0" rect:CGRectMake(10, 405, 36, 36)],
        [SBVisionBox boxWithSignature:@"AXButton||1" rect:CGRectMake(750, 405, 36, 36)],
    ];
}

GH_TEST(anywhere_vision_only_crops_controls_nothing_could_name) {
    SBFakeAXNode *window = PlayerWindow(YES, NO);
    SBCaptureResult *result = [Capture() captureWindow:window];
    SBNextAction *engine = Engine(TempMemory());
    [engine proposeForResult:result window:window signals:nil];
    // The player's glyphs DO resolve from their identifiers, so there is nothing for the model to do here.
    GH_ASSERT_EQUAL_INT([SBVision boxesForFields:result.fields unnamed:engine.unnamedSignatures sensitiveOnScreen:NO].count, 0);

    SBField *mystery = [SBField fieldWithSignature:@"AXButton||9" label:@"" kind:SBKindButton];
    mystery.unnamed = YES;
    mystery.rect = CGRectMake(40, 40, 32, 32);
    NSArray<SBVisionBox *> *boxes = [SBVision boxesForFields:@[ mystery ] unnamed:@[ @"AXButton||9" ] sensitiveOnScreen:NO];
    GH_ASSERT_EQUAL_INT(boxes.count, 1);
    GH_ASSERT_EQUAL_OBJECTS(boxes.firstObject.signature, @"AXButton||9");
}

GH_TEST(anywhere_vision_refuses_a_window_with_a_sensitive_field_on_screen) {
    SBField *glyph = [SBField fieldWithSignature:@"AXButton||9" label:@"" kind:SBKindButton];
    glyph.rect = CGRectMake(40, 40, 32, 32);
    NSArray<SBVisionBox *> *boxes = [SBVision boxesForFields:@[ glyph ] unnamed:@[ @"AXButton||9" ] sensitiveOnScreen:YES];
    GH_ASSERT_MSG(boxes.count == 0, @"not one pixel of a window with a password on screen");
}

GH_TEST(anywhere_vision_skips_controls_too_small_or_too_large_to_be_controls) {
    SBField *speck = [SBField fieldWithSignature:@"a" label:@"" kind:SBKindButton];
    speck.rect = CGRectMake(0, 0, 4, 4);
    SBField *region = [SBField fieldWithSignature:@"b" label:@"" kind:SBKindButton];
    region.rect = CGRectMake(0, 0, 900, 700);
    SBField *control = [SBField fieldWithSignature:@"c" label:@"" kind:SBKindButton];
    control.rect = CGRectMake(0, 0, 36, 36);
    NSArray<SBVisionBox *> *boxes = [SBVision boxesForFields:@[ speck, region, control ] unnamed:(@[ @"a", @"b", @"c" ]) sensitiveOnScreen:NO];
    GH_ASSERT_EQUAL_INT(boxes.count, 1);
    GH_ASSERT_EQUAL_OBJECTS(boxes.firstObject.signature, @"c");
}

GH_TEST(anywhere_vision_says_when_screen_recording_is_missing) {
    SBVision *vision = [[SBVision alloc] initWithBaseURLString:nil];
    // No screenshot block and (in the test runner) no permission: the fallback reports itself unavailable and
    // nothing is captured or sent.
    if (vision.screenRecordingAllowed) return;   // a machine that HAS granted it: nothing to prove here
    GH_ASSERT_EQUAL_OBJECTS(vision.unavailableReason, SBVisionReasonScreenRecording);
    __block NSString *reason = nil;
    __block NSUInteger answered = 0;
    [vision labelBoxes:GlyphBoxes() pageKey:@"p1" completion:^(NSDictionary *labels, NSSet *locked, NSString *why) {
        reason = why;
        answered = labels.count;
    }];
    GH_ASSERT(SBTestWaitUntil(1.0, ^BOOL { return reason != nil; }));
    GH_ASSERT_EQUAL_OBJECTS(reason, SBVisionReasonScreenRecording);
    GH_ASSERT_EQUAL_INT(answered, 0);
    GH_ASSERT_EQUAL_INT(vision.calls, 0);
}

GH_TEST(anywhere_vision_names_icons_once_per_page_and_then_from_the_cache) {
    NSMutableArray<NSURLRequest *> *sent = [NSMutableArray array];
    NSString *reply = @"{\"labels\":[{\"id\":\"AXButton||0\",\"label\":\"Play\",\"role\":\"button\",\"affordance\":\"play\",\"irreversible\":false,\"sensitive\":false,\"confidence\":0.94},"
                       "{\"id\":\"AXButton||1\",\"label\":\"Fullscreen\",\"role\":\"button\",\"affordance\":\"fullscreen\",\"irreversible\":false,\"sensitive\":false,\"confidence\":0.91}]}";
    SBVision *vision = Vision(sent, reply);

    __block NSDictionary<NSString *, NSString *> *labels = nil;
    [vision labelBoxes:GlyphBoxes() pageKey:@"p1" completion:^(NSDictionary *got, NSSet *locked, NSString *why) { labels = got; }];
    GH_ASSERT(SBTestWaitUntil(1.0, ^BOOL { return labels != nil; }));
    GH_ASSERT_EQUAL_INT(labels.count, 2);
    GH_ASSERT_EQUAL_OBJECTS(labels[@"AXButton||0"], @"Play");
    GH_ASSERT_EQUAL_OBJECTS(labels[@"AXButton||1"], @"Fullscreen");
    GH_ASSERT_EQUAL_INT(sent.count, 1);

    // The request carries the strip and the boxes, and NOTHING else: no window title, no page text, no app name.
    NSDictionary *body = SBJSONParse([[NSString alloc] initWithData:sent.firstObject.HTTPBody encoding:NSUTF8StringEncoding]);
    GH_ASSERT_EQUAL_INT(body.count, 2);
    GH_ASSERT([body[@"image"] hasPrefix:@"data:image/png;base64,"]);
    GH_ASSERT_EQUAL_INT([body[@"boxes"] count], 2);
    GH_ASSERT(body[@"context"] == nil);
    GH_ASSERT(body[@"page"] == nil);

    // Second look at the same page: answered from the cache, no second call.
    labels = nil;
    [vision labelBoxes:GlyphBoxes() pageKey:@"p1" completion:^(NSDictionary *got, NSSet *locked, NSString *why) { labels = got; }];
    GH_ASSERT(SBTestWaitUntil(1.0, ^BOOL { return labels != nil; }));
    GH_ASSERT_EQUAL_INT(sent.count, 1);
    GH_ASSERT_EQUAL_INT(vision.cacheHits, 1);
    GH_ASSERT_EQUAL_INT(labels.count, 2);
}

GH_TEST(anywhere_vision_one_call_per_page_view_even_when_the_controls_move) {
    NSMutableArray<NSURLRequest *> *sent = [NSMutableArray array];
    SBVision *vision = Vision(sent, @"{\"labels\":[]}");
    [vision labelBoxes:GlyphBoxes() pageKey:@"p1" completion:^(NSDictionary *l, NSSet *k, NSString *w) {}];
    NSArray<SBVisionBox *> *moved = @[ [SBVisionBox boxWithSignature:@"AXButton||0" rect:CGRectMake(10, 500, 36, 36)] ];
    [vision labelBoxes:moved pageKey:@"p1" completion:^(NSDictionary *l, NSSet *k, NSString *w) {}];
    GH_ASSERT(SBTestWaitUntil(1.0, ^BOOL { return sent.count >= 1; }));
    GH_ASSERT_EQUAL_INT(sent.count, 1);

    [vision forgetPage];   // a new page view
    [vision labelBoxes:moved pageKey:@"p1" completion:^(NSDictionary *l, NSSet *k, NSString *w) {}];
    GH_ASSERT(SBTestWaitUntil(1.0, ^BOOL { return sent.count >= 2; }));
    GH_ASSERT_EQUAL_INT(sent.count, 2);
}

GH_TEST(anywhere_vision_locks_what_it_must_and_drops_what_it_may_not_name) {
    NSString *reply = @"{\"labels\":[{\"id\":\"a\",\"label\":\"Place order\",\"role\":\"button\",\"irreversible\":true,\"sensitive\":false,\"confidence\":0.9},"
                       "{\"id\":\"b\",\"label\":\"Card number\",\"role\":\"field\",\"irreversible\":false,\"sensitive\":true,\"confidence\":0.9},"
                       "{\"id\":\"c\",\"label\":null,\"role\":\"other\",\"irreversible\":false,\"sensitive\":false,\"confidence\":0}]}";
    NSMutableSet<NSString *> *locked = [NSMutableSet set];
    NSDictionary<NSString *, NSString *> *labels = [SBVision labelsFromReply:SBJSONParse(reply) locked:locked];
    GH_ASSERT_EQUAL_INT(labels.count, 1);
    GH_ASSERT_EQUAL_OBJECTS(labels[@"a"], @"Place order");
    GH_ASSERT([locked containsObject:@"a"]);
    GH_ASSERT_MSG(labels[@"b"] == nil, @"a sensitive control is never named, never drawn, never filled");
    GH_ASSERT_MSG(labels[@"c"] == nil, @"a box the model could not read stays unnamed");

    // Rubbish is simply no labels.
    GH_ASSERT_EQUAL_INT([SBVision labelsFromReply:@"not a reply" locked:locked].count, 0);
    GH_ASSERT_EQUAL_INT([SBVision labelsFromReply:nil locked:locked].count, 0);
}

GH_TEST(anywhere_vision_cache_key_changes_when_a_control_moves) {
    NSString *before = [SBVision cacheKeyForPage:@"p1" boxes:GlyphBoxes()];
    NSArray<SBVisionBox *> *moved = @[ GlyphBoxes().firstObject, [SBVisionBox boxWithSignature:@"AXButton||1" rect:CGRectMake(751, 405, 36, 36)] ];
    GH_ASSERT_FALSE([before isEqualToString:[SBVision cacheKeyForPage:@"p1" boxes:moved]]);
    GH_ASSERT_FALSE([before isEqualToString:[SBVision cacheKeyForPage:@"p2" boxes:GlyphBoxes()]]);
    GH_ASSERT_EQUAL_OBJECTS(before, [SBVision cacheKeyForPage:@"p1" boxes:GlyphBoxes()]);
}

#pragma mark - the one press (rule 2 at the writer)

/// The smallest actuator that can answer a press. Everything else refuses, so a test can only ever prove the
/// press path; nothing here can type, fill or drive a panel.
@interface SBPressOnlyActuator : NSObject <SBAXActuating>
@property (nonatomic) NSUInteger presses;
@property (nonatomic) NSUInteger clicks;
@property (nonatomic) NSUInteger opens;
/// NO makes this element one of the many that publish no AXPress at all, so the writer must click it.
@property (nonatomic) BOOL publishesPress;
@end

@implementation SBPressOnlyActuator
- (instancetype)init { if ((self = [super init])) _publishesPress = YES; return self; }
- (id<SBAXNode>)refreshedNode:(id<SBAXNode>)node { return node; }
- (BOOL)focusNode:(id<SBAXNode>)node { return YES; }
- (BOOL)setValue:(NSString *)value ofNode:(id<SBAXNode>)node { return NO; }
- (BOOL)selectAllInNode:(id<SBAXNode>)node { return NO; }
- (BOOL)replaceSelectionWithText:(NSString *)text inNode:(id<SBAXNode>)node { return NO; }
- (BOOL)typeText:(NSString *)text intoNode:(id<SBAXNode>)node { return NO; }
- (BOOL)pressNode:(id<SBAXNode>)node { self.presses++; return YES; }
- (BOOL)nodeAcceptsPress:(id<SBAXNode>)node { return self.publishesPress; }
- (BOOL)pressIsTrustworthyForNode:(id<SBAXNode>)node { return YES; }
- (BOOL)clickNode:(id<SBAXNode>)node { self.clicks++; return YES; }
- (BOOL)openNode:(id<SBAXNode>)node { self.opens++; return YES; }
- (BOOL)dismissMenuOfPopup:(id<SBAXNode>)popup stillWanted:(BOOL (^)(void))stillWanted { return NO; }
- (BOOL)scrollToVisible:(id<SBAXNode>)node { return NO; }
@end

static SBWriteResult *WriteClick(SBWriter *writer, SBGhost *ghost, SBField *field, id<SBAXNode> node) {
    __block SBWriteResult *result = nil;
    [writer executeGhost:ghost field:field node:node optionNode:nil completion:^(SBWriteResult *got) { result = got; }];
    SBTestWaitUntil(1.0, ^BOOL { return result != nil; });
    return result;
}

GH_TEST(anywhere_an_unlocked_proposal_is_pressed_exactly_once_and_only_with_a_live_lock_check) {
    SBFakeAXNode *node = Node(@"AXButton", @"Full screen", CGRectMake(750, 405, 36, 36));
    SBField *field = [SBField fieldWithSignature:@"AXButton|full|0" label:@"Full screen" kind:SBKindButton];
    field.rect = node.frame;
    SBGhost *ghost = [[SBGhost alloc] init];
    ghost.signature = field.signature;
    ghost.action = SBGhostActionClick;
    ghost.displayText = field.label;
    ghost.confidence = 0.7;

    SBPressOnlyActuator *actuator = [[SBPressOnlyActuator alloc] init];
    SBWriter *writer = [[SBWriter alloc] initWithActuator:actuator];
    writer.isNodeSensitive = ^BOOL(id<SBAXNode> n) { return NO; };
    writer.after = ^(NSTimeInterval delay, dispatch_block_t block) { block(); };

    // No lock check: nothing is pressed, ever. The form walk's own click ghost is the locked Submit.
    SBWriteResult *refused = WriteClick(writer, ghost, field, node);
    GH_ASSERT_FALSE(refused.ok);
    GH_ASSERT_EQUAL_OBJECTS(refused.reason, SBWriteReasonLocked);
    GH_ASSERT_EQUAL_INT(actuator.presses, 0);

    // A check that says "irreversible after all": still nothing pressed.
    writer.isNodeLocked = ^BOOL(id<SBAXNode> n) { return YES; };
    SBWriteResult *locked = WriteClick(writer, ghost, field, node);
    GH_ASSERT_FALSE(locked.ok);
    GH_ASSERT_EQUAL_OBJECTS(locked.reason, SBWriteReasonLocked);
    GH_ASSERT_EQUAL_INT(actuator.presses, 0);

    // A plainly reversible control: one press, and the result says so.
    writer.isNodeLocked = ^BOOL(id<SBAXNode> n) { return NO; };
    SBWriteResult *pressed = WriteClick(writer, ghost, field, node);
    GH_ASSERT(pressed.ok);
    GH_ASSERT_EQUAL_OBJECTS(pressed.method, SBWriteMethodPress);
    GH_ASSERT_EQUAL_INT(actuator.presses, 1);

    // A ghost the core locked, or a control capture locked, is refused before the check is even asked.
    ghost.locked = YES;
    GH_ASSERT_EQUAL_OBJECTS(WriteClick(writer, ghost, field, node).reason, SBWriteReasonLocked);
    ghost.locked = NO;
    field.locked = YES;
    GH_ASSERT_EQUAL_OBJECTS(WriteClick(writer, ghost, field, node).reason, SBWriteReasonLocked);
    GH_ASSERT_EQUAL_INT(actuator.presses, 1);
}

/// A proposal carries no value, so its display text is the control's own name. That names an ACTION on a
/// button ("Play") and is the placeholder on anything you interact with by value, which is how a search box
/// saying "Search" got a ghost saying "Search" beside it. Shown here for the kind that survived the first
/// attempt at this: a search box WITH A DROPDOWN is a combobox, not a text field.
GH_TEST(anywhere_only_a_control_whose_name_is_an_action_shows_it) {
    NSArray<NSString *> *silent = @[ SBKindText, SBKindTextArea, SBKindSelect, SBKindCheckbox, SBKindRadio ];
    for (NSString *kind in silent) {
        SBField *field = [SBField fieldWithSignature:@"s|0" label:@"Search" kind:kind];
        GH_ASSERT_MSG(SBProposalDisplayText(field).length == 0, @"%@ must say nothing", kind);
    }
    for (NSString *kind in @[ SBKindButton, SBKindLink, SBKindItem ]) {
        SBField *field = [SBField fieldWithSignature:@"a|0" label:@"Play" kind:kind];
        GH_ASSERT_EQUAL_OBJECTS(SBProposalDisplayText(field), @"Play");
    }
}

/// A chat app opening a new message puts the cursor in `To`, and Shabang used to offer that box back: press to
/// move the cursor to where the cursor is. Worse, the step after it -- knowing who to write to -- is the one
/// thing Shabang cannot help with at all, so the whole chain ended in a shrug.
GH_TEST(anywhere_the_box_the_cursor_is_already_in_is_not_an_action) {
    SBFakeAXNode *node = Node(@"AXTextField", @"To", CGRectMake(300, 40, 600, 28));
    SBField *field = [SBField fieldWithSignature:@"ax|AXTextField|to|0" label:@"To" kind:SBKindText];
    field.rect = node.frame;
    field.focused = YES;

    SBCaptureResult *result = [[SBCaptureResult alloc] init];
    [result setValue:@[ field ] forKey:@"fields"];
    [result setValue:@{ field.signature: node } forKey:@"nodes"];

    SBNextAction *engine = [[SBNextAction alloc] initWithCore:[SBCore sharedCore] memory:nil];
    SBNextProposal *proposal = [engine proposeForResult:result window:node signals:nil];
    // Whatever the ranking says, a focused empty box is never handed back as something to press.
    GH_ASSERT(proposal == nil || ![proposal.signature isEqualToString:field.signature]);

    // The same box, NOT focused, is an ordinary offer again: putting the cursor there is a real action.
    field.focused = NO;
    SBNextProposal *unfocused = [engine proposeForResult:result window:node signals:nil];
    (void)unfocused;   // the ranking decides whether it wins; the point is that it is no longer refused
}

/// "Pick, never generate." A box with the app's own answers listed under it does not want a cursor in it --
/// nobody types a name they can see. Measured as the bug: a search box whose placeholder said "Go to file"
/// got a ghost that said "Go to file", because a proposal's display text names its control and a search
/// box's name IS its placeholder.
GH_TEST(anywhere_a_box_with_the_answers_under_it_is_not_the_proposal) {
    SBCaptureResult *result = [[SBCaptureResult alloc] init];
    SBField *box = [SBField fieldWithSignature:@"ax|AXTextField|goto|0" label:@"Go to file" kind:SBKindText];
    box.rect = CGRectMake(300, 100, 400, 32);
    box.focused = YES;
    NSMutableArray<SBField *> *fields = [NSMutableArray arrayWithObject:box];
    for (NSUInteger i = 0; i < 3; i++) {
        SBField *row = [SBField fieldWithSignature:[NSString stringWithFormat:@"ax|AXRow|r%lu|0", (unsigned long)i]
                                             label:[NSString stringWithFormat:@"File %lu.ts", (unsigned long)i] kind:SBKindItem];
        row.rect = CGRectMake(300, (CGFloat)(140 + i * 28), 400, 26);
        [fields addObject:row];
    }
    [result setValue:fields forKey:@"fields"];
    GH_ASSERT([SBNextAction result:result showsCandidatesUnder:box.signature]);

    // A sidebar BESIDE the box is a different thing entirely, and so is a list far below it.
    SBCaptureResult *beside = [[SBCaptureResult alloc] init];
    NSMutableArray<SBField *> *other = [NSMutableArray arrayWithObject:box];
    for (NSUInteger i = 0; i < 3; i++) {
        SBField *row = [SBField fieldWithSignature:[NSString stringWithFormat:@"ax|AXRow|s%lu|0", (unsigned long)i]
                                             label:@"Sidebar" kind:SBKindItem];
        row.rect = CGRectMake(0, (CGFloat)(140 + i * 28), 280, 26);   // left of the box, no overlap
        [other addObject:row];
    }
    [beside setValue:other forKey:@"fields"];
    GH_ASSERT_FALSE([SBNextAction result:beside showsCandidatesUnder:box.signature]);

    // And a box with nothing under it keeps the cursor: there is simply nothing to pick from.
    SBCaptureResult *bare = [[SBCaptureResult alloc] init];
    [bare setValue:@[ box ] forKey:@"fields"];
    GH_ASSERT_FALSE([SBNextAction result:bare showsCandidatesUnder:box.signature]);
}

/// Most of the desktop does not implement AXPress: a Finder row, a Spotify tile, a Discord channel, anything
/// custom-drawn. Before this, `press` was the only actuation Shabang had, and on all of those the accept did
/// nothing at all -- and still reported ok, because kAXErrorCannotComplete was being counted as success.
GH_TEST(anywhere_a_control_that_does_not_implement_press_is_really_clicked) {
    SBFakeAXNode *node = Node(@"AXButton", @"Full screen", CGRectMake(0, 120, 300, 64));
    SBField *field = [SBField fieldWithSignature:@"AXButton|fullscreen|0" label:@"Full screen" kind:SBKindButton];
    field.rect = node.frame;
    SBGhost *ghost = [[SBGhost alloc] init];
    ghost.signature = field.signature;
    ghost.action = SBGhostActionClick;
    ghost.displayText = field.label;
    ghost.confidence = 0.8;

    SBPressOnlyActuator *actuator = [[SBPressOnlyActuator alloc] init];
    actuator.publishesPress = NO;   // the element lists no AXPress at all
    SBWriter *writer = [[SBWriter alloc] initWithActuator:actuator];
    writer.isNodeSensitive = ^BOOL(id<SBAXNode> n) { return NO; };
    writer.isNodeLocked = ^BOOL(id<SBAXNode> n) { return NO; };
    writer.after = ^(NSTimeInterval delay, dispatch_block_t block) { block(); };

    SBWriteResult *clicked = WriteClick(writer, ghost, field, node);
    GH_ASSERT(clicked.ok);
    GH_ASSERT_EQUAL_OBJECTS(clicked.method, SBWriteMethodClick);
    GH_ASSERT_EQUAL_INT(actuator.clicks, 1);
    GH_ASSERT_EQUAL_INT(actuator.presses, 0);   // never pressed something that cannot be pressed

    // And a locked control is still never touched, by either route.
    field.locked = YES;
    GH_ASSERT_EQUAL_OBJECTS(WriteClick(writer, ghost, field, node).reason, SBWriteReasonLocked);
    GH_ASSERT_EQUAL_INT(actuator.clicks, 1);
}

/// A row is not a button. AXPress on one SELECTS it: measured on Spotify, where pressing a playlist
/// highlighted it and opened nothing at all. Activating a row is an OPEN -- AXOpen, or a double click.
GH_TEST(anywhere_a_list_entry_is_opened_and_never_merely_pressed) {
    SBFakeAXNode *node = Node(@"AXRow", nil, CGRectMake(0, 120, 300, 64));
    SBField *field = [SBField fieldWithSignature:@"ax|AXRow|playlist|0" label:@"pre grrr" kind:SBKindItem];
    field.rect = node.frame;
    SBGhost *ghost = [[SBGhost alloc] init];
    ghost.signature = field.signature;
    ghost.action = SBGhostActionClick;
    ghost.displayText = field.label;

    SBPressOnlyActuator *actuator = [[SBPressOnlyActuator alloc] init];
    SBWriter *writer = [[SBWriter alloc] initWithActuator:actuator];
    writer.isNodeSensitive = ^BOOL(id<SBAXNode> n) { return NO; };
    writer.isNodeLocked = ^BOOL(id<SBAXNode> n) { return NO; };
    writer.after = ^(NSTimeInterval delay, dispatch_block_t block) { block(); };

    SBWriteResult *opened = WriteClick(writer, ghost, field, node);
    GH_ASSERT(opened.ok);
    GH_ASSERT_EQUAL_OBJECTS(opened.method, SBWriteMethodOpen);
    GH_ASSERT_EQUAL_INT(actuator.opens, 1);
    GH_ASSERT_EQUAL_INT(actuator.presses, 0);
    GH_ASSERT_EQUAL_INT(actuator.clicks, 0);

    // A locked row is refused before any of that.
    field.locked = YES;
    GH_ASSERT_EQUAL_OBJECTS(WriteClick(writer, ghost, field, node).reason, SBWriteReasonLocked);
    GH_ASSERT_EQUAL_INT(actuator.opens, 1);
}

/// The real click is the fallback, never the first choice: AXPress is the app's own default action, it needs
/// no pointer, and it cannot land on whatever happens to be under the mouse.
GH_TEST(anywhere_press_is_preferred_and_the_click_is_the_fallback) {
    SBFakeAXNode *node = Node(@"AXButton", @"Play", CGRectMake(700, 400, 36, 36));
    SBField *field = [SBField fieldWithSignature:@"AXButton|play|0" label:@"Play" kind:SBKindButton];
    field.rect = node.frame;
    SBGhost *ghost = [[SBGhost alloc] init];
    ghost.signature = field.signature;
    ghost.action = SBGhostActionClick;
    ghost.displayText = field.label;

    SBPressOnlyActuator *actuator = [[SBPressOnlyActuator alloc] init];
    SBWriter *writer = [[SBWriter alloc] initWithActuator:actuator];
    writer.isNodeSensitive = ^BOOL(id<SBAXNode> n) { return NO; };
    writer.isNodeLocked = ^BOOL(id<SBAXNode> n) { return NO; };
    writer.after = ^(NSTimeInterval delay, dispatch_block_t block) { block(); };

    SBWriteResult *pressed = WriteClick(writer, ghost, field, node);
    GH_ASSERT_EQUAL_OBJECTS(pressed.method, SBWriteMethodPress);
    GH_ASSERT_EQUAL_INT(actuator.presses, 1);
    GH_ASSERT_EQUAL_INT(actuator.clicks, 0);
}

GH_TEST(anywhere_a_search_box_proposal_moves_the_cursor_and_presses_nothing) {
    SBFakeAXNode *node = Node(@"AXTextField", nil, CGRectMake(200, 16, 500, 28));
    node.subrole = @"AXSearchField";
    node.placeholder = @"Search";
    SBField *field = [SBField fieldWithSignature:@"AXTextField|search|0" label:@"Search" kind:SBKindText];
    field.rect = node.frame;
    SBGhost *ghost = [[SBGhost alloc] init];
    ghost.signature = field.signature;
    ghost.action = SBGhostActionClick;
    ghost.displayText = @"Search";

    SBPressOnlyActuator *actuator = [[SBPressOnlyActuator alloc] init];
    SBWriter *writer = [[SBWriter alloc] initWithActuator:actuator];
    writer.isNodeSensitive = ^BOOL(id<SBAXNode> n) { return NO; };
    writer.isNodeLocked = ^BOOL(id<SBAXNode> n) { return NO; };
    writer.after = ^(NSTimeInterval delay, dispatch_block_t block) { block(); };

    SBWriteResult *result = WriteClick(writer, ghost, field, node);
    GH_ASSERT(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.method, SBWriteMethodFocus);
    GH_ASSERT_MSG(actuator.presses == 0, @"a text box is never pressed; the cursor going there is the whole action");
    GH_ASSERT_MSG(ghost.value == nil, @"and nothing is ever typed into it");
}

GH_TEST(anywhere_an_ordinary_form_field_is_never_proposed_as_a_click) {
    // A window whose only controls are ordinary fields: the form walk fills those. The next-action path must
    // not put a "Tab to click" cursor on a text box (and on this window it has nothing else to offer).
    SBFakeAXNode *window = Node(@"AXWindow", @"", CGRectMake(0, 0, 600, 400));
    SBFakeAXNode *group = [window addChild:Node(@"AXGroup", nil, CGRectMake(0, 0, 600, 400))];
    for (NSUInteger i = 0; i < 4; i++) {
        SBFakeAXNode *label = [group addChild:Text([NSString stringWithFormat:@"Detail %lu", (unsigned long)i + 1], CGRectMake(20, 20 + 40 * i, 120, 18))];
        (void)label;
        SBFakeAXNode *input = [group addChild:Node(@"AXTextField", [NSString stringWithFormat:@"Detail %lu", (unsigned long)i + 1], CGRectMake(150, 20 + 40 * i, 300, 24))];
        input.value = @"already filled";
    }
    SBNextAction *engine = Engine(TempMemory());
    SBNextProposal *top = ProposalFor(engine, window, nil);
    GH_ASSERT_MSG(top == nil, @"got %@", top);
    for (SBNextProposal *row in engine.ranked) GH_ASSERT_FALSE([row.role isEqualToString:@"field"]);
}

#pragma mark - always propose (docs/always-propose.md)

GH_TEST(anywhere_one_nameless_icon_is_still_a_proposal) {
    // The owner's complaint, in its smallest form: a window Shabang can say nothing about must still put the
    // cursor somewhere. One icon, no text anywhere, no page kind: propose it, as a guess.
    SBFakeAXNode *window = Node(@"AXWindow", @"", CGRectMake(0, 0, 500, 400));
    SBFakeAXNode *bar = [window addChild:Node(@"AXGroup", nil, CGRectMake(0, 0, 500, 44))];
    [bar addChild:Glyph(@"tool-a", CGRectMake(12, 6, 32, 32))];

    SBNextAction *engine = Engine(TempMemory());
    SBNextProposal *top = ProposalFor(engine, window, nil);
    GH_ASSERT_MSG(top != nil, @"silence is only right when there is nothing actionable at all");
    GH_ASSERT(top.guess);
    GH_ASSERT_FALSE(top.locked);
    GH_ASSERT_EQUAL_INT(engine.unnamedSignatures.count, 1);   // and this is what the vision fallback is for
}

GH_TEST(anywhere_a_window_whose_only_control_is_irreversible_proposes_it_locked) {
    // Proposing is not doing. The only thing on offer is irreversible, so it is proposed WITH its lock, and the
    // one rule that decides every accept key parks on it instead of pressing it.
    SBFakeAXNode *window = Node(@"AXWindow", @"", CGRectMake(0, 0, 400, 200));
    SBFakeAXNode *group = [window addChild:Node(@"AXGroup", nil, CGRectMake(0, 0, 400, 200))];
    [group addChild:Node(@"AXButton", @"Delete everything", CGRectMake(120, 80, 160, 32))];

    SBNextAction *engine = Engine(TempMemory());
    SBNextProposal *top = ProposalFor(engine, window, nil);
    GH_ASSERT(top != nil);
    GH_ASSERT_MSG(top.locked, @"an irreversible control keeps its lock even as the only proposal");
    SBWalkSnapshot snapshot = { .active = YES, .hasCurrent = YES, .currentVisible = YES, .currentLocked = YES, .focusInWalk = YES };
    GH_ASSERT_EQUAL_INT(SBDecideTab(snapshot, SBKeyModifierNone, NO, NULL), SBKeyDecisionPark);
}

GH_TEST(anywhere_a_confident_row_is_not_marked_a_guess) {
    // The chip is the only thing the gate controls, so the ordinary case must stay ordinary.
    SBNextAction *engine = Engine(TempMemory());
    SBNextProposal *top = ProposalFor(engine, PlayerWindow(YES, NO), nil);
    GH_ASSERT(top != nil);
    GH_ASSERT_EQUAL_OBJECTS(top.role, @"fullscreen");
    GH_ASSERT(top.confidence >= engine.threshold);
    GH_ASSERT_FALSE(top.guess);
}

GH_TEST(anywhere_every_ranked_row_carries_its_own_guess_flag) {
    SBNextAction *engine = Engine(TempMemory());
    SBNextProposal *top = ProposalFor(engine, ShopWindow(2), nil);
    GH_ASSERT(top != nil);
    GH_ASSERT(engine.ranked.count > 1);
    for (SBNextProposal *row in engine.ranked) {
        GH_ASSERT_EQUAL_INT(row.guess, row.confidence < engine.threshold);
    }
}
