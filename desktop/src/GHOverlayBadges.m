// The dark chips of the overlay: the "Enter to confirm" lock badge and the HUD. Classes are declared in GHOverlayLayers.h.
#import "GHOverlayLayers.h"
#import "GHOverlayDrawing.h"

static CGFloat GHSnapTo(CGFloat value, CGFloat scale) {
    CGFloat s = scale > 0 ? scale : 1;
    return round(value * s) / s;
}

/// A soft shadow with a negative spread, like `box-shadow: 0 12px 32px -12px`.
static void GHSetChipShadow(CALayer *chip, CGColorRef color, float opacity, CGFloat drop, CGFloat blur, CGFloat spread) {
    CGFloat inset = MIN(spread, MIN(chip.bounds.size.width, chip.bounds.size.height) / 2 - 2);
    CGPathRef caster = CGPathCreateWithRoundedRect(CGRectInset(chip.bounds, inset, inset), 2, 2, NULL);
    chip.shadowPath = caster;
    CGPathRelease(caster);
    chip.shadowColor = color;
    chip.shadowOpacity = opacity;
    chip.shadowOffset = CGSizeMake(0, -drop);
    chip.shadowRadius = blur / 2;
}

#pragma mark - Lock badge

@implementation GHLockBadgeLayer {
    CGFloat _builtScale;
}

/// viewBox 0 0 16 16 of the extension's padlock, redrawn y-up: a rounded body and a round-capped shackle.
static id GHPadlockImage(CGFloat side, CGFloat scale) {
    return GHImageFromDrawing(CGSizeMake(side, side), scale, ^(CGContextRef ctx) {
        CGContextScaleCTM(ctx, side / 16, side / 16);
        CGColorRef amber = GHColor(245, 165, 36, 1);
        CGPathRef body = CGPathCreateWithRoundedRect(CGRectMake(3, 1.5, 10, 7.5), 2, 2, NULL);
        CGContextAddPath(ctx, body);
        CGContextSetFillColorWithColor(ctx, amber);
        CGContextFillPath(ctx);
        CGPathRelease(body);
        CGContextMoveToPoint(ctx, 5.2, 9);
        CGContextAddLineToPoint(ctx, 5.2, 11);
        CGContextAddArc(ctx, 8, 11, 2.8, M_PI, 0, 1);
        CGContextAddLineToPoint(ctx, 10.8, 9);
        CGContextSetStrokeColorWithColor(ctx, amber);
        CGContextSetLineWidth(ctx, 1.6);
        CGContextSetLineCap(ctx, kCGLineCapRound);
        CGContextStrokePath(ctx);
    });
}

static CALayer *GHEnterKey(CGFloat scale, CGSize *outSize) {
    NSFont *font = [NSFont systemFontOfSize:10 weight:NSFontWeightBold];
    NSAttributedString *text = GHAttributed(@"Enter", font, GHColor(42, 28, 2, 1), 0);
    CGSize textSize = GHTextSize(text);
    CGSize size = CGSizeMake(textSize.width + 10, 15);
    CALayer *key = [CALayer layer];
    key.anchorPoint = CGPointZero;
    key.bounds = CGRectMake(0, 0, size.width, size.height);
    key.cornerRadius = 4;
    key.backgroundColor = GHColor(185, 122, 12, 1);  // the 1.5 pt bottom edge
    CAGradientLayer *face = [CAGradientLayer layer];
    face.frame = CGRectMake(0, 1.5, size.width, size.height - 1.5);
    face.cornerRadius = 4;
    face.colors = @[ (__bridge id)GHColor(255, 227, 166, 1), (__bridge id)GHColor(245, 185, 66, 1) ];
    face.startPoint = CGPointMake(0.5, 1);
    face.endPoint = CGPointMake(0.5, 0);
    [key addSublayer:face];
    CATextLayer *label = GHMakeTextLayer(scale);
    label.string = text;
    CGFloat line = GHLineHeight(font);
    label.frame = CGRectMake(5, GHSnapTo(1.5 + (size.height - 1.5 - line) / 2, scale), textSize.width + 1, line);
    [key addSublayer:label];
    *outSize = size;
    return key;
}

- (void)applyItem:(GHDrawItem *)item glide:(BOOL)glide reduceMotion:(BOOL)reduceMotion {
    static const CGFloat kHeight = 26, kIcon = 13;
    if (_builtScale != item.scale) {
        _builtScale = item.scale;
        self.sublayers = nil;
        CALayer *icon = [CALayer layer];
        icon.frame = CGRectMake(8, GHSnapTo((kHeight - kIcon) / 2, item.scale), kIcon, kIcon);
        icon.contents = GHPadlockImage(kIcon, item.scale);
        icon.contentsScale = item.scale;
        [self addSublayer:icon];

        CGSize keySize = CGSizeZero;
        CALayer *key = GHEnterKey(item.scale, &keySize);
        key.position = CGPointMake(CGRectGetMaxX(icon.frame) + 6, GHSnapTo((kHeight - keySize.height) / 2, item.scale));
        [self addSublayer:key];

        NSFont *font = [NSFont systemFontOfSize:11 weight:NSFontWeightSemibold];
        NSAttributedString *text = GHAttributed(@"to confirm", font, GHColor(255, 223, 158, 1), 0);
        CGSize textSize = GHTextSize(text);
        CATextLayer *label = GHMakeTextLayer(item.scale);
        label.string = text;
        CGFloat line = GHLineHeight(font);
        label.frame = CGRectMake(key.position.x + keySize.width + 5, GHSnapTo((kHeight - line) / 2, item.scale), textSize.width + 1, line);
        [self addSublayer:label];
        self.bounds = CGRectMake(0, 0, ceil(CGRectGetMaxX(label.frame) + 10), kHeight);
    }
    GHSetLayerFrame(self, GHAnchoredFrame(item.frame, self.bounds.size, item.anchor, item.scale), glide);
    self.cornerRadius = kHeight / 2;
    self.backgroundColor = GHColor(30, 21, 6, 0.9);
    self.borderWidth = 1;
    self.borderColor = GHColor(245, 165, 36, 0.6);
    GHSetChipShadow(self, GHColor(245, 165, 36, 1), 0.6f, 8, 22, 8);
}

@end

#pragma mark - HUD

@implementation GHHudLayer {
    CALayer *_dot;
    CATextLayer *_label;
}

static CGColorRef GHCacheTone(NSString *cache) {
    if ([cache isEqualToString:@"hit"]) return GHColor(126, 226, 168, 1);
    if ([cache isEqualToString:@"miss"]) return GHColor(255, 213, 138, 1);
    return GHColor(185, 180, 208, 1);
}

/// "Ghost  via <provider>  last <n> ms  cache <state>  saved <n> keys" as ONE string: kerning makes the gaps,
/// so one text layer and one measurement cover the whole pill.
static NSAttributedString *GHHudText(GHOverlayHUDInfo *hud) {
    NSFont *brandFont = [NSFont systemFontOfSize:11 weight:NSFontWeightBold];
    NSFont *mono = [NSFont monospacedSystemFontOfSize:11 weight:NSFontWeightMedium];
    NSMutableAttributedString *out = [[NSMutableAttributedString alloc] init];
    void (^append)(NSString *, NSFont *, CGColorRef, CGFloat) = ^(NSString *text, NSFont *font, CGColorRef color, CGFloat gap) {
        if (text.length == 0) return;
        NSMutableAttributedString *part = [GHAttributed(text, font, color, 0) mutableCopy];
        if (gap > 0) [part addAttribute:NSKernAttributeName value:@(gap) range:NSMakeRange(text.length - 1, 1)];
        [out appendAttributedString:part];
    };
    NSArray<NSString *> *segments = hud.segments;
    append(@"Ghost", brandFont, GHColor(255, 255, 255, 0.92), 12);
    for (NSUInteger i = 0; i + 1 < segments.count; i += 2) {
        BOOL last = i + 2 >= segments.count, isCache = [segments[i] isEqualToString:@"cache"];
        append(segments[i], mono, GHColor(255, 255, 255, 0.48), 5);
        append(segments[i + 1], mono, isCache ? GHCacheTone(hud.cache) : GHColor(255, 255, 255, 0.92), last ? 0 : 12);
    }
    return out;
}

- (void)applyItem:(GHDrawItem *)item glide:(BOOL)glide reduceMotion:(BOOL)reduceMotion {
    static const CGFloat kHeight = 28, kPadX = 12, kDot = 7, kDotGap = 6;
    BOOL isError = item.kind == GHDrawKindHUDError;
    BOOL isChip = isError || item.kind == GHDrawKindHUDStatus;   // a line of text: an error, or a sequence's progress
    NSFont *mono = [NSFont monospacedSystemFontOfSize:11 weight:NSFontWeightMedium];
    CGColorRef chipColor = isError ? GHColor(255, 180, 180, 1) : GHColor(255, 255, 255, 0.92);
    NSAttributedString *text = isChip ? GHAttributed(item.text ?: @"", mono, chipColor, 0) : GHHudText(item.hud);
    CGFloat lead = isChip ? kPadX : kPadX + kDot + kDotGap;
    CGFloat textWidth = MIN(GHTextSize(text).width + 1, MAX(0, item.frame.size.width - lead - kPadX));
    CGRect frame = GHAnchoredFrame(item.frame, CGSizeMake(lead + textWidth + kPadX, kHeight), item.anchor, item.scale);
    GHSetLayerFrame(self, frame, NO);

    self.cornerRadius = 11;
    self.backgroundColor = GHColor(16, 14, 26, 0.86);
    self.borderWidth = 1;
    self.borderColor = isError ? GHColor(255, 120, 120, 0.4) : GHColor(255, 255, 255, 0.1);
    GHSetChipShadow(self, GHColor(10, 6, 40, 1), 0.65f, 12, 32, 12);

    if (!_label) {
        _label = GHMakeTextLayer(item.scale);
        [self addSublayer:_label];
    }
    _label.contentsScale = item.scale;
    if (isChip) GHSetPlainText(_label, item.text ?: @"", mono, chipColor);  // may be truncated
    else _label.string = text;
    CGFloat line = MAX(GHLineHeight(mono), GHTextSize(text).height);
    _label.frame = CGRectMake(lead, GHSnapTo((kHeight - line) / 2, item.scale), textWidth, line);

    if (isChip) {
        [_dot removeFromSuperlayer];
        _dot = nil;
        return;
    }
    if (!_dot) {
        _dot = [CALayer layer];
        [self addSublayer:_dot];
    }
    _dot.frame = CGRectMake(kPadX, GHSnapTo((kHeight - kDot) / 2, item.scale), kDot, kDot);
    _dot.cornerRadius = kDot / 2;
    _dot.backgroundColor = GHAccent(NO, 1);
    _dot.shadowColor = GHAccent(NO, 1);
    _dot.shadowOpacity = 1;
    _dot.shadowRadius = 4;
    _dot.shadowOffset = CGSizeZero;
}

@end
