// SBOverlayLayers: one Core Animation layer per draw item. The layers only paint what SBOverlayModel decided;
// they measure text (the model cannot) and hug their content inside the item's frame.
#import <QuartzCore/QuartzCore.h>
#import "SBOverlayModel.h"

NS_ASSUME_NONNULL_BEGIN

@interface SBOverlayItemLayer : CALayer
/// The right subclass for the item's kind, not yet configured.
+ (instancetype)layerForItem:(SBDrawItem *)item;
/// Applies geometry and content. Call inside a CATransaction with actions disabled.
/// `glide`: ease to the new place (the target changed) instead of tracking it exactly (scroll, relayout).
- (void)applyItem:(SBDrawItem *)item glide:(BOOL)glide reduceMotion:(BOOL)reduceMotion;
/// Stacking order inside a panel: HUD, ghost text and pills, ring, lock badge, keycap, cursor.
+ (CGFloat)zPositionForKind:(SBDrawKind)kind;
@end

@interface SBGhostTextLayer : SBOverlayItemLayer
@end
@interface SBPillLayer : SBOverlayItemLayer
@end
@interface SBRingLayer : SBOverlayItemLayer
@end
@interface SBCursorLayer : SBOverlayItemLayer
@end
@interface SBKeycapLayer : SBOverlayItemLayer
@end
@interface SBLockBadgeLayer : SBOverlayItemLayer
@end
@interface SBHudLayer : SBOverlayItemLayer   // the HUD pill and the error chip
@end

/// Frame of a content-sized layer inside the room the model gave it.
CGRect SBAnchoredFrame(CGRect room, CGSize content, SBDrawAnchor anchor, CGFloat scale);

NS_ASSUME_NONNULL_END
