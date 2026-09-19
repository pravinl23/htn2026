#import "GHGeometry.h"
#import <AppKit/AppKit.h>

const CGFloat GHVisibleEnoughFraction = 0.6;

BOOL GHRectIsUsable(CGRect rect) {
    if (CGRectIsNull(rect) || CGRectIsInfinite(rect)) return NO;
    if (!isfinite(rect.origin.x) || !isfinite(rect.origin.y)) return NO;
    if (!isfinite(rect.size.width) || !isfinite(rect.size.height)) return NO;
    return rect.size.width > 0 && rect.size.height > 0;
}

CGFloat GHRectArea(CGRect rect) {
    return GHRectIsUsable(rect) ? rect.size.width * rect.size.height : 0;
}

CGRect GHRectFlip(CGRect rect, CGFloat primaryHeight) {
    return CGRectMake(rect.origin.x, primaryHeight - rect.origin.y - rect.size.height, rect.size.width, rect.size.height);
}

CGRect GHRectPixelAligned(CGRect rect, CGFloat scale) {
    CGFloat s = scale > 0 ? scale : 1;
    CGFloat minX = round(CGRectGetMinX(rect) * s) / s;
    CGFloat minY = round(CGRectGetMinY(rect) * s) / s;
    CGFloat maxX = round(CGRectGetMaxX(rect) * s) / s;
    CGFloat maxY = round(CGRectGetMaxY(rect) * s) / s;
    return CGRectMake(minX, minY, maxX - minX, maxY - minY);
}

CGRect GHRectClipped(CGRect rect, CGRect clip) {
    if (CGRectIsNull(clip)) return rect;
    return CGRectIntersection(rect, clip);
}

CGFloat GHVisibleFraction(CGRect field, CGRect window, CGRect screen) {
    CGFloat whole = GHRectArea(field);
    if (whole <= 0) return 0;
    CGRect seen = CGRectIntersection(GHRectClipped(field, window), screen);
    return GHRectArea(seen) / whole;
}

@implementation GHScreenLayout {
    NSArray<NSValue *> *_frames;
    NSArray<NSValue *> *_visibleFrames;
    NSArray<NSNumber *> *_scales;
}

- (instancetype)initWithFrames:(NSArray<NSValue *> *)frames
                        scales:(NSArray<NSNumber *> *)scales
                 visibleFrames:(NSArray<NSValue *> *)visibleFrames {
    if ((self = [super init])) {
        _frames = [frames copy];
        NSMutableArray<NSNumber *> *cleanScales = [NSMutableArray array];
        NSMutableArray<NSValue *> *cleanVisible = [NSMutableArray array];
        for (NSUInteger i = 0; i < frames.count; i++) {
            CGFloat scale = i < scales.count ? scales[i].doubleValue : 1;
            [cleanScales addObject:@(scale > 0 ? scale : 1)];
            CGRect frame = frames[i].rectValue;
            CGRect visible = i < visibleFrames.count ? visibleFrames[i].rectValue : frame;
            // A visible frame that is not inside its display is a caller bug; the full frame is always safe.
            [cleanVisible addObject:[NSValue valueWithRect:CGRectContainsRect(frame, visible) ? visible : frame]];
        }
        _scales = cleanScales;
        _visibleFrames = cleanVisible;
    }
    return self;
}

+ (instancetype)layoutWithFrames:(NSArray<NSValue *> *)frames scales:(NSArray<NSNumber *> *)scales {
    return [[self alloc] initWithFrames:frames scales:scales visibleFrames:nil];
}

+ (instancetype)currentLayout {
    NSMutableArray<NSValue *> *frames = [NSMutableArray array];
    NSMutableArray<NSValue *> *visible = [NSMutableArray array];
    NSMutableArray<NSNumber *> *scales = [NSMutableArray array];
    for (NSScreen *screen in NSScreen.screens) {  // screens[0] is always the primary display
        [frames addObject:[NSValue valueWithRect:screen.frame]];
        [visible addObject:[NSValue valueWithRect:screen.visibleFrame]];
        [scales addObject:@(screen.backingScaleFactor)];
    }
    return [[self alloc] initWithFrames:frames scales:scales visibleFrames:visible];
}

- (NSUInteger)count { return _frames.count; }

- (CGFloat)primaryHeight {
    return _frames.count > 0 ? _frames[0].rectValue.size.height : 0;
}

- (NSString *)fingerprint {
    NSMutableString *out = [NSMutableString string];
    for (NSUInteger i = 0; i < _frames.count; i++) {
        CGRect f = _frames[i].rectValue, v = _visibleFrames[i].rectValue;
        [out appendFormat:@"%.1f,%.1f,%.1f,%.1f@%.2f/%.1f,%.1f,%.1f,%.1f;", f.origin.x, f.origin.y, f.size.width,
                          f.size.height, _scales[i].doubleValue, v.origin.x, v.origin.y, v.size.width, v.size.height];
    }
    return out;
}

- (CGRect)frameAtIndex:(NSUInteger)index {
    return index < _frames.count ? _frames[index].rectValue : CGRectNull;
}

- (CGRect)visibleFrameAtIndex:(NSUInteger)index {
    return index < _visibleFrames.count ? _visibleFrames[index].rectValue : CGRectNull;
}

- (CGRect)axFrameAtIndex:(NSUInteger)index {
    return index < _frames.count ? GHRectFlip(_frames[index].rectValue, self.primaryHeight) : CGRectNull;
}

- (CGFloat)scaleAtIndex:(NSUInteger)index {
    return index < _scales.count ? _scales[index].doubleValue : 1;
}

- (CGRect)appKitRectFromAXRect:(CGRect)axRect { return GHRectFlip(axRect, self.primaryHeight); }
- (CGRect)axRectFromAppKitRect:(CGRect)appKitRect { return GHRectFlip(appKitRect, self.primaryHeight); }

- (NSUInteger)screenIndexForAXRect:(CGRect)axRect {
    if (!GHRectIsUsable(axRect)) return NSNotFound;
    NSUInteger best = NSNotFound;
    CGFloat bestArea = 0;
    for (NSUInteger i = 0; i < _frames.count; i++) {
        CGFloat area = GHRectArea(CGRectIntersection(axRect, [self axFrameAtIndex:i]));
        if (area > bestArea) {
            bestArea = area;
            best = i;
        }
    }
    return best;
}

- (CGRect)localRectFromAXRect:(CGRect)axRect screen:(NSUInteger)index {
    if (index >= _frames.count) return CGRectNull;
    CGRect global = [self appKitRectFromAXRect:axRect];
    CGRect frame = _frames[index].rectValue;
    CGRect local = CGRectOffset(global, -frame.origin.x, -frame.origin.y);
    return GHRectPixelAligned(local, [self scaleAtIndex:index]);
}

- (CGPoint)localPointFromAXPoint:(CGPoint)axPoint screen:(NSUInteger)index {
    if (index >= _frames.count) return CGPointZero;
    CGRect frame = _frames[index].rectValue;
    return CGPointMake(axPoint.x - frame.origin.x, self.primaryHeight - axPoint.y - frame.origin.y);
}

- (CGRect)visiblePartOfAXRect:(CGRect)axRect inWindow:(CGRect)windowAXFrame screen:(NSUInteger)index {
    if (index >= _frames.count || !GHRectIsUsable(axRect)) return CGRectNull;
    return CGRectIntersection(GHRectClipped(axRect, windowAXFrame), [self axFrameAtIndex:index]);
}

- (CGFloat)visibleFractionOfAXRect:(CGRect)axRect inWindow:(CGRect)windowAXFrame {
    NSUInteger index = [self screenIndexForAXRect:axRect];
    if (index == NSNotFound) return 0;
    return GHVisibleFraction(axRect, windowAXFrame, [self axFrameAtIndex:index]);
}

- (BOOL)isAXRectVisibleEnough:(CGRect)axRect inWindow:(CGRect)windowAXFrame {
    return [self visibleFractionOfAXRect:axRect inWindow:windowAXFrame] >= GHVisibleEnoughFraction;
}

@end
