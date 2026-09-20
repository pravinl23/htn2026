#import "GHAffordance.h"

// Roles, as the accessibility tree spells them. Structural vocabulary only: these say what a node IS, never
// what it is about.
static NSString *const kRoleStaticText = @"AXStaticText";
static NSString *const kRoleSlider = @"AXSlider";
static NSString *const kRoleVideo = @"AXVideo";
static NSString *const kRoleAudio = @"AXAudio";
static NSString *const kRoleImage = @"AXImage";
static NSString *const kRoleSecureTextField = @"AXSecureTextField";

/// How far up from a media element a control may sit and still count as one of its controls.
static const NSUInteger kMediaSeedLift = 4;
/// How far up from a control Ghost looks for that shared ancestor.
static const NSUInteger kMediaControlLift = 3;
/// How far a price-shaped string may be drawn from a control and still be "beside" it, in points.
static const CGFloat kPriceMargin = 120.0;
/// A repeated sibling structure needs at least this many members to be a list rather than a coincidence.
static const NSUInteger kMinListMembers = 3;
/// How far up from a control its list membership is looked for (the row itself, or the tile around it).
static const NSUInteger kListLift = 4;
/// A badge is a small number, not a year or a price.
static const NSUInteger kMaxBadgeCount = 999;
/// What one control is "worth" in characters when the page's text density is measured.
static const double kControlWeight = 200.0;

static const NSUInteger kDefaultMaxNodes = 1500;
static const NSTimeInterval kDefaultTimeBudget = 0.25;

#pragma mark - small helpers

static NSString *GHAffSquash(NSString *_Nullable text) {
    if (text.length == 0) return @"";
    NSArray<NSString *> *parts = [text componentsSeparatedByCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    NSMutableArray<NSString *> *kept = [NSMutableArray array];
    for (NSString *part in parts) if (part.length) [kept addObject:part];
    return [kept componentsJoinedByString:@" "];
}

static BOOL GHAffMatches(NSRegularExpression *pattern, NSString *_Nullable text) {
    if (text.length == 0) return NO;
    return [pattern numberOfMatchesInString:text options:0 range:NSMakeRange(0, text.length)] > 0;
}

static NSRegularExpression *GHAffPattern(NSString *source) {
    return [NSRegularExpression regularExpressionWithPattern:source options:NSRegularExpressionCaseInsensitive error:NULL];
}

/// "0:42", "12:03", "1:03:11": what a player draws beside its scrubber, in every language.
static NSRegularExpression *GHAffDurationPattern(void) {
    static NSRegularExpression *pattern;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ pattern = GHAffPattern(@"^-?\\d{1,3}:[0-5]\\d(:[0-5]\\d)?$"); });
    return pattern;
}

/// A currency symbol beside digits, or digits beside a currency code. Symbols cover most of the world; the
/// codes are the ISO ones, which are not a vendor list.
static NSRegularExpression *GHAffPricePattern(void) {
    static NSRegularExpression *pattern;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        pattern = GHAffPattern(@"[$£€¥₹₩₽₺₪₫฿¢]\\s?\\d|\\d\\s?[$£€¥₹₩₽₺₪₫฿¢]|"
                               @"\\d\\s?(usd|eur|gbp|cad|aud|nzd|jpy|cny|inr|chf|sek|nok|dkk|pln|czk|huf|try|brl|mxn|ars|zar|krw|sgd|hkd|rub|aed|ils)\\b");
    });
    return pattern;
}

/// Naming that means "this slider is the playhead". Structural player vocabulary, not a site's words.
static NSRegularExpression *GHAffScrubPattern(void) {
    static NSRegularExpression *pattern;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ pattern = GHAffPattern(@"\\b(seek|scrub|playhead|elapsed|remaining|time|timeline|progress|position|duration)\\b"); });
    return pattern;
}

/// A role description that says "this node IS a media element". Only ever read off the node's own role words.
static NSRegularExpression *GHAffMediaPattern(void) {
    static NSRegularExpression *pattern;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ pattern = GHAffPattern(@"\\b(video|audio|movie|media player|player)\\b"); });
    return pattern;
}

/// The small count an icon carries: "3", "12", "7 new", "2 items". Never a year, a price or an id.
static NSRegularExpression *GHAffBadgePattern(void) {
    static NSRegularExpression *pattern;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ pattern = GHAffPattern(@"^\\(?(\\d{1,3})\\)?(\\s*(new|unread|items?|messages?|notifications?))?$"); });
    return pattern;
}

static uint32_t GHAffHash(NSString *text) {
    uint32_t hash = 2166136261u;
    const char *bytes = text.UTF8String ?: "";
    for (const char *c = bytes; *c; c++) {
        hash ^= (uint32_t)(unsigned char)*c;
        hash *= 16777619u;
    }
    return hash;
}

#pragma mark - GHPageSignals

@implementation GHPageSignals

- (id)copyWithZone:(NSZone *)zone {
    GHPageSignals *copy = [[GHPageSignals allocWithZone:zone] init];
    copy.hasMediaElement = self.hasMediaElement;
    copy.mainListSignature = self.mainListSignature;
    copy.mainRegionRepeats = self.mainRegionRepeats;
    copy.textDensity = self.textDensity;
    copy.appBundleId = self.appBundleId;
    copy.pathPattern = self.pathPattern;
    copy.isFullscreen = self.isFullscreen;
    copy.previousRole = self.previousRole;
    copy.sensitiveOnScreen = self.sensitiveOnScreen;
    copy.visitedNodes = self.visitedNodes;
    copy.partial = self.partial;
    return copy;
}

- (NSDictionary<NSString *, id> *)toJSONObject {
    NSMutableDictionary<NSString *, id> *json = [NSMutableDictionary dictionary];
    json[@"hasMediaElement"] = @(self.hasMediaElement);
    // Always authoritative: null means "this window has no main list", which is not the same as "unknown".
    json[@"mainListSignature"] = self.mainListSignature ?: (id)[NSNull null];
    json[@"mainRegionRepeats"] = @(self.mainRegionRepeats);
    json[@"textDensity"] = @(isfinite(self.textDensity) ? self.textDensity : 0.0);
    if (self.appBundleId.length) json[@"appBundleId"] = self.appBundleId;
    if (self.pathPattern.length) json[@"pathPattern"] = self.pathPattern;
    if (self.isFullscreen) json[@"isFullscreen"] = @YES;
    if (self.previousRole.length) json[@"previousRole"] = self.previousRole;
    return json;
}

@end

#pragma mark - the scan

/// One visited node. Plain storage: the scan itself is a single bounded walk.
@interface GHAffEntry : NSObject
@property (nonatomic, strong) id<GHAXNode> node;
@property (nonatomic) NSInteger parent;
@property (nonatomic) NSUInteger depth;
@property (nonatomic) BOOL mediaSeed;      // a media element, or a scrubber
@property (nonatomic) BOOL price;          // a price-shaped static text
@property (nonatomic) BOOL secure;         // an AXSecureTextField: nothing in this window may be screenshotted
@property (nonatomic) NSUInteger badge;    // a badge-shaped static text ("3")
@property (nonatomic, copy) NSString *shape;   // role|subrole|first child roles: what makes two siblings "the same"
@property (nonatomic, copy, nullable) NSString *listSignature;
@property (nonatomic) NSUInteger listIndex;
@end

@implementation GHAffEntry
@end

@implementation GHAffordance

+ (BOOL)looksLikeDuration:(NSString *)text {
    return GHAffMatches(GHAffDurationPattern(), GHAffSquash(text));
}

+ (BOOL)looksLikePrice:(NSString *)text {
    NSString *clean = GHAffSquash(text);
    if (clean.length == 0 || clean.length > 40) return NO;
    return GHAffMatches(GHAffPricePattern(), clean);
}

+ (NSUInteger)countInBadgeText:(NSString *)text {
    NSString *clean = GHAffSquash(text);
    if (clean.length == 0 || clean.length > 20) return 0;
    NSTextCheckingResult *match = [GHAffBadgePattern() firstMatchInString:clean options:0 range:NSMakeRange(0, clean.length)];
    if (!match || match.numberOfRanges < 2) return 0;
    NSInteger value = [[clean substringWithRange:[match rangeAtIndex:1]] integerValue];
    return (value > 0 && value <= (NSInteger)kMaxBadgeCount) ? (NSUInteger)value : 0;
}

+ (GHPageSignals *)annotateResult:(GHCaptureResult *)result window:(id<GHAXNode>)window {
    return [self annotateResult:result window:window maxNodes:kDefaultMaxNodes timeBudget:kDefaultTimeBudget];
}

+ (GHPageSignals *)annotateResult:(GHCaptureResult *)result
                           window:(id<GHAXNode>)window
                         maxNodes:(NSUInteger)maxNodes
                       timeBudget:(NSTimeInterval)timeBudget {
    GHPageSignals *signals = [[GHPageSignals alloc] init];
    if (!window) return signals;

    NSMutableArray<GHAffEntry *> *entries = [NSMutableArray array];
    NSMutableArray<NSMutableArray<NSNumber *> *> *children = [NSMutableArray array];
    GHAXWalkBudget budget = GHAXWalkBudgetMake(maxNodes ?: kDefaultMaxNodes, timeBudget > 0 ? timeBudget : kDefaultTimeBudget);
    double textChars = 0;
    [self visit:window parent:-1 depth:0 entries:entries children:children budget:&budget textChars:&textChars];

    signals.visitedNodes = entries.count;
    signals.partial = budget.exhausted || budget.hung;
    CGRect windowFrame = CGRectIsEmpty(result.windowFrame) ? window.frame : result.windowFrame;
    double windowArea = MAX(0.0, (double)windowFrame.size.width) * MAX(0.0, (double)windowFrame.size.height);
    for (GHAffEntry *entry in entries) {
        if (entry.secure) signals.sensitiveOnScreen = YES;
        if (![self isMediaElement:entry.node]) continue;
        entry.mediaSeed = YES;
        signals.hasMediaElement = YES;
        // Already filling the window: proposing fullscreen again is the classic wrong ghost, so the core is
        // told and the priors leave a watching user alone (docs/anywhere.md section 3).
        CGRect frame = entry.node.frame;
        double area = MAX(0.0, (double)frame.size.width) * MAX(0.0, (double)frame.size.height);
        if (windowArea > 0 && area / windowArea >= 0.9) signals.isFullscreen = YES;
    }
    [self markScrubbersIn:entries children:children];
    [self findListsIn:entries children:children];

    NSUInteger repeats = 0;
    signals.mainListSignature = [self mainListSignatureIn:entries repeats:&repeats];
    signals.mainRegionRepeats = repeats;

    NSArray<GHField *> *fields = result.fields ?: @[];
    NSUInteger controls = 0;
    for (GHField *field in fields) if (!field.unnamed) controls++;
    controls = MAX(controls, fields.count / 2);
    signals.textDensity = textChars / (textChars + kControlWeight * (double)controls + 1.0);

    [self annotateFields:fields result:result entries:entries children:children];
    return signals;
}

#pragma mark the walk

+ (void)visit:(id<GHAXNode>)node
       parent:(NSInteger)parent
        depth:(NSUInteger)depth
      entries:(NSMutableArray<GHAffEntry *> *)entries
     children:(NSMutableArray<NSMutableArray<NSNumber *> *> *)children
       budget:(GHAXWalkBudget *)budget
    textChars:(double *)textChars {
    if (!GHAXWalkBudgetSpend(budget, node)) return;
    GHAffEntry *entry = [[GHAffEntry alloc] init];
    entry.node = node;
    entry.parent = parent;
    entry.depth = depth;
    entry.shape = [self shapeOf:node];
    NSInteger index = (NSInteger)entries.count;
    [entries addObject:entry];
    [children addObject:[NSMutableArray array]];
    if (parent >= 0) [children[(NSUInteger)parent] addObject:@(index)];

    if ([node.role isEqualToString:kRoleSecureTextField] || [node.subrole isEqualToString:kRoleSecureTextField]) {
        entry.secure = YES;
    }

    if ([node.role isEqualToString:kRoleStaticText]) {
        NSString *text = GHAffSquash(node.value ?: node.title);
        // Page text is COUNTED and thrown away: the count is the only thing that survives this line.
        *textChars += (double)text.length;
        if ([self looksLikePrice:text]) entry.price = YES;
        entry.badge = [self countInBadgeText:text];
    }

    if (depth >= 40) return;
    for (id<GHAXNode> child in node.children) {
        if (budget->exhausted || budget->hung) return;
        [self visit:child parent:index depth:depth + 1 entries:entries children:children budget:budget textChars:textChars];
    }
}

/// role|subrole|the roles of the first children: what makes two siblings "the same kind of thing".
+ (NSString *)shapeOf:(id<GHAXNode>)node {
    NSMutableString *shape = [NSMutableString stringWithFormat:@"%@|%@", node.role ?: @"?", node.subrole ?: @""];
    NSUInteger taken = 0;
    for (id<GHAXNode> child in node.children) {
        [shape appendFormat:@"|%@", child.role ?: @"?"];
        if (++taken >= 4) break;
    }
    return shape;
}

#pragma mark media

+ (BOOL)isMediaElement:(id<GHAXNode>)node {
    NSString *role = node.role ?: @"", *subrole = node.subrole ?: @"";
    if ([role isEqualToString:kRoleVideo] || [role isEqualToString:kRoleAudio]) return YES;
    if ([subrole isEqualToString:kRoleVideo] || [subrole isEqualToString:kRoleAudio]) return YES;
    // A role DESCRIPTION is the app's own word for what the node is ("video", "audio player"), never its content.
    // An image described as a "player" is a thumbnail, so images are excluded.
    if ([role isEqualToString:kRoleImage]) return NO;
    return GHAffMatches(GHAffMediaPattern(), GHAffSquash(node.roleDescription));
}

/// A slider is the playhead when its own naming says so, or when a duration is drawn beside it.
+ (void)markScrubbersIn:(NSArray<GHAffEntry *> *)entries children:(NSArray<NSMutableArray<NSNumber *> *> *)children {
    for (NSUInteger i = 0; i < entries.count; i++) {
        GHAffEntry *entry = entries[i];
        if (entry.mediaSeed || ![entry.node.role isEqualToString:kRoleSlider]) continue;
        id<GHAXNode> node = entry.node;
        NSString *naming = GHAffSquash([@[node.title ?: @"", node.axDescription ?: @"", node.roleDescription ?: @"", node.identifier ?: @""] componentsJoinedByString:@" "]);
        BOOL named = GHAffMatches(GHAffScrubPattern(), naming);
        BOOL timed = [self looksLikeDuration:node.value];
        if (!named && !timed && entry.parent >= 0) {
            for (NSNumber *sibling in children[(NSUInteger)entry.parent]) {
                GHAffEntry *other = entries[sibling.unsignedIntegerValue];
                if (other != entry && [other.node.role isEqualToString:kRoleStaticText] && [self looksLikeDuration:other.node.value]) {
                    timed = YES;
                    break;
                }
            }
        }
        if (named || timed) entry.mediaSeed = YES;
    }
}

#pragma mark lists

+ (void)findListsIn:(NSArray<GHAffEntry *> *)entries children:(NSArray<NSMutableArray<NSNumber *> *> *)children {
    for (NSUInteger i = 0; i < entries.count; i++) {
        NSArray<NSNumber *> *kids = children[i];
        if (kids.count < kMinListMembers) continue;
        NSMutableDictionary<NSString *, NSMutableArray<NSNumber *> *> *byShape = [NSMutableDictionary dictionary];
        for (NSNumber *kid in kids) {
            NSString *shape = entries[kid.unsignedIntegerValue].shape ?: @"";
            NSMutableArray<NSNumber *> *group = byShape[shape];
            if (!group) byShape[shape] = group = [NSMutableArray array];
            [group addObject:kid];
        }
        for (NSString *shape in byShape) {
            NSArray<NSNumber *> *group = byShape[shape];
            if (group.count < kMinListMembers) continue;
            // The signature names the STRUCTURE, never the content: the same grid keeps its key across reloads.
            NSString *signature = [NSString stringWithFormat:@"l%08x", GHAffHash([NSString stringWithFormat:@"%@#%@", entries[i].shape ?: @"", shape])];
            NSUInteger index = 0;
            for (NSNumber *kid in group) {
                GHAffEntry *member = entries[kid.unsignedIntegerValue];
                member.listSignature = signature;
                member.listIndex = index++;
            }
        }
    }
}

/// The main list is the repeated structure that carries the page: many members, each of a real size. A
/// navigation bar has many members too, but they are small, which is exactly what tells them apart.
+ (NSString *)mainListSignatureIn:(NSArray<GHAffEntry *> *)entries repeats:(NSUInteger *)repeats {
    NSMutableDictionary<NSString *, NSNumber *> *counts = [NSMutableDictionary dictionary];
    NSMutableDictionary<NSString *, NSNumber *> *areas = [NSMutableDictionary dictionary];
    for (GHAffEntry *entry in entries) {
        NSString *signature = entry.listSignature;
        if (!signature) continue;
        CGRect frame = entry.node.frame;
        double area = MAX(0.0, (double)frame.size.width) * MAX(0.0, (double)frame.size.height);
        counts[signature] = @(counts[signature].unsignedIntegerValue + 1);
        areas[signature] = @(areas[signature].doubleValue + area);
    }
    NSString *best = nil;
    double bestScore = 0;
    NSUInteger bestCount = 0;
    for (NSString *signature in counts) {
        NSUInteger count = counts[signature].unsignedIntegerValue;
        double score = areas[signature].doubleValue; // total drawn area: many members, each of a real size
        if (score > bestScore || (score == bestScore && count > bestCount)) {
            best = signature;
            bestScore = score;
            bestCount = count;
        }
    }
    if (repeats) *repeats = bestCount;
    return best;
}

#pragma mark annotation

+ (void)annotateFields:(NSArray<GHField *> *)fields
                result:(GHCaptureResult *)result
               entries:(NSArray<GHAffEntry *> *)entries
              children:(NSArray<NSMutableArray<NSNumber *> *> *)children {
    if (fields.count == 0 || entries.count == 0) return;

    // Where a media cluster reaches: the seeds themselves and their near ancestors.
    NSMutableIndexSet *mediaContainers = [NSMutableIndexSet indexSet];
    NSMutableArray<NSValue *> *priceRects = [NSMutableArray array];
    for (NSUInteger i = 0; i < entries.count; i++) {
        if (entries[i].mediaSeed) [self lift:i by:kMediaSeedLift entries:entries into:mediaContainers];
        // "Beside it" is a question about pixels, not about the tree: a shared ancestor high enough up would
        // make every control on a shop page look priced (measured: 6 of 6 on a synthetic shop).
        if (entries[i].price && !CGRectIsEmpty(entries[i].node.frame)) [priceRects addObject:[NSValue valueWithRect:NSRectFromCGRect(entries[i].node.frame)]];
    }

    for (GHField *field in fields) {
        id<GHAXNode> node = [result nodeForSignature:field.signature];
        NSInteger index = [self indexOfNode:node in:entries];
        if (index < 0) continue;

        NSMutableIndexSet *near = [NSMutableIndexSet indexSet];
        [self lift:(NSUInteger)index by:kMediaControlLift entries:entries into:near];
        field.insideMediaControls = [self set:near meets:mediaContainers];
        field.nearbyPrice = [self isRect:field.rect nearAnyOf:priceRects];

        for (NSInteger up = index, lift = 0; up >= 0 && lift <= (NSInteger)kListLift; up = entries[(NSUInteger)up].parent, lift++) {
            GHAffEntry *entry = entries[(NSUInteger)up];
            if (!entry.listSignature) continue;
            field.listSignature = entry.listSignature;
            field.listIndex = entry.listIndex;
            break;
        }

        field.badgeCount = [self badgeUnder:(NSUInteger)index entries:entries children:children];
    }
}

/// `index` and its ancestors, up to `lift` levels.
+ (void)lift:(NSUInteger)index by:(NSUInteger)lift entries:(NSArray<GHAffEntry *> *)entries into:(NSMutableIndexSet *)set {
    NSInteger at = (NSInteger)index;
    for (NSUInteger step = 0; at >= 0 && step <= lift; step++) {
        [set addIndex:(NSUInteger)at];
        at = entries[(NSUInteger)at].parent;
    }
}

/// A price is "beside" a control when it is drawn inside the control's own box grown by about its own size:
/// a product tile holds its price, a header's cart button does not hold the prices further down the page.
+ (BOOL)isRect:(CGRect)rect nearAnyOf:(NSArray<NSValue *> *)rects {
    if (CGRectIsEmpty(rect) || rects.count == 0) return NO;
    CGFloat margin = MIN(kPriceMargin, MAX(24.0, rect.size.height));
    CGRect grown = CGRectInset(rect, -margin, -margin);
    for (NSValue *value in rects) {
        if (CGRectIntersectsRect(grown, NSRectToCGRect(value.rectValue))) return YES;
    }
    return NO;
}

+ (BOOL)set:(NSIndexSet *)a meets:(NSIndexSet *)b {
    __block BOOL met = NO;
    [a enumerateIndexesUsingBlock:^(NSUInteger index, BOOL *stop) {
        if ([b containsIndex:index]) {
            met = YES;
            *stop = YES;
        }
    }];
    return met;
}

/// A small count drawn ON the control: its own short name, or a static text just inside it.
+ (NSUInteger)badgeUnder:(NSUInteger)index entries:(NSArray<GHAffEntry *> *)entries children:(NSArray<NSMutableArray<NSNumber *> *> *)children {
    id<GHAXNode> node = entries[index].node;
    NSUInteger own = [self countInBadgeText:node.axDescription];
    if (own > 0) return own;
    NSMutableArray<NSNumber *> *frontier = [NSMutableArray arrayWithObject:@(index)];
    for (NSUInteger depth = 0; depth < 2 && frontier.count > 0; depth++) {
        NSMutableArray<NSNumber *> *next = [NSMutableArray array];
        for (NSNumber *at in frontier) {
            for (NSNumber *kid in children[at.unsignedIntegerValue]) {
                GHAffEntry *child = entries[kid.unsignedIntegerValue];
                if (child.badge > 0) return child.badge;
                [next addObject:kid];
            }
        }
        frontier = next;
    }
    return 0;
}

+ (NSInteger)indexOfNode:(id<GHAXNode>)node in:(NSArray<GHAffEntry *> *)entries {
    if (!node) return -1;
    for (NSUInteger i = 0; i < entries.count; i++) {
        if ([entries[i].node isSameNode:node]) return (NSInteger)i;
    }
    return -1;
}

@end
