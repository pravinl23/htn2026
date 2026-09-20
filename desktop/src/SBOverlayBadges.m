// The dark chips of the overlay: the "Enter to confirm" lock badge and the HUD. Classes are declared in SBOverlayLayers.h.
#import "SBOverlayLayers.h"
#import "SBOverlayDrawing.h"
#import "SBLog.h"   // SBProductName: the brand, written down once

static CGFloat SBSnapTo(CGFloat value, CGFloat scale) {
    CGFloat s = scale > 0 ? scale : 1;
    return round(value * s) / s;
}

/// A soft shadow with a negative spread, like `box-shadow: 0 12px 32px -12px`.
static void SBSetChipShadow(CALayer *chip, CGColorRef color, float opacity, CGFloat drop, CGFloat blur, CGFloat spread) {
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

@implementation SBLockBadgeLayer {
    CGFloat _builtScale;
}

/// viewBox 0 0 16 16 of the extension's padlock, redrawn y-up: a rounded body and a round-capped shackle.
static id SBPadlockImage(CGFloat side, CGFloat scale) {
    return SBImageFromDrawing(CGSizeMake(side, side), scale, ^(CGContextRef ctx) {
        CGContextScaleCTM(ctx, side / 16, side / 16);
        CGColorRef amber = SBColor(245, 165, 36, 1);
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

static CALayer *SBEnterKey(CGFloat scale, CGSize *outSize) {
    NSFont *font = [NSFont systemFontOfSize:10 weight:NSFontWeightBold];
    NSAttributedString *text = SBAttributed(@"Enter", font, SBColor(42, 28, 2, 1), 0);
    CGSize textSize = SBTextSize(text);
    CGSize size = CGSizeMake(textSize.width + 10, 15);
    CALayer *key = [CALayer layer];
    key.anchorPoint = CGPointZero;
    key.bounds = CGRectMake(0, 0, size.width, size.height);
    key.cornerRadius = 4;
    key.backgroundColor = SBColor(185, 122, 12, 1);  // the 1.5 pt bottom edge
    CAGradientLayer *face = [CAGradientLayer layer];
    face.frame = CGRectMake(0, 1.5, size.width, size.height - 1.5);
    face.cornerRadius = 4;
    face.colors = @[ (__bridge id)SBColor(255, 227, 166, 1), (__bridge id)SBColor(245, 185, 66, 1) ];
    face.startPoint = CGPointMake(0.5, 1);
    face.endPoint = CGPointMake(0.5, 0);
    [key addSublayer:face];
    CATextLayer *label = SBMakeTextLayer(scale);
    label.string = text;
    CGFloat line = SBLineHeight(font);
    label.frame = CGRectMake(5, SBSnapTo(1.5 + (size.height - 1.5 - line) / 2, scale), textSize.width + 1, line);
    [key addSublayer:label];
    *outSize = size;
    return key;
}

- (void)applyItem:(SBDrawItem *)item glide:(BOOL)glide reduceMotion:(BOOL)reduceMotion {
    static const CGFloat kHeight = 26, kIcon = 13;
    if (_builtScale != item.scale) {
        _builtScale = item.scale;
        self.sublayers = nil;
        CALayer *icon = [CALayer layer];
        icon.frame = CGRectMake(8, SBSnapTo((kHeight - kIcon) / 2, item.scale), kIcon, kIcon);
        icon.contents = SBPadlockImage(kIcon, item.scale);
        icon.contentsScale = item.scale;
        [self addSublayer:icon];

        CGSize keySize = CGSizeZero;
        CALayer *key = SBEnterKey(item.scale, &keySize);
        key.position = CGPointMake(CGRectGetMaxX(icon.frame) + 6, SBSnapTo((kHeight - keySize.height) / 2, item.scale));
        [self addSublayer:key];

        NSFont *font = [NSFont systemFontOfSize:11 weight:NSFontWeightSemibold];
        NSAttributedString *text = SBAttributed(@"to confirm", font, SBColor(255, 223, 158, 1), 0);
        CGSize textSize = SBTextSize(text);
        CATextLayer *label = SBMakeTextLayer(item.scale);
        label.string = text;
        CGFloat line = SBLineHeight(font);
        label.frame = CGRectMake(key.position.x + keySize.width + 5, SBSnapTo((kHeight - line) / 2, item.scale), textSize.width + 1, line);
        [self addSublayer:label];
        self.bounds = CGRectMake(0, 0, ceil(CGRectGetMaxX(label.frame) + 10), kHeight);
    }
    SBSetLayerFrame(self, SBAnchoredFrame(item.frame, self.bounds.size, item.anchor, item.scale), glide);
    self.cornerRadius = kHeight / 2;
    self.backgroundColor = SBColor(30, 21, 6, 0.9);
    self.borderWidth = 1;
    self.borderColor = SBColor(245, 165, 36, 0.6);
    SBSetChipShadow(self, SBColor(245, 165, 36, 1), 0.6f, 8, 22, 8);
}

@end

#pragma mark - HUD

@implementation SBHudLayer {
    CALayer *_dot;
    CATextLayer *_label;
}

static CGColorRef SBCacheTone(NSString *cache) {
    if ([cache isEqualToString:@"hit"]) return SBColor(126, 226, 168, 1);
    if ([cache isEqualToString:@"miss"]) return SBColor(255, 213, 138, 1);
    return SBColor(185, 180, 208, 1);
}

/// "Shabang  via <provider>  last <n> ms  cache <state>  saved <n> keys" as ONE string: kerning makes the gaps,
/// so one text layer and one measurement cover the whole pill.
static NSAttributedString *SBHudText(SBOverlayHUDInfo *hud) {
    NSFont *brandFont = [NSFont systemFontOfSize:11 weight:NSFontWeightBold];
    NSFont *mono = [NSFont monospacedSystemFontOfSize:11 weight:NSFontWeightMedium];
    NSMutableAttributedString *out = [[NSMutableAttributedString alloc] init];
    void (^append)(NSString *, NSFont *, CGColorRef, CGFloat) = ^(NSString *text, NSFont *font, CGColorRef color, CGFloat gap) {
        if (text.length == 0) return;
        NSMutableAttributedString *part = [SBAttributed(text, font, color, 0) mutableCopy];
        if (gap > 0) [part addAttribute:NSKernAttributeName value:@(gap) range:NSMakeRange(text.length - 1, 1)];
        [out appendAttributedString:part];
    };
    NSArray<NSString *> *segments = hud.segments;
    append(SBProductName, brandFont, SBColor(255, 255, 255, 0.92), 12);
    for (NSUInteger i = 0; i + 1 < segments.count; i += 2) {
        BOOL last = i + 2 >= segments.count, isCache = [segments[i] isEqualToString:@"cache"];
        append(segments[i], mono, SBColor(255, 255, 255, 0.48), 5);
        append(segments[i + 1], mono, isCache ? SBCacheTone(hud.cache) : SBColor(255, 255, 255, 0.92), last ? 0 : 12);
    }
    return out;
}

- (void)applyItem:(SBDrawItem *)item glide:(BOOL)glide reduceMotion:(BOOL)reduceMotion {
    static const CGFloat kHeight = 28, kPadX = 12, kDot = 7, kDotGap = 6;
    BOOL isError = item.kind == SBDrawKindHUDError;
    BOOL isChip = isError || item.kind == SBDrawKindHUDStatus;   // a line of text: an error, or a sequence's progress
    NSFont *mono = [NSFont monospacedSystemFontOfSize:11 weight:NSFontWeightMedium];
    CGColorRef chipColor = isError ? SBColor(255, 180, 180, 1) : SBColor(255, 255, 255, 0.92);
    NSAttributedString *text = isChip ? SBAttributed(item.text ?: @"", mono, chipColor, 0) : SBHudText(item.hud);
    CGFloat lead = isChip ? kPadX : kPadX + kDot + kDotGap;
    CGFloat textWidth = MIN(SBTextSize(text).width + 1, MAX(0, item.frame.size.width - lead - kPadX));
    CGRect frame = SBAnchoredFrame(item.frame, CGSizeMake(lead + textWidth + kPadX, kHeight), item.anchor, item.scale);
    SBSetLayerFrame(self, frame, NO);

    self.cornerRadius = 11;
    self.backgroundColor = SBColor(16, 14, 26, 0.86);
    self.borderWidth = 1;
    self.borderColor = isError ? SBColor(255, 120, 120, 0.4) : SBColor(255, 255, 255, 0.1);
    SBSetChipShadow(self, SBColor(10, 6, 40, 1), 0.65f, 12, 32, 12);

    if (!_label) {
        _label = SBMakeTextLayer(item.scale);
        [self addSublayer:_label];
    }
    _label.contentsScale = item.scale;
    if (isChip) SBSetPlainText(_label, item.text ?: @"", mono, chipColor);  // may be truncated
    else _label.string = text;
    CGFloat line = MAX(SBLineHeight(mono), SBTextSize(text).height);
    _label.frame = CGRectMake(lead, SBSnapTo((kHeight - line) / 2, item.scale), textWidth, line);

    if (isChip) {
        [_dot removeFromSuperlayer];
        _dot = nil;
        return;
    }
    if (!_dot) {
        _dot = [CALayer layer];
        [self addSublayer:_dot];
    }
    _dot.frame = CGRectMake(kPadX, SBSnapTo((kHeight - kDot) / 2, item.scale), kDot, kDot);
    _dot.cornerRadius = kDot / 2;
    _dot.backgroundColor = SBAccent(NO, 1);
    _dot.shadowColor = SBAccent(NO, 1);
    _dot.shadowOpacity = 1;
    _dot.shadowRadius = 4;
    _dot.shadowOffset = CGSizeZero;
}

@end
