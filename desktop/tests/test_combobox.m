// SBComboBoxDriver without a keyboard or AX: a fake react-select (Greenhouse style: label, live log, placeholder,
// input, "Toggle flyout", menu inserted right after it) reacts to the fake poster, and a hand-driven clock runs
// every wait. Only SBFakeKeyPoster is used: nothing here can post a real event.
#import "SBTest.h"
#import "SBComboBoxDriver.h"
#import "SBKeyPoster.h"

#pragma mark - fakes

/// A fake node that owns an ordered, editable child list (a menu is inserted after the toggle and removed again).
@interface SBCBNode : SBFakeAXNode
- (void)insert:(SBFakeAXNode *)child after:(nullable id<SBAXNode>)sibling;
- (void)remove:(SBFakeAXNode *)child;
- (BOOL)holds:(SBFakeAXNode *)child;
@end

@implementation SBCBNode {
    NSMutableArray<SBFakeAXNode *> *_items;
}
- (NSMutableArray<SBFakeAXNode *> *)items {
    if (!_items) _items = [NSMutableArray array];
    return _items;
}
- (NSArray<id<SBAXNode>> *)children { return [self.items copy]; }
- (SBFakeAXNode *)addChild:(SBFakeAXNode *)child {
    child.parent = self;
    [self.items addObject:child];
    return child;
}
- (void)insert:(SBFakeAXNode *)child after:(id<SBAXNode>)sibling {
    child.parent = self;
    NSUInteger index = sibling ? [self.items indexOfObjectIdenticalTo:(SBFakeAXNode *)sibling] : NSNotFound;
    if (index == NSNotFound) [self.items addObject:child]; else [self.items insertObject:child atIndex:index + 1];
}
- (void)remove:(SBFakeAXNode *)child { [self.items removeObjectIdenticalTo:child]; }
- (BOOL)holds:(SBFakeAXNode *)child { return [self.items indexOfObjectIdenticalTo:child] != NSNotFound; }
@end

@interface SBCBClock : NSObject
@property (nonatomic) NSTimeInterval now;
@property (nonatomic, readonly) NSMutableArray<NSArray *> *timers;
@end

@implementation SBCBClock
- (instancetype)init {
    if ((self = [super init])) { _timers = [NSMutableArray array]; _now = 50; }
    return self;
}
- (void (^)(NSTimeInterval, dispatch_block_t))after {
    __weak SBCBClock *weakSelf = self;
    return ^(NSTimeInterval delay, dispatch_block_t block) {
        SBCBClock *clock = weakSelf;
        [clock.timers addObject:@[ @(clock.now + delay), [block copy] ]];
    };
}
- (NSTimeInterval (^)(void))clock {
    __weak SBCBClock *weakSelf = self;
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

@interface SBCBState : SBFakeDesktopState
/// Runs on every focus read (the poster reads focus right before each post), with the read's number.
@property (nonatomic, copy) void (^onFocusRead)(NSUInteger read);
@end

@implementation SBCBState
- (id<SBAXNode>)focusedElement {
    if (self.onFocusRead) self.onFocusRead(self.focusReads + 1);
    return [super focusedElement];
}
@end

@class SBCBWorld;

@interface SBCBActuator : SBFakeAXActuator
@property (nonatomic, weak) SBCBWorld *world;
@end

/// SBCBPressClosesOnly is what the REAL react-select on the live Greenhouse form does: a synthesized press on an
/// option row dismisses the menu and chooses nothing at all (the row answers a real mouse press).
typedef NS_ENUM(NSInteger, SBCBPress) { SBCBPressSelects, SBCBPressIgnored, SBCBPressFails, SBCBPressSelectsOther, SBCBPressClosesOnly };

/// A react-select combobox inside a flat form group, as on the real Greenhouse page.
@interface SBCBWorld : NSObject
@property (nonatomic) pid_t pid;
@property (nonatomic, strong) SBCBState *state;
@property (nonatomic, strong) SBFakeKeyPoster *poster;
@property (nonatomic, strong) SBCBActuator *actuator;
@property (nonatomic, strong) SBCBClock *clock;
@property (nonatomic, strong) SBComboBoxDriver *driver;

@property (nonatomic, strong) SBCBNode *container;
@property (nonatomic, strong) SBFakeAXNode *combo, *toggle, *shownText, *logText, *elsewhere;
@property (nonatomic, strong, nullable) SBCBNode *menu;
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
@property (nonatomic) SBCBPress press;
@property (nonatomic, copy) void (^afterPost)(SBKeyStroke *stroke);

// What happened.
@property (nonatomic) NSUInteger presses, escapes, returnsWithoutList, selections, pressOpensDone;
@property (nonatomic, copy) NSString *selected;

- (instancetype)initWithContainer:(SBCBNode *)container combo:(SBFakeAXNode *)combo;
+ (instancetype)syntheticWorldWithLabel:(NSString *)label;
+ (instancetype)syntheticWorld;
- (void)focus:(SBFakeAXNode *)node;
- (void)choose:(NSString *)text;
- (void)openMenu;
- (void)closeMenu;
- (void)highlightIndex:(NSInteger)index;
- (SBComboBoxResult *)choose:(NSString *)answer in:(id<SBAXNode>)combo;
- (SBComboBoxResult *)answer:(NSString *)answer;
@end

static BOOL CBIsInside(id<SBAXNode> node, id<SBAXNode> ancestor) {
    for (id<SBAXNode> up = node; up; up = up.parent) if (up == ancestor) return YES;
    return NO;
}

@implementation SBCBActuator
- (BOOL)focusNode:(id<SBAXNode>)node {
    BOOL ok = [super focusNode:node];
    if (ok) self.world.state.focusedNode = node;
    return ok;
}
- (BOOL)pressNode:(id<SBAXNode>)node {
    [super pressNode:node];
    SBCBWorld *world = self.world;
    world.presses++;
    if (world.pressOpens && node == world.combo && !world.menu) {
        if (world.maxPressOpens > 0 && world.pressOpensDone >= world.maxPressOpens) return YES;
        world.pressOpensDone++;
        [world openMenu];
        return YES;
    }
    if (!world.menu || !CBIsInside(node, world.menu)) return YES;
    switch (world.press) {
        case SBCBPressSelects: [world choose:[SBComboBoxDriver textOfOption:node]]; return YES;
        case SBCBPressIgnored: return YES;
        case SBCBPressFails: return NO;
        case SBCBPressSelectsOther: [world choose:@"Something else"]; return YES;
        case SBCBPressClosesOnly: [world closeMenu]; return YES;
    }
    return YES;
}
@end

static SBFakeAXNode *CBNode(NSString *role, NSString *title) {
    SBCBNode *node = [SBCBNode nodeWithRole:role];
    node.title = title;
    return node;
}

@implementation SBCBWorld

/// `combo` sits in `container` after [label, log group, placeholder group] and before its toggle button.
- (instancetype)initWithContainer:(SBCBNode *)container combo:(SBFakeAXNode *)combo {
    if ((self = [super init])) {
        _pid = 777;
        _state = [[SBCBState alloc] init];
        _state.frontmostPID = _pid;
        _poster = [[SBFakeKeyPoster alloc] initWithState:_state];
        _actuator = [[SBCBActuator alloc] init];
        _actuator.world = self;
        _clock = [[SBCBClock alloc] init];
        _container = container;
        _combo = combo;
        NSArray<id<SBAXNode>> *siblings = container.children;
        NSUInteger index = [siblings indexOfObjectIdenticalTo:combo];
        _toggle = index + 1 < siblings.count ? (SBFakeAXNode *)siblings[index + 1] : nil;
        SBFakeAXNode *placeholder = index >= 1 ? (SBFakeAXNode *)siblings[index - 1] : nil;
        SBFakeAXNode *log = index >= 2 ? (SBFakeAXNode *)siblings[index - 2] : nil;
        _shownText = (SBFakeAXNode *)placeholder.children.firstObject;
        _logText = [SBFakeAXNode staticText:@"" frame:CGRectZero];
        [log addChild:_logText];
        _elsewhere = (SBFakeAXNode *)CBNode(@"AXTextField", @"Somewhere else");
        _options = @[ @"Indeed", @"LinkedIn", @"Referral" ];
        _opensMenu = _highlightsFirst = _arrowsWork = _escapeClears = _typingLands = YES;
        _press = SBCBPressSelects;
        _highlight = -1;

        __weak SBCBWorld *weakSelf = self;
        _poster.onPost = ^(SBKeyStroke *stroke) { [weakSelf react:stroke]; };
        _driver = [[SBComboBoxDriver alloc] initWithActuator:_actuator poster:_poster state:_state];
        _driver.after = _clock.after;
        _driver.clock = _clock.clock;
        _driver.isNodeSensitive = ^BOOL(id<SBAXNode> node) { return NO; };
    }
    return self;
}

+ (instancetype)syntheticWorldWithLabel:(NSString *)label {
    SBCBNode *form = (SBCBNode *)CBNode(@"AXGroup", nil);
    form.subrole = @"AXLandmarkForm";
    [form addChild:[SBFakeAXNode staticText:label frame:CGRectZero]];
    SBFakeAXNode *log = [form addChild:CBNode(@"AXGroup", nil)];
    log.subrole = @"AXEmptyGroup";
    log.roleDescription = @"log";
    SBFakeAXNode *placeholder = [form addChild:CBNode(@"AXGroup", nil)];
    [placeholder addChild:[SBFakeAXNode staticText:@"Select..." frame:CGRectZero]];
    SBFakeAXNode *combo = [form addChild:CBNode(@"AXComboBox", label)];
    combo.axDescription = label;
    combo.roleDescription = @"combo box";
    [form addChild:CBNode(@"AXButton", @"Toggle flyout")];
    [form addChild:[SBFakeAXNode staticText:@"" frame:CGRectZero]];
    [form addChild:[SBFakeAXNode staticText:@"Are you legally authorized to work in the United States for any employer?" frame:CGRectZero]];
    [form addChild:CBNode(@"AXComboBox", @"Are you legally authorized to work in the United States for any employer?")];
    SBFakeAXNode *web = CBNode(@"AXWebArea", nil);
    [web addChild:form];
    return [[self alloc] initWithContainer:form combo:combo];
}

+ (instancetype)syntheticWorld {
    return [self syntheticWorldWithLabel:@"How did you hear about this opportunity at Viam?"];
}

- (void)focus:(SBFakeAXNode *)node {
    ((SBFakeAXNode *)self.state.focusedNode).isFocused = NO;
    node.isFocused = YES;
    self.state.focusedNode = node;
    self.actuator.focusedNode = node;
}

- (NSArray<SBFakeAXNode *> *)optionNodes {
    NSMutableArray<SBFakeAXNode *> *nodes = [NSMutableArray array];
    for (id<SBAXNode> child in self.menu.children) [nodes addObject:(SBFakeAXNode *)child];
    return nodes;
}

- (void)openMenu {
    [self closeMenu];
    NSString *typed = self.combo.value.lowercaseString ?: @"";
    NSMutableArray<NSString *> *shown = [NSMutableArray array];
    for (NSString *option in self.options) {
        if (!self.filters || typed.length == 0 || [option.lowercaseString containsString:typed]) [shown addObject:option];
    }
    SBCBNode *menu = (SBCBNode *)CBNode(@"AXList", nil);
    menu.roleDescription = @"list box";
    if (shown.count == 0) {
        [menu addChild:[SBFakeAXNode staticText:@"No options" frame:CGRectZero]];
    }
    for (NSString *option in shown) {
        if (self.explicitOptions) {
            SBFakeAXNode *row = [menu addChild:CBNode(@"AXGroup", nil)];
            row.roleDescription = @"option";
            [row addChild:[SBFakeAXNode staticText:option frame:CGRectZero]];
        } else if (self.webkitOptions) {
            SBFakeAXNode *row = [menu addChild:CBNode(@"AXStaticText", option)];   // text in AXTitle, AXValue empty
            row.roleDescription = @"text";
            row.domClassList = @[ @"select__option", @"remix-css-18355b6-option" ];
        } else {
            [menu addChild:[SBFakeAXNode staticText:option frame:CGRectZero]];
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
    NSArray<SBFakeAXNode *> *nodes = [self optionNodes];
    for (SBFakeAXNode *node in nodes) {
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
    SBFakeAXNode *shown = self.shownText;
    shown.value = @"";
    self.driver.after(self.driver.verifyDelay * (self.chosenTextLagLooks + 0.5), ^{ shown.value = text; });
}

- (void)react:(SBKeyStroke *)stroke {
    SBFakeAXNode *focused = (SBFakeAXNode *)self.state.focusedNode;
    BOOL inCombo = focused == self.combo;
    switch (stroke.kind) {
        case SBKeyStrokeKindText:
            if (!self.typingLands || !focused) break;
            focused.value = [focused.value ?: @"" stringByAppendingString:stroke.text];
            if (inCombo && self.opensMenu) [self openMenu];
            break;
        case SBKeyStrokeKindDownArrow:
        case SBKeyStrokeKindUpArrow:
            if (inCombo && self.menu && self.arrowsWork) {
                NSInteger step = stroke.kind == SBKeyStrokeKindDownArrow ? 1 : -1;
                NSInteger next = MAX(0, MIN((NSInteger)[self optionNodes].count - 1, self.highlight + step));
                [self highlightIndex:next];
            }
            break;
        case SBKeyStrokeKindReturn:
            if (inCombo && self.menu && self.highlight >= 0) [self choose:[SBComboBoxDriver textOfOption:[self optionNodes][(NSUInteger)self.highlight]]];
            else self.returnsWithoutList++;
            break;
        case SBKeyStrokeKindEscape:
            self.escapes++;
            [self closeMenu];
            if (inCombo && self.escapeClears) self.combo.value = @"";
            break;
        case SBKeyStrokeKindBackspace:
            if (focused.value.length) focused.value = [focused.value substringToIndex:focused.value.length - 1];
            break;
        default:
            break;
    }
    if (self.afterPost) self.afterPost(stroke);
}

- (SBComboBoxResult *)choose:(NSString *)answer in:(id<SBAXNode>)combo {
    __block SBComboBoxResult *result = nil;
    [self.driver chooseAnswer:answer inComboBox:combo completion:^(SBComboBoxResult *r) { result = r; }];
    [self.clock runUntil:^BOOL { return result != nil; }];
    return result;
}

- (SBComboBoxResult *)answer:(NSString *)answer {
    return [self choose:answer in:self.combo];
}

@end

static BOOL CBTouchedNothing(SBCBWorld *world) {
    return world.poster.posted.count == 0 && world.poster.guardCalls == 0 && world.actuator.focusCount == 0 && world.presses == 0;
}

#pragma mark - fixture

static SBCBNode *CBFixtureNode(NSDictionary *raw) {
    SBCBNode *node = [SBCBNode nodeWithRole:raw[@"role"] ?: @"AXUnknown"];
    NSDictionary *keys = @{ @"title": @"title", @"subrole": @"subrole", @"description": @"axDescription", @"roleDescription": @"roleDescription",
                            @"identifier": @"identifier", @"text": @"value" };
    for (NSString *key in keys) if ([raw[key] isKindOfClass:NSString.class]) [node setValue:raw[key] forKey:keys[key]];
    if (raw[@"enabled"]) node.enabled = [raw[@"enabled"] boolValue];
    for (NSDictionary *child in raw[@"children"]) [node addChild:CBFixtureNode(child)];
    return node;
}

static SBCBNode *CBGreenhouseWindow(void) {
    NSString *path = [@(__FILE__).stringByDeletingLastPathComponent stringByAppendingPathComponent:@"fixtures/greenhouse-safari-viam.json"];
    NSDictionary *fixture = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:path] ?: [NSData data] options:0 error:NULL];
    return [fixture[@"tree"] isKindOfClass:NSDictionary.class] ? CBFixtureNode(fixture[@"tree"]) : nil;
}

static void CBCollect(id<SBAXNode> root, NSString *role, NSMutableArray *out) {
    if ([root.role isEqualToString:role]) [out addObject:root];
    for (id<SBAXNode> child in root.children) CBCollect(child, role, out);
}

static SBFakeAXNode *CBComboTitled(id<SBAXNode> window, NSString *title) {
    NSMutableArray<id<SBAXNode>> *combos = [NSMutableArray array];
    CBCollect(window, @"AXComboBox", combos);
    for (id<SBAXNode> combo in combos) if ([combo.title isEqualToString:title]) return (SBFakeAXNode *)combo;
    return nil;
}

#pragma mark - pure rules

GH_TEST(combobox_match_option_port_pins_the_shared_cases) {
    SBOptionMatch m = SBMatchOption(@[ @"Select...", @"Indeed", @"LinkedIn" ], @"LinkedIn");
    GH_ASSERT_EQUAL_INT(m.index, 2);
    GH_ASSERT_NEAR(m.score, 1.0, 1e-9);
    m = SBMatchOption(@[ @"Yes, I am authorized", @"No, I am not" ], @"Yes");
    GH_ASSERT_EQUAL_INT(m.index, 0);
    GH_ASSERT_NEAR(m.score, 0.95, 1e-9);
    GH_ASSERT_EQUAL_INT(SBMatchOption(@[ @"Yes", @"No" ], @"no").index, 1);
    GH_ASSERT_EQUAL_INT(SBMatchOption(@[ @"Yes", @"Yes, with sponsorship" ], @"yes").index, 0);   // exact 1 beats 0.95
    // Two equally good answers are a guess, not an answer.
    GH_ASSERT_EQUAL_INT(SBMatchOption(@[ @"Yes, as a citizen", @"Yes, with a permit" ], @"Yes").index, -1);
    m = SBMatchOption(@[ @"Hack the North 2026", @"Other" ], @"Hack the North");
    GH_ASSERT_EQUAL_INT(m.index, 0);
    GH_ASSERT_NEAR(m.score, 0.88, 1e-9);
    GH_ASSERT_EQUAL_INT(SBMatchOption(@[ @"University of Toronto" ], @"University of Waterloo").index, -1);
    GH_ASSERT_EQUAL_INT(SBMatchOption(@[ @"University" ], @"University of Waterloo").index, -1);
    GH_ASSERT_EQUAL_INT(SBMatchOption(@[ @"Arkansas" ], @"AR").index, -1);   // never substrings
    GH_ASSERT_EQUAL_INT(SBMatchOption(@[ @"LinkedIn", @"Indeed" ], @"Twitter").index, -1);
    GH_ASSERT_EQUAL_INT(SBMatchOption(@[ @"Select one", @"-- choose --" ], @"Select one").index, -1);   // placeholders are never options
    GH_ASSERT_EQUAL_INT(SBMatchOption(@[ @"linked_in" ], @"Linked In").index, 0);   // shared normalize()
    GH_ASSERT_EQUAL_INT(SBMatchOption(@[], @"Yes").index, -1);
    GH_ASSERT_EQUAL_INT(SBMatchOption(@[ @"Yes" ], @"").index, -1);
    GH_ASSERT_NEAR(SBComboBoxMatchThreshold, 0.7, 1e-9);
}

GH_TEST(combobox_demographic_questions_are_recognised) {
    for (NSString *text in @[ @"Gender", @"Are you Hispanic/Latino?", @"Veteran Status", @"Disability Status", @"Pronouns", @"Race & Ethnicity",
                              @"Sexual orientation", @"Date of Birth", @"What is your age?", @"Birthdate", @"hispanic_ethnicity", @"veteranStatus",
                              @"Do you identify as transgender?" ]) {
        GH_ASSERT_MSG([SBComboBoxDriver isDemographicText:text], @"should be demographic: %@", text);
    }
    for (NSString *text in @[ @"Country", @"How did you hear about this opportunity at Viam?", @"Language", @"Page", @"Manager", @"Message",
                              @"Are you legally authorized to work in the United States for any employer?", @"Stage", @"" ]) {
        GH_ASSERT_MSG(![SBComboBoxDriver isDemographicText:text], @"should not be demographic: %@", text);
    }
}

GH_TEST(combobox_real_greenhouse_eeo_questions_are_never_touched) {
    SBCBNode *window = CBGreenhouseWindow();
    GH_ASSERT(window != nil);
    NSMutableArray<id<SBAXNode>> *combos = [NSMutableArray array];
    CBCollect(window, @"AXComboBox", combos);
    GH_ASSERT_EQUAL_INT(combos.count, 7);
    NSMutableSet<NSString *> *eeo = [NSMutableSet set];
    for (id<SBAXNode> combo in combos) if ([SBComboBoxDriver isDemographicComboBox:combo]) [eeo addObject:combo.title];
    GH_ASSERT_EQUAL_OBJECTS(eeo, ([NSSet setWithArray:@[ @"Gender", @"Are you Hispanic/Latino?", @"Veteran Status", @"Disability Status" ]]));

    for (NSString *title in eeo) {
        SBFakeAXNode *combo = CBComboTitled(window, title);
        SBCBWorld *world = [[SBCBWorld alloc] initWithContainer:(SBCBNode *)combo.parent combo:combo];
        SBComboBoxResult *result = [world answer:@"Decline to self-identify"];
        GH_ASSERT_EQUAL_OBJECTS(result.reason, SBComboBoxReasonDemographic);
        GH_ASSERT(result.skipsField);
        GH_ASSERT(CBTouchedNothing(world));
    }
}

GH_TEST(combobox_real_greenhouse_list_detection) {
    SBCBNode *window = CBGreenhouseWindow();
    NSMutableArray<id<SBAXNode>> *combos = [NSMutableArray array];
    CBCollect(window, @"AXComboBox", combos);
    // Nothing is open: the posting's bulleted AXContentLists are never taken for a menu.
    for (id<SBAXNode> combo in combos) GH_ASSERT_MSG([SBComboBoxDriver listForComboBox:combo] == nil, @"%@", combo.title);
    // Every combobox shows "Select..." (or nothing): no value yet.
    for (id<SBAXNode> combo in combos) GH_ASSERT_EQUAL_INT([SBComboBoxDriver shownTextsForComboBox:combo typed:nil].count, 0);

    SBFakeAXNode *heard = CBComboTitled(window, @"How did you hear about this opportunity at Viam?");
    SBCBWorld *world = [[SBCBWorld alloc] initWithContainer:(SBCBNode *)heard.parent combo:heard];
    [world openMenu];
    GH_ASSERT([SBComboBoxDriver listForComboBox:heard] == world.menu);
    // The next question's combobox does not claim a menu that sits before it.
    GH_ASSERT([SBComboBoxDriver listForComboBox:CBComboTitled(window, @"Are you legally authorized to work in the United States for any employer?")] == nil);
}

GH_TEST(combobox_list_search_stops_at_a_hung_app) {
    SBCBWorld *world = [SBCBWorld syntheticWorld];
    [world openMenu];
    GH_ASSERT([SBComboBoxDriver listForComboBox:world.combo] == world.menu);
    // The web process stops answering: the menu is not "found" through a node that did not answer, and nothing
    // behind it is read.
    world.menu.lastError = kAXErrorCannotComplete;
    NSUInteger reads = world.menu.childrenReadCount;
    GH_ASSERT([SBComboBoxDriver listForComboBox:world.combo] == nil);
    GH_ASSERT_EQUAL_INT(world.menu.childrenReadCount, reads);
    world.menu.lastError = kAXErrorSuccess;
    GH_ASSERT([SBComboBoxDriver listForComboBox:world.combo] == world.menu);
}

GH_TEST(combobox_list_and_option_detection_rules) {
    SBCBWorld *world = [SBCBWorld syntheticWorld];
    // A checkbox group right after the combobox is not its menu.
    SBCBNode *checks = (SBCBNode *)CBNode(@"AXList", nil);
    SBFakeAXNode *row = [checks addChild:CBNode(@"AXGroup", nil)];
    [row addChild:CBNode(@"AXCheckBox", @"Yes")];
    [row addChild:[SBFakeAXNode staticText:@"Yes" frame:CGRectZero]];
    [world.container insert:checks after:world.toggle];
    GH_ASSERT([SBComboBoxDriver listForComboBox:world.combo] == nil);
    [world.container remove:checks];
    // Neither is a content list.
    SBCBNode *bullets = (SBCBNode *)CBNode(@"AXList", nil);
    bullets.subrole = @"AXContentList";
    [bullets addChild:[SBFakeAXNode staticText:@"Free lunch" frame:CGRectZero]];
    [world.container insert:bullets after:world.toggle];
    GH_ASSERT([SBComboBoxDriver listForComboBox:world.combo] == nil);
    [world.container remove:bullets];

    // Explicit option rows win over loose text, and their text comes from inside.
    world.explicitOptions = YES;
    [world openMenu];
    GH_ASSERT([SBComboBoxDriver listForComboBox:world.combo] == world.menu);
    NSArray<id<SBAXNode>> *options = [SBComboBoxDriver optionsInList:world.menu];
    GH_ASSERT_EQUAL_INT(options.count, 3);
    GH_ASSERT_EQUAL_OBJECTS(options[0].roleDescription, @"option");
    GH_ASSERT_EQUAL_OBJECTS([SBComboBoxDriver textOfOption:options[1]], @"LinkedIn");
    [world closeMenu];

    // "No options" is a notice, never an option.
    SBCBNode *notice = (SBCBNode *)CBNode(@"AXList", nil);
    notice.roleDescription = @"list box";
    [notice addChild:[SBFakeAXNode staticText:@"No options" frame:CGRectZero]];
    GH_ASSERT_EQUAL_INT([SBComboBoxDriver optionsInList:notice].count, 0);

    // A menu rendered in a portal at the end of the page is found too.
    SBCBNode *web = (SBCBNode *)CBNode(@"AXWebArea", nil);
    SBCBNode *form = (SBCBNode *)[web addChild:CBNode(@"AXGroup", nil)];
    SBFakeAXNode *combo = [form addChild:CBNode(@"AXComboBox", @"Location")];
    [form addChild:CBNode(@"AXTextField", @"Next field")];
    SBCBNode *portal = (SBCBNode *)[web addChild:CBNode(@"AXGroup", nil)];
    SBFakeAXNode *menu = [portal addChild:CBNode(@"AXMenu", nil)];
    [menu addChild:CBNode(@"AXMenuItem", @"Toronto, ON")];
    GH_ASSERT([SBComboBoxDriver listForComboBox:combo] == menu);
    GH_ASSERT_EQUAL_OBJECTS([SBComboBoxDriver textOfOption:[SBComboBoxDriver optionsInList:menu][0]], @"Toronto, ON");

    GH_ASSERT([SBComboBoxDriver isComboBox:world.combo]);
    SBFakeAXNode *textCombo = CBNode(@"AXTextField", @"City");
    textCombo.roleDescription = @"combo box";
    GH_ASSERT([SBComboBoxDriver isComboBox:textCombo]);
    GH_ASSERT_FALSE([SBComboBoxDriver isComboBox:CBNode(@"AXTextField", @"City")]);
}

GH_TEST(combobox_shown_texts_skip_placeholder_log_label_and_typing) {
    SBCBWorld *world = [SBCBWorld syntheticWorld];
    GH_ASSERT_EQUAL_INT([SBComboBoxDriver shownTextsForComboBox:world.combo typed:nil].count, 0);
    world.logText.value = @"Select is focused, type to refine list";
    GH_ASSERT_EQUAL_INT([SBComboBoxDriver shownTextsForComboBox:world.combo typed:nil].count, 0);
    world.combo.value = @"Link";
    GH_ASSERT_EQUAL_INT([SBComboBoxDriver shownTextsForComboBox:world.combo typed:@"Link"].count, 0);
    GH_ASSERT_EQUAL_OBJECTS([SBComboBoxDriver shownTextsForComboBox:world.combo typed:nil], (@[ @"Link" ]));
    world.combo.value = @"";
    world.shownText.value = @"LinkedIn";
    GH_ASSERT_EQUAL_OBJECTS([SBComboBoxDriver shownTextsForComboBox:world.combo typed:nil], (@[ @"LinkedIn" ]));
}

#pragma mark - choosing

GH_TEST(combobox_types_presses_the_option_and_verifies) {
    SBCBWorld *world = [SBCBWorld syntheticWorld];
    SBComboBoxResult *result = [world answer:@"LinkedIn"];
    GH_ASSERT_MSG(result.chosen, @"%@", result);
    GH_ASSERT_EQUAL_OBJECTS(result.method, SBComboBoxMethodPress);
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
    SBCBNode *window = CBGreenhouseWindow();
    SBFakeAXNode *heard = CBComboTitled(window, @"How did you hear about this opportunity at Viam?");
    SBCBWorld *world = [[SBCBWorld alloc] initWithContainer:(SBCBNode *)heard.parent combo:heard];
    world.filters = YES;
    SBComboBoxResult *result = [world answer:@"LinkedIn"];
    GH_ASSERT_MSG(result.chosen, @"%@", result);
    GH_ASSERT_EQUAL_OBJECTS(world.shownText.value, @"LinkedIn");
    GH_ASSERT_EQUAL_INT(result.optionCount, 1);

    SBFakeAXNode *authorized = CBComboTitled(window, @"Are you legally authorized to work in the United States for any employer?");
    SBCBWorld *yes = [[SBCBWorld alloc] initWithContainer:(SBCBNode *)authorized.parent combo:authorized];
    yes.options = @[ @"Yes", @"No" ];
    yes.filters = NO;
    SBComboBoxResult *answered = [yes answer:@"Yes"];
    GH_ASSERT_MSG(answered.chosen, @"%@", answered);
    GH_ASSERT_EQUAL_OBJECTS(yes.selected, @"Yes");
}

GH_TEST(combobox_press_that_does_nothing_falls_back_to_arrows_and_return) {
    for (NSNumber *mode in @[ @(SBCBPressIgnored), @(SBCBPressFails) ]) {
        SBCBWorld *world = [SBCBWorld syntheticWorld];
        world.press = (SBCBPress)mode.integerValue;
        world.options = @[ @"Indeed", @"LinkedIn", @"Referral" ];
        world.filters = NO;   // all three stay listed, "Indeed" highlighted first
        SBComboBoxResult *result = [world answer:@"LinkedIn"];
        GH_ASSERT_MSG(result.chosen, @"%@", result);
        GH_ASSERT_EQUAL_OBJECTS(result.method, SBComboBoxMethodKeys);
        GH_ASSERT_EQUAL_OBJECTS(world.poster.postedNames, (@[ @"text", @"down", @"return" ]));
        GH_ASSERT_EQUAL_OBJECTS(world.selected, @"LinkedIn");
        GH_ASSERT_EQUAL_INT(world.returnsWithoutList, 0);
    }
    // Nothing highlighted yet: Down first highlights, then walks.
    SBCBWorld *world = [SBCBWorld syntheticWorld];
    world.press = SBCBPressIgnored;
    world.filters = NO;
    world.highlightsFirst = NO;
    SBComboBoxResult *result = [world answer:@"Referral"];
    GH_ASSERT_MSG(result.chosen, @"%@", result);
    GH_ASSERT_EQUAL_OBJECTS(world.poster.postedNames, (@[ @"text", @"down", @"down", @"down", @"return" ]));
}

// What the LIVE Greenhouse form did on 2026-09-19: the menu opened on a press, the option matched 1.00, the press
// on the row closed the menu and chose NOTHING, and the run reported combobox-not-verified for all five remaining
// questions. The row answers a real mouse press; a synthesized one only dismisses the menu. So: open it again and
// use the keyboard, which is the path a person without a mouse takes anyway.
GH_TEST(combobox_press_that_only_closes_the_menu_reopens_it_and_uses_the_keyboard) {
    SBCBNode *window = CBGreenhouseWindow();
    SBFakeAXNode *authorized = CBComboTitled(window, @"Are you legally authorized to work in the United States for any employer?");
    SBCBWorld *world = [[SBCBWorld alloc] initWithContainer:(SBCBNode *)authorized.parent combo:authorized];
    world.options = @[ @"Yes", @"No" ];
    world.filters = NO;
    world.pressOpens = YES;       // react-select opens on a press, so nothing is ever typed here
    world.webkitOptions = YES;    // rows are AXStaticText marked only by their DOM class
    world.press = SBCBPressClosesOnly;

    SBComboBoxResult *result = [world answer:@"No"];
    GH_ASSERT_MSG(result.chosen, @"%@", result);
    GH_ASSERT_EQUAL_OBJECTS(result.method, SBComboBoxMethodKeys);
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
    SBCBWorld *world = [SBCBWorld syntheticWorldWithLabel:@"Gender"];
    world.options = @[ @"Male", @"Female", @"Decline To Self Identify" ];
    world.filters = NO;
    world.pressOpens = YES;
    world.webkitOptions = YES;
    world.press = SBCBPressClosesOnly;

    __block SBComboBoxResult *result = nil;
    [world.driver chooseAnswer:@"Prefer not to say" inComboBox:world.combo decline:YES completion:^(SBComboBoxResult *r) { result = r; }];
    [world.clock runUntil:^BOOL { return result != nil; }];
    GH_ASSERT_MSG(result.chosen, @"%@", result);
    GH_ASSERT_EQUAL_OBJECTS(world.selected, @"Decline To Self Identify");   // the form's own wording, never ours
    GH_ASSERT_FALSE(result.typed);
    GH_ASSERT_EQUAL_OBJECTS(world.poster.postedNames, (@[ @"down", @"down", @"return" ]));
}

// A press that DID choose, on a page whose accessibility tree catches up a few looks later: no second choice, no
// re-open, and the run still reports the press as the method.
GH_TEST(combobox_press_is_verified_when_the_page_catches_up_late) {
    SBCBWorld *world = [SBCBWorld syntheticWorld];
    world.pressOpens = YES;
    world.webkitOptions = YES;
    world.filters = NO;
    world.chosenTextLagLooks = 3;   // the page chose, but says so only after three more looks
    SBComboBoxResult *result = [world answer:@"LinkedIn"];
    GH_ASSERT_MSG(result.chosen, @"%@", result);
    GH_ASSERT_EQUAL_OBJECTS(result.method, SBComboBoxMethodPress);
    GH_ASSERT_EQUAL_INT(world.presses, 2);     // open, the option: never a third
    GH_ASSERT_EQUAL_INT(world.selections, 1);
}

// A press that chose the WRONG option is never answered with a second choice, however long the run looks.
GH_TEST(combobox_press_that_picks_something_else_is_never_reopened) {
    SBCBWorld *world = [SBCBWorld syntheticWorld];
    world.pressOpens = YES;
    world.webkitOptions = YES;
    world.filters = NO;
    world.press = SBCBPressSelectsOther;
    SBComboBoxResult *result = [world answer:@"LinkedIn"];
    GH_ASSERT(result.stopsWalk);
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBComboBoxReasonNotVerified);
    GH_ASSERT_EQUAL_INT(world.presses, 2);
    GH_ASSERT_EQUAL_INT(world.selections, 1);
    GH_ASSERT_EQUAL_OBJECTS(world.selected, @"Something else");
}

// A control that will not open a second time is left exactly as the press found it: nothing typed, nothing chosen.
GH_TEST(combobox_that_will_not_reopen_is_left_alone) {
    SBCBWorld *world = [SBCBWorld syntheticWorld];
    world.pressOpens = YES;
    world.webkitOptions = YES;
    world.filters = NO;
    world.press = SBCBPressClosesOnly;
    world.maxPressOpens = 1;   // the menu never comes back
    SBComboBoxResult *result = [world answer:@"LinkedIn"];
    GH_ASSERT_FALSE(result.chosen);
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBComboBoxReasonNotVerified);
    GH_ASSERT_EQUAL_INT(world.selections, 0);
    GH_ASSERT_EQUAL_OBJECTS(world.poster.postedNames, @[]);
    GH_ASSERT_EQUAL_OBJECTS(world.shownText.value, @"Select...");
}

GH_TEST(combobox_neutral_matcher_ranks_the_least_committing_option_first) {
    // "Other" answers the question; declining merely ends it, so it ranks after the three that answer.
    GH_ASSERT_EQUAL_INT(SBMatchNeutralOption((@[ @"LinkedIn", @"Prefer not to say", @"Other" ]), @"").index, 2);
    GH_ASSERT_EQUAL_INT(SBMatchNeutralOption((@[ @"None of the above", @"N/A" ]), @"").index, 0);
    GH_ASSERT_EQUAL_INT(SBMatchNeutralOption((@[ @"Yes", @"No", @"Not applicable" ]), @"").index, 2);
    GH_ASSERT_EQUAL_INT(SBMatchNeutralOption((@[ @"Select...", @"Other" ]), @"").index, 1);   // never a placeholder
    GH_ASSERT_NEAR(SBMatchNeutralOption((@[ @"Other" ]), @"").score, 1.0, 1e-9);
    // A legal statement is not a neutral answer, and a list of real claims has no neutral option at all.
    GH_ASSERT_EQUAL_INT(SBMatchNeutralOption((@[ @"I certify that none of the above apply" ]), @"").index, -1);
    GH_ASSERT_EQUAL_INT(SBMatchNeutralOption((@[ @"Yes", @"No" ]), @"").index, -1);
    GH_ASSERT_EQUAL_INT(SBMatchNeutralOption(@[], @"").index, -1);
    // The exact list the LIVE Greenhouse "How did you hear" control showed on 2026-09-19.
    NSArray<NSString *> *live = @[ @"LinkedIn", @"Indeed", @"A friend", @"TikTok", @"Instagram", @"Twitter", @"Meetup/Event", @"Other" ];
    GH_ASSERT_EQUAL_INT(SBMatchNeutralOption(live, @"Hack the North").index, 7);
    GH_ASSERT_EQUAL_INT(SBMatchOption(live, @"Hack the North").index, -1);   // the fact itself is not on the list
}

// docs/answers.md section 3: an ORDINARY question whose profile fact is not among the options is still answered,
// with whatever the list itself calls the neutral choice. Live: "Hack the North" against eight named sources.
GH_TEST(combobox_answer_that_is_not_on_the_list_takes_the_lists_own_neutral_option) {
    SBCBWorld *world = [SBCBWorld syntheticWorld];
    world.options = @[ @"LinkedIn", @"Indeed", @"A friend", @"TikTok", @"Instagram", @"Twitter", @"Meetup/Event", @"Other" ];
    world.filters = NO;
    world.pressOpens = YES;
    world.webkitOptions = YES;

    __block SBComboBoxResult *result = nil;
    [world.driver chooseAnswer:@"Hack the North" inComboBox:world.combo decline:NO neutralFallback:YES completion:^(SBComboBoxResult *r) { result = r; }];
    [world.clock runUntil:^BOOL { return result != nil; }];
    GH_ASSERT_MSG(result.chosen, @"%@", result);
    GH_ASSERT(result.tookNeutral);
    GH_ASSERT_EQUAL_OBJECTS(world.selected, @"Other");
    GH_ASSERT_FALSE(result.typed);   // nothing is typed: a word the list does not have would filter it to nothing
}

GH_TEST(combobox_neutral_fallback_never_beats_a_real_match_and_never_invents_one) {
    // A real match still wins: the fallback only ever runs when the matcher found nothing.
    SBCBWorld *match = [SBCBWorld syntheticWorld];
    match.options = @[ @"LinkedIn", @"Other" ];
    match.filters = NO;
    match.pressOpens = YES;
    __block SBComboBoxResult *chosen = nil;
    [match.driver chooseAnswer:@"LinkedIn" inComboBox:match.combo decline:NO neutralFallback:YES completion:^(SBComboBoxResult *r) { chosen = r; }];
    [match.clock runUntil:^BOOL { return chosen != nil; }];
    GH_ASSERT(chosen.chosen);
    GH_ASSERT_FALSE(chosen.tookNeutral);
    GH_ASSERT_EQUAL_OBJECTS(match.selected, @"LinkedIn");

    // A list with no neutral option is left exactly as it was: a declaration's Yes/No is never "answered" for it.
    SBCBWorld *none = [SBCBWorld syntheticWorldWithLabel:@"Are you legally authorized to work in the United States for any employer?"];
    none.options = @[ @"Yes", @"No" ];
    none.filters = NO;
    none.pressOpens = YES;
    __block SBComboBoxResult *skipped = nil;
    [none.driver chooseAnswer:@"Maybe" inComboBox:none.combo decline:NO neutralFallback:YES completion:^(SBComboBoxResult *r) { skipped = r; }];
    [none.clock runUntil:^BOOL { return skipped != nil; }];
    GH_ASSERT(skipped.skipsField);
    GH_ASSERT_EQUAL_OBJECTS(skipped.reason, SBComboBoxReasonNoMatchingOption);
    GH_ASSERT_EQUAL_INT(none.selections, 0);
    GH_ASSERT_FALSE(skipped.tookNeutral);

    // Without the flag nothing changes: the field is skipped, as it was before the fallback existed.
    SBCBWorld *off = [SBCBWorld syntheticWorld];
    off.options = @[ @"LinkedIn", @"Other" ];
    off.filters = NO;
    off.pressOpens = YES;
    SBComboBoxResult *left = [off answer:@"Hack the North"];
    GH_ASSERT(left.skipsField);
    GH_ASSERT_EQUAL_INT(off.selections, 0);
}

GH_TEST(combobox_return_only_while_the_list_is_open_and_the_choice_highlighted) {
    // The list closes after an arrow: no Return at all.
    SBCBWorld *closing = [SBCBWorld syntheticWorld];
    closing.press = SBCBPressIgnored;
    closing.filters = NO;
    __weak SBCBWorld *weakClosing = closing;
    closing.afterPost = ^(SBKeyStroke *stroke) { if (stroke.kind == SBKeyStrokeKindDownArrow) [weakClosing closeMenu]; };
    SBComboBoxResult *closed = [closing answer:@"LinkedIn"];
    GH_ASSERT_EQUAL_OBJECTS(closed.reason, SBComboBoxReasonListClosed);
    GH_ASSERT(closed.stopsWalk);
    GH_ASSERT_EQUAL_INT([closing.poster countOfKind:SBKeyStrokeKindReturn], 0);

    // The highlight moves off the choice between the decision and the Return: the guard refuses it.
    SBCBWorld *moving = [SBCBWorld syntheticWorld];
    moving.press = SBCBPressIgnored;
    moving.filters = NO;
    __weak SBCBWorld *weakMoving = moving;
    moving.state.onFocusRead = ^(NSUInteger read) {
        SBCBWorld *world = weakMoving;
        if (world.menu && world.highlight == 1) [world highlightIndex:2];   // "LinkedIn" -> "Referral" right before the post
    };
    SBComboBoxResult *moved = [moving answer:@"LinkedIn"];
    GH_ASSERT_FALSE(moved.chosen);
    GH_ASSERT(moved.stopsWalk);
    GH_ASSERT_EQUAL_INT([moving.poster countOfKind:SBKeyStrokeKindReturn], 0);
    GH_ASSERT_EQUAL_INT(moving.selections, 0);
}

GH_TEST(combobox_without_a_matching_option_escapes_once_clears_and_skips) {
    SBCBWorld *world = [SBCBWorld syntheticWorld];
    world.filters = NO;
    SBComboBoxResult *result = [world answer:@"Twitter"];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBComboBoxReasonNoMatchingOption);
    GH_ASSERT(result.skipsField);
    GH_ASSERT(result.pressedEscape);
    GH_ASSERT(result.clearedTyping);
    GH_ASSERT_EQUAL_OBJECTS(world.poster.postedNames, (@[ @"text", @"escape" ]));
    GH_ASSERT_EQUAL_INT(world.presses, 1);        // the open attempt only; no option was ever pressed
    GH_ASSERT_EQUAL_OBJECTS(world.combo.value, @"");

    // A list whose Escape keeps the typed text: backspaces take exactly that back.
    SBCBWorld *sticky = [SBCBWorld syntheticWorld];
    sticky.filters = NO;
    sticky.escapeClears = NO;
    SBComboBoxResult *cleaned = [sticky answer:@"Twitter"];
    GH_ASSERT(cleaned.skipsField);
    GH_ASSERT(cleaned.clearedTyping);
    GH_ASSERT_EQUAL_INT([sticky.poster countOfKind:SBKeyStrokeKindBackspace], 7);
    GH_ASSERT_EQUAL_OBJECTS(sticky.combo.value, @"");

    // The list closed on its own before the Escape: nothing is open, so nothing is posted (it would reach the page).
    SBCBWorld *closed = [SBCBWorld syntheticWorld];
    closed.filters = NO;
    __weak SBCBWorld *weakClosed = closed;
    closed.driver.matcher = ^SBOptionMatch(NSArray<NSString *> *options, NSString *answer) {
        [weakClosed closeMenu];
        return (SBOptionMatch){ -1, 0 };
    };
    SBComboBoxResult *gone = [closed answer:@"Twitter"];
    GH_ASSERT_EQUAL_OBJECTS(gone.reason, SBComboBoxReasonNoMatchingOption);
    GH_ASSERT_FALSE(gone.pressedEscape);
    GH_ASSERT_EQUAL_INT([closed.poster countOfKind:SBKeyStrokeKindEscape], 0);
    GH_ASSERT_EQUAL_OBJECTS(closed.combo.value, @"");

    // Focus left meanwhile: nothing is deleted anywhere.
    SBCBWorld *left = [SBCBWorld syntheticWorld];
    left.filters = NO;
    left.escapeClears = NO;
    __weak SBCBWorld *weakLeft = left;
    left.afterPost = ^(SBKeyStroke *stroke) { if (stroke.kind == SBKeyStrokeKindEscape) [weakLeft focus:weakLeft.elsewhere]; };
    left.elsewhere.value = @"keep me";
    SBComboBoxResult *untouched = [left answer:@"Twitter"];
    GH_ASSERT(untouched.skipsField);
    GH_ASSERT_FALSE(untouched.clearedTyping);
    GH_ASSERT_EQUAL_INT([left.poster countOfKind:SBKeyStrokeKindBackspace], 0);
    GH_ASSERT_EQUAL_OBJECTS(left.elsewhere.value, @"keep me");

    // An injected matcher and the threshold decide.
    SBCBWorld *low = [SBCBWorld syntheticWorld];
    low.driver.matcher = ^SBOptionMatch(NSArray<NSString *> *options, NSString *answer) { return (SBOptionMatch){ 1, 0.69 }; };
    GH_ASSERT_EQUAL_OBJECTS([low answer:@"LinkedIn"].reason, SBComboBoxReasonNoMatchingOption);
    SBCBWorld *high = [SBCBWorld syntheticWorld];
    high.filters = NO;
    high.driver.matcher = ^SBOptionMatch(NSArray<NSString *> *options, NSString *answer) { return (SBOptionMatch){ 1, 0.7 }; };
    SBComboBoxResult *picked = [high answer:@"whatever"];
    GH_ASSERT(picked.chosen);
    GH_ASSERT_EQUAL_OBJECTS(high.selected, @"LinkedIn");
}

GH_TEST(combobox_list_that_never_opens_skips_after_one_and_a_half_seconds) {
    SBCBWorld *world = [SBCBWorld syntheticWorld];
    world.opensMenu = NO;
    NSTimeInterval start = world.clock.now;
    SBComboBoxResult *result = [world answer:@"LinkedIn"];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBComboBoxReasonNoList);
    GH_ASSERT(result.skipsField);
    // Focus settle, the press that opens nothing, the list that never comes, the cleanup.
    GH_ASSERT_NEAR(world.clock.now - start, 0.05 + 0.7 + 1.5 + 0.06, 0.12);
    // No list ever showed: an Escape would reach the page or the window (a modal closes, a sheet cancels). None.
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:SBKeyStrokeKindEscape], 0);
    GH_ASSERT_FALSE(result.pressedEscape);
    GH_ASSERT_EQUAL_OBJECTS(world.combo.value, @"");                // the typed text is taken back with backspaces

    // A list that only says "No options" IS open: the notice is never matched ("No" stays unanswered), but the menu
    // is closed at once with one Escape instead of waiting out the whole timeout with it hanging open.
    SBCBWorld *notice = [SBCBWorld syntheticWorld];
    notice.filters = YES;
    NSTimeInterval noticeStart = notice.clock.now;
    SBComboBoxResult *none = [notice answer:@"No"];
    GH_ASSERT_EQUAL_OBJECTS(none.reason, SBComboBoxReasonNoMatchingOption);
    GH_ASSERT(none.skipsField);
    GH_ASSERT(none.pressedEscape);
    GH_ASSERT(notice.clock.now - noticeStart < 1.2);   // not the 1.5 s "no list at all" timeout on top
    GH_ASSERT_EQUAL_INT(notice.presses, 1);            // the open attempt; the notice itself is never pressed
    GH_ASSERT_EQUAL_INT([notice.poster countOfKind:SBKeyStrokeKindReturn], 0);
    GH_ASSERT_EQUAL_OBJECTS(notice.combo.value, @"");
}

GH_TEST(combobox_highlight_that_never_reaches_the_choice_gives_up) {
    SBCBWorld *world = [SBCBWorld syntheticWorld];
    world.press = SBCBPressIgnored;
    world.filters = NO;
    world.arrowsWork = NO;
    SBComboBoxResult *result = [world answer:@"LinkedIn"];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBComboBoxReasonNoHighlight);
    GH_ASSERT(result.skipsField);
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:SBKeyStrokeKindDownArrow], 6);   // options + 3 tries, then stop
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:SBKeyStrokeKindReturn], 0);
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:SBKeyStrokeKindEscape], 1);
}

GH_TEST(combobox_press_that_picks_something_else_stops_the_walk) {
    SBCBWorld *world = [SBCBWorld syntheticWorld];
    world.press = SBCBPressSelectsOther;
    SBComboBoxResult *result = [world answer:@"LinkedIn"];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBComboBoxReasonNotVerified);
    GH_ASSERT(result.stopsWalk);
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:SBKeyStrokeKindReturn], 0);
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:SBKeyStrokeKindEscape], 0);
}

#pragma mark - refusals and aborts

GH_TEST(combobox_refusals_touch_nothing) {
    SBCBWorld *world = [SBCBWorld syntheticWorld];
    GH_ASSERT_EQUAL_OBJECTS([world answer:@""].reason, SBComboBoxReasonUnsupported);
    GH_ASSERT_EQUAL_OBJECTS([world answer:@"   "].reason, SBComboBoxReasonUnsupported);
    GH_ASSERT_EQUAL_OBJECTS([world answer:@"Linked\nIn"].reason, SBComboBoxReasonUnsupported);
    GH_ASSERT_EQUAL_OBJECTS([world choose:@"LinkedIn" in:CBNode(@"AXTextField", @"First Name")].reason, SBComboBoxReasonUnsupported);

    world.shownText.value = @"Referral";   // already answered
    GH_ASSERT_EQUAL_OBJECTS([world answer:@"LinkedIn"].reason, SBComboBoxReasonHasValue);
    world.shownText.value = @"Select...";
    world.combo.value = @"Lin";            // something typed there already
    GH_ASSERT_EQUAL_OBJECTS([world answer:@"LinkedIn"].reason, SBComboBoxReasonHasValue);
    world.combo.value = nil;

    world.combo.enabled = NO;
    GH_ASSERT_EQUAL_OBJECTS([world answer:@"LinkedIn"].reason, SBComboBoxReasonDisabled);
    world.combo.enabled = YES;

    world.driver.isNodeSensitive = nil;    // not wired: fail closed
    GH_ASSERT_EQUAL_OBJECTS([world answer:@"LinkedIn"].reason, SBComboBoxReasonSensitive);
    world.driver.isNodeSensitive = ^BOOL(id<SBAXNode> node) { return YES; };
    GH_ASSERT_EQUAL_OBJECTS([world answer:@"LinkedIn"].reason, SBComboBoxReasonSensitive);
    world.driver.isNodeSensitive = ^BOOL(id<SBAXNode> node) { return NO; };

    world.state.frontmostPID = 0;
    GH_ASSERT_EQUAL_OBJECTS([world answer:@"LinkedIn"].reason, SBComboBoxReasonNoFrontmostApp);
    world.state.frontmostPID = world.pid;

    [world.actuator.goneNodes addObject:world.combo];
    GH_ASSERT_EQUAL_OBJECTS([world answer:@"LinkedIn"].reason, SBComboBoxReasonGone);
    [world.actuator.goneNodes removeObject:world.combo];

    SBCBWorld *gender = [SBCBWorld syntheticWorldWithLabel:@"Gender"];
    GH_ASSERT_EQUAL_OBJECTS([gender answer:@"Female"].reason, SBComboBoxReasonDemographic);
    GH_ASSERT(CBTouchedNothing(gender));

    GH_ASSERT(CBTouchedNothing(world));
    GH_ASSERT([world answer:@"LinkedIn"].chosen);   // and the same world still works afterwards
}

GH_TEST(combobox_focus_that_does_not_arrive_or_leaves_before_typing_skips) {
    SBCBWorld *world = [SBCBWorld syntheticWorld];
    world.actuator.focusWorks = NO;
    SBComboBoxResult *result = [world answer:@"LinkedIn"];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBComboBoxReasonNotFocused);
    GH_ASSERT(result.skipsField);
    GH_ASSERT_EQUAL_INT(world.poster.posted.count, 0);

    // Focus is on the combobox when checked, gone when the first chunk is about to go out.
    SBCBWorld *moved = [SBCBWorld syntheticWorld];
    __weak SBCBWorld *weakMoved = moved;
    moved.state.onFocusRead = ^(NSUInteger read) { if (read == 2) weakMoved.state.focusedNode = weakMoved.elsewhere; };
    SBComboBoxResult *skipped = [moved answer:@"LinkedIn"];
    GH_ASSERT_EQUAL_OBJECTS(skipped.reason, SBComboBoxReasonFocusChanged);
    GH_ASSERT(skipped.skipsField);
    GH_ASSERT_FALSE(skipped.typed);
    GH_ASSERT_EQUAL_INT(moved.poster.posted.count, 0);
    GH_ASSERT_EQUAL_OBJECTS(moved.elsewhere.value, nil);
}

GH_TEST(combobox_focus_lost_mid_typing_stops_the_walk) {
    SBCBWorld *world = [SBCBWorld syntheticWorld];
    world.options = @[ @"Referral from a current employee", @"Other" ];
    __weak SBCBWorld *weakWorld = world;
    world.afterPost = ^(SBKeyStroke *stroke) { if (stroke.kind == SBKeyStrokeKindText) [weakWorld focus:weakWorld.elsewhere]; };
    SBComboBoxResult *result = [world answer:@"Referral from a current employee"];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBComboBoxReasonTypingInterrupted);
    GH_ASSERT(result.stopsWalk);
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:SBKeyStrokeKindText], 1);
    GH_ASSERT_EQUAL_OBJECTS(world.elsewhere.value, nil);
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:SBKeyStrokeKindEscape], 0);
}

GH_TEST(combobox_user_key_or_app_switch_stops_without_another_key) {
    SBCBWorld *world = [SBCBWorld syntheticWorld];
    world.opensMenu = NO;
    __weak SBCBWorld *weakWorld = world;
    world.afterPost = ^(SBKeyStroke *stroke) { if (stroke.kind == SBKeyStrokeKindText) [weakWorld.driver noteUserKeyEvent]; };
    SBComboBoxResult *result = [world answer:@"LinkedIn"];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBComboBoxReasonUserKey);
    GH_ASSERT(result.stopsWalk);
    GH_ASSERT_EQUAL_OBJECTS(world.poster.postedNames, (@[ @"text" ]));

    SBCBWorld *switched = [SBCBWorld syntheticWorld];
    __weak SBCBWorld *weakSwitched = switched;
    switched.afterPost = ^(SBKeyStroke *stroke) { if (stroke.kind == SBKeyStrokeKindText) weakSwitched.state.frontmostPID = 1; };
    SBComboBoxResult *away = [switched answer:@"LinkedIn"];
    GH_ASSERT_EQUAL_OBJECTS(away.reason, SBComboBoxReasonAppChanged);
    GH_ASSERT_EQUAL_OBJECTS(switched.poster.postedNames, (@[ @"text" ]));
    // One press: the open attempt, made while this app WAS still in front. Nothing after the switch -- no option is
    // ever pressed into an app that is not in front.
    GH_ASSERT_EQUAL_INT(switched.presses, 1);

    // During the cleanup of a skip: the user's key wins, no backspaces follow.
    SBCBWorld *cleanup = [SBCBWorld syntheticWorld];
    cleanup.filters = NO;
    cleanup.escapeClears = NO;
    __weak SBCBWorld *weakCleanup = cleanup;
    cleanup.afterPost = ^(SBKeyStroke *stroke) { if (stroke.kind == SBKeyStrokeKindEscape) [weakCleanup.driver noteUserKeyEvent]; };
    SBComboBoxResult *interrupted = [cleanup answer:@"Twitter"];
    GH_ASSERT_EQUAL_OBJECTS(interrupted.reason, SBComboBoxReasonUserKey);
    GH_ASSERT_EQUAL_INT([cleanup.poster countOfKind:SBKeyStrokeKindBackspace], 0);

    // A key while nothing runs is not remembered.
    SBCBWorld *idle = [SBCBWorld syntheticWorld];
    [idle.driver noteUserKeyEvent];
    GH_ASSERT([idle answer:@"LinkedIn"].chosen);
}

GH_TEST(combobox_one_run_at_a_time_and_cancel_is_silent) {
    SBCBWorld *world = [SBCBWorld syntheticWorld];
    world.opensMenu = NO;
    __block SBComboBoxResult *first = nil;
    [world.driver chooseAnswer:@"LinkedIn" inComboBox:world.combo completion:^(SBComboBoxResult *r) { first = r; }];
    GH_ASSERT(world.driver.running);
    __block SBComboBoxResult *second = nil;
    [world.driver chooseAnswer:@"LinkedIn" inComboBox:world.combo completion:^(SBComboBoxResult *r) { second = r; }];
    GH_ASSERT_EQUAL_OBJECTS(second.reason, SBComboBoxReasonBusy);
    GH_ASSERT(second.stopsWalk);
    [world.driver cancel];
    GH_ASSERT_EQUAL_OBJECTS(first.reason, SBComboBoxReasonCancelled);
    [world.clock runUntil:^BOOL { return NO; }];   // stale timers post nothing
    GH_ASSERT_EQUAL_INT(world.poster.posted.count, 0);
    [world.driver cancel];
    world.driver.matcher = nil;         // null_resettable
    world.driver.isHighlighted = nil;
    GH_ASSERT(world.driver.matcher != nil && world.driver.isHighlighted != nil);
}

#pragma mark - what the real Greenhouse page turned out to expose (Safari, 2026-09-19)

/// Built from a live `shabangctl probe-combobox "How did you hear"` on
/// https://job-boards.greenhouse.io/viamrobotics/jobs/6185046004 in Safari. Every detail here was measured, not
/// assumed, and each one broke the driver before it was:
///   - the AXComboBox IS react-select's inner <input class="select__input">: 4 px wide, no children, AXPress;
///   - AXPress on it opens the menu (typing into it opened nothing at all);
///   - the menu is an AXList `select__menu-list`, a SIBLING of the combo box, two nodes further on, behind the
///     "Toggle flyout" AXButton and a 1 px AXStaticText;
///   - every row is AXStaticText with role description "text" whose label is in AXTitle and whose AXValue is EMPTY;
///   - the highlighted row is marked only by the class `select__option--is-focused`.
static SBCBNode *CBRealReactSelect(NSArray<NSString *> *options, NSInteger highlighted, BOOL menuOpen) {
    SBCBNode *form = (SBCBNode *)CBNode(@"AXGroup", nil);
    SBFakeAXNode *label = [form addChild:CBNode(@"AXStaticText", nil)];
    label.value = @"How did you hear about this opportunity at Viam?";
    label.domClassList = @[ @"label", @"select__label" ];
    SBFakeAXNode *log = [form addChild:CBNode(@"AXGroup", nil)];
    log.subrole = @"AXEmptyGroup";
    log.roleDescription = @"log";
    log.domClassList = @[ @"remix-css-7pg0cj-a11yText" ];
    SBFakeAXNode *placeholder = [form addChild:CBNode(@"AXGroup", nil)];
    placeholder.domClassList = @[ @"select__placeholder", @"remix-css-1jqq78o-placeholder" ];
    [placeholder addChild:[SBFakeAXNode staticText:@"Select..." frame:CGRectZero]];
    SBFakeAXNode *combo = [form addChild:CBNode(@"AXComboBox", @"How did you hear about this opportunity at Viam?")];
    combo.axDescription = combo.title;
    combo.roleDescription = @"combo box";
    combo.identifier = @"question_19909094004";
    combo.domClassList = @[ @"select__input" ];
    combo.frame = CGRectMake(316, 898, 4, 21);     // four pixels wide: this is the auto-sized inner input
    SBFakeAXNode *toggle = [form addChild:CBNode(@"AXButton", @"Toggle flyout")];
    toggle.axDescription = @"Toggle flyout";
    toggle.domClassList = @[ @"icon-button", @"icon-button--sm" ];
    [form addChild:CBNode(@"AXStaticText", nil)];  // the 1 px spacer between the control and the menu
    if (menuOpen) {
        SBCBNode *menu = (SBCBNode *)CBNode(@"AXList", nil);
        menu.roleDescription = @"list";
        menu.domClassList = @[ @"select__menu-list", @"remix-css-qr46ko" ];
        for (NSUInteger i = 0; i < options.count; i++) {
            SBFakeAXNode *row = [menu addChild:CBNode(@"AXStaticText", options[i])];
            row.roleDescription = @"text";
            row.domClassList = (NSInteger)i == highlighted ? @[ @"select__option", @"select__option--is-focused", @"remix-css-2ov8vj-option" ]
                                                           : @[ @"select__option", @"remix-css-18355b6-option" ];
        }
        [form addChild:menu];
    }
    // The next question, so that a menu can be claimed by the wrong control if the scan is sloppy.
    SBFakeAXNode *nextLabel = [form addChild:CBNode(@"AXStaticText", nil)];
    nextLabel.value = @"Are you legally authorized to work in the United States for any employer?";
    SBFakeAXNode *next = [form addChild:CBNode(@"AXComboBox", @"Are you legally authorized to work in the United States for any employer?")];
    next.roleDescription = @"combo box";
    next.domClassList = @[ @"select__input" ];
    SBFakeAXNode *web = CBNode(@"AXWebArea", nil);
    [web addChild:form];
    return form;
}

static NSArray<NSString *> *CBViamOptions(void) {
    // The eight rows the live probe read out of the open menu, in page order.
    return @[ @"LinkedIn", @"Indeed", @"A friend", @"TikTok", @"Instagram", @"Twitter", @"Meetup/Event", @"Other" ];
}

GH_TEST(combobox_real_react_select_menu_is_found_and_read_from_axtitle) {
    SBCBNode *form = CBRealReactSelect(CBViamOptions(), 2, YES);
    SBFakeAXNode *combo = nil, *menu = nil, *next = nil;
    for (id<SBAXNode> child in form.children) {
        if ([child.role isEqualToString:@"AXComboBox"] && !combo) combo = (SBFakeAXNode *)child;
        else if ([child.role isEqualToString:@"AXComboBox"]) next = (SBFakeAXNode *)child;
        if ([child.role isEqualToString:@"AXList"]) menu = (SBFakeAXNode *)child;
    }
    GH_ASSERT(combo != nil && menu != nil && next != nil);

    // The menu sits two siblings past the combo box, behind the "Toggle flyout" button: the scan must cross both.
    GH_ASSERT([SBComboBoxDriver listForComboBox:combo] == menu);
    // ...and the NEXT question, which sits after the menu, must not claim it.
    GH_ASSERT([SBComboBoxDriver listForComboBox:next] == nil);

    // The rows carry their text in AXTitle with an EMPTY AXValue. Reading AXValue (what the driver used to do) is
    // what made the real page report "no list": eight rows, zero options.
    NSArray<id<SBAXNode>> *options = [SBComboBoxDriver optionsInList:menu];
    GH_ASSERT_EQUAL_INT(options.count, 8);
    for (id<SBAXNode> option in options) GH_ASSERT_EQUAL_INT(option.value.length, 0);
    NSMutableArray<NSString *> *texts = [NSMutableArray array];
    for (id<SBAXNode> option in options) [texts addObject:[SBComboBoxDriver textOfOption:option]];
    GH_ASSERT_EQUAL_OBJECTS(texts, CBViamOptions());
    GH_ASSERT_FALSE([SBComboBoxDriver listSaysNothingFound:menu]);

    // The highlight is a CLASS, not AXFocused and not AXSelected: the arrow-key fallback's guard depends on it.
    SBComboBoxDriver *driver = [[SBComboBoxDriver alloc] initWithActuator:[[SBCBActuator alloc] init]
                                                                   poster:[[SBFakeKeyPoster alloc] initWithState:[[SBCBState alloc] init]]
                                                                    state:[[SBCBState alloc] init]];
    for (NSUInteger i = 0; i < options.count; i++) {
        GH_ASSERT_FALSE(options[i].isFocused);
        GH_ASSERT_EQUAL_INT(driver.isHighlighted(options[i]) ? 1 : 0, i == 2 ? 1 : 0);
    }

    // Closed, there is no menu to find and nothing looks like one.
    SBCBNode *closed = CBRealReactSelect(CBViamOptions(), -1, NO);
    for (id<SBAXNode> child in closed.children) {
        if ([child.role isEqualToString:@"AXComboBox"]) GH_ASSERT([SBComboBoxDriver listForComboBox:child] == nil);
    }
}

GH_TEST(combobox_real_react_select_is_answered_by_two_presses_and_no_keystroke) {
    SBCBWorld *world = [SBCBWorld syntheticWorld];
    world.webkitOptions = YES;     // rows are AXTitle-only AXStaticText marked by class
    world.pressOpens = YES;        // AXPress on the combo box opens the menu, as react-select really does
    world.options = CBViamOptions();
    SBComboBoxResult *result = [world answer:@"LinkedIn"];
    GH_ASSERT_MSG(result.chosen, @"%@ %@", result.reason, @(result.optionCount));
    GH_ASSERT_EQUAL_OBJECTS(result.method, SBComboBoxMethodPress);
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
    SBCBWorld *world = [SBCBWorld syntheticWorld];
    world.webkitOptions = YES;
    world.pressOpens = YES;
    world.filters = YES;           // typing narrows, so the fallback filter really runs
    world.options = CBViamOptions();
    SBComboBoxResult *result = [world answer:@"Hack the North"];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBComboBoxReasonNoMatchingOption);
    GH_ASSERT(result.skipsField);
    GH_ASSERT_FALSE(result.stopsWalk);
    // Nothing was chosen, the menu Shabang opened is closed again, and the field is exactly as it was found.
    GH_ASSERT_EQUAL_INT(world.selections, 0);
    GH_ASSERT(result.pressedEscape);
    GH_ASSERT(world.menu == nil);
    GH_ASSERT_EQUAL_OBJECTS(world.combo.value, @"");
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:SBKeyStrokeKindReturn], 0);
}

GH_TEST(combobox_eeo_and_work_authorization_are_never_even_pressed_open) {
    // The new press-to-open step runs AFTER the refusals, never before them.
    for (NSString *title in @[ @"Gender", @"Are you Hispanic/Latino?", @"Veteran Status", @"Disability Status" ]) {
        SBCBWorld *world = [SBCBWorld syntheticWorldWithLabel:title];
        world.pressOpens = YES;
        world.webkitOptions = YES;
        SBComboBoxResult *result = [world answer:@"Prefer not to say"];
        GH_ASSERT_EQUAL_OBJECTS(result.reason, SBComboBoxReasonDemographic);
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
        SBOptionMatch match = SBMatchDeclineOption(options, @"anything at all");
        GH_ASSERT_MSG(match.index == 2, @"%@ should be recognised as a decline", decline);
        GH_ASSERT_MSG(match.score >= SBComboBoxMatchThreshold, @"%@ should be certain", decline);
    }
    // No way to decline: nothing is picked, and nothing is guessed at.
    SBOptionMatch none = SBMatchDeclineOption(@[ @"Male", @"Female", @"Non-binary" ], @"I don't wish to answer");
    GH_ASSERT_EQUAL_INT(none.index, -1);
    GH_ASSERT_EQUAL_INT(SBMatchDeclineOption(@[], @"x").index, -1);
    // A question ABOUT declining is not an option that declines it.
    GH_ASSERT_EQUAL_INT(SBMatchDeclineOption(@[ @"Yes", @"No", @"Select..." ], @"x").index, -1);
    // The first way out wins, and a placeholder is never one.
    SBOptionMatch first = SBMatchDeclineOption(@[ @"Select...", @"Prefer not to say", @"Decline To Self Identify" ], @"x");
    GH_ASSERT_EQUAL_INT(first.index, 1);
}
