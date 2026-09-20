#import "GHVision.h"
#import "GHLog.h"
#import <AppKit/AppKit.h>
#import <ImageIO/ImageIO.h>

NSString *const GHVisionReasonScreenRecording = @"needs Screen Recording";
NSString *const GHVisionReasonSensitive = @"a sensitive field is on screen";
NSString *const GHVisionReasonNothingToName = @"nothing to name";
NSString *const GHVisionReasonCaptureFailed = @"the screenshot failed";

/// The route's own limit (docs/server-api.md): 1 to 40 boxes per call.
static const NSUInteger kMaxBoxes = 40;
/// A control smaller than this is a spacer or a hit-box artifact, not something a person clicks.
static const CGFloat kMinBoxSide = 12.0;
/// A crop bigger than this is a region, not a control: cropping it would be cropping the page.
static const CGFloat kMaxBoxSide = 400.0;
/// Room around a glyph, so the crop shows the whole control and not half of it.
static const CGFloat kPadding = 4.0;
static const CGFloat kTileGap = 8.0;
static const NSUInteger kMaxCacheEntries = 64;
static const NSTimeInterval kTimeout = 12.0;

@implementation GHVisionBox

+ (instancetype)boxWithSignature:(NSString *)signature rect:(CGRect)rect {
    GHVisionBox *box = [[GHVisionBox alloc] init];
    box.signature = signature ?: @"";
    box.rect = rect;
    return box;
}

- (NSString *)description {
    return [NSString stringWithFormat:@"<GHVisionBox %@ %.0fx%.0f>", self.signature, self.rect.size.width, self.rect.size.height];
}

@end

@implementation GHVision {
    NSString *_baseURLString;
    NSMutableDictionary<NSString *, NSDictionary *> *_cache;   // key -> { labels, locked }
    NSMutableArray<NSString *> *_cacheOrder;
    NSMutableSet<NSString *> *_askedPages;
    BOOL _loggedUnavailable;
}

- (instancetype)initWithBaseURLString:(NSString *)baseURLString {
    if ((self = [super init])) {
        _baseURLString = [(baseURLString.length ? baseURLString : @"http://127.0.0.1:8787") copy];
        _cache = [NSMutableDictionary dictionary];
        _cacheOrder = [NSMutableArray array];
        _askedPages = [NSMutableSet set];
    }
    return self;
}

#pragma mark permission

- (BOOL)screenRecordingAllowed {
    // A caller that supplies its own `screenshot` block answers for the permission itself (that is how the
    // tests run, with no screen access at all). Otherwise: ask macOS, and never prompt. The user grants this
    // in System Settings, and a dialog in the middle of a walk would be exactly the interruption Ghost must
    // not be.
    if (self.screenshot) return YES;
    return CGPreflightScreenCaptureAccess();
}

- (NSString *)unavailableReason {
    return self.screenRecordingAllowed ? nil : GHVisionReasonScreenRecording;
}

- (void)forgetPage {
    [_askedPages removeAllObjects];
}

#pragma mark what to crop

+ (NSArray<GHVisionBox *> *)boxesForFields:(NSArray<GHField *> *)fields
                                   unnamed:(NSArray<NSString *> *)unnamedSignatures
                         sensitiveOnScreen:(BOOL)sensitiveOnScreen {
    // Rule: a window with a password on screen is never screenshotted, not even its other controls.
    if (sensitiveOnScreen) return @[];
    NSSet<NSString *> *wanted = [NSSet setWithArray:unnamedSignatures ?: @[]];
    NSMutableArray<GHVisionBox *> *boxes = [NSMutableArray array];
    for (GHField *field in fields) {
        if (boxes.count >= kMaxBoxes) break;
        if (![wanted containsObject:field.signature]) continue;
        CGRect rect = field.rect;
        if (CGRectIsEmpty(rect) || rect.size.width < kMinBoxSide || rect.size.height < kMinBoxSide) continue;
        if (rect.size.width > kMaxBoxSide || rect.size.height > kMaxBoxSide) continue;
        [boxes addObject:[GHVisionBox boxWithSignature:field.signature rect:rect]];
    }
    return boxes;
}

+ (NSString *)cacheKeyForPage:(NSString *)pageKey boxes:(NSArray<GHVisionBox *> *)boxes {
    NSMutableString *key = [NSMutableString stringWithString:pageKey ?: @""];
    for (GHVisionBox *box in boxes) {
        [key appendFormat:@"|%.0f,%.0f,%.0f,%.0f", box.rect.origin.x, box.rect.origin.y, box.rect.size.width, box.rect.size.height];
    }
    return key;
}

#pragma mark the call

- (void)labelBoxes:(NSArray<GHVisionBox *> *)boxes
           pageKey:(NSString *)pageKey
        completion:(void (^)(NSDictionary<NSString *, NSString *> *, NSSet<NSString *> *, NSString *_Nullable))completion {
    void (^answer)(NSDictionary *, NSSet *, NSString *) = ^(NSDictionary *labels, NSSet *locked, NSString *reason) {
        if (!completion) return;
        if (NSThread.isMainThread) completion(labels ?: @{}, locked ?: [NSSet set], reason);
        else dispatch_async(dispatch_get_main_queue(), ^{ completion(labels ?: @{}, locked ?: [NSSet set], reason); });
    };
    if (boxes.count == 0) { answer(nil, nil, GHVisionReasonNothingToName); return; }

    NSString *key = [GHVision cacheKeyForPage:pageKey boxes:boxes];
    NSDictionary *cached = _cache[key];
    if (cached) {
        _cacheHits++;
        answer(cached[@"labels"], cached[@"locked"], nil);
        return;
    }
    if ([_askedPages containsObject:pageKey ?: @""]) { answer(nil, nil, nil); return; }   // one call per page view

    if (!self.screenRecordingAllowed) {
        if (!_loggedUnavailable) {
            _loggedUnavailable = YES;
            GHLog(@"vision: unavailable (%@): no eyes for icon-only controls", GHVisionReasonScreenRecording);
        }
        answer(nil, nil, GHVisionReasonScreenRecording);
        return;
    }

    CGSize size = CGSizeZero;
    NSMutableArray<NSValue *> *origins = [NSMutableArray array];
    NSData *png = [self stripForBoxes:boxes size:&size origins:origins];
    if (!png) {
        if (!_loggedUnavailable) {
            _loggedUnavailable = YES;
            GHLog(@"vision: unavailable (%@)", GHVisionReasonCaptureFailed);
        }
        answer(nil, nil, GHVisionReasonCaptureFailed);
        return;
    }

    NSDictionary *body = [GHVision requestBodyForStrip:png size:size boxes:boxes origins:origins];
    NSData *json = body ? [NSJSONSerialization dataWithJSONObject:body options:0 error:NULL] : nil;
    if (!json) { answer(nil, nil, GHVisionReasonCaptureFailed); return; }

    [_askedPages addObject:pageKey ?: @""];
    _calls++;
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:[_baseURLString stringByAppendingString:@"/v1/vision/label"]]];
    request.HTTPMethod = @"POST";
    request.timeoutInterval = kTimeout;
    [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
    request.HTTPBody = json;

    __weak GHVision *weakSelf = self;
    void (^done)(NSData *, NSInteger) = ^(NSData *replyData, NSInteger status) {
        GHVision *vision = weakSelf;
        if (status != 200 || replyData.length == 0) {
            GHLog(@"vision: /v1/vision/label answered %ld (boxes=%lu)", (long)status, (unsigned long)boxes.count);
            answer(nil, nil, nil);
            return;
        }
        id reply = [NSJSONSerialization JSONObjectWithData:replyData options:0 error:NULL];
        NSMutableSet<NSString *> *locked = [NSMutableSet set];
        NSDictionary<NSString *, NSString *> *labels = [GHVision labelsFromReply:reply locked:locked];
        GHLog(@"vision: named %lu of %lu controls (%lu locked)", (unsigned long)labels.count, (unsigned long)boxes.count, (unsigned long)locked.count);
        [vision remember:key labels:labels locked:locked];
        answer(labels, locked, nil);
    };
    if (self.transport) {
        self.transport(request, done);
        return;
    }
    [[NSURLSession.sharedSession dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        NSInteger status = [response isKindOfClass:[NSHTTPURLResponse class]] ? ((NSHTTPURLResponse *)response).statusCode : 0;
        done(error ? nil : data, status);
    }] resume];
}

- (void)remember:(NSString *)key labels:(NSDictionary *)labels locked:(NSSet *)locked {
    if (key.length == 0) return;
    _cache[key] = @{ @"labels": labels ?: @{}, @"locked": locked ?: [NSSet set] };
    [_cacheOrder addObject:key];
    while (_cacheOrder.count > kMaxCacheEntries) {
        [_cache removeObjectForKey:_cacheOrder.firstObject];
        [_cacheOrder removeObjectAtIndex:0];
    }
}

#pragma mark the strip

/// One PNG holding ONLY the controls, side by side. Nothing around them is captured, so no page text, no
/// window title and no neighbouring content can reach the server.
- (NSData *)stripForBoxes:(NSArray<GHVisionBox *> *)boxes size:(CGSize *)outSize origins:(NSMutableArray<NSValue *> *)origins {
    CGFloat width = kTileGap, height = 0;
    for (GHVisionBox *box in boxes) {
        width += box.rect.size.width + 2 * kPadding + kTileGap;
        height = MAX(height, box.rect.size.height + 2 * kPadding);
    }
    if (width <= kTileGap || height <= 0) return nil;
    height += 2 * kTileGap;

    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = CGBitmapContextCreate(NULL, (size_t)ceil(width), (size_t)ceil(height), 8, 0, space, kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(space);
    if (!context) return nil;
    CGContextSetRGBFillColor(context, 1, 1, 1, 1);
    CGContextFillRect(context, CGRectMake(0, 0, width, height));

    CGFloat x = kTileGap;
    BOOL any = NO;
    for (GHVisionBox *box in boxes) {
        CGRect crop = CGRectInset(box.rect, -kPadding, -kPadding);
        CGImageRef image = self.screenshot ? self.screenshot(crop) : [GHVision copyScreenImageOfRect:crop];
        CGFloat tileWidth = crop.size.width, tileHeight = crop.size.height;
        if (image) {
            // The bitmap context has a bottom-left origin; the strip's own coordinates stay top-left.
            CGContextDrawImage(context, CGRectMake(x, height - kTileGap - tileHeight, tileWidth, tileHeight), image);
            CGImageRelease(image);
            any = YES;
        }
        [origins addObject:[NSValue valueWithRect:NSMakeRect(x, kTileGap, tileWidth, tileHeight)]];
        x += tileWidth + kTileGap;
    }
    if (!any) {
        CGContextRelease(context);
        return nil;
    }

    CGImageRef strip = CGBitmapContextCreateImage(context);
    CGContextRelease(context);
    if (!strip) return nil;
    NSMutableData *data = [NSMutableData data];
    CGImageDestinationRef destination = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)data, CFSTR("public.png"), 1, NULL);
    if (destination) {
        CGImageDestinationAddImage(destination, strip, NULL);
        CGImageDestinationFinalize(destination);
        CFRelease(destination);
    }
    if (outSize) *outSize = CGSizeMake(CGImageGetWidth(strip), CGImageGetHeight(strip));
    CGImageRelease(strip);
    return data.length ? data : nil;
}

+ (CGImageRef)copyScreenImageOfRect:(CGRect)rect {
    // The only screen read in Ghost. Without the Screen Recording permission this returns NULL (or a blank
    // image), which the caller reports as "unavailable" rather than sending anything.
    return CGWindowListCreateImage(rect, kCGWindowListOptionOnScreenOnly, kCGNullWindowID, kCGWindowImageBoundsIgnoreFraming);
}

+ (NSDictionary<NSString *, id> *)requestBodyForStrip:(NSData *)png size:(CGSize)size boxes:(NSArray<GHVisionBox *> *)boxes origins:(NSArray<NSValue *> *)origins {
    if (png.length == 0 || boxes.count == 0 || origins.count != boxes.count) return nil;
    NSString *dataURL = [@"data:image/png;base64," stringByAppendingString:[png base64EncodedStringWithOptions:0]];
    NSMutableArray<NSDictionary *> *wire = [NSMutableArray array];
    // The strip is drawn at the captured scale, which on a Retina display is twice the point size.
    CGFloat scale = 1.0;
    CGFloat pointWidth = 0;
    for (NSValue *value in origins) pointWidth = MAX(pointWidth, NSMaxX(value.rectValue));
    if (pointWidth > 0 && size.width > 0) scale = size.width / pointWidth;
    for (NSUInteger i = 0; i < boxes.count; i++) {
        NSRect tile = origins[i].rectValue;
        [wire addObject:@{
            @"id": boxes[i].signature ?: @"",
            @"x": @(round(tile.origin.x * scale)),
            @"y": @(round(tile.origin.y * scale)),
            @"width": @(round(tile.size.width * scale)),
            @"height": @(round(tile.size.height * scale)),
        }];
    }
    // `context.mediaControls` is not set here: the caller knows the cluster, and a window title is REFUSED by
    // the route on purpose. Nothing but the pixels of the controls and their boxes is ever sent.
    return @{ @"image": dataURL, @"boxes": wire };
}

+ (NSDictionary<NSString *, NSString *> *)labelsFromReply:(id)reply locked:(NSMutableSet<NSString *> *)locked {
    NSMutableDictionary<NSString *, NSString *> *labels = [NSMutableDictionary dictionary];
    NSArray *rows = [reply isKindOfClass:[NSDictionary class]] ? reply[@"labels"] : nil;
    if (![rows isKindOfClass:[NSArray class]]) return labels;
    for (id row in rows) {
        if (![row isKindOfClass:[NSDictionary class]]) continue;
        NSDictionary *entry = row;
        NSString *signature = [entry[@"id"] isKindOfClass:[NSString class]] ? entry[@"id"] : nil;
        NSString *label = [entry[@"label"] isKindOfClass:[NSString class]] ? entry[@"label"] : nil;
        if (signature.length == 0) continue;
        // A model can lock a control, never unlock one: the flag is taken as-is and only ever adds a lock.
        if ([entry[@"irreversible"] isKindOfClass:[NSNumber class]] && [entry[@"irreversible"] boolValue]) [locked addObject:signature];
        // Sensitive: never named, never filled, never drawn. The label is dropped entirely.
        if ([entry[@"sensitive"] isKindOfClass:[NSNumber class]] && [entry[@"sensitive"] boolValue]) continue;
        if (label.length == 0) continue;
        labels[signature] = label;
    }
    return labels;
}

@end
