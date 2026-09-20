#import "GHTestPanel.h"
#import "GHController.h"
#import "GHHarness.h"
#import "GHLog.h"
#import "GHWalkState.h"

const NSTimeInterval GHTestPanelDelay = 1.0;

/// How long to wait after the action before reading what the controller recorded. A write verifies itself
/// after a moment, so asking immediately would always report the step before this one.
static const NSTimeInterval kSettle = 0.7;
static const CGFloat kWidth = 260;
static const CGFloat kHeight = 96;
static const CGFloat kMargin = 24;

#pragma mark - panel

/// Never key, never main, never activating: pressing a button here must not take focus away from the app
/// under test, or the thing being measured changes as it is measured.
@interface GHTestPanelWindow : NSPanel
@end

@implementation GHTestPanelWindow
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
- (BOOL)isAccessibilityElement { return NO; }   // keep it out of Ghost's own walks
@end

#pragma mark - GHTestPanel

@implementation GHTestPanel {
    __weak GHController *_controller;
    GHTestPanelWindow *_panel;
    NSTextField *_result;
    id<GHAutotabKeyPosting> _poster;
}

- (instancetype)initWithController:(GHController *)controller {
    if ((self = [super init])) {
        _controller = controller;
        _resultLine = @"ready";
        _after = ^(NSTimeInterval delay, dispatch_block_t block) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)), dispatch_get_main_queue(), block);
        };
        _poster = [[GHHarnessTabPoster alloc] init];
        __weak GHTestPanel *weakSelf = self;
        _postTab = ^BOOL { GHTestPanel *panel = weakSelf; return panel ? [panel->_poster postTab] : NO; };
    }
    return self;
}

- (BOOL)visible {
    return _panel != nil && _panel.isVisible;
}

- (void)toggle {
    if (self.visible) [self hide]; else [self show];
}

- (void)hide {
    [_panel orderOut:nil];
}

- (void)show {
    if (!_panel) [self build];
    [_panel orderFrontRegardless];
}

- (void)build {
    NSScreen *screen = NSScreen.mainScreen ?: NSScreen.screens.firstObject;
    CGRect visible = screen.visibleFrame;
    CGRect frame = CGRectMake(CGRectGetMinX(visible) + kMargin, CGRectGetMinY(visible) + kMargin, kWidth, kHeight);
    _panel = [[GHTestPanelWindow alloc] initWithContentRect:frame
                                                  styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskUtilityWindow | NSWindowStyleMaskNonactivatingPanel
                                                    backing:NSBackingStoreBuffered
                                                      defer:NO];
    _panel.title = [NSString stringWithFormat:@"%@ test", GHProductName];
    _panel.level = NSStatusWindowLevel;
    _panel.hidesOnDeactivate = NO;   // Ghost is never the active app
    _panel.canHide = NO;
    _panel.becomesKeyOnlyIfNeeded = YES;
    _panel.releasedWhenClosed = NO;
    _panel.excludedFromWindowsMenu = YES;
    _panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary |
                                NSWindowCollectionBehaviorStationary | NSWindowCollectionBehaviorIgnoresCycle;

    NSButton *tab = [NSButton buttonWithTitle:@"Tab" target:self action:@selector(tabPressed:)];
    tab.frame = CGRectMake(12, 44, 112, 32);
    tab.toolTip = [NSString stringWithFormat:@"Posts a real Tab one second from now. Nothing does? The key never reached %@.", GHProductName];
    NSButton *accept = [NSButton buttonWithTitle:@"Accept" target:self action:@selector(acceptPressed:)];
    accept.frame = CGRectMake(136, 44, 112, 32);
    accept.toolTip = @"Takes the current ghost one second from now, the same way the accept key does.";

    _result = [NSTextField labelWithString:self.resultLine];
    _result.frame = CGRectMake(12, 14, kWidth - 24, 22);
    _result.font = [NSFont monospacedDigitSystemFontOfSize:11 weight:NSFontWeightRegular];
    _result.textColor = NSColor.secondaryLabelColor;
    _result.lineBreakMode = NSLineBreakByTruncatingTail;

    NSView *content = _panel.contentView;
    [content addSubview:tab];
    [content addSubview:accept];
    [content addSubview:_result];
}

#pragma mark actions

- (void)tabPressed:(id)sender {
    [self countDownThen:^(GHTestPanel *panel) { [panel runTab]; }];
}

- (void)acceptPressed:(id)sender {
    [self countDownThen:^(GHTestPanel *panel) { [panel runAccept]; }];
}

/// The wait is what makes the measurement honest: the hand comes off the mouse, the app settles, and the
/// panel says so while it counts down.
- (void)countDownThen:(void (^)(GHTestPanel *panel))action {
    [self note:[NSString stringWithFormat:@"in %.0fs...", GHTestPanelDelay]];
    __weak GHTestPanel *weakSelf = self;
    self.after(GHTestPanelDelay, ^{
        GHTestPanel *panel = weakSelf;
        if (panel) action(panel);
    });
}

- (void)runTab {
    BOOL posted = self.postTab ? self.postTab() : NO;
    GHLog(@"test panel: posted a real Tab (%@)", posted ? @"ok" : @"refused");
    if (!posted) { [self note:@"tab: could not be posted"]; return; }
    [self reportAfterSettling:@"tab"];
}

- (void)runAccept {
    GHController *controller = _controller;
    if (!controller) { [self note:@"accept: no controller"]; return; }
    GHLog(@"test panel: accepting the current ghost");
    [controller eventTapDidTapGhostKey:controller.eventTap];
    [self reportAfterSettling:@"accept"];
}

- (void)reportAfterSettling:(NSString *)what {
    __weak GHTestPanel *weakSelf = self;
    self.after(kSettle, ^{
        GHTestPanel *panel = weakSelf;
        if (panel) [panel note:[NSString stringWithFormat:@"%@: %@", what, [panel stepSummary]]];
    });
}

/// Short codes from the controller's own record. Never a label, a value or anything that was typed.
- (NSString *)stepSummary {
    GHController *controller = _controller;
    NSDictionary *step = controller.lastStep;
    if (!step) return @"nothing happened";
    NSMutableArray<NSString *> *parts = [NSMutableArray array];
    if ([step[@"outcome"] isKindOfClass:[NSString class]]) [parts addObject:step[@"outcome"]];
    if ([step[@"method"] isKindOfClass:[NSString class]]) [parts addObject:step[@"method"]];
    if ([step[@"reason"] isKindOfClass:[NSString class]]) [parts addObject:step[@"reason"]];
    if (parts.count == 0) [parts addObject:@"?"];
    NSString *ghosts = controller.walk.current ? @"" : @" (no ghost)";
    return [[parts componentsJoinedByString:@" "] stringByAppendingString:ghosts];
}

- (void)note:(NSString *)line {
    _resultLine = [line copy];
    _result.stringValue = _resultLine;
}

@end
