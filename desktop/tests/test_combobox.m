// GHComboBoxDriver without a keyboard or AX: a fake react-select (Greenhouse style: label, live log, placeholder,
// input, "Toggle flyout", menu inserted right after it) reacts to the fake poster, and a hand-driven clock runs
// every wait. Only GHFakeKeyPoster is used: nothing here can post a real event.
#import "GHTest.h"
#import "GHComboBoxDriver.h"
#import "GHKeyPoster.h"

#pragma mark - fakes

/// A fake node that owns an ordered, editable child list (a menu is inserted after the toggle and removed again).
@interface GHCBNode : GHFakeAXNode
- (void)insert:(GHFakeAXNode *)child after:(nullable id<GHAXNode>)sibling;
- (void)remove:(GHFakeAXNode *)child;
- (BOOL)holds:(GHFakeAXNode *)child;
@end

@implementation GHCBNode {
    NSMutableArray<GHFakeAXNode *> *_items;
}
- (NSMutableArray<GHFakeAXNode *> *)items {
    if (!_items) _items = [NSMutableArray array];
    return _items;
}
- (NSArray<id<GHAXNode>> *)children { return [self.items copy]; }
- (GHFakeAXNode *)addChild:(GHFakeAXNode *)child {
    child.parent = self;
    [self.items addObject:child];
    return child;
}
- (void)insert:(GHFakeAXNode *)child after:(id<GHAXNode>)sibling {
    child.parent = self;
    NSUInteger index = sibling ? [self.items indexOfObjectIdenticalTo:(GHFakeAXNode *)sibling] : NSNotFound;
    if (index == NSNotFound) [self.items addObject:child]; else [self.items insertObject:child atIndex:index + 1];
}
- (void)remove:(GHFakeAXNode *)child { [self.items removeObjectIdenticalTo:child]; }
- (BOOL)holds:(GHFakeAXNode *)child { return [self.items indexOfObjectIdenticalTo:child] != NSNotFound; }
@end

@interface GHCBClock : NSObject
@property (nonatomic) NSTimeInterval now;
@property (nonatomic, readonly) NSMutableArray<NSArray *> *timers;
@end

@implementation GHCBClock
- (instancetype)init {
    if ((self = [super init])) { _timers = [NSMutableArray array]; _now = 50; }
    return self;
}
- (void (^)(NSTimeInterval, dispatch_block_t))after {
    __weak GHCBClock *weakSelf = self;
    return ^(NSTimeInterval delay, dispatch_block_t block) {
        GHCBClock *clock = weakSelf;
        [clock.timers addObject:@[ @(clock.now + delay), [block copy] ]];
    };
}
- (NSTimeInterval (^)(void))clock {
    __weak GHCBClock *weakSelf = self;
    return ^NSTimeInterval { return weakSelf.now; };
}
- (void)runUntil:(BOOL (^)(void))done {
    for (NSUInteger step = 0; step < 20000 && !done() && self.timers.count; step++) {
        NSUInteger best = 0;
        for (NSUInteger i = 1; i < self.timers.count; i++) {
            if ([self.timers[i][0] doubleValue] < [self.timers[best][0] doubleValue]) best = i;
        }
        NSArray *timer = self.timers[best];
        [self.timers removeObjectAtIndex:best];
        self.now = MAX(self.now, [timer[0] doubleValue]);
        ((dispatch_block_t)timer[1])();
    }
}
@end

@interface GHCBState : GHFakeDesktopState
/// Runs on every focus read (the poster reads focus right before each post), with the read's number.
@property (nonatomic, copy) void (^onFocusRead)(NSUInteger read);
@end

@implementation GHCBState
- (id<GHAXNode>)focusedElement {
    if (self.onFocusRead) self.onFocusRead(self.focusReads + 1);
    return [super focusedElement];
}
@end

@class GHCBWorld;

@interface GHCBActuator : GHFakeAXActuator
@property (nonatomic, weak) GHCBWorld *world;
@end

/// GHCBPressClosesOnly is what the REAL react-select on the live Greenhouse form does: a synthesized press on an
/// option row dismisses the menu and chooses nothing at all (the row answers a real mouse press).
typedef NS_ENUM(NSInteger, GHCBPress) { GHCBPressSelects, GHCBPressIgnored, GHCBPressFails, GHCBPressSelectsOther, GHCBPressClosesOnly };

/// A react-select combobox inside a flat form group, as on the real Greenhouse page.
@interface GHCBWorld : NSObject
@property (nonatomic) pid_t pid;
@property (nonatomic, strong) GHCBState *state;
@property (nonatomic, strong) GHFakeKeyPoster *poster;
@property (nonatomic, strong) GHCBActuator *actuator;
@property (nonatomic, strong) GHCBClock *clock;
@property (nonatomic, strong) GHComboBoxDriver *driver;

@property (nonatomic, strong) GHCBNode *container;
@property (nonatomic, strong) GHFakeAXNode *combo, *toggle, *shownText, *logText, *elsewhere;
@property (nonatomic, strong, nullable) GHCBNode *menu;
@property (nonatomic, copy) NSArray<NSString *> *options;
@property (nonatomic) NSInteger highlight;

// Behaviour.
@property (nonatomic) BOOL opensMenu, filters, highlightsFirst, arrowsWork, escapeClears, typingLands, explicitOptions;
/// The real WebKit shape of a react-select menu: rows are AXStaticText whose text is in AXTitle (AXValue empty) and
/// whose only marks are the DOM classes `select__option` and `select__option--is-focused`.
@property (nonatomic) BOOL webkitOptions;
/// react-select opens its menu when the combo box itself is pressed, with no keystroke at all.
@property (nonatomic) BOOL pressOpens;
/// How many times a press may open the menu (0 = as often as asked). 1 is a control that never comes back.
@property (nonatomic) NSUInteger maxPressOpens;
/// How many verification looks pass before the chosen text appears beside the control: a page whose accessibility
/// tree catches up after it has already chosen.
@property (nonatomic) NSUInteger chosenTextLagLooks;
@property (nonatomic) GHCBPress press;
@property (nonatomic, copy) void (^afterPost)(GHKeyStroke *stroke);

// What happened.
@property (nonatomic) NSUInteger presses, escapes, returnsWithoutList, selections, pressOpensDone;
@property (nonatomic, copy) NSString *selected;

- (instancetype)initWithContainer:(GHCBNode *)container combo:(GHFakeAXNode *)combo;
+ (instancetype)syntheticWorldWithLabel:(NSString *)label;
+ (instancetype)syntheticWorld;
- (void)focus:(GHFakeAXNode *)node;
- (void)choose:(NSString *)text;
- (void)openMenu;
- (void)closeMenu;
- (void)highlightIndex:(NSInteger)index;
- (GHComboBoxResult *)choose:(NSString *)answer in:(id<GHAXNode>)combo;
- (GHComboBoxResult *)answer:(NSString *)answer;
@end

static BOOL CBIsInside(id<GHAXNode> node, id<GHAXNode> ancestor) {
    for (id<GHAXNode> up = node; up; up = up.parent) if (up == ancestor) return YES;
    return NO;
}

@implementation GHCBActuator
- (BOOL)focusNode:(id<GHAXNode>)node {
    BOOL ok = [super focusNode:node];
    if (ok) self.world.state.focusedNode = node;
    return ok;
}
- (BOOL)pressNode:(id<GHAXNode>)node {
    [super pressNode:node];
    GHCBWorld *world = self.world;
    world.presses++;
    if (world.pressOpens && node == world.combo && !world.menu) {
        if (world.maxPressOpens > 0 && world.pressOpensDone >= world.maxPressOpens) return YES;
        world.pressOpensDone++;
        [world openMenu];
        return YES;
    }
    if (!world.menu || !CBIsInside(node, world.menu)) return YES;
    switch (world.press) {
        case GHCBPressSelects: [world choose:[GHComboBoxDriver textOfOption:node]]; return YES;
        case GHCBPressIgnored: return YES;
        case GHCBPressFails: return NO;
        case GHCBPressSelectsOther: [world choose:@"Something else"]; return YES;
        case GHCBPressClosesOnly: [world closeMenu]; return YES;
    }
    return YES;
}
@end

static GHFakeAXNode *CBNode(NSString *role, NSString *title) {
    GHCBNode *node = [GHCBNode nodeWithRole:role];
    node.title = title;
    return node;
}

@implementation GHCBWorld

/// `combo` sits in `container` after [label, log group, placeholder group] and before its toggle button.
- (instancetype)initWithContainer:(GHCBNode *)container combo:(GHFakeAXNode *)combo {
    if ((self = [super init])) {
        _pid = 777;
        _state = [[GHCBState alloc] init];
        _state.frontmostPID = _pid;
        _poster = [[GHFakeKeyPoster alloc] initWithState:_state];
        _actuator = [[GHCBActuator alloc] init];
        _actuator.world = self;
        _clock = [[GHCBClock alloc] init];
        _container = container;
        _combo = combo;
        NSArray<id<GHAXNode>> *siblings = container.children;
        NSUInteger index = [siblings indexOfObjectIdenticalTo:combo];
        _toggle = index + 1 < siblings.count ? (GHFakeAXNode *)siblings[index + 1] : nil;
        GHFakeAXNode *placeholder = index >= 1 ? (GHFakeAXNode *)siblings[index - 1] : nil;
        GHFakeAXNode *log = index >= 2 ? (GHFakeAXNode *)siblings[index - 2] : nil;
        _shownText = (GHFakeAXNode *)placeholder.children.firstObject;
        _logText = [GHFakeAXNode staticText:@"" frame:CGRectZero];
        [log addChild:_logText];
        _elsewhere = (GHFakeAXNode *)CBNode(@"AXTextField", @"Somewhere else");
        _options = @[ @"Indeed", @"LinkedIn", @"Referral" ];
        _opensMenu = _highlightsFirst = _arrowsWork = _escapeClears = _typingLands = YES;
        _press = GHCBPressSelects;
        _highlight = -1;

        __weak GHCBWorld *weakSelf = self;
        _poster.onPost = ^(GHKeyStroke *stroke) { [weakSelf react:stroke]; };
        _driver = [[GHComboBoxDriver alloc] initWithActuator:_actuator poster:_poster state:_state];
        _driver.after = _clock.after;
        _driver.clock = _clock.clock;
        _driver.isNodeSensitive = ^BOOL(id<GHAXNode> node) { return NO; };
    }
    return self;
}

+ (instancetype)syntheticWorldWithLabel:(NSString *)label {
    GHCBNode *form = (GHCBNode *)CBNode(@"AXGroup", nil);
    form.subrole = @"AXLandmarkForm";
    [form addChild:[GHFakeAXNode staticText:label frame:CGRectZero]];
    GHFakeAXNode *log = [form addChild:CBNode(@"AXGroup", nil)];
    log.subrole = @"AXEmptyGroup";
    log.roleDescription = @"log";
    GHFakeAXNode *placeholder = [form addChild:CBNode(@"AXGroup", nil)];
    [placeholder addChild:[GHFakeAXNode staticText:@"Select..." frame:CGRectZero]];
    GHFakeAXNode *combo = [form addChild:CBNode(@"AXComboBox", label)];
    combo.axDescription = label;
    combo.roleDescription = @"combo box";
    [form addChild:CBNode(@"AXButton", @"Toggle flyout")];
    [form addChild:[GHFakeAXNode staticText:@"" frame:CGRectZero]];
    [form addChild:[GHFakeAXNode staticText:@"Are you legally authorized to work in the United States for any employer?" frame:CGRectZero]];
    [form addChild:CBNode(@"AXComboBox", @"Are you legally authorized to work in the United States for any employer?")];
    GHFakeAXNode *web = CBNode(@"AXWebArea", nil);
    [web addChild:form];
    return [[self alloc] initWithContainer:form combo:combo];
}

+ (instancetype)syntheticWorld {
    return [self syntheticWorldWithLabel:@"How did you hear about this opportunity at Viam?"];
}

- (void)focus:(GHFakeAXNode *)node {
    ((GHFakeAXNode *)self.state.focusedNode).isFocused = NO;
    node.isFocused = YES;
    self.state.focusedNode = node;
    self.actuator.focusedNode = node;
}

- (NSArray<GHFakeAXNode *> *)optionNodes {
    NSMutableArray<GHFakeAXNode *> *nodes = [NSMutableArray array];
    for (id<GHAXNode> child in self.menu.children) [nodes addObject:(GHFakeAXNode *)child];
    return nodes;
}

- (void)openMenu {
    [self closeMenu];
    NSString *typed = self.combo.value.lowercaseString ?: @"";
    NSMutableArray<NSString *> *shown = [NSMutableArray array];
    for (NSString *option in self.options) {
        if (!self.filters || typed.length == 0 || [option.lowercaseString containsString:typed]) [shown addObject:option];
    }
    GHCBNode *menu = (GHCBNode *)CBNode(@"AXList", nil);
    menu.roleDescription = @"list box";
    if (shown.count == 0) {
        [menu addChild:[GHFakeAXNode staticText:@"No options" frame:CGRectZero]];
    }
    for (NSString *option in shown) {
        if (self.explicitOptions) {
            GHFakeAXNode *row = [menu addChild:CBNode(@"AXGroup", nil)];
            row.roleDescription = @"option";
            [row addChild:[GHFakeAXNode staticText:option frame:CGRectZero]];
        } else if (self.webkitOptions) {
            GHFakeAXNode *row = [menu addChild:CBNode(@"AXStaticText", option)];   // text in AXTitle, AXValue empty
            row.roleDescription = @"text";
            row.domClassList = @[ @"select__option", @"remix-css-18355b6-option" ];
        } else {
            [menu addChild:[GHFakeAXNode staticText:option frame:CGRectZero]];
        }
    }
    self.menu = menu;
    [self.container insert:menu after:self.toggle];
    self.highlight = -1;
    if (self.highlightsFirst && shown.count) [self highlightIndex:0];
}

- (void)closeMenu {
    if (self.menu) [self.container remove:self.menu];
    self.menu = nil;
    self.highlight = -1;
}

- (void)highlightIndex:(NSInteger)index {
    NSArray<GHFakeAXNode *> *nodes = [self optionNodes];
    for (GHFakeAXNode *node in nodes) {
        node.isFocused = NO;
        if (self.webkitOptions) node.domClassList = @[ @"select__option", @"remix-css-18355b6-option" ];
    }
    if (index < 0 || index >= (NSInteger)nodes.count) { self.highlight = -1; return; }
    // The real page marks the highlighted row with a class and NOTHING else: no AXFocused, no AXSelected.
    if (self.webkitOptions) nodes[(NSUInteger)index].domClassList = @[ @"select__option", @"select__option--is-focused", @"remix-css-2ov8vj-option" ];
    else nodes[(NSUInteger)index].isFocused = YES;
    self.highlight = index;
}

- (void)choose:(NSString *)text {
    self.selections++;
    self.selected = text;
    [self closeMenu];
    self.combo.value = @"";
    self.logText.value = [NSString stringWithFormat:@"option %@, selected.", text];
    if (self.chosenTextLagLooks == 0) { self.shownText.value = text; return; }
    // The page has chosen; its accessibility tree says so only a few looks later.
    GHFakeAXNode *shown = self.shownText;
    shown.value = @"";
    self.driver.after(self.driver.verifyDelay * (self.chosenTextLagLooks + 0.5), ^{ shown.value = text; });
}

- (void)react:(GHKeyStroke *)stroke {
    GHFakeAXNode *focused = (GHFakeAXNode *)self.state.focusedNode;
    BOOL inCombo = focused == self.combo;
    switch (stroke.kind) {
        case GHKeyStrokeKindText:
            if (!self.typingLands || !focused) break;
            focused.value = [focused.value ?: @"" stringByAppendingString:stroke.text];
            if (inCombo && self.opensMenu) [self openMenu];
            break;
        case GHKeyStrokeKindDownArrow:
        case GHKeyStrokeKindUpArrow:
            if (inCombo && self.menu && self.arrowsWork) {
                NSInteger step = stroke.kind == GHKeyStrokeKindDownArrow ? 1 : -1;
                NSInteger next = MAX(0, MIN((NSInteger)[self optionNodes].count - 1, self.highlight + step));
                [self highlightIndex:next];
            }
            break;
        case GHKeyStrokeKindReturn:
            if (inCombo && self.menu && self.highlight >= 0) [self choose:[GHComboBoxDriver textOfOption:[self optionNodes][(NSUInteger)self.highlight]]];
            else self.returnsWithoutList++;
            break;
        case GHKeyStrokeKindEscape:
            self.escapes++;
            [self closeMenu];
            if (inCombo && self.escapeClears) self.combo.value = @"";
            break;
        case GHKeyStrokeKindBackspace:
            if (focused.value.length) focused.value = [focused.value substringToIndex:focused.value.length - 1];
            break;
        default:
            break;
    }
    if (self.afterPost) self.afterPost(stroke);
}

- (GHComboBoxResult *)choose:(NSString *)answer in:(id<GHAXNode>)combo {
    __block GHComboBoxResult *result = nil;
    [self.driver chooseAnswer:answer inComboBox:combo completion:^(GHComboBoxResult *r) { result = r; }];
    [self.clock runUntil:^BOOL { return result != nil; }];
    return result;
}

- (GHComboBoxResult *)answer:(NSString *)answer {
    return [self choose:answer in:self.combo];
}

@end

static BOOL CBTouchedNothing(GHCBWorld *world) {
    return world.poster.posted.count == 0 && world.poster.guardCalls == 0 && world.actuator.focusCount == 0 && world.presses == 0;
}

#pragma mark - fixture

static GHCBNode *CBFixtureNode(NSDictionary *raw) {
    GHCBNode *node = [GHCBNode nodeWithRole:raw[@"role"] ?: @"AXUnknown"];
    NSDictionary *keys = @{ @"title": @"title", @"subrole": @"subrole", @"description": @"axDescription", @"roleDescription": @"roleDescription",
                            @"identifier": @"identifier", @"text": @"value" };
    for (NSString *key in keys) if ([raw[key] isKindOfClass:NSString.class]) [node setValue:raw[key] forKey:keys[key]];
    if (raw[@"enabled"]) node.enabled = [raw[@"enabled"] boolValue];
    for (NSDictionary *child in raw[@"children"]) [node addChild:CBFixtureNode(child)];
    return node;
}

static GHCBNode *CBGreenhouseWindow(void) {
    NSString *path = [@(__FILE__).stringByDeletingLastPathComponent stringByAppendingPathComponent:@"fixtures/greenhouse-safari-viam.json"];
    NSDictionary *fixture = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:path] ?: [NSData data] options:0 error:NULL];
    return [fixture[@"tree"] isKindOfClass:NSDictionary.class] ? CBFixtureNode(fixture[@"tree"]) : nil;
}

static void CBCollect(id<GHAXNode> root, NSString *role, NSMutableArray *out) {
    if ([root.role isEqualToString:role]) [out addObject:root];
    for (id<GHAXNode> child in root.children) CBCollect(child, role, out);
}

static GHFakeAXNode *CBComboTitled(id<GHAXNode> window, NSString *title) {
    NSMutableArray<id<GHAXNode>> *combos = [NSMutableArray array];
    CBCollect(window, @"AXComboBox", combos);
    for (id<GHAXNode> combo in combos) if ([combo.title isEqualToString:title]) return (GHFakeAXNode *)combo;
    return nil;
}

#pragma mark - pure rules

GH_TEST(combobox_match_option_port_pins_the_shared_cases) {
    GHOptionMatch m = GHMatchOption(@[ @"Select...", @"Indeed", @"LinkedIn" ], @"LinkedIn");
    GH_ASSERT_EQUAL_INT(m.index, 2);
    GH_ASSERT_NEAR(m.score, 1.0, 1e-9);
    m = GHMatchOption(@[ @"Yes, I am authorized", @"No, I am not" ], @"Yes");
    GH_ASSERT_EQUAL_INT(m.index, 0);
    GH_ASSERT_NEAR(m.score, 0.95, 1e-9);
    GH_ASSERT_EQUAL_INT(GHMatchOption(@[ @"Yes", @"No" ], @"no").index, 1);
    GH_ASSERT_EQUAL_INT(GHMatchOption(@[ @"Yes", @"Yes, with sponsorship" ], @"yes").index, 0);   // exact 1 beats 0.95
    // Two equally good answers are a guess, not an answer.
    GH_ASSERT_EQUAL_INT(GHMatchOption(@[ @"Yes, as a citizen", @"Yes, with a permit" ], @"Yes").index, -1);
    m = GHMatchOption(@[ @"Hack the North 2026", @"Other" ], @"Hack the North");
    GH_ASSERT_EQUAL_INT(m.index, 0);
    GH_ASSERT_NEAR(m.score, 0.88, 1e-9);
    GH_ASSERT_EQUAL_INT(GHMatchOption(@[ @"University of Toronto" ], @"University of Waterloo").index, -1);
    GH_ASSERT_EQUAL_INT(GHMatchOption(@[ @"University" ], @"University of Waterloo").index, -1);
    GH_ASSERT_EQUAL_INT(GHMatchOption(@[ @"Arkansas" ], @"AR").index, -1);   // never substrings
    GH_ASSERT_EQUAL_INT(GHMatchOption(@[ @"LinkedIn", @"Indeed" ], @"Twitter").index, -1);
    GH_ASSERT_EQUAL_INT(GHMatchOption(@[ @"Select one", @"-- choose --" ], @"Select one").index, -1);   // placeholders are never options
    GH_ASSERT_EQUAL_INT(GHMatchOption(@[ @"linked_in" ], @"Linked In").index, 0);   // shared normalize()
    GH_ASSERT_EQUAL_INT(GHMatchOption(@[], @"Yes").index, -1);
    GH_ASSERT_EQUAL_INT(GHMatchOption(@[ @"Yes" ], @"").index, -1);
    GH_ASSERT_NEAR(GHComboBoxMatchThreshold, 0.7, 1e-9);
}

GH_TEST(combobox_demographic_questions_are_recognised) {
    for (NSString *text in @[ @"Gender", @"Are you Hispanic/Latino?", @"Veteran Status", @"Disability Status", @"Pronouns", @"Race & Ethnicity",
                              @"Sexual orientation", @"Date of Birth", @"What is your age?", @"Birthdate", @"hispanic_ethnicity", @"veteranStatus",
                              @"Do you identify as transgender?" ]) {
        GH_ASSERT_MSG([GHComboBoxDriver isDemographicText:text], @"should be demographic: %@", text);
    }
    for (NSString *text in @[ @"Country", @"How did you hear about this opportunity at Viam?", @"Language", @"Page", @"Manager", @"Message",
                              @"Are you legally authorized to work in the United States for any employer?", @"Stage", @"" ]) {
        GH_ASSERT_MSG(![GHComboBoxDriver isDemographicText:text], @"should not be demographic: %@", text);
    }
}

GH_TEST(combobox_real_greenhouse_eeo_questions_are_never_touched) {
    GHCBNode *window = CBGreenhouseWindow();
    GH_ASSERT(window != nil);
    NSMutableArray<id<GHAXNode>> *combos = [NSMutableArray array];
    CBCollect(window, @"AXComboBox", combos);
    GH_ASSERT_EQUAL_INT(combos.count, 7);
    NSMutableSet<NSString *> *eeo = [NSMutableSet set];
    for (id<GHAXNode> combo in combos) if ([GHComboBoxDriver isDemographicComboBox:combo]) [eeo addObject:combo.title];
    GH_ASSERT_EQUAL_OBJECTS(eeo, ([NSSet setWithArray:@[ @"Gender", @"Are you Hispanic/Latino?", @"Veteran Status", @"Disability Status" ]]));

    for (NSString *title in eeo) {
        GHFakeAXNode *combo = CBComboTitled(window, title);
        GHCBWorld *world = [[GHCBWorld alloc] initWithContainer:(GHCBNode *)combo.parent combo:combo];
        GHComboBoxResult *result = [world answer:@"Decline to self-identify"];
        GH_ASSERT_EQUAL_OBJECTS(result.reason, GHComboBoxReasonDemographic);
        GH_ASSERT(result.skipsField);
        GH_ASSERT(CBTouchedNothing(world));
    }
}

GH_TEST(combobox_real_greenhouse_list_detection) {
    GHCBNode *window = CBGreenhouseWindow();
    NSMutableArray<id<GHAXNode>> *combos = [NSMutableArray array];
    CBCollect(window, @"AXComboBox", combos);
    // Nothing is open: the posting's bulleted AXContentLists are never taken for a menu.
    for (id<GHAXNode> combo in combos) GH_ASSERT_MSG([GHComboBoxDriver listForComboBox:combo] == nil, @"%@", combo.title);
    // Every combobox shows "Select..." (or nothing): no value yet.
    for (id<GHAXNode> combo in combos) GH_ASSERT_EQUAL_INT([GHComboBoxDriver shownTextsForComboBox:combo typed:nil].count, 0);

    GHFakeAXNode *heard = CBComboTitled(window, @"How did you hear about this opportunity at Viam?");
    GHCBWorld *world = [[GHCBWorld alloc] initWithContainer:(GHCBNode *)heard.parent combo:heard];
    [world openMenu];
    GH_ASSERT([GHComboBoxDriver listForComboBox:heard] == world.menu);
    // The next question's combobox does not claim a menu that sits before it.
    GH_ASSERT([GHComboBoxDriver listForComboBox:CBComboTitled(window, @"Are you legally authorized to work in the United States for any employer?")] == nil);
}

GH_TEST(combobox_list_search_stops_at_a_hung_app) {
    GHCBWorld *world = [GHCBWorld syntheticWorld];
    [world openMenu];
    GH_ASSERT([GHComboBoxDriver listForComboBox:world.combo] == world.menu);
    // The web process stops answering: the menu is not "found" through a node that did not answer, and nothing
    // behind it is read.
    world.menu.lastError = kAXErrorCannotComplete;
    NSUInteger reads = world.menu.childrenReadCount;
    GH_ASSERT([GHComboBoxDriver listForComboBox:world.combo] == nil);
    GH_ASSERT_EQUAL_INT(world.menu.childrenReadCount, reads);
    world.menu.lastError = kAXErrorSuccess;
    GH_ASSERT([GHComboBoxDriver listForComboBox:world.combo] == world.menu);
}

GH_TEST(combobox_list_and_option_detection_rules) {
    GHCBWorld *world = [GHCBWorld syntheticWorld];
    // A checkbox group right after the combobox is not its menu.
    GHCBNode *checks = (GHCBNode *)CBNode(@"AXList", nil);
    GHFakeAXNode *row = [checks addChild:CBNode(@"AXGroup", nil)];
    [row addChild:CBNode(@"AXCheckBox", @"Yes")];
    [row addChild:[GHFakeAXNode staticText:@"Yes" frame:CGRectZero]];
    [world.container insert:checks after:world.toggle];
    GH_ASSERT([GHComboBoxDriver listForComboBox:world.combo] == nil);
    [world.container remove:checks];
    // Neither is a content list.
    GHCBNode *bullets = (GHCBNode *)CBNode(@"AXList", nil);
    bullets.subrole = @"AXContentList";
    [bullets addChild:[GHFakeAXNode staticText:@"Free lunch" frame:CGRectZero]];
    [world.container insert:bullets after:world.toggle];
    GH_ASSERT([GHComboBoxDriver listForComboBox:world.combo] == nil);
    [world.container remove:bullets];

    // Explicit option rows win over loose text, and their text comes from inside.
    world.explicitOptions = YES;
    [world openMenu];
    GH_ASSERT([GHComboBoxDriver listForComboBox:world.combo] == world.menu);
    NSArray<id<GHAXNode>> *options = [GHComboBoxDriver optionsInList:world.menu];
    GH_ASSERT_EQUAL_INT(options.count, 3);
    GH_ASSERT_EQUAL_OBJECTS(options[0].roleDescription, @"option");
    GH_ASSERT_EQUAL_OBJECTS([GHComboBoxDriver textOfOption:options[1]], @"LinkedIn");
    [world closeMenu];

    // "No options" is a notice, never an option.
    GHCBNode *notice = (GHCBNode *)CBNode(@"AXList", nil);
    notice.roleDescription = @"list box";
    [notice addChild:[GHFakeAXNode staticText:@"No options" frame:CGRectZero]];
    GH_ASSERT_EQUAL_INT([GHComboBoxDriver optionsInList:notice].count, 0);

    // A menu rendered in a portal at the end of the page is found too.
    GHCBNode *web = (GHCBNode *)CBNode(@"AXWebArea", nil);
    GHCBNode *form = (GHCBNode *)[web addChild:CBNode(@"AXGroup", nil)];
    GHFakeAXNode *combo = [form addChild:CBNode(@"AXComboBox", @"Location")];
    [form addChild:CBNode(@"AXTextField", @"Next field")];
    GHCBNode *portal = (GHCBNode *)[web addChild:CBNode(@"AXGroup", nil)];
    GHFakeAXNode *menu = [portal addChild:CBNode(@"AXMenu", nil)];
    [menu addChild:CBNode(@"AXMenuItem", @"Toronto, ON")];
    GH_ASSERT([GHComboBoxDriver listForComboBox:combo] == menu);
    GH_ASSERT_EQUAL_OBJECTS([GHComboBoxDriver textOfOption:[GHComboBoxDriver optionsInList:menu][0]], @"Toronto, ON");

    GH_ASSERT([GHComboBoxDriver isComboBox:world.combo]);
    GHFakeAXNode *textCombo = CBNode(@"AXTextField", @"City");
    textCombo.roleDescription = @"combo box";
    GH_ASSERT([GHComboBoxDriver isComboBox:textCombo]);
    GH_ASSERT_FALSE([GHComboBoxDriver isComboBox:CBNode(@"AXTextField", @"City")]);
}

GH_TEST(combobox_shown_texts_skip_placeholder_log_label_and_typing) {
    GHCBWorld *world = [GHCBWorld syntheticWorld];
    GH_ASSERT_EQUAL_INT([GHComboBoxDriver shownTextsForComboBox:world.combo typed:nil].count, 0);
    world.logText.value = @"Select is focused, type to refine list";
    GH_ASSERT_EQUAL_INT([GHComboBoxDriver shownTextsForComboBox:world.combo typed:nil].count, 0);
    world.combo.value = @"Link";
    GH_ASSERT_EQUAL_INT([GHComboBoxDriver shownTextsForComboBox:world.combo typed:@"Link"].count, 0);
    GH_ASSERT_EQUAL_OBJECTS([GHComboBoxDriver shownTextsForComboBox:world.combo typed:nil], (@[ @"Link" ]));
    world.combo.value = @"";
    world.shownText.value = @"LinkedIn";
    GH_ASSERT_EQUAL_OBJECTS([GHComboBoxDriver shownTextsForComboBox:world.combo typed:nil], (@[ @"LinkedIn" ]));
}

#pragma mark - choosing

GH_TEST(combobox_types_presses_the_option_and_verifies) {
    GHCBWorld *world = [GHCBWorld syntheticWorld];
    GHComboBoxResult *result = [world answer:@"LinkedIn"];
    GH_ASSERT_MSG(result.chosen, @"%@", result);
    GH_ASSERT_EQUAL_OBJECTS(result.method, GHComboBoxMethodPress);
    GH_ASSERT_NEAR(result.score, 1.0, 1e-9);
    GH_ASSERT(result.typed);
    GH_ASSERT_EQUAL_OBJECTS(world.selected, @"LinkedIn");
    GH_ASSERT_EQUAL_OBJECTS(world.poster.postedNames, (@[ @"text" ]));   // no Return, no Escape
    GH_ASSERT_EQUAL_OBJECTS(world.poster.typedText, @"LinkedIn");
    // Two presses: the combo box itself (the attempt to open it without a keystroke), then the chosen option. This
    // synthetic control ignores the first one, so the run still had to type.
    GH_ASSERT_EQUAL_INT(world.presses, 2);
    GH_ASSERT_FALSE(world.driver.running);
}

GH_TEST(combobox_chooses_on_the_real_greenhouse_tree) {
    GHCBNode *window = CBGreenhouseWindow();
    GHFakeAXNode *heard = CBComboTitled(window, @"How did you hear about this opportunity at Viam?");
    GHCBWorld *world = [[GHCBWorld alloc] initWithContainer:(GHCBNode *)heard.parent combo:heard];
    world.filters = YES;
    GHComboBoxResult *result = [world answer:@"LinkedIn"];
    GH_ASSERT_MSG(result.chosen, @"%@", result);
    GH_ASSERT_EQUAL_OBJECTS(world.shownText.value, @"LinkedIn");
    GH_ASSERT_EQUAL_INT(result.optionCount, 1);

    GHFakeAXNode *authorized = CBComboTitled(window, @"Are you legally authorized to work in the United States for any employer?");
    GHCBWorld *yes = [[GHCBWorld alloc] initWithContainer:(GHCBNode *)authorized.parent combo:authorized];
    yes.options = @[ @"Yes", @"No" ];
    yes.filters = NO;
    GHComboBoxResult *answered = [yes answer:@"Yes"];
    GH_ASSERT_MSG(answered.chosen, @"%@", answered);
    GH_ASSERT_EQUAL_OBJECTS(yes.selected, @"Yes");
}

GH_TEST(combobox_press_that_does_nothing_falls_back_to_arrows_and_return) {
    for (NSNumber *mode in @[ @(GHCBPressIgnored), @(GHCBPressFails) ]) {
        GHCBWorld *world = [GHCBWorld syntheticWorld];
        world.press = (GHCBPress)mode.integerValue;
        world.options = @[ @"Indeed", @"LinkedIn", @"Referral" ];
        world.filters = NO;   // all three stay listed, "Indeed" highlighted first
        GHComboBoxResult *result = [world answer:@"LinkedIn"];
        GH_ASSERT_MSG(result.chosen, @"%@", result);
        GH_ASSERT_EQUAL_OBJECTS(result.method, GHComboBoxMethodKeys);
        GH_ASSERT_EQUAL_OBJECTS(world.poster.postedNames, (@[ @"text", @"down", @"return" ]));
        GH_ASSERT_EQUAL_OBJECTS(world.selected, @"LinkedIn");
        GH_ASSERT_EQUAL_INT(world.returnsWithoutList, 0);
    }
    // Nothing highlighted yet: Down first highlights, then walks.
    GHCBWorld *world = [GHCBWorld syntheticWorld];
    world.press = GHCBPressIgnored;
    world.filters = NO;
    world.highlightsFirst = NO;
    GHComboBoxResult *result = [world answer:@"Referral"];
    GH_ASSERT_MSG(result.chosen, @"%@", result);
    GH_ASSERT_EQUAL_OBJECTS(world.poster.postedNames, (@[ @"text", @"down", @"down", @"down", @"return" ]));
}

// What the LIVE Greenhouse form did on 2026-09-19: the menu opened on a press, the option matched 1.00, the press
// on the row closed the menu and chose NOTHING, and the run reported combobox-not-verified for all five remaining
// questions. The row answers a real mouse press; a synthesized one only dismisses the menu. So: open it again and
// use the keyboard, which is the path a person without a mouse takes anyway.
GH_TEST(combobox_press_that_only_closes_the_menu_reopens_it_and_uses_the_keyboard) {
    GHCBNode *window = CBGreenhouseWindow();
    GHFakeAXNode *authorized = CBComboTitled(window, @"Are you legally authorized to work in the United States for any employer?");
    GHCBWorld *world = [[GHCBWorld alloc] initWithContainer:(GHCBNode *)authorized.parent combo:authorized];
    world.options = @[ @"Yes", @"No" ];
    world.filters = NO;
    world.pressOpens = YES;       // react-select opens on a press, so nothing is ever typed here
    world.webkitOptions = YES;    // rows are AXStaticText marked only by their DOM class
    world.press = GHCBPressClosesOnly;

    GHComboBoxResult *result = [world answer:@"No"];
    GH_ASSERT_MSG(result.chosen, @"%@", result);
    GH_ASSERT_EQUAL_OBJECTS(result.method, GHComboBoxMethodKeys);
    GH_ASSERT_EQUAL_OBJECTS(world.selected, @"No");
    GH_ASSERT_EQUAL_OBJECTS(world.shownText.value, @"No");
    GH_ASSERT_FALSE(result.typed);
    // Nothing is typed and no Escape is posted: open, arrow, Return.
    GH_ASSERT_EQUAL_OBJECTS(world.poster.postedNames, (@[ @"down", @"return" ]));
    GH_ASSERT_EQUAL_INT(world.presses, 3);   // open, the option, open again
    GH_ASSERT_EQUAL_INT(world.selections, 1);
    GH_ASSERT_EQUAL_INT(world.escapes, 0);
}

// The same for a decline on a demographic question: the option is chosen by MEANING and still nothing is typed.
GH_TEST(combobox_decline_survives_a_press_that_only_closes_the_menu) {
    GHCBWorld *world = [GHCBWorld syntheticWorldWithLabel:@"Gender"];
    world.options = @[ @"Male", @"Female", @"Decline To Self Identify" ];
    world.filters = NO;
    world.pressOpens = YES;
    world.webkitOptions = YES;
    world.press = GHCBPressClosesOnly;

    __block GHComboBoxResult *result = nil;
    [world.driver chooseAnswer:@"Prefer not to say" inComboBox:world.combo decline:YES completion:^(GHComboBoxResult *r) { result = r; }];
    [world.clock runUntil:^BOOL { return result != nil; }];
    GH_ASSERT_MSG(result.chosen, @"%@", result);
    GH_ASSERT_EQUAL_OBJECTS(world.selected, @"Decline To Self Identify");   // the form's own wording, never ours
    GH_ASSERT_FALSE(result.typed);
    GH_ASSERT_EQUAL_OBJECTS(world.poster.postedNames, (@[ @"down", @"down", @"return" ]));
}

// A press that DID choose, on a page whose accessibility tree catches up a few looks later: no second choice, no
// re-open, and the run still reports the press as the method.
GH_TEST(combobox_press_is_verified_when_the_page_catches_up_late) {
    GHCBWorld *world = [GHCBWorld syntheticWorld];
    world.pressOpens = YES;
    world.webkitOptions = YES;
    world.filters = NO;
    world.chosenTextLagLooks = 3;   // the page chose, but says so only after three more looks
    GHComboBoxResult *result = [world answer:@"LinkedIn"];
    GH_ASSERT_MSG(result.chosen, @"%@", result);
    GH_ASSERT_EQUAL_OBJECTS(result.method, GHComboBoxMethodPress);
    GH_ASSERT_EQUAL_INT(world.presses, 2);     // open, the option: never a third
    GH_ASSERT_EQUAL_INT(world.selections, 1);
}

// A press that chose the WRONG option is never answered with a second choice, however long the run looks.
GH_TEST(combobox_press_that_picks_something_else_is_never_reopened) {
    GHCBWorld *world = [GHCBWorld syntheticWorld];
    world.pressOpens = YES;
    world.webkitOptions = YES;
    world.filters = NO;
    world.press = GHCBPressSelectsOther;
    GHComboBoxResult *result = [world answer:@"LinkedIn"];
    GH_ASSERT(result.stopsWalk);
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHComboBoxReasonNotVerified);
    GH_ASSERT_EQUAL_INT(world.presses, 2);
    GH_ASSERT_EQUAL_INT(world.selections, 1);
    GH_ASSERT_EQUAL_OBJECTS(world.selected, @"Something else");
}

// A control that will not open a second time is left exactly as the press found it: nothing typed, nothing chosen.
GH_TEST(combobox_that_will_not_reopen_is_left_alone) {
    GHCBWorld *world = [GHCBWorld syntheticWorld];
    world.pressOpens = YES;
    world.webkitOptions = YES;
    world.filters = NO;
    world.press = GHCBPressClosesOnly;
    world.maxPressOpens = 1;   // the menu never comes back
    GHComboBoxResult *result = [world answer:@"LinkedIn"];
    GH_ASSERT_FALSE(result.chosen);
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHComboBoxReasonNotVerified);
    GH_ASSERT_EQUAL_INT(world.selections, 0);
    GH_ASSERT_EQUAL_OBJECTS(world.poster.postedNames, @[]);
    GH_ASSERT_EQUAL_OBJECTS(world.shownText.value, @"Select...");
}

GH_TEST(combobox_neutral_matcher_ranks_the_least_committing_option_first) {
    // "Other" answers the question; declining merely ends it, so it ranks after the three that answer.
    GH_ASSERT_EQUAL_INT(GHMatchNeutralOption((@[ @"LinkedIn", @"Prefer not to say", @"Other" ]), @"").index, 2);
    GH_ASSERT_EQUAL_INT(GHMatchNeutralOption((@[ @"None of the above", @"N/A" ]), @"").index, 0);
    GH_ASSERT_EQUAL_INT(GHMatchNeutralOption((@[ @"Yes", @"No", @"Not applicable" ]), @"").index, 2);
    GH_ASSERT_EQUAL_INT(GHMatchNeutralOption((@[ @"Select...", @"Other" ]), @"").index, 1);   // never a placeholder
    GH_ASSERT_NEAR(GHMatchNeutralOption((@[ @"Other" ]), @"").score, 1.0, 1e-9);
    // A legal statement is not a neutral answer, and a list of real claims has no neutral option at all.
    GH_ASSERT_EQUAL_INT(GHMatchNeutralOption((@[ @"I certify that none of the above apply" ]), @"").index, -1);
    GH_ASSERT_EQUAL_INT(GHMatchNeutralOption((@[ @"Yes", @"No" ]), @"").index, -1);
    GH_ASSERT_EQUAL_INT(GHMatchNeutralOption(@[], @"").index, -1);
    // The exact list the LIVE Greenhouse "How did you hear" control showed on 2026-09-19.
    NSArray<NSString *> *live = @[ @"LinkedIn", @"Indeed", @"A friend", @"TikTok", @"Instagram", @"Twitter", @"Meetup/Event", @"Other" ];
    GH_ASSERT_EQUAL_INT(GHMatchNeutralOption(live, @"Hack the North").index, 7);
    GH_ASSERT_EQUAL_INT(GHMatchOption(live, @"Hack the North").index, -1);   // the fact itself is not on the list
}

// docs/answers.md section 3: an ORDINARY question whose profile fact is not among the options is still answered,
// with whatever the list itself calls the neutral choice. Live: "Hack the North" against eight named sources.
GH_TEST(combobox_answer_that_is_not_on_the_list_takes_the_lists_own_neutral_option) {
    GHCBWorld *world = [GHCBWorld syntheticWorld];
    world.options = @[ @"LinkedIn", @"Indeed", @"A friend", @"TikTok", @"Instagram", @"Twitter", @"Meetup/Event", @"Other" ];
    world.filters = NO;
    world.pressOpens = YES;
    world.webkitOptions = YES;

    __block GHComboBoxResult *result = nil;
    [world.driver chooseAnswer:@"Hack the North" inComboBox:world.combo decline:NO neutralFallback:YES completion:^(GHComboBoxResult *r) { result = r; }];
    [world.clock runUntil:^BOOL { return result != nil; }];
    GH_ASSERT_MSG(result.chosen, @"%@", result);
    GH_ASSERT(result.tookNeutral);
    GH_ASSERT_EQUAL_OBJECTS(world.selected, @"Other");
    GH_ASSERT_FALSE(result.typed);   // nothing is typed: a word the list does not have would filter it to nothing
}

GH_TEST(combobox_neutral_fallback_never_beats_a_real_match_and_never_invents_one) {
    // A real match still wins: the fallback only ever runs when the matcher found nothing.
    GHCBWorld *match = [GHCBWorld syntheticWorld];
    match.options = @[ @"LinkedIn", @"Other" ];
    match.filters = NO;
    match.pressOpens = YES;
    __block GHComboBoxResult *chosen = nil;
    [match.driver chooseAnswer:@"LinkedIn" inComboBox:match.combo decline:NO neutralFallback:YES completion:^(GHComboBoxResult *r) { chosen = r; }];
    [match.clock runUntil:^BOOL { return chosen != nil; }];
    GH_ASSERT(chosen.chosen);
    GH_ASSERT_FALSE(chosen.tookNeutral);
    GH_ASSERT_EQUAL_OBJECTS(match.selected, @"LinkedIn");

    // A list with no neutral option is left exactly as it was: a declaration's Yes/No is never "answered" for it.
    GHCBWorld *none = [GHCBWorld syntheticWorldWithLabel:@"Are you legally authorized to work in the United States for any employer?"];
    none.options = @[ @"Yes", @"No" ];
    none.filters = NO;
    none.pressOpens = YES;
    __block GHComboBoxResult *skipped = nil;
    [none.driver chooseAnswer:@"Maybe" inComboBox:none.combo decline:NO neutralFallback:YES completion:^(GHComboBoxResult *r) { skipped = r; }];
    [none.clock runUntil:^BOOL { return skipped != nil; }];
    GH_ASSERT(skipped.skipsField);
    GH_ASSERT_EQUAL_OBJECTS(skipped.reason, GHComboBoxReasonNoMatchingOption);
    GH_ASSERT_EQUAL_INT(none.selections, 0);
    GH_ASSERT_FALSE(skipped.tookNeutral);

    // Without the flag nothing changes: the field is skipped, as it was before the fallback existed.
    GHCBWorld *off = [GHCBWorld syntheticWorld];
    off.options = @[ @"LinkedIn", @"Other" ];
    off.filters = NO;
    off.pressOpens = YES;
    GHComboBoxResult *left = [off answer:@"Hack the North"];
    GH_ASSERT(left.skipsField);
    GH_ASSERT_EQUAL_INT(off.selections, 0);
}

GH_TEST(combobox_return_only_while_the_list_is_open_and_the_choice_highlighted) {
    // The list closes after an arrow: no Return at all.
    GHCBWorld *closing = [GHCBWorld syntheticWorld];
    closing.press = GHCBPressIgnored;
    closing.filters = NO;
    __weak GHCBWorld *weakClosing = closing;
    closing.afterPost = ^(GHKeyStroke *stroke) { if (stroke.kind == GHKeyStrokeKindDownArrow) [weakClosing closeMenu]; };
    GHComboBoxResult *closed = [closing answer:@"LinkedIn"];
    GH_ASSERT_EQUAL_OBJECTS(closed.reason, GHComboBoxReasonListClosed);
    GH_ASSERT(closed.stopsWalk);
    GH_ASSERT_EQUAL_INT([closing.poster countOfKind:GHKeyStrokeKindReturn], 0);

    // The highlight moves off the choice between the decision and the Return: the guard refuses it.
    GHCBWorld *moving = [GHCBWorld syntheticWorld];
    moving.press = GHCBPressIgnored;
    moving.filters = NO;
    __weak GHCBWorld *weakMoving = moving;
    moving.state.onFocusRead = ^(NSUInteger read) {
        GHCBWorld *world = weakMoving;
        if (world.menu && world.highlight == 1) [world highlightIndex:2];   // "LinkedIn" -> "Referral" right before the post
    };
    GHComboBoxResult *moved = [moving answer:@"LinkedIn"];
    GH_ASSERT_FALSE(moved.chosen);
    GH_ASSERT(moved.stopsWalk);
    GH_ASSERT_EQUAL_INT([moving.poster countOfKind:GHKeyStrokeKindReturn], 0);
    GH_ASSERT_EQUAL_INT(moving.selections, 0);
}

GH_TEST(combobox_without_a_matching_option_escapes_once_clears_and_skips) {
    GHCBWorld *world = [GHCBWorld syntheticWorld];
    world.filters = NO;
    GHComboBoxResult *result = [world answer:@"Twitter"];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHComboBoxReasonNoMatchingOption);
    GH_ASSERT(result.skipsField);
    GH_ASSERT(result.pressedEscape);
    GH_ASSERT(result.clearedTyping);
    GH_ASSERT_EQUAL_OBJECTS(world.poster.postedNames, (@[ @"text", @"escape" ]));
    GH_ASSERT_EQUAL_INT(world.presses, 1);        // the open attempt only; no option was ever pressed
    GH_ASSERT_EQUAL_OBJECTS(world.combo.value, @"");

    // A list whose Escape keeps the typed text: backspaces take exactly that back.
    GHCBWorld *sticky = [GHCBWorld syntheticWorld];
    sticky.filters = NO;
    sticky.escapeClears = NO;
    GHComboBoxResult *cleaned = [sticky answer:@"Twitter"];
    GH_ASSERT(cleaned.skipsField);
    GH_ASSERT(cleaned.clearedTyping);
    GH_ASSERT_EQUAL_INT([sticky.poster countOfKind:GHKeyStrokeKindBackspace], 7);
    GH_ASSERT_EQUAL_OBJECTS(sticky.combo.value, @"");

    // The list closed on its own before the Escape: nothing is open, so nothing is posted (it would reach the page).
    GHCBWorld *closed = [GHCBWorld syntheticWorld];
    closed.filters = NO;
    __weak GHCBWorld *weakClosed = closed;
    closed.driver.matcher = ^GHOptionMatch(NSArray<NSString *> *options, NSString *answer) {
        [weakClosed closeMenu];
        return (GHOptionMatch){ -1, 0 };
    };
    GHComboBoxResult *gone = [closed answer:@"Twitter"];
    GH_ASSERT_EQUAL_OBJECTS(gone.reason, GHComboBoxReasonNoMatchingOption);
    GH_ASSERT_FALSE(gone.pressedEscape);
    GH_ASSERT_EQUAL_INT([closed.poster countOfKind:GHKeyStrokeKindEscape], 0);
    GH_ASSERT_EQUAL_OBJECTS(closed.combo.value, @"");

    // Focus left meanwhile: nothing is deleted anywhere.
    GHCBWorld *left = [GHCBWorld syntheticWorld];
    left.filters = NO;
    left.escapeClears = NO;
    __weak GHCBWorld *weakLeft = left;
    left.afterPost = ^(GHKeyStroke *stroke) { if (stroke.kind == GHKeyStrokeKindEscape) [weakLeft focus:weakLeft.elsewhere]; };
    left.elsewhere.value = @"keep me";
    GHComboBoxResult *untouched = [left answer:@"Twitter"];
    GH_ASSERT(untouched.skipsField);
    GH_ASSERT_FALSE(untouched.clearedTyping);
    GH_ASSERT_EQUAL_INT([left.poster countOfKind:GHKeyStrokeKindBackspace], 0);
    GH_ASSERT_EQUAL_OBJECTS(left.elsewhere.value, @"keep me");

    // An injected matcher and the threshold decide.
    GHCBWorld *low = [GHCBWorld syntheticWorld];
    low.driver.matcher = ^GHOptionMatch(NSArray<NSString *> *options, NSString *answer) { return (GHOptionMatch){ 1, 0.69 }; };
    GH_ASSERT_EQUAL_OBJECTS([low answer:@"LinkedIn"].reason, GHComboBoxReasonNoMatchingOption);
    GHCBWorld *high = [GHCBWorld syntheticWorld];
    high.filters = NO;
    high.driver.matcher = ^GHOptionMatch(NSArray<NSString *> *options, NSString *answer) { return (GHOptionMatch){ 1, 0.7 }; };
    GHComboBoxResult *picked = [high answer:@"whatever"];
    GH_ASSERT(picked.chosen);
    GH_ASSERT_EQUAL_OBJECTS(high.selected, @"LinkedIn");
}

GH_TEST(combobox_list_that_never_opens_skips_after_one_and_a_half_seconds) {
    GHCBWorld *world = [GHCBWorld syntheticWorld];
    world.opensMenu = NO;
    NSTimeInterval start = world.clock.now;
    GHComboBoxResult *result = [world answer:@"LinkedIn"];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHComboBoxReasonNoList);
    GH_ASSERT(result.skipsField);
    // Focus settle, the press that opens nothing, the list that never comes, the cleanup.
    GH_ASSERT_NEAR(world.clock.now - start, 0.05 + 0.7 + 1.5 + 0.06, 0.12);
    // No list ever showed: an Escape would reach the page or the window (a modal closes, a sheet cancels). None.
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:GHKeyStrokeKindEscape], 0);
    GH_ASSERT_FALSE(result.pressedEscape);
    GH_ASSERT_EQUAL_OBJECTS(world.combo.value, @"");                // the typed text is taken back with backspaces

    // A list that only says "No options" IS open: the notice is never matched ("No" stays unanswered), but the menu
    // is closed at once with one Escape instead of waiting out the whole timeout with it hanging open.
    GHCBWorld *notice = [GHCBWorld syntheticWorld];
    notice.filters = YES;
    NSTimeInterval noticeStart = notice.clock.now;
    GHComboBoxResult *none = [notice answer:@"No"];
    GH_ASSERT_EQUAL_OBJECTS(none.reason, GHComboBoxReasonNoMatchingOption);
    GH_ASSERT(none.skipsField);
    GH_ASSERT(none.pressedEscape);
    GH_ASSERT(notice.clock.now - noticeStart < 1.2);   // not the 1.5 s "no list at all" timeout on top
    GH_ASSERT_EQUAL_INT(notice.presses, 1);            // the open attempt; the notice itself is never pressed
    GH_ASSERT_EQUAL_INT([notice.poster countOfKind:GHKeyStrokeKindReturn], 0);
    GH_ASSERT_EQUAL_OBJECTS(notice.combo.value, @"");
}

GH_TEST(combobox_highlight_that_never_reaches_the_choice_gives_up) {
    GHCBWorld *world = [GHCBWorld syntheticWorld];
    world.press = GHCBPressIgnored;
    world.filters = NO;
    world.arrowsWork = NO;
    GHComboBoxResult *result = [world answer:@"LinkedIn"];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHComboBoxReasonNoHighlight);
    GH_ASSERT(result.skipsField);
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:GHKeyStrokeKindDownArrow], 6);   // options + 3 tries, then stop
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:GHKeyStrokeKindReturn], 0);
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:GHKeyStrokeKindEscape], 1);
}

GH_TEST(combobox_press_that_picks_something_else_stops_the_walk) {
    GHCBWorld *world = [GHCBWorld syntheticWorld];
    world.press = GHCBPressSelectsOther;
    GHComboBoxResult *result = [world answer:@"LinkedIn"];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHComboBoxReasonNotVerified);
    GH_ASSERT(result.stopsWalk);
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:GHKeyStrokeKindReturn], 0);
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:GHKeyStrokeKindEscape], 0);
}

#pragma mark - refusals and aborts

GH_TEST(combobox_refusals_touch_nothing) {
    GHCBWorld *world = [GHCBWorld syntheticWorld];
    GH_ASSERT_EQUAL_OBJECTS([world answer:@""].reason, GHComboBoxReasonUnsupported);
    GH_ASSERT_EQUAL_OBJECTS([world answer:@"   "].reason, GHComboBoxReasonUnsupported);
    GH_ASSERT_EQUAL_OBJECTS([world answer:@"Linked\nIn"].reason, GHComboBoxReasonUnsupported);
    GH_ASSERT_EQUAL_OBJECTS([world choose:@"LinkedIn" in:CBNode(@"AXTextField", @"First Name")].reason, GHComboBoxReasonUnsupported);

    world.shownText.value = @"Referral";   // already answered
    GH_ASSERT_EQUAL_OBJECTS([world answer:@"LinkedIn"].reason, GHComboBoxReasonHasValue);
    world.shownText.value = @"Select...";
    world.combo.value = @"Lin";            // something typed there already
    GH_ASSERT_EQUAL_OBJECTS([world answer:@"LinkedIn"].reason, GHComboBoxReasonHasValue);
    world.combo.value = nil;

    world.combo.enabled = NO;
    GH_ASSERT_EQUAL_OBJECTS([world answer:@"LinkedIn"].reason, GHComboBoxReasonDisabled);
    world.combo.enabled = YES;

    world.driver.isNodeSensitive = nil;    // not wired: fail closed
    GH_ASSERT_EQUAL_OBJECTS([world answer:@"LinkedIn"].reason, GHComboBoxReasonSensitive);
    world.driver.isNodeSensitive = ^BOOL(id<GHAXNode> node) { return YES; };
    GH_ASSERT_EQUAL_OBJECTS([world answer:@"LinkedIn"].reason, GHComboBoxReasonSensitive);
    world.driver.isNodeSensitive = ^BOOL(id<GHAXNode> node) { return NO; };

    world.state.frontmostPID = 0;
    GH_ASSERT_EQUAL_OBJECTS([world answer:@"LinkedIn"].reason, GHComboBoxReasonNoFrontmostApp);
    world.state.frontmostPID = world.pid;

    [world.actuator.goneNodes addObject:world.combo];
    GH_ASSERT_EQUAL_OBJECTS([world answer:@"LinkedIn"].reason, GHComboBoxReasonGone);
    [world.actuator.goneNodes removeObject:world.combo];

    GHCBWorld *gender = [GHCBWorld syntheticWorldWithLabel:@"Gender"];
    GH_ASSERT_EQUAL_OBJECTS([gender answer:@"Female"].reason, GHComboBoxReasonDemographic);
    GH_ASSERT(CBTouchedNothing(gender));

    GH_ASSERT(CBTouchedNothing(world));
    GH_ASSERT([world answer:@"LinkedIn"].chosen);   // and the same world still works afterwards
}

GH_TEST(combobox_focus_that_does_not_arrive_or_leaves_before_typing_skips) {
    GHCBWorld *world = [GHCBWorld syntheticWorld];
    world.actuator.focusWorks = NO;
    GHComboBoxResult *result = [world answer:@"LinkedIn"];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHComboBoxReasonNotFocused);
    GH_ASSERT(result.skipsField);
    GH_ASSERT_EQUAL_INT(world.poster.posted.count, 0);

    // Focus is on the combobox when checked, gone when the first chunk is about to go out.
    GHCBWorld *moved = [GHCBWorld syntheticWorld];
    __weak GHCBWorld *weakMoved = moved;
    moved.state.onFocusRead = ^(NSUInteger read) { if (read == 2) weakMoved.state.focusedNode = weakMoved.elsewhere; };
    GHComboBoxResult *skipped = [moved answer:@"LinkedIn"];
    GH_ASSERT_EQUAL_OBJECTS(skipped.reason, GHComboBoxReasonFocusChanged);
    GH_ASSERT(skipped.skipsField);
    GH_ASSERT_FALSE(skipped.typed);
    GH_ASSERT_EQUAL_INT(moved.poster.posted.count, 0);
    GH_ASSERT_EQUAL_OBJECTS(moved.elsewhere.value, nil);
}

GH_TEST(combobox_focus_lost_mid_typing_stops_the_walk) {
    GHCBWorld *world = [GHCBWorld syntheticWorld];
    world.options = @[ @"Referral from a current employee", @"Other" ];
    __weak GHCBWorld *weakWorld = world;
    world.afterPost = ^(GHKeyStroke *stroke) { if (stroke.kind == GHKeyStrokeKindText) [weakWorld focus:weakWorld.elsewhere]; };
    GHComboBoxResult *result = [world answer:@"Referral from a current employee"];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHComboBoxReasonTypingInterrupted);
    GH_ASSERT(result.stopsWalk);
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:GHKeyStrokeKindText], 1);
    GH_ASSERT_EQUAL_OBJECTS(world.elsewhere.value, nil);
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:GHKeyStrokeKindEscape], 0);
}

GH_TEST(combobox_user_key_or_app_switch_stops_without_another_key) {
    GHCBWorld *world = [GHCBWorld syntheticWorld];
    world.opensMenu = NO;
    __weak GHCBWorld *weakWorld = world;
    world.afterPost = ^(GHKeyStroke *stroke) { if (stroke.kind == GHKeyStrokeKindText) [weakWorld.driver noteUserKeyEvent]; };
    GHComboBoxResult *result = [world answer:@"LinkedIn"];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHComboBoxReasonUserKey);
    GH_ASSERT(result.stopsWalk);
    GH_ASSERT_EQUAL_OBJECTS(world.poster.postedNames, (@[ @"text" ]));

    GHCBWorld *switched = [GHCBWorld syntheticWorld];
    __weak GHCBWorld *weakSwitched = switched;
    switched.afterPost = ^(GHKeyStroke *stroke) { if (stroke.kind == GHKeyStrokeKindText) weakSwitched.state.frontmostPID = 1; };
    GHComboBoxResult *away = [switched answer:@"LinkedIn"];
    GH_ASSERT_EQUAL_OBJECTS(away.reason, GHComboBoxReasonAppChanged);
    GH_ASSERT_EQUAL_OBJECTS(switched.poster.postedNames, (@[ @"text" ]));
    // One press: the open attempt, made while this app WAS still in front. Nothing after the switch -- no option is
    // ever pressed into an app that is not in front.
    GH_ASSERT_EQUAL_INT(switched.presses, 1);

    // During the cleanup of a skip: the user's key wins, no backspaces follow.
    GHCBWorld *cleanup = [GHCBWorld syntheticWorld];
    cleanup.filters = NO;
    cleanup.escapeClears = NO;
    __weak GHCBWorld *weakCleanup = cleanup;
    cleanup.afterPost = ^(GHKeyStroke *stroke) { if (stroke.kind == GHKeyStrokeKindEscape) [weakCleanup.driver noteUserKeyEvent]; };
    GHComboBoxResult *interrupted = [cleanup answer:@"Twitter"];
    GH_ASSERT_EQUAL_OBJECTS(interrupted.reason, GHComboBoxReasonUserKey);
    GH_ASSERT_EQUAL_INT([cleanup.poster countOfKind:GHKeyStrokeKindBackspace], 0);

    // A key while nothing runs is not remembered.
    GHCBWorld *idle = [GHCBWorld syntheticWorld];
    [idle.driver noteUserKeyEvent];
    GH_ASSERT([idle answer:@"LinkedIn"].chosen);
}

GH_TEST(combobox_one_run_at_a_time_and_cancel_is_silent) {
    GHCBWorld *world = [GHCBWorld syntheticWorld];
    world.opensMenu = NO;
    __block GHComboBoxResult *first = nil;
    [world.driver chooseAnswer:@"LinkedIn" inComboBox:world.combo completion:^(GHComboBoxResult *r) { first = r; }];
    GH_ASSERT(world.driver.running);
    __block GHComboBoxResult *second = nil;
    [world.driver chooseAnswer:@"LinkedIn" inComboBox:world.combo completion:^(GHComboBoxResult *r) { second = r; }];
    GH_ASSERT_EQUAL_OBJECTS(second.reason, GHComboBoxReasonBusy);
    GH_ASSERT(second.stopsWalk);
    [world.driver cancel];
    GH_ASSERT_EQUAL_OBJECTS(first.reason, GHComboBoxReasonCancelled);
    [world.clock runUntil:^BOOL { return NO; }];   // stale timers post nothing
    GH_ASSERT_EQUAL_INT(world.poster.posted.count, 0);
    [world.driver cancel];
    world.driver.matcher = nil;         // null_resettable
    world.driver.isHighlighted = nil;
    GH_ASSERT(world.driver.matcher != nil && world.driver.isHighlighted != nil);
}

#pragma mark - what the real Greenhouse page turned out to expose (Safari, 2026-09-19)

/// Built from a live `ghostctl probe-combobox "How did you hear"` on
/// https://job-boards.greenhouse.io/viamrobotics/jobs/6185046004 in Safari. Every detail here was measured, not
/// assumed, and each one broke the driver before it was:
///   - the AXComboBox IS react-select's inner <input class="select__input">: 4 px wide, no children, AXPress;
///   - AXPress on it opens the menu (typing into it opened nothing at all);
///   - the menu is an AXList `select__menu-list`, a SIBLING of the combo box, two nodes further on, behind the
///     "Toggle flyout" AXButton and a 1 px AXStaticText;
///   - every row is AXStaticText with role description "text" whose label is in AXTitle and whose AXValue is EMPTY;
///   - the highlighted row is marked only by the class `select__option--is-focused`.
static GHCBNode *CBRealReactSelect(NSArray<NSString *> *options, NSInteger highlighted, BOOL menuOpen) {
    GHCBNode *form = (GHCBNode *)CBNode(@"AXGroup", nil);
    GHFakeAXNode *label = [form addChild:CBNode(@"AXStaticText", nil)];
    label.value = @"How did you hear about this opportunity at Viam?";
    label.domClassList = @[ @"label", @"select__label" ];
    GHFakeAXNode *log = [form addChild:CBNode(@"AXGroup", nil)];
    log.subrole = @"AXEmptyGroup";
    log.roleDescription = @"log";
    log.domClassList = @[ @"remix-css-7pg0cj-a11yText" ];
    GHFakeAXNode *placeholder = [form addChild:CBNode(@"AXGroup", nil)];
    placeholder.domClassList = @[ @"select__placeholder", @"remix-css-1jqq78o-placeholder" ];
    [placeholder addChild:[GHFakeAXNode staticText:@"Select..." frame:CGRectZero]];
    GHFakeAXNode *combo = [form addChild:CBNode(@"AXComboBox", @"How did you hear about this opportunity at Viam?")];
    combo.axDescription = combo.title;
    combo.roleDescription = @"combo box";
    combo.identifier = @"question_19909094004";
    combo.domClassList = @[ @"select__input" ];
    combo.frame = CGRectMake(316, 898, 4, 21);     // four pixels wide: this is the auto-sized inner input
    GHFakeAXNode *toggle = [form addChild:CBNode(@"AXButton", @"Toggle flyout")];
    toggle.axDescription = @"Toggle flyout";
    toggle.domClassList = @[ @"icon-button", @"icon-button--sm" ];
    [form addChild:CBNode(@"AXStaticText", nil)];  // the 1 px spacer between the control and the menu
    if (menuOpen) {
        GHCBNode *menu = (GHCBNode *)CBNode(@"AXList", nil);
        menu.roleDescription = @"list";
        menu.domClassList = @[ @"select__menu-list", @"remix-css-qr46ko" ];
        for (NSUInteger i = 0; i < options.count; i++) {
            GHFakeAXNode *row = [menu addChild:CBNode(@"AXStaticText", options[i])];
            row.roleDescription = @"text";
            row.domClassList = (NSInteger)i == highlighted ? @[ @"select__option", @"select__option--is-focused", @"remix-css-2ov8vj-option" ]
                                                           : @[ @"select__option", @"remix-css-18355b6-option" ];
        }
        [form addChild:menu];
    }
    // The next question, so that a menu can be claimed by the wrong control if the scan is sloppy.
    GHFakeAXNode *nextLabel = [form addChild:CBNode(@"AXStaticText", nil)];
    nextLabel.value = @"Are you legally authorized to work in the United States for any employer?";
    GHFakeAXNode *next = [form addChild:CBNode(@"AXComboBox", @"Are you legally authorized to work in the United States for any employer?")];
    next.roleDescription = @"combo box";
    next.domClassList = @[ @"select__input" ];
    GHFakeAXNode *web = CBNode(@"AXWebArea", nil);
    [web addChild:form];
    return form;
}

static NSArray<NSString *> *CBViamOptions(void) {
    // The eight rows the live probe read out of the open menu, in page order.
    return @[ @"LinkedIn", @"Indeed", @"A friend", @"TikTok", @"Instagram", @"Twitter", @"Meetup/Event", @"Other" ];
}

GH_TEST(combobox_real_react_select_menu_is_found_and_read_from_axtitle) {
    GHCBNode *form = CBRealReactSelect(CBViamOptions(), 2, YES);
    GHFakeAXNode *combo = nil, *menu = nil, *next = nil;
    for (id<GHAXNode> child in form.children) {
        if ([child.role isEqualToString:@"AXComboBox"] && !combo) combo = (GHFakeAXNode *)child;
        else if ([child.role isEqualToString:@"AXComboBox"]) next = (GHFakeAXNode *)child;
        if ([child.role isEqualToString:@"AXList"]) menu = (GHFakeAXNode *)child;
    }
    GH_ASSERT(combo != nil && menu != nil && next != nil);

    // The menu sits two siblings past the combo box, behind the "Toggle flyout" button: the scan must cross both.
    GH_ASSERT([GHComboBoxDriver listForComboBox:combo] == menu);
    // ...and the NEXT question, which sits after the menu, must not claim it.
    GH_ASSERT([GHComboBoxDriver listForComboBox:next] == nil);

    // The rows carry their text in AXTitle with an EMPTY AXValue. Reading AXValue (what the driver used to do) is
    // what made the real page report "no list": eight rows, zero options.
    NSArray<id<GHAXNode>> *options = [GHComboBoxDriver optionsInList:menu];
    GH_ASSERT_EQUAL_INT(options.count, 8);
    for (id<GHAXNode> option in options) GH_ASSERT_EQUAL_INT(option.value.length, 0);
    NSMutableArray<NSString *> *texts = [NSMutableArray array];
    for (id<GHAXNode> option in options) [texts addObject:[GHComboBoxDriver textOfOption:option]];
    GH_ASSERT_EQUAL_OBJECTS(texts, CBViamOptions());
    GH_ASSERT_FALSE([GHComboBoxDriver listSaysNothingFound:menu]);

    // The highlight is a CLASS, not AXFocused and not AXSelected: the arrow-key fallback's guard depends on it.
    GHComboBoxDriver *driver = [[GHComboBoxDriver alloc] initWithActuator:[[GHCBActuator alloc] init]
                                                                   poster:[[GHFakeKeyPoster alloc] initWithState:[[GHCBState alloc] init]]
                                                                    state:[[GHCBState alloc] init]];
    for (NSUInteger i = 0; i < options.count; i++) {
        GH_ASSERT_FALSE(options[i].isFocused);
        GH_ASSERT_EQUAL_INT(driver.isHighlighted(options[i]) ? 1 : 0, i == 2 ? 1 : 0);
    }

    // Closed, there is no menu to find and nothing looks like one.
    GHCBNode *closed = CBRealReactSelect(CBViamOptions(), -1, NO);
    for (id<GHAXNode> child in closed.children) {
        if ([child.role isEqualToString:@"AXComboBox"]) GH_ASSERT([GHComboBoxDriver listForComboBox:child] == nil);
    }
}

GH_TEST(combobox_real_react_select_is_answered_by_two_presses_and_no_keystroke) {
    GHCBWorld *world = [GHCBWorld syntheticWorld];
    world.webkitOptions = YES;     // rows are AXTitle-only AXStaticText marked by class
    world.pressOpens = YES;        // AXPress on the combo box opens the menu, as react-select really does
    world.options = CBViamOptions();
    GHComboBoxResult *result = [world answer:@"LinkedIn"];
    GH_ASSERT_MSG(result.chosen, @"%@ %@", result.reason, @(result.optionCount));
    GH_ASSERT_EQUAL_OBJECTS(result.method, GHComboBoxMethodPress);
    GH_ASSERT_EQUAL_OBJECTS(world.selected, @"LinkedIn");
    GH_ASSERT_EQUAL_INT(result.optionCount, 8);
    GH_ASSERT_NEAR(result.score, 1.0, 1e-9);
    // The whole answer cost the page TWO AXPresses and not one key event: nothing was typed into the site.
    GH_ASSERT_EQUAL_INT(world.presses, 2);
    GH_ASSERT_FALSE(result.typed);
    GH_ASSERT_EQUAL_INT(world.poster.posted.count, 0);
    GH_ASSERT_EQUAL_INT(world.escapes, 0);
}

GH_TEST(combobox_press_opened_menu_without_a_match_is_closed_and_the_field_skipped) {
    GHCBWorld *world = [GHCBWorld syntheticWorld];
    world.webkitOptions = YES;
    world.pressOpens = YES;
    world.filters = YES;           // typing narrows, so the fallback filter really runs
    world.options = CBViamOptions();
    GHComboBoxResult *result = [world answer:@"Hack the North"];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHComboBoxReasonNoMatchingOption);
    GH_ASSERT(result.skipsField);
    GH_ASSERT_FALSE(result.stopsWalk);
    // Nothing was chosen, the menu Ghost opened is closed again, and the field is exactly as it was found.
    GH_ASSERT_EQUAL_INT(world.selections, 0);
    GH_ASSERT(result.pressedEscape);
    GH_ASSERT(world.menu == nil);
    GH_ASSERT_EQUAL_OBJECTS(world.combo.value, @"");
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:GHKeyStrokeKindReturn], 0);
}

GH_TEST(combobox_eeo_and_work_authorization_are_never_even_pressed_open) {
    // The new press-to-open step runs AFTER the refusals, never before them.
    for (NSString *title in @[ @"Gender", @"Are you Hispanic/Latino?", @"Veteran Status", @"Disability Status" ]) {
        GHCBWorld *world = [GHCBWorld syntheticWorldWithLabel:title];
        world.pressOpens = YES;
        world.webkitOptions = YES;
        GHComboBoxResult *result = [world answer:@"Prefer not to say"];
        GH_ASSERT_EQUAL_OBJECTS(result.reason, GHComboBoxReasonDemographic);
        GH_ASSERT_MSG(CBTouchedNothing(world), @"%@ was touched", title);
    }
}

#pragma mark - declining (docs/answers.md section 1)

GH_TEST(combobox_decline_matcher_knows_every_ats_wording) {
    // The wordings shared/src/answers/classify.ts DECLINE_OPTION covers. Greenhouse alone ships three of them.
    NSArray<NSString *> *declines = @[ @"Decline To Self Identify", @"I don't wish to answer", @"I do not want to answer",
                                       @"Prefer not to say", @"Prefer not to disclose", @"I decline to answer",
                                       @"I choose not to disclose", @"Would rather not say", @"Not disclosed", @"No answer",
                                       @"I don’t wish to answer" ];
    for (NSString *decline in declines) {
        NSArray<NSString *> *options = @[ @"Male", @"Female", decline ];
        GHOptionMatch match = GHMatchDeclineOption(options, @"anything at all");
        GH_ASSERT_MSG(match.index == 2, @"%@ should be recognised as a decline", decline);
        GH_ASSERT_MSG(match.score >= GHComboBoxMatchThreshold, @"%@ should be certain", decline);
    }
    // No way to decline: nothing is picked, and nothing is guessed at.
    GHOptionMatch none = GHMatchDeclineOption(@[ @"Male", @"Female", @"Non-binary" ], @"I don't wish to answer");
    GH_ASSERT_EQUAL_INT(none.index, -1);
    GH_ASSERT_EQUAL_INT(GHMatchDeclineOption(@[], @"x").index, -1);
    // A question ABOUT declining is not an option that declines it.
    GH_ASSERT_EQUAL_INT(GHMatchDeclineOption(@[ @"Yes", @"No", @"Select..." ], @"x").index, -1);
    // The first way out wins, and a placeholder is never one.
    GHOptionMatch first = GHMatchDeclineOption(@[ @"Select...", @"Prefer not to say", @"Decline To Self Identify" ], @"x");
    GH_ASSERT_EQUAL_INT(first.index, 1);
}
