// GHOverlayDrawing: small Core Animation / Core Graphics helpers shared by the overlay layers.
// Colors mirror extension/src/content/overlay-style.ts (purple accent 124 92 255, amber lock 245 165 36).
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>

NS_ASSUME_NONNULL_BEGIN

extern const CFTimeInterval GHGlideDuration;  // 180 ms

/// sRGB color from 0...255 channels.
CGColorRef GHColor(CGFloat r, CGFloat g, CGFloat b, CGFloat alpha) CF_RETURNS_NOT_RETAINED;
/// Purple accent, or the amber lock color for a locked target.
CGColorRef GHAccent(BOOL locked, CGFloat alpha) CF_RETURNS_NOT_RETAINED;
CGColorRef GHGhostTextColor(void) CF_RETURNS_NOT_RETAINED;

/// cubic-bezier(.2,.8,.2,1), the extension's glide curve.
CAMediaTimingFunction *GHGlideTiming(void);

/// Sets the frame. With `glide` the layer eases there from wherever it is on screen right now.
void GHSetLayerFrame(CALayer *layer, CGRect frame, BOOL glide);
/// Quick fade from transparent, used on first appearance.
void GHFadeIn(CALayer *layer, CFTimeInterval duration);

/// A CGImage (as `id`, ready for CALayer.contents) drawn at `scale` in a bottom-left, point-sized context.
id _Nullable GHImageFromDrawing(CGSize size, CGFloat scale, void (NS_NOESCAPE ^ draw)(CGContextRef ctx));
/// Draws only the shadow of `path` (the CSS box-shadow / drop-shadow recipe): offset and blur in points.
void GHDrawShadowOnly(CGContextRef ctx, CGPathRef path, CGSize offset, CGFloat blur, CGColorRef color, CGFloat scale);

CATextLayer *GHMakeTextLayer(CGFloat scale);
/// Plain string + font properties. Anything that may be truncated must go through here: CATextLayer lays out a
/// truncated ATTRIBUTED string one line too high and clips it away (seen on macOS 26).
void GHSetPlainText(CATextLayer *layer, NSString *text, NSFont *font, CGColorRef color);
/// Line box height of a font, rounded up to whole points.
CGFloat GHLineHeight(NSFont *font);
CGSize GHTextSize(NSAttributedString *text);
NSAttributedString *GHAttributed(NSString *text, NSFont *font, CGColorRef color, CGFloat kern);

/// The little "Tab" keycap: light gradient face, accent border that is thicker at the bottom.
CALayer *GHMakeKeycap(NSString *label, CGSize size, CGFloat scale);
extern const CGSize GHKeycapSize;

NS_ASSUME_NONNULL_END
