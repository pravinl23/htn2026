#import "SBOverlayLayers.h"
#import "SBOverlayDrawing.h"

static CGFloat SBSnap(CGFloat value, CGFloat scale) {
    CGFloat s = scale > 0 ? scale : 1;
    return round(value * s) / s;
}

CGRect SBAnchoredFrame(CGRect room, CGSize content, SBDrawAnchor anchor, CGFloat scale) {
    if (anchor == SBDrawAnchorFill) return room;
    CGFloat width = MIN(content.width, room.size.width), height = content.height;
    CGFloat x = CGRectGetMinX(room), y = CGRectGetMidY(room) - height / 2;
    if (anchor == SBDrawAnchorRightCenter || anchor == SBDrawAnchorBottomRight) x = CGRectGetMaxX(room) - width;
    if (anchor == SBDrawAnchorTopLeft) y = CGRectGetMaxY(room) - height;
    if (anchor == SBDrawAnchorBottomRight) y = CGRectGetMinY(room);
    return CGRectMake(SBSnap(x, scale), SBSnap(y, scale), ceil(width), height);
}

@implementation SBOverlayItemLayer

+ (instancetype)layerForItem:(SBDrawItem *)item {
    Class cls = SBOverlayItemLayer.class;
    switch (item.kind) {
        case SBDrawKindGhostText: cls = SBGhostTextLayer.class; break;
        case SBDrawKindPill: cls = SBPillLayer.class; break;
        case SBDrawKindRing: cls = SBRingLayer.class; break;
        case SBDrawKindCursor: cls = SBCursorLayer.class; break;
        case SBDrawKindHUD:
        case SBDrawKindHUDError:
        case SBDrawKindHUDStatus: cls = SBHudLayer.class; break;
    }
    SBOverlayItemLayer *layer = [cls layer];
    layer.zPosition = [self zPositionForKind:item.kind];
    return layer;
}

+ (CGFloat)zPositionForKind:(SBDrawKind)kind {
    switch (kind) {
        case SBDrawKindHUD:
        case SBDrawKindHUDError:
        case SBDrawKindHUDStatus: return 0;
        case SBDrawKindGhostText:
        case SBDrawKindPill: return 1;
        case SBDrawKindRing: return 2;
        case SBDrawKindCursor: return 5;
    }
    return 0;
}

- (void)applyItem:(SBDrawItem *)item glide:(BOOL)glide reduceMotion:(BOOL)reduceMotion {
    SBSetLayerFrame(self, item.frame, glide);
}

@end

#pragma mark - Shabang text

@implementation SBGhostTextLayer {
    CATextLayer *_label;
    CALayer *_guess;
}

- (void)applyItem:(SBDrawItem *)item glide:(BOOL)glide reduceMotion:(BOOL)reduceMotion {
    // The layer is the visible part of the field and clips; the label is laid out against the whole field.
    self.masksToBounds = YES;
    SBSetLayerFrame(self, item.clipRect, NO);
    self.opacity = item.current ? 1.0f : 0.62f;
    if (!_label) {
        _label = SBMakeTextLayer(item.scale);
        [self addSublayer:_label];
    }
    _label.contentsScale = item.scale;
    _label.wrapped = item.multiline;

    NSFont *font = [NSFont systemFontOfSize:item.fontSize];
    NSString *shown = item.text ?: @"";
    if (!item.multiline) shown = [[shown componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet] componentsJoinedByString:@" "];
    NSAttributedString *text = SBAttributed(shown, font, SBGhostTextColor(), 0);  // for measuring only
    SBSetPlainText(_label, shown, font, SBGhostTextColor());

    CGFloat dx = item.frame.origin.x - item.clipRect.origin.x, dy = item.frame.origin.y - item.clipRect.origin.y;
    CGFloat width = MAX(0, item.frame.size.width - item.padLeft - item.padRight);
    CGFloat height = item.frame.size.height;
    if (item.multiline) {
        static const CGFloat kTop = 7, kBottom = 4;
        // Whole lines only: a line cut in half at the bottom edge reads as a rendering bug, even under the fade.
        CGFloat line = SBLineHeight(font), available = MAX(0, height - kTop - kBottom);
        CGFloat room = available >= line ? floor(available / line) * line : available;
        _label.frame = CGRectMake(dx + item.padLeft, SBSnap(dy + height - kTop - room, item.scale), width, room);
        CGRect needed = [text boundingRectWithSize:CGSizeMake(width, CGFLOAT_MAX)
                                           options:NSStringDrawingUsesLineFragmentOrigin | NSStringDrawingUsesFontLeading];
        _label.mask = needed.size.height > room ? [self fadeMaskForBounds:_label.bounds] : nil;
    } else {
        CGFloat line = SBLineHeight(font);
        CGFloat y = SBSnap(dy + (height - line) / 2, item.scale);
        _label.frame = CGRectMake(dx + item.padLeft, y, width, line);
        _label.mask = nil;
    }
    [self markGuess:item font:font shown:shown];
    [self pulse:item.streaming && !reduceMotion];
}

/// A guess is always visibly a guess (docs/answers.md section 3): a dotted amber rule under the words, as
/// wide as the text itself so it reads as "check this", not as a spelling error on the whole field.
- (void)markGuess:(SBDrawItem *)item font:(NSFont *)font shown:(NSString *)shown {
    [_guess removeFromSuperlayer];
    _guess = nil;
    if (!item.guess || shown.length == 0) return;
    CGFloat textWidth = MIN(SBTextSize(SBAttributed(shown, font, SBGhostTextColor(), 0)).width, _label.frame.size.width);
    if (textWidth <= 1) return;
    _guess = SBMakeGuessUnderline(textWidth, item.scale);
    _guess.position = CGPointMake(_label.frame.origin.x, MAX(0, _label.frame.origin.y - 2));
    [self addSublayer:_guess];
}

/// Text that does not fit a text area fades out toward the bottom instead of being cut mid-line.
- (CALayer *)fadeMaskForBounds:(CGRect)bounds {
    CAGradientLayer *fade = [CAGradientLayer layer];
    fade.frame = bounds;
    fade.colors = @[ (__bridge id)SBColor(0, 0, 0, 0), (__bridge id)SBColor(0, 0, 0, 1) ];
    fade.startPoint = CGPointMake(0.5, 0);
    fade.endPoint = CGPointMake(0.5, MIN(1, 26 / MAX(bounds.size.height, 1)));
    return fade;
}

- (void)pulse:(BOOL)on {
    static NSString *const kKey = @"ghost-stream";
    if (!on) {
        [_label removeAnimationForKey:kKey];
    } else if (![_label animationForKey:kKey]) {
        CABasicAnimation *pulse = [CABasicAnimation animationWithKeyPath:@"opacity"];
        pulse.fromValue = @1;
        pulse.toValue = @0.55;
        pulse.duration = 0.55;
        pulse.autoreverses = YES;
        pulse.repeatCount = HUGE_VALF;
        pulse.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseInEaseOut];
        [_label addAnimation:pulse forKey:kKey];
    }
}

@end

#pragma mark - Pill (selects, radios, checkboxes)

@implementation SBPillLayer {
    CATextLayer *_label;
    CALayer *_guess;
}

- (void)applyItem:(SBDrawItem *)item glide:(BOOL)glide reduceMotion:(BOOL)reduceMotion {
    static const CGFloat kHeight = 22, kPad = 9;
    NSFont *font = [NSFont systemFontOfSize:item.fontSize weight:NSFontWeightMedium];
    CGColorRef ink = SBColor(88, 86, 104, item.streaming ? 0.7 : 0.95);
    NSAttributedString *text = SBAttributed(item.text ?: @"", font, ink, 0);  // for measuring only
    // No chips. A pill carried a "guess" pill and a key cap inside it, which was two widgets of
    // furniture around three words -- and the cap had become a lie besides, since Tab is not the accept
    // key outside a form. What a ghost has to say it says with the ring: solid means take it, dashed means
    // Shabang is guessing (docs/answers.md section 3 -- a guess is still always visibly a guess).
    CGFloat tail = kPad;
    CGFloat labelWidth = MIN(SBTextSize(text).width + 1, MAX(0, item.frame.size.width - kPad - tail));
    CGRect frame = SBAnchoredFrame(item.frame, CGSizeMake(kPad + labelWidth + tail, kHeight), item.anchor, item.scale);
    SBSetLayerFrame(self, frame, NO);

    self.cornerRadius = kHeight / 2;
    self.backgroundColor = SBColor(245, 244, 251, 1);
    self.borderWidth = 1;
    // The ring says everything the chips used to: purple means take it, amber means Shabang is guessing
    // (docs/answers.md section 3 -- a guess is still always visibly a guess, with nothing added to the
    // screen to say so).
    self.borderColor = item.current ? SBAccent(NO, 0.45) : SBColor(120, 120, 135, 0.3);
    self.shadowColor = item.current ? SBAccent(NO, 1) : SBColor(24, 16, 64, 1);
    self.shadowOpacity = item.current ? 0.45f : 0.08f;
    self.shadowRadius = item.current ? 6 : 1;
    self.shadowOffset = CGSizeMake(0, item.current ? -3 : -1);
    CGFloat inset = item.current ? 5 : 0;  // the CSS glow has a negative spread
    CGPathRef caster = CGPathCreateWithRoundedRect(CGRectInset(self.bounds, inset, inset), kHeight / 2 - inset, kHeight / 2 - inset, NULL);
    self.shadowPath = caster;
    CGPathRelease(caster);

    if (!_label) {
        _label = SBMakeTextLayer(item.scale);
        [self addSublayer:_label];
    }
    _label.contentsScale = item.scale;
    SBSetPlainText(_label, item.text ?: @"", font, ink);
    CGFloat line = SBLineHeight(font);
    _label.frame = CGRectMake(kPad, SBSnap((kHeight - line) / 2, item.scale), labelWidth, line);

    [_guess removeFromSuperlayer];
    _guess = nil;
}

@end

#pragma mark - Highlight ring

/// CSS: box-shadow 0 0 0 1.5px accent/.72, 0 0 0 5px accent/.16, 0 8px 26px -8px accent/.5. Nothing paints inside the box.
@implementation SBRingLayer {
    CALayer *_glow, *_halo, *_line;
    NSString *_glowKey;
}

static const CGFloat kGlowMargin = 44;

- (void)applyItem:(SBDrawItem *)item glide:(BOOL)glide reduceMotion:(BOOL)reduceMotion {
    if (!_line) {
        _glow = [CALayer layer];
        _halo = [CALayer layer];
        _line = [CALayer layer];
        for (CALayer *part in @[ _glow, _halo, _line ]) [self addSublayer:part];
    }
    SBSetLayerFrame(self, item.frame, glide);
    CGRect box = CGRectMake(0, 0, item.frame.size.width, item.frame.size.height);
    CGFloat radius = item.cornerRadius;

    SBSetLayerFrame(_line, CGRectInset(box, -1.5, -1.5), glide);
    _line.borderWidth = 1.5;
    _line.cornerRadius = radius + 1.5;
    _line.borderColor = SBAccent(NO, 0.72);

    SBSetLayerFrame(_halo, CGRectInset(box, -5, -5), glide);
    _halo.borderWidth = 5;
    _halo.cornerRadius = radius + 5;
    _halo.borderColor = SBAccent(NO, 0.16);

    SBSetLayerFrame(_glow, CGRectInset(box, -kGlowMargin, -kGlowMargin), glide);
    NSString *key = [NSString stringWithFormat:@"%.1fx%.1f r%.1f s%.1f", box.size.width, box.size.height, radius, item.scale];
    if (![key isEqualToString:_glowKey]) {
        _glowKey = key;
        _glow.contents = [self glowImageForSize:box.size radius:radius locked:NO scale:item.scale];
        _glow.contentsScale = item.scale;
    }
}

- (id)glowImageForSize:(CGSize)size radius:(CGFloat)radius locked:(BOOL)locked scale:(CGFloat)scale {
    CGSize canvas = CGSizeMake(size.width + 2 * kGlowMargin, size.height + 2 * kGlowMargin);
    return SBImageFromDrawing(canvas, scale, ^(CGContextRef ctx) {
        CGRect box = CGRectMake(kGlowMargin, kGlowMargin, size.width, size.height);
        CGPathRef hole = CGPathCreateWithRoundedRect(box, radius, radius, NULL);
        CGContextAddRect(ctx, CGRectMake(0, 0, canvas.width, canvas.height));
        CGContextAddPath(ctx, hole);
        CGContextEOClip(ctx);
        CGPathRelease(hole);
        // Spread -8: the caster is the box shrunk by 8 pt, but never to nothing on a short field.
        CGFloat shrink = MIN(8, MIN(size.width, size.height) / 2 - 2);
        CGFloat casterRadius = MAX(1, radius - shrink);
        CGPathRef caster = CGPathCreateWithRoundedRect(CGRectInset(box, shrink, shrink), casterRadius, casterRadius, NULL);
        SBDrawShadowOnly(ctx, caster, CGSizeMake(0, -8), 26, SBAccent(locked, 0.5), scale);
        CGPathRelease(caster);
    });
}

@end

#pragma mark - Shabang cursor

/// extension/src/content/overlay-style.ts CURSOR_PATH, in a 28 x 28 box with the tip at (5, 3.5), y down.
static CGPathRef SBCursorPathCreate(void) CF_RETURNS_RETAINED;
static CGPathRef SBCursorPathCreate(void) {
    static const CGPoint points[] = {{5, 3.5}, {5, 21.5}, {10.2, 16.9}, {13.6, 24.6}, {17, 23.1}, {13.7, 15.6}, {20.5, 15.2}};
    CGMutablePathRef path = CGPathCreateMutable();
    CGPathAddLines(path, NULL, points, sizeof(points) / sizeof(points[0]));
    CGPathCloseSubpath(path);
    return path;
}

@implementation SBCursorLayer {
    CALayer *_halo, *_body;
    NSString *_imageKey;
}

static const CGFloat kCursorBox = 28, kCursorMargin = 16, kHaloSize = 34;

- (void)applyItem:(SBDrawItem *)item glide:(BOOL)glide reduceMotion:(BOOL)reduceMotion {
    if (!_body) {
        _halo = [CALayer layer];
        _body = [CALayer layer];
        [self addSublayer:_halo];
        [self addSublayer:_body];
        // CSS left -12, top -13: the halo is centered on the pointer's tip.
        _halo.frame = CGRectMake(5 - kHaloSize / 2, kCursorBox - 4 - kHaloSize / 2, kHaloSize, kHaloSize);
        _body.frame = CGRectInset(CGRectMake(0, 0, kCursorBox, kCursorBox), -kCursorMargin, -kCursorMargin);
    }
    SBSetLayerFrame(self, item.frame, glide);
    NSString *key = [NSString stringWithFormat:@"l%d s%.1f", item.locked, item.scale];
    if (![key isEqualToString:_imageKey]) {
        _imageKey = key;
        _body.contents = [self bodyImageLocked:item.locked scale:item.scale];
        _halo.contents = [self haloImageLocked:item.locked scale:item.scale];
        _body.contentsScale = _halo.contentsScale = item.scale;
    }
    _halo.opacity = 0.6f;  // the resting look, and all of it under Reduce Motion
    [self animate:!reduceMotion];
}

- (id)bodyImageLocked:(BOOL)locked scale:(CGFloat)scale {
    CGFloat side = kCursorBox + 2 * kCursorMargin;
    return SBImageFromDrawing(CGSizeMake(side, side), scale, ^(CGContextRef ctx) {
        CGContextTranslateCTM(ctx, kCursorMargin, kCursorMargin + kCursorBox);  // the path is y-down
        CGContextScaleCTM(ctx, 1, -1);
        CGPathRef path = SBCursorPathCreate();
        // Shadows stay outside the pointer, so its translucent white body is not tinted by its own glow.
        CGContextSaveGState(ctx);
        CGContextAddRect(ctx, CGRectMake(-kCursorMargin, -kCursorMargin, side, side));
        CGContextAddPath(ctx, path);
        CGContextEOClip(ctx);
        SBDrawShadowOnly(ctx, path, CGSizeMake(0, -3), 6, SBColor(24, 16, 64, 0.28), scale);
        SBDrawShadowOnly(ctx, path, CGSizeZero, 7, SBAccent(locked, 0.62), scale);
        CGContextRestoreGState(ctx);

        CGContextSaveGState(ctx);
        CGContextAddPath(ctx, path);
        CGContextClip(ctx);
        CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
        NSArray *colors = @[ (__bridge id)SBColor(255, 255, 255, 0.92), (__bridge id)(locked ? SBColor(255, 226, 170, 0.55) : SBColor(205, 194, 255, 0.5)) ];
        CGGradientRef fill = CGGradientCreateWithColors(space, (__bridge CFArrayRef)colors, NULL);
        CGContextDrawLinearGradient(ctx, fill, CGPointMake(4, 3), CGPointMake(19, 25), 0);
        CGGradientRelease(fill);
        CGColorSpaceRelease(space);
        CGContextRestoreGState(ctx);

        CGContextAddPath(ctx, path);
        CGContextSetStrokeColorWithColor(ctx, SBAccent(locked, 0.95));
        CGContextSetLineWidth(ctx, 1.5);
        CGContextSetLineJoin(ctx, kCGLineJoinRound);
        CGContextStrokePath(ctx);
        CGPathRelease(path);
    });
}

- (id)haloImageLocked:(BOOL)locked scale:(CGFloat)scale {
    return SBImageFromDrawing(CGSizeMake(kHaloSize, kHaloSize), scale, ^(CGContextRef ctx) {
        CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
        NSArray *colors = @[ (__bridge id)SBAccent(locked, 0.38), (__bridge id)SBAccent(locked, 0) ];
        CGFloat stops[] = {0, 0.68};
        CGGradientRef glow = CGGradientCreateWithColors(space, (__bridge CFArrayRef)colors, stops);
        CGPoint center = CGPointMake(kHaloSize / 2, kHaloSize / 2);
        CGContextDrawRadialGradient(ctx, glow, center, 0, center, kHaloSize / 2, 0);
        CGGradientRelease(glow);
        CGColorSpaceRelease(space);
    });
}

/// A slow float and a pulsing halo keep the ghost alive while it waits. Both stop under Reduce Motion.
- (void)animate:(BOOL)on {
    if (!on) {
        [_body removeAnimationForKey:@"ghost-float"];
        [_halo removeAnimationForKey:@"ghost-pulse"];
        return;
    }
    if (![_body animationForKey:@"ghost-float"]) {
        CABasicAnimation *drift = [CABasicAnimation animationWithKeyPath:@"transform.translation.y"];
        drift.fromValue = @0;
        drift.toValue = @2;
        drift.duration = 1.4;
        drift.autoreverses = YES;
        drift.repeatCount = HUGE_VALF;
        drift.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseInEaseOut];
        [_body addAnimation:drift forKey:@"ghost-float"];
    }
    if (![_halo animationForKey:@"ghost-pulse"]) {
        CABasicAnimation *grow = [CABasicAnimation animationWithKeyPath:@"transform.scale"];
        grow.fromValue = @0.7;
        grow.toValue = @1.35;
        CABasicAnimation *fade = [CABasicAnimation animationWithKeyPath:@"opacity"];
        fade.fromValue = @0.9;
        fade.toValue = @0;
        CAAnimationGroup *pulse = [CAAnimationGroup animation];
        pulse.animations = @[ grow, fade ];
        pulse.duration = 1.9;
        pulse.repeatCount = HUGE_VALF;
        pulse.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseOut];
        [_halo addAnimation:pulse forKey:@"ghost-pulse"];
    }
}

@end
