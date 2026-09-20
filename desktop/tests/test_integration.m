// The whole Tab walk over the REAL Greenhouse page (desktop/tests/fixtures/greenhouse-safari-viam.json), without a
// keyboard, without AX and without a real open panel:
//
//   fixture -> GHCapture -> ghost-core.js -> GHController -> GHWriter -> GHOpenPanelDriver / GHComboBoxDriver
//
// A fake "Safari" reacts to everything Ghost does: AXScrollToVisible scrolls the page, pressing Attach hangs the
// macOS open panel (a sheet with a go-to sheet) below the window, typing into a react-select opens its option list,
// pressing an option shows the chosen value, closing the panel with a file shows the file name and a Remove button.
// Keys only ever reach GHFakeKeyPoster (the production guard logic over a recording sink); a hand-driven clock runs
// every wait. The profile is the fictional Alex Chen plus the fictional resume in demo/fixtures.
#import "GHTest.h"
#import "GHCapture.h"
#import "GHComboBoxDriver.h"
#import "GHController.h"
#import "GHCore.h"
#import "GHEventTap.h"
#import "GHKeyPoster.h"
#import "GHOpenPanelDriver.h"
#import "GHOverlayWindow.h"
#import "GHProfileStore.h"
#import "GHWriter.h"

static NSString *const kHeard = @"How did you hear about this opportunity at Viam?";
static NSString *const kAuthorized = @"Are you legally authorized to work in the United States for any employer?";

static NSString *GWFixturePath(void) {
    return [[@(__FILE__) stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"fixtures/greenhouse-safari-viam.json"];
}

/// The fictional resume checked into the repository, as an absolute path without "..".
static NSString *GWResumePath(void) {
    NSString *here = [@(__FILE__) stringByDeletingLastPathComponent];   // relative when make compiled a relative path
    if (!here.isAbsolutePath) here = [NSFileManager.defaultManager.currentDirectoryPath stringByAppendingPathComponent:here];
    return [[here stringByAppendingPathComponent:@"../../demo/fixtures/resume-alex-chen.pdf"] stringByStandardizingPath];
}

#pragma mark - clock

@interface GWClock : NSObject
@property (nonatomic) NSTimeInterval now;
@property (nonatomic, readonly) NSMutableArray<NSArray *> *timers;
@end

@implementation GWClock
- (instancetype)init {
    if ((self = [super init])) { _timers = [NSMutableArray array]; _now = 1000; }
    return self;
}
- (void (^)(NSTimeInterval, dispatch_block_t))after {
    __weak GWClock *weakSelf = self;
    return ^(NSTimeInterval delay, dispatch_block_t block) {
        GWClock *clock = weakSelf;
        [clock.timers addObject:@[ @(clock.now + MAX(0, delay)), [block copy] ]];
    };
}
- (NSTimeInterval (^)(void))clock {
    __weak GWClock *weakSelf = self;
    return ^NSTimeInterval { return weakSelf.now; };
}
/// Runs timers in time order until `done` (or nothing is left).
- (void)runUntil:(BOOL (^)(void))done {
    for (NSUInteger step = 0; step < 50000 && !done() && self.timers.count; step++) [self fireNext];
}
- (void)fireNext {
    NSUInteger best = 0;
    for (NSUInteger i = 1; i < self.timers.count; i++) {
        if ([self.timers[i][0] doubleValue] < [self.timers[best][0] doubleValue]) best = i;
    }
    NSArray *timer = self.timers[best];
    [self.timers removeObjectAtIndex:best];
    self.now = MAX(self.now, [timer[0] doubleValue]);
    ((dispatch_block_t)timer[1])();
}
@end

#pragma mark - the fake Safari

@class GWWorld;

@interface GWActuator : GHFakeAXActuator
@property (nonatomic, weak) GWWorld *world;
@end

@interface GWWorld : NSObject
@property (nonatomic) pid_t pid;
@property (nonatomic, strong) GHFakeDesktopState *state;
@property (nonatomic, strong) GHFakeKeyPoster *poster;
@property (nonatomic, strong) GWActuator *actuator;
@property (nonatomic, strong) GWClock *clock;

@property (nonatomic, strong) GHFakeAXNode *window, *scrollArea, *web;
@property (nonatomic, strong) GHFakeAXNode *panel, *goToSheet, *fileList, *openButton, *goToField;
@property (nonatomic, weak) GHFakeAXNode *uploadWidget;       // the widget whose Attach opened the panel
@property (nonatomic, copy) NSString *expectedPath;
@property (nonatomic, weak) GHFakeAXNode *selectedAll;
@property (nonatomic, strong, nullable) GHFakeAXNode *menu;
@property (nonatomic, weak, nullable) GHFakeAXNode *menuCombo;
@property (nonatomic, copy) NSDictionary<NSString *, NSArray<NSString *> *> *optionsByCombo;
/// Combo boxes whose menu opens on an AXPress alone, with every option, and never needs a keystroke -- what
/// Greenhouse's react-select does for the EEO selects (GHComboBoxDriver step 3a). The phone-prefix Country
/// control and the referral type-ahead are NOT in here: they only show options once something is typed, so
/// both halves of the contract stay covered.
@property (nonatomic, copy) NSSet<NSString *> *pressOpensMenu;

// What happened. Text is recorded per target so the test can prove where every character went.
@property (nonatomic, strong) NSMutableArray<NSString *> *typedTargets;          // one entry per text chunk
@property (nonatomic, strong) NSMutableDictionary<NSString *, NSMutableString *> *typedByTarget;
@property (nonatomic, strong) NSMutableArray<NSString *> *chosen;                // "<combo title>=<option>"
@property (nonatomic, strong) NSMutableArray<NSString *> *panelsOpenedBy;        // title / identifier of the pressed control
@property (nonatomic) NSUInteger returnsInGoTo, returnsOnOpen, returnsElsewhere, escapes, scrolls;
@property (nonatomic) BOOL keepPanelOpen;                    // the "app" ignores the Return on Open
@property (nonatomic) BOOL fileShownOutsideWidget;           // the page names the file in a toast, the widget stays as it was
@property (nonatomic) NSTimeInterval attachmentShowsAfter;   // Greenhouse uploads the file first: the widget names it late
@property (nonatomic) BOOL pageDropsUploadControls;          // ... and then takes Attach and the file input out of the page
/// React: writing into this node destroys it and puts an identical one in its place (the live page does this to the
/// first field of the form). `replacementKeepsValue` says whether the new element carries the value that was written.
@property (nonatomic, weak, nullable) GHFakeAXNode *replacedOnWrite;
@property (nonatomic) BOOL replacementKeepsValue;
@property (nonatomic, copy, nullable) void (^afterPost)(GHKeyStroke *stroke);
- (void)focus:(nullable GHFakeAXNode *)node;
- (void)replaceFieldNode:(GHFakeAXNode *)node withValue:(NSString *)value;
- (BOOL)panelOpen;
- (void)openPanelFrom:(GHFakeAXNode *)button;
- (void)openMenuFor:(GHFakeAXNode *)combo;
- (void)choose:(NSString *)option;
@end

static BOOL GWInside(id<GHAXNode> node, id<GHAXNode> ancestor) {
    for (id<GHAXNode> up = node; up; up = up.parent) if (up == ancestor) return YES;
    return NO;
}

static GHFakeAXNode *GWFind(id<GHAXNode> root, BOOL (^match)(GHFakeAXNode *node)) {
    if (match((GHFakeAXNode *)root)) return (GHFakeAXNode *)root;
    for (id<GHAXNode> child in root.children) {
        GHFakeAXNode *hit = GWFind(child, match);
        if (hit) return hit;
    }
    return nil;
}

static void GWCollect(id<GHAXNode> root, NSMutableArray<GHFakeAXNode *> *out) {
    [out addObject:(GHFakeAXNode *)root];
    for (id<GHAXNode> child in root.children) GWCollect(child, out);
}

static GHFakeAXNode *GWNode(NSString *role, NSString *title, CGRect frame) {
    return [GHFakeAXNode nodeWithRole:role title:title frame:frame];
}

@implementation GWActuator
- (BOOL)focusNode:(id<GHAXNode>)node {
    BOOL ok = [super focusNode:node];
    if (ok) self.world.state.focusedNode = node;
    return ok;
}
- (BOOL)setValue:(NSString *)value ofNode:(id<GHAXNode>)node {
    BOOL ok = [super setValue:value ofNode:node];
    GWWorld *world = self.world;
    if (ok && world.replacedOnWrite && node == world.replacedOnWrite) [world replaceFieldNode:world.replacedOnWrite withValue:value];
    return ok;
}
- (BOOL)pressNode:(id<GHAXNode>)node {
    [super pressNode:node];
    GWWorld *world = self.world;
    GHFakeAXNode *fake = (GHFakeAXNode *)node;
    if (world.menu && GWInside(node, world.menu)) {
        [world choose:[GHComboBoxDriver textOfOption:node]];
        return YES;
    }
    if ([GHOpenPanelDriver isUploadButton:node]) [world openPanelFrom:fake];
    else if ([fake.role isEqualToString:@"AXComboBox"] && [world.pressOpensMenu containsObject:fake.title ?: @""]) [world openMenuFor:fake];
    return YES;
}
- (BOOL)selectAllInNode:(id<GHAXNode>)node {
    self.world.selectedAll = (GHFakeAXNode *)node;
    return YES;
}
@end

@implementation GWWorld

- (instancetype)init {
    if (!(self = [super init])) return nil;
    _window = [GHFakeAXNode nodeWithDumpTreeFile:GWFixturePath()];
    if (!_window) return nil;
    _web = GWFind(_window, ^BOOL(GHFakeAXNode *node) { return [node.role isEqualToString:@"AXWebArea"]; });
    _scrollArea = (GHFakeAXNode *)_web.parent;
    _pid = 4711;
    _state = [[GHFakeDesktopState alloc] init];
    _state.frontmostPID = _pid;
    [_state addWindow:_window forPID:_pid];
    _poster = [[GHFakeKeyPoster alloc] initWithState:_state];
    _actuator = [[GWActuator alloc] init];
    _actuator.world = self;
    _clock = [[GWClock alloc] init];
    _typedTargets = [NSMutableArray array];
    _typedByTarget = [NSMutableDictionary dictionary];
    _chosen = [NSMutableArray array];
    _panelsOpenedBy = [NSMutableArray array];
    _pressOpensMenu = [NSSet setWithArray:@[ @"Gender", @"Are you Hispanic/Latino?", @"Veteran Status", @"Disability Status" ]];
    _optionsByCombo = @{
        @"Country": @[ @"Canada +1", @"United States +1", @"United Kingdom +44", @"India +91" ],
        kHeard: @[ @"LinkedIn", @"Indeed", @"Hack the North", @"Company website", @"Referral", @"Other" ],
        kAuthorized: @[ @"Yes", @"No" ],
        // The four EEO lists, worded the way Greenhouse words them: each one offers its own way to decline,
        // and no two of them word it the same.
        @"Gender": @[ @"Male", @"Female", @"Decline To Self Identify" ],
        @"Are you Hispanic/Latino?": @[ @"Yes", @"No", @"Decline To Self Identify" ],
        @"Veteran Status": @[ @"I identify as one or more of the classifications of a protected veteran",
                              @"I am not a protected veteran", @"I don't wish to answer" ],
        @"Disability Status": @[ @"Yes, I have a disability, or have had one in the past",
                                 @"No, I do not have a disability and have not had one in the past",
                                 @"I do not want to answer" ],
    };

    // The macOS open panel: a sheet with a file list, a search field, Cancel and a (disabled) Upload button.
    _panel = GWNode(@"AXSheet", nil, CGRectMake(300, 150, 800, 500));
    _fileList = [_panel addChild:GWNode(@"AXOutline", nil, CGRectMake(320, 200, 760, 360))];
    GHFakeAXNode *search = [_panel addChild:GWNode(@"AXTextField", nil, CGRectMake(900, 160, 180, 24))];
    search.subrole = @"AXSearchField";
    [_panel addChild:GWNode(@"AXButton", @"Cancel", CGRectMake(880, 600, 90, 28))];
    _openButton = [_panel addChild:GWNode(@"AXButton", @"Upload", CGRectMake(980, 600, 90, 28))];
    _openButton.enabled = NO;
    _goToSheet = GWNode(@"AXSheet", nil, CGRectMake(400, 180, 600, 120));
    _goToField = [_goToSheet addChild:GWNode(@"AXTextField", nil, CGRectMake(420, 220, 560, 24))];
    [_goToSheet addChild:GWNode(@"AXButton", @"Go", CGRectMake(900, 260, 80, 28))];

    __weak GWWorld *weakSelf = self;
    _poster.onPost = ^(GHKeyStroke *stroke) { [weakSelf react:stroke]; };
    _actuator.onScroll = ^(GHFakeAXNode *node) { [weakSelf scrollToShow:node]; };
    return self;
}

- (void)focus:(GHFakeAXNode *)node {
    ((GHFakeAXNode *)self.state.focusedNode).isFocused = NO;
    node.isFocused = YES;
    self.state.focusedNode = node;
    self.actuator.focusedNode = node;
}

#pragma mark scrolling

/// AXScrollToVisible: the page (everything inside the web area) moves so the element sits mid-viewport.
- (void)scrollToShow:(GHFakeAXNode *)node {
    CGRect viewport = self.scrollArea.frame;
    if (CGRectContainsRect(viewport, node.frame)) return;
    CGFloat delta = CGRectGetMidY(viewport) - CGRectGetMidY(node.frame);
    self.scrolls++;
    NSMutableArray<GHFakeAXNode *> *all = [NSMutableArray array];
    GWCollect(self.web, all);
    for (GHFakeAXNode *each in all) each.frame = CGRectOffset(each.frame, 0, delta);
}

#pragma mark open panel

- (BOOL)panelOpen { return [self.window indexOfChild:self.panel] != NSNotFound; }
- (BOOL)goToOpen { return [self.panel indexOfChild:self.goToSheet] != NSNotFound; }

- (void)openPanelFrom:(GHFakeAXNode *)button {
    if ([self panelOpen]) return;
    [self.panelsOpenedBy addObject:button.title ?: button.identifier ?: @"?"];
    GHFakeAXNode *widget = (GHFakeAXNode *)button.parent;
    while (widget && widget.title.length == 0) widget = (GHFakeAXNode *)widget.parent;
    self.uploadWidget = widget;
    self.openButton.enabled = NO;
    [self.window addChild:self.panel];
    [self focus:self.fileList];
}

/// React replaces an input while Ghost writes into it: the old element dies, an identical one (same role, label and
/// DOM identifier, so the same signature) takes its place, with or without the value that was just written.
- (void)replaceFieldNode:(GHFakeAXNode *)node withValue:(NSString *)value {
    GHFakeAXNode *parent = (GHFakeAXNode *)node.parent;
    NSUInteger index = [parent indexOfChild:node];
    if (index == NSNotFound) return;
    GHFakeAXNode *fresh = [GHFakeAXNode nodeWithRole:node.role title:node.title frame:node.frame];
    fresh.identifier = node.identifier;
    fresh.roleDescription = node.roleDescription;
    fresh.value = self.replacementKeepsValue ? value : @"";
    [parent removeChild:node];
    [parent insertChild:fresh atIndex:index];
    [self.actuator.goneNodes addObject:node];
    self.replacedOnWrite = nil;
    if (self.state.focusedNode == node) [self focus:fresh];
}

- (void)closePanelWithFile:(BOOL)chosen {
    [self.window removeChild:self.panel];
    if ([self goToOpen]) [self.panel removeChild:self.goToSheet];
    GHFakeAXNode *widget = self.uploadWidget;
    GHFakeAXNode *attach = GWFind(widget, ^BOOL(GHFakeAXNode *node) { return [node.title isEqualToString:@"Attach"]; });
    if (chosen && !self.fileShownOutsideWidget && self.attachmentShowsAfter > 0) {
        // The page uploads the file before it shows it: nothing names it for a while.
        GHFakeAXNode *late = widget;
        NSString *name = self.expectedPath.lastPathComponent;
        __weak GWWorld *weakSelf = self;
        self.clock.after(self.attachmentShowsAfter, ^{ [weakSelf showFile:name inWidget:late]; });
        [self focus:attach];
        return;
    }
    if (chosen && self.fileShownOutsideWidget) {
        CGRect page = self.web.frame;
        [self.web addChild:[GHFakeAXNode staticText:[self.expectedPath.lastPathComponent stringByAppendingString:@" uploaded"]
                                              frame:CGRectMake(page.origin.x + 20, CGRectGetMaxY(page) - 40, 300, 20)]];
    } else if (chosen && widget) {
        [self showFile:self.expectedPath.lastPathComponent inWidget:widget];
    }
    [self focus:attach];
}

/// What Greenhouse shows once a file is attached: its name and a way to remove it. With `pageDropsUploadControls`
/// the page also takes the Attach button and the file input away, so nothing of the upload field is left to find.
- (void)showFile:(NSString *)name inWidget:(GHFakeAXNode *)widget {
    if (!widget || name.length == 0) return;
    if (self.pageDropsUploadControls) {
        NSMutableArray<GHFakeAXNode *> *inside = [NSMutableArray array];
        GWCollect(widget, inside);
        for (GHFakeAXNode *node in inside) {
            if (![node.title isEqualToString:@"Attach"] && ![GHOpenPanelDriver isUploadButton:node]) continue;
            [(GHFakeAXNode *)node.parent removeChild:node];
            [self.actuator.goneNodes addObject:node];
        }
    }
    CGRect box = widget.frame;
    GHFakeAXNode *row = [GHFakeAXNode nodeWithRole:@"AXGroup" title:nil frame:CGRectMake(box.origin.x, box.origin.y + 30, 400, 24)];
    [row addChild:[GHFakeAXNode staticText:name frame:CGRectMake(box.origin.x, box.origin.y + 32, 200, 20)]];
    [row addChild:GWNode(@"AXButton", @"Remove file", CGRectMake(box.origin.x + 210, box.origin.y + 30, 24, 24))];
    [widget insertChild:row atIndex:1];
}

#pragma mark react-select

- (void)openMenuFor:(GHFakeAXNode *)combo {
    [self closeMenu];
    NSString *typed = combo.value.lowercaseString ?: @"";
    GHFakeAXNode *menu = [GHFakeAXNode nodeWithRole:@"AXList" title:nil frame:CGRectMake(combo.frame.origin.x, CGRectGetMaxY(combo.frame) + 6, 537, 160)];
    menu.roleDescription = @"list box";
    NSUInteger shown = 0;
    for (NSString *option in self.optionsByCombo[combo.title] ?: @[]) {
        if (typed.length && ![option.lowercaseString containsString:typed]) continue;
        [menu addChild:[GHFakeAXNode staticText:option frame:CGRectMake(combo.frame.origin.x, CGRectGetMaxY(combo.frame) + 8 + 24 * shown, 520, 22)]];
        shown++;
    }
    if (shown == 0) [menu addChild:[GHFakeAXNode staticText:@"No options" frame:CGRectZero]];
    else ((GHFakeAXNode *)menu.children.firstObject).isFocused = YES;   // react-select highlights the first option
    GHFakeAXNode *parent = (GHFakeAXNode *)combo.parent;
    NSUInteger index = [parent indexOfChild:combo];
    // After the combo box's own "Toggle flyout" button, as react-select renders it.
    NSUInteger after = index + 1 < parent.children.count && [parent.children[index + 1].title isEqualToString:@"Toggle flyout"] ? index + 2 : index + 1;
    [parent insertChild:menu atIndex:after];
    self.menu = menu;
    self.menuCombo = combo;
}

- (void)closeMenu {
    if (self.menu) [(GHFakeAXNode *)self.menu.parent removeChild:self.menu];
    self.menu = nil;
    self.menuCombo = nil;
}

- (void)choose:(NSString *)option {
    GHFakeAXNode *combo = self.menuCombo;
    [self closeMenu];
    if (!combo) return;
    [self.chosen addObject:[NSString stringWithFormat:@"%@=%@", combo.title, option]];
    combo.value = @"";
    // The chosen value replaces the placeholder right before the input (Country has none: one appears).
    GHFakeAXNode *parent = (GHFakeAXNode *)combo.parent;
    NSUInteger index = [parent indexOfChild:combo];
    GHFakeAXNode *before = index > 0 ? (GHFakeAXNode *)parent.children[index - 1] : nil;
    BOOL placeholder = NO;
    for (NSString *name in before.domClassList) if ([name containsString:@"placeholder"]) placeholder = YES;
    if (placeholder) {
        before.domClassList = @[ @"select__single-value" ];
        ((GHFakeAXNode *)before.children.firstObject).value = option;
    } else {
        GHFakeAXNode *value = [GHFakeAXNode nodeWithRole:@"AXGroup" title:nil frame:CGRectMake(combo.frame.origin.x, combo.frame.origin.y, 120, combo.frame.size.height)];
        value.domClassList = @[ @"select__single-value" ];
        [value addChild:[GHFakeAXNode staticText:option frame:value.frame]];
        [parent insertChild:value atIndex:index];
    }
}

#pragma mark keys

- (NSString *)nameOf:(GHFakeAXNode *)node {
    if (!node) return @"(nothing)";
    if (node == self.goToField) return @"go-to field";
    if (GWInside(node, self.panel)) return @"open panel";
    return node.title.length ? node.title : (node.role ?: @"?");
}

- (void)react:(GHKeyStroke *)stroke {
    GHFakeAXNode *focused = (GHFakeAXNode *)self.state.focusedNode;
    switch (stroke.kind) {
        case GHKeyStrokeKindGoToFolder:
            if ([self panelOpen] && GWInside(focused, self.panel) && ![self goToOpen]) {
                [self.panel addChild:self.goToSheet];
                [self.actuator.goneNodes removeObject:self.goToField];
                self.goToField.value = @"";
                [self focus:self.goToField];
            }
            break;
        case GHKeyStrokeKindText: {
            NSString *target = [self nameOf:focused];
            [self.typedTargets addObject:target];
            NSMutableString *typed = self.typedByTarget[target];
            if (!typed) self.typedByTarget[target] = typed = [NSMutableString string];
            [typed appendString:stroke.text];
            if (!focused) break;
            NSString *base = self.selectedAll == focused ? @"" : (focused.value ?: @"");
            focused.value = [base stringByAppendingString:stroke.text];
            self.selectedAll = nil;
            if ([focused.role isEqualToString:@"AXComboBox"]) [self openMenuFor:focused];
            break;
        }
        case GHKeyStrokeKindReturn:
            if (focused == self.goToField && [self goToOpen]) {
                self.returnsInGoTo++;
                [self.panel removeChild:self.goToSheet];
                [self.actuator.goneNodes addObject:self.goToField];
                if ([self.goToField.value isEqualToString:self.expectedPath]) self.openButton.enabled = YES;
                [self focus:self.fileList];
            } else if ([self panelOpen] && GWInside(focused, self.panel)) {
                self.returnsOnOpen++;
                if (self.openButton.enabled && !self.keepPanelOpen) [self closePanelWithFile:YES];
            } else if (self.menu && focused == self.menuCombo) {
                GHFakeAXNode *highlighted = nil;
                for (id<GHAXNode> option in self.menu.children) if (option.isFocused) highlighted = (GHFakeAXNode *)option;
                if (highlighted) [self choose:highlighted.value];
            } else {
                self.returnsElsewhere++;   // a Return that reached the page itself: must never happen
            }
            break;
        case GHKeyStrokeKindEscape:
            self.escapes++;
            if ([self goToOpen]) { [self.panel removeChild:self.goToSheet]; [self focus:self.fileList]; }
            else if ([self panelOpen]) [self closePanelWithFile:NO];
            else [self closeMenu];
            break;
        case GHKeyStrokeKindBackspace:
            if (focused.value.length) focused.value = [focused.value substringToIndex:focused.value.length - 1];
            break;
        default:
            break;
    }
    if (self.afterPost) self.afterPost(stroke);
}

@end

#pragma mark - the rig

@interface GWRig : NSObject
@property (nonatomic, strong) GWWorld *world;
@property (nonatomic, strong) GHCore *core;
@property (nonatomic, strong) GHProfileStore *store;
@property (nonatomic, strong) GHCapture *capture;
@property (nonatomic, strong) GHController *controller;
@property (nonatomic, strong) GHWriter *writer;
@property (nonatomic, strong) NSMutableArray<NSDictionary *> *steps;
@property (nonatomic, strong) NSMutableArray<NSString *> *statuses;
@property (nonatomic) NSUInteger handedBack;
@end

@implementation GWRig

+ (instancetype)rig {
    GWRig *rig = [[GWRig alloc] init];
    rig.core = [GHCore sharedCore];
    rig.world = [[GWWorld alloc] init];
    if (!rig.core || !rig.world) return nil;
    GWWorld *world = rig.world;
    world.expectedPath = GWResumePath();

    rig.store = [[GHProfileStore alloc] initWithDirectory:GHTestTempDirectory() core:rig.core];
    [rig.store prepare];
    NSMutableDictionary *profile = [[rig.core demoProfile] mutableCopy];
    NSMutableDictionary *facts = [profile[@"facts"] mutableCopy];
    facts[@"resumePath"] = GWResumePath();
    profile[@"facts"] = facts;
    [rig.store saveProfile:profile error:NULL];

    rig.capture = [[GHCapture alloc] initWithSafety:rig.core];
    rig.capture.keepsScrolledOutFields = YES;
    rig.capture.clock = ^NSTimeInterval { return 0; };   // a saved tree has no latency; the node budget still applies

    GHWriter *writer = [[GHWriter alloc] initWithActuator:world.actuator];
    writer.after = world.clock.after;
    GHCapture *capture = rig.capture;
    writer.isNodeSensitive = ^BOOL(id<GHAXNode> node) { return [capture isNodeSensitive:node]; };
    GHOpenPanelDriver *panel = [[GHOpenPanelDriver alloc] initWithActuator:world.actuator poster:world.poster state:world.state];
    panel.after = world.clock.after;
    panel.clock = world.clock.clock;
    GHComboBoxDriver *combo = [[GHComboBoxDriver alloc] initWithActuator:world.actuator poster:world.poster state:world.state];
    combo.after = world.clock.after;
    combo.clock = world.clock.clock;
    // combo.isNodeSensitive is left unset: the controller wires the capture's check before the first sequence.
    writer.openPanelDriver = panel;
    writer.comboBoxDriver = combo;
    rig.writer = writer;

    GHController *controller = [[GHController alloc] initWithCore:rig.core store:rig.store client:nil];
    controller.assumesActive = YES;
    controller.after = world.clock.after;   // the upload check waits for the page on this clock too
    controller.capture = capture;
    controller.overlay = [[GHOverlayWindow alloc] initWithLayout:[GHScreenLayout layoutWithFrames:@[ [NSValue valueWithRect:NSMakeRect(0, 0, 1470, 956)] ] scales:@[ @2 ]]];
    controller.writer = writer;
    controller.eventTap.deliversSynchronously = YES;   // never installed: there is no real tap in tests
    __weak GWRig *weakRig = rig;
    controller.tabHandBack = ^{ weakRig.handedBack++; };
    GHFakeAXNode *window = world.window;
    controller.captureProvider = ^GHCaptureResult *{ return [capture captureWindow:window]; };
    // Live focus as the controller reads it before every step and after every write: the fake Safari's own.
    __weak GWWorld *weakWorld = world;
    controller.focusedNodeProvider = ^id<GHAXNode> { return weakWorld.state.focusedNode; };
    rig.controller = controller;
    rig.steps = [NSMutableArray array];
    rig.statuses = [NSMutableArray array];
    return rig;
}

- (void)rescan {
    [self.controller adoptCaptureResult:[self.capture captureWindow:self.world.window] pageKey:@"greenhouse-viam"
                                 origin:@"app://com.apple.Safari/job-boards.greenhouse.io"];
}

/// One real Tab through the event tap's rule, focus reported the way the AX observer would, then every timer the
/// write started runs to the end. Records the step.
- (BOOL)tab {
    [self.controller noteFocusedNode:self.world.state.focusedNode ?: self.world.web];
    NSUInteger before = self.controller.stepCount;
    BOOL consumed = [self.controller.eventTap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:NO userData:0 printable:NO];
    GHController *controller = self.controller;
    NSMutableArray *statuses = self.statuses;
    [self.world.clock runUntil:^BOOL {
        if (controller.hudStatus && ![statuses.lastObject isEqualToString:controller.hudStatus]) [statuses addObject:controller.hudStatus];
        return !controller.busy;
    }];
    if (controller.hudStatus && ![statuses.lastObject isEqualToString:controller.hudStatus]) [statuses addObject:controller.hudStatus];
    if (self.controller.stepCount > before) [self.steps addObject:self.controller.lastStep ?: @{}];
    return consumed;
}

/// A repeat of a held Tab (the tap already decided it belongs to Ghost), then every timer runs out.
- (void)hold {
    [self.controller eventTap:self.controller.eventTap didConsumeTab:GHKeyDecisionAccept isRepeat:YES];
    GHController *controller = self.controller;
    [self.world.clock runUntil:^BOOL { return !controller.busy; }];
    NSDictionary *last = self.controller.lastStep;
    if (last && ![last isEqual:self.steps.lastObject]) [self.steps addObject:last];
}

/// Tabs until the current ghost has `label` (at most `limit` presses). NO when it never got there.
- (BOOL)tabUntilCurrentIs:(NSString *)label limit:(NSUInteger)limit {
    for (NSUInteger i = 0; i < limit && ![[self currentLabel] isEqualToString:label]; i++) [self tab];
    return [[self currentLabel] isEqualToString:label];
}

- (NSArray<NSString *> *)stepSummaries {
    NSMutableArray<NSString *> *out = [NSMutableArray array];
    for (NSDictionary *step in self.steps) [out addObject:[NSString stringWithFormat:@"%@: %@", step[@"outcome"], step[@"label"]]];
    return out;
}

- (GHFakeAXNode *)comboTitled:(NSString *)title {
    return GWFind(self.world.window, ^BOOL(GHFakeAXNode *node) { return [node.role isEqualToString:@"AXComboBox"] && [node.title isEqualToString:title]; });
}

- (GHFakeAXNode *)buttonTitled:(NSString *)title {
    return GWFind(self.world.window, ^BOOL(GHFakeAXNode *node) { return [node.role isEqualToString:@"AXButton"] && [node.title isEqualToString:title]; });
}

- (GHFakeAXNode *)textFieldTitled:(NSString *)title {
    return GWFind(self.world.window, ^BOOL(GHFakeAXNode *node) { return [node.role isEqualToString:@"AXTextField"] && [node.title isEqualToString:title]; });
}

- (NSString *)currentLabel {
    GHGhost *current = self.controller.walk.current;
    return current ? [self.controller harnessState][@"current"][@"label"] : nil;
}

@end

#define GW_RIG(name) \
    GWRig *name = [GWRig rig]; \
    GH_ASSERT_MSG(name != nil, @"fixture or ghost-core.js did not load (DESKTOP_CORE_PATH=%s)", getenv("DESKTOP_CORE_PATH") ?: "(unset)")

#pragma mark - the walk

GH_TEST(integration_greenhouse_tab_walk_fills_uploads_chooses_and_parks_on_submit) {
    GW_RIG(rig);
    GH_ASSERT([NSFileManager.defaultManager isReadableFileAtPath:GWResumePath()]);
    GWWorld *world = rig.world;
    GHController *controller = rig.controller;
    NSDictionary *facts = rig.store.profile[@"facts"];
    GH_ASSERT_EQUAL_OBJECTS(facts[@"resumePath"], GWResumePath());   // validated on load, kept as is

    [rig rescan];
    GHWalkState *walk = controller.walk;
    NSMutableDictionary<NSString *, NSString *> *labels = [NSMutableDictionary dictionary];
    for (GHField *field in [rig.capture captureWindow:world.window].fields) labels[field.signature] = field.label;
    NSMutableArray<NSString *> *ghosted = [NSMutableArray array];
    for (GHGhost *ghost in walk.ghosts) [ghosted addObject:[NSString stringWithFormat:@"%@ %@", ghost.action, labels[ghost.signature]]];
    // EVERY question gets a ghost now (docs/answers.md), and NO Submit while a required field is unanswered
    // (docs/incremental.md): the work-authorization question is AXRequired on this page.
    GH_ASSERT_EQUAL_OBJECTS(ghosted, (@[ @"fill First Name", @"fill Last Name", @"fill Email", @"select Country", @"fill Phone", @"upload Resume/CV",
                                         @"fill LinkedIn Profile", @"fill Github", @"fill Website", [@"select " stringByAppendingString:kHeard],
                                         [@"select " stringByAppendingString:kAuthorized],
                                         @"select Gender", @"select Are you Hispanic/Latino?", @"select Veteran Status", @"select Disability Status" ]));
    // Every proposal Ghost is not certain of wears the badge and stops a held accept key; what it knows
    // outright does not (docs/always-propose.md). The US question is guessed (the profile covers Canada
    // only); the four EEO questions are declines -- sourced as facts, because declining claims nothing about
    // anybody, but still shown for a look because they come in under the confident tier.
    for (GHGhost *ghost in walk.ghosts) {
        NSString *label = labels[ghost.signature];
        if (ghost.guess) GH_ASSERT_MSG(ghost.needsReview, @"%@ is flagged, so it must ask to be checked", label);
        if ([@[ @"First Name", @"Last Name", @"Email" ] containsObject:label]) {
            GH_ASSERT_MSG(!ghost.guess, @"%@ comes straight from the profile", label);
        }
        if ([label isEqualToString:kAuthorized]) {
            GH_ASSERT_MSG(ghost.guess, @"%@ is inferred, not known", label);
            GH_ASSERT_EQUAL_OBJECTS(ghost.answerSource, @"guess");
        }
        if (![@[ @"Gender", @"Are you Hispanic/Latino?", @"Veteran Status", @"Disability Status" ] containsObject:label]) continue;
        GH_ASSERT_MSG(ghost.declineAnswer, @"%@ must be answered by declining", label);
        GH_ASSERT_EQUAL_OBJECTS(ghost.answerSource, @"fact"); // a decline is never sourced as a guess
        GH_ASSERT_EQUAL_OBJECTS(ghost.answerClass, @"protected");
    }
    for (GHGhost *ghost in walk.ghosts) {
        if ([ghost.action isEqualToString:GHGhostActionSelect]) GH_ASSERT(ghost.lazy);
        if ([ghost.action isEqualToString:GHGhostActionUpload]) GH_ASSERT_EQUAL_OBJECTS(ghost.displayText, @"resume-alex-chen.pdf");
    }
    GH_ASSERT_EQUAL_OBJECTS([rig currentLabel], @"First Name");
    GH_ASSERT_FALSE(controller.currentVisible);                   // the form is far below the job description

    // Tab, Tab, Tab... from the page itself. The first press only scrolls the form into view.
    NSUInteger presses = 0;
    while (presses < 20 && !(walk.current.locked && [rig.steps.lastObject[@"outcome"] isEqualToString:@"parked"])) {
        GH_ASSERT_MSG([rig tab], @"Tab %lu was not consumed (current %@)", (unsigned long)presses + 1, [rig currentLabel]);
        presses++;
        if (walk.error) break;
    }
    GH_ASSERT_MSG(walk.error == nil, @"the walk stopped: %@", walk.error);
    NSArray *expected = @[
        @"jumped: First Name",
        @"accepted: First Name", @"accepted: Last Name", @"accepted: Email", @"accepted: Country", @"accepted: Phone",
        @"accepted: Resume/CV", @"accepted: LinkedIn Profile", @"accepted: Github", @"accepted: Website", [@"accepted: " stringByAppendingString:kHeard],
        [@"accepted: " stringByAppendingString:kAuthorized],
        @"accepted: Gender", @"accepted: Are you Hispanic/Latino?", @"accepted: Veteran Status", @"accepted: Disability Status",
        @"parked: Submit application",
    ];
    GH_ASSERT_EQUAL_OBJECTS([rig stepSummaries], expected);
    GH_ASSERT_EQUAL_INT(presses, expected.count);

    // Values: typed through AXValue for the text fields, chosen through the lists for the two comboboxes.
    GH_ASSERT_EQUAL_OBJECTS([rig textFieldTitled:@"First Name"].value, facts[@"firstName"]);
    GH_ASSERT_EQUAL_OBJECTS([rig textFieldTitled:@"Last Name"].value, facts[@"lastName"]);
    GH_ASSERT_EQUAL_OBJECTS([rig textFieldTitled:@"Email"].value, facts[@"email"]);
    GH_ASSERT([rig textFieldTitled:@"Phone"].value.length > 0);
    GH_ASSERT_EQUAL_OBJECTS([rig textFieldTitled:@"LinkedIn Profile"].value, facts[@"linkedin"]);
    GH_ASSERT_EQUAL_OBJECTS([rig textFieldTitled:@"Github"].value, facts[@"github"]);
    GH_ASSERT_EQUAL_OBJECTS([rig textFieldTitled:@"Website"].value, facts[@"website"]);
    // Every question is answered, each in the page's own words: the two type-ahead lists from the profile, the
    // US work-authorization question with the conservative "No", and each EEO question with ITS way of declining.
    GH_ASSERT_EQUAL_OBJECTS(world.chosen, (@[ @"Country=Canada +1", [kHeard stringByAppendingString:@"=Hack the North"],
                                              [kAuthorized stringByAppendingString:@"=No"],
                                              @"Gender=Decline To Self Identify",
                                              @"Are you Hispanic/Latino?=Decline To Self Identify",
                                              @"Veteran Status=I don't wish to answer",
                                              @"Disability Status=I do not want to answer" ]));

    // The upload drove the panel with the right path, exactly once, and nothing else.
    GH_ASSERT_EQUAL_OBJECTS(world.panelsOpenedBy, (@[ @"Attach" ]));
    GH_ASSERT_EQUAL_OBJECTS(world.typedByTarget[@"go-to field"], GWResumePath());
    GH_ASSERT_EQUAL_OBJECTS(world.typedByTarget[@"Country"], @"Canada");
    GH_ASSERT_EQUAL_OBJECTS(world.typedByTarget[kHeard], @"Hack the North");
    // The work-authorization question is a type-ahead like the other two: "No" is typed, then the real option
    // is pressed. The four EEO questions are not in this set: a decline is never typed anywhere.
    GH_ASSERT_EQUAL_OBJECTS(world.typedByTarget[kAuthorized], @"No");
    GH_ASSERT_EQUAL_OBJECTS([NSSet setWithArray:world.typedTargets], ([NSSet setWithArray:@[ @"go-to field", @"Country", kHeard, kAuthorized ]]));
    GH_ASSERT_EQUAL_INT(world.returnsInGoTo, 1);
    GH_ASSERT_EQUAL_INT(world.returnsOnOpen, 1);
    GH_ASSERT_EQUAL_INT(world.returnsElsewhere, 0);
    GH_ASSERT_EQUAL_INT(world.escapes, 0);
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:GHKeyStrokeKindReturn], 2);
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:GHKeyStrokeKindGoToFolder], 1);
    GH_ASSERT_FALSE([world panelOpen]);
    GH_ASSERT([rig.statuses containsObject:@"Picking resume-alex-chen.pdf"]);   // the HUD names the file only
    for (NSString *status in rig.statuses) GH_ASSERT_FALSE([status containsString:@"/"]);

    // Presses: each combo box is pressed ONCE to try to open it without a keystroke (what the real Greenhouse
    // react-select needs), then its chosen option; the Attach button once; never Submit (or Apply, Autofill,
    // Dropbox...).
    GHFakeAXNode *submit = [rig buttonTitled:@"Submit application"];
    NSMutableArray<NSString *> *pressed = [NSMutableArray array];
    for (id<GHAXNode> node in world.actuator.pressedNodes) [pressed addObject:node.title ?: node.value ?: node.role];
    GH_ASSERT_EQUAL_OBJECTS(pressed, (@[ @"Country", @"Canada +1", @"Attach", kHeard, @"Hack the North",
                                         kAuthorized, @"No",
                                         @"Gender", @"Decline To Self Identify",
                                         @"Are you Hispanic/Latino?", @"Decline To Self Identify",
                                         @"Veteran Status", @"I don't wish to answer",
                                         @"Disability Status", @"I do not want to answer" ]));

    // Nothing is ever TYPED into an EEO question: a decline is matched by meaning among the options the page
    // itself offers, so no wording of Ghost's ever lands in a demographic field (docs/answers.md section 7).
    for (NSString *title in @[ @"Gender", @"Are you Hispanic/Latino?", @"Veteran Status", @"Disability Status" ]) {
        GHFakeAXNode *combo = [rig comboTitled:title];
        GH_ASSERT_MSG(combo != nil, @"%@ is in the fixture", title);
        GH_ASSERT_MSG(world.typedByTarget[title] == nil, @"nothing may be typed into %@", title);
    }

    // The walk ends parked on the locked Submit: current, focused, on screen, never pressed.
    GH_ASSERT(walk.current.locked);
    GH_ASSERT_EQUAL_OBJECTS([rig currentLabel], @"Submit application");
    GH_ASSERT(submit.isFocused);
    GH_ASSERT(controller.currentVisible);
    GH_ASSERT(walk.finished);
    GH_ASSERT_EQUAL_INT(walk.accepted, 15);
    GH_ASSERT([controller.eventTap publishedSnapshot].currentLocked);
    // Over-pressing and holding Tab on the lock is harmless: still no press, no key.
    NSUInteger posts = world.poster.posted.count;
    for (int i = 0; i < 3; i++) [rig tab];
    for (int i = 0; i < 3; i++) [controller eventTap:controller.eventTap didConsumeTab:GHKeyDecisionAccept isRepeat:YES];
    GH_ASSERT_FALSE([world.actuator.pressedNodes containsObject:submit]);
    GH_ASSERT_EQUAL_INT(world.poster.posted.count, posts);
    GH_ASSERT_EQUAL_INT(rig.handedBack, 0);

    // The rescan after the walk offers nothing again: the upload and both choices are seen as filled.
    [rig rescan];
    GH_ASSERT_EQUAL_INT(walk.ghosts.count, 1);
    GH_ASSERT(walk.ghosts.firstObject.locked);
    GHCaptureResult *after = [rig.capture captureWindow:world.window];
    for (GHField *field in after.fields) {
        if ([field.label isEqualToString:@"Resume/CV"]) GH_ASSERT_EQUAL_OBJECTS(field.value, @"resume-alex-chen.pdf");
        if ([field.label isEqualToString:@"Country"]) GH_ASSERT_EQUAL_OBJECTS(field.value, @"Canada +1");
        if ([field.label isEqualToString:kHeard]) GH_ASSERT_EQUAL_OBJECTS(field.value, @"Hack the North");
    }
}

#pragma mark - sequences

GH_TEST(integration_hold_tab_stops_at_a_combobox_or_upload_and_a_fresh_press_starts_it) {
    GW_RIG(rig);
    GWWorld *world = rig.world;
    [rig rescan];
    GH_ASSERT([rig tab]);                                        // the jump
    for (int i = 0; i < 8; i++) [rig hold];                       // holding Tab
    GH_ASSERT_EQUAL_OBJECTS([rig stepSummaries], (@[ @"jumped: First Name", @"accepted: First Name", @"accepted: Last Name", @"accepted: Email",
                                                     @"needs-press: Country" ]));
    GH_ASSERT_EQUAL_OBJECTS([rig currentLabel], @"Country");
    GH_ASSERT_EQUAL_INT(world.poster.posted.count, 0);            // the hold never started the combobox sequence
    GH_ASSERT_EQUAL_INT(world.chosen.count, 0);
    GH_ASSERT(rig.controller.currentVisible);

    GH_ASSERT([rig tab]);                                         // one deliberate press does
    GH_ASSERT_EQUAL_OBJECTS(world.chosen, (@[ @"Country=Canada +1" ]));
    for (int i = 0; i < 8; i++) [rig hold];
    GH_ASSERT_EQUAL_OBJECTS([[rig stepSummaries] subarrayWithRange:NSMakeRange(5, 3)], (@[ @"accepted: Country", @"accepted: Phone", @"needs-press: Resume/CV" ]));
    GH_ASSERT_EQUAL_INT(world.panelsOpenedBy.count, 0);           // nor the upload
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:GHKeyStrokeKindGoToFolder], 0);
    GH_ASSERT([rig tab]);
    GH_ASSERT_EQUAL_OBJECTS(world.panelsOpenedBy, (@[ @"Attach" ]));
    GH_ASSERT_EQUAL_OBJECTS(rig.steps.lastObject[@"outcome"], @"accepted");
    GH_ASSERT(rig.controller.walk.error == nil);
}

GH_TEST(integration_a_user_key_during_the_upload_aborts_it_and_queued_tabs_are_dropped) {
    GW_RIG(rig);
    GWWorld *world = rig.world;
    [rig rescan];
    GH_ASSERT([rig tabUntilCurrentIs:@"Resume/CV" limit:10]);
    GHEventTap *tap = rig.controller.eventTap;
    __block BOOL pressed = NO;
    __block BOOL panelTabConsumed = YES;
    world.afterPost = ^(GHKeyStroke *stroke) {
        if (stroke.kind != GHKeyStrokeKindGoToFolder || pressed) return;
        pressed = YES;
        // The user presses a letter and then Tab while the panel is being driven (untagged key-downs).
        [tap handleKeyDown:0 flags:0 isRepeat:NO userData:0 printable:YES];
        GH_ASSERT([tap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:NO userData:0 printable:NO]);   // queued, not native
        // Once the controller has heard that focus is inside the panel, a Tab is the panel's own (never trapped).
        [rig.controller noteFocusedNode:rig.world.state.focusedNode];
        panelTabConsumed = [tap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:NO userData:0 printable:NO];
    };
    [rig tab];
    GH_ASSERT(pressed);
    GH_ASSERT_FALSE(panelTabConsumed);
    GH_ASSERT_EQUAL_OBJECTS(rig.steps.lastObject[@"outcome"], @"failed");
    GH_ASSERT_EQUAL_OBJECTS(rig.steps.lastObject[@"reason"], @"upload-user-key");
    GH_ASSERT([rig.controller.walk.error containsString:@"upload-user-key"]);
    GH_ASSERT(world.typedByTarget[@"go-to field"] == nil);         // the path was never typed
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:GHKeyStrokeKindReturn], 0);
    GH_ASSERT_EQUAL_INT(world.escapes, 0);                        // the user took over: not even an Escape
    // The Tab pressed meanwhile was not replayed as an accept of the next ghost.
    GH_ASSERT_EQUAL_OBJECTS([rig currentLabel], @"LinkedIn Profile");
    GH_ASSERT_EQUAL_INT([rig textFieldTitled:@"LinkedIn Profile"].value.length, 0);
    GH_ASSERT_FALSE(rig.controller.busy);
    GH_ASSERT(rig.controller.hudStatus == nil);
}

GH_TEST(integration_losing_the_permission_mid_upload_cancels_it_before_another_key) {
    GW_RIG(rig);
    GWWorld *world = rig.world;
    [rig rescan];
    GH_ASSERT([rig tabUntilCurrentIs:@"Resume/CV" limit:10]);
    GHController *controller = rig.controller;
    world.afterPost = ^(GHKeyStroke *stroke) {
        if (stroke.kind != GHKeyStrokeKindGoToFolder) return;
        // Accessibility is revoked (or Ghost is switched off) right after Command+Shift+G went out.
        [controller accessibility:controller.accessibility trustDidChange:GHTrustStateUntrusted];
    };
    NSUInteger before = world.poster.posted.count;                // the Country combobox typed earlier in the walk
    NSUInteger returns = [world.poster countOfKind:GHKeyStrokeKindReturn];
    [rig tab];
    GH_ASSERT_FALSE(rig.writer.openPanelDriver.running);
    NSArray<NSString *> *names = world.poster.postedNames;
    GH_ASSERT_EQUAL_OBJECTS([names subarrayWithRange:NSMakeRange(before, names.count - before)], (@[ @"go-to-folder" ]));   // no path, Return, Escape
    GH_ASSERT(world.typedByTarget[@"go-to field"] == nil);
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:GHKeyStrokeKindReturn], returns);
    GH_ASSERT_FALSE(controller.busy);
    // Whatever timers were still queued run out without posting anything.
    [world.clock runUntil:^BOOL { return NO; }];
    GH_ASSERT_EQUAL_INT(world.poster.posted.count, before + 1);
}

/// Live, Safari: the panel closed and Greenhouse only named the file a moment later (it uploads it first), so the one
/// look right after the sequence called a good upload "upload-not-verified". The check waits for the page.
GH_TEST(integration_an_upload_the_page_shows_late_is_still_accepted) {
    GW_RIG(rig);
    GWWorld *world = rig.world;
    world.attachmentShowsAfter = 1.2;   // longer than one look, well inside the check's own window
    [rig rescan];
    GH_ASSERT([rig tabUntilCurrentIs:@"Resume/CV" limit:10]);
    [rig tab];
    GH_ASSERT_EQUAL_INT(world.returnsOnOpen, 1);
    GH_ASSERT_EQUAL_OBJECTS(rig.steps.lastObject[@"outcome"], @"accepted");
    GH_ASSERT(rig.steps.lastObject[@"reason"] == nil);
    GH_ASSERT(rig.controller.walk.error == nil);

    // Live, Safari: Greenhouse also takes Attach and the file input out of the page, so the upload field cannot be
    // found again at all. The Remove button it leaves where the field was is the proof.
    GW_RIG(dropped);
    dropped.world.attachmentShowsAfter = 1.2;
    dropped.world.pageDropsUploadControls = YES;
    [dropped rescan];
    GH_ASSERT([dropped tabUntilCurrentIs:@"Resume/CV" limit:10]);
    [dropped tab];
    GH_ASSERT_EQUAL_OBJECTS(dropped.steps.lastObject[@"outcome"], @"accepted");
    GH_ASSERT(GWFind(dropped.world.web, ^BOOL(GHFakeAXNode *node) { return [node.title isEqualToString:@"Remove file"]; }) != nil);
    GH_ASSERT(dropped.controller.walk.error == nil);

    // And a page that never shows it still stops the walk, after the check has waited.
    GW_RIG(other);
    other.world.fileShownOutsideWidget = YES;
    [other rescan];
    GH_ASSERT([other tabUntilCurrentIs:@"Resume/CV" limit:10]);
    [other tab];
    GH_ASSERT_EQUAL_OBJECTS(other.steps.lastObject[@"reason"], @"upload-not-verified");
}

/// Live, Safari: Greenhouse replaced the First Name input while Ghost wrote into it, and the write was reported as
/// "gone" although the value had landed. A fresh capture decides: the new element holds it, or it is written once more.
GH_TEST(integration_a_field_the_page_replaces_mid_write_is_not_lost) {
    for (NSUInteger keepsValue = 0; keepsValue < 2; keepsValue++) {
        GW_RIG(rig);
        GWWorld *world = rig.world;
        [rig rescan];
        GH_ASSERT([rig tabUntilCurrentIs:@"First Name" limit:8]);
        GHFakeAXNode *input = GWFind(world.web, ^BOOL(GHFakeAXNode *node) { return [node.title isEqualToString:@"First Name"]; });
        GH_ASSERT(input != nil);
        world.replacedOnWrite = input;
        world.replacementKeepsValue = keepsValue == 1;
        [rig tab];
        // The first Tab on a form below the posting only scrolls it into view; the next one writes.
        if ([rig.steps.lastObject[@"outcome"] isEqualToString:@"jumped"]) [rig tab];
        GH_ASSERT_MSG([rig.steps.lastObject[@"outcome"] isEqualToString:@"accepted"], @"keepsValue=%lu outcome=%@ reason=%@",
                      (unsigned long)keepsValue, rig.steps.lastObject[@"outcome"], rig.steps.lastObject[@"reason"] ?: @"-");
        GHFakeAXNode *now = GWFind(world.web, ^BOOL(GHFakeAXNode *node) { return [node.title isEqualToString:@"First Name"]; });
        GH_ASSERT(now != input);                       // the page really did replace it
        GH_ASSERT_EQUAL_OBJECTS(now.value, @"Alex");   // and the name is in the new element either way
        GH_ASSERT(rig.controller.walk.error == nil);
        GH_ASSERT_EQUAL_INT(rig.controller.walk.accepted, 1);
    }
}

GH_TEST(integration_an_upload_the_widget_does_not_show_is_not_accepted) {
    GW_RIG(rig);
    GWWorld *world = rig.world;
    world.fileShownOutsideWidget = YES;                           // the page names the file, the upload widget does not
    [rig rescan];
    GH_ASSERT([rig tabUntilCurrentIs:@"Resume/CV" limit:10]);
    [rig tab];
    GH_ASSERT_EQUAL_INT(world.returnsOnOpen, 1);                  // the panel really was driven to the end
    GH_ASSERT_EQUAL_OBJECTS(rig.steps.lastObject[@"reason"], @"upload-not-verified");
    GH_ASSERT([rig.controller.walk.error containsString:@"upload-not-verified"]);
    GH_ASSERT_EQUAL_INT(rig.controller.walk.accepted, 5);
}

GH_TEST(integration_a_combobox_without_the_answer_is_skipped_and_the_walk_goes_on) {
    GW_RIG(rig);
    GWWorld *world = rig.world;
    NSMutableDictionary *options = [world.optionsByCombo mutableCopy];
    options[@"Country"] = @[ @"United States +1", @"Mexico +52" ];   // no Canada on this page
    world.optionsByCombo = options;
    [rig rescan];
    GH_ASSERT([rig tabUntilCurrentIs:@"Country" limit:10]);
    [rig tab];
    GH_ASSERT_EQUAL_OBJECTS(rig.steps.lastObject[@"outcome"], @"refused");
    GH_ASSERT_EQUAL_OBJECTS(rig.steps.lastObject[@"reason"], @"combobox-no-matching-option");
    GH_ASSERT(rig.controller.walk.error == nil);                  // skipped, not broken
    GH_ASSERT_EQUAL_INT(world.chosen.count, 0);
    GH_ASSERT_EQUAL_INT([rig comboTitled:@"Country"].value.length, 0);   // what was typed is gone again (backspaces)
    GH_ASSERT_EQUAL_INT(world.escapes, 1);                        // one Escape, into the open "No options" menu
    GH_ASSERT_EQUAL_OBJECTS([rig currentLabel], @"Phone");
    [rig tab];
    GH_ASSERT([rig textFieldTitled:@"Phone"].value.length > 0);
    [rig rescan];                                                 // and it is not offered again on this page
    for (GHGhost *ghost in rig.controller.walk.ghosts) GH_ASSERT_FALSE(ghost.lazy && [ghost.displayText isEqualToString:@"Canada"]);
}
