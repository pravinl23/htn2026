// GHController end to end without AX: fake window tree -> GHCapture -> real GhostCore -> walk -> fake actuator,
// with an off-screen overlay, an uninstalled event tap and a stub prediction server (no socket is ever opened).
#import "GHTest.h"
#import "GHCapture.h"
#import "GHController.h"
#import "GHCore.h"
#import "GHOverlayWindow.h"
#import "GHProfileStore.h"
#import "GHWriter.h"
#import "GHField.h"
#import "GHVision.h"
#include <sys/stat.h>

#pragma mark - stub server

@interface GHCtlStub : NSURLProtocol
+ (void)reset;
+ (void)setPredictHandler:(NSDictionary * (^)(NSDictionary *body))handler;   // nil handler or nil reply = unreachable
+ (NSUInteger)countForPath:(NSString *)path;
+ (NSArray<NSDictionary *> *)bodiesForPath:(NSString *)path;
+ (NSUInteger)openDraftCount;
+ (BOOL)completeDraftForLabel:(NSString *)label text:(NSString *)text;
@end

static NSMutableArray<NSDictionary *> *gSeen;                       // { path, body }
static NSMutableDictionary<NSString *, GHCtlStub *> *gOpenDrafts;   // field label -> connection
static NSDictionary * (^gPredict)(NSDictionary *);

@implementation GHCtlStub

+ (void)reset {
    @synchronized ([GHCtlStub class]) {
        gSeen = [NSMutableArray array];
        gOpenDrafts = [NSMutableDictionary dictionary];
        gPredict = nil;
    }
}

+ (void)setPredictHandler:(NSDictionary * (^)(NSDictionary *))handler {
    @synchronized ([GHCtlStub class]) { gPredict = [handler copy]; }
}

+ (NSArray<NSDictionary *> *)bodiesForPath:(NSString *)path {
    NSMutableArray *out = [NSMutableArray array];
    @synchronized ([GHCtlStub class]) {
        for (NSDictionary *seen in gSeen) if ([seen[@"path"] isEqualToString:path]) [out addObject:seen[@"body"]];
    }
    return out;
}

+ (NSUInteger)countForPath:(NSString *)path { return [self bodiesForPath:path].count; }

+ (NSUInteger)openDraftCount {
    @synchronized ([GHCtlStub class]) { return gOpenDrafts.count; }
}

+ (BOOL)completeDraftForLabel:(NSString *)label text:(NSString *)text {
    GHCtlStub *connection = nil;
    @synchronized ([GHCtlStub class]) {
        connection = gOpenDrafts[label];
        [gOpenDrafts removeObjectForKey:label];
    }
    if (!connection) return NO;
    NSData *delta = [NSJSONSerialization dataWithJSONObject:@{ @"delta": text } options:0 error:NULL];
    NSData *done = [NSJSONSerialization dataWithJSONObject:@{ @"done": @YES, @"text": text, @"provider": @"template", @"latencyMs": @12 } options:0 error:NULL];
    NSString *events = [NSString stringWithFormat:@"data: %@\n\ndata: %@\n\n", [[NSString alloc] initWithData:delta encoding:NSUTF8StringEncoding],
                        [[NSString alloc] initWithData:done encoding:NSUTF8StringEncoding]];
    [connection.client URLProtocol:connection didLoadData:[events dataUsingEncoding:NSUTF8StringEncoding]];
    [connection.client URLProtocolDidFinishLoading:connection];
    return YES;
}

+ (BOOL)canInitWithRequest:(NSURLRequest *)request { return YES; }
+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request { return request; }

static NSData *CtlReadBody(NSURLRequest *request) {
    if (request.HTTPBody) return request.HTTPBody;
    NSInputStream *stream = request.HTTPBodyStream;
    if (!stream) return nil;
    NSMutableData *data = [NSMutableData data];
    [stream open];
    uint8_t buffer[4096];
    NSInteger read;
    while ((read = [stream read:buffer maxLength:sizeof(buffer)]) > 0) [data appendBytes:buffer length:(NSUInteger)read];
    [stream close];
    return data;
}

- (void)respond:(NSInteger)status type:(NSString *)type {
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:self.request.URL statusCode:status HTTPVersion:@"HTTP/1.1" headerFields:@{ @"Content-Type": type }];
    [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
}

- (void)startLoading {
    NSString *path = self.request.URL.path ?: @"";
    NSData *raw = CtlReadBody(self.request);
    NSDictionary *body = raw.length ? [NSJSONSerialization JSONObjectWithData:raw options:0 error:NULL] : @{};
    NSDictionary * (^predict)(NSDictionary *);
    @synchronized ([GHCtlStub class]) {
        [gSeen addObject:@{ @"path": path, @"body": body ?: @{} }];
        predict = gPredict;
    }
    if ([path isEqualToString:@"/v1/ghost-text"]) {
        [self respond:200 type:@"text/event-stream; charset=utf-8"];
        @synchronized ([GHCtlStub class]) { gOpenDrafts[body[@"fieldLabel"] ?: @"?"] = self; }   // stays open until the test completes it
        return;
    }
    NSDictionary *reply = ([path isEqualToString:@"/v1/predict/form"] && predict) ? predict(body) : nil;
    if (!reply) {
        [self.client URLProtocol:self didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorCannotConnectToHost userInfo:nil]];
        return;
    }
    [self respond:200 type:@"application/json"];
    [self.client URLProtocol:self didLoadData:[NSJSONSerialization dataWithJSONObject:reply options:0 error:NULL]];
    [self.client URLProtocolDidFinishLoading:self];
}

- (void)stopLoading {
    @synchronized ([GHCtlStub class]) {
        for (NSString *label in gOpenDrafts.allKeys) if (gOpenDrafts[label] == self) [gOpenDrafts removeObjectForKey:label];
    }
}

@end

#pragma mark - rig

@interface GHRig : NSObject
@property (nonatomic, strong) GHCore *core;
@property (nonatomic, strong) GHProfileStore *store;
@property (nonatomic, strong) GHController *controller;
@property (nonatomic, strong) GHFakeAXActuator *actuator;
@property (nonatomic, strong) GHCapture *capture;
@property (nonatomic, strong) GHFakeAXNode *window;
@property (nonatomic, strong) GHFakeAXNode *web;
@property (nonatomic, strong) NSMutableDictionary<NSString *, GHFakeAXNode *> *nodes;
@property (nonatomic) NSUInteger handedBack;
@end

@implementation GHRig

+ (instancetype)rigWithClient:(GHServerClient *)client {
    GHRig *rig = [[GHRig alloc] init];
    rig.core = [GHCore sharedCore];
    if (!rig.core) return nil;
    rig.store = [[GHProfileStore alloc] initWithDirectory:GHTestTempDirectory() core:rig.core];
    [rig.store prepare];
    rig.actuator = [[GHFakeAXActuator alloc] init];
    rig.capture = [[GHCapture alloc] initWithSafety:rig.core];
    rig.capture.keepsScrolledOutFields = YES;
    GHCapture *capture = rig.capture;

    GHController *controller = [[GHController alloc] initWithCore:rig.core store:rig.store client:client];
    controller.assumesActive = YES;
    controller.capture = capture;
    controller.overlay = [[GHOverlayWindow alloc] initWithLayout:[GHScreenLayout layoutWithFrames:@[ [NSValue valueWithRect:NSMakeRect(0, 0, 1440, 900)] ] scales:@[ @2 ]]];
    controller.writer = [[GHWriter alloc] initWithActuator:rig.actuator];
    controller.writer.after = ^(NSTimeInterval delay, dispatch_block_t block) { block(); };
    controller.writer.isNodeSensitive = ^BOOL(id<GHAXNode> node) { return [capture isNodeSensitive:node]; };
    controller.eventTap.deliversSynchronously = YES;   // never installed: there is no real tap in tests
    __weak GHRig *weakRig = rig;
    controller.tabHandBack = ^{ weakRig.handedBack++; };   // recorded, never posted
    rig.controller = controller;
    rig.nodes = [NSMutableDictionary dictionary];
    return rig;
}

- (GHFakeAXNode *)add:(NSString *)role label:(NSString *)label y:(CGFloat)y height:(CGFloat)height {
    GHFakeAXNode *node = [GHFakeAXNode nodeWithRole:role title:label frame:CGRectMake(140, y, 360, height)];
    if (![role isEqualToString:@"AXButton"]) node.value = @"";
    [self.web addChild:node];
    self.nodes[label] = node;
    return node;
}

/// First name, Last name, Email, Phone, then (optionally) free-text areas, then a locked Submit.
- (void)buildFormWithAreas:(NSArray<NSString *> *)areas {
    self.window = [GHFakeAXNode nodeWithRole:@"AXWindow" title:@"Apply - Example Careers" frame:CGRectMake(100, 60, 900, 760)];
    self.web = [self.window addChild:[GHFakeAXNode nodeWithRole:@"AXWebArea" title:nil frame:CGRectMake(100, 110, 900, 710)]];
    CGFloat y = 140;
    for (NSString *label in @[ @"First name", @"Last name", @"Email", @"Phone" ]) { [self add:@"AXTextField" label:label y:y height:30]; y += 50; }
    for (NSString *label in areas) { [self add:@"AXTextArea" label:label y:y height:70]; y += 85; }
    [self add:@"AXButton" label:@"Submit application" y:y height:32];
}

- (void)rescan { [self rescanPage:@"page-1"]; }

- (void)rescanPage:(NSString *)pageKey {
    [self.controller adoptCaptureResult:[self.capture captureWindow:self.window] pageKey:pageKey origin:@"app://com.apple.Safari/careers.example.com"];
}

- (void)tab { [self.controller eventTap:self.controller.eventTap didConsumeTab:GHKeyDecisionAccept isRepeat:NO]; }
- (void)holdTab { [self.controller eventTap:self.controller.eventTap didConsumeTab:GHKeyDecisionAccept isRepeat:YES]; }
- (void)ghostKey { [self.controller eventTapDidTapGhostKey:self.controller.eventTap]; }

- (NSString *)currentLabel {
    GHGhost *current = self.controller.walk.current;
    if (!current) return nil;
    for (NSString *label in self.nodes) {
        if ([[self.controller focusSignatureForNode:self.nodes[label]] isEqualToString:current.signature]) return label;
    }
    return @"?";
}

- (NSUInteger)buttonPresses {
    NSUInteger count = 0;
    for (id<GHAXNode> node in self.actuator.pressedNodes) if ([node.role isEqualToString:@"AXButton"]) count++;
    return count;
}

@end

static GHServerClient *StubClient(GHCore *core, GHFormCache *cache) {
    NSURLSessionConfiguration *configuration = [NSURLSessionConfiguration ephemeralSessionConfiguration];
    configuration.protocolClasses = @[ [GHCtlStub class] ];
    return [[GHServerClient alloc] initWithBaseURLString:@"http://127.0.0.1:8787" core:core configuration:configuration cache:cache];
}

static NSString *DemoEmail(void) {
    return [[GHCore sharedCore] demoProfile][@"facts"][@"email"];
}

#define RIG(name, client) \
    GHRig *name = [GHRig rigWithClient:(client)]; \
    GH_ASSERT_MSG(name != nil, @"shabang-core.js is not loadable (run make core)")

#pragma mark - the walk

GH_TEST(controller_shows_offline_ghosts_at_once_with_the_lock_parked_last) {
    RIG(rig, nil);
    [rig buildFormWithAreas:@[]];
    [rig rescan];
    GHWalkState *walk = rig.controller.walk;
    GH_ASSERT_EQUAL_INT(walk.ghosts.count, 5);
    GH_ASSERT(walk.ghosts.lastObject.locked);
    GH_ASSERT_EQUAL_OBJECTS([rig currentLabel], @"First name");
    GH_ASSERT_EQUAL_OBJECTS(walk.current.value, @"Alex");
    GH_ASSERT(rig.controller.currentVisible);
    GH_ASSERT_EQUAL_OBJECTS(rig.controller.provider, @"offline-heuristic");

    GHWalkSnapshot snapshot = [rig.controller.eventTap publishedSnapshot];
    GH_ASSERT(snapshot.active && snapshot.hasCurrent && snapshot.currentVisible && snapshot.focusInWalk);
    GH_ASSERT_FALSE(snapshot.currentLocked || snapshot.busy);
    GH_ASSERT([[rig.controller.overlay layerKeysAtIndex:0] containsObject:@"ring"]);
    GH_ASSERT([[rig.controller statusLine] hasPrefix:@"4 ghosts in"]);
    GH_ASSERT_EQUAL_INT(rig.actuator.setValueCount, 0);   // showing ghosts writes nothing and moves no focus
    GH_ASSERT_EQUAL_INT(rig.actuator.focusCount, 0);
}

GH_TEST(controller_tab_tab_tab_fills_the_form_and_never_presses_submit) {
    RIG(rig, nil);
    [rig buildFormWithAreas:@[]];
    [rig rescan];
    [rig tab];
    GH_ASSERT_EQUAL_OBJECTS(rig.nodes[@"First name"].value, @"Alex");
    GH_ASSERT_EQUAL_OBJECTS([rig currentLabel], @"Last name");
    GH_ASSERT(rig.nodes[@"Last name"].isFocused);         // focus moved on to the next ghost
    [rig tab];
    [rig tab];
    [rig tab];
    GH_ASSERT_EQUAL_OBJECTS(rig.nodes[@"Last name"].value, @"Chen");
    GH_ASSERT_EQUAL_OBJECTS(rig.nodes[@"Email"].value, DemoEmail());
    GH_ASSERT(rig.nodes[@"Phone"].value.length > 0);
    GHWalkState *walk = rig.controller.walk;
    GH_ASSERT_EQUAL_INT(walk.accepted, 4);
    GH_ASSERT(walk.finished);
    GH_ASSERT(walk.current.locked);
    GH_ASSERT(rig.nodes[@"Submit application"].isFocused);   // parked: an explicit Enter confirms
    GH_ASSERT([rig.controller.eventTap publishedSnapshot].currentLocked);

    // Over-pressing (and holding) Tab on the lock is harmless.
    for (int i = 0; i < 4; i++) [rig tab];
    for (int i = 0; i < 4; i++) [rig holdTab];
    GH_ASSERT_EQUAL_INT([rig buttonPresses], 0);
    GH_ASSERT_EQUAL_INT(rig.actuator.pressedNodes.count, 0);
    GH_ASSERT_EQUAL_INT(walk.accepted, 4);
    GH_ASSERT(walk.keystrokesSaved >= 4 + 4 + 21);

    // The rescan that follows the walk keeps the cursor parked on the same Submit and offers nothing twice.
    [rig rescan];
    GH_ASSERT_EQUAL_INT(walk.ghosts.count, 1);
    GH_ASSERT(walk.current.locked);
    GH_ASSERT([[rig.controller statusLine] hasPrefix:@"Parked on the locked action"]);
}

GH_TEST(controller_never_touches_fields_that_have_a_value) {
    RIG(rig, nil);
    [rig buildFormWithAreas:@[]];
    rig.nodes[@"Last name"].value = @"Smith";               // the user already typed it
    [rig rescan];
    GH_ASSERT_EQUAL_INT(rig.controller.walk.ghosts.count, 4);
    // A field that gains a value AFTER the capture is re-checked right before the write.
    rig.nodes[@"First name"].value = @"Sam";
    [rig tab];
    GH_ASSERT_EQUAL_OBJECTS(rig.nodes[@"First name"].value, @"Sam");
    GH_ASSERT(rig.controller.walk.error == nil);           // refused, not broken
    GH_ASSERT_EQUAL_INT(rig.controller.walk.accepted, 0);
    GH_ASSERT_EQUAL_OBJECTS([rig currentLabel], @"Email");
    [rig tab];
    [rig tab];
    GH_ASSERT_EQUAL_OBJECTS(rig.nodes[@"Last name"].value, @"Smith");
    GH_ASSERT_EQUAL_OBJECTS(rig.nodes[@"Email"].value, DemoEmail());
    [rig rescan];                                          // the refused ghost does not come straight back
    GH_ASSERT_EQUAL_OBJECTS(rig.nodes[@"First name"].value, @"Sam");
}

GH_TEST(controller_escape_and_typing_dismiss_for_the_whole_page) {
    RIG(rig, nil);
    [rig buildFormWithAreas:@[]];
    [rig rescan];
    [rig.controller eventTapDidConsumeEscape:rig.controller.eventTap];
    GH_ASSERT_EQUAL_OBJECTS([rig currentLabel], @"Last name");
    [rig.controller noteFocusedNode:rig.nodes[@"Email"]];     // rule 7: focus follows the user
    GH_ASSERT_EQUAL_OBJECTS([rig currentLabel], @"Email");
    GH_ASSERT([rig.controller.eventTap publishedSnapshot].focusOnField);
    [rig.controller eventTapDidSeeTypingInField:rig.controller.eventTap];   // typing overrides, the walk moves on
    GH_ASSERT_EQUAL_OBJECTS([rig currentLabel], @"Phone");
    [rig rescan];
    GH_ASSERT_EQUAL_INT(rig.controller.walk.ghosts.count, 3);   // Last name, Phone, Submit
    GH_ASSERT_EQUAL_OBJECTS(rig.nodes[@"First name"].value, @"");
    GH_ASSERT_EQUAL_OBJECTS(rig.nodes[@"Email"].value, @"");

    // A new page forgets the walk: the same fields get their ghosts again.
    [rig rescanPage:@"page-2"];
    GH_ASSERT_EQUAL_INT(rig.controller.walk.ghosts.count, 5);
    GH_ASSERT_EQUAL_INT(rig.controller.walk.dismissed.count, 0);
}

GH_TEST(controller_focus_mapping_and_tab_gate) {
    RIG(rig, nil);
    [rig buildFormWithAreas:@[]];
    GHFakeAXNode *search = [GHFakeAXNode nodeWithRole:@"AXTextField" title:nil frame:CGRectMake(600, 140, 200, 30)];
    [rig.window addChild:search];                             // browser chrome: outside the web area, never captured
    [rig rescan];
    GH_ASSERT([rig.controller focusSignatureForNode:nil] == nil);
    GH_ASSERT([rig.controller focusSignatureForNode:rig.web] == nil);          // the page body
    GH_ASSERT([rig.controller focusSignatureForNode:rig.window] == nil);
    GH_ASSERT_EQUAL_OBJECTS([rig.controller focusSignatureForNode:search], GHWalkFocusElsewhere);
    GH_ASSERT_EQUAL_OBJECTS([rig.controller focusSignatureForNode:rig.nodes[@"Email"]], rig.controller.walk.ghosts[2].signature);

    // An element whose role could not be read (a slow app, a destroyed element) is never "the window itself".
    GH_ASSERT_EQUAL_OBJECTS([rig.controller focusSignatureForNode:[[GHFakeAXNode alloc] init]], GHWalkFocusElsewhere);
    GHFakeAXNode *roleless = [rig.web addChild:[[GHFakeAXNode alloc] init]];
    GH_ASSERT_EQUAL_OBJECTS([rig.controller focusSignatureForNode:roleless], GHWalkFocusElsewhere);

    [rig.controller noteFocusedNode:search];
    GHWalkSnapshot snapshot = [rig.controller.eventTap publishedSnapshot];
    GH_ASSERT_FALSE(snapshot.focusInWalk);                    // Tab in the address bar is the browser's
    GH_ASSERT_FALSE([rig.controller.eventTap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:NO userData:0 printable:NO]);
    GH_ASSERT_EQUAL_OBJECTS(rig.nodes[@"First name"].value, @"");

    [rig.controller noteFocusedNode:rig.web];
    GH_ASSERT([rig.controller.eventTap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:NO userData:0 printable:NO]);   // the real path: tap -> controller -> writer
    GH_ASSERT_EQUAL_OBJECTS(rig.nodes[@"First name"].value, @"Alex");
    GH_ASSERT_FALSE([rig.controller.eventTap handleKeyDown:GHKeyCodeTab flags:kCGEventFlagMaskShift isRepeat:NO userData:0 printable:NO]);
}

GH_TEST(controller_write_failure_stops_the_walk_and_says_why) {
    RIG(rig, nil);
    [rig buildFormWithAreas:@[]];
    rig.actuator.valueSticks = NO;
    rig.actuator.typingSticks = NO;
    [rig rescan];
    [rig tab];
    GHWalkState *walk = rig.controller.walk;
    GH_ASSERT([walk.error containsString:@"did-not-hold"]);
    GH_ASSERT_FALSE([walk.error containsString:@"Alex"]);
    GH_ASSERT_EQUAL_INT(walk.accepted, 0);
    GH_ASSERT_EQUAL_INT(walk.ghosts.count, 4);                // the rest stays pending, the failed one is gone
    GH_ASSERT_EQUAL_OBJECTS([rig.controller statusLine], walk.error);
    // The hold that caused it is over: repeats are swallowed, not turned into more failures.
    GHEventTap *tap = rig.controller.eventTap;
    GH_ASSERT([tap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:NO userData:0 printable:NO]);
    NSUInteger typed = rig.actuator.typeCount;
    GH_ASSERT([tap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:YES userData:0 printable:NO]);
    GH_ASSERT_EQUAL_INT(rig.actuator.typeCount, typed);

    rig.actuator.valueSticks = YES;                          // the next successful accept clears the error
    [rig tab];
    GH_ASSERT(walk.error == nil);
}

GH_TEST(controller_does_nothing_while_disabled_or_off_screen) {
    RIG(rig, nil);
    [rig buildFormWithAreas:@[]];
    [rig.store setEnabled:NO];
    [rig rescan];
    GH_ASSERT_EQUAL_INT(rig.controller.walk.ghosts.count, 0);
    GH_ASSERT_FALSE([rig.controller.eventTap publishedSnapshot].active);
    GH_ASSERT_FALSE([rig.controller.eventTap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:NO userData:0 printable:NO]);
    [rig tab];                                                // even a Tab that slipped through writes nothing
    GH_ASSERT_EQUAL_OBJECTS(rig.nodes[@"First name"].value, @"");

    [rig.store setEnabled:YES];
    // The whole form sits below the visible part of the window and this page does not scroll: the first Tab tries the
    // jump (nothing is written) and is handed back to the app; from then on Tab stays native. No keyboard trap.
    for (GHFakeAXNode *node in rig.nodes.allValues) node.frame = CGRectOffset(node.frame, 0, 900);
    rig.web.frame = CGRectMake(100, 110, 900, 2000);
    [rig rescan];
    GH_ASSERT(rig.controller.walk.ghosts.count > 0);
    GH_ASSERT_FALSE(rig.controller.currentVisible);
    GHEventTap *tap = rig.controller.eventTap;
    GH_ASSERT([tap publishedSnapshot].canJump);
    rig.actuator.scrollWorks = NO;                            // the element refuses AXScrollToVisible
    GH_ASSERT([tap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:NO userData:0 printable:NO]);
    GH_ASSERT_EQUAL_INT(rig.actuator.scrollCount, 1);
    GH_ASSERT_EQUAL_INT(rig.handedBack, 1);
    GH_ASSERT_EQUAL_OBJECTS(rig.controller.lastStep[@"outcome"], @"not-visible");
    GH_ASSERT_FALSE([tap publishedSnapshot].canJump);
    GH_ASSERT_FALSE([tap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:NO userData:0 printable:NO]);
    [rig tab];                                                // even a Tab that slipped through writes nothing
    GH_ASSERT_EQUAL_OBJECTS(rig.nodes[@"First name"].value, @"");
    GH_ASSERT_EQUAL_INT(rig.actuator.setValueCount + rig.actuator.typeCount, 0);

    // The scroll is accepted but nothing moves (or it animates): the Tab was the jump; the rects are read again, and a
    // ghost still off screen afterwards leaves Tab native. Nothing is handed back twice, nothing is written.
    rig.actuator.scrollWorks = YES;
    [rig rescanPage:@"page-2"];
    GH_ASSERT([tap publishedSnapshot].canJump);
    GH_ASSERT([tap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:NO userData:0 printable:NO]);
    GH_ASSERT_EQUAL_OBJECTS(rig.controller.lastStep[@"outcome"], @"jumped");
    GH_ASSERT_EQUAL_INT(rig.handedBack, 1);
    GH_ASSERT(GHTestWaitUntil(2.0, ^BOOL { return ![tap publishedSnapshot].canJump; }));
    GH_ASSERT_FALSE([tap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:NO userData:0 printable:NO]);
    GH_ASSERT_EQUAL_INT(rig.actuator.setValueCount + rig.actuator.typeCount, 0);
}

GH_TEST(controller_jump_waits_for_a_page_that_scrolls_smoothly) {
    RIG(rig, nil);
    [rig buildFormWithAreas:@[]];
    rig.web.frame = CGRectMake(100, 110, 900, 3000);
    for (GHFakeAXNode *node in rig.nodes.allValues) node.frame = CGRectOffset(node.frame, 0, 1500);
    __weak GHRig *weakRig = rig;
    // The page scrolls a moment AFTER AXScrollToVisible returned.
    rig.actuator.onScroll = ^(GHFakeAXNode *node) {
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.05 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            GHRig *strong = weakRig;
            CGFloat delta = 470 - CGRectGetMidY(node.frame);
            for (GHFakeAXNode *each in [strong.nodes.allValues arrayByAddingObject:strong.web]) each.frame = CGRectOffset(each.frame, 0, delta);
        });
    };
    [rig rescan];
    GHEventTap *tap = rig.controller.eventTap;
    GH_ASSERT([tap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:NO userData:0 printable:NO]);
    GH_ASSERT_EQUAL_OBJECTS(rig.controller.lastStep[@"outcome"], @"jumped");
    GH_ASSERT_FALSE(rig.controller.currentVisible);           // not yet
    GH_ASSERT(GHTestWaitUntil(2.0, ^BOOL { return rig.controller.currentVisible; }));
    GH_ASSERT_EQUAL_INT(rig.handedBack, 0);
    GH_ASSERT([tap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:NO userData:0 printable:NO]);
    GH_ASSERT_EQUAL_OBJECTS(rig.nodes[@"First name"].value, @"Alex");
}

/// Scrolls the fake page so `node` is centred in the window's lower 700 pt (what AXScrollToVisible does).
static void CtlScrollPage(GHRig *rig, GHFakeAXNode *node) {
    CGFloat delta = 470 - CGRectGetMidY(node.frame);
    NSMutableArray<GHFakeAXNode *> *stack = [NSMutableArray arrayWithObject:rig.web];
    while (stack.count) {
        GHFakeAXNode *each = stack.lastObject;
        [stack removeLastObject];
        each.frame = CGRectOffset(each.frame, 0, delta);
        for (id<GHAXNode> child in each.children) [stack addObject:(GHFakeAXNode *)child];
    }
}

GH_TEST(controller_tab_on_the_page_jumps_to_an_off_screen_ghost_without_writing) {
    RIG(rig, nil);
    [rig buildFormWithAreas:@[]];
    // The form is far down the page: nothing is on screen, so the first ghost stays current.
    rig.web.frame = CGRectMake(100, 110, 900, 3000);
    for (GHFakeAXNode *node in rig.nodes.allValues) node.frame = CGRectOffset(node.frame, 0, 1500);
    __weak GHRig *weakRig = rig;
    rig.actuator.onScroll = ^(GHFakeAXNode *node) { CtlScrollPage(weakRig, node); };
    [rig rescan];
    GH_ASSERT_FALSE(rig.controller.currentVisible);
    GH_ASSERT_EQUAL_OBJECTS([rig currentLabel], @"First name");

    GHEventTap *tap = rig.controller.eventTap;
    [rig.controller noteFocusedNode:rig.web];                 // focus on the page itself
    GH_ASSERT([tap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:NO userData:0 printable:NO]);
    GH_ASSERT_EQUAL_OBJECTS(rig.controller.lastStep[@"outcome"], @"jumped");
    GH_ASSERT(rig.controller.currentVisible);                 // scrolled into view and drawn
    GH_ASSERT_EQUAL_INT(rig.actuator.setValueCount + rig.actuator.typeCount + rig.actuator.focusCount, 0);   // nothing written, no focus moved
    GH_ASSERT_EQUAL_OBJECTS(rig.nodes[@"First name"].value, @"");
    GH_ASSERT_EQUAL_INT(rig.handedBack, 0);

    // The next Tab writes; a ghost scrolled away before a queued press is scrolled back first, never written blind.
    GH_ASSERT([tap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:NO userData:0 printable:NO]);
    GH_ASSERT_EQUAL_OBJECTS(rig.nodes[@"First name"].value, @"Alex");
    [rig.controller noteFocusedNode:rig.nodes[@"Last name"]];
    rig.nodes[@"Last name"].frame = CGRectOffset(rig.nodes[@"Last name"].frame, 0, 2000);   // pushed far below the window
    [rig tab];
    GH_ASSERT_EQUAL_OBJECTS(rig.controller.lastStep[@"outcome"], @"jumped");
    GH_ASSERT_EQUAL_OBJECTS(rig.nodes[@"Last name"].value, @"");
    GH_ASSERT(rig.controller.currentVisible);
    [rig tab];
    GH_ASSERT_EQUAL_OBJECTS(rig.nodes[@"Last name"].value, @"Chen");
    GH_ASSERT_EQUAL_INT(rig.actuator.pressedNodes.count, 0);
}

#pragma mark - cache -> server

GH_TEST(controller_asks_the_server_once_per_form_and_upgrades_in_place) {
    [GHCtlStub reset];
    [GHCtlStub setPredictHandler:^NSDictionary *(NSDictionary *body) {
        NSMutableArray *assignments = [NSMutableArray array];
        for (NSDictionary *field in body[@"fields"]) {
            // A calibrated model that knows "Phone" is the phone and is certain about it.
            if ([field[@"label"] isEqualToString:@"Phone"]) [assignments addObject:@{ @"signature": field[@"signature"], @"factKey": @"phone", @"confidence": @0.99, @"calibrated": @YES }];
        }
        return @{ @"assignments": assignments, @"provider": @"jev-gateway", @"calibrated": @YES, @"latencyMs": @120 };
    }];
    GHFormCache *cache = [[GHFormCache alloc] initWithPath:nil];
    GHRig *warm = [GHRig rigWithClient:StubClient([GHCore sharedCore], cache)];
    GH_ASSERT(warm != nil);
    [warm buildFormWithAreas:@[]];
    [warm rescan];
    GH_ASSERT_EQUAL_INT(warm.controller.walk.ghosts.count, 5);   // offline ghosts are there before any answer
    for (int i = 0; i < 3; i++) [warm rescan];                   // rescans never ask again
    GH_ASSERT(GHTestWaitUntil(5.0, ^BOOL { return [warm.controller.provider isEqualToString:@"jev-gateway"]; }));
    GH_ASSERT_EQUAL_INT([GHCtlStub countForPath:@"/v1/predict/form"], 1);
    GH_ASSERT_EQUAL_INT(warm.controller.predictionRequests, 1);
    GH_ASSERT_EQUAL_OBJECTS([warm currentLabel], @"First name");   // the upgrade did not disturb the current ghost
    GH_ASSERT_EQUAL_INT(warm.controller.walk.ghosts.count, 5);

    // What left the process: fact KEYS and value-free fields.
    NSDictionary *body = [GHCtlStub bodiesForPath:@"/v1/predict/form"].firstObject;
    NSString *wire = [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:body options:0 error:NULL] encoding:NSUTF8StringEncoding];
    GH_ASSERT([body[@"factKeys"] containsObject:@"email"]);
    GH_ASSERT_FALSE([wire containsString:DemoEmail()]);
    GH_ASSERT(DemoEmail().length > 0);
    GH_ASSERT_FALSE([wire containsString:@"\"value\":\"Alex\""]);

    // A repeat visit is served from the per-window cache: zero calls.
    [cache waitForWrites];
    GHRig *again = [GHRig rigWithClient:StubClient([GHCore sharedCore], cache)];
    [again buildFormWithAreas:@[]];
    [again rescan];
    GH_ASSERT(GHTestWaitUntil(5.0, ^BOOL { return [again.controller.provider isEqualToString:@"jev-gateway"]; }));
    GH_ASSERT_EQUAL_INT([GHCtlStub countForPath:@"/v1/predict/form"], 1);
    [again tab];
    GH_ASSERT_EQUAL_OBJECTS(again.nodes[@"First name"].value, @"Alex");
}

GH_TEST(controller_server_down_changes_nothing) {
    [GHCtlStub reset];                                            // no handler: every request fails to connect
    GHRig *rig = [GHRig rigWithClient:StubClient([GHCore sharedCore], [[GHFormCache alloc] initWithPath:nil])];
    GH_ASSERT(rig != nil);
    [rig buildFormWithAreas:@[]];
    [rig rescan];
    GH_ASSERT(GHTestWaitUntil(5.0, ^BOOL { return [GHCtlStub countForPath:@"/v1/predict/form"] == 1; }));
    GHTestWaitUntil(0.2, ^BOOL { return NO; });
    GH_ASSERT_EQUAL_INT(rig.controller.walk.ghosts.count, 5);
    GH_ASSERT(rig.controller.walk.error == nil);
    GH_ASSERT_EQUAL_OBJECTS(rig.controller.provider, @"offline-heuristic");
    [rig tab];
    GH_ASSERT_EQUAL_OBJECTS(rig.nodes[@"First name"].value, @"Alex");
}

#pragma mark - drafts

static NSString *const kWhy = @"Why do you want to work here?";
static NSString *const kProject = @"Tell us about a project you are proud of";
static NSString *const kTeam = @"Describe how you work in a team";
static NSString *const kAnything = @"Is there anything else you would like to share?";

GH_TEST(controller_drafts_stream_ahead_three_at_a_time_and_a_hold_skips_them) {
    [GHCtlStub reset];
    GHRig *rig = [GHRig rigWithClient:StubClient([GHCore sharedCore], [[GHFormCache alloc] initWithPath:nil])];
    GH_ASSERT(rig != nil);
    [rig buildFormWithAreas:@[ kWhy, kProject, kTeam, kAnything ]];
    [rig rescan];
    GHWalkState *walk = rig.controller.walk;
    NSUInteger pending = 0;
    for (GHGhost *ghost in walk.ghosts) if (ghost.pending) pending++;
    GH_ASSERT_MSG(pending == 4, @"expected 4 pending drafts, got %lu of %lu ghosts", (unsigned long)pending, (unsigned long)walk.ghosts.count);
    GH_ASSERT(walk.ghosts.lastObject.locked);                     // still parked last, after the drafts
    GH_ASSERT_EQUAL_INT(rig.controller.activeDraftCount, 3);      // speculative, but never more than 3 at once
    GH_ASSERT(GHTestWaitUntil(5.0, ^BOOL { return [GHCtlStub openDraftCount] == 3; }));
    GH_ASSERT_EQUAL_INT([GHCtlStub countForPath:@"/v1/ghost-text"], 3);

    // Only the allowlisted facts leave for a draft: no email, no phone.
    NSDictionary *body = [GHCtlStub bodiesForPath:@"/v1/ghost-text"].firstObject;
    GH_ASSERT(body[@"facts"][@"email"] == nil && body[@"facts"][@"phone"] == nil);

    // Holding Tab accepts the four ready ghosts, skips every pending draft and stops.
    [rig tab];
    for (int i = 0; i < 10; i++) [rig holdTab];
    GH_ASSERT_EQUAL_INT(walk.accepted, 4);
    for (NSString *label in @[ kWhy, kProject, kTeam, kAnything ]) GH_ASSERT_EQUAL_OBJECTS(rig.nodes[label].value, @"");
    GH_ASSERT_EQUAL_INT([rig buttonPresses], 0);

    // The first draft finishes: its ghost is ready, and the fourth draft starts.
    GH_ASSERT([GHCtlStub completeDraftForLabel:kWhy text:@"I build fast tools."]);
    GH_ASSERT(GHTestWaitUntil(5.0, ^BOOL { return [GHCtlStub countForPath:@"/v1/ghost-text"] == 4; }));
    [rig.controller noteFocusedNode:rig.nodes[kWhy]];
    GH_ASSERT_FALSE(walk.current.pending);
    [rig tab];
    GH_ASSERT_EQUAL_OBJECTS(rig.nodes[kWhy].value, @"I build fast tools.");
    GH_ASSERT_EQUAL_INT(walk.accepted, 5);
}

GH_TEST(controller_tab_on_a_pending_draft_waits_for_it) {
    [GHCtlStub reset];
    GHRig *rig = [GHRig rigWithClient:StubClient([GHCore sharedCore], [[GHFormCache alloc] initWithPath:nil])];
    GH_ASSERT(rig != nil);
    [rig buildFormWithAreas:@[ kWhy ]];
    [rig rescan];
    GH_ASSERT(GHTestWaitUntil(5.0, ^BOOL { return [GHCtlStub openDraftCount] == 1; }));
    [rig.controller noteFocusedNode:rig.nodes[kWhy]];
    GH_ASSERT(rig.controller.walk.current.pending);
    [rig tab];                                                    // a deliberate press: wait, write nothing yet
    GH_ASSERT(rig.controller.busy);
    GH_ASSERT([rig.controller.eventTap publishedSnapshot].busy);
    GH_ASSERT_EQUAL_OBJECTS(rig.nodes[kWhy].value, @"");
    GH_ASSERT([GHCtlStub completeDraftForLabel:kWhy text:@"I build fast tools."]);
    GH_ASSERT(GHTestWaitUntil(5.0, ^BOOL { return !rig.controller.busy; }));
    GH_ASSERT_EQUAL_OBJECTS(rig.nodes[kWhy].value, @"I build fast tools.");
    GH_ASSERT_EQUAL_INT(rig.controller.walk.accepted, 1);

    // Escape on a draft cancels its stream; a lone text area never gets a draft in the first place.
    [GHCtlStub reset];
    GHRig *lone = [GHRig rigWithClient:StubClient([GHCore sharedCore], [[GHFormCache alloc] initWithPath:nil])];
    lone.window = [GHFakeAXNode nodeWithRole:@"AXWindow" title:@"Chat" frame:CGRectMake(100, 60, 900, 760)];
    lone.web = [lone.window addChild:[GHFakeAXNode nodeWithRole:@"AXWebArea" title:nil frame:CGRectMake(100, 110, 900, 710)]];
    [lone add:@"AXTextArea" label:@"Message the team about anything you like" y:200 height:80];
    [lone rescan];
    GHTestWaitUntil(0.2, ^BOOL { return NO; });
    GH_ASSERT_EQUAL_INT(lone.controller.walk.ghosts.count, 0);
    GH_ASSERT_EQUAL_INT([GHCtlStub countForPath:@"/v1/ghost-text"], 0);
}

/// Fills the four ready fields, so the draft for `kWhy` is the last unlocked ghost before the locked Submit.
static void CtlFillReadyFields(GHRig *rig) {
    for (NSString *label in @[ @"First name", @"Last name", @"Email", @"Phone" ]) {
        [rig.controller noteFocusedNode:rig.nodes[label]];
        [rig tab];
    }
}

GH_TEST(controller_a_draft_that_lands_after_the_user_left_writes_nothing_and_never_parks_on_submit) {
    [GHCtlStub reset];
    GHRig *rig = [GHRig rigWithClient:StubClient([GHCore sharedCore], [[GHFormCache alloc] initWithPath:nil])];
    GH_ASSERT(rig != nil);
    [rig buildFormWithAreas:@[ kWhy ]];
    GHFakeAXNode *own = [rig add:@"AXTextArea" label:@"Anything you want to add yourself" y:700 height:60];
    own.value = @"typed by the user";                               // no ghost: the user is writing it
    [rig rescan];
    GH_ASSERT(GHTestWaitUntil(5.0, ^BOOL { return [GHCtlStub openDraftCount] == 1; }));
    CtlFillReadyFields(rig);
    GH_ASSERT_EQUAL_INT(rig.controller.walk.accepted, 4);
    __block id<GHAXNode> focus = rig.nodes[kWhy];
    rig.controller.focusedNodeProvider = ^id<GHAXNode> { return focus; };
    [rig.controller noteFocusedNode:rig.nodes[kWhy]];
    GH_ASSERT(rig.controller.walk.current.pending);

    [rig tab];                                                    // waits for the draft
    GH_ASSERT(rig.controller.busy);
    [rig tab];                                                    // two more presses while it waits: queued
    [rig tab];
    focus = own;                                                  // the user clicks into their own essay and types
    NSUInteger focusBefore = rig.actuator.focusCount;
    GH_ASSERT([GHCtlStub completeDraftForLabel:kWhy text:@"I build fast tools."]);
    GH_ASSERT(GHTestWaitUntil(5.0, ^BOOL { return !rig.controller.busy; }));
    GH_ASSERT_EQUAL_OBJECTS(rig.controller.lastStep[@"outcome"], @"focus-left");
    GH_ASSERT_EQUAL_OBJECTS(rig.nodes[kWhy].value, @"");            // nothing written behind the user's back
    GH_ASSERT_EQUAL_INT(rig.actuator.focusCount, focusBefore);       // focus was not taken from them
    GH_ASSERT_FALSE(rig.nodes[@"Submit application"].isFocused);
    GH_ASSERT_EQUAL_OBJECTS(own.value, @"typed by the user");
    GH_ASSERT_EQUAL_INT(rig.handedBack, 0);                          // a delayed Tab is dropped, never replayed
    GH_ASSERT_EQUAL_INT(rig.controller.walk.accepted, 4);
    GH_ASSERT_EQUAL_INT([rig buttonPresses], 0);
}

GH_TEST(controller_a_delayed_accept_never_moves_focus_onto_the_lock) {
    [GHCtlStub reset];
    GHRig *rig = [GHRig rigWithClient:StubClient([GHCore sharedCore], [[GHFormCache alloc] initWithPath:nil])];
    GH_ASSERT(rig != nil);
    [rig buildFormWithAreas:@[ kWhy ]];
    [rig rescan];
    GH_ASSERT(GHTestWaitUntil(5.0, ^BOOL { return [GHCtlStub openDraftCount] == 1; }));
    CtlFillReadyFields(rig);
    GHFakeAXActuator *actuator = rig.actuator;
    rig.controller.focusedNodeProvider = ^id<GHAXNode> { return actuator.focusedNode; };   // focus stays on the essay
    [rig.controller noteFocusedNode:rig.nodes[kWhy]];
    [rig tab];
    GH_ASSERT([GHCtlStub completeDraftForLabel:kWhy text:@"I build fast tools."]);
    GH_ASSERT(GHTestWaitUntil(5.0, ^BOOL { return !rig.controller.busy; }));
    GH_ASSERT_EQUAL_OBJECTS(rig.nodes[kWhy].value, @"I build fast tools.");
    GHWalkState *walk = rig.controller.walk;
    GH_ASSERT(walk.current.locked);                                  // parked and drawn...
    GH_ASSERT_FALSE(rig.nodes[@"Submit application"].isFocused);     // ...but focus stays on the essay seconds later
    GH_ASSERT(rig.nodes[kWhy].isFocused);
    // The user's next deliberate Tab parks focus on it; nothing ever presses it.
    [rig tab];
    GH_ASSERT_EQUAL_OBJECTS(rig.controller.lastStep[@"outcome"], @"parked");
    GH_ASSERT(rig.nodes[@"Submit application"].isFocused);
    GH_ASSERT_EQUAL_INT([rig buttonPresses], 0);
}

GH_TEST(controller_focus_moved_during_a_write_is_left_where_the_user_put_it) {
    RIG(rig, nil);
    [rig buildFormWithAreas:@[]];
    GHFakeAXNode *search = [GHFakeAXNode nodeWithRole:@"AXTextField" title:nil frame:CGRectMake(600, 70, 200, 30)];
    [rig.window addChild:search];                                    // browser chrome: never captured
    [rig rescan];
    for (NSString *label in @[ @"First name", @"Last name", @"Email" ]) { [rig.controller noteFocusedNode:rig.nodes[label]]; [rig tab]; }
    // Phone is the last field before Submit. The step starts with focus on it; by the time the write is verified the
    // user has clicked into the search box.
    __block NSUInteger reads = 0;
    GHFakeAXNode *phone = rig.nodes[@"Phone"];
    rig.controller.focusedNodeProvider = ^id<GHAXNode> { return reads++ == 0 ? phone : search; };
    [rig.controller noteFocusedNode:rig.nodes[@"Phone"]];
    NSUInteger focusBefore = rig.actuator.focusCount;
    [rig tab];
    GH_ASSERT(rig.nodes[@"Phone"].value.length > 0);
    GH_ASSERT(reads >= 2);
    GH_ASSERT(rig.controller.walk.current.locked);
    GH_ASSERT_FALSE(rig.nodes[@"Submit application"].isFocused);
    GH_ASSERT_EQUAL_INT(rig.actuator.focusCount, focusBefore + 1);   // the fill's own focus only, nothing after it
    // A Tab from the search box is the browser's again, and a stale one that slipped through is handed back unwritten.
    GH_ASSERT_FALSE([rig.controller.eventTap publishedSnapshot].focusInWalk);
    [rig tab];
    GH_ASSERT_EQUAL_OBJECTS(rig.controller.lastStep[@"outcome"], @"handed-back");
    GH_ASSERT_EQUAL_INT(rig.handedBack, 1);
    GH_ASSERT_FALSE(rig.nodes[@"Submit application"].isFocused);
}

/// The other half of the same rule. Tab is handed back when focus has left the walk, because Tab belonged to
/// whatever the user was focused on. A lone right Option belongs to nobody, so it is not handed back -- and
/// requiring focus is exactly what made the accept do nothing in every native app, where focus sits on a list
/// row or a sidebar while the ghost is on a toolbar button.
GH_TEST(controller_the_ghost_key_accepts_even_when_focus_is_elsewhere) {
    RIG(rig, nil);
    [rig buildFormWithAreas:@[]];
    GHFakeAXNode *elsewhere = [GHFakeAXNode nodeWithRole:@"AXTextField" title:nil frame:CGRectMake(600, 70, 200, 30)];
    [rig.window addChild:elsewhere];   // never captured: focus here is "not in the walk"
    [rig rescan];
    rig.controller.focusedNodeProvider = ^id<GHAXNode> { return elsewhere; };
    [rig.controller noteFocusedNode:elsewhere];
    GH_ASSERT_FALSE([rig.controller.eventTap publishedSnapshot].focusInWalk);

    // A Tab from there is the app's.
    [rig tab];
    GH_ASSERT_EQUAL_OBJECTS(rig.controller.lastStep[@"outcome"], @"handed-back");
    GH_ASSERT_EQUAL_INT(rig.handedBack, 1);
    GH_ASSERT_EQUAL_INT(rig.nodes[@"First name"].value.length, 0);

    // The Ghost key is not.
    [rig ghostKey];
    GH_ASSERT_EQUAL_OBJECTS(rig.controller.lastStep[@"outcome"], @"accepted");
    GH_ASSERT_EQUAL_INT(rig.handedBack, 1);   // nothing was given back to the app
    GH_ASSERT(rig.nodes[@"First name"].value.length > 0);
}

/// The messaging half of "Ghost anywhere": a thread on screen and an empty box under it, so the ghost is the
/// reply. Shaped like a real Messages window -- the words of each message live on a group's AXDescription as
/// "<who>, <what>, <when>", the bubble itself carries nothing, and the compose box is at the bottom.
GH_TEST(controller_a_thread_on_screen_drafts_a_reply_into_the_box_below_it) {
    [GHCtlStub reset];
    GHRig *rig = [GHRig rigWithClient:StubClient([GHCore sharedCore], [[GHFormCache alloc] initWithPath:nil])];
    rig.window = [GHFakeAXNode nodeWithRole:@"AXWindow" title:@"Messages" frame:CGRectMake(0, 0, 1400, 800)];
    GHFakeAXNode *thread = [rig.window addChild:[GHFakeAXNode nodeWithRole:@"AXGroup" title:nil frame:CGRectMake(300, 40, 1100, 700)]];
    NSArray<NSString *> *said = @[ @"Tahseen Rayhan, are you coming tonight, 7:04 PM", @"Alex Chen, yes, 7:05 PM" ];
    for (NSUInteger i = 0; i < said.count; i++) {
        GHFakeAXNode *row = [thread addChild:[GHFakeAXNode nodeWithRole:@"AXGroup" title:nil
                                                                  frame:CGRectMake(320, (CGFloat)(60 + i * 40), 300, 33)]];
        row.axDescription = said[i];
        [row addChild:[GHFakeAXNode nodeWithRole:@"AXTextArea" title:nil frame:CGRectMake(320, (CGFloat)(60 + i * 40), 300, 33)]];
    }
    // A search box at the top and the compose box at the bottom: only the bottom one is the reply box.
    GHFakeAXNode *search = [rig.window addChild:[GHFakeAXNode nodeWithRole:@"AXTextField" title:@"Search" frame:CGRectMake(20, 50, 260, 30)]];
    search.subrole = @"AXSearchField";
    GHFakeAXNode *compose = [rig.window addChild:[GHFakeAXNode nodeWithRole:@"AXTextField" title:@"Message" frame:CGRectMake(320, 750, 1000, 33)]];
    [rig rescan];

    GH_ASSERT(GHTestWaitUntil(5.0, ^BOOL { return [GHCtlStub openDraftCount] == 1; }));
    GH_ASSERT_EQUAL_INT(rig.controller.walk.ghosts.count, 1);
    GH_ASSERT_EQUAL_OBJECTS(rig.controller.walk.current.action, GHGhostActionFill);
    GH_ASSERT([GHCtlStub completeDraftForLabel:@"Message" text:@"ya see you there"]);
    GH_ASSERT(GHTestWaitUntil(5.0, ^BOOL { return !rig.controller.walk.current.pending; }));

    // The reply goes where a reply goes, and taking it writes it there and nowhere else.
    [rig.controller noteFocusedNode:compose];
    [rig ghostKey];
    GH_ASSERT_EQUAL_OBJECTS(compose.value, @"ya see you there");
    GH_ASSERT_EQUAL_INT(search.value.length, 0);
}

#pragma mark - the eyes

/// A 1x1 image stands in for a screenshot: this never touches the screen and never needs the permission.
static CGImageRef CtlPixelImage(void) {
    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = CGBitmapContextCreate(NULL, 8, 8, 8, 0, space, kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(space);
    CGContextSetRGBFillColor(context, 0.2, 0.2, 0.2, 1);
    CGContextFillRect(context, CGRectMake(0, 0, 8, 8));
    CGImageRef image = CGBitmapContextCreateImage(context);
    CGContextRelease(context);
    return image;
}

/**
 * The whole vision path through the controller, with no window server, no key and no network.
 *
 * Worth a test rather than a live run: measured against the real route, every app on the machine this was
 * written on names all of its controls, so there was nothing for the model to name anywhere. The wiring still
 * has to be right for the day an app does publish a nameless one.
 *
 * What it proves is the part that is easy to get wrong: capture rebuilds its fields on EVERY rescan, so a
 * name that arrives asynchronously has to be remembered and put back, or it is thrown away a tenth of a
 * second after it lands.
 */
GH_TEST(controller_a_name_from_the_model_survives_the_next_capture) {
    [GHCtlStub reset];
    GHRig *rig = [GHRig rigWithClient:StubClient([GHCore sharedCore], [[GHFormCache alloc] initWithPath:nil])];
    rig.window = [GHFakeAXNode nodeWithRole:@"AXWindow" title:@"Player" frame:CGRectMake(0, 0, 900, 600)];
    // An icon-only button: no title, no description, nothing anywhere in the tree to read.
    GHFakeAXNode *glyph = [rig.window addChild:[GHFakeAXNode nodeWithRole:@"AXButton" title:nil frame:CGRectMake(420, 520, 36, 36)]];
    // The live controller turns this on for its own capture; the rig injects one, so the test says so too.
    rig.capture.capturesUnnamedControls = YES;

    __block NSUInteger calls = 0;
    GHVision *vision = [[GHVision alloc] initWithBaseURLString:@"http://127.0.0.1:8787"];
    vision.screenshot = ^CGImageRef(CGRect rect) { return CtlPixelImage(); };
    vision.transport = ^(NSURLRequest *request, void (^done)(NSData *, NSInteger)) {
        calls++;
        NSString *reply = [NSString stringWithFormat:@"{\"labels\":[{\"id\":\"%@\",\"label\":\"Full screen\",\"confidence\":0.9}]}",
                           [rig.controller focusSignatureForNode:glyph]];
        done([reply dataUsingEncoding:NSUTF8StringEncoding], 200);
    };
    rig.controller.vision = vision;

    [rig rescan];
    GH_ASSERT(GHTestWaitUntil(3.0, ^BOOL { return calls > 0; }));

    // The name reaches the GHOST, which is the only place it is worth anything, and it is still there after
    // the page has been captured again from scratch.
    [rig rescanPage:@"page-1"];
    NSString *signature = [rig.controller focusSignatureForNode:glyph];
    GHGhost *ghost = [rig.controller.walk ghostWithSignature:signature];
    GH_ASSERT(ghost != nil);
    GH_ASSERT_EQUAL_OBJECTS(ghost.displayText, @"Full screen");

    // One call per page view: rescanning does not ask again.
    NSUInteger after = calls;
    [rig rescanPage:@"page-1"];
    GH_ASSERT_EQUAL_INT(calls, after);
}

#pragma mark - lifecycle

GH_TEST(controller_start_and_stop_are_safe_while_untrusted) {
    RIG(rig, nil);
    GHController *controller = rig.controller;
    controller.assumesActive = NO;                                // the real gate
    controller.accessibility.trustProbe = ^BOOL { return NO; };   // deterministic: never touches the live AX API
    for (int round = 0; round < 2; round++) {                     // a restart (disable, enable) works too
        [controller start];
        GH_ASSERT(controller.running);
        GH_ASSERT_FALSE(controller.active);
        GH_ASSERT_EQUAL_OBJECTS([controller statusLine], @"Needs Accessibility permission");
        GH_ASSERT_FALSE([controller.eventTap publishedSnapshot].active);
        GH_ASSERT_FALSE([controller.eventTap handleKeyDown:GHKeyCodeTab flags:0 isRepeat:NO userData:0 printable:NO]);
        GH_ASSERT_FALSE([controller.eventTap handleKeyDown:GHKeyCodeEscape flags:0 isRepeat:NO userData:0 printable:NO]);
        [rig buildFormWithAreas:@[]];
        [rig rescan];                                             // even a capture handed in is ignored while untrusted
        GH_ASSERT_EQUAL_INT(controller.walk.ghosts.count, 0);
        [controller stop];
        GH_ASSERT_FALSE(controller.running);
        GH_ASSERT_FALSE(controller.eventTap.wanted);
    }
    GH_ASSERT_EQUAL_INT(rig.actuator.setValueCount + rig.actuator.typeCount + rig.actuator.focusCount, 0);
}

#pragma mark - page context for drafts

GH_TEST(controller_draft_context_is_the_posting_for_long_questions_only) {
    GHField *area = [GHField fieldWithSignature:@"a" label:@"Anything else?" kind:GHKindTextArea];
    GHField *question = [GHField fieldWithSignature:@"q" label:@"Why do you want to work here?" kind:GHKindText];
    GHField *shortText = [GHField fieldWithSignature:@"s" label:@"Preferred name" kind:GHKindText];
    GHField *select = [GHField fieldWithSignature:@"c" label:@"Which office would you like to work from most?" kind:GHKindSelect];
    GH_ASSERT([GHController isLongQuestionField:area]);
    GH_ASSERT([GHController isLongQuestionField:question]);
    GH_ASSERT_FALSE([GHController isLongQuestionField:shortText]);
    GH_ASSERT_FALSE([GHController isLongQuestionField:select]);
    GH_ASSERT([GHController isLongQuestionField:[GHField fieldWithSignature:@"l" label:@"Tell us about a project you are proud of" kind:GHKindText]]);

    NSDictionary *page = @{ @"company": @"Acme Robots", @"role": @"Robotics Intern", @"description": @"We build friendly robots." };
    GH_ASSERT_EQUAL_OBJECTS([GHController draftContextForField:question page:page], page);
    shortText.context = @"Personal details";
    GH_ASSERT_EQUAL_OBJECTS([GHController draftContextForField:shortText page:page], (@{ @"description": @"Personal details" }));
    area.context = @"Questions";
    GH_ASSERT_EQUAL_OBJECTS([GHController draftContextForField:area page:@{ @"company": @"Acme Robots" }], (@{ @"company": @"Acme Robots", @"description": @"Questions" }));
    GH_ASSERT_EQUAL_OBJECTS([GHController draftContextForField:question page:nil], (@{}));
}

GH_TEST(controller_drafts_carry_company_role_and_description_of_the_posting) {
    [GHCtlStub reset];
    GHRig *rig = [GHRig rigWithClient:StubClient([GHCore sharedCore], [[GHFormCache alloc] initWithPath:nil])];
    GH_ASSERT(rig != nil);
    [rig buildFormWithAreas:@[ kWhy ]];
    rig.web.axDescription = @"Job Application for Robotics Intern at Acme Robots";
    GHFakeAXNode *heading = [GHFakeAXNode nodeWithRole:@"AXHeading" title:@"Robotics Intern" frame:CGRectMake(140, 112, 400, 24)];
    [rig.web insertChild:heading atIndex:0];
    [rig.web insertChild:[GHFakeAXNode staticText:@"We build friendly robots for warehouses." frame:CGRectMake(140, 120, 400, 18)] atIndex:1];
    [rig.web insertChild:[GHFakeAXNode nodeWithRole:@"AXHeading" title:@"Apply for this job" frame:CGRectMake(140, 128, 400, 10)] atIndex:2];
    [rig rescan];
    GH_ASSERT(GHTestWaitUntil(5.0, ^BOOL { return [GHCtlStub countForPath:@"/v1/ghost-text"] == 1; }));
    NSDictionary *body = [GHCtlStub bodiesForPath:@"/v1/ghost-text"].firstObject;
    NSDictionary *context = body[@"pageContext"];
    GH_ASSERT_EQUAL_OBJECTS(context[@"company"], @"Acme Robots");
    GH_ASSERT_EQUAL_OBJECTS(context[@"role"], @"Robotics Intern");
    GH_ASSERT([context[@"description"] containsString:@"friendly robots"]);
    NSString *wire = [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:body options:0 error:NULL] encoding:NSUTF8StringEncoding];
    GH_ASSERT_FALSE([wire containsString:DemoEmail()]);          // still only the allowlisted facts
}

#pragma mark - the answer engine and the gate (docs/answers.md, docs/incremental.md)

/// The same form plus a required Country select the profile can answer and a required consent checkbox it cannot.
static void CtlBuildGatedForm(GHRig *rig) {
    [rig buildFormWithAreas:@[]];
    GHFakeAXNode *submit = rig.nodes[@"Submit application"];
    GHFakeAXNode *consent = [rig add:@"AXCheckBox" label:@"I agree to the terms *" y:submit.frame.origin.y height:24];
    consent.value = @"0";   // AXValue of an unticked box
    // The submit has to come last in reading order for the gate to have anything to withhold.
    [rig.web removeChild:submit];
    submit.frame = CGRectMake(submit.frame.origin.x, consent.frame.origin.y + 50, submit.frame.size.width, 32);
    [rig.web addChild:submit];
}

GH_TEST(controller_withholds_submit_until_the_required_field_is_answered_and_says_why) {
    RIG(rig, nil);
    CtlBuildGatedForm(rig);
    [rig rescan];
    GHWalkState *walk = rig.controller.walk;
    // A required checkbox nobody has ticked: no Submit ghost at all, no lock badge, and the HUD says why.
    for (GHGhost *ghost in walk.ghosts) GH_ASSERT_FALSE(ghost.locked);
    GH_ASSERT([[rig.controller statusLine] containsString:@"1 required field still empty"]);
    GH_ASSERT([[rig.controller statusLine] containsString:@"I agree to the terms"]);

    // The user ticks it themselves. The next rescan finds nothing unmet and parks the locked Submit last.
    rig.nodes[@"I agree to the terms *"].value = @"1";
    [rig rescan];
    GH_ASSERT(walk.ghosts.lastObject.locked);
    GH_ASSERT_FALSE([[rig.controller statusLine] containsString:@"required field"]);
}

GH_TEST(controller_learns_the_answer_the_user_gave_and_proposes_it_next_time) {
    RIG(rig, nil);
    [rig.store updateSettings:@{ @"learningEnabled": @YES } error:NULL];
    [rig buildFormWithAreas:@[]];
    GHFakeAXNode *referral = [rig add:@"AXTextField" label:@"How did you hear about us?" y:600 height:30];
    [rig rescan];
    GH_ASSERT_EQUAL_INT([rig.store.answers[@"answers"] count], 0);

    // The user types their own answer over the one Ghost proposed. No key logging: the next capture simply
    // reports a value Ghost did not write.
    referral.value = @"A friend at Viam";
    [rig rescan];
    GH_ASSERT_EQUAL_INT([rig.store.answers[@"answers"] count], 1);
    NSDictionary *learned = rig.store.answers[@"answers"][0];
    GH_ASSERT_EQUAL_OBJECTS(learned[@"label"], @"How did you hear about us?");
    GH_ASSERT_EQUAL_OBJECTS(learned[@"value"], @"A friend at Viam");
    GH_ASSERT_EQUAL_OBJECTS(learned[@"class"], @"ordinary");
    struct stat st;
    GH_ASSERT_EQUAL_INT(stat(rig.store.answersPath.fileSystemRepresentation, &st), 0);
    GH_ASSERT_EQUAL_INT((int)(st.st_mode & 0777), 0600);

    // The same question on the next page is answered from the correction rather than from the profile.
    GHRig *next = [GHRig rigWithClient:nil];
    GH_ASSERT(next != nil);
    next.store = rig.store;
    GHController *controller = [[GHController alloc] initWithCore:next.core store:rig.store client:nil];
    controller.assumesActive = YES;
    controller.capture = next.capture;
    controller.overlay = next.controller.overlay;
    controller.writer = next.controller.writer;
    next.controller = controller;
    [next buildFormWithAreas:@[]];
    [next add:@"AXTextField" label:@"How did you hear about us?" y:600 height:30];
    [next rescan];
    GHGhost *proposed = nil;
    for (GHGhost *ghost in controller.walk.ghosts) {
        if ([[controller focusSignatureForNode:next.nodes[@"How did you hear about us?"]] isEqualToString:ghost.signature]) proposed = ghost;
    }
    GH_ASSERT(proposed != nil);
    GH_ASSERT_EQUAL_OBJECTS(proposed.value, @"A friend at Viam");
    GH_ASSERT_EQUAL_OBJECTS(proposed.answerSource, @"learned");
}

GH_TEST(controller_never_learns_its_own_writes_or_a_secret_and_never_learns_with_learning_off) {
    RIG(rig, nil);
    [rig buildFormWithAreas:@[]];
    [rig rescan];
    // Learning is off by default: a user edit changes nothing on disk.
    rig.nodes[@"First name"].value = @"Alexandra";
    [rig rescan];
    GH_ASSERT_EQUAL_INT([rig.store.answers[@"answers"] count], 0);
    GH_ASSERT_FALSE([NSFileManager.defaultManager fileExistsAtPath:rig.store.answersPath]);

    // With learning on, what GHOST writes is never read back as a correction.
    [rig.store updateSettings:@{ @"learningEnabled": @YES } error:NULL];
    rig.nodes[@"First name"].value = @"";
    [rig rescan];
    for (int i = 0; i < 4; i++) [rig tab];
    [rig rescan];
    GH_ASSERT_EQUAL_OBJECTS(rig.nodes[@"First name"].value, @"Alex");
    GH_ASSERT_EQUAL_OBJECTS(rig.nodes[@"Email"].value, DemoEmail());
    GH_ASSERT_EQUAL_INT([rig.store.answers[@"answers"] count], 0);
    GH_ASSERT_FALSE([NSFileManager.defaultManager fileExistsAtPath:rig.store.answersPath]);
}

GH_TEST(controller_hold_tab_stops_at_a_guess_and_a_fresh_press_takes_it) {
    RIG(rig, nil);
    [rig buildFormWithAreas:@[]];
    // A declaration the Canadian demo profile cannot support: the conservative "No", shown as a guess.
    GHFakeAXNode *auth = [rig add:@"AXRadioGroup" label:@"Are you legally authorized to work in the United States?" y:600 height:30];
    [auth addChild:[GHFakeAXNode nodeWithRole:@"AXRadioButton" title:@"Yes" frame:CGRectMake(140, 600, 60, 20)]];
    [auth addChild:[GHFakeAXNode nodeWithRole:@"AXRadioButton" title:@"No" frame:CGRectMake(210, 600, 60, 20)]];
    [rig rescan];

    GHWalkState *walk = rig.controller.walk;
    GHGhost *guess = nil;
    for (GHGhost *ghost in walk.ghosts) if (ghost.guess) guess = ghost;
    GH_ASSERT_MSG(guess != nil, @"the US question should be a visible guess");
    GH_ASSERT(guess.needsReview);

    // Hold Tab through the form: it takes the facts and STOPS on the guess without writing it.
    for (int i = 0; i < 10 && walk.current && !walk.current.guess; i++) [rig holdTab];
    GH_ASSERT(walk.current != nil && walk.current.guess);
    [rig holdTab];
    GH_ASSERT_EQUAL_OBJECTS(rig.controller.lastStep[@"outcome"], @"needs-press");
    GH_ASSERT_EQUAL_OBJECTS(rig.controller.lastStep[@"reason"], @"guess");
    GH_ASSERT(walk.current.guess);   // still there, still unwritten

    // One deliberate press takes it.
    [rig tab];
    GH_ASSERT_EQUAL_OBJECTS(rig.controller.lastStep[@"outcome"], @"accepted");
}
