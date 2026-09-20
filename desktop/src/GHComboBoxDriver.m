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

/// `probeText` of shared/src/answers/classify.ts: lowercase, every run of non-alphanumerics becomes one space.
/// "I don't wish to answer" and "I do not want to answer" both come out as plain words.
static NSString *GHProbeText(NSString *text) {
    NSString *s = GHReplace((text ?: @"").lowercaseString, @"[^a-z0-9]+", @" ", NO);
    return [GHReplace(s, @"\\s+", @" ", NO) stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

/// Every wording of DECLINE_OPTION in shared/src/answers/classify.ts, in one alternation over probe text.
static NSString *GHDeclinePattern(void) {
    return @"\\bprefer not to (say|answer|disclose|respond|identify|self identify|specify|state|provide)\\b"
            "|\\bdecline to (self identify|identify|answer|state|disclose|respond|provide|specify)\\b"
            "|\\b(do not|don t|dont|does not) (wish|want|choose|prefer) to (answer|disclose|identify|self identify|provide|say|specify|state)\\b"
            "|\\bwish not to (answer|disclose|identify|self identify)\\b"
            "|\\bchoose not to (disclose|answer|identify|self identify|provide|say)\\b"
            "|\\b(would )?rather not (say|answer|disclose)\\b"
            "|\\bnot disclosed?\\b"
            "|\\bno answer\\b";
}

GHOptionMatch GHMatchDeclineOption(NSArray<NSString *> *options, NSString *answer) {
    (void)answer;   // declining is the same answer however the caller spelled it
    GHOptionMatch none = { -1, 0 };
    for (NSUInteger i = 0; i < options.count; i++) {
        NSString *trimmed = [options[i] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        if (trimmed.length == 0 || GHMatches(trimmed, @"^(select|choose|please|--)")) continue;
        if (GHMatches(GHProbeText(trimmed), GHDeclinePattern())) return (GHOptionMatch){ (NSInteger)i, 1 };
    }
    return none;
}

/// NEUTRAL_OPTIONS of shared/src/answers/propose.ts, best rank first. "Other" answers the question; declining
/// merely ends it, so it ranks last.
static NSArray<NSString *> *GHNeutralPatterns(void) {
    static NSArray<NSString *> *patterns;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        patterns = @[ @"^other\\b|^something else\\b|^not listed\\b|^none of these apply\\b",
                      @"^none of the (above|below|these|listed)\\b|^none$|^no other\\b",
                      @"^n a$|^not applicable\\b|^does not apply\\b",
                      @"\\bprefer not to\\b|\\bdecline to\\b|\\bdo not wish to\\b|\\bdon t wish to\\b|\\brather not say\\b",
                      @"^no preference\\b|^unsure\\b|^not sure\\b|^i don t know\\b|^undecided\\b" ];
    });
    return patterns;
}

/// DECLARATION_OPTION of shared/src/answers/propose.ts: an option that states something legal rather than
/// answering a question. Never picked as "the neutral one".
static NSString *GHDeclarationOptionPattern(void) {
    return @"\\bi (certify|agree|consent|authori[sz]e|acknowledge|declare|attest|understand)\\b|\\bunder penalt\\w+\\b";
}

GHOptionMatch GHMatchNeutralOption(NSArray<NSString *> *options, NSString *answer) {
    (void)answer;   // the neutral option is the same answer whatever was wanted
    GHOptionMatch none = { -1, 0 };
    NSArray<NSString *> *patterns = GHNeutralPatterns();
    NSInteger bestIndex = -1;
    NSUInteger bestRank = patterns.count;
    for (NSUInteger i = 0; i < options.count; i++) {
        NSString *trimmed = [options[i] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        if (trimmed.length == 0 || GHMatches(trimmed, @"^(select|choose|please|--)")) continue;
        NSString *probe = GHProbeText(trimmed);
        if (GHMatches(probe, GHDeclarationOptionPattern())) continue;
        for (NSUInteger rank = 0; rank < patterns.count; rank++) {
            if (!GHMatches(probe, patterns[rank])) continue;
            if (rank < bestRank) { bestRank = rank; bestIndex = (NSInteger)i; }
            break;
        }
    }
    if (bestIndex < 0) return none;
    return (GHOptionMatch){ bestIndex, 1 };
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
@property (nonatomic, readwrite) BOOL tookNeutral;
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

/// The notice that ends the wait: the list is open and says that nothing matches what was typed. "Loading..." and
/// "Searching..." are not this: those are worth waiting out.
static BOOL GHIsNothingFoundNotice(NSString *text) {
    return GHMatches(GHTrimmed(text), @"^(no options?|no results?( found)?|no matches( found)?|nothing found)$");
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
    BOOL _openedByPress;
    BOOL _declining;
    BOOL _neutralFallback;
    BOOL _tookNeutral;
    BOOL _reopened;
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
        _openTimeout = 0.7;
        _verifyDelay = 0.15;
        _verifyAttempts = 6;
        _keyStepDelay = 0.06;
        _after = ^(NSTimeInterval delay, dispatch_block_t block) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)), dispatch_get_main_queue(), block);
        };
        _clock = ^NSTimeInterval { return NSProcessInfo.processInfo.systemUptime; };
        self.matcher = nil;
        self.declineMatcher = nil;
        self.neutralMatcher = nil;
        self.isHighlighted = nil;
    }
    return self;
}

- (void)setMatcher:(GHOptionMatcher)matcher {
    if (matcher) { _matcher = [matcher copy]; return; }
    _matcher = ^GHOptionMatch(NSArray<NSString *> *options, NSString *answer) { return GHMatchOption(options, answer); };
}

- (void)setDeclineMatcher:(GHOptionMatcher)matcher {
    if (matcher) { _declineMatcher = [matcher copy]; return; }
    _declineMatcher = ^GHOptionMatch(NSArray<NSString *> *options, NSString *answer) { return GHMatchDeclineOption(options, answer); };
}

- (void)setNeutralMatcher:(GHOptionMatcher)matcher {
    if (matcher) { _neutralMatcher = [matcher copy]; return; }
    _neutralMatcher = ^GHOptionMatch(NSArray<NSString *> *options, NSString *answer) { return GHMatchNeutralOption(options, answer); };
}

- (void)setIsHighlighted:(BOOL (^)(id<GHAXNode>))isHighlighted {
    if (isHighlighted) { _isHighlighted = [isHighlighted copy]; return; }
    _isHighlighted = ^BOOL(id<GHAXNode> option) {
        if (option.isFocused) return YES;
        if (GHHasHighlightClass(option)) return YES;   // react-select: the class IS the highlight
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

/// Does any DOM class of `node` end in "option"? react-select marks every row of an open menu with `select__option`
/// (plus a generated `…-option`), and in WebKit that is the ONLY thing that separates an option row from ordinary
/// page text: the role is AXStaticText and the role description is "text", not "option".
static BOOL GHHasOptionClass(id<GHAXNode> node) {
    for (NSString *name in node.domClassList) {
        NSString *lower = name.lowercaseString;
        if ([lower isEqualToString:@"option"] || [lower hasSuffix:@"-option"] || [lower hasSuffix:@"_option"]) return YES;
    }
    return NO;
}

/// react-select's highlighted row carries `select__option--is-focused`; the chosen one `--is-selected`. Neither sets
/// AXFocused or AXSelected, so the arrow-key fallback could never see a highlight on a real page without this.
static BOOL GHHasHighlightClass(id<GHAXNode> node) {
    for (NSString *name in node.domClassList) {
        NSString *lower = name.lowercaseString;
        if ([lower hasSuffix:@"--is-focused"] || [lower hasSuffix:@"--is-selected"]
            || [lower hasSuffix:@"-is-focused"] || [lower hasSuffix:@"-is-selected"]) return YES;
    }
    return NO;
}

static NSArray<id<GHAXNode>> *GHOptionsInList(id<GHAXNode> list, GHAXWalkBudget *outer);

static BOOL GHListSaysNothingFound(id<GHAXNode> list, GHAXWalkBudget *outer);

/// A list of options: list-like, holds options (or says it has none for what was typed), and no form control
/// inside (a checkbox group is not a menu).
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
    if (hasControl) return NO;
    // An open menu that says "No options" is a list: it is what the page answers when nothing matches, and Ghost
    // closes it (one Escape) instead of waiting out the whole timeout with the menu hanging open.
    return GHOptionsInList(node, outer).count > 0 || GHListSaysNothingFound(node, outer);
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

static BOOL GHListSaysNothingFound(id<GHAXNode> list, GHAXWalkBudget *outer) {
    __block BOOL nothing = NO;
    GHAXWalkBudget budget = GHAXWalkBudgetNested(outer, kOptionSearchNodes);
    GHWalk(list, 5, &budget, ^BOOL(id<GHAXNode> node, NSUInteger depth, BOOL *stop) {
        if (depth == 0) return YES;
        for (NSString *text in @[ node.value ?: @"", node.title ?: @"", node.axDescription ?: @"" ]) {
            if (!GHIsNothingFoundNotice(text)) continue;
            nothing = YES;
            *stop = YES;
            return NO;
        }
        return YES;
    });
    GHAXWalkBudgetAbsorb(outer, &budget);
    return nothing;
}

+ (BOOL)listSaysNothingFound:(id<GHAXNode>)list {
    GHAXWalkBudget budget = GHAXWalkBudgetMake(NSUIntegerMax, GHComboBoxListSearchSeconds);
    return list != nil && GHListSaysNothingFound(list, &budget);
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
        if ([node.role isEqualToString:@"AXMenuItem"] || [description isEqualToString:@"option"] || [node.subrole isEqualToString:@"AXOption"]
            || GHHasOptionClass(node)) {
            NSString *text = [GHComboBoxDriver textOfOption:node];
            if (node.enabled && text.length && !GHIsNotice(text)) [explicit addObject:node];
            return NO;
        }
        if ([node.role isEqualToString:@"AXStaticText"]) {
            // NOT node.value: WebKit gives react-select's option divs (AXStaticText, role description "text") their
            // label in AXTitle and leaves AXValue empty, which is why the real Greenhouse menu read as 0 options.
            NSString *text = [GHComboBoxDriver textOfOption:node];
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
    [self chooseAnswer:answer inComboBox:comboBox decline:NO neutralFallback:NO completion:completion];
}

- (void)chooseAnswer:(NSString *)answer
          inComboBox:(id<GHAXNode>)comboBox
             decline:(BOOL)decline
          completion:(void (^)(GHComboBoxResult *))completion {
    [self chooseAnswer:answer inComboBox:comboBox decline:decline neutralFallback:NO completion:completion];
}

- (void)chooseAnswer:(NSString *)answer
          inComboBox:(id<GHAXNode>)comboBox
             decline:(BOOL)decline
     neutralFallback:(BOOL)neutralFallback
          completion:(void (^)(GHComboBoxResult *))completion {
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
    // A demographic question is only ever DECLINED. Anything else the caller may want there is refused,
    // whatever it asks for (docs/answers.md section 7).
    if (!decline && [GHComboBoxDriver isDemographicComboBox:combo]) { refuse(GHComboBoxOutcomeSkipped, GHComboBoxReasonDemographic); return; }
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
    _openedByPress = NO;
    _reopened = NO;
    _declining = decline;
    _neutralFallback = neutralFallback && !decline;
    _tookNeutral = NO;
    _started = self.clock();

    [self.actuator focusNode:combo];
    [self later:self.focusSettleDelay do:^{
        id<GHAXNode> focused = [self.state focusedElement];
        if (![focused isSameNode:self->_combo]) { [self finish:GHComboBoxOutcomeSkipped reason:GHComboBoxReasonNotFocused method:GHComboBoxMethodNone escaped:NO cleared:NO]; return; }
        [self openByPress];
    }];
}

/// Step 3a, before any key: AXPress the combo box itself. On the real Greenhouse form this is what opens
/// react-select's menu -- typing into that 4 px wide inner input opens nothing -- and it costs the page no
/// keystrokes at all. A control that does not answer a press falls through to typing, which is what a location or
/// type-ahead field needs.
- (void)openByPress {
    if (!_running || ![self stillSafe]) return;
    id<GHAXNode> combo = [self.actuator refreshedNode:_combo];
    if (!combo) { [self finish:GHComboBoxOutcomeSkipped reason:GHComboBoxReasonGone method:GHComboBoxMethodNone escaped:NO cleared:NO]; return; }
    if (![self.actuator pressNode:combo]) { [self typeAnswer]; return; }
    _openedByPress = YES;
    [self waitForOpenedListUntil:self.clock() + self.openTimeout generation:_generation];
}

/// Like waitForListUntil:, but running out is not a failure: it just means this control does not open on a press,
/// so the old typing path takes over.
- (void)waitForOpenedListUntil:(NSTimeInterval)deadline generation:(NSUInteger)generation {
    if (generation != _generation || !_running || ![self stillSafe]) return;
    id<GHAXNode> list = [self currentList];
    NSArray<id<GHAXNode>> *options = list ? [GHComboBoxDriver optionsInList:list] : @[];
    if (options.count) { [self pickFrom:options]; return; }
    if (self.clock() >= deadline) { [self typeAnswer]; return; }
    self.after(self.pollInterval, ^{ [self waitForOpenedListUntil:deadline generation:generation]; });
}

/**
 * A decline is not a literal answer: the option that means "prefer not to answer" is worded differently on
 * every site, so typing the core's wording would filter a type-ahead list down to nothing (or, worse, leave
 * an EEO answer sitting in the field). A declining run therefore only ever PRESSES the control open and picks
 * from what the page itself offers; if nothing opens, the field is left exactly as it was.
 */
- (void)typeAnswer {
    if (_declining) { [self abandon:GHComboBoxReasonNoList]; return; }
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
    // The page itself says nothing matches what was typed: close the menu, take the typing back, skip the field.
    if (list && [GHComboBoxDriver listSaysNothingFound:list]) { [self abandon:GHComboBoxReasonNoMatchingOption]; return; }
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
    GHOptionMatch match = _declining ? self.declineMatcher(texts, _answer) : self.matcher(texts, _answer);
    BOOL neutral = NO;
    if ((match.index < 0 || (NSUInteger)match.index >= texts.count || match.score < self.threshold) && _neutralFallback) {
        // The answer is not among the options. An ORDINARY question still gets an answer: whatever this list
        // itself calls the neutral choice (docs/answers.md section 3). It is tried before any typing, because a
        // list that offers "Other" is a fixed set of choices -- typing a word it does not have would only filter
        // it down to nothing. A list with no neutral option falls through to the old path untouched.
        GHOptionMatch fallback = self.neutralMatcher(texts, _answer);
        if (fallback.index >= 0 && (NSUInteger)fallback.index < texts.count && fallback.score >= self.threshold) {
            match = fallback;
            neutral = YES;
        }
    }
    if (match.index < 0 || (NSUInteger)match.index >= texts.count || match.score < self.threshold) {
        // A menu opened by a press shows everything it has; a type-ahead control only shows what was typed. If
        // nothing here clears the threshold and nothing has been typed yet, let the page filter once, then judge
        // again. Never a second time, and never a guess: the threshold still decides.
        // A declining run never types (see -typeAnswer): a list with no way to decline is simply left alone.
        if (_openedByPress && !_typed && !_declining) { [self typeAnswer]; return; }
        [self abandon:GHComboBoxReasonNoMatchingOption];
        return;
    }
    _tookNeutral = neutral;
    _chosenText = texts[(NSUInteger)match.index];
    _score = match.score;
    id<GHAXNode> option = options[(NSUInteger)match.index];
    if (![self.actuator pressNode:option]) { [self selectWithKeysStep:0]; return; }
    NSUInteger generation = _generation;
    [self later:self.verifyDelay do:^{
        if ([self verified]) { [self finish:GHComboBoxOutcomeChosen reason:nil method:GHComboBoxMethodPress escaped:NO cleared:NO]; return; }
        // The press did nothing visible and the list is still open: the keyboard, at once. Waiting would only
        // delay a control that is never going to answer a press.
        if ([self currentList]) { [self selectWithKeysStep:0]; return; }
        // The list closed with nothing showing yet. That is either a page whose accessibility tree lags its own
        // update, or a react-select whose option row answers a real mouse press and not a synthesized one. Look a
        // few more times, and only then open the menu once more and take the same keyboard path -- once per run,
        // and never while something IS showing: a press that chose the wrong option gets no second choice.
        [self verifyAttempt:1 generation:generation then:^(BOOL ok) {
            if (ok) { [self finish:GHComboBoxOutcomeChosen reason:nil method:GHComboBoxMethodPress escaped:NO cleared:NO]; return; }
            if ([self currentList]) { [self selectWithKeysStep:0]; return; }
            if (!self->_reopened && [self showsNothing]) { [self reopenForKeys]; return; }
            [self failNotVerified];
        }];
    }];
}

/// Nothing at all is showing in the combobox: no value of its own, and no chosen-value text beside it.
- (BOOL)showsNothing {
    id<GHAXNode> combo = [self.actuator refreshedNode:_combo];
    if (!combo) return NO;
    if (GHTrimmed(combo.value).length > 0) return NO;
    return [GHComboBoxDriver shownTextsForComboBox:combo typed:_answer].count == 0;
}

/// Wait `verifyDelay`, then look for the chosen text up to `verifyAttempts` times, `verifyDelay` apart, stopping
/// the moment it is there. One look raced a page that updates its accessibility tree a beat after itself -- the
/// same lesson the upload check learned on the live form.
- (void)verifyThen:(void (^)(BOOL ok))done {
    NSUInteger generation = _generation;
    [self later:self.verifyDelay do:^{ [self verifyAttempt:0 generation:generation then:done]; }];
}

- (void)verifyAttempt:(NSUInteger)attempt generation:(NSUInteger)generation then:(void (^)(BOOL ok))done {
    if (generation != _generation || !_running) return;
    if ([self verified]) { done(YES); return; }
    NSUInteger attempts = MAX((NSUInteger)1, self.verifyAttempts);
    if (attempt + 1 >= attempts) { done(NO); return; }
    // -later:do: carries the generation and stops the run itself if the user or another app took over.
    [self later:self.verifyDelay do:^{ [self verifyAttempt:attempt + 1 generation:generation then:done]; }];
}

/// Focus the control, press it open once more, and hand the open list to the keyboard path. Nothing is typed and
/// nothing else is pressed, so a control that will not re-open is left exactly as the press found it.
- (void)reopenForKeys {
    _reopened = YES;
    NSUInteger generation = _generation;
    id<GHAXNode> combo = [self.actuator refreshedNode:_combo];
    if (!combo) { [self failNotVerified]; return; }
    [self.actuator focusNode:combo];
    [self later:self.focusSettleDelay do:^{
        id<GHAXNode> fresh = [self.actuator refreshedNode:self->_combo];
        if (!fresh || ![[self.state focusedElement] isSameNode:self->_combo] || ![self.actuator pressNode:fresh]) {
            [self failNotVerified];
            return;
        }
        [self waitForReopenedListUntil:self.clock() + self.openTimeout generation:generation];
    }];
}

- (void)waitForReopenedListUntil:(NSTimeInterval)deadline generation:(NSUInteger)generation {
    if (generation != _generation || !_running || ![self stillSafe]) return;
    id<GHAXNode> list = [self currentList];
    if (list && [GHComboBoxDriver optionsInList:list].count > 0) { [self selectWithKeysStep:0]; return; }
    if (self.clock() >= deadline) { [self failNotVerified]; return; }
    self.after(self.pollInterval, ^{ [self waitForReopenedListUntil:deadline generation:generation]; });
}

- (void)failNotVerified {
    [self finish:GHComboBoxOutcomeFailed reason:GHComboBoxReasonNotVerified method:GHComboBoxMethodPress escaped:NO cleared:NO];
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
        [self verifyThen:^(BOOL ok) {
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
    if ((_openedByPress || ![reason isEqualToString:GHComboBoxReasonNoList]) && [self mayPostTo:[self.state frontmostProcessIdentifier]]) {
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
    result.tookNeutral = _tookNeutral;
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
    if (_tookNeutral && outcome == GHComboBoxOutcomeChosen) GHLog(@"combobox: label=%@ took the list's own neutral option", _label);
    if (completion) completion(result);
}

- (void)noteUserKeyEvent {
    if (atomic_load(&_active)) atomic_store(&_userKeySeen, true);
}

- (void)cancel {
    [self finish:GHComboBoxOutcomeFailed reason:GHComboBoxReasonCancelled method:GHComboBoxMethodNone escaped:NO cleared:NO];
}

@end
