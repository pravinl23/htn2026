#import "GHOverlayModel.h"
#import "GHField.h"

// Layout numbers shared with extension/src/content/overlay.ts and overlay-style.ts.
static const CGFloat kRingPad = 3, kGroupRingPad = 4, kFieldRadiusGuess = 6;
static const CGFloat kCursorBox = 28, kCursorTipX = 5, kCursorTipY = 3.5;
static const CGFloat kKeycapWidth = 32, kKeycapHeight = 18, kKeycapGap = 8, kKeycapMinField = 96;
static const CGFloat kPillHeight = 22, kPillMaxWidth = 260, kPillRoom = 140, kSelectArrowRoom = 30;
static const CGFloat kHudMargin = 14, kHudHeight = 28, kHudGap = 6, kHudErrorMaxWidth = 320;

GHOverlayMode GHOverlayModeForKind(NSString *kind) {
    if ([kind isEqualToString:@"textarea"]) return GHOverlayModeMultiline;
    if ([kind isEqualToString:@"select"]) return GHOverlayModeSelectPill;
    if ([kind isEqualToString:@"radio"] || [kind isEqualToString:@"checkbox"] || [kind isEqualToString:@"file"]) return GHOverlayModePill;
    if ([kind isEqualToString:@"button"] || [kind isEqualToString:@"link"]) {
        return GHOverlayModeTarget;
    }
    return GHOverlayModeText;
}

CGFloat GHGhostFontSize(CGFloat fieldHeight, BOOL multiline) {
    if (multiline) return 13;
    if (!isfinite(fieldHeight)) return 13;
    return MAX(11, MIN(17, round(fieldHeight * 0.46 * 2) / 2));
}

CGFloat GHGhostTextPadding(CGFloat fieldHeight) {
    if (!isfinite(fieldHeight)) return 8;
    return MAX(4, MIN(8, round(fieldHeight * 0.3)));
}

@implementation GHOverlayEntry

+ (instancetype)entryWithSignature:(NSString *)signature
                              kind:(NSString *)kind
                       displayText:(NSString *)displayText
                            axRect:(CGRect)axRect
                            locked:(BOOL)locked {
    GHOverlayEntry *entry = [[self alloc] init];
    entry.signature = signature;
    entry.kind = kind;
    entry.displayText = displayText;
    entry.axRect = axRect;
    entry.locked = locked;
    return entry;
}

+ (instancetype)entryWithField:(GHField *)field ghost:(NSDictionary<NSString *, id> *)ghost keyName:(NSString *)keyName {
    id text = ghost[@"displayText"], locked = ghost[@"locked"], pending = ghost[@"pending"];
    GHOverlayEntry *entry = [self entryWithSignature:field.signature
                                                kind:field.kind
                                         displayText:[text isKindOfClass:NSString.class] ? text : @""
                                              axRect:field.rect
                                              locked:[locked isKindOfClass:NSNumber.class] ? [locked boolValue] : field.locked];
    entry.streaming = [pending isKindOfClass:NSNumber.class] && [pending boolValue];
    entry.keyName = keyName;
    id guess = ghost[@"guess"];
    entry.guess = [guess isKindOfClass:NSNumber.class] && [guess boolValue];
    return entry;
}

- (instancetype)init {
    if ((self = [super init])) {
        _signature = @"";
        _kind = @"text";
        _displayText = @"";
        _axRect = CGRectNull;
    }
    return self;
}

@end

@implementation GHOverlayHUDInfo

+ (instancetype)infoWithProvider:(NSString *)provider
                       latencyMs:(NSNumber *)latencyMs
                           cache:(NSString *)cache
                 keystrokesSaved:(NSInteger)keystrokesSaved {
    GHOverlayHUDInfo *info = [[self alloc] init];
    info.provider = provider;
    info.latencyMs = latencyMs;
    info.cache = cache;
    info.keystrokesSaved = keystrokesSaved;
    return info;
}

- (instancetype)init {
    if ((self = [super init])) {
        _provider = @"offline-heuristic";
        _cache = @"offline";
    }
    return self;
}

- (id)copyWithZone:(NSZone *)zone {
    return [GHOverlayHUDInfo infoWithProvider:self.provider latencyMs:self.latencyMs cache:self.cache
                              keystrokesSaved:self.keystrokesSaved];
}

- (NSArray<NSString *> *)segments {
    NSString *latency = self.latencyMs ? [NSString stringWithFormat:@"%ld ms", lround(self.latencyMs.doubleValue)] : @"—";
    NSString *saved = [NSString stringWithFormat:@"%ld keys", (long)self.keystrokesSaved];
    return @[ @"via", self.provider ?: @"", @"last", latency, @"cache", self.cache ?: @"", @"saved", saved ];
}

@end

@implementation GHOverlayInput

- (instancetype)init {
    if ((self = [super init])) {
        _entries = @[];
        _currentIndex = -1;
        _windowAXFrame = CGRectNull;
    }
    return self;
}

@end

@interface GHDrawItem ()
@property (nonatomic, copy, readwrite) NSString *key;
@property (nonatomic, readwrite) GHDrawKind kind;
@property (nonatomic, readwrite) NSUInteger screenIndex;
@property (nonatomic, readwrite) CGRect frame;
@property (nonatomic, readwrite) CGRect clipRect;
@property (nonatomic, readwrite) GHDrawAnchor anchor;
@property (nonatomic, copy, readwrite, nullable) NSString *text;
@property (nonatomic, readwrite) CGFloat fontSize;
@property (nonatomic, readwrite) CGFloat padLeft;
@property (nonatomic, readwrite) CGFloat padRight;
@property (nonatomic, readwrite) CGFloat cornerRadius;
@property (nonatomic, readwrite) BOOL multiline;
@property (nonatomic, readwrite) BOOL current;
@property (nonatomic, readwrite) BOOL locked;
@property (nonatomic, readwrite) BOOL streaming;
@property (nonatomic, readwrite) BOOL guess;
@property (nonatomic, readwrite) BOOL showsKeycap;
@property (nonatomic, readwrite) CGPoint tip;
@property (nonatomic, copy, readwrite, nullable) NSString *targetSignature;
@property (nonatomic, strong, readwrite, nullable) GHOverlayHUDInfo *hud;
@property (nonatomic, readwrite) CGFloat scale;
@end

@implementation GHDrawItem {
    NSString *_contentSignature;
}

+ (instancetype)itemWithKind:(GHDrawKind)kind key:(NSString *)key screen:(NSUInteger)screen frame:(CGRect)frame {
    GHDrawItem *item = [[self alloc] init];
    item.kind = kind;
    item.key = key;
    item.screenIndex = screen;
    item.frame = frame;
    item.clipRect = frame;
    item.scale = 1;
    return item;
}

/// Text enters as hash + length only: signatures end up in diffs and debug descriptions, values must not.
- (NSString *)contentSignature {
    if (_contentSignature) return _contentSignature;
    NSString *hud = self.hud ? [self.hud.segments componentsJoinedByString:@"\x1f"] : @"";
    _contentSignature = [NSString
        stringWithFormat:@"%@|%ld|%lu|%.2f,%.2f,%.2f,%.2f|%.2f,%.2f,%.2f,%.2f|%ld|%lx:%lu|%.1f|%.1f,%.1f|%.1f|%d%d%d%d%d%d|%.2f,%.2f|%@|%@|%.2f",
                         self.key, (long)self.kind, (unsigned long)self.screenIndex, self.frame.origin.x,
                         self.frame.origin.y, self.frame.size.width, self.frame.size.height, self.clipRect.origin.x,
                         self.clipRect.origin.y, self.clipRect.size.width, self.clipRect.size.height, (long)self.anchor,
                         (unsigned long)self.text.hash, (unsigned long)self.text.length, self.fontSize, self.padLeft,
                         self.padRight, self.cornerRadius, self.multiline, self.current, self.locked, self.streaming,
                         self.showsKeycap, self.guess, self.tip.x, self.tip.y, self.targetSignature ?: @"", hud, self.scale];
    return _contentSignature;
}

- (NSString *)description {
    return [NSString stringWithFormat:@"<GHDrawItem %@ screen=%lu frame=%@>", self.key, (unsigned long)self.screenIndex,
                                      NSStringFromRect(self.frame)];
}

@end

#pragma mark - Layout

/// One entry measured against the displays: everything later steps need, in AX global space.
typedef struct {
    BOOL drawable;
    NSUInteger screen;
    CGRect box;     // the control
    CGRect seen;    // the part inside the window and the display
    CGRect bounds;  // window ∩ display: where floating parts (pill, badge) must stay
} GHMeasured;

static GHMeasured GHMeasure(GHOverlayEntry *entry, CGRect window, GHScreenLayout *layout) {
    GHMeasured m = {NO, NSNotFound, entry.axRect, CGRectNull, CGRectNull};
    m.screen = [layout screenIndexForAXRect:entry.axRect];
    if (m.screen == NSNotFound) return m;
    CGRect screenFrame = [layout axFrameAtIndex:m.screen];
    if (GHVisibleFraction(entry.axRect, window, screenFrame) < GHVisibleEnoughFraction) return m;
    m.seen = [layout visiblePartOfAXRect:entry.axRect inWindow:window screen:m.screen];
    m.bounds = GHRectClipped(screenFrame, window);
    m.drawable = GHRectIsUsable(m.seen);
    return m;
}

static GHDrawItem *GHTextItem(GHOverlayEntry *entry, GHMeasured m, BOOL current, BOOL hasKeycap, GHOverlayMode mode, GHScreenLayout *layout) {
    BOOL multiline = mode == GHOverlayModeMultiline;
    NSString *key = [@"text:" stringByAppendingString:entry.signature];
    GHDrawItem *item = [GHDrawItem itemWithKind:GHDrawKindGhostText key:key screen:m.screen
                                          frame:[layout localRectFromAXRect:m.box screen:m.screen]];
    item.clipRect = [layout localRectFromAXRect:m.seen screen:m.screen];
    item.text = entry.displayText;
    item.current = current;
    item.streaming = entry.streaming;
    item.guess = entry.guess;
    item.multiline = multiline;
    item.fontSize = GHGhostFontSize(m.box.size.height, multiline);
    item.padLeft = multiline ? 8 : GHGhostTextPadding(m.box.size.height);
    item.padRight = hasKeycap ? kKeycapGap + kKeycapWidth + kKeycapGap : item.padLeft;
    return item;
}

/// Inside a popup (left of its arrow); past the control for checkboxes and radio groups, inside when there is no room.
static GHDrawItem *GHPillItem(GHOverlayEntry *entry, GHMeasured m, BOOL current, GHOverlayMode mode, GHScreenLayout *layout) {
    CGFloat midY = CGRectGetMidY(m.box), top = midY - kPillHeight / 2;
    CGRect room;
    GHDrawAnchor anchor = GHDrawAnchorRightCenter;
    if (mode == GHOverlayModeSelectPill) {
        CGFloat width = MAX(40, m.box.size.width - kSelectArrowRoom - 14);
        room = CGRectMake(CGRectGetMaxX(m.box) - kSelectArrowRoom - width, top, width, kPillHeight);
    } else if (CGRectGetMaxX(m.box) + kPillRoom <= CGRectGetMaxX(m.bounds)) {
        CGFloat width = MIN(kPillMaxWidth, CGRectGetMaxX(m.bounds) - CGRectGetMaxX(m.box) - 16);
        room = CGRectMake(CGRectGetMaxX(m.box) + 8, top, width, kPillHeight);
        anchor = GHDrawAnchorLeftCenter;
    } else {
        CGFloat width = MIN(kPillMaxWidth, MAX(40, m.box.size.width - 16));
        room = CGRectMake(CGRectGetMaxX(m.box) - 8 - width, top, width, kPillHeight);
    }
    NSString *key = [@"pill:" stringByAppendingString:entry.signature];
    GHDrawItem *item = [GHDrawItem itemWithKind:GHDrawKindPill key:key screen:m.screen
                                          frame:[layout localRectFromAXRect:room screen:m.screen]];
    item.anchor = anchor;
    item.text = entry.displayText;
    item.current = current;
    item.streaming = entry.streaming;
    item.guess = entry.guess;
    item.fontSize = 12;
    item.showsKeycap = current && !entry.locked;
    return item;
}

/// Where the pointer's tip rests: past the ghost text in a field, dead center on small controls.
/// `textLength` > 0 nudges it right of the (estimated) end of single-line ghost text so it does not sit on the words.
static CGPoint GHTipPoint(CGRect box, GHOverlayMode mode, NSUInteger textLength) {
    if (mode == GHOverlayModeTarget || mode == GHOverlayModePill) {
        return CGPointMake(CGRectGetMidX(box), box.origin.y + box.size.height * 0.55);
    }
    CGFloat limit = box.size.width - 56;  // keeps clear of the keycap
    CGFloat dx = MIN(box.size.width * 0.62, limit);
    if (mode == GHOverlayModeText && textLength > 0) {
        CGFloat textEnd = GHGhostTextPadding(box.size.height) + textLength * GHGhostFontSize(box.size.height, NO) * 0.54;
        dx = MIN(MAX(dx, textEnd + 10), limit);
    }
    return CGPointMake(box.origin.x + MAX(20, dx), box.origin.y + MIN(box.size.height * 0.62, 34));
}

static GHDrawItem *GHRingItem(GHOverlayEntry *entry, GHMeasured m, GHOverlayMode mode, GHScreenLayout *layout) {
    CGFloat pad = mode == GHOverlayModePill ? kGroupRingPad : kRingPad;
    CGRect ring = CGRectInset(m.seen, -pad, -pad);
    GHDrawItem *item = [GHDrawItem itemWithKind:GHDrawKindRing key:@"ring" screen:m.screen
                                          frame:[layout localRectFromAXRect:ring screen:m.screen]];
    CGFloat radius = mode == GHOverlayModePill ? 8 : kFieldRadiusGuess + pad;
    item.cornerRadius = MIN(radius, MIN(ring.size.width, ring.size.height) / 2);
    return item;
}

static GHDrawItem *GHCursorItem(GHMeasured m, CGPoint tip, GHScreenLayout *layout) {
    CGRect box = CGRectMake(tip.x - kCursorTipX, tip.y - kCursorTipY, kCursorBox, kCursorBox);
    // Not pixel aligned on purpose: the pointer is a vector shape and its tip must land exactly on `tip`.
    CGPoint local = [layout localPointFromAXPoint:CGPointMake(box.origin.x, CGRectGetMaxY(box)) screen:m.screen];
    GHDrawItem *item = [GHDrawItem itemWithKind:GHDrawKindCursor key:@"cursor" screen:m.screen
                                          frame:CGRectMake(local.x, local.y, kCursorBox, kCursorBox)];
    item.tip = [layout localPointFromAXPoint:tip screen:m.screen];
    return item;
}

static GHDrawItem *GHKeycapItem(GHOverlayEntry *entry, GHMeasured m, GHOverlayMode mode, GHScreenLayout *layout) {
    if (mode != GHOverlayModeText && mode != GHOverlayModeMultiline) return nil;
    if (m.box.size.width < kKeycapMinField) return nil;
    CGFloat x = CGRectGetMaxX(m.box) - kKeycapGap - kKeycapWidth;
    CGFloat y = mode == GHOverlayModeMultiline ? m.box.origin.y + 8 : CGRectGetMidY(m.box) - kKeycapHeight / 2;
    CGRect cap = CGRectMake(x, y, kKeycapWidth, kKeycapHeight);
    if (!CGRectContainsRect(CGRectInset(m.seen, -1, -1), cap)) return nil;  // the right edge is cut off
    GHDrawItem *item = [GHDrawItem itemWithKind:GHDrawKindKeycap key:@"keycap" screen:m.screen
                                          frame:[layout localRectFromAXRect:cap screen:m.screen]];
    item.text = entry.keyName ?: @"Tab";
    return item;
}

/// Bottom-right of the main display, above the Dock. The frame is the room; the layer hugs its content inside it.
static NSArray<GHDrawItem *> *GHHudItems(GHOverlayInput *input, GHScreenLayout *layout) {
    BOOL hasError = input.error.length > 0, hasStatus = input.status.length > 0;
    if ((!input.hud && !hasError && !hasStatus) || layout.count == 0) return @[];
    CGRect screen = [layout frameAtIndex:0], visible = [layout visibleFrameAtIndex:0];
    CGFloat right = CGRectGetMaxX(visible) - screen.origin.x - kHudMargin;
    CGFloat bottom = CGRectGetMinY(visible) - screen.origin.y + kHudMargin;
    CGFloat room = MAX(120, visible.size.width - 2 * kHudMargin);
    NSMutableArray<GHDrawItem *> *items = [NSMutableArray array];
    if (input.hud) {
        GHDrawItem *hud = [GHDrawItem itemWithKind:GHDrawKindHUD key:@"hud" screen:0
                                             frame:CGRectMake(right - room, bottom, room, kHudHeight)];
        hud.anchor = GHDrawAnchorBottomRight;
        hud.hud = [input.hud copy];
        hud.fontSize = 11;
        [items addObject:hud];
        bottom += kHudHeight + kHudGap;
    }
    if (hasError) {
        CGFloat width = MIN(room, kHudErrorMaxWidth);
        GHDrawItem *chip = [GHDrawItem itemWithKind:GHDrawKindHUDError key:@"hud-error" screen:0
                                              frame:CGRectMake(right - width, bottom, width, kHudHeight)];
        chip.anchor = GHDrawAnchorBottomRight;
        chip.text = input.error;
        chip.fontSize = 11;
        [items addObject:chip];
        bottom += kHudHeight + kHudGap;
    }
    if (hasStatus) {
        CGFloat width = MIN(room, kHudErrorMaxWidth);
        GHDrawItem *chip = [GHDrawItem itemWithKind:GHDrawKindHUDStatus key:@"hud-status" screen:0
                                              frame:CGRectMake(right - width, bottom, width, kHudHeight)];
        chip.anchor = GHDrawAnchorBottomRight;
        chip.text = input.status;
        chip.fontSize = 11;
        [items addObject:chip];
    }
    return items;
}

@interface GHOverlayModel ()
@property (nonatomic, copy, readwrite) NSArray<GHDrawItem *> *items;
@property (nonatomic, copy, readwrite) NSString *layoutFingerprint;
@property (nonatomic, readwrite) BOOL currentVisible;
@property (nonatomic, readwrite) CGPoint currentTipAX;
@end

@implementation GHOverlayModel

+ (instancetype)emptyModel {
    GHOverlayModel *model = [[self alloc] init];
    model.items = @[];
    model.layoutFingerprint = @"";
    return model;
}

+ (instancetype)modelWithInput:(GHOverlayInput *)input layout:(GHScreenLayout *)layout {
    GHOverlayModel *model = [self emptyModel];
    model.layoutFingerprint = layout.fingerprint;
    NSMutableArray<GHDrawItem *> *items = [NSMutableArray arrayWithArray:GHHudItems(input, layout)];
    NSMutableSet<NSString *> *seen = [NSMutableSet set];
    NSMutableArray<GHDrawItem *> *chrome = [NSMutableArray array];  // ring, lock, keycap, cursor: above every text

    for (NSUInteger i = 0; i < input.entries.count; i++) {
        GHOverlayEntry *entry = input.entries[i];
        if (entry.signature.length == 0 || [seen containsObject:entry.signature]) continue;  // keys must stay unique
        [seen addObject:entry.signature];
        GHMeasured m = GHMeasure(entry, input.windowAXFrame, layout);
        if (!m.drawable) continue;
        BOOL current = (NSInteger)i == input.currentIndex;
        GHOverlayMode mode = GHOverlayModeForKind(entry.kind);

        BOOL hasText = entry.displayText.length > 0 && !entry.locked;
        // Decided first: ghost text only gives up room on its right when a keycap is really drawn there.
        GHDrawItem *keycap = current && hasText ? GHKeycapItem(entry, m, mode, layout) : nil;
        GHDrawItem *body = nil;
        if (hasText) {
            if (mode == GHOverlayModeText || mode == GHOverlayModeMultiline) body = GHTextItem(entry, m, current, keycap != nil, mode, layout);
            else if (mode != GHOverlayModeTarget) body = GHPillItem(entry, m, current, mode, layout);
        }
        if (body) [items addObject:body];
        if (!current) continue;

        CGPoint tip = GHTipPoint(m.seen, mode, body ? entry.displayText.length : 0);
        model.currentVisible = YES;
        model.currentTipAX = tip;
        [chrome addObject:GHRingItem(entry, m, mode, layout)];
        if (keycap) [chrome addObject:keycap];
        // No ghost cursor on a locked action. Ghost is never going to press it, so a cursor that means
        // "take this" is the wrong thing to draw there -- and its absence, beside the same purple ring
        // everything else gets, is the whole signal. The badge that used to say "Enter to confirm" is gone
        // with it: a ghost's vocabulary is a ring and a cursor, and a pill of instructions is not part of it.
        if (!entry.locked) [chrome addObject:GHCursorItem(m, tip, layout)];
        for (GHDrawItem *item in chrome) {
            item.locked = entry.locked;
            item.targetSignature = entry.signature;
        }
    }
    [items addObjectsFromArray:chrome];
    for (GHDrawItem *item in items) {
        item.scale = [layout scaleAtIndex:item.screenIndex];
        item.current = item.current || item.targetSignature != nil;
    }
    model.items = items;
    return model;
}

- (NSArray<GHDrawItem *> *)itemsForScreen:(NSUInteger)screenIndex {
    NSMutableArray<GHDrawItem *> *out = [NSMutableArray array];
    for (GHDrawItem *item in self.items) {
        if (item.screenIndex == screenIndex) [out addObject:item];
    }
    return out;
}

- (GHDrawItem *)itemWithKey:(NSString *)key screen:(NSUInteger)screenIndex {
    for (GHDrawItem *item in self.items) {
        if (item.screenIndex == screenIndex && [item.key isEqualToString:key]) return item;
    }
    return nil;
}

@end

@interface GHOverlayDiff ()
@property (nonatomic, copy, readwrite) NSArray<GHDrawItem *> *added;
@property (nonatomic, copy, readwrite) NSArray<GHDrawItem *> *changed;
@property (nonatomic, copy, readwrite) NSArray<GHDrawItem *> *unchanged;
@property (nonatomic, copy, readwrite) NSArray<NSString *> *removedKeys;
@end

@implementation GHOverlayDiff

+ (instancetype)diffFromItems:(NSArray<GHDrawItem *> *)oldItems toItems:(NSArray<GHDrawItem *> *)newItems {
    NSMutableDictionary<NSString *, GHDrawItem *> *before = [NSMutableDictionary dictionary];
    for (GHDrawItem *item in oldItems) before[item.key] = item;
    NSMutableArray *added = [NSMutableArray array], *changed = [NSMutableArray array], *unchanged = [NSMutableArray array];
    for (GHDrawItem *item in newItems) {
        GHDrawItem *old = before[item.key];
        [before removeObjectForKey:item.key];
        if (!old) [added addObject:item];
        else if ([old.contentSignature isEqualToString:item.contentSignature]) [unchanged addObject:item];
        else [changed addObject:item];
    }
    NSMutableArray<NSString *> *removed = [NSMutableArray array];
    for (GHDrawItem *item in oldItems) {  // old order, so the result is deterministic
        if (before[item.key]) [removed addObject:item.key];
    }
    GHOverlayDiff *diff = [[self alloc] init];
    diff.added = added;
    diff.changed = changed;
    diff.unchanged = unchanged;
    diff.removedKeys = removed;
    return diff;
}

- (BOOL)isEmpty {
    return self.added.count == 0 && self.changed.count == 0 && self.removedKeys.count == 0;
}

@end
