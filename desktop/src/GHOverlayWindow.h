// GHOverlayWindow: the glass Ghost draws on. One borderless, transparent, click-through, non-activating panel per
// display, just below the screen saver level, on every Space and over full-screen apps. It never takes focus, never
// receives events and draws only with Core Animation layers. Main thread only.
//
//   GHOverlayModel *model = [GHOverlayModel modelWithInput:input layout:overlay.layout];
//   [overlay render:model];        // idempotent: call it on every state change, scroll and relayout
//   [overlay hideImmediately];     // app or window switch, window drag, scroll start
#import <AppKit/AppKit.h>
#import "GHOverlayModel.h"

NS_ASSUME_NONNULL_BEGIN

@interface GHOverlayWindow : NSObject

/// The display arrangement the panels were built for. Build models against THIS layout.
@property (nonatomic, readonly) GHScreenLayout *layout;
/// Called after displays were added, removed, rearranged or changed scale. The overlay is already hidden and
/// `layout` is new: rects must be re-queried and rendered again.
@property (nonatomic, copy, nullable) void (^onLayoutChange)(void);
/// YES keeps the overlay out of screenshots and recordings (NSWindowSharingNone). Default NO so demos can be filmed.
@property (nonatomic) BOOL excludedFromCapture;
/// System setting "Reduce motion", or the override below. No glide, no float, no pulse.
@property (nonatomic, readonly) BOOL reduceMotion;
@property (nonatomic, strong, nullable) NSNumber *reduceMotionOverride;
/// True while at least one panel is on screen.
@property (nonatomic, readonly, getter=isVisible) BOOL visible;
/// Off-screen mode for tests and the demo harness: layers are built but no panel is ever ordered in.
@property (nonatomic) BOOL offscreen;

- (instancetype)init;
/// For tests: fixed layout, no NSScreen, implies `offscreen`.
- (instancetype)initWithLayout:(GHScreenLayout *)layout;

/// Diffs against what is on screen and touches only the layers that changed. A model built for another display
/// arrangement is refused (the overlay hides): its frames would be wrong.
- (void)render:(GHOverlayModel *)model;
/// Builds the model against the current layout and remembers the input, so a display change redraws by itself.
- (void)renderInput:(GHOverlayInput *)input;
/// Everything disappears in this frame, with no fade. The next render fades in place and does not glide.
- (void)hideImmediately;
/// Closes the panels and stops observing. The object is dead afterwards.
- (void)invalidate;

@property (nonatomic, readonly) NSUInteger panelCount;
- (nullable NSPanel *)panelAtIndex:(NSUInteger)index;
- (nullable CALayer *)rootLayerAtIndex:(NSUInteger)index;
/// Keys of the layers alive on a display, for tests of layer reuse.
- (NSArray<NSString *> *)layerKeysAtIndex:(NSUInteger)index;
- (nullable CALayer *)layerForKey:(NSString *)key atIndex:(NSUInteger)index;

@end

NS_ASSUME_NONNULL_END
