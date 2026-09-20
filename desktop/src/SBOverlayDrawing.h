// SBOverlayDrawing: small Core Animation / Core Graphics helpers shared by the overlay layers.
// Colors mirror extension/src/content/overlay-style.ts (purple accent 124 92 255, amber lock 245 165 36).
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>

NS_ASSUME_NONNULL_BEGIN

extern const CFTimeInterval SBGlideDuration;  // 180 ms

/// sRGB color from 0...255 channels.
CGColorRef SBColor(CGFloat r, CGFloat g, CGFloat b, CGFloat alpha) CF_RETURNS_NOT_RETAINED;
/// Purple accent, or the amber lock color for a locked target.
CGColorRef SBAccent(BOOL locked, CGFloat alpha) CF_RETURNS_NOT_RETAINED;
CGColorRef SBGhostTextColor(void) CF_RETURNS_NOT_RETAINED;

/// cubic-bezier(.2,.8,.2,1), the extension's glide curve.
CAMediaTimingFunction *SBGlideTiming(void);

/// Sets the frame. With `glide` the layer eases there from wherever it is on screen right now.
void SBSetLayerFrame(CALayer *layer, CGRect frame, BOOL glide);
/// Quick fade from transparent, used on first appearance.
void SBFadeIn(CALayer *layer, CFTimeInterval duration);

/// A CGImage (as `id`, ready for CALayer.contents) drawn at `scale` in a bottom-left, point-sized context.
id _Nullable SBImageFromDrawing(CGSize size, CGFloat scale, void (NS_NOESCAPE ^ draw)(CGContextRef ctx));
/// Draws only the shadow of `path` (the CSS box-shadow / drop-shadow recipe): offset and blur in points.
void SBDrawShadowOnly(CGContextRef ctx, CGPathRef path, CGSize offset, CGFloat blur, CGColorRef color, CGFloat scale);

CATextLayer *SBMakeTextLayer(CGFloat scale);
/// Plain string + font properties. Anything that may be truncated must go through here: CATextLayer lays out a
/// truncated ATTRIBUTED string one line too high and clips it away (seen on macOS 26).
void SBSetPlainText(CATextLayer *layer, NSString *text, NSFont *font, CGColorRef color);
/// Line box height of a font, rounded up to whole points.
CGFloat SBLineHeight(NSFont *font);
CGSize SBTextSize(NSAttributedString *text);
NSAttributedString *SBAttributed(NSString *text, NSFont *font, CGColorRef color, CGFloat kern);

/// The little "Tab" keycap: light gradient face, accent border that is thicker at the bottom.
CALayer *SBMakeKeycap(NSString *label, CGSize size, CGFloat scale);
extern const CGSize SBKeycapSize;

// ---------- the guess marker (docs/answers.md: a guess is always visibly a guess) ----------
/// Amber, the colour Shabang already uses for "this needs your eyes".
CGColorRef SBGuessColor(CGFloat alpha) CF_RETURNS_NOT_RETAINED;
/// A dotted amber rule under ghost text, `width` points wide, sitting at y = 0 of its parent.
CALayer *SBMakeGuessUnderline(CGFloat width, CGFloat scale);
/// The little "guess" chip that follows a pill's label.

NS_ASSUME_NONNULL_END
