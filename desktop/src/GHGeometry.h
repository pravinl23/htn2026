// GHGeometry: pure coordinate math for the overlay. No AX, no windows.
//
// Two global spaces meet here:
//   AX / Quartz: origin at the TOP-left of the primary display, y grows downward (AXPosition, CGDisplayBounds).
//   AppKit:      origin at the BOTTOM-left of the primary display, y grows upward (NSScreen.frame, NSWindow.frame).
// Both are in points, so a display's scale factor only matters for snapping to its pixel grid.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

NS_ASSUME_NONNULL_BEGIN

/// A field is drawn (and Tab is consumed) only when at least this much of it is inside the window and a screen.
extern const CGFloat GHVisibleEnoughFraction;

/// Finite numbers and a positive size. AX reports NaN, zero and negative sizes for collapsed elements.
BOOL GHRectIsUsable(CGRect rect);
CGFloat GHRectArea(CGRect rect);
/// Flips a rect between the AX and the AppKit global space. Its own inverse.
CGRect GHRectFlip(CGRect rect, CGFloat primaryHeight);
/// Snaps the edges to the pixel grid of a display with this scale factor (edges, not size, so neighbours still touch).
CGRect GHRectPixelAligned(CGRect rect, CGFloat scale);
/// Intersection that is CGRectNull-safe: a null `clip` means "no clip known" and leaves the rect alone.
CGRect GHRectClipped(CGRect rect, CGRect clip);
/// Share of `field` that lies inside both `window` (CGRectNull = unknown) and `screen`. 0 for unusable rects.
CGFloat GHVisibleFraction(CGRect field, CGRect window, CGRect screen);

/// The arrangement of displays, captured as plain numbers so every conversion is testable.
@interface GHScreenLayout : NSObject

/// `frames`: NSScreen.frame of every display (NSValue of CGRect/NSRect), primary display FIRST.
/// `scales`: backing scale factors, same order; nil or short means 1.
/// `visibleFrames`: NSScreen.visibleFrame (without menu bar and Dock), same order; nil means the full frame.
- (instancetype)initWithFrames:(NSArray<NSValue *> *)frames
                        scales:(nullable NSArray<NSNumber *> *)scales
                 visibleFrames:(nullable NSArray<NSValue *> *)visibleFrames NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

+ (instancetype)layoutWithFrames:(NSArray<NSValue *> *)frames scales:(nullable NSArray<NSNumber *> *)scales;
/// From NSScreen.screens. Main thread only.
+ (instancetype)currentLayout;

@property (nonatomic, readonly) NSUInteger count;
/// Height of the primary display: the hinge of every flip.
@property (nonatomic, readonly) CGFloat primaryHeight;
/// Changes whenever the arrangement, a resolution or a scale factor changes.
@property (nonatomic, readonly) NSString *fingerprint;

- (CGRect)frameAtIndex:(NSUInteger)index;         // AppKit global
- (CGRect)visibleFrameAtIndex:(NSUInteger)index;  // AppKit global
- (CGRect)axFrameAtIndex:(NSUInteger)index;       // AX global
- (CGFloat)scaleAtIndex:(NSUInteger)index;

- (CGRect)appKitRectFromAXRect:(CGRect)axRect;
- (CGRect)axRectFromAppKitRect:(CGRect)appKitRect;

/// The display showing most of the rect; NSNotFound when it touches none.
- (NSUInteger)screenIndexForAXRect:(CGRect)axRect;
/// AX global rect -> coordinates of the overlay panel that covers display `index` (bottom-left origin), pixel aligned.
- (CGRect)localRectFromAXRect:(CGRect)axRect screen:(NSUInteger)index;
- (CGPoint)localPointFromAXPoint:(CGPoint)axPoint screen:(NSUInteger)index;

/// The part of the rect a person can see: inside the window (CGRectNull = unknown) and display `index`. AX space.
- (CGRect)visiblePartOfAXRect:(CGRect)axRect inWindow:(CGRect)windowAXFrame screen:(NSUInteger)index;
/// Visible share on the best display.
- (CGFloat)visibleFractionOfAXRect:(CGRect)axRect inWindow:(CGRect)windowAXFrame;
- (BOOL)isAXRectVisibleEnough:(CGRect)axRect inWindow:(CGRect)windowAXFrame;

@end

NS_ASSUME_NONNULL_END
