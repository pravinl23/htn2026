// overlay-demo: shows the real GHOverlayWindow over a window of fake fields for 4 seconds, renders both layer trees
// into a PNG, and exits. This is how the overlay is LOOKED at without Accessibility permission or a browser.
//
//   build/overlay-demo [--out path.png] [--scene form|lock|dark] [--seconds 4] [--offscreen] [--reduce-motion]
//
// --offscreen builds the same layers but never puts a window on screen (fast, works over ssh).
// Fictional demo profile only ("Alex Chen").
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import "GHGeometry.h"
#import "GHOverlayModel.h"
#import "GHOverlayWindow.h"

static const CGSize kCanvas = {900, 640};

typedef struct {
    const char *signature, *kind, *label, *ghost;
    CGRect rect;  // canvas coordinates, top-left origin
    BOOL locked, streaming;
} DemoField;

static const DemoField kFields[] = {
    {"first", "text", "First name", "Alex", {{40, 96}, {300, 40}}, NO, NO},
    {"last", "text", "Last name", "Chen", {{360, 96}, {300, 40}}, NO, NO},
    {"email", "email", "Email", "alex.chen@example.com", {{40, 176}, {300, 40}}, NO, NO},
    {"phone", "tel", "Phone", "+1 (415) 555-0134", {{360, 176}, {300, 40}}, NO, NO},
    {"native", "text", "Native field (22 pt)", "San Francisco, CA", {{690, 105}, {170, 22}}, NO, NO},
    {"linkedin", "url", "LinkedIn, in a narrow field", "https://www.linkedin.com/in/alexchen-demo", {{690, 176}, {170, 32}}, NO, NO},
    {"country", "select", "Country", "United States", {{40, 256}, {300, 36}}, NO, NO},
    {"auth", "radio", "Authorized to work in the US?", "Yes", {{360, 264}, {130, 20}}, NO, NO},
    {"updates", "checkbox", "Email me about similar roles", "Check", {{690, 264}, {20, 20}}, NO, NO},
    {"why", "textarea", "Why do you want to work here?",
     "I have spent six years building developer tools, most recently leading the editor platform team at Northwind, "
     "where we cut cold start time by 40% and shipped inline completions to two million users. Ghost sits exactly "
     "where my interests meet: latency-sensitive UX, accessibility APIs and small models that make good decisions fast. "
     "I would love to bring that experience to the team and help people get through the boring parts of their day. "
     "Outside of work I maintain a small open source library for keyboard-first navigation and mentor new engineers.",
     {{40, 336}, {620, 104}}, NO, YES},
    {"submit", "button", "", "Submit application", {{40, 480}, {190, 44}}, YES, NO},
};
static const NSUInteger kFieldCount = sizeof(kFields) / sizeof(kFields[0]);

static CGColorRef Gray(CGFloat white, CGFloat alpha) { return [NSColor colorWithWhite:white alpha:alpha].CGColor; }

static CATextLayer *Caption(NSString *text, CGRect frame, CGFloat size, NSColor *color, CGFloat scale) {
    CATextLayer *layer = [CATextLayer layer];
    layer.string = text;
    layer.font = (__bridge CFTypeRef)[NSFont systemFontOfSize:size weight:NSFontWeightMedium];
    layer.fontSize = size;
    layer.foregroundColor = color.CGColor;
    layer.contentsScale = scale;
    layer.frame = frame;
    return layer;
}

/// The fake application form: what a browser would draw under the overlay. Bottom-left layer coordinates.
static CALayer *BuildForm(BOOL dark, CGFloat scale) {
    CALayer *form = [CALayer layer];
    form.frame = CGRectMake(0, 0, kCanvas.width, kCanvas.height);
    form.backgroundColor = dark ? Gray(0.11, 1) : Gray(0.985, 1);
    NSColor *ink = dark ? [NSColor colorWithWhite:0.92 alpha:1] : [NSColor colorWithWhite:0.13 alpha:1];
    [form addSublayer:Caption(@"Apply: Senior Engineer, Northwind (fake form under the real overlay)",
                              CGRectMake(40, kCanvas.height - 56, 800, 24), 17, ink, scale)];
    for (NSUInteger i = 0; i < kFieldCount; i++) {
        DemoField f = kFields[i];
        CGRect box = CGRectMake(f.rect.origin.x, kCanvas.height - CGRectGetMaxY(f.rect), f.rect.size.width, f.rect.size.height);
        NSString *kind = @(f.kind);
        CALayer *field = [CALayer layer];
        field.frame = box;
        field.cornerRadius = 6;
        field.borderWidth = 1;
        field.borderColor = dark ? Gray(0.32, 1) : Gray(0.78, 1);
        field.backgroundColor = dark ? Gray(0.16, 1) : Gray(1, 1);
        if ([kind isEqualToString:@"button"]) {
            field.backgroundColor = [NSColor colorWithSRGBRed:0.13 green:0.13 blue:0.18 alpha:1].CGColor;
            field.borderWidth = 0;
            CATextLayer *title = Caption(@(f.ghost), CGRectMake(0, 13, box.size.width, 18), 14, NSColor.whiteColor, scale);
            title.alignmentMode = kCAAlignmentCenter;
            [field addSublayer:title];
        } else if ([kind isEqualToString:@"checkbox"]) {
            field.cornerRadius = 4;
        } else if ([kind isEqualToString:@"radio"]) {
            field.borderWidth = 0;
            field.backgroundColor = NULL;
            for (int r = 0; r < 2; r++) {
                CALayer *dot = [CALayer layer];
                dot.frame = CGRectMake(r * 66, 2, 16, 16);
                dot.cornerRadius = 8;
                dot.borderWidth = 1;
                dot.borderColor = dark ? Gray(0.45, 1) : Gray(0.6, 1);
                [field addSublayer:dot];
                [field addSublayer:Caption(r == 0 ? @"Yes" : @"No", CGRectMake(r * 66 + 22, 1, 40, 17), 13, ink, scale)];
            }
        } else if ([kind isEqualToString:@"select"]) {
            [field addSublayer:Caption(@"⌄", CGRectMake(box.size.width - 24, 11, 16, 18), 14, ink, scale)];
        }
        [form addSublayer:field];
        if (f.label[0]) {
            [form addSublayer:Caption(@(f.label), CGRectMake(box.origin.x, CGRectGetMaxY(box) + 5, 320, 16), 12,
                                      [ink colorWithAlphaComponent:0.7], scale)];
        }
    }
    return form;
}

static GHOverlayInput *BuildInput(CGRect canvasAX, NSInteger currentIndex, BOOL withError) {
    NSMutableArray<GHOverlayEntry *> *entries = [NSMutableArray array];
    for (NSUInteger i = 0; i < kFieldCount; i++) {
        DemoField f = kFields[i];
        CGRect ax = CGRectOffset(f.rect, canvasAX.origin.x, canvasAX.origin.y);
        GHOverlayEntry *entry = [GHOverlayEntry entryWithSignature:@(f.signature) kind:@(f.kind) displayText:@(f.ghost)
                                                            axRect:ax locked:f.locked];
        entry.streaming = f.streaming;
        [entries addObject:entry];
    }
    GHOverlayInput *input = [[GHOverlayInput alloc] init];
    input.entries = entries;
    input.currentIndex = currentIndex;
    input.windowAXFrame = canvasAX;
    input.hud = [GHOverlayHUDInfo infoWithProvider:@"jev (ai-gateway)" latencyMs:@182 cache:@"miss" keystrokesSaved:124];
    input.error = withError ? @"Email: the page rejected the value" : nil;
    return input;
}

static BOOL WritePNG(CALayer *form, CALayer *overlayRoot, CGPoint canvasInPanel, CGFloat scale, NSString *path) {
    size_t width = (size_t)(kCanvas.width * scale), height = (size_t)(kCanvas.height * scale);
    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef ctx = CGBitmapContextCreate(NULL, width, height, 8, 0, space,
                                             (uint32_t)kCGImageAlphaPremultipliedFirst | (uint32_t)kCGBitmapByteOrder32Host);
    CGColorSpaceRelease(space);
    if (!ctx) return NO;
    CGContextScaleCTM(ctx, scale, scale);
    [form renderInContext:ctx];
    CGContextTranslateCTM(ctx, -canvasInPanel.x, -canvasInPanel.y);  // the panel covers the display; crop to the form
    [overlayRoot renderInContext:ctx];
    CGImageRef image = CGBitmapContextCreateImage(ctx);
    CGContextRelease(ctx);
    NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithCGImage:image];
    CGImageRelease(image);
    NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    [NSFileManager.defaultManager createDirectoryAtPath:path.stringByDeletingLastPathComponent
                            withIntermediateDirectories:YES attributes:nil error:NULL];
    return [png writeToFile:path atomically:YES];
}

static NSString *Option(NSArray<NSString *> *args, NSString *name, NSString *fallback) {
    NSUInteger i = [args indexOfObject:name];
    return i != NSNotFound && i + 1 < args.count ? args[i + 1] : fallback;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        setvbuf(stdout, NULL, _IONBF, 0);  // nothing may be lost in a pipe if the run dies
        NSArray<NSString *> *args = NSProcessInfo.processInfo.arguments;
        NSString *out = Option(args, @"--out", @"build/overlay-demo.png");
        NSString *scene = Option(args, @"--scene", @"form");
        NSTimeInterval seconds = Option(args, @"--seconds", @"4").doubleValue;
        BOOL offscreen = [args containsObject:@"--offscreen"];

        NSApplication *app = NSApplication.sharedApplication;
        app.activationPolicy = NSApplicationActivationPolicyAccessory;

        GHOverlayWindow *overlay = [[GHOverlayWindow alloc] init];
        overlay.offscreen = offscreen;
        if ([args containsObject:@"--reduce-motion"]) overlay.reduceMotionOverride = @YES;
        GHScreenLayout *layout = overlay.layout;
        if (layout.count == 0) {
            fprintf(stderr, "overlay-demo: no display attached\n");
            return 2;
        }
        CGFloat scale = [layout scaleAtIndex:0];
        CGRect visible = [layout visibleFrameAtIndex:0];
        // The fake form sits in the bottom-right of the main display, so the HUD lands inside the picture.
        CGRect canvasAppKit = CGRectMake(CGRectGetMaxX(visible) - kCanvas.width, CGRectGetMinY(visible), kCanvas.width, kCanvas.height);
        CGRect canvasAX = [layout axRectFromAppKitRect:canvasAppKit];

        BOOL dark = [scene isEqualToString:@"dark"];
        CALayer *form = BuildForm(dark, scale);
        NSWindow *window = nil;
        if (!offscreen) {
            window = [[NSWindow alloc] initWithContentRect:canvasAppKit styleMask:NSWindowStyleMaskBorderless
                                                   backing:NSBackingStoreBuffered defer:NO];
            NSView *view = [[NSView alloc] initWithFrame:CGRectMake(0, 0, kCanvas.width, kCanvas.height)];
            view.layer = form;
            view.wantsLayer = YES;
            window.contentView = view;
            window.releasedWhenClosed = NO;  // ARC owns it; the default would release it a second time on close
            window.level = NSFloatingWindowLevel;
            window.ignoresMouseEvents = YES;
            [window orderFrontRegardless];
        }

        NSInteger current = [scene isEqualToString:@"lock"] ? (NSInteger)kFieldCount - 1 : [Option(args, @"--current", @"2") integerValue];
        GHOverlayInput *input = BuildInput(canvasAX, current, [scene isEqualToString:@"lock"]);
        [overlay renderInput:input];

        if (!offscreen && seconds > 0) {
            // Walk the ghost through a few fields so the glide can be watched, then settle on the scene's target.
            NSArray<NSNumber *> *walk = @[ @0, @1, @(current) ];
            for (NSUInteger step = 0; step < walk.count; step++) {
                input.currentIndex = walk[step].integerValue;
                [overlay renderInput:input];
                [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:seconds / walk.count]];
            }
        }

        CGRect panelFrame = [layout frameAtIndex:0];
        CGPoint canvasInPanel = CGPointMake(canvasAppKit.origin.x - panelFrame.origin.x, canvasAppKit.origin.y - panelFrame.origin.y);
        BOOL ok = WritePNG(form, [overlay rootLayerAtIndex:0], canvasInPanel, MAX(scale, 2), out);
        printf("overlay-demo: %s %s (scene %s, %lu layers, %s)\n", ok ? "wrote" : "FAILED to write", out.UTF8String,
               scene.UTF8String, (unsigned long)[overlay layerKeysAtIndex:0].count, offscreen ? "offscreen" : "on screen");
        NSPanel *panel = [overlay panelAtIndex:0];
        printf("overlay-demo: %lu panel(s); panel 0 level %ld (screen saver %ld), click-through %d, visible %d, key %d, "
               "shadow %d, opaque %d, all spaces %d, full-screen aux %d, ignores cycle %d, reduce motion %d\n",
               (unsigned long)overlay.panelCount, (long)panel.level, (long)NSScreenSaverWindowLevel, panel.ignoresMouseEvents,
               panel.isVisible, panel.isKeyWindow, panel.hasShadow, panel.isOpaque,
               (panel.collectionBehavior & NSWindowCollectionBehaviorCanJoinAllSpaces) != 0,
               (panel.collectionBehavior & NSWindowCollectionBehaviorFullScreenAuxiliary) != 0,
               (panel.collectionBehavior & NSWindowCollectionBehaviorIgnoresCycle) != 0, overlay.reduceMotion);
        [overlay hideImmediately];
        printf("overlay-demo: after hideImmediately visible %d\n", overlay.isVisible);
        [overlay invalidate];
        [window close];
        return ok ? 0 : 1;
    }
}
