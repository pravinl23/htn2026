#import "GHOverlayDrawing.h"

const CFTimeInterval GHGlideDuration = 0.18;
const CGSize GHKeycapSize = {32, 18};

CGColorRef GHColor(CGFloat r, CGFloat g, CGFloat b, CGFloat alpha) {
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

CGColorRef GHAccent(BOOL locked, CGFloat alpha) {
    return locked ? GHColor(245, 165, 36, alpha) : GHColor(124, 92, 255, alpha);
}

CGColorRef GHGhostTextColor(void) { return GHColor(120, 120, 135, 0.75); }

CAMediaTimingFunction *GHGlideTiming(void) {
    return [CAMediaTimingFunction functionWithControlPoints:0.2f :0.8f :0.2f :1.0f];
}

static void GHAddGlide(CALayer *layer, NSString *keyPath, id from, id to) {
    CABasicAnimation *move = [CABasicAnimation animationWithKeyPath:keyPath];
    move.fromValue = from;
    move.toValue = to;
    move.duration = GHGlideDuration;
    move.timingFunction = GHGlideTiming();
    [layer addAnimation:move forKey:[@"ghost-glide-" stringByAppendingString:keyPath]];
}

void GHSetLayerFrame(CALayer *layer, CGRect frame, BOOL glide) {
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
        GHAddGlide(layer, @"position", [NSValue valueWithPoint:fromPosition], [NSValue valueWithPoint:layer.position]);
    }
    if (!CGSizeEqualToSize(fromBounds.size, layer.bounds.size)) {
        GHAddGlide(layer, @"bounds", [NSValue valueWithRect:fromBounds], [NSValue valueWithRect:layer.bounds]);
    }
}

void GHFadeIn(CALayer *layer, CFTimeInterval duration) {
    CABasicAnimation *fade = [CABasicAnimation animationWithKeyPath:@"opacity"];
    fade.fromValue = @0;
    fade.toValue = @(layer.opacity);
    fade.duration = duration;
    fade.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseOut];
    [layer addAnimation:fade forKey:@"ghost-fade-in"];
}

id GHImageFromDrawing(CGSize size, CGFloat scale, void (NS_NOESCAPE ^ draw)(CGContextRef ctx)) {
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

void GHDrawShadowOnly(CGContextRef ctx, CGPathRef path, CGSize offset, CGFloat blur, CGColorRef color, CGFloat scale) {
    // The caster is painted far outside the bitmap; only its shadow, shifted back, lands inside.
    // Shadow offset and blur are in device pixels and ignore the CTM, hence the explicit scale.
    static const CGFloat kAway = 20000;
    CGContextSaveGState(ctx);
    CGContextSetShadowWithColor(ctx, CGSizeMake((offset.width - kAway) * scale, offset.height * scale), blur * scale, color);
    CGContextTranslateCTM(ctx, kAway, 0);
    CGContextAddPath(ctx, path);
    CGContextSetFillColorWithColor(ctx, GHColor(0, 0, 0, 1));
    CGContextFillPath(ctx);
    CGContextRestoreGState(ctx);
}

CATextLayer *GHMakeTextLayer(CGFloat scale) {
    CATextLayer *text = [CATextLayer layer];
    text.contentsScale = scale > 0 ? scale : 1;
    text.truncationMode = kCATruncationEnd;
    text.alignmentMode = kCAAlignmentLeft;
    text.wrapped = NO;
    text.anchorPoint = CGPointZero;
    return text;
}

void GHSetPlainText(CATextLayer *layer, NSString *text, NSFont *font, CGColorRef color) {
    layer.string = text;
    layer.font = (__bridge CFTypeRef)font;
    layer.fontSize = font.pointSize;
    layer.foregroundColor = color;
}

CGFloat GHLineHeight(NSFont *font) {
    return ceil(font.ascender - font.descender + font.leading);
}

CGSize GHTextSize(NSAttributedString *text) {
    CGSize size = text.size;
    return CGSizeMake(ceil(size.width), ceil(size.height));
}

NSAttributedString *GHAttributed(NSString *text, NSFont *font, CGColorRef color, CGFloat kern) {
    NSDictionary *attrs = @{
        NSFontAttributeName : font,
        NSForegroundColorAttributeName : [NSColor colorWithCGColor:color] ?: NSColor.grayColor,
        NSKernAttributeName : @(kern),
    };
    return [[NSAttributedString alloc] initWithString:text attributes:attrs];
}

CALayer *GHMakeKeycap(NSString *label, CGSize size, CGFloat scale) {
    CALayer *cap = [CALayer layer];
    cap.bounds = CGRectMake(0, 0, size.width, size.height);
    cap.anchorPoint = CGPointZero;
    cap.cornerRadius = 5;
    cap.backgroundColor = GHColor(205, 193, 255, 1);  // accent at .38 over the white face: the border
    cap.shadowColor = GHColor(24, 16, 64, 1);
    cap.shadowOpacity = 0.14f;
    cap.shadowRadius = 1;
    cap.shadowOffset = CGSizeMake(0, -1);
    CGPathRef outline = CGPathCreateWithRoundedRect(cap.bounds, 5, 5, NULL);
    cap.shadowPath = outline;
    CGPathRelease(outline);

    CAGradientLayer *face = [CAGradientLayer layer];
    face.frame = CGRectMake(1, 2, size.width - 2, size.height - 3);  // 1 pt border, 2 pt at the bottom
    face.cornerRadius = 4;
    face.colors = @[ (__bridge id)GHColor(255, 255, 255, 1), (__bridge id)GHColor(240, 237, 251, 1) ];
    face.startPoint = CGPointMake(0.5, 1);
    face.endPoint = CGPointMake(0.5, 0);
    [cap addSublayer:face];

    NSFont *font = [NSFont systemFontOfSize:10 weight:NSFontWeightSemibold];
    NSAttributedString *text = GHAttributed(label, font, GHColor(74, 58, 150, 0.95), 0.3);
    CGSize textSize = GHTextSize(text);
    CATextLayer *title = GHMakeTextLayer(scale);
    title.string = text;
    CGFloat lineHeight = GHLineHeight(font);
    CGFloat x = round((size.width - textSize.width) / 2 * scale) / scale;
    CGFloat y = round((2 + (size.height - 3 - lineHeight) / 2) * scale) / scale;
    title.frame = CGRectMake(x, y, textSize.width + 1, lineHeight);
    [cap addSublayer:title];
    return cap;
}
