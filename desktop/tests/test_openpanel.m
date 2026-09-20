// SBKeyPoster and SBOpenPanelDriver without a keyboard, without AX and without a real open panel: a fake "Safari"
// (page, sheet panel, go-to sheet) reacts to the fake poster's posts, and a hand-driven clock runs every wait.
// Nothing in this file can post a real event: only SBFakeKeyPoster is used, never the live sink.
#import "SBTest.h"
#import "SBKeyPoster.h"
#import "SBOpenPanelDriver.h"
#import "SBEventTap.h"

#pragma mark - fakes

/// A fake node whose children can come and go (a sheet that opens and closes).
@interface SBOPNode : SBFakeAXNode
- (void)attach:(SBFakeAXNode *)child;
- (void)detach:(SBFakeAXNode *)child;
- (BOOL)holds:(SBFakeAXNode *)child;
@end

@implementation SBOPNode {
    NSMutableArray<SBFakeAXNode *> *_attached;
}
- (NSArray<id<SBAXNode>> *)children {
    NSArray<id<SBAXNode>> *fixed = [super children];
    return _attached.count ? [fixed arrayByAddingObjectsFromArray:_attached] : fixed;
}
- (void)attach:(SBFakeAXNode *)child {
    if (!_attached) _attached = [NSMutableArray array];
    if ([_attached containsObject:child]) return;
    child.parent = self;
    [_attached addObject:child];
}
- (void)detach:(SBFakeAXNode *)child { [_attached removeObject:child]; }
- (BOOL)holds:(SBFakeAXNode *)child { return [_attached containsObject:child]; }
@end

/// Timers run in time order by hand; `now` jumps to each timer.
@interface SBOPClock : NSObject
@property (nonatomic) NSTimeInterval now;
@property (nonatomic, readonly) NSMutableArray<NSArray *> *timers;
@end

@implementation SBOPClock
- (instancetype)init {
    if ((self = [super init])) { _timers = [NSMutableArray array]; _now = 100; }
    return self;
}
- (void (^)(NSTimeInterval, dispatch_block_t))after {
    __weak SBOPClock *weakSelf = self;
    return ^(NSTimeInterval delay, dispatch_block_t block) {
        SBOPClock *clock = weakSelf;
        [clock.timers addObject:@[ @(clock.now + delay), [block copy] ]];
    };
}
- (NSTimeInterval (^)(void))clock {
    __weak SBOPClock *weakSelf = self;
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

@interface SBOPState : SBFakeDesktopState
/// Runs on every focus read; the poster reads focus right before each post, so this is "the last moment".
@property (nonatomic, copy) void (^onFocusRead)(void);
@end

@implementation SBOPState
- (id<SBAXNode>)focusedElement {
    if (self.onFocusRead) self.onFocusRead();
    return [super focusedElement];
}
@end

@class SBOPWorld;

@interface SBOPActuator : SBFakeAXActuator
@property (nonatomic, weak) SBOPWorld *world;
@property (nonatomic) NSUInteger selectAllCount;
@end

/// A fake Safari with a file-upload page and the macOS open panel as a sheet.
@interface SBOPWorld : NSObject
@property (nonatomic) pid_t pid;
@property (nonatomic, strong) SBOPState *state;
@property (nonatomic, strong) SBFakeKeyPoster *poster;
@property (nonatomic, strong) SBOPActuator *actuator;
@property (nonatomic, strong) SBOPClock *clock;
@property (nonatomic, strong) SBOpenPanelDriver *driver;
@property (nonatomic, strong) NSMutableArray<NSString *> *messages;

@property (nonatomic, strong) SBOPNode *window;
@property (nonatomic, strong) SBFakeAXNode *uploadButton, *pageField, *pageStatus;
@property (nonatomic, strong) SBOPNode *panel, *goToSheet;
@property (nonatomic, strong) SBFakeAXNode *fileList, *openButton, *goToField, *searchField;
@property (nonatomic, copy) NSString *path;
@property (nonatomic, weak) SBFakeAXNode *selectedAll;

// How the "app" behaves.
@property (nonatomic) BOOL pressFails, panelAppears, focusGoesToPanel, goToOpens, goToFocusesField, typingLands, dropFirstCharacter;
@property (nonatomic) BOOL firstReturnCloses, openCloses, pageShowsName, openEnabledAfterGoTo, selectAllWorks;
@property (nonatomic, copy) NSString *goToPrefill;
@property (nonatomic, copy) void (^onPress)(void);
@property (nonatomic, copy) void (^afterPost)(SBKeyStroke *stroke);

// What happened.
@property (nonatomic) NSUInteger returnsInGoTo, returnsOnOpen, returnsOutsidePanel, escapes, presses;
- (void)focus:(SBFakeAXNode *)node;
- (BOOL)panelOpen;
@end

@implementation SBOPActuator
- (BOOL)pressNode:(id<SBAXNode>)node {
    [super pressNode:node];
    SBOPWorld *world = self.world;
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
- (BOOL)selectAllInNode:(id<SBAXNode>)node {
    self.selectAllCount++;
    if (!self.world.selectAllWorks) return NO;
    self.world.selectedAll = (SBFakeAXNode *)node;
    return YES;
}
@end

static SBFakeAXNode *OPNode(NSString *role, NSString *title) {
    SBOPNode *node = [SBOPNode nodeWithRole:role];
    node.title = title;
    node.frame = CGRectMake(0, 0, 100, 20);
    return node;
}

@implementation SBOPWorld

- (instancetype)initWithWindow:(SBOPNode *)window uploadButton:(SBFakeAXNode *)uploadButton statusParent:(SBOPNode *)statusParent {
    if ((self = [super init])) {
        _pid = 4242;
        _state = [[SBOPState alloc] init];
        _state.frontmostPID = _pid;
        _poster = [[SBFakeKeyPoster alloc] initWithState:_state];
        _actuator = [[SBOPActuator alloc] init];
        _actuator.world = self;
        _clock = [[SBOPClock alloc] init];
        _messages = [NSMutableArray array];
        _window = window;
        _uploadButton = uploadButton;
        [_state addWindow:window forPID:_pid];
        _pageStatus = [SBFakeAXNode staticText:@"" frame:CGRectZero];
        [statusParent attach:_pageStatus];

        _panel = (SBOPNode *)OPNode(@"AXSheet", nil);
        _fileList = [_panel addChild:OPNode(@"AXOutline", nil)];
        _searchField = [_panel addChild:OPNode(@"AXTextField", nil)];
        _searchField.subrole = @"AXSearchField";
        [_panel addChild:OPNode(@"AXButton", @"Cancel")];
        _openButton = [_panel addChild:OPNode(@"AXButton", @"Upload")];
        _openButton.enabled = NO;   // nothing chosen yet
        _goToSheet = (SBOPNode *)OPNode(@"AXSheet", nil);
        _goToField = [_goToSheet addChild:OPNode(@"AXTextField", nil)];
        [_goToSheet addChild:OPNode(@"AXButton", @"Go")];

        _panelAppears = _focusGoesToPanel = _goToOpens = _goToFocusesField = _typingLands = YES;
        _openCloses = _pageShowsName = _openEnabledAfterGoTo = _selectAllWorks = YES;

        __weak SBOPWorld *weakSelf = self;
        _poster.onPost = ^(SBKeyStroke *stroke) { [weakSelf react:stroke]; };

        _driver = [[SBOpenPanelDriver alloc] initWithActuator:_actuator poster:_poster state:_state];
        _driver.after = _clock.after;
        _driver.clock = _clock.clock;
        _driver.progress = ^(SBOpenPanelState state, NSString *message) { [weakSelf.messages addObject:message]; };
    }
    return self;
}

/// Page: window > web area > "Resume/CV" group (file input + Attach) + a text field.
+ (instancetype)syntheticWorld {
    SBOPNode *window = (SBOPNode *)OPNode(@"AXWindow", nil);
    window.subrole = @"AXStandardWindow";
    SBFakeAXNode *web = [window addChild:OPNode(@"AXWebArea", nil)];
    SBOPNode *group = (SBOPNode *)[web addChild:OPNode(@"AXGroup", @"Resume/CV")];
    [group addChild:OPNode(@"AXButton", @"Attach")];
    SBFakeAXNode *input = [group addChild:OPNode(@"AXButton", nil)];
    input.subrole = @"AXFileUploadButton";
    input.identifier = @"resume";
    SBOPWorld *world = [[self alloc] initWithWindow:window uploadButton:input statusParent:group];
    world.pageField = [web addChild:OPNode(@"AXTextField", @"First Name")];
    return world;
}

- (void)focus:(SBFakeAXNode *)node {
    ((SBFakeAXNode *)self.state.focusedNode).isFocused = NO;
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

- (void)react:(SBKeyStroke *)stroke {
    SBFakeAXNode *focused = (SBFakeAXNode *)self.state.focusedNode;
    switch (stroke.kind) {
        case SBKeyStrokeKindGoToFolder:
            if (self.goToOpens && [self panelOpen] && [SBOpenPanelDriver node:focused isInside:self.panel]) {
                [self.panel attach:self.goToSheet];
                [self.actuator.goneNodes removeObject:self.goToField];
                self.goToField.value = self.goToPrefill ?: @"";
                if (self.goToFocusesField) [self focus:self.goToField];
            }
            break;
        case SBKeyStrokeKindText: {
            if (!self.typingLands || !focused) break;
            NSString *text = stroke.text;
            if (self.dropFirstCharacter && text.length) { text = [text substringFromIndex:1]; self.dropFirstCharacter = NO; }
            NSString *base = self.selectedAll == focused ? @"" : (focused.value ?: @"");
            focused.value = [base stringByAppendingString:text];
            self.selectedAll = nil;
            break;
        }
        case SBKeyStrokeKindReturn:
            if (focused == self.goToField && [self goToOpen]) {
                self.returnsInGoTo++;
                [self.panel detach:self.goToSheet];
                [self.actuator.goneNodes addObject:self.goToField];
                BOOL chosen = [self.goToField.value isEqualToString:self.path];
                if (chosen) self.openButton.enabled = self.openEnabledAfterGoTo;
                [self focus:self.fileList];
                if (chosen && self.firstReturnCloses) [self closePanelWithFile:YES];
            } else if ([self panelOpen] && [SBOpenPanelDriver node:focused isInside:self.panel]) {
                self.returnsOnOpen++;
                if (self.openButton.enabled && self.openCloses) [self closePanelWithFile:YES];
            } else {
                self.returnsOutsidePanel++;   // a Return that reached the page: must never happen
            }
            break;
        case SBKeyStrokeKindEscape:
            self.escapes++;
            if ([self goToOpen]) { [self.panel detach:self.goToSheet]; [self focus:self.fileList]; }
            else if ([self panelOpen]) [self closePanelWithFile:NO];
            break;
        default:
            break;
    }
    if (self.afterPost) self.afterPost(stroke);
}

- (SBOpenPanelResult *)runWithPath:(NSString *)path button:(id<SBAXNode>)button {
    self.path = path;
    __block SBOpenPanelResult *result = nil;
    [self.driver attachFileAtPath:path uploadButton:button completion:^(SBOpenPanelResult *r) { result = r; }];
    [self.clock runUntil:^BOOL { return result != nil; }];
    return result;
}

- (SBOpenPanelResult *)run {
    return [self runWithPath:self.path button:self.uploadButton];
}

@end

/// A fictional resume in a temp folder (the real fixture path is checked separately).
static NSString *OPResumePath(void) {
    NSString *path = [SBTestTempDirectory() stringByAppendingPathComponent:@"resume-alex-chen.pdf"];
    [@"%PDF-1.4 fictional resume for Alex Chen" writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    return path;
}

static SBOPWorld *OPWorld(void) {
    SBOPWorld *world = [SBOPWorld syntheticWorld];
    world.path = OPResumePath();
    return world;
}

static BOOL OPNoKeysAtAll(SBOPWorld *world) {
    return world.poster.posted.count == 0 && world.poster.guardCalls == 0;
}

#pragma mark - SBKeyPoster

GH_TEST(keyposter_can_never_post_space_enter_or_tab) {
    NSArray<NSNumber *> *codes = [SBKeyPoster postableKeyCodes];
    for (NSNumber *forbidden in @[ @49 /* Space */, @76 /* keypad Enter */, @48 /* Tab */ ]) GH_ASSERT_FALSE([codes containsObject:forbidden]);
    GH_ASSERT_EQUAL_OBJECTS(codes, (@[ @0, @5, @36, @51, @53, @125, @126 ]));
    for (SBKeyStroke *stroke in @[ [SBKeyStroke text:@"a"], [SBKeyStroke escape], [SBKeyStroke downArrow], [SBKeyStroke upArrow],
                                   [SBKeyStroke backspace], [SBKeyStroke goToFolder], [SBKeyStroke returnKey] ]) {
        GH_ASSERT([codes containsObject:@(stroke.keyCode)]);
    }
    SBKeyStroke *goTo = [SBKeyStroke goToFolder];
    GH_ASSERT_EQUAL_INT(goTo.keyCode, 5);
    GH_ASSERT_EQUAL_INT(goTo.flags, kCGEventFlagMaskCommand | kCGEventFlagMaskShift);
    GH_ASSERT_EQUAL_INT([SBKeyStroke returnKey].flags, 0);
    GH_ASSERT_FALSE([[SBKeyStroke text:@"secret"].description containsString:@"secret"]);
    // The live poster is only constructed here, never asked to post.
    SBKeyPoster *live = [SBKeyPoster livePoster];
    GH_ASSERT([live.sink isKindOfClass:SBTaggedKeyEventSink.class]);
    GH_ASSERT([(id)live.state isKindOfClass:SBLiveDesktopState.class]);
    GH_ASSERT_NEAR(live.interPostDelay, 0.002, 1e-9);
}

GH_TEST(keyposter_guard_reads_fresh_state_before_every_single_post) {
    SBFakeDesktopState *state = [[SBFakeDesktopState alloc] init];
    state.frontmostPID = 7;
    SBFakeAXNode *field = [SBFakeAXNode nodeWithRole:@"AXTextField"];
    SBFakeAXNode *other = [SBFakeAXNode nodeWithRole:@"AXTextField"];
    state.focusedNode = field;
    SBFakeKeyPoster *poster = [[SBFakeKeyPoster alloc] initWithState:state];
    // The "app" moves focus away after the first chunk.
    __block NSUInteger posts = 0;
    poster.onPost = ^(SBKeyStroke *stroke) { if (++posts == 1) state.focusedNode = other; };
    NSMutableArray *seen = [NSMutableArray array];
    NSString *text = [@"" stringByPaddingToLength:45 withString:@"x" startingAtIndex:0];   // 3 chunks: 20 + 20 + 5
    SBKeyBurstResult *result = [poster postBurst:@[ [SBKeyStroke text:text], [SBKeyStroke escape] ] guard:^BOOL(SBKeyStroke *stroke, pid_t pid, id<SBAXNode> focused) {
        [seen addObject:focused ? (id)focused : (id)NSNull.null];
        return pid == 7 && focused == field;
    }];
    GH_ASSERT_FALSE(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBKeyBurstReasonGuardRefused);
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
    SBFakeDesktopState *state = [[SBFakeDesktopState alloc] init];
    state.frontmostPID = 7;
    SBFakeAXNode *list = [SBFakeAXNode nodeWithRole:@"AXComboBox"];
    SBFakeAXNode *chat = [SBFakeAXNode nodeWithRole:@"AXTextArea"];
    state.focusedNode = list;
    SBFakeKeyPoster *poster = [[SBFakeKeyPoster alloc] initWithState:state];
    // The guard approves what it was shown, but while its (slow) walk runs the user clicks into a chat box.
    SBKeyBurstResult *clicked = [poster postBurst:@[ [SBKeyStroke returnKey] ] guard:^BOOL(SBKeyStroke *stroke, pid_t pid, id<SBAXNode> focused) {
        BOOL ok = pid == 7 && focused == list;
        state.focusedNode = chat;
        return ok;
    }];
    GH_ASSERT_FALSE(clicked.ok);
    GH_ASSERT_EQUAL_OBJECTS(clicked.reason, SBKeyBurstReasonGuardRefused);
    GH_ASSERT_EQUAL_INT(poster.posted.count, 0);

    // ...or Command+Tabs to another app.
    state.focusedNode = list;
    SBKeyBurstResult *switched = [poster postBurst:@[ [SBKeyStroke returnKey] ] guard:^BOOL(SBKeyStroke *stroke, pid_t pid, id<SBAXNode> focused) {
        state.frontmostPID = 99;
        return pid == 7 && focused == list;
    }];
    GH_ASSERT_FALSE(switched.ok);
    GH_ASSERT_EQUAL_INT(poster.posted.count, 0);

    // The caller's last check (the user-key flag) is asked after all that, right before the post.
    state.frontmostPID = 7;
    __block BOOL userKey = NO;
    __block NSUInteger lastChecks = 0;
    SBKeyBurstResult *keyed = [poster postBurst:@[ [SBKeyStroke text:@"Canada"], [SBKeyStroke downArrow] ] guard:^BOOL(SBKeyStroke *stroke, pid_t pid, id<SBAXNode> focused) {
        userKey = YES;   // a key the event tap saw while the guard ran
        return YES;
    } lastCheck:^BOOL { lastChecks++; return !userKey; }];
    GH_ASSERT_FALSE(keyed.ok);
    GH_ASSERT_EQUAL_INT(lastChecks, 1);
    GH_ASSERT_EQUAL_INT(poster.posted.count, 0);
    // All clear: it posts, with the last check asked once per post.
    lastChecks = 0;
    GH_ASSERT([poster postBurst:@[ [SBKeyStroke escape] ] guard:^BOOL(SBKeyStroke *s, pid_t p, id<SBAXNode> f) { return YES; }
                      lastCheck:^BOOL { lastChecks++; return YES; }].ok);
    GH_ASSERT_EQUAL_INT(lastChecks, 1);
    GH_ASSERT_EQUAL_OBJECTS(poster.postedNames, (@[ @"escape" ]));
}

GH_TEST(keyposter_refuses_malformed_bursts_before_posting_anything) {
    SBFakeDesktopState *state = [[SBFakeDesktopState alloc] init];
    SBFakeKeyPoster *poster = [[SBFakeKeyPoster alloc] initWithState:state];
    SBKeyGuard yes = ^BOOL(SBKeyStroke *stroke, pid_t pid, id<SBAXNode> focused) { return YES; };
    NSArray *bad = @[ @[],
                      @[ [SBKeyStroke text:@"path"], [SBKeyStroke returnKey] ],   // a Return is always alone
                      @[ [SBKeyStroke returnKey], [SBKeyStroke returnKey] ],
                      @[ [SBKeyStroke text:@"line\nbreak"] ],                     // a newline could become an Enter
                      @[ [SBKeyStroke text:@"tab\there"] ],
                      @[ [SBKeyStroke text:@""] ] ];
    for (NSArray *burst in bad) {
        SBKeyBurstResult *result = [poster postBurst:burst guard:yes];
        GH_ASSERT_FALSE(result.ok);
        GH_ASSERT_EQUAL_INT(result.postedCount, 0);
    }
    GH_ASSERT_EQUAL_INT(poster.posted.count, 0);
    GH_ASSERT_EQUAL_INT(poster.guardCalls, 0);
    GH_ASSERT_EQUAL_OBJECTS([poster postBurst:@[] guard:yes].reason, SBKeyBurstReasonEmpty);
    GH_ASSERT_EQUAL_OBJECTS([poster postBurst:@[ [SBKeyStroke text:@"a\rb"] ] guard:yes].reason, SBKeyBurstReasonMalformed);

    NSString *reason = nil;
    NSArray<SBKeyStroke *> *atoms = [SBKeyPoster atomicStrokesForBurst:@[ [SBKeyStroke text:[@"" stringByPaddingToLength:45 withString:@"y" startingAtIndex:0]],
                                                                         [SBKeyStroke downArrow] ] reason:&reason];
    GH_ASSERT_EQUAL_INT(atoms.count, 4);
    GH_ASSERT_EQUAL_INT(atoms[0].text.length, 20);
    GH_ASSERT_EQUAL_INT(atoms[2].text.length, 5);
    GH_ASSERT_EQUAL_INT(atoms[3].kind, SBKeyStrokeKindDownArrow);

    // A lone Return with a guard that says yes goes out; one that says no does not.
    GH_ASSERT([poster postBurst:@[ [SBKeyStroke returnKey] ] guard:yes].ok);
    GH_ASSERT_FALSE([poster postBurst:@[ [SBKeyStroke returnKey] ] guard:^BOOL(SBKeyStroke *s, pid_t p, id<SBAXNode> f) { return NO; }].ok);
    GH_ASSERT_EQUAL_INT([poster countOfKind:SBKeyStrokeKindReturn], 1);
}

GH_TEST(keyposter_stops_at_the_first_refusal_or_failed_post) {
    SBFakeDesktopState *state = [[SBFakeDesktopState alloc] init];
    SBFakeKeyPoster *poster = [[SBFakeKeyPoster alloc] initWithState:state];
    SBKeyBurstResult *result = [poster postBurst:@[ [SBKeyStroke escape], [SBKeyStroke downArrow], [SBKeyStroke upArrow] ]
                                           guard:^BOOL(SBKeyStroke *stroke, pid_t pid, id<SBAXNode> focused) { return stroke.kind != SBKeyStrokeKindDownArrow; }];
    GH_ASSERT_FALSE(result.ok);
    GH_ASSERT_EQUAL_INT(result.failedIndex, 1);
    GH_ASSERT_EQUAL_OBJECTS(poster.postedNames, (@[ @"escape" ]));

    poster.sinkFails = YES;
    SBKeyBurstResult *failed = [poster postBurst:@[ [SBKeyStroke backspace], [SBKeyStroke backspace] ]
                                           guard:^BOOL(SBKeyStroke *stroke, pid_t pid, id<SBAXNode> focused) { return YES; }];
    GH_ASSERT_EQUAL_OBJECTS(failed.reason, SBKeyBurstReasonPostFailed);
    GH_ASSERT_EQUAL_INT(failed.postedCount, 0);
    GH_ASSERT_EQUAL_INT(poster.guardCalls, 3);   // 2 in the first burst, 1 before the failed post
    GH_ASSERT_EQUAL_INT(poster.burstCount, 2);
}

#pragma mark - pure pieces

GH_TEST(openpanel_validates_the_upload_path) {
    NSString *dir = SBTestTempDirectory();
    NSString *good = [dir stringByAppendingPathComponent:@"resume-alex-chen.pdf"];
    [@"%PDF fictional" writeToFile:good atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    GH_ASSERT([SBOpenPanelDriver problemWithUploadPath:good] == nil);

    GH_ASSERT_EQUAL_OBJECTS([SBOpenPanelDriver problemWithUploadPath:nil], SBUploadPathEmpty);
    GH_ASSERT_EQUAL_OBJECTS([SBOpenPanelDriver problemWithUploadPath:@"resume.pdf"], SBUploadPathNotAbsolute);
    GH_ASSERT_EQUAL_OBJECTS([SBOpenPanelDriver problemWithUploadPath:@"~/resume.pdf"], SBUploadPathNotAbsolute);
    GH_ASSERT_EQUAL_OBJECTS([SBOpenPanelDriver problemWithUploadPath:[dir stringByAppendingPathComponent:@"missing.pdf"]], SBUploadPathMissing);
    GH_ASSERT_EQUAL_OBJECTS([SBOpenPanelDriver problemWithUploadPath:dir], SBUploadPathNotRegularFile);
    GH_ASSERT_EQUAL_OBJECTS([SBOpenPanelDriver problemWithUploadPath:[good stringByAppendingString:@"\n"]], SBUploadPathControlCharacter);

    NSString *link = [dir stringByAppendingPathComponent:@"link.pdf"];
    [NSFileManager.defaultManager createSymbolicLinkAtPath:link withDestinationPath:good error:NULL];
    GH_ASSERT_EQUAL_OBJECTS([SBOpenPanelDriver problemWithUploadPath:link], SBUploadPathNotRegularFile);

    NSString *big = [dir stringByAppendingPathComponent:@"big.pdf"];
    [NSFileManager.defaultManager createFileAtPath:big contents:nil attributes:nil];
    NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:big];
    [handle truncateFileAtOffset:SBOpenPanelMaxFileBytes];   // sparse: exactly 25 MB is already too large
    [handle closeFile];
    GH_ASSERT_EQUAL_OBJECTS([SBOpenPanelDriver problemWithUploadPath:big], SBUploadPathTooLarge);

    NSString *locked = [dir stringByAppendingPathComponent:@"locked.pdf"];
    [@"x" writeToFile:locked atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    [NSFileManager.defaultManager setAttributes:@{ NSFilePosixPermissions: @0 } ofItemAtPath:locked error:NULL];
    GH_ASSERT_EQUAL_OBJECTS([SBOpenPanelDriver problemWithUploadPath:locked], SBUploadPathUnreadable);
    [NSFileManager.defaultManager setAttributes:@{ NSFilePosixPermissions: @0600 } ofItemAtPath:locked error:NULL];

    // The fictional demo resume the live run will use passes.
    NSString *here = [@(__FILE__) stringByDeletingLastPathComponent];
    if (!here.isAbsolutePath) here = [NSFileManager.defaultManager.currentDirectoryPath stringByAppendingPathComponent:here];
    NSString *demo = [here stringByAppendingPathComponent:@"../../demo/fixtures/resume-alex-chen.pdf"].stringByStandardizingPath;
    GH_ASSERT([SBOpenPanelDriver problemWithUploadPath:demo] == nil);
}

static SBOPNode *OPFixtureNode(NSDictionary *raw) {
    SBOPNode *node = [SBOPNode nodeWithRole:raw[@"role"] ?: @"AXUnknown"];
    NSDictionary *keys = @{ @"title": @"title", @"subrole": @"subrole", @"description": @"axDescription", @"roleDescription": @"roleDescription",
                            @"identifier": @"identifier", @"text": @"value" };
    for (NSString *key in keys) if ([raw[key] isKindOfClass:NSString.class]) [node setValue:raw[key] forKey:keys[key]];
    if (raw[@"enabled"]) node.enabled = [raw[@"enabled"] boolValue];
    for (NSDictionary *child in raw[@"children"]) [node addChild:OPFixtureNode(child)];
    return node;
}

static SBOPNode *OPGreenhouseWindow(void) {
    NSString *path = [@(__FILE__).stringByDeletingLastPathComponent stringByAppendingPathComponent:@"fixtures/greenhouse-safari-viam.json"];
    NSDictionary *fixture = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:path] ?: [NSData data] options:0 error:NULL];
    return [fixture[@"tree"] isKindOfClass:NSDictionary.class] ? OPFixtureNode(fixture[@"tree"]) : nil;
}

static id<SBAXNode> OPFind(id<SBAXNode> root, BOOL (^match)(id<SBAXNode> node)) {
    if (match(root)) return root;
    for (id<SBAXNode> child in root.children) {
        id<SBAXNode> hit = OPFind(child, match);
        if (hit) return hit;
    }
    return nil;
}

static void OPCollect(id<SBAXNode> root, NSMutableArray *out) {
    [out addObject:root];
    for (id<SBAXNode> child in root.children) OPCollect(child, out);
}

GH_TEST(openpanel_finds_the_upload_control_in_the_real_greenhouse_page) {
    SBOPNode *window = OPGreenhouseWindow();
    GH_ASSERT(window != nil);
    id<SBAXNode> resume = OPFind(window, ^BOOL(id<SBAXNode> n) { return [n.title isEqualToString:@"Resume/CV"]; });
    id<SBAXNode> cover = OPFind(window, ^BOOL(id<SBAXNode> n) { return [n.title isEqualToString:@"Cover Letter"]; });
    GH_ASSERT(resume && cover);
    id<SBAXNode> resumeButton = [SBOpenPanelDriver uploadButtonInGroup:resume];
    GH_ASSERT_EQUAL_OBJECTS(resumeButton.subrole, @"AXFileUploadButton");
    GH_ASSERT_EQUAL_OBJECTS(resumeButton.identifier, @"resume");
    GH_ASSERT_EQUAL_OBJECTS([SBOpenPanelDriver uploadButtonInGroup:cover].identifier, @"cover_letter");

    NSMutableArray<id<SBAXNode>> *all = [NSMutableArray array];
    OPCollect(window, all);
    NSMutableSet<NSString *> *accepted = [NSMutableSet set];
    for (id<SBAXNode> node in all) {
        if ([SBOpenPanelDriver isUploadButton:node]) [accepted addObject:node.title ?: node.identifier ?: @"?"];
    }
    // The file inputs and "Attach", never the cloud pickers, "Enter manually", "Apply", "Autofill" or Submit.
    GH_ASSERT_EQUAL_OBJECTS(accepted, ([NSSet setWithArray:@[ @"Attach", @"resume", @"cover_letter" ]]));
    // The page itself holds no open panel, although it is full of buttons.
    GH_ASSERT([SBOpenPanelDriver openPanelInWindows:@[ window ]] == nil);
}

GH_TEST(openpanel_panel_search_only_accepts_sheets_and_dialogs) {
    SBFakeAXNode *window = OPNode(@"AXWindow", nil);
    window.subrole = @"AXStandardWindow";
    SBFakeAXNode *web = [window addChild:OPNode(@"AXWebArea", nil)];
    [web addChild:OPNode(@"AXButton", @"Upload")];          // a page button called Upload is not a panel
    SBFakeAXNode *webSheet = [web addChild:OPNode(@"AXSheet", nil)];
    [webSheet addChild:OPNode(@"AXButton", @"Open")];       // nothing inside web content counts
    [window addChild:OPNode(@"AXButton", @"Open")];         // a standard window with an Open button is not a panel
    GH_ASSERT([SBOpenPanelDriver openPanelInWindows:@[ window ]] == nil);

    SBFakeAXNode *sheet = [window addChild:OPNode(@"AXSheet", nil)];
    SBFakeAXNode *nested = [sheet addChild:OPNode(@"AXGroup", nil)];
    SBFakeAXNode *choose = [nested addChild:OPNode(@"AXButton", @"Choose")];
    GH_ASSERT([SBOpenPanelDriver openPanelInWindows:@[ window ]] == sheet);
    GH_ASSERT([SBOpenPanelDriver defaultButtonOfPanel:sheet] == choose);

    SBFakeAXNode *dialog = OPNode(@"AXWindow", nil);
    dialog.subrole = @"AXDialog";
    [dialog addChild:OPNode(@"AXButton", @"Open")];
    GH_ASSERT([SBOpenPanelDriver openPanelInWindows:@[ dialog ]] == dialog);
    SBFakeAXNode *alert = OPNode(@"AXWindow", nil);
    alert.subrole = @"AXDialog";
    [alert addChild:OPNode(@"AXButton", @"OK")];
    GH_ASSERT([SBOpenPanelDriver openPanelInWindows:@[ alert ]] == nil);

    SBFakeAXNode *search = OPNode(@"AXTextField", nil);
    search.subrole = @"AXSearchField";
    GH_ASSERT_FALSE([SBOpenPanelDriver isGoToFieldCandidate:search]);
    GH_ASSERT([SBOpenPanelDriver isGoToFieldCandidate:OPNode(@"AXTextField", nil)]);
    GH_ASSERT([SBOpenPanelDriver isGoToFieldCandidate:OPNode(@"AXComboBox", nil)]);
    GH_ASSERT_FALSE([SBOpenPanelDriver isGoToFieldCandidate:OPNode(@"AXSecureTextField", nil)]);
    GH_ASSERT_FALSE([SBOpenPanelDriver node:search isInside:sheet]);
    GH_ASSERT([SBOpenPanelDriver node:choose isInside:sheet]);
    GH_ASSERT_FALSE([SBOpenPanelDriver node:nil isInside:sheet]);
}

GH_TEST(openpanel_page_check_reads_page_text_never_field_values) {
    SBFakeAXNode *window = OPNode(@"AXWindow", nil);
    SBFakeAXNode *field = [window addChild:OPNode(@"AXTextField", @"Notes")];
    field.value = @"see resume-alex-chen.pdf";
    GH_ASSERT_FALSE([SBOpenPanelDriver nodes:@[ window ] mentionFilename:@"resume-alex-chen.pdf"]);
    [window addChild:[SBFakeAXNode staticText:@"RESUME-ALEX-CHEN.PDF" frame:CGRectZero]];
    GH_ASSERT([SBOpenPanelDriver nodes:@[ window ] mentionFilename:@"resume-alex-chen.pdf"]);
    GH_ASSERT_FALSE([SBOpenPanelDriver nodes:@[ window ] mentionFilename:@""]);
}

#pragma mark - the whole sequence

GH_TEST(openpanel_attaches_the_resume_with_exactly_one_path_and_two_returns) {
    SBOPWorld *world = OPWorld();
    SBOpenPanelResult *result = [world run];
    GH_ASSERT_MSG(result.ok, @"%@", result);
    GH_ASSERT_EQUAL_INT(result.finalState, SBOpenPanelStateDone);
    GH_ASSERT(result.verifiedOnPage);
    GH_ASSERT_FALSE(result.pressedEscape);
    GH_ASSERT_FALSE(result.panelLeftOpen);
    GH_ASSERT_EQUAL_OBJECTS(result.filename, @"resume-alex-chen.pdf");
    GH_ASSERT_EQUAL_INT(world.presses, 1);
    // Command+Shift+G, the path (in chunks), Return in the go-to sheet, Return on Open. Nothing else.
    NSArray<NSString *> *names = world.poster.postedNames;
    GH_ASSERT_EQUAL_OBJECTS(names.firstObject, @"go-to-folder");
    GH_ASSERT_EQUAL_OBJECTS([names subarrayWithRange:NSMakeRange(names.count - 2, 2)], (@[ @"return", @"return" ]));
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:SBKeyStrokeKindText], names.count - 3);
    GH_ASSERT_EQUAL_OBJECTS(world.poster.typedText, world.path);
    GH_ASSERT_EQUAL_INT(world.returnsInGoTo, 1);
    GH_ASSERT_EQUAL_INT(world.returnsOnOpen, 1);
    GH_ASSERT_EQUAL_INT(world.returnsOutsidePanel, 0);
    GH_ASSERT_EQUAL_INT(world.escapes, 0);
    GH_ASSERT_EQUAL_OBJECTS(world.pageField.value, nil);   // nothing reached the page's text field
    GH_ASSERT_EQUAL_OBJECTS(world.messages, (@[ @"Opening the file picker", @"Picking resume-alex-chen.pdf", @"Attached resume-alex-chen.pdf" ]));
    GH_ASSERT_FALSE(world.driver.running);
    GH_ASSERT_EQUAL_INT(world.driver.currentState, SBOpenPanelStateDone);
}

GH_TEST(openpanel_attaches_through_the_real_greenhouse_tree) {
    SBOPNode *window = OPGreenhouseWindow();
    GH_ASSERT(window != nil);
    SBOPNode *group = (SBOPNode *)OPFind(window, ^BOOL(id<SBAXNode> n) { return [n.title isEqualToString:@"Resume/CV"]; });
    id<SBAXNode> button = [SBOpenPanelDriver uploadButtonInGroup:group];
    SBOPWorld *world = [[SBOPWorld alloc] initWithWindow:window uploadButton:(SBFakeAXNode *)button statusParent:group];
    world.path = OPResumePath();
    SBOpenPanelResult *result = [world run];
    GH_ASSERT_MSG(result.ok, @"%@", result);
    GH_ASSERT_EQUAL_INT(world.returnsOutsidePanel, 0);
    GH_ASSERT_EQUAL_OBJECTS(world.actuator.pressedNodes, (@[ button ]));   // only the file input was pressed
}

GH_TEST(openpanel_selects_a_prefilled_go_to_field_before_typing) {
    SBOPWorld *world = OPWorld();
    world.goToPrefill = @"/Users/alex/Documents";
    SBOpenPanelResult *result = [world run];
    GH_ASSERT_MSG(result.ok, @"%@", result);
    GH_ASSERT_EQUAL_INT(world.actuator.selectAllCount, 1);

    SBOPWorld *stuck = OPWorld();
    stuck.goToPrefill = @"/Users/alex/Documents";
    stuck.selectAllWorks = NO;
    SBOpenPanelResult *refused = [stuck run];
    GH_ASSERT_EQUAL_OBJECTS(refused.reason, SBOpenPanelReasonGoToFieldBusy);
    GH_ASSERT_EQUAL_INT([stuck.poster countOfKind:SBKeyStrokeKindText], 0);   // never appended to the old folder
    GH_ASSERT_EQUAL_INT([stuck.poster countOfKind:SBKeyStrokeKindReturn], 0);
    GH_ASSERT(refused.pressedEscape);
    GH_ASSERT_EQUAL_INT(stuck.escapes, 1);
}

GH_TEST(openpanel_refuses_before_touching_anything) {
    SBOPWorld *world = OPWorld();
    SBOpenPanelResult *relative = [world runWithPath:@"demo/fixtures/resume-alex-chen.pdf" button:world.uploadButton];
    GH_ASSERT_EQUAL_OBJECTS(relative.reason, @"invalid-path:not-absolute");
    GH_ASSERT_EQUAL_INT(relative.finalState, SBOpenPanelStateIdle);

    SBFakeAXNode *submit = OPNode(@"AXButton", @"Submit application");
    GH_ASSERT_EQUAL_OBJECTS([world runWithPath:OPResumePath() button:submit].reason, SBOpenPanelReasonNoUploadTarget);
    SBFakeAXNode *dropbox = OPNode(@"AXButton", @"Dropbox");
    GH_ASSERT_EQUAL_OBJECTS([world runWithPath:OPResumePath() button:dropbox].reason, SBOpenPanelReasonNoUploadTarget);

    world.uploadButton.enabled = NO;
    GH_ASSERT_EQUAL_OBJECTS([world runWithPath:OPResumePath() button:world.uploadButton].reason, SBOpenPanelReasonNoUploadTarget);
    world.uploadButton.enabled = YES;

    world.state.frontmostPID = 0;
    GH_ASSERT_EQUAL_OBJECTS([world runWithPath:OPResumePath() button:world.uploadButton].reason, SBOpenPanelReasonNoFrontmostApp);
    world.state.frontmostPID = world.pid;

    // A panel somebody else opened is not ours to drive.
    [world.window attach:world.panel];
    GH_ASSERT_EQUAL_OBJECTS([world runWithPath:OPResumePath() button:world.uploadButton].reason, SBOpenPanelReasonPanelAlreadyOpen);
    [world.window detach:world.panel];

    // The page already names the file: the final check would prove nothing.
    world.pageStatus.value = @"resume-alex-chen.pdf";
    GH_ASSERT_EQUAL_OBJECTS([world runWithPath:OPResumePath() button:world.uploadButton].reason, SBOpenPanelReasonAlreadyShown);

    GH_ASSERT_EQUAL_INT(world.presses, 0);
    GH_ASSERT(OPNoKeysAtAll(world));
}

GH_TEST(openpanel_panel_that_never_appears_times_out_without_a_key) {
    SBOPWorld *world = OPWorld();
    world.panelAppears = NO;
    NSTimeInterval start = world.clock.now;
    SBOpenPanelResult *result = [world run];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBOpenPanelReasonPanelTimeout);
    GH_ASSERT_EQUAL_INT(result.finalState, SBOpenPanelStateWaitForPanel);
    GH_ASSERT_NEAR(world.clock.now - start, 3.0, 0.11);
    GH_ASSERT_FALSE(result.pressedEscape);
    GH_ASSERT(OPNoKeysAtAll(world));
    GH_ASSERT_EQUAL_OBJECTS(world.messages.lastObject, @"Could not attach resume-alex-chen.pdf (panel-timeout)");

    SBOPWorld *broken = OPWorld();
    broken.pressFails = YES;
    GH_ASSERT_EQUAL_OBJECTS([broken run].reason, SBOpenPanelReasonPressFailed);
    GH_ASSERT(OPNoKeysAtAll(broken));
}

GH_TEST(openpanel_focus_outside_the_panel_blocks_the_go_to_shortcut) {
    SBOPWorld *world = OPWorld();
    world.focusGoesToPanel = NO;
    [world focus:world.pageField];
    SBOpenPanelResult *result = [world run];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBOpenPanelReasonFocusNotInPanel);
    GH_ASSERT_EQUAL_INT(world.poster.posted.count, 0);
    GH_ASSERT_EQUAL_INT(world.poster.guardCalls, 1);
    GH_ASSERT_FALSE(result.pressedEscape);   // no key goes to a page that has focus
    GH_ASSERT(result.panelLeftOpen);
}

GH_TEST(openpanel_go_to_field_timeout_escapes_once) {
    SBOPWorld *world = OPWorld();
    world.goToOpens = NO;
    SBOpenPanelResult *result = [world run];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBOpenPanelReasonGoToTimeout);
    GH_ASSERT(result.pressedEscape);
    GH_ASSERT_EQUAL_INT(world.escapes, 1);
    GH_ASSERT_EQUAL_OBJECTS(world.poster.postedNames, (@[ @"go-to-folder", @"escape" ]));
    GH_ASSERT_FALSE(result.panelLeftOpen);   // the fake panel closes on that Escape

    // The same timeout while focus sits on the page: no Escape at all.
    SBOPWorld *other = OPWorld();
    other.goToFocusesField = NO;
    __weak SBOPWorld *weakOther = other;
    other.afterPost = ^(SBKeyStroke *stroke) { if (stroke.kind == SBKeyStrokeKindGoToFolder) [weakOther focus:weakOther.pageField]; };
    SBOpenPanelResult *leaving = [other run];
    GH_ASSERT_EQUAL_OBJECTS(leaving.reason, SBOpenPanelReasonGoToTimeout);
    GH_ASSERT_FALSE(leaving.pressedEscape);
    GH_ASSERT_EQUAL_INT(other.escapes, 0);
    GH_ASSERT_EQUAL_INT([other.poster countOfKind:SBKeyStrokeKindEscape], 0);
    GH_ASSERT(leaving.panelLeftOpen);
}

GH_TEST(openpanel_never_types_outside_the_go_to_field) {
    // Focus leaves the go-to field in the middle of the path: the rest is never typed anywhere.
    SBOPWorld *world = OPWorld();
    world.path = [SBTestTempDirectory() stringByAppendingPathComponent:@"a-rather-long-folder-name/resume-alex-chen.pdf"];
    [NSFileManager.defaultManager createDirectoryAtPath:world.path.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:NULL];
    [@"%PDF" writeToFile:world.path atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    __block NSUInteger chunks = 0;
    __weak SBOPWorld *weakWorld = world;
    world.afterPost = ^(SBKeyStroke *stroke) {
        if (stroke.kind == SBKeyStrokeKindText && ++chunks == 1) [weakWorld focus:weakWorld.pageField];
    };
    SBOpenPanelResult *result = [world run];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBOpenPanelReasonFocusChanged);
    GH_ASSERT_EQUAL_INT(chunks, 1);
    GH_ASSERT(world.path.length > 20);
    GH_ASSERT_EQUAL_OBJECTS(world.pageField.value, nil);
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:SBKeyStrokeKindReturn], 0);
    GH_ASSERT_FALSE(result.pressedEscape);
    GH_ASSERT_EQUAL_INT(world.returnsOutsidePanel, 0);
}

GH_TEST(openpanel_path_that_did_not_land_exactly_is_never_confirmed) {
    SBOPWorld *world = OPWorld();
    world.dropFirstCharacter = YES;   // the field lost the leading "/"
    SBOpenPanelResult *result = [world run];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBOpenPanelReasonPathMismatch);
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:SBKeyStrokeKindReturn], 0);
    GH_ASSERT(result.pressedEscape);
    GH_ASSERT_EQUAL_INT(world.escapes, 1);
}

GH_TEST(openpanel_first_return_that_closes_the_panel_is_never_followed_by_another) {
    for (NSNumber *closes in @[ @YES, @NO ]) {
        SBOPWorld *world = OPWorld();
        world.firstReturnCloses = closes.boolValue;
        SBOpenPanelResult *result = [world run];
        GH_ASSERT_MSG(result.ok, @"%@", result);
        GH_ASSERT_EQUAL_INT(world.returnsOutsidePanel, 0);
        GH_ASSERT_EQUAL_INT([world.poster countOfKind:SBKeyStrokeKindReturn], closes.boolValue ? 1 : 2);
    }
}

GH_TEST(openpanel_each_return_rechecks_everything_at_the_last_moment) {
    // The go-to field changes between the read-back and the Return: no Return.
    SBOPWorld *edited = OPWorld();
    __weak SBOPWorld *weakEdited = edited;
    edited.state.onFocusRead = ^{
        SBOPWorld *world = weakEdited;
        if (world.driver.currentState == SBOpenPanelStateConfirmGoTo) world.goToField.value = @"/Users/alex/Documents/other.pdf";
    };
    SBOpenPanelResult *changed = [edited run];
    GH_ASSERT_FALSE(changed.ok);
    GH_ASSERT_EQUAL_OBJECTS(changed.reason, SBOpenPanelReasonFocusChanged);
    GH_ASSERT_EQUAL_INT([edited.poster countOfKind:SBKeyStrokeKindReturn], 0);

    // Focus jumps to the page right before the Return on Open: no Return reaches the page.
    SBOPWorld *jumped = OPWorld();
    __weak SBOPWorld *weakJumped = jumped;
    jumped.state.onFocusRead = ^{
        SBOPWorld *world = weakJumped;
        if (world.driver.currentState == SBOpenPanelStateConfirmOpen) [world focus:world.pageField];
    };
    SBOpenPanelResult *refused = [jumped run];
    GH_ASSERT_EQUAL_OBJECTS(refused.reason, SBOpenPanelReasonFocusNotInPanel);
    GH_ASSERT_EQUAL_INT([jumped.poster countOfKind:SBKeyStrokeKindReturn], 1);   // the go-to Return only
    GH_ASSERT_EQUAL_INT(jumped.returnsOnOpen, 0);
    GH_ASSERT_EQUAL_INT(jumped.returnsOutsidePanel, 0);
    GH_ASSERT_FALSE(refused.pressedEscape);   // focus is on the page: no Escape either
    GH_ASSERT(refused.panelLeftOpen);

    // The panel is gone at that moment (closed by the user): no Return either.
    SBOPWorld *gone = OPWorld();
    __weak SBOPWorld *weakGone = gone;
    gone.state.onFocusRead = ^{
        SBOPWorld *world = weakGone;
        if (world.driver.currentState == SBOpenPanelStateConfirmOpen && [world panelOpen]) [world.window detach:world.panel];
    };
    SBOpenPanelResult *vanished = [gone run];
    GH_ASSERT_FALSE(vanished.ok);
    GH_ASSERT_EQUAL_INT([gone.poster countOfKind:SBKeyStrokeKindReturn], 1);
    GH_ASSERT_EQUAL_INT(gone.returnsOutsidePanel, 0);
}

GH_TEST(openpanel_disabled_open_button_is_never_confirmed) {
    SBOPWorld *world = OPWorld();
    world.openEnabledAfterGoTo = NO;   // the panel did not accept the file (wrong type)
    SBOpenPanelResult *result = [world run];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBOpenPanelReasonGoToDismissTimeout);
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:SBKeyStrokeKindReturn], 1);   // only the go-to Return
    GH_ASSERT_EQUAL_INT(world.returnsOnOpen, 0);
    GH_ASSERT(result.pressedEscape);
    GH_ASSERT_EQUAL_INT(world.escapes, 1);
}

GH_TEST(openpanel_panel_that_stays_open_times_out_with_one_escape) {
    SBOPWorld *world = OPWorld();
    world.openCloses = NO;
    SBOpenPanelResult *result = [world run];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBOpenPanelReasonPanelCloseTimeout);
    GH_ASSERT_EQUAL_INT(result.finalState, SBOpenPanelStateWaitForPanelClosed);
    GH_ASSERT_EQUAL_INT(world.escapes, 1);
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:SBKeyStrokeKindEscape], 1);
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:SBKeyStrokeKindReturn], 2);
}

GH_TEST(openpanel_success_needs_the_page_to_show_the_file) {
    SBOPWorld *world = OPWorld();
    world.pageShowsName = NO;
    SBOpenPanelResult *result = [world run];
    GH_ASSERT_FALSE(result.ok);
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBOpenPanelReasonFilenameNotShown);
    GH_ASSERT_FALSE(result.verifiedOnPage);
    GH_ASSERT_FALSE(result.pressedEscape);   // the panel is gone: nothing to cancel
    GH_ASSERT_FALSE(result.panelLeftOpen);

    // An injected page check replaces the default one.
    SBOPWorld *custom = OPWorld();
    custom.pageShowsName = NO;
    __block NSUInteger asked = 0;
    custom.driver.pageShowsFilename = ^BOOL(NSString *filename, pid_t pid) { return ++asked > 2; };
    GH_ASSERT([custom run].ok);
    custom.driver.pageShowsFilename = nil;   // null_resettable: back to the default
    GH_ASSERT(custom.driver.pageShowsFilename != nil);
}

GH_TEST(openpanel_user_key_aborts_and_nothing_more_is_posted) {
    SBOPWorld *world = OPWorld();
    __weak SBOPWorld *weakWorld = world;
    world.afterPost = ^(SBKeyStroke *stroke) { if (stroke.kind == SBKeyStrokeKindGoToFolder) [weakWorld.driver noteUserKeyEvent]; };
    SBOpenPanelResult *result = [world run];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBOpenPanelReasonUserKey);
    GH_ASSERT_EQUAL_OBJECTS(world.poster.postedNames, (@[ @"go-to-folder" ]));
    GH_ASSERT_FALSE(result.pressedEscape);

    // Mid-path: the guard sees the flag before the next chunk.
    SBOPWorld *typing = OPWorld();
    typing.path = [SBTestTempDirectory() stringByAppendingPathComponent:@"another-long-folder-name/resume-alex-chen.pdf"];
    [NSFileManager.defaultManager createDirectoryAtPath:typing.path.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:NULL];
    [@"%PDF" writeToFile:typing.path atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    __weak SBOPWorld *weakTyping = typing;
    typing.afterPost = ^(SBKeyStroke *stroke) { if (stroke.kind == SBKeyStrokeKindText) [weakTyping.driver noteUserKeyEvent]; };
    SBOpenPanelResult *interrupted = [typing run];
    GH_ASSERT_EQUAL_OBJECTS(interrupted.reason, SBOpenPanelReasonUserKey);
    GH_ASSERT_EQUAL_INT([typing.poster countOfKind:SBKeyStrokeKindText], 1);
    GH_ASSERT_EQUAL_INT([typing.poster countOfKind:SBKeyStrokeKindReturn], 0);
    GH_ASSERT_EQUAL_INT([typing.poster countOfKind:SBKeyStrokeKindEscape], 0);

    // Keys while nothing runs are not remembered for the next run.
    SBOPWorld *idle = OPWorld();
    [idle.driver noteUserKeyEvent];
    GH_ASSERT([idle run].ok);
}

GH_TEST(openpanel_app_switch_aborts_without_a_key) {
    SBOPWorld *world = OPWorld();
    __weak SBOPWorld *weakWorld = world;
    world.onPress = ^{ weakWorld.state.frontmostPID = 999; };   // the user switched apps as the panel opened
    SBOpenPanelResult *result = [world run];
    GH_ASSERT_EQUAL_OBJECTS(result.reason, SBOpenPanelReasonAppChanged);
    GH_ASSERT(OPNoKeysAtAll(world));

    // Switching right after the go-to Return: the Return on Open never follows.
    SBOPWorld *late = OPWorld();
    __weak SBOPWorld *weakLate = late;
    late.afterPost = ^(SBKeyStroke *stroke) {
        if (stroke.kind == SBKeyStrokeKindReturn && weakLate.returnsInGoTo == 1) weakLate.state.frontmostPID = 999;
    };
    SBOpenPanelResult *refused = [late run];
    GH_ASSERT_EQUAL_OBJECTS(refused.reason, SBOpenPanelReasonAppChanged);
    GH_ASSERT_EQUAL_INT([late.poster countOfKind:SBKeyStrokeKindReturn], 1);
    GH_ASSERT_EQUAL_INT([late.poster countOfKind:SBKeyStrokeKindEscape], 0);
}

GH_TEST(openpanel_one_run_at_a_time_and_cancel_stops_everything) {
    SBOPWorld *world = OPWorld();
    world.goToOpens = NO;   // it will sit in waitForGoToField
    world.path = OPResumePath();
    __block SBOpenPanelResult *first = nil;
    [world.driver attachFileAtPath:world.path uploadButton:world.uploadButton completion:^(SBOpenPanelResult *r) { first = r; }];
    GH_ASSERT(world.driver.running);
    GH_ASSERT_EQUAL_INT(world.driver.currentState, SBOpenPanelStateWaitForGoToField);
    __block SBOpenPanelResult *second = nil;
    [world.driver attachFileAtPath:world.path uploadButton:world.uploadButton completion:^(SBOpenPanelResult *r) { second = r; }];
    GH_ASSERT_EQUAL_OBJECTS(second.reason, SBOpenPanelReasonBusy);
    GH_ASSERT(world.driver.running);

    [world.driver cancel];
    GH_ASSERT_EQUAL_OBJECTS(first.reason, SBOpenPanelReasonCancelled);
    GH_ASSERT_FALSE(world.driver.running);
    NSUInteger posted = world.poster.posted.count;
    [world.clock runUntil:^BOOL { return NO; }];   // stale timers do nothing
    GH_ASSERT_EQUAL_INT(world.poster.posted.count, posted);
    GH_ASSERT_EQUAL_INT([world.poster countOfKind:SBKeyStrokeKindEscape], 0);
    [world.driver cancel];   // idempotent
}

GH_TEST(openpanel_page_check_reads_web_content_never_tab_titles) {
    SBFakeAXNode *window = OPNode(@"AXWindow", nil);
    SBFakeAXNode *tabs = [window addChild:OPNode(@"AXTabGroup", nil)];
    SBFakeAXNode *tab = [tabs addChild:OPNode(@"AXRadioButton", @"resume-alex-chen.pdf")];   // another tab shows the PDF
    tab.subrole = @"AXTabButton";
    SBFakeAXNode *web = [tabs addChild:OPNode(@"AXWebArea", nil)];
    [web addChild:OPNode(@"AXButton", @"Attach")];
    GH_ASSERT_EQUAL_OBJECTS([SBOpenPanelDriver webAreasInWindows:@[ window ]], (@[ web ]));
    SBFakeDesktopState *state = [[SBFakeDesktopState alloc] init];
    [state addWindow:window forPID:9];
    SBOpenPanelDriver *driver = [[SBOpenPanelDriver alloc] initWithActuator:[[SBFakeAXActuator alloc] init]
                                                                     poster:[[SBFakeKeyPoster alloc] initWithState:state] state:state];
    GH_ASSERT_FALSE(driver.pageShowsFilename(@"resume-alex-chen.pdf", 9));
    [web addChild:[SBFakeAXNode staticText:@"resume-alex-chen.pdf" frame:CGRectZero]];
    GH_ASSERT(driver.pageShowsFilename(@"resume-alex-chen.pdf", 9));
    // A window without web content (a native app) is searched as a whole.
    SBFakeAXNode *native = OPNode(@"AXWindow", nil);
    [native addChild:[SBFakeAXNode staticText:@"cover.pdf" frame:CGRectZero]];
    [state addWindow:native forPID:10];
    GH_ASSERT(driver.pageShowsFilename(@"cover.pdf", 10));
}

#pragma mark - live-like snapshots and walk budgets

/// What a live SBAXElementNode is: every attribute and the children list are read ONCE, when first asked for. A
/// stale snapshot is the whole point: only a fresh one (refreshedNode:, windowsOfProcess:) sees new state.
@interface SBOPSnapshot : NSObject <SBAXNode>
@property (nonatomic, strong, readonly) SBFakeAXNode *target;
+ (instancetype)of:(SBFakeAXNode *)target;
@end

@implementation SBOPSnapshot {
    NSString *_role, *_subrole, *_roleDescription, *_title, *_axDescription, *_placeholder, *_help, *_value, *_identifier;
    BOOL _enabled, _required, _isFocused, _valueIsSettable, _pressable;
    CGRect _frame;
    NSArray<id<SBAXNode>> *_children;
    id<SBAXNode> _parent;
    BOOL _parentRead;
}
@synthesize valueIsSettable = _valueIsSettable, pressable = _pressable;
+ (instancetype)of:(SBFakeAXNode *)target {
    if (!target) return nil;
    SBOPSnapshot *node = [[self alloc] init];
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
- (id<SBAXNode>)titleUIElement { return nil; }
- (AXUIElementRef)axElement { return NULL; }
- (NSArray<id<SBAXNode>> *)children {
    if (!_children) {
        NSMutableArray *out = [NSMutableArray array];
        for (id<SBAXNode> child in _target.children) if ([(id)child isKindOfClass:[SBFakeAXNode class]]) [out addObject:[SBOPSnapshot of:(SBFakeAXNode *)child]];
        _children = out;
    }
    return _children;
}
- (id<SBAXNode>)parent {
    if (!_parentRead) {
        _parentRead = YES;
        id<SBAXNode> up = _target.parent;
        _parent = [(id)up isKindOfClass:[SBFakeAXNode class]] ? [SBOPSnapshot of:(SBFakeAXNode *)up] : nil;
    }
    return _parent;
}
- (BOOL)isSameNode:(id<SBAXNode>)other {
    if ([(id)other isKindOfClass:[SBOPSnapshot class]]) return ((SBOPSnapshot *)other).target == _target;
    return (id)other == (id)_target;
}
@end

static SBFakeAXNode *OPUnwrap(id<SBAXNode> node) {
    if ([(id)node isKindOfClass:[SBOPSnapshot class]]) return ((SBOPSnapshot *)node).target;
    return [(id)node isKindOfClass:[SBFakeAXNode class]] ? (SBFakeAXNode *)node : nil;
}

/// The desktop as the live code sees it: fresh snapshots on every read, never the fake objects themselves.
@interface SBOPSnapshotState : SBOPState
@end
@implementation SBOPSnapshotState
- (NSArray<id<SBAXNode>> *)windowsOfProcess:(pid_t)pid {
    NSMutableArray *out = [NSMutableArray array];
    for (id<SBAXNode> window in [super windowsOfProcess:pid]) [out addObject:[SBOPSnapshot of:OPUnwrap(window)]];
    return out;
}
- (id<SBAXNode>)focusedElement {
    return [SBOPSnapshot of:OPUnwrap([super focusedElement])];
}
@end

@interface SBOPSnapshotActuator : SBOPActuator
@end
@implementation SBOPSnapshotActuator
- (id<SBAXNode>)refreshedNode:(id<SBAXNode>)node {
    SBFakeAXNode *fake = OPUnwrap(node);
    if (!fake || [self.goneNodes containsObject:fake]) return nil;
    return [(id)node isKindOfClass:[SBOPSnapshot class]] ? [SBOPSnapshot of:fake] : fake;
}
- (BOOL)pressNode:(id<SBAXNode>)node { return [super pressNode:OPUnwrap(node) ?: node]; }
- (BOOL)selectAllInNode:(id<SBAXNode>)node { return [super selectAllInNode:OPUnwrap(node) ?: node]; }
@end

@interface SBOPWorld (Reactions)
- (void)react:(SBKeyStroke *)stroke;
@end

/// The synthetic world, re-wired so the driver only ever sees snapshots.
static SBOPWorld *OPSnapshotWorld(void) {
    SBOPWorld *world = OPWorld();
    SBOPSnapshotState *state = [[SBOPSnapshotState alloc] init];
    state.frontmostPID = world.pid;
    [state addWindow:world.window forPID:world.pid];
    world.state = state;
    SBOPSnapshotActuator *actuator = [[SBOPSnapshotActuator alloc] init];
    actuator.world = world;
    world.actuator = actuator;
    world.poster = [[SBFakeKeyPoster alloc] initWithState:state];
    __weak SBOPWorld *weakWorld = world;
    world.poster.onPost = ^(SBKeyStroke *stroke) { [weakWorld react:stroke]; };
    SBOpenPanelDriver *driver = [[SBOpenPanelDriver alloc] initWithActuator:actuator poster:world.poster state:state];
    driver.after = world.clock.after;
    driver.clock = world.clock.clock;
    world.driver = driver;
    return world;
}

GH_TEST(openpanel_open_button_is_read_from_a_fresh_panel_never_the_cached_snapshot) {
    // The panel appears with Upload disabled (nothing chosen). The go-to Return enables it. A driver that kept reading
    // the snapshot it took when the panel appeared would wait for "enabled" forever and time out.
    SBOPWorld *world = OPSnapshotWorld();
    SBOpenPanelResult *result = [world run];
    GH_ASSERT_MSG(result.ok, @"%@", result);
    GH_ASSERT_EQUAL_INT(world.returnsInGoTo, 1);
    GH_ASSERT_EQUAL_INT(world.returnsOnOpen, 1);
    GH_ASSERT_EQUAL_INT(world.escapes, 0);

    // And the other way round: Upload stays disabled (the path did not select anything). No second Return, ever.
    SBOPWorld *disabled = OPSnapshotWorld();
    disabled.openEnabledAfterGoTo = NO;
    SBOpenPanelResult *refused = [disabled run];
    GH_ASSERT_FALSE(refused.ok);
    GH_ASSERT_EQUAL_OBJECTS(refused.reason, SBOpenPanelReasonGoToDismissTimeout);
    GH_ASSERT_EQUAL_INT(disabled.returnsOnOpen, 0);
}

/// A node that takes `delay` seconds to hand out its children (a busy web process).
@interface SBOPSlowNode : SBFakeAXNode
@property (nonatomic) NSTimeInterval delay;
@end
@implementation SBOPSlowNode
- (NSArray<id<SBAXNode>> *)children {
    if (self.delay > 0) usleep((useconds_t)(self.delay * 1e6));
    return [super children];
}
@end

GH_TEST(ax_walk_budget_counts_nodes_time_and_hangs) {
    SBAXWalkBudget budget = SBAXWalkBudgetMake(2, 0);
    SBFakeAXNode *node = OPNode(@"AXGroup", nil);
    GH_ASSERT(SBAXWalkBudgetSpend(&budget, node));
    GH_ASSERT(SBAXWalkBudgetSpend(&budget, node));
    GH_ASSERT_FALSE(SBAXWalkBudgetSpend(&budget, node));
    GH_ASSERT(budget.exhausted);
    SBAXWalkBudget timed = SBAXWalkBudgetMake(100, 0.01);
    usleep(20000);
    GH_ASSERT_FALSE(SBAXWalkBudgetSpend(&timed, node));
    GH_ASSERT(timed.exhausted);
    SBFakeAXNode *hung = OPNode(@"AXGroup", nil);
    hung.lastError = kAXErrorCannotComplete;
    SBAXWalkBudget open = SBAXWalkBudgetMake(100, 1);
    GH_ASSERT_FALSE(SBAXWalkBudgetSpend(&open, hung));
    GH_ASSERT(open.hung);
    GH_ASSERT_FALSE(SBAXWalkBudgetSpend(&open, node));      // nothing more is read from that app in this walk
    SBAXWalkBudget nested = SBAXWalkBudgetNested(&open, 10);
    GH_ASSERT_FALSE(SBAXWalkBudgetSpend(&nested, node));
    GH_ASSERT(SBAXNodeLooksHung(hung));
    GH_ASSERT_FALSE(SBAXNodeLooksHung(node));
}

GH_TEST(openpanel_page_check_stops_at_a_hung_app_and_at_its_deadline) {
    // A hung web process: the first node that says so ends the check; nothing after it is expanded.
    SBFakeAXNode *window = OPNode(@"AXWindow", nil);
    SBFakeAXNode *web = [window addChild:OPNode(@"AXWebArea", nil)];
    SBFakeAXNode *hung = [web addChild:OPNode(@"AXGroup", nil)];
    hung.lastError = kAXErrorCannotComplete;
    SBFakeAXNode *after = [web addChild:OPNode(@"AXGroup", nil)];
    [after addChild:[SBFakeAXNode staticText:@"resume-alex-chen.pdf" frame:CGRectZero]];
    GH_ASSERT_FALSE([SBOpenPanelDriver windows:@[ window ] showFilename:@"resume-alex-chen.pdf"]);
    GH_ASSERT_EQUAL_INT(hung.childrenReadCount, 0);
    GH_ASSERT_EQUAL_INT(after.childrenReadCount, 0);
    hung.lastError = kAXErrorSuccess;
    GH_ASSERT([SBOpenPanelDriver windows:@[ window ] showFilename:@"resume-alex-chen.pdf"]);

    // A slow page: the check gives up at its wall-clock budget instead of walking thousands of nodes.
    SBFakeAXNode *slowWindow = OPNode(@"AXWindow", nil);
    SBFakeAXNode *slowWeb = [slowWindow addChild:OPNode(@"AXWebArea", nil)];
    for (int i = 0; i < 200; i++) {
        SBOPSlowNode *slow = [SBOPSlowNode nodeWithRole:@"AXGroup"];
        slow.delay = 0.01;
        [slowWeb addChild:slow];
    }
    [slowWeb addChild:[SBFakeAXNode staticText:@"resume-alex-chen.pdf" frame:CGRectZero]];
    CFAbsoluteTime started = CFAbsoluteTimeGetCurrent();
    GH_ASSERT_FALSE([SBOpenPanelDriver windows:@[ slowWindow ] showFilename:@"resume-alex-chen.pdf"]);
    NSTimeInterval spent = CFAbsoluteTimeGetCurrent() - started;
    GH_ASSERT_MSG(spent < SBOpenPanelPageCheckSeconds + 0.25, @"the page check took %.2f s", spent);
}
