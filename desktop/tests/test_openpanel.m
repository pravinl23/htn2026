// GHKeyPoster and GHOpenPanelDriver without a keyboard, without AX and without a real open panel: a fake "Safari"
// (page, sheet panel, go-to sheet) reacts to the fake poster's posts, and a hand-driven clock runs every wait.
// Nothing in this file can post a real event: only GHFakeKeyPoster is used, never the live sink.
#import "GHTest.h"
#import "GHKeyPoster.h"
#import "GHOpenPanelDriver.h"
#import "GHEventTap.h"

#pragma mark - fakes

/// A fake node whose children can come and go (a sheet that opens and closes).
@interface GHOPNode : GHFakeAXNode
- (void)attach:(GHFakeAXNode *)child;
- (void)detach:(GHFakeAXNode *)child;
- (BOOL)holds:(GHFakeAXNode *)child;
@end

@implementation GHOPNode {
    NSMutableArray<GHFakeAXNode *> *_attached;
}
- (NSArray<id<GHAXNode>> *)children {
    NSArray<id<GHAXNode>> *fixed = [super children];
    return _attached.count ? [fixed arrayByAddingObjectsFromArray:_attached] : fixed;
}
- (void)attach:(GHFakeAXNode *)child {
    if (!_attached) _attached = [NSMutableArray array];
    if ([_attached containsObject:child]) return;
    child.parent = self;
    [_attached addObject:child];
}
- (void)detach:(GHFakeAXNode *)child { [_attached removeObject:child]; }
- (BOOL)holds:(GHFakeAXNode *)child { return [_attached containsObject:child]; }
@end

/// Timers run in time order by hand; `now` jumps to each timer.
@interface GHOPClock : NSObject
@property (nonatomic) NSTimeInterval now;
@property (nonatomic, readonly) NSMutableArray<NSArray *> *timers;
@end

@implementation GHOPClock
- (instancetype)init {
    if ((self = [super init])) { _timers = [NSMutableArray array]; _now = 100; }
    return self;
}
- (void (^)(NSTimeInterval, dispatch_block_t))after {
    __weak GHOPClock *weakSelf = self;
    return ^(NSTimeInterval delay, dispatch_block_t block) {
        GHOPClock *clock = weakSelf;
        [clock.timers addObject:@[ @(clock.now + delay), [block copy] ]];
    };
}
- (NSTimeInterval (^)(void))clock {
    __weak GHOPClock *weakSelf = self;
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

@interface GHOPState : GHFakeDesktopState
/// Runs on every focus read; the poster reads focus right before each post, so this is "the last moment".
@property (nonatomic, copy) void (^onFocusRead)(void);
@end

@implementation GHOPState
- (id<GHAXNode>)focusedElement {
    if (self.onFocusRead) self.onFocusRead();
    return [super focusedElement];
}
@end

@class GHOPWorld;

@interface GHOPActuator : GHFakeAXActuator
@property (nonatomic, weak) GHOPWorld *world;
@property (nonatomic) NSUInteger selectAllCount;
@end

/// A fake Safari with a file-upload page and the macOS open panel as a sheet.
@interface GHOPWorld : NSObject
@property (nonatomic) pid_t pid;
@property (nonatomic, strong) GHOPState *state;
@property (nonatomic, strong) GHFakeKeyPoster *poster;
@property (nonatomic, strong) GHOPActuator *actuator;
@property (nonatomic, strong) GHOPClock *clock;
@property (nonatomic, strong) GHOpenPanelDriver *driver;
@property (nonatomic, strong) NSMutableArray<NSString *> *messages;

@property (nonatomic, strong) GHOPNode *window;
@property (nonatomic, strong) GHFakeAXNode *uploadButton, *pageField, *pageStatus;
@property (nonatomic, strong) GHOPNode *panel, *goToSheet;
@property (nonatomic, strong) GHFakeAXNode *fileList, *openButton, *goToField, *searchField;
@property (nonatomic, copy) NSString *path;
@property (nonatomic, weak) GHFakeAXNode *selectedAll;

// How the "app" behaves.
@property (nonatomic) BOOL pressFails, panelAppears, focusGoesToPanel, goToOpens, goToFocusesField, typingLands, dropFirstCharacter;
@property (nonatomic) BOOL firstReturnCloses, openCloses, pageShowsName, openEnabledAfterGoTo, selectAllWorks;
@property (nonatomic, copy) NSString *goToPrefill;
@property (nonatomic, copy) void (^onPress)(void);
@property (nonatomic, copy) void (^afterPost)(GHKeyStroke *stroke);

// What happened.
@property (nonatomic) NSUInteger returnsInGoTo, returnsOnOpen, returnsOutsidePanel, escapes, presses;
- (void)focus:(GHFakeAXNode *)node;
- (BOOL)panelOpen;
@end

@implementation GHOPActuator
- (BOOL)pressNode:(id<GHAXNode>)node {
    [super pressNode:node];
    GHOPWorld *world = self.world;
    if (node != world.uploadButton) return YES;
    world.presses++;
    if (world.pressFails) return NO;
    if (world.panelAppears) {
        [world.window attach:world.panel];
        if (world.focusGoesToPanel) [world focus:world.fileList];
    }
    if (world.onPress) world.onPress();
    return YES;
}
- (BOOL)selectAllInNode:(id<GHAXNode>)node {
    self.selectAllCount++;
    if (!self.world.selectAllWorks) return NO;
    self.world.selectedAll = (GHFakeAXNode *)node;
    return YES;
}
@end

static GHFakeAXNode *OPNode(NSString *role, NSString *title) {
    GHOPNode *node = [GHOPNode nodeWithRole:role];
    node.title = title;
    node.frame = CGRectMake(0, 0, 100, 20);
    return node;
}

@implementation GHOPWorld

- (instancetype)initWithWindow:(GHOPNode *)window uploadButton:(GHFakeAXNode *)uploadButton statusParent:(GHOPNode *)statusParent {
    if ((self = [super init])) {
        _pid = 4242;
        _state = [[GHOPState alloc] init];
        _state.frontmostPID = _pid;
        _poster = [[GHFakeKeyPoster alloc] initWithState:_state];
        _actuator = [[GHOPActuator alloc] init];
        _actuator.world = self;
        _clock = [[GHOPClock alloc] init];
        _messages = [NSMutableArray array];
        _window = window;
        _uploadButton = uploadButton;
        [_state addWindow:window forPID:_pid];
        _pageStatus = [GHFakeAXNode staticText:@"" frame:CGRectZero];
        [statusParent attach:_pageStatus];

        _panel = (GHOPNode *)OPNode(@"AXSheet", nil);
        _fileList = [_panel addChild:OPNode(@"AXOutline", nil)];
        _searchField = [_panel addChild:OPNode(@"AXTextField", nil)];
        _searchField.subrole = @"AXSearchField";
        [_panel addChild:OPNode(@"AXButton", @"Cancel")];
        _openButton = [_panel addChild:OPNode(@"AXButton", @"Upload")];
        _openButton.enabled = NO;   // nothing chosen yet
        _goToSheet = (GHOPNode *)OPNode(@"AXSheet", nil);
        _goToField = [_goToSheet addChild:OPNode(@"AXTextField", nil)];
        [_goToSheet addChild:OPNode(@"AXButton", @"Go")];

        _panelAppears = _focusGoesToPanel = _goToOpens = _goToFocusesField = _typingLands = YES;
        _openCloses = _pageShowsName = _openEnabledAfterGoTo = _selectAllWorks = YES;

        __weak GHOPWorld *weakSelf = self;
        _poster.onPost = ^(GHKeyStroke *stroke) { [weakSelf react:stroke]; };

        _driver = [[GHOpenPanelDriver alloc] initWithActuator:_actuator poster:_poster state:_state];
        _driver.after = _clock.after;
        _driver.clock = _clock.clock;
        _driver.progress = ^(GHOpenPanelState state, NSString *message) { [weakSelf.messages addObject:message]; };
    }
    return self;
}

/// Page: window > web area > "Resume/CV" group (file input + Attach) + a text field.
+ (instancetype)syntheticWorld {
    GHOPNode *window = (GHOPNode *)OPNode(@"AXWindow", nil);
    window.subrole = @"AXStandardWindow";
    GHFakeAXNode *web = [window addChild:OPNode(@"AXWebArea", nil)];
    GHOPNode *group = (GHOPNode *)[web addChild:OPNode(@"AXGroup", @"Resume/CV")];
    [group addChild:OPNode(@"AXButton", @"Attach")];
    GHFakeAXNode *input = [group addChild:OPNode(@"AXButton", nil)];
    input.subrole = @"AXFileUploadButton";
    input.identifier = @"resume";
    GHOPWorld *world = [[self alloc] initWithWindow:window uploadButton:input statusParent:group];
    world.pageField = [web addChild:OPNode(@"AXTextField", @"First Name")];
    return world;
}

- (void)focus:(GHFakeAXNode *)node {
    ((GHFakeAXNode *)self.state.focusedNode).isFocused = NO;
    node.isFocused = YES;
    self.state.focusedNode = node;
    self.actuator.focusedNode = node;
}

- (BOOL)panelOpen { return [self.window holds:self.panel]; }
- (BOOL)goToOpen { return [self.panel holds:self.goToSheet]; }

- (void)closePanelWithFile:(BOOL)chosen {
    [self.window detach:self.panel];
    [self focus:self.uploadButton];
    if (chosen && self.pageShowsName) self.pageStatus.value = self.path.lastPathComponent;
}

- (void)react:(GHKeyStroke *)stroke {
    GHFakeAXNode *focused = (GHFakeAXNode *)self.state.focusedNode;
    switch (stroke.kind) {
        case GHKeyStrokeKindGoToFolder:
            if (self.goToOpens && [self panelOpen] && [GHOpenPanelDriver node:focused isInside:self.panel]) {
                [self.panel attach:self.goToSheet];
                [self.actuator.goneNodes removeObject:self.goToField];
                self.goToField.value = self.goToPrefill ?: @"";
                if (self.goToFocusesField) [self focus:self.goToField];
            }
            break;
        case GHKeyStrokeKindText: {
            if (!self.typingLands || !focused) break;
            NSString *text = stroke.text;
            if (self.dropFirstCharacter && text.length) { text = [text substringFromIndex:1]; self.dropFirstCharacter = NO; }
            NSString *base = self.selectedAll == focused ? @"" : (focused.value ?: @"");
            focused.value = [base stringByAppendingString:text];
            self.selectedAll = nil;
            break;
        }
        case GHKeyStrokeKindReturn:
            if (focused == self.goToField && [self goToOpen]) {
                self.returnsInGoTo++;
                [self.panel detach:self.goToSheet];
                [self.actuator.goneNodes addObject:self.goToField];
                BOOL chosen = [self.goToField.value isEqualToString:self.path];
                if (chosen) self.openButton.enabled = self.openEnabledAfterGoTo;
                [self focus:self.fileList];
                if (chosen && self.firstReturnCloses) [self closePanelWithFile:YES];
            } else if ([self panelOpen] && [GHOpenPanelDriver node:focused isInside:self.panel]) {
                self.returnsOnOpen++;
                if (self.openButton.enabled && self.openCloses) [self closePanelWithFile:YES];
            } else {
                self.returnsOutsidePanel++;   // a Return that reached the page: must never happen
            }
            break;
        case GHKeyStrokeKindEscape:
            self.escapes++;
            if ([self goToOpen]) { [self.panel detach:self.goToSheet]; [self focus:self.fileList]; }
            else if ([self panelOpen]) [self closePanelWithFile:NO];
            break;
        default:
            break;
    }
    if (self.afterPost) self.afterPost(stroke);
}

- (GHOpenPanelResult *)runWithPath:(NSString *)path button:(id<GHAXNode>)button {
    self.path = path;
    __block GHOpenPanelResult *result = nil;
    [self.driver attachFileAtPath:path uploadButton:button completion:^(GHOpenPanelResult *r) { result = r; }];
    [self.clock runUntil:^BOOL { return result != nil; }];
    return result;
}

- (GHOpenPanelResult *)run {
    return [self runWithPath:self.path button:self.uploadButton];
}

@end

/// A fictional resume in a temp folder (the real fixture path is checked separately).
static NSString *OPResumePath(void) {
    NSString *path = [GHTestTempDirectory() stringByAppendingPathComponent:@"resume-alex-chen.pdf"];
    [@"%PDF-1.4 fictional resume for Alex Chen" writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    return path;
}

static GHOPWorld *OPWorld(void) {
    GHOPWorld *world = [GHOPWorld syntheticWorld];
    world.path = OPResumePath();
    return world;
}

static BOOL OPNoKeysAtAll(GHOPWorld *world) {
    return world.poster.posted.count == 0 && world.poster.guardCalls == 0;
}

#pragma mark - GHKeyPoster

GH_TEST(keyposter_can_never_post_space_enter_or_tab) {
    NSArray<NSNumber *> *codes = [GHKeyPoster postableKeyCodes];
    for (NSNumber *forbidden in @[ @49 /* Space */, @76 /* keypad Enter */, @48 /* Tab */ ]) GH_ASSERT_FALSE([codes containsObject:forbidden]);
    GH_ASSERT_EQUAL_OBJECTS(codes, (@[ @0, @5, @36, @51, @53, @125, @126 ]));
    for (GHKeyStroke *stroke in @[ [GHKeyStroke text:@"a"], [GHKeyStroke escape], [GHKeyStroke downArrow], [GHKeyStroke upArrow],
                                   [GHKeyStroke backspace], [GHKeyStroke goToFolder], [GHKeyStroke returnKey] ]) {
        GH_ASSERT([codes containsObject:@(stroke.keyCode)]);
    }
    GHKeyStroke *goTo = [GHKeyStroke goToFolder];
    GH_ASSERT_EQUAL_INT(goTo.keyCode, 5);
    GH_ASSERT_EQUAL_INT(goTo.flags, kCGEventFlagMaskCommand | kCGEventFlagMaskShift);
    GH_ASSERT_EQUAL_INT([GHKeyStroke returnKey].flags, 0);
    GH_ASSERT_FALSE([[GHKeyStroke text:@"secret"].description containsString:@"secret"]);
    // The live poster is only constructed here, never asked to post.
    GHKeyPoster *live = [GHKeyPoster livePoster];
    GH_ASSERT([live.sink isKindOfClass:GHTaggedKeyEventSink.class]);
    GH_ASSERT([(id)live.state isKindOfClass:GHLiveDesktopState.class]);
    GH_ASSERT_NEAR(live.interPostDelay, 0.002, 1e-9);
}

GH_TEST(keyposter_guard_reads_fresh_state_before_every_single_post) {
    GHFakeDesktopState *state = [[GHFakeDesktopState alloc] init];
    state.frontmostPID = 7;
    GHFakeAXNode *field = [GHFakeAXNode nodeWithRole:@"AXTextField"];
    GHFakeAXNode *other = [GHFakeAXNode nodeWithRole:@"AXTextField"];
    state.focusedNode = field;
    GHFakeKeyPoster *poster = [[GHFakeKeyPoster alloc] initWithState:state];
    // The "app" moves focus away after the first chunk.
    __block NSUInteger posts = 0;
    poster.onPost = ^(GHKeyStroke *stroke) { if (++posts == 1) state.focusedNode = other; };
    NSMutableArray *seen = [NSMutableArray array];
    NSString *text = [@"" stringByPaddingToLength:45 withString:@"x" startingAtIndex:0];   // 3 chunks: 20 + 20 + 5
    GHKeyBurstResult *result = [poster postBurst:@[ [GHKeyStroke text:text], [GHKeyStroke escape] ] guard:^BOOL(GHKeyStroke *stroke, pid_t pid, id<GHAXNode> focused) {
        [seen addObject:focused ? (id)focused : (id)NSNull.null];
        return pid == 7 && focused == field;
    }];
    GH_ASSERT_FALSE(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHKeyBurstReasonGuardRefused);
    GH_ASSERT_EQUAL_INT(result.postedCount, 1);
    GH_ASSERT_EQUAL_INT(result.failedIndex, 0);
    GH_ASSERT_EQUAL_INT(seen.count, 2);        // the guard ran before post 1 and before post 2, not a snapshot
    GH_ASSERT(seen[1] == other);
    GH_ASSERT_EQUAL_OBJECTS(poster.postedNames, (@[ @"text" ]));   // the Escape after it never went out
    GH_ASSERT_EQUAL_INT(poster.typedText.length, 20);
    // Post 1: read, guard, read again, post. Post 2: read, guard says no.
    GH_ASSERT_EQUAL_INT(state.focusReads, 3);
    GH_ASSERT_EQUAL_INT(state.frontmostReads, 3);
}

GH_TEST(keyposter_a_slow_guard_cannot_let_a_click_or_an_app_switch_slip_in) {
    GHFakeDesktopState *state = [[GHFakeDesktopState alloc] init];
    state.frontmostPID = 7;
    GHFakeAXNode *list = [GHFakeAXNode nodeWithRole:@"AXComboBox"];
    GHFakeAXNode *chat = [GHFakeAXNode nodeWithRole:@"AXTextArea"];
    state.focusedNode = list;
    GHFakeKeyPoster *poster = [[GHFakeKeyPoster alloc] initWithState:state];
    // The guard approves what it was shown, but while its (slow) walk runs the user clicks into a chat box.
    GHKeyBurstResult *clicked = [poster postBurst:@[ [GHKeyStroke returnKey] ] guard:^BOOL(GHKeyStroke *stroke, pid_t pid, id<GHAXNode> focused) {
        BOOL ok = pid == 7 && focused == list;
        state.focusedNode = chat;
        return ok;
    }];
    GH_ASSERT_FALSE(clicked.ok);
    GH_ASSERT_EQUAL_OBJECTS(clicked.reason, GHKeyBurstReasonGuardRefused);
    GH_ASSERT_EQUAL_INT(poster.posted.count, 0);

    // ...or Command+Tabs to another app.
    state.focusedNode = list;
    GHKeyBurstResult *switched = [poster postBurst:@[ [GHKeyStroke returnKey] ] guard:^BOOL(GHKeyStroke *stroke, pid_t pid, id<GHAXNode> focused) {
        state.frontmostPID = 99;
        return pid == 7 && focused == list;
    }];
    GH_ASSERT_FALSE(switched.ok);
    GH_ASSERT_EQUAL_INT(poster.posted.count, 0);

    // The caller's last check (the user-key flag) is asked after all that, right before the post.
    state.frontmostPID = 7;
    __block BOOL userKey = NO;
    __block NSUInteger lastChecks = 0;
    GHKeyBurstResult *keyed = [poster postBurst:@[ [GHKeyStroke text:@"Canada"], [GHKeyStroke downArrow] ] guard:^BOOL(GHKeyStroke *stroke, pid_t pid, id<GHAXNode> focused) {
        userKey = YES;   // a key the event tap saw while the guard ran
        return YES;
    } lastCheck:^BOOL { lastChecks++; return !userKey; }];
    GH_ASSERT_FALSE(keyed.ok);
    GH_ASSERT_EQUAL_INT(lastChecks, 1);
    GH_ASSERT_EQUAL_INT(poster.posted.count, 0);
    // All clear: it posts, with the last check asked once per post.
    lastChecks = 0;
    GH_ASSERT([poster postBurst:@[ [GHKeyStroke escape] ] guard:^BOOL(GHKeyStroke *s, pid_t p, id<GHAXNode> f) { return YES; }
                      lastCheck:^BOOL { lastChecks++; return YES; }].ok);
    GH_ASSERT_EQUAL_INT(lastChecks, 1);
    GH_ASSERT_EQUAL_OBJECTS(poster.postedNames, (@[ @"escape" ]));
}

GH_TEST(keyposter_refuses_malformed_bursts_before_posting_anything) {
    GHFakeDesktopState *state = [[GHFakeDesktopState alloc] init];
    GHFakeKeyPoster *poster = [[GHFakeKeyPoster alloc] initWithState:state];
    GHKeyGuard yes = ^BOOL(GHKeyStroke *stroke, pid_t pid, id<GHAXNode> focused) { return YES; };
    NSArray *bad = @[ @[],
                      @[ [GHKeyStroke text:@"path"], [GHKeyStroke returnKey] ],   // a Return is always alone
                      @[ [GHKeyStroke returnKey], [GHKeyStroke returnKey] ],
                      @[ [GHKeyStroke text:@"line\nbreak"] ],                     // a newline could become an Enter
                      @[ [GHKeyStroke text:@"tab\there"] ],
                      @[ [GHKeyStroke text:@""] ] ];
    for (NSArray *burst in bad) {
        GHKeyBurstResult *result = [poster postBurst:burst guard:yes];
        GH_ASSERT_FALSE(result.ok);
        GH_ASSERT_EQUAL_INT(result.postedCount, 0);
    }
    GH_ASSERT_EQUAL_INT(poster.posted.count, 0);
    GH_ASSERT_EQUAL_INT(poster.guardCalls, 0);
    GH_ASSERT_EQUAL_OBJECTS([poster postBurst:@[] guard:yes].reason, GHKeyBurstReasonEmpty);
    GH_ASSERT_EQUAL_OBJECTS([poster postBurst:@[ [GHKeyStroke text:@"a\rb"] ] guard:yes].reason, GHKeyBurstReasonMalformed);

    NSString *reason = nil;
    NSArray<GHKeyStroke *> *atoms = [GHKeyPoster atomicStrokesForBurst:@[ [GHKeyStroke text:[@"" stringByPaddingToLength:45 withString:@"y" startingAtIndex:0]],
                                                                         [GHKeyStroke downArrow] ] reason:&reason];
    GH_ASSERT_EQUAL_INT(atoms.count, 4);
    GH_ASSERT_EQUAL_INT(atoms[0].text.length, 20);
    GH_ASSERT_EQUAL_INT(atoms[2].text.length, 5);
    GH_ASSERT_EQUAL_INT(atoms[3].kind, GHKeyStrokeKindDownArrow);

    // A lone Return with a guard that says yes goes out; one that says no does not.
    GH_ASSERT([poster postBurst:@[ [GHKeyStroke returnKey] ] guard:yes].ok);
    GH_ASSERT_FALSE([poster postBurst:@[ [GHKeyStroke returnKey] ] guard:^BOOL(GHKeyStroke *s, pid_t p, id<GHAXNode> f) { return NO; }].ok);
    GH_ASSERT_EQUAL_INT([poster countOfKind:GHKeyStrokeKindReturn], 1);
}

GH_TEST(keyposter_stops_at_the_first_refusal_or_failed_post) {
    GHFakeDesktopState *state = [[GHFakeDesktopState alloc] init];
    GHFakeKeyPoster *poster = [[GHFakeKeyPoster alloc] initWithState:state];
    GHKeyBurstResult *result = [poster postBurst:@[ [GHKeyStroke escape], [GHKeyStroke downArrow], [GHKeyStroke upArrow] ]
                                           guard:^BOOL(GHKeyStroke *stroke, pid_t pid, id<GHAXNode> focused) { return stroke.kind != GHKeyStrokeKindDownArrow; }];
    GH_ASSERT_FALSE(result.ok);
    GH_ASSERT_EQUAL_INT(result.failedIndex, 1);
    GH_ASSERT_EQUAL_OBJECTS(poster.postedNames, (@[ @"escape" ]));

    poster.sinkFails = YES;
    GHKeyBurstResult *failed = [poster postBurst:@[ [GHKeyStroke backspace], [GHKeyStroke backspace] ]
                                           guard:^BOOL(GHKeyStroke *stroke, pid_t pid, id<GHAXNode> focused) { return YES; }];
    GH_ASSERT_EQUAL_OBJECTS(failed.reason, GHKeyBurstReasonPostFailed);
    GH_ASSERT_EQUAL_INT(failed.postedCount, 0);
    GH_ASSERT_EQUAL_INT(poster.guardCalls, 3);   // 2 in the first burst, 1 before the failed post
    GH_ASSERT_EQUAL_INT(poster.burstCount, 2);
}

#pragma mark - pure pieces

GH_TEST(openpanel_validates_the_upload_path) {
    NSString *dir = GHTestTempDirectory();
    NSString *good = [dir stringByAppendingPathComponent:@"resume-alex-chen.pdf"];
    [@"%PDF fictional" writeToFile:good atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    GH_ASSERT([GHOpenPanelDriver problemWithUploadPath:good] == nil);

    GH_ASSERT_EQUAL_OBJECTS([GHOpenPanelDriver problemWithUploadPath:nil], GHUploadPathEmpty);
    GH_ASSERT_EQUAL_OBJECTS([GHOpenPanelDriver problemWithUploadPath:@"resume.pdf"], GHUploadPathNotAbsolute);
    GH_ASSERT_EQUAL_OBJECTS([GHOpenPanelDriver problemWithUploadPath:@"~/resume.pdf"], GHUploadPathNotAbsolute);
    GH_ASSERT_EQUAL_OBJECTS([GHOpenPanelDriver problemWithUploadPath:[dir stringByAppendingPathComponent:@"missing.pdf"]], GHUploadPathMissing);
    GH_ASSERT_EQUAL_OBJECTS([GHOpenPanelDriver problemWithUploadPath:dir], GHUploadPathNotRegularFile);
    GH_ASSERT_EQUAL_OBJECTS([GHOpenPanelDriver problemWithUploadPath:[good stringByAppendingString:@"\n"]], GHUploadPathControlCharacter);

    NSString *link = [dir stringByAppendingPathComponent:@"link.pdf"];
    [NSFileManager.defaultManager createSymbolicLinkAtPath:link withDestinationPath:good error:NULL];
    GH_ASSERT_EQUAL_OBJECTS([GHOpenPanelDriver problemWithUploadPath:link], GHUploadPathNotRegularFile);

    NSString *big = [dir stringByAppendingPathComponent:@"big.pdf"];
    [NSFileManager.defaultManager createFileAtPath:big contents:nil attributes:nil];
    NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:big];
    [handle truncateFileAtOffset:GHOpenPanelMaxFileBytes];   // sparse: exactly 25 MB is already too large
    [handle closeFile];
    GH_ASSERT_EQUAL_OBJECTS([GHOpenPanelDriver problemWithUploadPath:big], GHUploadPathTooLarge);

    NSString *locked = [dir stringByAppendingPathComponent:@"locked.pdf"];
    [@"x" writeToFile:locked atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    [NSFileManager.defaultManager setAttributes:@{ NSFilePosixPermissions: @0 } ofItemAtPath:locked error:NULL];
    GH_ASSERT_EQUAL_OBJECTS([GHOpenPanelDriver problemWithUploadPath:locked], GHUploadPathUnreadable);
    [NSFileManager.defaultManager setAttributes:@{ NSFilePosixPermissions: @0600 } ofItemAtPath:locked error:NULL];

    // The fictional demo resume the live run will use passes.
    NSString *here = [@(__FILE__) stringByDeletingLastPathComponent];
    if (!here.isAbsolutePath) here = [NSFileManager.defaultManager.currentDirectoryPath stringByAppendingPathComponent:here];
    NSString *demo = [here stringByAppendingPathComponent:@"../../demo/fixtures/resume-alex-chen.pdf"].stringByStandardizingPath;
    GH_ASSERT([GHOpenPanelDriver problemWithUploadPath:demo] == nil);
}

static GHOPNode *OPFixtureNode(NSDictionary *raw) {
    GHOPNode *node = [GHOPNode nodeWithRole:raw[@"role"] ?: @"AXUnknown"];
    NSDictionary *keys = @{ @"title": @"title", @"subrole": @"subrole", @"description": @"axDescription", @"roleDescription": @"roleDescription",
                            @"identifier": @"identifier", @"text": @"value" };
    for (NSString *key in keys) if ([raw[key] isKindOfClass:NSString.class]) [node setValue:raw[key] forKey:keys[key]];
    if (raw[@"enabled"]) node.enabled = [raw[@"enabled"] boolValue];
    for (NSDictionary *child in raw[@"children"]) [node addChild:OPFixtureNode(child)];
    return node;
}

static GHOPNode *OPGreenhouseWindow(void) {
    NSString *path = [@(__FILE__).stringByDeletingLastPathComponent stringByAppendingPathComponent:@"fixtures/greenhouse-safari-viam.json"];
    NSDictionary *fixture = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:path] ?: [NSData data] options:0 error:NULL];
    return [fixture[@"tree"] isKindOfClass:NSDictionary.class] ? OPFixtureNode(fixture[@"tree"]) : nil;
}

static id<GHAXNode> OPFind(id<GHAXNode> root, BOOL (^match)(id<GHAXNode> node)) {
    if (match(root)) return root;
    for (id<GHAXNode> child in root.children) {
        id<GHAXNode> hit = OPFind(child, match);
        if (hit) return hit;
    }
    return nil;
}

static void OPCollect(id<GHAXNode> root, NSMutableArray *out) {
    [out addObject:root];
    for (id<GHAXNode> child in root.children) OPCollect(child, out);
}

GH_TEST(openpanel_finds_the_upload_control_in_the_real_greenhouse_page) {
    GHOPNode *window = OPGreenhouseWindow();
    GH_ASSERT(window != nil);
    id<GHAXNode> resume = OPFind(window, ^BOOL(id<GHAXNode> n) { return [n.title isEqualToString:@"Resume/CV"]; });
    id<GHAXNode> cover = OPFind(window, ^BOOL(id<GHAXNode> n) { return [n.title isEqualToString:@"Cover Letter"]; });
    GH_ASSERT(resume && cover);
    id<GHAXNode> resumeButton = [GHOpenPanelDriver uploadButtonInGroup:resume];
    GH_ASSERT_EQUAL_OBJECTS(resumeButton.subrole, @"AXFileUploadButton");
    GH_ASSERT_EQUAL_OBJECTS(resumeButton.identifier, @"resume");
    GH_ASSERT_EQUAL_OBJECTS([GHOpenPanelDriver uploadButtonInGroup:cover].identifier, @"cover_letter");

    NSMutableArray<id<GHAXNode>> *all = [NSMutableArray array];
    OPCollect(window, all);
    NSMutableSet<NSString *> *accepted = [NSMutableSet set];
    for (id<GHAXNode> node in all) {
        if ([GHOpenPanelDriver isUploadButton:node]) [accepted addObject:node.title ?: node.identifier ?: @"?"];
    }
    // The file inputs and "Attach", never the cloud pickers, "Enter manually", "Apply", "Autofill" or Submit.
    GH_ASSERT_EQUAL_OBJECTS(accepted, ([NSSet setWithArray:@[ @"Attach", @"resume", @"cover_letter" ]]));
    // The page itself holds no open panel, although it is full of buttons.
    GH_ASSERT([GHOpenPanelDriver openPanelInWindows:@[ window ]] == nil);
}

GH_TEST(openpanel_panel_search_only_accepts_sheets_and_dialogs) {
    GHFakeAXNode *window = OPNode(@"AXWindow", nil);
    window.subrole = @"AXStandardWindow";
    GHFakeAXNode *web = [window addChild:OPNode(@"AXWebArea", nil)];
    [web addChild:OPNode(@"AXButton", @"Upload")];          // a page button called Upload is not a panel
    GHFakeAXNode *webSheet = [web addChild:OPNode(@"AXSheet", nil)];
    [webSheet addChild:OPNode(@"AXButton", @"Open")];       // nothing inside web content counts
    [window addChild:OPNode(@"AXButton", @"Open")];         // a standard window with an Open button is not a panel
    GH_ASSERT([GHOpenPanelDriver openPanelInWindows:@[ window ]] == nil);

    GHFakeAXNode *sheet = [window addChild:OPNode(@"AXSheet", nil)];
    GHFakeAXNode *nested = [sheet addChild:OPNode(@"AXGroup", nil)];
    GHFakeAXNode *choose = [nested addChild:OPNode(@"AXButton", @"Choose")];
    GH_ASSERT([GHOpenPanelDriver openPanelInWindows:@[ window ]] == sheet);
    GH_ASSERT([GHOpenPanelDriver defaultButtonOfPanel:sheet] == choose);

    GHFakeAXNode *dialog = OPNode(@"AXWindow", nil);
    dialog.subrole = @"AXDialog";
    [dialog addChild:OPNode(@"AXButton", @"Open")];
    GH_ASSERT([GHOpenPanelDriver openPanelInWindows:@[ dialog ]] == dialog);
    GHFakeAXNode *alert = OPNode(@"AXWindow", nil);
    alert.subrole = @"AXDialog";
    [alert addChild:OPNode(@"AXButton", @"OK")];
    GH_ASSERT([GHOpenPanelDriver openPanelInWindows:@[ alert ]] == nil);

    GHFakeAXNode *search = OPNode(@"AXTextField", nil);
    search.subrole = @"AXSearchField";
    GH_ASSERT_FALSE([GHOpenPanelDriver isGoToFieldCandidate:search]);
    GH_ASSERT([GHOpenPanelDriver isGoToFieldCandidate:OPNode(@"AXTextField", nil)]);
    GH_ASSERT([GHOpenPanelDriver isGoToFieldCandidate:OPNode(@"AXComboBox", nil)]);
    GH_ASSERT_FALSE([GHOpenPanelDriver isGoToFieldCandidate:OPNode(@"AXSecureTextField", nil)]);
    GH_ASSERT_FALSE([GHOpenPanelDriver node:search isInside:sheet]);
    GH_ASSERT([GHOpenPanelDriver node:choose isInside:sheet]);
    GH_ASSERT_FALSE([GHOpenPanelDriver node:nil isInside:sheet]);
}

GH_TEST(openpanel_page_check_reads_page_text_never_field_values) {
    GHFakeAXNode *window = OPNode(@"AXWindow", nil);
    GHFakeAXNode *field = [window addChild:OPNode(@"AXTextField", @"Notes")];
    field.value = @"see resume-alex-chen.pdf";
    GH_ASSERT_FALSE([GHOpenPanelDriver nodes:@[ window ] mentionFilename:@"resume-alex-chen.pdf"]);
    [window addChild:[GHFakeAXNode staticText:@"RESUME-ALEX-CHEN.PDF" frame:CGRectZero]];
    GH_ASSERT([GHOpenPanelDriver nodes:@[ window ] mentionFilename:@"resume-alex-chen.pdf"]);
    GH_ASSERT_FALSE([GHOpenPanelDriver nodes:@[ window ] mentionFilename:@""]);
}

#pragma mark - the whole sequence

GH_TEST(openpanel_attaches_the_resume_with_exactly_one_path_and_two_returns) {
    GHOPWorld *world = OPWorld();
    GHOpenPanelResult *result = [world run];
    GH_ASSERT_MSG(result.ok, @"%@", result);
    GH_ASSERT_EQUAL_INT(result.finalState, GHOpenPanelStateDone);
    GH_ASSERT(result.verifiedOnPage);
    GH_ASSERT_FALSE(result.pressedEscape);
    GH_ASSERT_FALSE(result.panelLeftOpen);
    GH_ASSERT_EQUAL_OBJECTS(result.filename, @"resume-alex-chen.pdf");
    GH_ASSERT_EQUAL_INT(world.presses, 1);
    // Command+Shift+G, the path (in chunks), Return in the go-to sheet, Return on Open. Nothing else.
    NSArray<NSString *> *names = world.poster.postedNames;
    GH_ASSERT_EQUAL_OBJECTS(names.firstObject, @"go-to-folder");
    GH_ASSERT_EQUAL_OBJECTS([names subarrayWithRange:NSMakeRange(names.count - 2, 2)], (@[ @"return", @"return" ]));
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:GHKeyStrokeKindText], names.count - 3);
    GH_ASSERT_EQUAL_OBJECTS(world.poster.typedText, world.path);
    GH_ASSERT_EQUAL_INT(world.returnsInGoTo, 1);
    GH_ASSERT_EQUAL_INT(world.returnsOnOpen, 1);
    GH_ASSERT_EQUAL_INT(world.returnsOutsidePanel, 0);
    GH_ASSERT_EQUAL_INT(world.escapes, 0);
    GH_ASSERT_EQUAL_OBJECTS(world.pageField.value, nil);   // nothing reached the page's text field
    GH_ASSERT_EQUAL_OBJECTS(world.messages, (@[ @"Opening the file picker", @"Picking resume-alex-chen.pdf", @"Attached resume-alex-chen.pdf" ]));
    GH_ASSERT_FALSE(world.driver.running);
    GH_ASSERT_EQUAL_INT(world.driver.currentState, GHOpenPanelStateDone);
}

GH_TEST(openpanel_attaches_through_the_real_greenhouse_tree) {
    GHOPNode *window = OPGreenhouseWindow();
    GH_ASSERT(window != nil);
    GHOPNode *group = (GHOPNode *)OPFind(window, ^BOOL(id<GHAXNode> n) { return [n.title isEqualToString:@"Resume/CV"]; });
    id<GHAXNode> button = [GHOpenPanelDriver uploadButtonInGroup:group];
    GHOPWorld *world = [[GHOPWorld alloc] initWithWindow:window uploadButton:(GHFakeAXNode *)button statusParent:group];
    world.path = OPResumePath();
    GHOpenPanelResult *result = [world run];
    GH_ASSERT_MSG(result.ok, @"%@", result);
    GH_ASSERT_EQUAL_INT(world.returnsOutsidePanel, 0);
    GH_ASSERT_EQUAL_OBJECTS(world.actuator.pressedNodes, (@[ button ]));   // only the file input was pressed
}

GH_TEST(openpanel_selects_a_prefilled_go_to_field_before_typing) {
    GHOPWorld *world = OPWorld();
    world.goToPrefill = @"/Users/alex/Documents";
    GHOpenPanelResult *result = [world run];
    GH_ASSERT_MSG(result.ok, @"%@", result);
    GH_ASSERT_EQUAL_INT(world.actuator.selectAllCount, 1);

    GHOPWorld *stuck = OPWorld();
    stuck.goToPrefill = @"/Users/alex/Documents";
    stuck.selectAllWorks = NO;
    GHOpenPanelResult *refused = [stuck run];
    GH_ASSERT_EQUAL_OBJECTS(refused.reason, GHOpenPanelReasonGoToFieldBusy);
    GH_ASSERT_EQUAL_INT([stuck.poster countOfKind:GHKeyStrokeKindText], 0);   // never appended to the old folder
    GH_ASSERT_EQUAL_INT([stuck.poster countOfKind:GHKeyStrokeKindReturn], 0);
    GH_ASSERT(refused.pressedEscape);
    GH_ASSERT_EQUAL_INT(stuck.escapes, 1);
}

GH_TEST(openpanel_refuses_before_touching_anything) {
    GHOPWorld *world = OPWorld();
    GHOpenPanelResult *relative = [world runWithPath:@"demo/fixtures/resume-alex-chen.pdf" button:world.uploadButton];
    GH_ASSERT_EQUAL_OBJECTS(relative.reason, @"invalid-path:not-absolute");
    GH_ASSERT_EQUAL_INT(relative.finalState, GHOpenPanelStateIdle);

    GHFakeAXNode *submit = OPNode(@"AXButton", @"Submit application");
    GH_ASSERT_EQUAL_OBJECTS([world runWithPath:OPResumePath() button:submit].reason, GHOpenPanelReasonNoUploadTarget);
    GHFakeAXNode *dropbox = OPNode(@"AXButton", @"Dropbox");
    GH_ASSERT_EQUAL_OBJECTS([world runWithPath:OPResumePath() button:dropbox].reason, GHOpenPanelReasonNoUploadTarget);

    world.uploadButton.enabled = NO;
    GH_ASSERT_EQUAL_OBJECTS([world runWithPath:OPResumePath() button:world.uploadButton].reason, GHOpenPanelReasonNoUploadTarget);
    world.uploadButton.enabled = YES;

    world.state.frontmostPID = 0;
    GH_ASSERT_EQUAL_OBJECTS([world runWithPath:OPResumePath() button:world.uploadButton].reason, GHOpenPanelReasonNoFrontmostApp);
    world.state.frontmostPID = world.pid;

    // A panel somebody else opened is not ours to drive.
    [world.window attach:world.panel];
    GH_ASSERT_EQUAL_OBJECTS([world runWithPath:OPResumePath() button:world.uploadButton].reason, GHOpenPanelReasonPanelAlreadyOpen);
    [world.window detach:world.panel];

    // The page already names the file: the final check would prove nothing.
    world.pageStatus.value = @"resume-alex-chen.pdf";
    GH_ASSERT_EQUAL_OBJECTS([world runWithPath:OPResumePath() button:world.uploadButton].reason, GHOpenPanelReasonAlreadyShown);

    GH_ASSERT_EQUAL_INT(world.presses, 0);
    GH_ASSERT(OPNoKeysAtAll(world));
}

GH_TEST(openpanel_panel_that_never_appears_times_out_without_a_key) {
    GHOPWorld *world = OPWorld();
    world.panelAppears = NO;
    NSTimeInterval start = world.clock.now;
    GHOpenPanelResult *result = [world run];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHOpenPanelReasonPanelTimeout);
    GH_ASSERT_EQUAL_INT(result.finalState, GHOpenPanelStateWaitForPanel);
    GH_ASSERT_NEAR(world.clock.now - start, 3.0, 0.11);
    GH_ASSERT_FALSE(result.pressedEscape);
    GH_ASSERT(OPNoKeysAtAll(world));
    GH_ASSERT_EQUAL_OBJECTS(world.messages.lastObject, @"Could not attach resume-alex-chen.pdf (panel-timeout)");

    GHOPWorld *broken = OPWorld();
    broken.pressFails = YES;
    GH_ASSERT_EQUAL_OBJECTS([broken run].reason, GHOpenPanelReasonPressFailed);
    GH_ASSERT(OPNoKeysAtAll(broken));
}

GH_TEST(openpanel_focus_outside_the_panel_blocks_the_go_to_shortcut) {
    GHOPWorld *world = OPWorld();
    world.focusGoesToPanel = NO;
    [world focus:world.pageField];
    GHOpenPanelResult *result = [world run];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHOpenPanelReasonFocusNotInPanel);
    GH_ASSERT_EQUAL_INT(world.poster.posted.count, 0);
    GH_ASSERT_EQUAL_INT(world.poster.guardCalls, 1);
    GH_ASSERT_FALSE(result.pressedEscape);   // no key goes to a page that has focus
    GH_ASSERT(result.panelLeftOpen);
}

GH_TEST(openpanel_go_to_field_timeout_escapes_once) {
    GHOPWorld *world = OPWorld();
    world.goToOpens = NO;
    GHOpenPanelResult *result = [world run];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHOpenPanelReasonGoToTimeout);
    GH_ASSERT(result.pressedEscape);
    GH_ASSERT_EQUAL_INT(world.escapes, 1);
    GH_ASSERT_EQUAL_OBJECTS(world.poster.postedNames, (@[ @"go-to-folder", @"escape" ]));
    GH_ASSERT_FALSE(result.panelLeftOpen);   // the fake panel closes on that Escape

    // The same timeout while focus sits on the page: no Escape at all.
    GHOPWorld *other = OPWorld();
    other.goToFocusesField = NO;
    __weak GHOPWorld *weakOther = other;
    other.afterPost = ^(GHKeyStroke *stroke) { if (stroke.kind == GHKeyStrokeKindGoToFolder) [weakOther focus:weakOther.pageField]; };
    GHOpenPanelResult *leaving = [other run];
    GH_ASSERT_EQUAL_OBJECTS(leaving.reason, GHOpenPanelReasonGoToTimeout);
    GH_ASSERT_FALSE(leaving.pressedEscape);
    GH_ASSERT_EQUAL_INT(other.escapes, 0);
    GH_ASSERT_EQUAL_INT([other.poster countOfKind:GHKeyStrokeKindEscape], 0);
    GH_ASSERT(leaving.panelLeftOpen);
}

GH_TEST(openpanel_never_types_outside_the_go_to_field) {
    // Focus leaves the go-to field in the middle of the path: the rest is never typed anywhere.
    GHOPWorld *world = OPWorld();
    world.path = [GHTestTempDirectory() stringByAppendingPathComponent:@"a-rather-long-folder-name/resume-alex-chen.pdf"];
    [NSFileManager.defaultManager createDirectoryAtPath:world.path.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:NULL];
    [@"%PDF" writeToFile:world.path atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    __block NSUInteger chunks = 0;
    __weak GHOPWorld *weakWorld = world;
    world.afterPost = ^(GHKeyStroke *stroke) {
        if (stroke.kind == GHKeyStrokeKindText && ++chunks == 1) [weakWorld focus:weakWorld.pageField];
    };
    GHOpenPanelResult *result = [world run];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHOpenPanelReasonFocusChanged);
    GH_ASSERT_EQUAL_INT(chunks, 1);
    GH_ASSERT(world.path.length > 20);
    GH_ASSERT_EQUAL_OBJECTS(world.pageField.value, nil);
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:GHKeyStrokeKindReturn], 0);
    GH_ASSERT_FALSE(result.pressedEscape);
    GH_ASSERT_EQUAL_INT(world.returnsOutsidePanel, 0);
}

GH_TEST(openpanel_path_that_did_not_land_exactly_is_never_confirmed) {
    GHOPWorld *world = OPWorld();
    world.dropFirstCharacter = YES;   // the field lost the leading "/"
    GHOpenPanelResult *result = [world run];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHOpenPanelReasonPathMismatch);
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:GHKeyStrokeKindReturn], 0);
    GH_ASSERT(result.pressedEscape);
    GH_ASSERT_EQUAL_INT(world.escapes, 1);
}

GH_TEST(openpanel_first_return_that_closes_the_panel_is_never_followed_by_another) {
    for (NSNumber *closes in @[ @YES, @NO ]) {
        GHOPWorld *world = OPWorld();
        world.firstReturnCloses = closes.boolValue;
        GHOpenPanelResult *result = [world run];
        GH_ASSERT_MSG(result.ok, @"%@", result);
        GH_ASSERT_EQUAL_INT(world.returnsOutsidePanel, 0);
        GH_ASSERT_EQUAL_INT([world.poster countOfKind:GHKeyStrokeKindReturn], closes.boolValue ? 1 : 2);
    }
}

GH_TEST(openpanel_each_return_rechecks_everything_at_the_last_moment) {
    // The go-to field changes between the read-back and the Return: no Return.
    GHOPWorld *edited = OPWorld();
    __weak GHOPWorld *weakEdited = edited;
    edited.state.onFocusRead = ^{
        GHOPWorld *world = weakEdited;
        if (world.driver.currentState == GHOpenPanelStateConfirmGoTo) world.goToField.value = @"/Users/alex/Documents/other.pdf";
    };
    GHOpenPanelResult *changed = [edited run];
    GH_ASSERT_FALSE(changed.ok);
    GH_ASSERT_EQUAL_OBJECTS(changed.reason, GHOpenPanelReasonFocusChanged);
    GH_ASSERT_EQUAL_INT([edited.poster countOfKind:GHKeyStrokeKindReturn], 0);

    // Focus jumps to the page right before the Return on Open: no Return reaches the page.
    GHOPWorld *jumped = OPWorld();
    __weak GHOPWorld *weakJumped = jumped;
    jumped.state.onFocusRead = ^{
        GHOPWorld *world = weakJumped;
        if (world.driver.currentState == GHOpenPanelStateConfirmOpen) [world focus:world.pageField];
    };
    GHOpenPanelResult *refused = [jumped run];
    GH_ASSERT_EQUAL_OBJECTS(refused.reason, GHOpenPanelReasonFocusNotInPanel);
    GH_ASSERT_EQUAL_INT([jumped.poster countOfKind:GHKeyStrokeKindReturn], 1);   // the go-to Return only
    GH_ASSERT_EQUAL_INT(jumped.returnsOnOpen, 0);
    GH_ASSERT_EQUAL_INT(jumped.returnsOutsidePanel, 0);
    GH_ASSERT_FALSE(refused.pressedEscape);   // focus is on the page: no Escape either
    GH_ASSERT(refused.panelLeftOpen);

    // The panel is gone at that moment (closed by the user): no Return either.
    GHOPWorld *gone = OPWorld();
    __weak GHOPWorld *weakGone = gone;
    gone.state.onFocusRead = ^{
        GHOPWorld *world = weakGone;
        if (world.driver.currentState == GHOpenPanelStateConfirmOpen && [world panelOpen]) [world.window detach:world.panel];
    };
    GHOpenPanelResult *vanished = [gone run];
    GH_ASSERT_FALSE(vanished.ok);
    GH_ASSERT_EQUAL_INT([gone.poster countOfKind:GHKeyStrokeKindReturn], 1);
    GH_ASSERT_EQUAL_INT(gone.returnsOutsidePanel, 0);
}

GH_TEST(openpanel_disabled_open_button_is_never_confirmed) {
    GHOPWorld *world = OPWorld();
    world.openEnabledAfterGoTo = NO;   // the panel did not accept the file (wrong type)
    GHOpenPanelResult *result = [world run];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHOpenPanelReasonGoToDismissTimeout);
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:GHKeyStrokeKindReturn], 1);   // only the go-to Return
    GH_ASSERT_EQUAL_INT(world.returnsOnOpen, 0);
    GH_ASSERT(result.pressedEscape);
    GH_ASSERT_EQUAL_INT(world.escapes, 1);
}

GH_TEST(openpanel_panel_that_stays_open_times_out_with_one_escape) {
    GHOPWorld *world = OPWorld();
    world.openCloses = NO;
    GHOpenPanelResult *result = [world run];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHOpenPanelReasonPanelCloseTimeout);
    GH_ASSERT_EQUAL_INT(result.finalState, GHOpenPanelStateWaitForPanelClosed);
    GH_ASSERT_EQUAL_INT(world.escapes, 1);
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:GHKeyStrokeKindEscape], 1);
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:GHKeyStrokeKindReturn], 2);
}

GH_TEST(openpanel_success_needs_the_page_to_show_the_file) {
    GHOPWorld *world = OPWorld();
    world.pageShowsName = NO;
    GHOpenPanelResult *result = [world run];
    GH_ASSERT_FALSE(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHOpenPanelReasonFilenameNotShown);
    GH_ASSERT_FALSE(result.verifiedOnPage);
    GH_ASSERT_FALSE(result.pressedEscape);   // the panel is gone: nothing to cancel
    GH_ASSERT_FALSE(result.panelLeftOpen);

    // An injected page check replaces the default one.
    GHOPWorld *custom = OPWorld();
    custom.pageShowsName = NO;
    __block NSUInteger asked = 0;
    custom.driver.pageShowsFilename = ^BOOL(NSString *filename, pid_t pid) { return ++asked > 2; };
    GH_ASSERT([custom run].ok);
    custom.driver.pageShowsFilename = nil;   // null_resettable: back to the default
    GH_ASSERT(custom.driver.pageShowsFilename != nil);
}

GH_TEST(openpanel_user_key_aborts_and_nothing_more_is_posted) {
    GHOPWorld *world = OPWorld();
    __weak GHOPWorld *weakWorld = world;
    world.afterPost = ^(GHKeyStroke *stroke) { if (stroke.kind == GHKeyStrokeKindGoToFolder) [weakWorld.driver noteUserKeyEvent]; };
    GHOpenPanelResult *result = [world run];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHOpenPanelReasonUserKey);
    GH_ASSERT_EQUAL_OBJECTS(world.poster.postedNames, (@[ @"go-to-folder" ]));
    GH_ASSERT_FALSE(result.pressedEscape);

    // Mid-path: the guard sees the flag before the next chunk.
    GHOPWorld *typing = OPWorld();
    typing.path = [GHTestTempDirectory() stringByAppendingPathComponent:@"another-long-folder-name/resume-alex-chen.pdf"];
    [NSFileManager.defaultManager createDirectoryAtPath:typing.path.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:NULL];
    [@"%PDF" writeToFile:typing.path atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    __weak GHOPWorld *weakTyping = typing;
    typing.afterPost = ^(GHKeyStroke *stroke) { if (stroke.kind == GHKeyStrokeKindText) [weakTyping.driver noteUserKeyEvent]; };
    GHOpenPanelResult *interrupted = [typing run];
    GH_ASSERT_EQUAL_OBJECTS(interrupted.reason, GHOpenPanelReasonUserKey);
    GH_ASSERT_EQUAL_INT([typing.poster countOfKind:GHKeyStrokeKindText], 1);
    GH_ASSERT_EQUAL_INT([typing.poster countOfKind:GHKeyStrokeKindReturn], 0);
    GH_ASSERT_EQUAL_INT([typing.poster countOfKind:GHKeyStrokeKindEscape], 0);

    // Keys while nothing runs are not remembered for the next run.
    GHOPWorld *idle = OPWorld();
    [idle.driver noteUserKeyEvent];
    GH_ASSERT([idle run].ok);
}

GH_TEST(openpanel_app_switch_aborts_without_a_key) {
    GHOPWorld *world = OPWorld();
    __weak GHOPWorld *weakWorld = world;
    world.onPress = ^{ weakWorld.state.frontmostPID = 999; };   // the user switched apps as the panel opened
    GHOpenPanelResult *result = [world run];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, GHOpenPanelReasonAppChanged);
    GH_ASSERT(OPNoKeysAtAll(world));

    // Switching right after the go-to Return: the Return on Open never follows.
    GHOPWorld *late = OPWorld();
    __weak GHOPWorld *weakLate = late;
    late.afterPost = ^(GHKeyStroke *stroke) {
        if (stroke.kind == GHKeyStrokeKindReturn && weakLate.returnsInGoTo == 1) weakLate.state.frontmostPID = 999;
    };
    GHOpenPanelResult *refused = [late run];
    GH_ASSERT_EQUAL_OBJECTS(refused.reason, GHOpenPanelReasonAppChanged);
    GH_ASSERT_EQUAL_INT([late.poster countOfKind:GHKeyStrokeKindReturn], 1);
    GH_ASSERT_EQUAL_INT([late.poster countOfKind:GHKeyStrokeKindEscape], 0);
}

GH_TEST(openpanel_one_run_at_a_time_and_cancel_stops_everything) {
    GHOPWorld *world = OPWorld();
    world.goToOpens = NO;   // it will sit in waitForGoToField
    world.path = OPResumePath();
    __block GHOpenPanelResult *first = nil;
    [world.driver attachFileAtPath:world.path uploadButton:world.uploadButton completion:^(GHOpenPanelResult *r) { first = r; }];
    GH_ASSERT(world.driver.running);
    GH_ASSERT_EQUAL_INT(world.driver.currentState, GHOpenPanelStateWaitForGoToField);
    __block GHOpenPanelResult *second = nil;
    [world.driver attachFileAtPath:world.path uploadButton:world.uploadButton completion:^(GHOpenPanelResult *r) { second = r; }];
    GH_ASSERT_EQUAL_OBJECTS(second.reason, GHOpenPanelReasonBusy);
    GH_ASSERT(world.driver.running);

    [world.driver cancel];
    GH_ASSERT_EQUAL_OBJECTS(first.reason, GHOpenPanelReasonCancelled);
    GH_ASSERT_FALSE(world.driver.running);
    NSUInteger posted = world.poster.posted.count;
    [world.clock runUntil:^BOOL { return NO; }];   // stale timers do nothing
    GH_ASSERT_EQUAL_INT(world.poster.posted.count, posted);
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:GHKeyStrokeKindEscape], 0);
    [world.driver cancel];   // idempotent
}

GH_TEST(openpanel_page_check_reads_web_content_never_tab_titles) {
    GHFakeAXNode *window = OPNode(@"AXWindow", nil);
    GHFakeAXNode *tabs = [window addChild:OPNode(@"AXTabGroup", nil)];
    GHFakeAXNode *tab = [tabs addChild:OPNode(@"AXRadioButton", @"resume-alex-chen.pdf")];   // another tab shows the PDF
    tab.subrole = @"AXTabButton";
    GHFakeAXNode *web = [tabs addChild:OPNode(@"AXWebArea", nil)];
    [web addChild:OPNode(@"AXButton", @"Attach")];
    GH_ASSERT_EQUAL_OBJECTS([GHOpenPanelDriver webAreasInWindows:@[ window ]], (@[ web ]));
    GHFakeDesktopState *state = [[GHFakeDesktopState alloc] init];
    [state addWindow:window forPID:9];
    GHOpenPanelDriver *driver = [[GHOpenPanelDriver alloc] initWithActuator:[[GHFakeAXActuator alloc] init]
                                                                     poster:[[GHFakeKeyPoster alloc] initWithState:state] state:state];
    GH_ASSERT_FALSE(driver.pageShowsFilename(@"resume-alex-chen.pdf", 9));
    [web addChild:[GHFakeAXNode staticText:@"resume-alex-chen.pdf" frame:CGRectZero]];
    GH_ASSERT(driver.pageShowsFilename(@"resume-alex-chen.pdf", 9));
    // A window without web content (a native app) is searched as a whole.
    GHFakeAXNode *native = OPNode(@"AXWindow", nil);
    [native addChild:[GHFakeAXNode staticText:@"cover.pdf" frame:CGRectZero]];
    [state addWindow:native forPID:10];
    GH_ASSERT(driver.pageShowsFilename(@"cover.pdf", 10));
}

#pragma mark - live-like snapshots and walk budgets

/// What a live GHAXElementNode is: every attribute and the children list are read ONCE, when first asked for. A
/// stale snapshot is the whole point: only a fresh one (refreshedNode:, windowsOfProcess:) sees new state.
@interface GHOPSnapshot : NSObject <GHAXNode>
@property (nonatomic, strong, readonly) GHFakeAXNode *target;
+ (instancetype)of:(GHFakeAXNode *)target;
@end

@implementation GHOPSnapshot {
    NSString *_role, *_subrole, *_roleDescription, *_title, *_axDescription, *_placeholder, *_help, *_value, *_identifier;
    BOOL _enabled, _required, _isFocused, _valueIsSettable, _pressable;
    CGRect _frame;
    NSArray<id<GHAXNode>> *_children;
    id<GHAXNode> _parent;
    BOOL _parentRead;
}
@synthesize valueIsSettable = _valueIsSettable, pressable = _pressable;
+ (instancetype)of:(GHFakeAXNode *)target {
    if (!target) return nil;
    GHOPSnapshot *node = [[self alloc] init];
    node->_target = target;
    node->_role = target.role; node->_subrole = target.subrole; node->_roleDescription = target.roleDescription;
    node->_title = target.title; node->_axDescription = target.axDescription; node->_placeholder = target.placeholder;
    node->_help = target.help; node->_value = target.value; node->_identifier = target.identifier;
    node->_enabled = target.enabled; node->_required = target.required; node->_isFocused = target.isFocused; node->_frame = target.frame;
    return node;
}
- (NSString *)role { return _role; }
- (NSString *)subrole { return _subrole; }
- (NSString *)roleDescription { return _roleDescription; }
- (NSString *)title { return _title; }
- (NSString *)axDescription { return _axDescription; }
- (NSString *)placeholder { return _placeholder; }
- (NSString *)help { return _help; }
- (NSString *)value { return _value; }
- (NSString *)identifier { return _identifier; }
- (NSArray<NSString *> *)domClassList { return nil; }
- (BOOL)enabled { return _enabled; }
- (BOOL)required { return _required; }
- (BOOL)isFocused { return _isFocused; }
- (CGRect)frame { return _frame; }
- (id<GHAXNode>)titleUIElement { return nil; }
- (AXUIElementRef)axElement { return NULL; }
- (NSArray<id<GHAXNode>> *)children {
    if (!_children) {
        NSMutableArray *out = [NSMutableArray array];
        for (id<GHAXNode> child in _target.children) if ([(id)child isKindOfClass:[GHFakeAXNode class]]) [out addObject:[GHOPSnapshot of:(GHFakeAXNode *)child]];
        _children = out;
    }
    return _children;
}
- (id<GHAXNode>)parent {
    if (!_parentRead) {
        _parentRead = YES;
        id<GHAXNode> up = _target.parent;
        _parent = [(id)up isKindOfClass:[GHFakeAXNode class]] ? [GHOPSnapshot of:(GHFakeAXNode *)up] : nil;
    }
    return _parent;
}
- (BOOL)isSameNode:(id<GHAXNode>)other {
    if ([(id)other isKindOfClass:[GHOPSnapshot class]]) return ((GHOPSnapshot *)other).target == _target;
    return (id)other == (id)_target;
}
@end

static GHFakeAXNode *OPUnwrap(id<GHAXNode> node) {
    if ([(id)node isKindOfClass:[GHOPSnapshot class]]) return ((GHOPSnapshot *)node).target;
    return [(id)node isKindOfClass:[GHFakeAXNode class]] ? (GHFakeAXNode *)node : nil;
}

/// The desktop as the live code sees it: fresh snapshots on every read, never the fake objects themselves.
@interface GHOPSnapshotState : GHOPState
@end
@implementation GHOPSnapshotState
- (NSArray<id<GHAXNode>> *)windowsOfProcess:(pid_t)pid {
    NSMutableArray *out = [NSMutableArray array];
    for (id<GHAXNode> window in [super windowsOfProcess:pid]) [out addObject:[GHOPSnapshot of:OPUnwrap(window)]];
    return out;
}
- (id<GHAXNode>)focusedElement {
    return [GHOPSnapshot of:OPUnwrap([super focusedElement])];
}
@end

@interface GHOPSnapshotActuator : GHOPActuator
@end
@implementation GHOPSnapshotActuator
- (id<GHAXNode>)refreshedNode:(id<GHAXNode>)node {
    GHFakeAXNode *fake = OPUnwrap(node);
    if (!fake || [self.goneNodes containsObject:fake]) return nil;
    return [(id)node isKindOfClass:[GHOPSnapshot class]] ? [GHOPSnapshot of:fake] : fake;
}
- (BOOL)pressNode:(id<GHAXNode>)node { return [super pressNode:OPUnwrap(node) ?: node]; }
- (BOOL)selectAllInNode:(id<GHAXNode>)node { return [super selectAllInNode:OPUnwrap(node) ?: node]; }
@end

@interface GHOPWorld (Reactions)
- (void)react:(GHKeyStroke *)stroke;
@end

/// The synthetic world, re-wired so the driver only ever sees snapshots.
static GHOPWorld *OPSnapshotWorld(void) {
    GHOPWorld *world = OPWorld();
    GHOPSnapshotState *state = [[GHOPSnapshotState alloc] init];
    state.frontmostPID = world.pid;
    [state addWindow:world.window forPID:world.pid];
    world.state = state;
    GHOPSnapshotActuator *actuator = [[GHOPSnapshotActuator alloc] init];
    actuator.world = world;
    world.actuator = actuator;
    world.poster = [[GHFakeKeyPoster alloc] initWithState:state];
    __weak GHOPWorld *weakWorld = world;
    world.poster.onPost = ^(GHKeyStroke *stroke) { [weakWorld react:stroke]; };
    GHOpenPanelDriver *driver = [[GHOpenPanelDriver alloc] initWithActuator:actuator poster:world.poster state:state];
    driver.after = world.clock.after;
    driver.clock = world.clock.clock;
    world.driver = driver;
    return world;
}

GH_TEST(openpanel_open_button_is_read_from_a_fresh_panel_never_the_cached_snapshot) {
    // The panel appears with Upload disabled (nothing chosen). The go-to Return enables it. A driver that kept reading
    // the snapshot it took when the panel appeared would wait for "enabled" forever and time out.
    GHOPWorld *world = OPSnapshotWorld();
    GHOpenPanelResult *result = [world run];
    GH_ASSERT_MSG(result.ok, @"%@", result);
    GH_ASSERT_EQUAL_INT(world.returnsInGoTo, 1);
    GH_ASSERT_EQUAL_INT(world.returnsOnOpen, 1);
    GH_ASSERT_EQUAL_INT(world.escapes, 0);

    // And the other way round: Upload stays disabled (the path did not select anything). No second Return, ever.
    GHOPWorld *disabled = OPSnapshotWorld();
    disabled.openEnabledAfterGoTo = NO;
    GHOpenPanelResult *refused = [disabled run];
    GH_ASSERT_FALSE(refused.ok);
    GH_ASSERT_EQUAL_OBJECTS(refused.reason, GHOpenPanelReasonGoToDismissTimeout);
    GH_ASSERT_EQUAL_INT(disabled.returnsOnOpen, 0);
}

/// A node that takes `delay` seconds to hand out its children (a busy web process).
@interface GHOPSlowNode : GHFakeAXNode
@property (nonatomic) NSTimeInterval delay;
@end
@implementation GHOPSlowNode
- (NSArray<id<GHAXNode>> *)children {
    if (self.delay > 0) usleep((useconds_t)(self.delay * 1e6));
    return [super children];
}
@end

GH_TEST(ax_walk_budget_counts_nodes_time_and_hangs) {
    GHAXWalkBudget budget = GHAXWalkBudgetMake(2, 0);
    GHFakeAXNode *node = OPNode(@"AXGroup", nil);
    GH_ASSERT(GHAXWalkBudgetSpend(&budget, node));
    GH_ASSERT(GHAXWalkBudgetSpend(&budget, node));
    GH_ASSERT_FALSE(GHAXWalkBudgetSpend(&budget, node));
    GH_ASSERT(budget.exhausted);
    GHAXWalkBudget timed = GHAXWalkBudgetMake(100, 0.01);
    usleep(20000);
    GH_ASSERT_FALSE(GHAXWalkBudgetSpend(&timed, node));
    GH_ASSERT(timed.exhausted);
    GHFakeAXNode *hung = OPNode(@"AXGroup", nil);
    hung.lastError = kAXErrorCannotComplete;
    GHAXWalkBudget open = GHAXWalkBudgetMake(100, 1);
    GH_ASSERT_FALSE(GHAXWalkBudgetSpend(&open, hung));
    GH_ASSERT(open.hung);
    GH_ASSERT_FALSE(GHAXWalkBudgetSpend(&open, node));      // nothing more is read from that app in this walk
    GHAXWalkBudget nested = GHAXWalkBudgetNested(&open, 10);
    GH_ASSERT_FALSE(GHAXWalkBudgetSpend(&nested, node));
    GH_ASSERT(GHAXNodeLooksHung(hung));
    GH_ASSERT_FALSE(GHAXNodeLooksHung(node));
}

GH_TEST(openpanel_page_check_stops_at_a_hung_app_and_at_its_deadline) {
    // A hung web process: the first node that says so ends the check; nothing after it is expanded.
    GHFakeAXNode *window = OPNode(@"AXWindow", nil);
    GHFakeAXNode *web = [window addChild:OPNode(@"AXWebArea", nil)];
    GHFakeAXNode *hung = [web addChild:OPNode(@"AXGroup", nil)];
    hung.lastError = kAXErrorCannotComplete;
    GHFakeAXNode *after = [web addChild:OPNode(@"AXGroup", nil)];
    [after addChild:[GHFakeAXNode staticText:@"resume-alex-chen.pdf" frame:CGRectZero]];
    GH_ASSERT_FALSE([GHOpenPanelDriver windows:@[ window ] showFilename:@"resume-alex-chen.pdf"]);
    GH_ASSERT_EQUAL_INT(hung.childrenReadCount, 0);
    GH_ASSERT_EQUAL_INT(after.childrenReadCount, 0);
    hung.lastError = kAXErrorSuccess;
    GH_ASSERT([GHOpenPanelDriver windows:@[ window ] showFilename:@"resume-alex-chen.pdf"]);

    // A slow page: the check gives up at its wall-clock budget instead of walking thousands of nodes.
    GHFakeAXNode *slowWindow = OPNode(@"AXWindow", nil);
    GHFakeAXNode *slowWeb = [slowWindow addChild:OPNode(@"AXWebArea", nil)];
    for (int i = 0; i < 200; i++) {
        GHOPSlowNode *slow = [GHOPSlowNode nodeWithRole:@"AXGroup"];
        slow.delay = 0.01;
        [slowWeb addChild:slow];
    }
    [slowWeb addChild:[GHFakeAXNode staticText:@"resume-alex-chen.pdf" frame:CGRectZero]];
    CFAbsoluteTime started = CFAbsoluteTimeGetCurrent();
    GH_ASSERT_FALSE([GHOpenPanelDriver windows:@[ slowWindow ] showFilename:@"resume-alex-chen.pdf"]);
    NSTimeInterval spent = CFAbsoluteTimeGetCurrent() - started;
    GH_ASSERT_MSG(spent < GHOpenPanelPageCheckSeconds + 0.25, @"the page check took %.2f s", spent);
}
