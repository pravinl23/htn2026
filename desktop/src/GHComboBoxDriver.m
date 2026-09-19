#import "GHComboBoxDriver.h"
#import "GHLog.h"
#import <stdatomic.h>

const double GHComboBoxMatchThreshold = 0.7;

NSString *const GHComboBoxReasonUnsupported = @"unsupported";
NSString *const GHComboBoxReasonGone = @"gone";
NSString *const GHComboBoxReasonDemographic = @"demographic";
NSString *const GHComboBoxReasonSensitive = @"sensitive";
NSString *const GHComboBoxReasonDisabled = @"disabled";
NSString *const GHComboBoxReasonHasValue = @"has-value";
NSString *const GHComboBoxReasonNoFrontmostApp = @"no-frontmost-app";
NSString *const GHComboBoxReasonNotFocused = @"not-focused";
NSString *const GHComboBoxReasonFocusChanged = @"focus-changed";
NSString *const GHComboBoxReasonNoList = @"no-list";
NSString *const GHComboBoxReasonNoMatchingOption = @"no-matching-option";
NSString *const GHComboBoxReasonOptionVanished = @"option-vanished";
NSString *const GHComboBoxReasonNoHighlight = @"no-highlight";
NSString *const GHComboBoxReasonBusy = @"busy";
NSString *const GHComboBoxReasonTypingInterrupted = @"typing-interrupted";
NSString *const GHComboBoxReasonNotVerified = @"not-verified";
NSString *const GHComboBoxReasonListClosed = @"list-closed";
NSString *const GHComboBoxReasonKeysRefused = @"keys-refused";
NSString *const GHComboBoxReasonAppChanged = @"app-changed";
NSString *const GHComboBoxReasonUserKey = @"user-key";
NSString *const GHComboBoxReasonCancelled = @"cancelled";

NSString *const GHComboBoxMethodNone = @"none";
NSString *const GHComboBoxMethodPress = @"press";
NSString *const GHComboBoxMethodKeys = @"keys";

static const NSUInteger kListSiblingScan = 8;
static const NSUInteger kListLevelsUp = 4;
static const NSUInteger kListSearchNodes = 300;
static const NSUInteger kOptionSearchNodes = 400;
static const NSUInteger kMaxBackspaces = 256;
const NSTimeInterval GHComboBoxListSearchSeconds = 0.2;

#pragma mark - matchOption (port of shared/src/resolve.ts)

static NSRegularExpression *GHRegex(NSString *pattern) {
    return [NSRegularExpression regularExpressionWithPattern:pattern options:NSRegularExpressionCaseInsensitive error:NULL];
}

static NSString *GHReplace(NSString *text, NSString *pattern, NSString *templ, BOOL caseSensitive) {
    NSRegularExpression *regex = [NSRegularExpression regularExpressionWithPattern:pattern options:caseSensitive ? 0 : NSRegularExpressionCaseInsensitive error:NULL];
    return [regex stringByReplacingMatchesInString:text options:0 range:NSMakeRange(0, text.length) withTemplate:templ];
}

static BOOL GHMatches(NSString *text, NSString *pattern) {
    return [GHRegex(pattern) firstMatchInString:text options:0 range:NSMakeRange(0, text.length)] != nil;
}

/// shared normalize(): camelCase split, lower case, _-./:* to spaces, collapsed whitespace.
static NSString *GHMatchNormalize(NSString *text) {
    NSString *s = GHReplace(text ?: @"", @"([a-z])([A-Z])", @"$1 $2", YES).lowercaseString;
    s = GHReplace(s, @"[_\\-./:*]+", @" ", NO);
    s = GHReplace(s, @"\\s+", @" ", NO);
    return [s stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

static NSArray<NSString *> *GHMatchWords(NSString *text) {
    NSMutableArray<NSString *> *words = [NSMutableArray array];
    for (NSString *part in [GHMatchNormalize(text) componentsSeparatedByCharactersInSet:NSCharacterSet.alphanumericCharacterSet.invertedSet]) {
        if (part.length) [words addObject:part];
    }
    return words;
}

static NSSet<NSString *> *GHMatchKeywords(NSString *text) {
    static NSSet<NSString *> *stopwords;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ stopwords = [NSSet setWithArray:@[ @"of", @"the", @"and", @"in", @"at", @"for", @"to", @"or", @"an" ]]; });
    NSMutableSet<NSString *> *keywords = [NSMutableSet set];
    for (NSString *word in GHMatchWords(text)) if (word.length > 1 && ![stopwords containsObject:word]) [keywords addObject:word];
    return keywords;
}

static double GHMatchOverlap(NSString *a, NSString *b) {
    NSSet<NSString *> *ta = GHMatchKeywords(a), *tb = GHMatchKeywords(b);
    if (ta.count == 0 || tb.count == 0) return 0;
    NSUInteger shared = 0;
    for (NSString *word in ta) if ([tb containsObject:word]) shared++;
    return (double)shared / (double)MAX(ta.count, tb.count);
}

static BOOL GHContainsWords(NSArray<NSString *> *haystack, NSArray<NSString *> *needle) {
    if (needle.count == 0 || needle.count > haystack.count) return NO;
    for (NSUInteger i = 0; i + needle.count <= haystack.count; i++) {
        BOOL all = YES;
        for (NSUInteger j = 0; j < needle.count && all; j++) all = [haystack[i + j] isEqualToString:needle[j]];
        if (all) return YES;
    }
    return NO;
}

static double GHContainmentScore(NSString *label, NSString *target) {
    NSArray<NSString *> *lw = GHMatchWords(label), *tw = GHMatchWords(target);
    if (GHContainsWords(lw, tw)) return 0.88;
    return GHContainsWords(tw, lw) && GHMatchOverlap(label, target) > 0.5 ? 0.88 : 0;
}

static double GHOptionScore(NSString *option, NSString *answer) {
    NSString *target = GHMatchNormalize(answer);
    NSString *label = GHMatchNormalize(option);
    if ([label isEqualToString:target]) return 1;
    NSString *trimmed = [answer stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    BOOL wantsYes = GHMatches(trimmed, @"^(y|yes|true|1)$");
    BOOL wantsNo = GHMatches(trimmed, @"^(n|no|false|0)$");
    if (wantsYes || wantsNo) {
        NSString *first = GHMatchWords(option).firstObject ?: @"";
        NSString *value = [option stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        BOOL word = GHMatches(first, wantsYes ? @"^(y|yes|true)$" : @"^(n|no|false)$");
        BOOL flag = GHMatches(value, wantsYes ? @"^(y|yes|true|1)$" : @"^(n|no|false|0)$");
        return word || flag ? 0.95 : 0;
    }
    double contained = GHContainmentScore(label, target);
    if (contained > 0) return contained;
    double shared = GHMatchOverlap(label, target);
    return shared >= 0.6 ? 0.6 + 0.25 * shared : 0;
}

GHOptionMatch GHMatchOption(NSArray<NSString *> *options, NSString *answer) {
    GHOptionMatch none = { -1, 0 };
    if (answer.length == 0) return none;
    NSInteger best = -1;
    double bestScore = -1, runnerUp = -1;
    for (NSUInteger i = 0; i < options.count; i++) {
        NSString *option = options[i];
        NSString *trimmed = [option stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        if (trimmed.length == 0 || GHMatches(trimmed, @"^(select|choose|please|--)")) continue;
        double score = GHOptionScore(option, answer);
        if (score > bestScore) { runnerUp = bestScore; bestScore = score; best = (NSInteger)i; }
        else if (score > runnerUp) runnerUp = score;
    }
    if (best < 0 || bestScore < GHComboBoxMatchThreshold) return none;
    // "Yes, as a citizen" vs "Yes, with a permit": picking one would be a guess.
    if (runnerUp == bestScore && bestScore < 1) return none;
    return (GHOptionMatch){ best, bestScore };
}

#pragma mark - result

@interface GHComboBoxResult ()
@property (nonatomic, readwrite) GHComboBoxOutcome outcome;
@property (nonatomic, readwrite, copy, nullable) NSString *reason;
@property (nonatomic, readwrite, copy) NSString *method;
@property (nonatomic, readwrite) double score;
@property (nonatomic, readwrite) NSUInteger optionCount;
@property (nonatomic, readwrite) BOOL typed;
@property (nonatomic, readwrite) BOOL pressedEscape;
@property (nonatomic, readwrite) BOOL clearedTyping;
@property (nonatomic, readwrite) NSTimeInterval elapsed;
@end

@implementation GHComboBoxResult
- (BOOL)chosen { return self.outcome == GHComboBoxOutcomeChosen; }
- (BOOL)skipsField { return self.outcome == GHComboBoxOutcomeSkipped; }
- (BOOL)stopsWalk { return self.outcome == GHComboBoxOutcomeFailed; }
- (NSString *)description {
    NSString *outcome = self.chosen ? @"chosen" : (self.skipsField ? @"skipped" : @"failed");
    return [NSString stringWithFormat:@"<GHComboBoxResult %@ reason=%@ method=%@ score=%.2f escape=%d cleared=%d>", outcome,
            self.reason ?: @"-", self.method, self.score, self.pressedEscape, self.clearedTyping];
}
@end

#pragma mark - tree helpers

static NSString *GHTrimmed(NSString *text) {
    return [text ?: @"" stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

static BOOL GHIsControlRole(NSString *role) {
    static NSSet<NSString *> *roles;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        roles = [NSSet setWithArray:@[ @"AXComboBox", @"AXTextField", @"AXTextArea", @"AXCheckBox", @"AXRadioButton", @"AXRadioGroup",
                                       @"AXPopUpButton", @"AXSecureTextField", @"AXSlider", @"AXLink" ]];
    });
    return role && [roles containsObject:role];
}

static BOOL GHIsLiveRegion(id<GHAXNode> node) {
    NSString *description = node.roleDescription.lowercaseString ?: @"";
    NSString *subrole = node.subrole ?: @"";
    return [description isEqualToString:@"log"] || [description isEqualToString:@"status"] || [description isEqualToString:@"alert"]
        || [subrole isEqualToString:@"AXApplicationLog"] || [subrole isEqualToString:@"AXApplicationStatus"] || [subrole isEqualToString:@"AXApplicationAlert"];
}

static BOOL GHIsNotice(NSString *text) {
    return GHMatches(GHTrimmed(text), @"^(no options?|no results?( found)?|no matches( found)?|nothing found|loading\\W*|searching\\W*|type to search.*)$");
}

/// Document-order walk (depth first), bounded by `budget` (nodes and wall clock; a hung app stops it). `visit`
/// returns NO to skip the node's children.
static void GHWalk(id<GHAXNode> root, NSUInteger maxDepth, GHAXWalkBudget *budget, BOOL (^visit)(id<GHAXNode> node, NSUInteger depth, BOOL *stop)) {
    NSMutableArray<id<GHAXNode>> *stack = [NSMutableArray arrayWithObject:root];
    NSMutableArray<NSNumber *> *depths = [NSMutableArray arrayWithObject:@0];
    BOOL stop = NO;
    while (stack.count && !stop) {
        id<GHAXNode> node = stack.lastObject;
        NSUInteger depth = depths.lastObject.unsignedIntegerValue;
        [stack removeLastObject];
        [depths removeLastObject];
        if (!GHAXWalkBudgetSpend(budget, node)) break;
        if (!visit(node, depth, &stop) || stop || depth >= maxDepth) continue;
        NSArray<id<GHAXNode>> *children = node.children;
        for (NSInteger i = (NSInteger)children.count - 1; i >= 0; i--) {
            [stack addObject:children[(NSUInteger)i]];
            [depths addObject:@(depth + 1)];
        }
    }
}

static NSUInteger GHIndexOfNode(NSArray<id<GHAXNode>> *nodes, id<GHAXNode> node) {
    for (NSUInteger i = 0; i < nodes.count; i++) if ([nodes[i] isSameNode:node]) return i;
    return NSNotFound;
}

static NSUInteger GHComposedLength(NSString *text) {
    __block NSUInteger count = 0;
    [text enumerateSubstringsInRange:NSMakeRange(0, text.length) options:NSStringEnumerationByComposedCharacterSequences
                          usingBlock:^(NSString *substring, NSRange range, NSRange enclosing, BOOL *stop) { count++; }];
    return count;
}

static BOOL GHSameText(NSString *a, NSString *b) {
    NSString *x = [GHWriter comparable:a], *y = [GHWriter comparable:b];
    return x.length > 0 && [x isEqualToString:y];
}

#pragma mark - driver

@implementation GHComboBoxDriver {
    _Atomic(bool) _active;
    _Atomic(bool) _userKeySeen;
    NSUInteger _generation;
    void (^_completion)(GHComboBoxResult *);
    id<GHAXNode> _combo;
    NSString *_answer;
    NSString *_label;
    NSString *_chosenText;
    double _score;
    NSUInteger _optionCount;
    pid_t _pid;
    BOOL _typed;
    NSTimeInterval _started;
}

- (instancetype)initWithActuator:(id<GHAXActuating>)actuator poster:(id<GHKeyPosting>)poster state:(id<GHDesktopState>)state {
    if ((self = [super init])) {
        _actuator = actuator;
        _poster = poster;
        _state = state;
        _threshold = GHComboBoxMatchThreshold;
        _pollInterval = 0.1;
        _focusSettleDelay = 0.05;
        _listTimeout = 1.5;
        _verifyDelay = 0.15;
        _keyStepDelay = 0.06;
        _after = ^(NSTimeInterval delay, dispatch_block_t block) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)), dispatch_get_main_queue(), block);
        };
        _clock = ^NSTimeInterval { return NSProcessInfo.processInfo.systemUptime; };
        self.matcher = nil;
        self.isHighlighted = nil;
    }
    return self;
}

- (void)setMatcher:(GHOptionMatcher)matcher {
    if (matcher) { _matcher = [matcher copy]; return; }
    _matcher = ^GHOptionMatch(NSArray<NSString *> *options, NSString *answer) { return GHMatchOption(options, answer); };
}

- (void)setIsHighlighted:(BOOL (^)(id<GHAXNode>))isHighlighted {
    if (isHighlighted) { _isHighlighted = [isHighlighted copy]; return; }
    _isHighlighted = ^BOOL(id<GHAXNode> option) {
        if (option.isFocused) return YES;
        AXUIElementRef element = option.axElement;
        if (!element) return NO;
        CFTypeRef value = NULL;
        BOOL selected = NO;
        if (AXUIElementCopyAttributeValue(element, kAXSelectedAttribute, &value) == kAXErrorSuccess && value) {
            selected = CFGetTypeID(value) == CFBooleanGetTypeID() && CFBooleanGetValue((CFBooleanRef)value);
        }
        if (value) CFRelease(value);
        return selected;
    };
}

#pragma mark pure

+ (BOOL)isDemographicText:(NSString *)text {
    if (text.length == 0) return NO;
    NSString *normal = GHMatchNormalize(text);
    return GHMatches(normal, @"\\b(gender|sex|race|racial|ethnic\\w*|hispanic|latin[oax]|veteran|military (status|service)|disabilit\\w+|disabled"
                              "|pronouns?|sexual orientation|lgbtq?\\w*|transgender|marital|religio\\w+|age (range|group)|indigenous|aboriginal"
                              "|first nations|visible minority|caste|date of birth|birth ?date|birthday|dob|how old|age)\\b");
}

+ (BOOL)isDemographicComboBox:(id<GHAXNode>)node {
    id<GHAXNode> titleElement = node.titleUIElement;
    for (NSString *text in @[ node.title ?: @"", node.axDescription ?: @"", node.placeholder ?: @"", node.help ?: @"", node.identifier ?: @"",
                              titleElement.value ?: @"", titleElement.title ?: @"" ]) {
        if ([self isDemographicText:text]) return YES;
    }
    return NO;
}

+ (BOOL)isComboBox:(id<GHAXNode>)node {
    if ([node.role isEqualToString:@"AXComboBox"]) return YES;
    NSString *description = node.roleDescription.lowercaseString ?: @"";
    return [node.role isEqualToString:@"AXTextField"] && ([description containsString:@"combo box"] || [description containsString:@"combobox"]);
}

static BOOL GHLooksLikeList(id<GHAXNode> node) {
    if ([node.subrole isEqualToString:@"AXContentList"]) return NO;   // a bulleted list in the page text
    NSString *description = node.roleDescription.lowercaseString ?: @"";
    if ([description isEqualToString:@"content list"]) return NO;
    if ([node.role isEqualToString:@"AXList"] || [node.role isEqualToString:@"AXMenu"]) return YES;
    return [description isEqualToString:@"list box"] || [description isEqualToString:@"listbox"] || [description isEqualToString:@"menu"];
}

static NSArray<id<GHAXNode>> *GHOptionsInList(id<GHAXNode> list, GHAXWalkBudget *outer);

/// A list of options: list-like, holds options, and no form control inside (a checkbox group is not a menu).
static BOOL GHIsOptionList(id<GHAXNode> node, GHAXWalkBudget *outer) {
    if (!GHLooksLikeList(node)) return NO;
    __block BOOL hasControl = NO;
    GHAXWalkBudget budget = GHAXWalkBudgetNested(outer, kOptionSearchNodes);
    GHWalk(node, 5, &budget, ^BOOL(id<GHAXNode> child, NSUInteger depth, BOOL *stop) {
        if (depth > 0 && GHIsControlRole(child.role)) { hasControl = YES; *stop = YES; }
        return YES;
    });
    GHAXWalkBudgetAbsorb(outer, &budget);
    if (budget.hung) return NO;   // the app stopped answering: nothing it shows is trusted as a list
    return !hasControl && GHOptionsInList(node, outer).count > 0;
}

static id<GHAXNode> GHFindOptionList(id<GHAXNode> root, NSUInteger maxDepth, GHAXWalkBudget *outer) {
    if (outer->hung || outer->exhausted) return nil;
    __block id<GHAXNode> found = nil;
    GHAXWalkBudget budget = GHAXWalkBudgetNested(outer, kListSearchNodes);
    GHWalk(root, maxDepth, &budget, ^BOOL(id<GHAXNode> node, NSUInteger depth, BOOL *stop) {
        if (GHIsOptionList(node, outer)) { found = node; *stop = YES; return NO; }
        if (outer->hung || outer->exhausted) { *stop = YES; return NO; }
        return ![node.subrole isEqualToString:@"AXContentList"];
    });
    GHAXWalkBudgetAbsorb(outer, &budget);
    return found;
}

+ (id<GHAXNode>)listForComboBox:(id<GHAXNode>)comboBox {
    // One wall-clock budget for the whole search (it runs inside every poll and every key guard).
    GHAXWalkBudget overall = GHAXWalkBudgetMake(NSUIntegerMax, GHComboBoxListSearchSeconds);
    if (!GHAXWalkBudgetSpend(&overall, comboBox)) return nil;
    // A native combo box owns its list.
    for (id<GHAXNode> child in comboBox.children) {
        id<GHAXNode> list = GHFindOptionList(child, 4, &overall);
        if (list) return list;
        if (overall.hung || overall.exhausted) return nil;
    }
    // react-select and friends: the menu follows the control, before the next field starts.
    id<GHAXNode> child = comboBox;
    id<GHAXNode> parent = comboBox.parent;
    for (NSUInteger level = 0; parent && level < kListLevelsUp; level++) {
        NSArray<id<GHAXNode>> *siblings = parent.children;
        NSUInteger index = GHIndexOfNode(siblings, child);
        if (index != NSNotFound) {
            for (NSUInteger i = index + 1; i < siblings.count && i <= index + kListSiblingScan; i++) {
                id<GHAXNode> sibling = siblings[i];
                if (GHIsControlRole(sibling.role) || [sibling.role isEqualToString:@"AXHeading"] || [sibling.role isEqualToString:@"AXSplitter"]) break;
                id<GHAXNode> list = GHFindOptionList(sibling, 6, &overall);
                if (list) return list;
                if (overall.hung || overall.exhausted) return nil;
            }
        }
        if ([parent.role isEqualToString:@"AXWebArea"]) break;
        child = parent;
        parent = parent.parent;
    }
    // A menu rendered in a portal at the end of the page: only among the web area's LAST children, and only after the
    // subtree that holds this combobox (never inside it: that is where other fields' menus live).
    id<GHAXNode> top = comboBox;
    id<GHAXNode> webArea = comboBox.parent;
    for (NSUInteger level = 0; webArea && ![webArea.role isEqualToString:@"AXWebArea"] && level < 64; level++) {
        top = webArea;
        webArea = webArea.parent;
    }
    if (![webArea.role isEqualToString:@"AXWebArea"]) return nil;
    NSArray<id<GHAXNode>> *pageChildren = webArea.children;
    NSUInteger topIndex = GHIndexOfNode(pageChildren, top);
    if (topIndex == NSNotFound) return nil;
    for (NSUInteger i = pageChildren.count; i > topIndex + 1 && i + 3 > pageChildren.count; i--) {
        id<GHAXNode> list = GHFindOptionList(pageChildren[i - 1], 6, &overall);
        if (list) return list;
        if (overall.hung || overall.exhausted) return nil;
    }
    return nil;
}

+ (NSArray<id<GHAXNode>> *)optionsInList:(id<GHAXNode>)list {
    GHAXWalkBudget budget = GHAXWalkBudgetMake(NSUIntegerMax, GHComboBoxListSearchSeconds);
    return GHOptionsInList(list, &budget);
}

static NSArray<id<GHAXNode>> *GHOptionsInList(id<GHAXNode> list, GHAXWalkBudget *outer) {
    NSMutableArray<id<GHAXNode>> *explicit = [NSMutableArray array];
    NSMutableArray<id<GHAXNode>> *texts = [NSMutableArray array];
    GHAXWalkBudget budget = GHAXWalkBudgetNested(outer, kOptionSearchNodes);
    GHWalk(list, 5, &budget, ^BOOL(id<GHAXNode> node, NSUInteger depth, BOOL *stop) {
        if (depth == 0) return YES;
        NSString *description = node.roleDescription.lowercaseString ?: @"";
        if ([node.role isEqualToString:@"AXMenuItem"] || [description isEqualToString:@"option"] || [node.subrole isEqualToString:@"AXOption"]) {
            NSString *text = [GHComboBoxDriver textOfOption:node];
            if (node.enabled && text.length && !GHIsNotice(text)) [explicit addObject:node];
            return NO;
        }
        if ([node.role isEqualToString:@"AXStaticText"]) {
            NSString *text = GHTrimmed(node.value);
            if (text.length && !GHIsNotice(text)) [texts addObject:node];
            return NO;   // nested static text repeats its parent
        }
        return YES;
    });
    GHAXWalkBudgetAbsorb(outer, &budget);
    return explicit.count ? explicit : texts;
}

+ (NSString *)textOfOption:(id<GHAXNode>)option {
    for (NSString *text in @[ option.title ?: @"", option.value ?: @"", option.axDescription ?: @"" ]) {
        if (GHTrimmed(text).length) return GHTrimmed(text);
    }
    NSMutableArray<NSString *> *parts = [NSMutableArray array];
    GHAXWalkBudget budget = GHAXWalkBudgetMake(40, GHComboBoxListSearchSeconds);
    GHWalk(option, 3, &budget, ^BOOL(id<GHAXNode> node, NSUInteger depth, BOOL *stop) {
        if (depth > 0 && [node.role isEqualToString:@"AXStaticText"] && GHTrimmed(node.value).length) {
            [parts addObject:GHTrimmed(node.value)];
            return NO;
        }
        return YES;
    });
    return [parts componentsJoinedByString:@" "];
}

+ (NSArray<NSString *> *)shownTextsForComboBox:(id<GHAXNode>)comboBox typed:(NSString *)typed {
    NSMutableArray<NSString *> *shown = [NSMutableArray array];
    void (^add)(NSString *) = ^(NSString *text) {
        NSString *clean = GHTrimmed(text);
        if (clean.length && ![GHWriter isPlaceholderChoice:clean]) [shown addObject:clean];
    };
    NSString *own = GHTrimmed(comboBox.value);
    if (own.length && !(typed.length && GHSameText(own, typed))) add(own);

    NSString *label = GHTrimmed(comboBox.title.length ? comboBox.title : comboBox.axDescription);
    NSArray<id<GHAXNode>> *siblings = comboBox.parent.children ?: @[];
    NSUInteger index = GHIndexOfNode(siblings, comboBox);
    if (index == NSNotFound) return shown;
    for (NSUInteger step = 1; step <= 3 && step <= index; step++) {
        id<GHAXNode> sibling = siblings[index - step];
        if (GHIsControlRole(sibling.role) || [sibling.role isEqualToString:@"AXButton"] || [sibling.role isEqualToString:@"AXHeading"]) break;
        if ([sibling.identifier hasSuffix:@"-label"]) break;
        if ([sibling.role isEqualToString:@"AXStaticText"] && label.length && GHSameText(sibling.value, label)) break;   // the question itself
        if (GHIsLiveRegion(sibling)) continue;
        if ([sibling.role isEqualToString:@"AXStaticText"]) { add(sibling.value); continue; }
        GHAXWalkBudget budget = GHAXWalkBudgetMake(40, GHComboBoxListSearchSeconds);
        GHWalk(sibling, 3, &budget, ^BOOL(id<GHAXNode> node, NSUInteger depth, BOOL *stop) {
            if (GHIsLiveRegion(node)) return NO;
            if ([node.role isEqualToString:@"AXStaticText"]) { add(node.value); return NO; }
            return YES;
        });
    }
    return shown;
}

#pragma mark run

- (BOOL)looksSensitive:(id<GHAXNode>)node {
    if ([node.role isEqualToString:@"AXSecureTextField"] || [node.subrole isEqualToString:@"AXSecureTextField"]) return YES;
    if (!self.isNodeSensitive) return YES;   // fail closed, like GHWriter
    return self.isNodeSensitive(node);
}

- (void)chooseAnswer:(NSString *)answer inComboBox:(id<GHAXNode>)comboBox completion:(void (^)(GHComboBoxResult *))completion {
    NSString *label = GHLogLabel(comboBox.title.length ? comboBox.title : comboBox.axDescription);
    void (^refuse)(GHComboBoxOutcome, NSString *) = ^(GHComboBoxOutcome outcome, NSString *reason) {
        GHLog(@"combobox: label=%@ refused (%@)", label, reason);
        GHComboBoxResult *result = [[GHComboBoxResult alloc] init];
        result.outcome = outcome;
        result.reason = reason;
        result.method = GHComboBoxMethodNone;
        completion(result);
    };
    if (_running) { refuse(GHComboBoxOutcomeFailed, GHComboBoxReasonBusy); return; }
    NSString *wanted = GHTrimmed(answer);
    BOOL control = NO;
    for (NSUInteger i = 0; i < wanted.length && !control; i++) {
        unichar c = [wanted characterAtIndex:i];
        control = c < 0x20 || c == 0x7F || (c >= 0x80 && c < 0xA0) || c == 0x2028 || c == 0x2029;
    }
    if (wanted.length == 0 || control) { refuse(GHComboBoxOutcomeSkipped, GHComboBoxReasonUnsupported); return; }
    id<GHAXNode> combo = comboBox ? [self.actuator refreshedNode:comboBox] : nil;
    if (!combo) { refuse(GHComboBoxOutcomeSkipped, GHComboBoxReasonGone); return; }
    if (![GHComboBoxDriver isComboBox:combo]) { refuse(GHComboBoxOutcomeSkipped, GHComboBoxReasonUnsupported); return; }
    // EEO / demographic questions are never answered, whatever the caller asks for.
    if ([GHComboBoxDriver isDemographicComboBox:combo]) { refuse(GHComboBoxOutcomeSkipped, GHComboBoxReasonDemographic); return; }
    if ([self looksSensitive:combo]) { refuse(GHComboBoxOutcomeSkipped, GHComboBoxReasonSensitive); return; }
    if (!combo.enabled) { refuse(GHComboBoxOutcomeSkipped, GHComboBoxReasonDisabled); return; }
    if (combo.value.length > 0 || [GHComboBoxDriver shownTextsForComboBox:combo typed:nil].count > 0) { refuse(GHComboBoxOutcomeSkipped, GHComboBoxReasonHasValue); return; }
    pid_t pid = [self.state frontmostProcessIdentifier];
    if (pid <= 0) { refuse(GHComboBoxOutcomeSkipped, GHComboBoxReasonNoFrontmostApp); return; }

    _running = YES;
    _generation++;
    atomic_store(&_userKeySeen, false);
    atomic_store(&_active, true);
    _completion = [completion copy];
    _combo = combo;
    _answer = wanted;
    _label = label;
    _chosenText = nil;
    _score = 0;
    _optionCount = 0;
    _pid = pid;
    _typed = NO;
    _started = self.clock();

    [self.actuator focusNode:combo];
    [self later:self.focusSettleDelay do:^{
        id<GHAXNode> focused = [self.state focusedElement];
        if (![focused isSameNode:self->_combo]) { [self finish:GHComboBoxOutcomeSkipped reason:GHComboBoxReasonNotFocused method:GHComboBoxMethodNone escaped:NO cleared:NO]; return; }
        [self typeAnswer];
    }];
}

- (void)typeAnswer {
    GHKeyBurstResult *burst = [self.poster postBurst:@[ [GHKeyStroke text:_answer] ] guard:^BOOL(GHKeyStroke *stroke, pid_t frontmost, id<GHAXNode> focused) {
        return [focused isSameNode:self->_combo] && [self mayPostTo:frontmost];
    } lastCheck:[self mayStillPost]];
    if (burst.postedCount > 0) _typed = YES;
    if (!burst.ok) {
        if (burst.postedCount > 0) { [self finish:GHComboBoxOutcomeFailed reason:GHComboBoxReasonTypingInterrupted method:GHComboBoxMethodNone escaped:NO cleared:NO]; return; }
        NSString *reason = [self reasonForBurst:burst fallback:GHComboBoxReasonFocusChanged];
        GHComboBoxOutcome outcome = [reason isEqualToString:GHComboBoxReasonFocusChanged] ? GHComboBoxOutcomeSkipped : GHComboBoxOutcomeFailed;
        [self finish:outcome reason:reason method:GHComboBoxMethodNone escaped:NO cleared:NO];
        return;
    }
    [self waitForListUntil:self.clock() + self.listTimeout generation:_generation];
}

- (void)waitForListUntil:(NSTimeInterval)deadline generation:(NSUInteger)generation {
    if (generation != _generation || !_running || ![self stillSafe]) return;
    id<GHAXNode> list = [self currentList];
    NSArray<id<GHAXNode>> *options = list ? [GHComboBoxDriver optionsInList:list] : @[];
    if (options.count) { [self pickFrom:options]; return; }
    if (self.clock() >= deadline) { [self abandon:GHComboBoxReasonNoList]; return; }
    self.after(self.pollInterval, ^{ [self waitForListUntil:deadline generation:generation]; });
}

- (id<GHAXNode>)currentList {
    id<GHAXNode> combo = [self.actuator refreshedNode:_combo];
    return combo ? [GHComboBoxDriver listForComboBox:combo] : nil;
}

- (NSArray<NSString *> *)textsOf:(NSArray<id<GHAXNode>> *)options {
    NSMutableArray<NSString *> *texts = [NSMutableArray arrayWithCapacity:options.count];
    for (id<GHAXNode> option in options) [texts addObject:[GHComboBoxDriver textOfOption:option]];
    return texts;
}

- (void)pickFrom:(NSArray<id<GHAXNode>> *)options {
    NSArray<NSString *> *texts = [self textsOf:options];
    _optionCount = texts.count;
    GHOptionMatch match = self.matcher(texts, _answer);
    if (match.index < 0 || (NSUInteger)match.index >= texts.count || match.score < self.threshold) { [self abandon:GHComboBoxReasonNoMatchingOption]; return; }
    _chosenText = texts[(NSUInteger)match.index];
    _score = match.score;
    id<GHAXNode> option = options[(NSUInteger)match.index];
    if (![self.actuator pressNode:option]) { [self selectWithKeysStep:0]; return; }
    [self later:self.verifyDelay do:^{
        if ([self verified]) { [self finish:GHComboBoxOutcomeChosen reason:nil method:GHComboBoxMethodPress escaped:NO cleared:NO]; return; }
        // The press did nothing visible: the list is still open, try the keyboard. A list that closed on something
        // else cannot be undone here.
        if ([self currentList]) [self selectWithKeysStep:0];
        else [self finish:GHComboBoxOutcomeFailed reason:GHComboBoxReasonNotVerified method:GHComboBoxMethodPress escaped:NO cleared:NO];
    }];
}

- (NSInteger)indexOfChosenIn:(NSArray<NSString *> *)texts {
    for (NSUInteger i = 0; i < texts.count; i++) if (GHSameText(texts[i], _chosenText)) return (NSInteger)i;
    return -1;
}

- (NSInteger)highlightedIndexIn:(NSArray<id<GHAXNode>> *)options {
    for (NSUInteger i = 0; i < options.count; i++) if (self.isHighlighted(options[i])) return (NSInteger)i;
    return -1;
}

/// Re-read right before a Return: the list is open and the highlighted option is the chosen one.
- (BOOL)chosenOptionIsHighlightedNow {
    id<GHAXNode> list = [self currentList];
    if (!list) return NO;
    NSArray<id<GHAXNode>> *options = [GHComboBoxDriver optionsInList:list];
    NSInteger highlighted = [self highlightedIndexIn:options];
    return highlighted >= 0 && GHSameText([GHComboBoxDriver textOfOption:options[(NSUInteger)highlighted]], _chosenText);
}

- (void)selectWithKeysStep:(NSUInteger)step {
    if (!_running || ![self stillSafe]) return;
    id<GHAXNode> list = [self currentList];
    if (!list) { [self finish:GHComboBoxOutcomeFailed reason:GHComboBoxReasonListClosed method:GHComboBoxMethodKeys escaped:NO cleared:NO]; return; }
    NSArray<id<GHAXNode>> *options = [GHComboBoxDriver optionsInList:list];
    NSInteger target = [self indexOfChosenIn:[self textsOf:options]];
    if (target < 0) { [self abandon:GHComboBoxReasonOptionVanished]; return; }
    if (step > options.count + 2) { [self abandon:GHComboBoxReasonNoHighlight]; return; }
    NSInteger highlighted = [self highlightedIndexIn:options];
    if (highlighted == target) {
        GHKeyBurstResult *burst = [self.poster postBurst:@[ [GHKeyStroke returnKey] ] guard:^BOOL(GHKeyStroke *stroke, pid_t frontmost, id<GHAXNode> focused) {
            // The slow re-read of the list first, the cheap checks last; the poster reads focus and the app again
            // after this and asks mayStillPost right before the Return goes out.
            return [self chosenOptionIsHighlightedNow] && [focused isSameNode:self->_combo] && [self mayPostTo:frontmost];
        } lastCheck:[self mayStillPost]];
        if (!burst.ok) { [self finish:GHComboBoxOutcomeFailed reason:[self reasonForBurst:burst fallback:GHComboBoxReasonFocusChanged] method:GHComboBoxMethodKeys escaped:NO cleared:NO]; return; }
        [self later:self.verifyDelay do:^{
            BOOL ok = [self verified];
            [self finish:ok ? GHComboBoxOutcomeChosen : GHComboBoxOutcomeFailed reason:ok ? nil : GHComboBoxReasonNotVerified method:GHComboBoxMethodKeys escaped:NO cleared:NO];
        }];
        return;
    }
    GHKeyStroke *arrow = (highlighted < 0 || highlighted < target) ? [GHKeyStroke downArrow] : [GHKeyStroke upArrow];
    GHKeyBurstResult *burst = [self.poster postBurst:@[ arrow ] guard:^BOOL(GHKeyStroke *stroke, pid_t frontmost, id<GHAXNode> focused) {
        return [self currentList] != nil && [focused isSameNode:self->_combo] && [self mayPostTo:frontmost];
    } lastCheck:[self mayStillPost]];
    if (!burst.ok) { [self finish:GHComboBoxOutcomeFailed reason:[self reasonForBurst:burst fallback:GHComboBoxReasonFocusChanged] method:GHComboBoxMethodKeys escaped:NO cleared:NO]; return; }
    [self later:self.keyStepDelay do:^{ [self selectWithKeysStep:step + 1]; }];
}

- (BOOL)verified {
    if ([self currentList]) return NO;
    id<GHAXNode> combo = [self.actuator refreshedNode:_combo];
    if (!combo) return NO;
    for (NSString *text in [GHComboBoxDriver shownTextsForComboBox:combo typed:_answer]) {
        if (GHSameText(text, _chosenText)) return YES;
    }
    return NO;
}

/// Nothing chosen: one Escape (only while an option list is really open), then take back what was typed, then
/// report the field as skipped. With no list showing, an Escape would travel on to the page or the window (a modal
/// closes, a native sheet cancels), so none is posted.
- (void)abandon:(NSString *)reason {
    BOOL escaped = NO;
    if (![reason isEqualToString:GHComboBoxReasonNoList] && [self mayPostTo:[self.state frontmostProcessIdentifier]]) {
        GHKeyBurstResult *burst = [self.poster postBurst:@[ [GHKeyStroke escape] ] guard:^BOOL(GHKeyStroke *stroke, pid_t frontmost, id<GHAXNode> focused) {
            // The expensive check first; focus, app and the user's keys are read again by the poster after it.
            return [self currentList] != nil && [focused isSameNode:self->_combo] && [self mayPostTo:frontmost];
        } lastCheck:[self mayStillPost]];
        escaped = burst.ok;
    }
    NSUInteger generation = _generation;
    self.after(self.keyStepDelay, ^{
        if (generation != self->_generation || !self->_running) return;
        if (atomic_load(&self->_userKeySeen)) {   // the user took over: not a clean skip, and nothing more is posted
            [self finish:GHComboBoxOutcomeFailed reason:GHComboBoxReasonUserKey method:GHComboBoxMethodNone escaped:escaped cleared:NO];
            return;
        }
        id<GHAXNode> combo = [self.actuator refreshedNode:self->_combo];
        NSString *left = combo.value ?: @"";
        BOOL cleared = combo != nil && left.length == 0;
        id<GHAXNode> focused = [self.state focusedElement];
        if (combo && left.length > 0 && [focused isSameNode:self->_combo] && [self mayPostTo:[self.state frontmostProcessIdentifier]]) {
            NSUInteger count = MIN(MIN(GHComposedLength(self->_answer), GHComposedLength(left)), kMaxBackspaces);
            NSMutableArray<GHKeyStroke *> *strokes = [NSMutableArray arrayWithCapacity:count];
            for (NSUInteger i = 0; i < count; i++) [strokes addObject:[GHKeyStroke backspace]];
            GHKeyBurstResult *burst = strokes.count ? [self.poster postBurst:strokes guard:^BOOL(GHKeyStroke *stroke, pid_t frontmost, id<GHAXNode> now) {
                return [now isSameNode:self->_combo] && [self mayPostTo:frontmost];
            } lastCheck:[self mayStillPost]] : nil;
            id<GHAXNode> after = [self.actuator refreshedNode:self->_combo];
            cleared = burst.ok && after.value.length == 0;
        }
        [self finish:GHComboBoxOutcomeSkipped reason:reason method:GHComboBoxMethodNone escaped:escaped cleared:cleared];
    });
}

#pragma mark plumbing

- (void)later:(NSTimeInterval)delay do:(dispatch_block_t)block {
    NSUInteger generation = _generation;
    self.after(delay, ^{
        if (generation != self->_generation || !self->_running || ![self stillSafe]) return;
        block();
    });
}

- (BOOL)mayPostTo:(pid_t)frontmost {
    return _running && !atomic_load(&_userKeySeen) && frontmost == _pid;
}

/// The poster's very last question before each post: still running, no key of the user's, same app in front.
- (BOOL (^)(void))mayStillPost {
    __weak GHComboBoxDriver *weakSelf = self;
    return ^BOOL {
        GHComboBoxDriver *driver = weakSelf;
        return driver != nil && [driver mayPostTo:[driver.state frontmostProcessIdentifier]];
    };
}

- (BOOL)stillSafe {
    if (atomic_load(&_userKeySeen)) { [self finish:GHComboBoxOutcomeFailed reason:GHComboBoxReasonUserKey method:GHComboBoxMethodNone escaped:NO cleared:NO]; return NO; }
    if ([self.state frontmostProcessIdentifier] != _pid) { [self finish:GHComboBoxOutcomeFailed reason:GHComboBoxReasonAppChanged method:GHComboBoxMethodNone escaped:NO cleared:NO]; return NO; }
    return YES;
}

- (NSString *)reasonForBurst:(GHKeyBurstResult *)burst fallback:(NSString *)fallback {
    if ([burst.reason isEqualToString:GHKeyBurstReasonPostFailed] || [burst.reason isEqualToString:GHKeyBurstReasonMalformed]) return GHComboBoxReasonKeysRefused;
    if (atomic_load(&_userKeySeen)) return GHComboBoxReasonUserKey;
    if ([self.state frontmostProcessIdentifier] != _pid) return GHComboBoxReasonAppChanged;
    return fallback;
}

- (void)finish:(GHComboBoxOutcome)outcome reason:(NSString *)reason method:(NSString *)method escaped:(BOOL)escaped cleared:(BOOL)cleared {
    if (!_running) return;
    GHComboBoxResult *result = [[GHComboBoxResult alloc] init];
    result.outcome = outcome;
    result.reason = reason;
    result.method = method;
    result.score = _score;
    result.optionCount = _optionCount;
    result.typed = _typed;
    result.pressedEscape = escaped;
    result.clearedTyping = cleared;
    result.elapsed = self.clock() - _started;
    _running = NO;
    atomic_store(&_active, false);
    _generation++;
    _combo = nil;
    void (^completion)(GHComboBoxResult *) = _completion;
    _completion = nil;
    GHLog(@"combobox: label=%@ %@ reason=%@ method=%@ options=%lu score=%.2f escape=%d cleared=%d %.0f ms", _label,
          outcome == GHComboBoxOutcomeChosen ? @"chosen" : (outcome == GHComboBoxOutcomeSkipped ? @"skipped" : @"failed"), reason ?: @"-", method,
          (unsigned long)_optionCount, _score, escaped, cleared, result.elapsed * 1000.0);
    if (completion) completion(result);
}

- (void)noteUserKeyEvent {
    if (atomic_load(&_active)) atomic_store(&_userKeySeen, true);
}

- (void)cancel {
    [self finish:GHComboBoxOutcomeFailed reason:GHComboBoxReasonCancelled method:GHComboBoxMethodNone escaped:NO cleared:NO];
}

@end
