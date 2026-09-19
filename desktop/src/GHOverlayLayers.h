// GHOverlayLayers: one Core Animation layer per draw item. The layers only paint what GHOverlayModel decided;
// they measure text (the model cannot) and hug their content inside the item's frame.
#import <QuartzCore/QuartzCore.h>
#import "GHOverlayModel.h"

NS_ASSUME_NONNULL_BEGIN

@interface GHOverlayItemLayer : CALayer
/// The right subclass for the item's kind, not yet configured.
+ (instancetype)layerForItem:(GHDrawItem *)item;
/// Applies geometry and content. Call inside a CATransaction with actions disabled.
/// `glide`: ease to the new place (the target changed) instead of tracking it exactly (scroll, relayout).
- (void)applyItem:(GHDrawItem *)item glide:(BOOL)glide reduceMotion:(BOOL)reduceMotion;
/// Stacking order inside a panel: HUD, ghost text and pills, ring, lock badge, keycap, cursor.
+ (CGFloat)zPositionForKind:(GHDrawKind)kind;
@end

@interface GHGhostTextLayer : GHOverlayItemLayer
@end
@interface GHPillLayer : GHOverlayItemLayer
@end
@interface GHRingLayer : GHOverlayItemLayer
@end
@interface GHCursorLayer : GHOverlayItemLayer
@end
@interface GHKeycapLayer : GHOverlayItemLayer
@end
@interface GHLockBadgeLayer : GHOverlayItemLayer
@end
@interface GHHudLayer : GHOverlayItemLayer   // the HUD pill and the error chip
@end

/// Frame of a content-sized layer inside the room the model gave it.
CGRect GHAnchoredFrame(CGRect room, CGSize content, GHDrawAnchor anchor, CGFloat scale);

NS_ASSUME_NONNULL_END
