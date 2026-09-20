#import "SBOverlayDrawing.h"

const CFTimeInterval SBGlideDuration = 0.18;

CGColorRef SBColor(CGFloat r, CGFloat g, CGFloat b, CGFloat alpha) {
    // The palette is tiny, and a cached NSColor keeps its CGColor alive for callers that do not retain it.
    static NSMutableDictionary<NSString *, NSColor *> *cache;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ cache = [NSMutableDictionary dictionary]; });
    NSString *key = [NSString stringWithFormat:@"%.0f,%.0f,%.0f,%.3f", r, g, b, alpha];
    @synchronized(cache) {
        NSColor *color = cache[key];
        if (!color) {
            color = [NSColor colorWithSRGBRed:r / 255.0 green:g / 255.0 blue:b / 255.0 alpha:alpha];
            cache[key] = color;
        }
        return color.CGColor;
    }
}

CGColorRef SBAccent(BOOL locked, CGFloat alpha) {
    return locked ? SBColor(245, 165, 36, alpha) : SBColor(124, 92, 255, alpha);
}

CGColorRef SBGhostTextColor(void) { return SBColor(120, 120, 135, 0.75); }

CAMediaTimingFunction *SBGlideTiming(void) {
    return [CAMediaTimingFunction functionWithControlPoints:0.2f :0.8f :0.2f :1.0f];
}

static void SBAddGlide(CALayer *layer, NSString *keyPath, id from, id to) {
    CABasicAnimation *move = [CABasicAnimation animationWithKeyPath:keyPath];
    move.fromValue = from;
    move.toValue = to;
    move.duration = SBGlideDuration;
    move.timingFunction = SBGlideTiming();
    [layer addAnimation:move forKey:[@"ghost-glide-" stringByAppendingString:keyPath]];
}

void SBSetLayerFrame(CALayer *layer, CGRect frame, BOOL glide) {
    CALayer *shown = layer.presentationLayer ?: layer;
    CGPoint fromPosition = shown.position;
    CGRect fromBounds = shown.bounds;
    layer.frame = frame;
    if (!glide) {
        [layer removeAnimationForKey:@"ghost-glide-position"];
        [layer removeAnimationForKey:@"ghost-glide-bounds"];
        return;
    }
    if (!CGPointEqualToPoint(fromPosition, layer.position)) {
        SBAddGlide(layer, @"position", [NSValue valueWithPoint:fromPosition], [NSValue valueWithPoint:layer.position]);
    }
    if (!CGSizeEqualToSize(fromBounds.size, layer.bounds.size)) {
        SBAddGlide(layer, @"bounds", [NSValue valueWithRect:fromBounds], [NSValue valueWithRect:layer.bounds]);
    }
}

void SBFadeIn(CALayer *layer, CFTimeInterval duration) {
    CABasicAnimation *fade = [CABasicAnimation animationWithKeyPath:@"opacity"];
    fade.fromValue = @0;
    fade.toValue = @(layer.opacity);
    fade.duration = duration;
    fade.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseOut];
    [layer addAnimation:fade forKey:@"ghost-fade-in"];
}

id SBImageFromDrawing(CGSize size, CGFloat scale, void (NS_NOESCAPE ^ draw)(CGContextRef ctx)) {
    CGFloat s = scale > 0 ? scale : 1;
    size_t width = (size_t)ceil(size.width * s), height = (size_t)ceil(size.height * s);
    if (width == 0 || height == 0 || width > 16384 || height > 16384) return nil;
    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef ctx = CGBitmapContextCreate(NULL, width, height, 8, 0, space,
                                             (uint32_t)kCGImageAlphaPremultipliedFirst | (uint32_t)kCGBitmapByteOrder32Host);
    CGColorSpaceRelease(space);
    if (!ctx) return nil;
    CGContextScaleCTM(ctx, s, s);
    draw(ctx);
    CGImageRef image = CGBitmapContextCreateImage(ctx);
    CGContextRelease(ctx);
    return CFBridgingRelease(image);
}

void SBDrawShadowOnly(CGContextRef ctx, CGPathRef path, CGSize offset, CGFloat blur, CGColorRef color, CGFloat scale) {
    // The caster is painted far outside the bitmap; only its shadow, shifted back, lands inside.
    // Shadow offset and blur are in device pixels and ignore the CTM, hence the explicit scale.
    static const CGFloat kAway = 20000;
    CGContextSaveGState(ctx);
    CGContextSetShadowWithColor(ctx, CGSizeMake((offset.width - kAway) * scale, offset.height * scale), blur * scale, color);
    CGContextTranslateCTM(ctx, kAway, 0);
    CGContextAddPath(ctx, path);
    CGContextSetFillColorWithColor(ctx, SBColor(0, 0, 0, 1));
    CGContextFillPath(ctx);
    CGContextRestoreGState(ctx);
}

CATextLayer *SBMakeTextLayer(CGFloat scale) {
    CATextLayer *text = [CATextLayer layer];
    text.contentsScale = scale > 0 ? scale : 1;
    text.truncationMode = kCATruncationEnd;
    text.alignmentMode = kCAAlignmentLeft;
    text.wrapped = NO;
    text.anchorPoint = CGPointZero;
    return text;
}

void SBSetPlainText(CATextLayer *layer, NSString *text, NSFont *font, CGColorRef color) {
    layer.string = text;
    layer.font = (__bridge CFTypeRef)font;
    layer.fontSize = font.pointSize;
    layer.foregroundColor = color;
}

CGFloat SBLineHeight(NSFont *font) {
    return ceil(font.ascender - font.descender + font.leading);
}

CGSize SBTextSize(NSAttributedString *text) {
    CGSize size = text.size;
    return CGSizeMake(ceil(size.width), ceil(size.height));
}

NSAttributedString *SBAttributed(NSString *text, NSFont *font, CGColorRef color, CGFloat kern) {
    NSDictionary *attrs = @{
        NSFontAttributeName : font,
        NSForegroundColorAttributeName : [NSColor colorWithCGColor:color] ?: NSColor.grayColor,
        NSKernAttributeName : @(kern),
    };
    return [[NSAttributedString alloc] initWithString:text attributes:attrs];
}


#pragma mark - the guess marker

/// One accent. A guess is told apart by the DOTTED rule under the words, never by a second colour: two
/// palettes on screen at once was most of what made the overlay look busy.
CGColorRef SBGuessColor(CGFloat alpha) { return SBAccent(NO, alpha); }

CALayer *SBMakeGuessUnderline(CGFloat width, CGFloat scale) {
    CAShapeLayer *rule = [CAShapeLayer layer];
    rule.contentsScale = scale;
    rule.bounds = CGRectMake(0, 0, MAX(0, width), 2);
    rule.anchorPoint = CGPointZero;
    CGMutablePathRef path = CGPathCreateMutable();
    CGPathMoveToPoint(path, NULL, 0, 1);
    CGPathAddLineToPoint(path, NULL, MAX(0, width), 1);
    rule.path = path;
    CGPathRelease(path);
    rule.strokeColor = SBGuessColor(0.9);
    rule.fillColor = NULL;
    rule.lineWidth = 1.5;
    rule.lineCap = kCALineCapRound;
    rule.lineDashPattern = @[ @1.5, @2.5 ];
    return rule;
}
