#import "SBOverlayWindow.h"
#import "SBOverlayLayers.h"
#import "SBOverlayDrawing.h"

#pragma mark - Panel

@interface SBOverlayPanel : NSPanel
@end

@implementation SBOverlayPanel
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
- (BOOL)isAccessibilityElement { return NO; }  // keep the glass out of everyone's AX tree, including our own walks
/// AppKit would push a borderless window below the menu bar; the glass must cover the whole display.
- (NSRect)constrainFrameRect:(NSRect)frameRect toScreen:(NSScreen *)screen { return frameRect; }
@end

static NSPanel *SBMakeOverlayPanel(CGRect frame, CALayer *root, BOOL excludedFromCapture) {
    NSPanel *panel = [[SBOverlayPanel alloc] initWithContentRect:frame
                                                       styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                                                         backing:NSBackingStoreBuffered
                                                           defer:NO];
    panel.level = NSScreenSaverWindowLevel - 1;
    panel.opaque = NO;
    panel.backgroundColor = NSColor.clearColor;
    panel.hasShadow = NO;
    panel.ignoresMouseEvents = YES;
    panel.hidesOnDeactivate = NO;  // NSPanel hides with its app by default; Shabang is never the active app
    panel.canHide = NO;
    panel.movable = NO;
    panel.becomesKeyOnlyIfNeeded = YES;
    panel.worksWhenModal = YES;
    panel.releasedWhenClosed = NO;
    panel.restorable = NO;
    panel.excludedFromWindowsMenu = YES;
    panel.animationBehavior = NSWindowAnimationBehaviorNone;
    panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary |
                               NSWindowCollectionBehaviorStationary | NSWindowCollectionBehaviorIgnoresCycle;
    panel.sharingType = excludedFromCapture ? NSWindowSharingNone : NSWindowSharingReadOnly;

    NSView *view = [[NSView alloc] initWithFrame:CGRectMake(0, 0, frame.size.width, frame.size.height)];
    view.layer = root;  // layer-hosting: set the layer BEFORE wantsLayer so AppKit never draws into it
    view.wantsLayer = YES;
    panel.contentView = view;
    [panel setFrame:frame display:NO];
    return panel;
}

#pragma mark - One display

@interface SBOverlaySurface : NSObject
@property (nonatomic, strong, nullable) NSPanel *panel;
@property (nonatomic, strong) CALayer *root;
@property (nonatomic, strong) NSMutableDictionary<NSString *, SBOverlayItemLayer *> *layers;
@property (nonatomic, copy) NSArray<SBDrawItem *> *items;
/// key -> signature of the ghost that layer last pointed at. A different ghost glides, the same one tracks exactly.
@property (nonatomic, strong) NSMutableDictionary<NSString *, NSString *> *targets;
@end

@implementation SBOverlaySurface

- (instancetype)initWithSize:(CGSize)size {
    if ((self = [super init])) {
        _root = [CALayer layer];
        _root.frame = CGRectMake(0, 0, size.width, size.height);
        _layers = [NSMutableDictionary dictionary];
        _targets = [NSMutableDictionary dictionary];
        _items = @[];
    }
    return self;
}

/// `fresh`: first paint after a hide (fade in place, never glide). `force`: repaint unchanged items too.
- (void)applyItems:(NSArray<SBDrawItem *> *)items fresh:(BOOL)fresh force:(BOOL)force reduceMotion:(BOOL)reduceMotion {
    SBOverlayDiff *diff = [SBOverlayDiff diffFromItems:self.items toItems:items];
    for (NSString *key in diff.removedKeys) {
        [self.layers[key] removeFromSuperlayer];
        [self.layers removeObjectForKey:key];
        [self.targets removeObjectForKey:key];
    }
    for (SBDrawItem *item in diff.added) {
        SBOverlayItemLayer *layer = [SBOverlayItemLayer layerForItem:item];
        self.layers[item.key] = layer;
        [self.root addSublayer:layer];
        [layer applyItem:item glide:NO reduceMotion:reduceMotion];
        if (!reduceMotion && !fresh) SBFadeIn(layer, 0.14);
        self.targets[item.key] = item.targetSignature;
    }
    NSArray<SBDrawItem *> *repaint = force ? [diff.changed arrayByAddingObjectsFromArray:diff.unchanged] : diff.changed;
    for (SBDrawItem *item in repaint) {
        NSString *before = self.targets[item.key];
        BOOL moved = before != nil && item.targetSignature != nil && ![before isEqualToString:item.targetSignature];
        [self.layers[item.key] applyItem:item glide:moved && !fresh && !reduceMotion reduceMotion:reduceMotion];
        self.targets[item.key] = item.targetSignature;
    }
    self.items = items;
    self.root.hidden = NO;
    if (fresh && !reduceMotion && items.count > 0) SBFadeIn(self.root, 0.12);
}

- (void)clear {
    for (CALayer *layer in self.layers.allValues) [layer removeFromSuperlayer];
    [self.layers removeAllObjects];
    [self.targets removeAllObjects];
    self.items = @[];
}

@end

#pragma mark - Overlay

@implementation SBOverlayWindow {
    NSMutableArray<SBOverlaySurface *> *_surfaces;
    SBOverlayModel *_lastModel;
    BOOL _fixedLayout;
    BOOL _hidden;
    BOOL _dead;
}

- (instancetype)init {
    if ((self = [super init])) {
        _surfaces = [NSMutableArray array];
        _hidden = YES;
        _layout = [SBScreenLayout currentLayout];
        [self rebuildSurfaces];
        [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(screensChanged:)
                                                   name:NSApplicationDidChangeScreenParametersNotification object:nil];
        [NSWorkspace.sharedWorkspace.notificationCenter addObserver:self selector:@selector(displayOptionsChanged:)
                                                               name:NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification
                                                             object:nil];
    }
    return self;
}

- (instancetype)initWithLayout:(SBScreenLayout *)layout {
    if ((self = [super init])) {
        _surfaces = [NSMutableArray array];
        _hidden = YES;
        _fixedLayout = YES;
        _offscreen = YES;
        _layout = layout;
        [self rebuildSurfaces];
    }
    return self;
}

- (void)dealloc {
    [NSNotificationCenter.defaultCenter removeObserver:self];
    [NSWorkspace.sharedWorkspace.notificationCenter removeObserver:self];
}

- (void)invalidate {
    _dead = YES;
    [NSNotificationCenter.defaultCenter removeObserver:self];
    [NSWorkspace.sharedWorkspace.notificationCenter removeObserver:self];
    for (SBOverlaySurface *surface in _surfaces) {
        [surface clear];
        [surface.panel close];
    }
    [_surfaces removeAllObjects];
    _lastModel = nil;
}

- (void)rebuildSurfaces {
    for (SBOverlaySurface *surface in _surfaces) [surface.panel close];
    [_surfaces removeAllObjects];
    for (NSUInteger i = 0; i < self.layout.count; i++) {
        CGRect frame = [self.layout frameAtIndex:i];
        SBOverlaySurface *surface = [[SBOverlaySurface alloc] initWithSize:frame.size];
        if (!_fixedLayout) surface.panel = SBMakeOverlayPanel(frame, surface.root, self.excludedFromCapture);
        [_surfaces addObject:surface];
    }
}

#pragma mark Rendering

- (void)render:(SBOverlayModel *)model {
    if (!NSThread.isMainThread) {
        dispatch_async(dispatch_get_main_queue(), ^{ [self render:model]; });
        return;
    }
    if (_dead) return;
    // Frames computed for another display arrangement would land in the wrong place: draw nothing instead.
    if (model.items.count > 0 && ![model.layoutFingerprint isEqualToString:self.layout.fingerprint]) {
        [self hideImmediately];
        return;
    }
    _lastModel = model;
    [self applyModel:model force:NO];
}

- (void)renderInput:(SBOverlayInput *)input {
    [self render:[SBOverlayModel modelWithInput:input layout:self.layout]];
}

- (void)applyModel:(SBOverlayModel *)model force:(BOOL)force {
    BOOL reduce = self.reduceMotion, fresh = _hidden;
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    for (NSUInteger i = 0; i < _surfaces.count; i++) {
        [_surfaces[i] applyItems:[model itemsForScreen:i] fresh:fresh force:force reduceMotion:reduce];
    }
    [CATransaction commit];
    for (SBOverlaySurface *surface in _surfaces) {
        if (self.offscreen || !surface.panel) continue;
        if (surface.items.count == 0) [surface.panel orderOut:nil];
        else if (!surface.panel.isVisible) [surface.panel orderFrontRegardless];
    }
    _hidden = model.items.count == 0;
}

- (void)hideImmediately {
    if (!NSThread.isMainThread) {
        dispatch_async(dispatch_get_main_queue(), ^{ [self hideImmediately]; });
        return;
    }
    if (_hidden) return;
    _hidden = YES;
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    for (SBOverlaySurface *surface in _surfaces) {
        [surface.root removeAllAnimations];
        surface.root.hidden = YES;
    }
    [CATransaction commit];
    [CATransaction flush];  // do not wait for the end of the run loop turn: the window under us is already moving
    for (SBOverlaySurface *surface in _surfaces) [surface.panel orderOut:nil];
}

#pragma mark Environment

- (BOOL)reduceMotion {
    if (self.reduceMotionOverride) return self.reduceMotionOverride.boolValue;
    return NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
}

- (void)setReduceMotionOverride:(NSNumber *)reduceMotionOverride {
    _reduceMotionOverride = reduceMotionOverride;
    [self displayOptionsChanged:nil];
}

- (void)setExcludedFromCapture:(BOOL)excludedFromCapture {
    _excludedFromCapture = excludedFromCapture;
    for (SBOverlaySurface *surface in _surfaces) {
        surface.panel.sharingType = excludedFromCapture ? NSWindowSharingNone : NSWindowSharingReadOnly;
    }
}

- (void)displayOptionsChanged:(NSNotification *)note {
    if (_dead || _hidden || !_lastModel) return;
    [self applyModel:_lastModel force:YES];  // starts or stops the float, the pulse and the glide
}

- (void)screensChanged:(NSNotification *)note {
    if (_dead || _fixedLayout) return;
    SBScreenLayout *now = [SBScreenLayout currentLayout];
    if ([now.fingerprint isEqualToString:self.layout.fingerprint]) return;
    [self hideImmediately];
    _layout = now;
    _lastModel = nil;
    [self rebuildSurfaces];
    if (self.onLayoutChange) self.onLayoutChange();
}

#pragma mark Introspection

- (BOOL)isVisible {
    for (SBOverlaySurface *surface in _surfaces) {
        if (surface.panel.isVisible) return YES;
    }
    return NO;
}

- (NSUInteger)panelCount { return _surfaces.count; }

- (NSPanel *)panelAtIndex:(NSUInteger)index {
    return index < _surfaces.count ? _surfaces[index].panel : nil;
}

- (CALayer *)rootLayerAtIndex:(NSUInteger)index {
    return index < _surfaces.count ? _surfaces[index].root : nil;
}

- (NSArray<NSString *> *)layerKeysAtIndex:(NSUInteger)index {
    if (index >= _surfaces.count) return @[];
    return [_surfaces[index].layers.allKeys sortedArrayUsingSelector:@selector(compare:)];
}

- (CALayer *)layerForKey:(NSString *)key atIndex:(NSUInteger)index {
    return index < _surfaces.count ? _surfaces[index].layers[key] : nil;
}

@end
