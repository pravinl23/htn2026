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

typedef NS_ENUM(NSInteger, GHCBPress) { GHCBPressSelects, GHCBPressIgnored, GHCBPressFails, GHCBPressSelectsOther };

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
@property (nonatomic) GHCBPress press;
@property (nonatomic, copy) void (^afterPost)(GHKeyStroke *stroke);

// What happened.
@property (nonatomic) NSUInteger presses, escapes, returnsWithoutList, selections;
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
    if (!world.menu || !CBIsInside(node, world.menu)) return YES;
    switch (world.press) {
        case GHCBPressSelects: [world choose:[GHComboBoxDriver textOfOption:node]]; return YES;
        case GHCBPressIgnored: return YES;
        case GHCBPressFails: return NO;
        case GHCBPressSelectsOther: [world choose:@"Something else"]; return YES;
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
    for (GHFakeAXNode *node in nodes) node.isFocused = NO;
    if (index < 0 || index >= (NSInteger)nodes.count) { self.highlight = -1; return; }
    nodes[(NSUInteger)index].isFocused = YES;
    self.highlight = index;
}

- (void)choose:(NSString *)text {
    self.selections++;
    self.selected = text;
    [self closeMenu];
    self.combo.value = @"";
    self.shownText.value = text;
    self.logText.value = [NSString stringWithFormat:@"option %@, selected.", text];
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
    GH_ASSERT_EQUAL_INT(world.presses, 1);
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
    GH_ASSERT_EQUAL_INT(world.presses, 0);
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
    GH_ASSERT_NEAR(world.clock.now - start, 0.05 + 1.5 + 0.06, 0.12);
    // No list ever showed: an Escape would reach the page or the window (a modal closes, a sheet cancels). None.
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:GHKeyStrokeKindEscape], 0);
    GH_ASSERT_FALSE(result.pressedEscape);
    GH_ASSERT_EQUAL_OBJECTS(world.combo.value, @"");                // the typed text is taken back with backspaces

    // A list that only says "No options" is no list: "No" is never matched against the notice.
    GHCBWorld *notice = [GHCBWorld syntheticWorld];
    notice.filters = YES;
    GHComboBoxResult *none = [notice answer:@"No"];
    GH_ASSERT_EQUAL_OBJECTS(none.reason, GHComboBoxReasonNoList);
    GH_ASSERT_EQUAL_INT(notice.presses, 0);
    GH_ASSERT_EQUAL_INT([notice.poster countOfKind:GHKeyStrokeKindReturn], 0);
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
    GH_ASSERT_EQUAL_INT(switched.presses, 0);   // not even an AXPress into an app that is not in front

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
