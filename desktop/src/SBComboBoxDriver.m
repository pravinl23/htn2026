#import "SBComboBoxDriver.h"
#import "SBLog.h"
#import <stdatomic.h>

const double SBComboBoxMatchThreshold = 0.7;

NSString *const SBComboBoxReasonUnsupported = @"unsupported";
NSString *const SBComboBoxReasonGone = @"gone";
NSString *const SBComboBoxReasonDemographic = @"demographic";
NSString *const SBComboBoxReasonSensitive = @"sensitive";
NSString *const SBComboBoxReasonDisabled = @"disabled";
NSString *const SBComboBoxReasonHasValue = @"has-value";
NSString *const SBComboBoxReasonNoFrontmostApp = @"no-frontmost-app";
NSString *const SBComboBoxReasonNotFocused = @"not-focused";
NSString *const SBComboBoxReasonFocusChanged = @"focus-changed";
NSString *const SBComboBoxReasonNoList = @"no-list";
NSString *const SBComboBoxReasonNoMatchingOption = @"no-matching-option";
NSString *const SBComboBoxReasonOptionVanished = @"option-vanished";
NSString *const SBComboBoxReasonNoHighlight = @"no-highlight";
NSString *const SBComboBoxReasonBusy = @"busy";
NSString *const SBComboBoxReasonTypingInterrupted = @"typing-interrupted";
NSString *const SBComboBoxReasonNotVerified = @"not-verified";
NSString *const SBComboBoxReasonListClosed = @"list-closed";
NSString *const SBComboBoxReasonKeysRefused = @"keys-refused";
NSString *const SBComboBoxReasonAppChanged = @"app-changed";
NSString *const SBComboBoxReasonUserKey = @"user-key";
NSString *const SBComboBoxReasonCancelled = @"cancelled";

NSString *const SBComboBoxMethodNone = @"none";
NSString *const SBComboBoxMethodPress = @"press";
NSString *const SBComboBoxMethodKeys = @"keys";

static const NSUInteger kListSiblingScan = 8;
static const NSUInteger kListLevelsUp = 4;
static const NSUInteger kListSearchNodes = 300;
static const NSUInteger kOptionSearchNodes = 400;
static const NSUInteger kMaxBackspaces = 256;
const NSTimeInterval SBComboBoxListSearchSeconds = 0.2;

#pragma mark - matchOption (port of shared/src/resolve.ts)

static NSRegularExpression *SBRegex(NSString *pattern) {
    return [NSRegularExpression regularExpressionWithPattern:pattern options:NSRegularExpressionCaseInsensitive error:NULL];
}

static NSString *SBReplace(NSString *text, NSString *pattern, NSString *templ, BOOL caseSensitive) {
    NSRegularExpression *regex = [NSRegularExpression regularExpressionWithPattern:pattern options:caseSensitive ? 0 : NSRegularExpressionCaseInsensitive error:NULL];
    return [regex stringByReplacingMatchesInString:text options:0 range:NSMakeRange(0, text.length) withTemplate:templ];
}

static BOOL SBMatches(NSString *text, NSString *pattern) {
    return [SBRegex(pattern) firstMatchInString:text options:0 range:NSMakeRange(0, text.length)] != nil;
}

/// shared normalize(): camelCase split, lower case, _-./:* to spaces, collapsed whitespace.
static NSString *SBMatchNormalize(NSString *text) {
    NSString *s = SBReplace(text ?: @"", @"([a-z])([A-Z])", @"$1 $2", YES).lowercaseString;
    s = SBReplace(s, @"[_\\-./:*]+", @" ", NO);
    s = SBReplace(s, @"\\s+", @" ", NO);
    return [s stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

static NSArray<NSString *> *SBMatchWords(NSString *text) {
    NSMutableArray<NSString *> *words = [NSMutableArray array];
    for (NSString *part in [SBMatchNormalize(text) componentsSeparatedByCharactersInSet:NSCharacterSet.alphanumericCharacterSet.invertedSet]) {
        if (part.length) [words addObject:part];
    }
    return words;
}

static NSSet<NSString *> *SBMatchKeywords(NSString *text) {
    static NSSet<NSString *> *stopwords;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ stopwords = [NSSet setWithArray:@[ @"of", @"the", @"and", @"in", @"at", @"for", @"to", @"or", @"an" ]]; });
    NSMutableSet<NSString *> *keywords = [NSMutableSet set];
    for (NSString *word in SBMatchWords(text)) if (word.length > 1 && ![stopwords containsObject:word]) [keywords addObject:word];
    return keywords;
}

static double SBMatchOverlap(NSString *a, NSString *b) {
    NSSet<NSString *> *ta = SBMatchKeywords(a), *tb = SBMatchKeywords(b);
    if (ta.count == 0 || tb.count == 0) return 0;
    NSUInteger shared = 0;
    for (NSString *word in ta) if ([tb containsObject:word]) shared++;
    return (double)shared / (double)MAX(ta.count, tb.count);
}

static BOOL SBContainsWords(NSArray<NSString *> *haystack, NSArray<NSString *> *needle) {
    if (needle.count == 0 || needle.count > haystack.count) return NO;
    for (NSUInteger i = 0; i + needle.count <= haystack.count; i++) {
        BOOL all = YES;
        for (NSUInteger j = 0; j < needle.count && all; j++) all = [haystack[i + j] isEqualToString:needle[j]];
        if (all) return YES;
    }
    return NO;
}

static double SBContainmentScore(NSString *label, NSString *target) {
    NSArray<NSString *> *lw = SBMatchWords(label), *tw = SBMatchWords(target);
    if (SBContainsWords(lw, tw)) return 0.88;
    return SBContainsWords(tw, lw) && SBMatchOverlap(label, target) > 0.5 ? 0.88 : 0;
}

static double SBOptionScore(NSString *option, NSString *answer) {
    NSString *target = SBMatchNormalize(answer);
    NSString *label = SBMatchNormalize(option);
    if ([label isEqualToString:target]) return 1;
    NSString *trimmed = [answer stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    BOOL wantsYes = SBMatches(trimmed, @"^(y|yes|true|1)$");
    BOOL wantsNo = SBMatches(trimmed, @"^(n|no|false|0)$");
    if (wantsYes || wantsNo) {
        NSString *first = SBMatchWords(option).firstObject ?: @"";
        NSString *value = [option stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        BOOL word = SBMatches(first, wantsYes ? @"^(y|yes|true)$" : @"^(n|no|false)$");
        BOOL flag = SBMatches(value, wantsYes ? @"^(y|yes|true|1)$" : @"^(n|no|false|0)$");
        return word || flag ? 0.95 : 0;
    }
    double contained = SBContainmentScore(label, target);
    if (contained > 0) return contained;
    double shared = SBMatchOverlap(label, target);
    return shared >= 0.6 ? 0.6 + 0.25 * shared : 0;
}

SBOptionMatch SBMatchOption(NSArray<NSString *> *options, NSString *answer) {
    SBOptionMatch none = { -1, 0 };
    if (answer.length == 0) return none;
    NSInteger best = -1;
    double bestScore = -1, runnerUp = -1;
    for (NSUInteger i = 0; i < options.count; i++) {
        NSString *option = options[i];
        NSString *trimmed = [option stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        if (trimmed.length == 0 || SBMatches(trimmed, @"^(select|choose|please|--)")) continue;
        double score = SBOptionScore(option, answer);
        if (score > bestScore) { runnerUp = bestScore; bestScore = score; best = (NSInteger)i; }
        else if (score > runnerUp) runnerUp = score;
    }
    if (best < 0 || bestScore < SBComboBoxMatchThreshold) return none;
    // "Yes, as a citizen" vs "Yes, with a permit": picking one would be a guess.
    if (runnerUp == bestScore && bestScore < 1) return none;
    return (SBOptionMatch){ best, bestScore };
}

/// `probeText` of shared/src/answers/classify.ts: lowercase, every run of non-alphanumerics becomes one space.
/// "I don't wish to answer" and "I do not want to answer" both come out as plain words.
static NSString *SBProbeText(NSString *text) {
    NSString *s = SBReplace((text ?: @"").lowercaseString, @"[^a-z0-9]+", @" ", NO);
    return [SBReplace(s, @"\\s+", @" ", NO) stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

/// Every wording of DECLINE_OPTION in shared/src/answers/classify.ts, in one alternation over probe text.
static NSString *SBDeclinePattern(void) {
    return @"\\bprefer not to (say|answer|disclose|respond|identify|self identify|specify|state|provide)\\b"
            "|\\bdecline to (self identify|identify|answer|state|disclose|respond|provide|specify)\\b"
            "|\\b(do not|don t|dont|does not) (wish|want|choose|prefer) to (answer|disclose|identify|self identify|provide|say|specify|state)\\b"
            "|\\bwish not to (answer|disclose|identify|self identify)\\b"
            "|\\bchoose not to (disclose|answer|identify|self identify|provide|say)\\b"
            "|\\b(would )?rather not (say|answer|disclose)\\b"
            "|\\bnot disclosed?\\b"
            "|\\bno answer\\b";
}

SBOptionMatch SBMatchDeclineOption(NSArray<NSString *> *options, NSString *answer) {
    (void)answer;   // declining is the same answer however the caller spelled it
    SBOptionMatch none = { -1, 0 };
    for (NSUInteger i = 0; i < options.count; i++) {
        NSString *trimmed = [options[i] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        if (trimmed.length == 0 || SBMatches(trimmed, @"^(select|choose|please|--)")) continue;
        if (SBMatches(SBProbeText(trimmed), SBDeclinePattern())) return (SBOptionMatch){ (NSInteger)i, 1 };
    }
    return none;
}

/// NEUTRAL_OPTIONS of shared/src/answers/propose.ts, best rank first. "Other" answers the question; declining
/// merely ends it, so it ranks last.
static NSArray<NSString *> *SBNeutralPatterns(void) {
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
static NSString *SBDeclarationOptionPattern(void) {
    return @"\\bi (certify|agree|consent|authori[sz]e|acknowledge|declare|attest|understand)\\b|\\bunder penalt\\w+\\b";
}

SBOptionMatch SBMatchNeutralOption(NSArray<NSString *> *options, NSString *answer) {
    (void)answer;   // the neutral option is the same answer whatever was wanted
    SBOptionMatch none = { -1, 0 };
    NSArray<NSString *> *patterns = SBNeutralPatterns();
    NSInteger bestIndex = -1;
    NSUInteger bestRank = patterns.count;
    for (NSUInteger i = 0; i < options.count; i++) {
        NSString *trimmed = [options[i] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        if (trimmed.length == 0 || SBMatches(trimmed, @"^(select|choose|please|--)")) continue;
        NSString *probe = SBProbeText(trimmed);
        if (SBMatches(probe, SBDeclarationOptionPattern())) continue;
        for (NSUInteger rank = 0; rank < patterns.count; rank++) {
            if (!SBMatches(probe, patterns[rank])) continue;
            if (rank < bestRank) { bestRank = rank; bestIndex = (NSInteger)i; }
            break;
        }
    }
    if (bestIndex < 0) return none;
    return (SBOptionMatch){ bestIndex, 1 };
}

#pragma mark - result

@interface SBComboBoxResult ()
@property (nonatomic, readwrite) SBComboBoxOutcome outcome;
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

@implementation SBComboBoxResult
- (BOOL)chosen { return self.outcome == SBComboBoxOutcomeChosen; }
- (BOOL)skipsField { return self.outcome == SBComboBoxOutcomeSkipped; }
- (BOOL)stopsWalk { return self.outcome == SBComboBoxOutcomeFailed; }
- (NSString *)description {
    NSString *outcome = self.chosen ? @"chosen" : (self.skipsField ? @"skipped" : @"failed");
    return [NSString stringWithFormat:@"<SBComboBoxResult %@ reason=%@ method=%@ score=%.2f escape=%d cleared=%d>", outcome,
            self.reason ?: @"-", self.method, self.score, self.pressedEscape, self.clearedTyping];
}
@end

#pragma mark - tree helpers

static NSString *SBTrimmed(NSString *text) {
    return [text ?: @"" stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

static BOOL SBIsControlRole(NSString *role) {
    static NSSet<NSString *> *roles;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        roles = [NSSet setWithArray:@[ @"AXComboBox", @"AXTextField", @"AXTextArea", @"AXCheckBox", @"AXRadioButton", @"AXRadioGroup",
                                       @"AXPopUpButton", @"AXSecureTextField", @"AXSlider", @"AXLink" ]];
    });
    return role && [roles containsObject:role];
}

static BOOL SBIsLiveRegion(id<SBAXNode> node) {
    NSString *description = node.roleDescription.lowercaseString ?: @"";
    NSString *subrole = node.subrole ?: @"";
    return [description isEqualToString:@"log"] || [description isEqualToString:@"status"] || [description isEqualToString:@"alert"]
        || [subrole isEqualToString:@"AXApplicationLog"] || [subrole isEqualToString:@"AXApplicationStatus"] || [subrole isEqualToString:@"AXApplicationAlert"];
}

static BOOL SBIsNotice(NSString *text) {
    return SBMatches(SBTrimmed(text), @"^(no options?|no results?( found)?|no matches( found)?|nothing found|loading\\W*|searching\\W*|type to search.*)$");
}

/// The notice that ends the wait: the list is open and says that nothing matches what was typed. "Loading..." and
/// "Searching..." are not this: those are worth waiting out.
static BOOL SBIsNothingFoundNotice(NSString *text) {
    return SBMatches(SBTrimmed(text), @"^(no options?|no results?( found)?|no matches( found)?|nothing found)$");
}

/// Document-order walk (depth first), bounded by `budget` (nodes and wall clock; a hung app stops it). `visit`
/// returns NO to skip the node's children.
static void SBWalk(id<SBAXNode> root, NSUInteger maxDepth, SBAXWalkBudget *budget, BOOL (^visit)(id<SBAXNode> node, NSUInteger depth, BOOL *stop)) {
    NSMutableArray<id<SBAXNode>> *stack = [NSMutableArray arrayWithObject:root];
    NSMutableArray<NSNumber *> *depths = [NSMutableArray arrayWithObject:@0];
    BOOL stop = NO;
    while (stack.count && !stop) {
        id<SBAXNode> node = stack.lastObject;
        NSUInteger depth = depths.lastObject.unsignedIntegerValue;
        [stack removeLastObject];
        [depths removeLastObject];
        if (!SBAXWalkBudgetSpend(budget, node)) break;
        if (!visit(node, depth, &stop) || stop || depth >= maxDepth) continue;
        NSArray<id<SBAXNode>> *children = node.children;
        for (NSInteger i = (NSInteger)children.count - 1; i >= 0; i--) {
            [stack addObject:children[(NSUInteger)i]];
            [depths addObject:@(depth + 1)];
        }
    }
}

static NSUInteger SBIndexOfNode(NSArray<id<SBAXNode>> *nodes, id<SBAXNode> node) {
    for (NSUInteger i = 0; i < nodes.count; i++) if ([nodes[i] isSameNode:node]) return i;
    return NSNotFound;
}

static NSUInteger SBComposedLength(NSString *text) {
    __block NSUInteger count = 0;
    [text enumerateSubstringsInRange:NSMakeRange(0, text.length) options:NSStringEnumerationByComposedCharacterSequences
                          usingBlock:^(NSString *substring, NSRange range, NSRange enclosing, BOOL *stop) { count++; }];
    return count;
}

static BOOL SBSameText(NSString *a, NSString *b) {
    NSString *x = [SBWriter comparable:a], *y = [SBWriter comparable:b];
    return x.length > 0 && [x isEqualToString:y];
}

#pragma mark - driver

@implementation SBComboBoxDriver {
    _Atomic(bool) _active;
    _Atomic(bool) _userKeySeen;
    NSUInteger _generation;
    void (^_completion)(SBComboBoxResult *);
    id<SBAXNode> _combo;
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

- (instancetype)initWithActuator:(id<SBAXActuating>)actuator poster:(id<SBKeyPosting>)poster state:(id<SBDesktopState>)state {
    if ((self = [super init])) {
        _actuator = actuator;
        _poster = poster;
        _state = state;
        _threshold = SBComboBoxMatchThreshold;
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

- (void)setMatcher:(SBOptionMatcher)matcher {
    if (matcher) { _matcher = [matcher copy]; return; }
    _matcher = ^SBOptionMatch(NSArray<NSString *> *options, NSString *answer) { return SBMatchOption(options, answer); };
}

- (void)setDeclineMatcher:(SBOptionMatcher)matcher {
    if (matcher) { _declineMatcher = [matcher copy]; return; }
    _declineMatcher = ^SBOptionMatch(NSArray<NSString *> *options, NSString *answer) { return SBMatchDeclineOption(options, answer); };
}

- (void)setNeutralMatcher:(SBOptionMatcher)matcher {
    if (matcher) { _neutralMatcher = [matcher copy]; return; }
    _neutralMatcher = ^SBOptionMatch(NSArray<NSString *> *options, NSString *answer) { return SBMatchNeutralOption(options, answer); };
}

- (void)setIsHighlighted:(BOOL (^)(id<SBAXNode>))isHighlighted {
    if (isHighlighted) { _isHighlighted = [isHighlighted copy]; return; }
    _isHighlighted = ^BOOL(id<SBAXNode> option) {
        if (option.isFocused) return YES;
        if (SBHasHighlightClass(option)) return YES;   // react-select: the class IS the highlight
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
    NSString *normal = SBMatchNormalize(text);
    return SBMatches(normal, @"\\b(gender|sex|race|racial|ethnic\\w*|hispanic|latin[oax]|veteran|military (status|service)|disabilit\\w+|disabled"
                              "|pronouns?|sexual orientation|lgbtq?\\w*|transgender|marital|religio\\w+|age (range|group)|indigenous|aboriginal"
                              "|first nations|visible minority|caste|date of birth|birth ?date|birthday|dob|how old|age)\\b");
}

+ (BOOL)isDemographicComboBox:(id<SBAXNode>)node {
    id<SBAXNode> titleElement = node.titleUIElement;
    for (NSString *text in @[ node.title ?: @"", node.axDescription ?: @"", node.placeholder ?: @"", node.help ?: @"", node.identifier ?: @"",
                              titleElement.value ?: @"", titleElement.title ?: @"" ]) {
        if ([self isDemographicText:text]) return YES;
    }
    return NO;
}

+ (BOOL)isComboBox:(id<SBAXNode>)node {
    if ([node.role isEqualToString:@"AXComboBox"]) return YES;
    NSString *description = node.roleDescription.lowercaseString ?: @"";
    return [node.role isEqualToString:@"AXTextField"] && ([description containsString:@"combo box"] || [description containsString:@"combobox"]);
}

static BOOL SBLooksLikeList(id<SBAXNode> node) {
    if ([node.subrole isEqualToString:@"AXContentList"]) return NO;   // a bulleted list in the page text
    NSString *description = node.roleDescription.lowercaseString ?: @"";
    if ([description isEqualToString:@"content list"]) return NO;
    if ([node.role isEqualToString:@"AXList"] || [node.role isEqualToString:@"AXMenu"]) return YES;
    return [description isEqualToString:@"list box"] || [description isEqualToString:@"listbox"] || [description isEqualToString:@"menu"];
}

/// Does any DOM class of `node` end in "option"? react-select marks every row of an open menu with `select__option`
/// (plus a generated `…-option`), and in WebKit that is the ONLY thing that separates an option row from ordinary
/// page text: the role is AXStaticText and the role description is "text", not "option".
static BOOL SBHasOptionClass(id<SBAXNode> node) {
    for (NSString *name in node.domClassList) {
        NSString *lower = name.lowercaseString;
        if ([lower isEqualToString:@"option"] || [lower hasSuffix:@"-option"] || [lower hasSuffix:@"_option"]) return YES;
    }
    return NO;
}

/// react-select's highlighted row carries `select__option--is-focused`; the chosen one `--is-selected`. Neither sets
/// AXFocused or AXSelected, so the arrow-key fallback could never see a highlight on a real page without this.
static BOOL SBHasHighlightClass(id<SBAXNode> node) {
    for (NSString *name in node.domClassList) {
        NSString *lower = name.lowercaseString;
        if ([lower hasSuffix:@"--is-focused"] || [lower hasSuffix:@"--is-selected"]
            || [lower hasSuffix:@"-is-focused"] || [lower hasSuffix:@"-is-selected"]) return YES;
    }
    return NO;
}

static NSArray<id<SBAXNode>> *SBOptionsInList(id<SBAXNode> list, SBAXWalkBudget *outer);

static BOOL SBListSaysNothingFound(id<SBAXNode> list, SBAXWalkBudget *outer);

/// A list of options: list-like, holds options (or says it has none for what was typed), and no form control
/// inside (a checkbox group is not a menu).
static BOOL SBIsOptionList(id<SBAXNode> node, SBAXWalkBudget *outer) {
    if (!SBLooksLikeList(node)) return NO;
    __block BOOL hasControl = NO;
    SBAXWalkBudget budget = SBAXWalkBudgetNested(outer, kOptionSearchNodes);
    SBWalk(node, 5, &budget, ^BOOL(id<SBAXNode> child, NSUInteger depth, BOOL *stop) {
        if (depth > 0 && SBIsControlRole(child.role)) { hasControl = YES; *stop = YES; }
        return YES;
    });
    SBAXWalkBudgetAbsorb(outer, &budget);
    if (budget.hung) return NO;   // the app stopped answering: nothing it shows is trusted as a list
    if (hasControl) return NO;
    // An open menu that says "No options" is a list: it is what the page answers when nothing matches, and Shabang
    // closes it (one Escape) instead of waiting out the whole timeout with the menu hanging open.
    return SBOptionsInList(node, outer).count > 0 || SBListSaysNothingFound(node, outer);
}

static id<SBAXNode> SBFindOptionList(id<SBAXNode> root, NSUInteger maxDepth, SBAXWalkBudget *outer) {
    if (outer->hung || outer->exhausted) return nil;
    __block id<SBAXNode> found = nil;
    SBAXWalkBudget budget = SBAXWalkBudgetNested(outer, kListSearchNodes);
    SBWalk(root, maxDepth, &budget, ^BOOL(id<SBAXNode> node, NSUInteger depth, BOOL *stop) {
        if (SBIsOptionList(node, outer)) { found = node; *stop = YES; return NO; }
        if (outer->hung || outer->exhausted) { *stop = YES; return NO; }
        return ![node.subrole isEqualToString:@"AXContentList"];
    });
    SBAXWalkBudgetAbsorb(outer, &budget);
    return found;
}

+ (id<SBAXNode>)listForComboBox:(id<SBAXNode>)comboBox {
    // One wall-clock budget for the whole search (it runs inside every poll and every key guard).
    SBAXWalkBudget overall = SBAXWalkBudgetMake(NSUIntegerMax, SBComboBoxListSearchSeconds);
    if (!SBAXWalkBudgetSpend(&overall, comboBox)) return nil;
    // A native combo box owns its list.
    for (id<SBAXNode> child in comboBox.children) {
        id<SBAXNode> list = SBFindOptionList(child, 4, &overall);
        if (list) return list;
        if (overall.hung || overall.exhausted) return nil;
    }
    // react-select and friends: the menu follows the control, before the next field starts.
    id<SBAXNode> child = comboBox;
    id<SBAXNode> parent = comboBox.parent;
    for (NSUInteger level = 0; parent && level < kListLevelsUp; level++) {
        NSArray<id<SBAXNode>> *siblings = parent.children;
        NSUInteger index = SBIndexOfNode(siblings, child);
        if (index != NSNotFound) {
            for (NSUInteger i = index + 1; i < siblings.count && i <= index + kListSiblingScan; i++) {
                id<SBAXNode> sibling = siblings[i];
                if (SBIsControlRole(sibling.role) || [sibling.role isEqualToString:@"AXHeading"] || [sibling.role isEqualToString:@"AXSplitter"]) break;
                id<SBAXNode> list = SBFindOptionList(sibling, 6, &overall);
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
    id<SBAXNode> top = comboBox;
    id<SBAXNode> webArea = comboBox.parent;
    for (NSUInteger level = 0; webArea && ![webArea.role isEqualToString:@"AXWebArea"] && level < 64; level++) {
        top = webArea;
        webArea = webArea.parent;
    }
    if (![webArea.role isEqualToString:@"AXWebArea"]) return nil;
    NSArray<id<SBAXNode>> *pageChildren = webArea.children;
    NSUInteger topIndex = SBIndexOfNode(pageChildren, top);
    if (topIndex == NSNotFound) return nil;
    for (NSUInteger i = pageChildren.count; i > topIndex + 1 && i + 3 > pageChildren.count; i--) {
        id<SBAXNode> list = SBFindOptionList(pageChildren[i - 1], 6, &overall);
        if (list) return list;
        if (overall.hung || overall.exhausted) return nil;
    }
    return nil;
}

static BOOL SBListSaysNothingFound(id<SBAXNode> list, SBAXWalkBudget *outer) {
    __block BOOL nothing = NO;
    SBAXWalkBudget budget = SBAXWalkBudgetNested(outer, kOptionSearchNodes);
    SBWalk(list, 5, &budget, ^BOOL(id<SBAXNode> node, NSUInteger depth, BOOL *stop) {
        if (depth == 0) return YES;
        for (NSString *text in @[ node.value ?: @"", node.title ?: @"", node.axDescription ?: @"" ]) {
            if (!SBIsNothingFoundNotice(text)) continue;
            nothing = YES;
            *stop = YES;
            return NO;
        }
        return YES;
    });
    SBAXWalkBudgetAbsorb(outer, &budget);
    return nothing;
}

+ (BOOL)listSaysNothingFound:(id<SBAXNode>)list {
    SBAXWalkBudget budget = SBAXWalkBudgetMake(NSUIntegerMax, SBComboBoxListSearchSeconds);
    return list != nil && SBListSaysNothingFound(list, &budget);
}

+ (NSArray<id<SBAXNode>> *)optionsInList:(id<SBAXNode>)list {
    SBAXWalkBudget budget = SBAXWalkBudgetMake(NSUIntegerMax, SBComboBoxListSearchSeconds);
    return SBOptionsInList(list, &budget);
}

static NSArray<id<SBAXNode>> *SBOptionsInList(id<SBAXNode> list, SBAXWalkBudget *outer) {
    NSMutableArray<id<SBAXNode>> *explicit = [NSMutableArray array];
    NSMutableArray<id<SBAXNode>> *texts = [NSMutableArray array];
    SBAXWalkBudget budget = SBAXWalkBudgetNested(outer, kOptionSearchNodes);
    SBWalk(list, 5, &budget, ^BOOL(id<SBAXNode> node, NSUInteger depth, BOOL *stop) {
        if (depth == 0) return YES;
        NSString *description = node.roleDescription.lowercaseString ?: @"";
        if ([node.role isEqualToString:@"AXMenuItem"] || [description isEqualToString:@"option"] || [node.subrole isEqualToString:@"AXOption"]
            || SBHasOptionClass(node)) {
            NSString *text = [SBComboBoxDriver textOfOption:node];
            if (node.enabled && text.length && !SBIsNotice(text)) [explicit addObject:node];
            return NO;
        }
        if ([node.role isEqualToString:@"AXStaticText"]) {
            // NOT node.value: WebKit gives react-select's option divs (AXStaticText, role description "text") their
            // label in AXTitle and leaves AXValue empty, which is why the real Greenhouse menu read as 0 options.
            NSString *text = [SBComboBoxDriver textOfOption:node];
            if (text.length && !SBIsNotice(text)) [texts addObject:node];
            return NO;   // nested static text repeats its parent
        }
        return YES;
    });
    SBAXWalkBudgetAbsorb(outer, &budget);
    return explicit.count ? explicit : texts;
}

+ (NSString *)textOfOption:(id<SBAXNode>)option {
    for (NSString *text in @[ option.title ?: @"", option.value ?: @"", option.axDescription ?: @"" ]) {
        if (SBTrimmed(text).length) return SBTrimmed(text);
    }
    NSMutableArray<NSString *> *parts = [NSMutableArray array];
    SBAXWalkBudget budget = SBAXWalkBudgetMake(40, SBComboBoxListSearchSeconds);
    SBWalk(option, 3, &budget, ^BOOL(id<SBAXNode> node, NSUInteger depth, BOOL *stop) {
        if (depth > 0 && [node.role isEqualToString:@"AXStaticText"] && SBTrimmed(node.value).length) {
            [parts addObject:SBTrimmed(node.value)];
            return NO;
        }
        return YES;
    });
    return [parts componentsJoinedByString:@" "];
}

+ (NSArray<NSString *> *)shownTextsForComboBox:(id<SBAXNode>)comboBox typed:(NSString *)typed {
    NSMutableArray<NSString *> *shown = [NSMutableArray array];
    void (^add)(NSString *) = ^(NSString *text) {
        NSString *clean = SBTrimmed(text);
        if (clean.length && ![SBWriter isPlaceholderChoice:clean]) [shown addObject:clean];
    };
    NSString *own = SBTrimmed(comboBox.value);
    if (own.length && !(typed.length && SBSameText(own, typed))) add(own);

    NSString *label = SBTrimmed(comboBox.title.length ? comboBox.title : comboBox.axDescription);
    NSArray<id<SBAXNode>> *siblings = comboBox.parent.children ?: @[];
    NSUInteger index = SBIndexOfNode(siblings, comboBox);
    if (index == NSNotFound) return shown;
    for (NSUInteger step = 1; step <= 3 && step <= index; step++) {
        id<SBAXNode> sibling = siblings[index - step];
        if (SBIsControlRole(sibling.role) || [sibling.role isEqualToString:@"AXButton"] || [sibling.role isEqualToString:@"AXHeading"]) break;
        if ([sibling.identifier hasSuffix:@"-label"]) break;
        if ([sibling.role isEqualToString:@"AXStaticText"] && label.length && SBSameText(sibling.value, label)) break;   // the question itself
        if (SBIsLiveRegion(sibling)) continue;
        if ([sibling.role isEqualToString:@"AXStaticText"]) { add(sibling.value); continue; }
        SBAXWalkBudget budget = SBAXWalkBudgetMake(40, SBComboBoxListSearchSeconds);
        SBWalk(sibling, 3, &budget, ^BOOL(id<SBAXNode> node, NSUInteger depth, BOOL *stop) {
            if (SBIsLiveRegion(node)) return NO;
            if ([node.role isEqualToString:@"AXStaticText"]) { add(node.value); return NO; }
            return YES;
        });
    }
    return shown;
}

#pragma mark run

- (BOOL)looksSensitive:(id<SBAXNode>)node {
    if ([node.role isEqualToString:@"AXSecureTextField"] || [node.subrole isEqualToString:@"AXSecureTextField"]) return YES;
    if (!self.isNodeSensitive) return YES;   // fail closed, like SBWriter
    return self.isNodeSensitive(node);
}

- (void)chooseAnswer:(NSString *)answer inComboBox:(id<SBAXNode>)comboBox completion:(void (^)(SBComboBoxResult *))completion {
    [self chooseAnswer:answer inComboBox:comboBox decline:NO neutralFallback:NO completion:completion];
}

- (void)chooseAnswer:(NSString *)answer
          inComboBox:(id<SBAXNode>)comboBox
             decline:(BOOL)decline
          completion:(void (^)(SBComboBoxResult *))completion {
    [self chooseAnswer:answer inComboBox:comboBox decline:decline neutralFallback:NO completion:completion];
}

- (void)chooseAnswer:(NSString *)answer
          inComboBox:(id<SBAXNode>)comboBox
             decline:(BOOL)decline
     neutralFallback:(BOOL)neutralFallback
          completion:(void (^)(SBComboBoxResult *))completion {
    NSString *label = SBLogLabel(comboBox.title.length ? comboBox.title : comboBox.axDescription);
    void (^refuse)(SBComboBoxOutcome, NSString *) = ^(SBComboBoxOutcome outcome, NSString *reason) {
        SBLog(@"combobox: label=%@ refused (%@)", label, reason);
        SBComboBoxResult *result = [[SBComboBoxResult alloc] init];
        result.outcome = outcome;
        result.reason = reason;
        result.method = SBComboBoxMethodNone;
        completion(result);
    };
    if (_running) { refuse(SBComboBoxOutcomeFailed, SBComboBoxReasonBusy); return; }
    NSString *wanted = SBTrimmed(answer);
    BOOL control = NO;
    for (NSUInteger i = 0; i < wanted.length && !control; i++) {
        unichar c = [wanted characterAtIndex:i];
        control = c < 0x20 || c == 0x7F || (c >= 0x80 && c < 0xA0) || c == 0x2028 || c == 0x2029;
    }
    if (wanted.length == 0 || control) { refuse(SBComboBoxOutcomeSkipped, SBComboBoxReasonUnsupported); return; }
    id<SBAXNode> combo = comboBox ? [self.actuator refreshedNode:comboBox] : nil;
    if (!combo) { refuse(SBComboBoxOutcomeSkipped, SBComboBoxReasonGone); return; }
    if (![SBComboBoxDriver isComboBox:combo]) { refuse(SBComboBoxOutcomeSkipped, SBComboBoxReasonUnsupported); return; }
    // A demographic question is only ever DECLINED. Anything else the caller may want there is refused,
    // whatever it asks for (docs/answers.md section 7).
    if (!decline && [SBComboBoxDriver isDemographicComboBox:combo]) { refuse(SBComboBoxOutcomeSkipped, SBComboBoxReasonDemographic); return; }
    if ([self looksSensitive:combo]) { refuse(SBComboBoxOutcomeSkipped, SBComboBoxReasonSensitive); return; }
    if (!combo.enabled) { refuse(SBComboBoxOutcomeSkipped, SBComboBoxReasonDisabled); return; }
    if (combo.value.length > 0 || [SBComboBoxDriver shownTextsForComboBox:combo typed:nil].count > 0) { refuse(SBComboBoxOutcomeSkipped, SBComboBoxReasonHasValue); return; }
    pid_t pid = [self.state frontmostProcessIdentifier];
    if (pid <= 0) { refuse(SBComboBoxOutcomeSkipped, SBComboBoxReasonNoFrontmostApp); return; }

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
        id<SBAXNode> focused = [self.state focusedElement];
        if (![focused isSameNode:self->_combo]) { [self finish:SBComboBoxOutcomeSkipped reason:SBComboBoxReasonNotFocused method:SBComboBoxMethodNone escaped:NO cleared:NO]; return; }
        [self openByPress];
    }];
}

/// Step 3a, before any key: AXPress the combo box itself. On the real Greenhouse form this is what opens
/// react-select's menu -- typing into that 4 px wide inner input opens nothing -- and it costs the page no
/// keystrokes at all. A control that does not answer a press falls through to typing, which is what a location or
/// type-ahead field needs.
- (void)openByPress {
    if (!_running || ![self stillSafe]) return;
    id<SBAXNode> combo = [self.actuator refreshedNode:_combo];
    if (!combo) { [self finish:SBComboBoxOutcomeSkipped reason:SBComboBoxReasonGone method:SBComboBoxMethodNone escaped:NO cleared:NO]; return; }
    if (![self.actuator pressNode:combo]) { [self typeAnswer]; return; }
    _openedByPress = YES;
    [self waitForOpenedListUntil:self.clock() + self.openTimeout generation:_generation];
}

/// Like waitForListUntil:, but running out is not a failure: it just means this control does not open on a press,
/// so the old typing path takes over.
- (void)waitForOpenedListUntil:(NSTimeInterval)deadline generation:(NSUInteger)generation {
    if (generation != _generation || !_running || ![self stillSafe]) return;
    id<SBAXNode> list = [self currentList];
    NSArray<id<SBAXNode>> *options = list ? [SBComboBoxDriver optionsInList:list] : @[];
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
    if (_declining) { [self abandon:SBComboBoxReasonNoList]; return; }
    SBKeyBurstResult *burst = [self.poster postBurst:@[ [SBKeyStroke text:_answer] ] guard:^BOOL(SBKeyStroke *stroke, pid_t frontmost, id<SBAXNode> focused) {
        return [focused isSameNode:self->_combo] && [self mayPostTo:frontmost];
    } lastCheck:[self mayStillPost]];
    if (burst.postedCount > 0) _typed = YES;
    if (!burst.ok) {
        if (burst.postedCount > 0) { [self finish:SBComboBoxOutcomeFailed reason:SBComboBoxReasonTypingInterrupted method:SBComboBoxMethodNone escaped:NO cleared:NO]; return; }
        NSString *reason = [self reasonForBurst:burst fallback:SBComboBoxReasonFocusChanged];
        SBComboBoxOutcome outcome = [reason isEqualToString:SBComboBoxReasonFocusChanged] ? SBComboBoxOutcomeSkipped : SBComboBoxOutcomeFailed;
        [self finish:outcome reason:reason method:SBComboBoxMethodNone escaped:NO cleared:NO];
        return;
    }
    [self waitForListUntil:self.clock() + self.listTimeout generation:_generation];
}

- (void)waitForListUntil:(NSTimeInterval)deadline generation:(NSUInteger)generation {
    if (generation != _generation || !_running || ![self stillSafe]) return;
    id<SBAXNode> list = [self currentList];
    NSArray<id<SBAXNode>> *options = list ? [SBComboBoxDriver optionsInList:list] : @[];
    if (options.count) { [self pickFrom:options]; return; }
    // The page itself says nothing matches what was typed: close the menu, take the typing back, skip the field.
    if (list && [SBComboBoxDriver listSaysNothingFound:list]) { [self abandon:SBComboBoxReasonNoMatchingOption]; return; }
    if (self.clock() >= deadline) { [self abandon:SBComboBoxReasonNoList]; return; }
    self.after(self.pollInterval, ^{ [self waitForListUntil:deadline generation:generation]; });
}

- (id<SBAXNode>)currentList {
    id<SBAXNode> combo = [self.actuator refreshedNode:_combo];
    return combo ? [SBComboBoxDriver listForComboBox:combo] : nil;
}

- (NSArray<NSString *> *)textsOf:(NSArray<id<SBAXNode>> *)options {
    NSMutableArray<NSString *> *texts = [NSMutableArray arrayWithCapacity:options.count];
    for (id<SBAXNode> option in options) [texts addObject:[SBComboBoxDriver textOfOption:option]];
    return texts;
}

- (void)pickFrom:(NSArray<id<SBAXNode>> *)options {
    NSArray<NSString *> *texts = [self textsOf:options];
    _optionCount = texts.count;
    SBOptionMatch match = _declining ? self.declineMatcher(texts, _answer) : self.matcher(texts, _answer);
    BOOL neutral = NO;
    if ((match.index < 0 || (NSUInteger)match.index >= texts.count || match.score < self.threshold) && _neutralFallback) {
        // The answer is not among the options. An ORDINARY question still gets an answer: whatever this list
        // itself calls the neutral choice (docs/answers.md section 3). It is tried before any typing, because a
        // list that offers "Other" is a fixed set of choices -- typing a word it does not have would only filter
        // it down to nothing. A list with no neutral option falls through to the old path untouched.
        SBOptionMatch fallback = self.neutralMatcher(texts, _answer);
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
        [self abandon:SBComboBoxReasonNoMatchingOption];
        return;
    }
    _tookNeutral = neutral;
    _chosenText = texts[(NSUInteger)match.index];
    _score = match.score;
    id<SBAXNode> option = options[(NSUInteger)match.index];
    if (![self.actuator pressNode:option]) { [self selectWithKeysStep:0]; return; }
    NSUInteger generation = _generation;
    [self later:self.verifyDelay do:^{
        if ([self verified]) { [self finish:SBComboBoxOutcomeChosen reason:nil method:SBComboBoxMethodPress escaped:NO cleared:NO]; return; }
        // The press did nothing visible and the list is still open: the keyboard, at once. Waiting would only
        // delay a control that is never going to answer a press.
        if ([self currentList]) { [self selectWithKeysStep:0]; return; }
        // The list closed with nothing showing yet. That is either a page whose accessibility tree lags its own
        // update, or a react-select whose option row answers a real mouse press and not a synthesized one. Look a
        // few more times, and only then open the menu once more and take the same keyboard path -- once per run,
        // and never while something IS showing: a press that chose the wrong option gets no second choice.
        [self verifyAttempt:1 generation:generation then:^(BOOL ok) {
            if (ok) { [self finish:SBComboBoxOutcomeChosen reason:nil method:SBComboBoxMethodPress escaped:NO cleared:NO]; return; }
            if ([self currentList]) { [self selectWithKeysStep:0]; return; }
            if (!self->_reopened && [self showsNothing]) { [self reopenForKeys]; return; }
            [self failNotVerified];
        }];
    }];
}

/// Nothing at all is showing in the combobox: no value of its own, and no chosen-value text beside it.
- (BOOL)showsNothing {
    id<SBAXNode> combo = [self.actuator refreshedNode:_combo];
    if (!combo) return NO;
    if (SBTrimmed(combo.value).length > 0) return NO;
    return [SBComboBoxDriver shownTextsForComboBox:combo typed:_answer].count == 0;
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
    id<SBAXNode> combo = [self.actuator refreshedNode:_combo];
    if (!combo) { [self failNotVerified]; return; }
    [self.actuator focusNode:combo];
    [self later:self.focusSettleDelay do:^{
        id<SBAXNode> fresh = [self.actuator refreshedNode:self->_combo];
        if (!fresh || ![[self.state focusedElement] isSameNode:self->_combo] || ![self.actuator pressNode:fresh]) {
            [self failNotVerified];
            return;
        }
        [self waitForReopenedListUntil:self.clock() + self.openTimeout generation:generation];
    }];
}

- (void)waitForReopenedListUntil:(NSTimeInterval)deadline generation:(NSUInteger)generation {
    if (generation != _generation || !_running || ![self stillSafe]) return;
    id<SBAXNode> list = [self currentList];
    if (list && [SBComboBoxDriver optionsInList:list].count > 0) { [self selectWithKeysStep:0]; return; }
    if (self.clock() >= deadline) { [self failNotVerified]; return; }
    self.after(self.pollInterval, ^{ [self waitForReopenedListUntil:deadline generation:generation]; });
}

- (void)failNotVerified {
    [self finish:SBComboBoxOutcomeFailed reason:SBComboBoxReasonNotVerified method:SBComboBoxMethodPress escaped:NO cleared:NO];
}

- (NSInteger)indexOfChosenIn:(NSArray<NSString *> *)texts {
    for (NSUInteger i = 0; i < texts.count; i++) if (SBSameText(texts[i], _chosenText)) return (NSInteger)i;
    return -1;
}

- (NSInteger)highlightedIndexIn:(NSArray<id<SBAXNode>> *)options {
    for (NSUInteger i = 0; i < options.count; i++) if (self.isHighlighted(options[i])) return (NSInteger)i;
    return -1;
}

/// Re-read right before a Return: the list is open and the highlighted option is the chosen one.
- (BOOL)chosenOptionIsHighlightedNow {
    id<SBAXNode> list = [self currentList];
    if (!list) return NO;
    NSArray<id<SBAXNode>> *options = [SBComboBoxDriver optionsInList:list];
    NSInteger highlighted = [self highlightedIndexIn:options];
    return highlighted >= 0 && SBSameText([SBComboBoxDriver textOfOption:options[(NSUInteger)highlighted]], _chosenText);
}

- (void)selectWithKeysStep:(NSUInteger)step {
    if (!_running || ![self stillSafe]) return;
    id<SBAXNode> list = [self currentList];
    if (!list) { [self finish:SBComboBoxOutcomeFailed reason:SBComboBoxReasonListClosed method:SBComboBoxMethodKeys escaped:NO cleared:NO]; return; }
    NSArray<id<SBAXNode>> *options = [SBComboBoxDriver optionsInList:list];
    NSInteger target = [self indexOfChosenIn:[self textsOf:options]];
    if (target < 0) { [self abandon:SBComboBoxReasonOptionVanished]; return; }
    if (step > options.count + 2) { [self abandon:SBComboBoxReasonNoHighlight]; return; }
    NSInteger highlighted = [self highlightedIndexIn:options];
    if (highlighted == target) {
        SBKeyBurstResult *burst = [self.poster postBurst:@[ [SBKeyStroke returnKey] ] guard:^BOOL(SBKeyStroke *stroke, pid_t frontmost, id<SBAXNode> focused) {
            // The slow re-read of the list first, the cheap checks last; the poster reads focus and the app again
            // after this and asks mayStillPost right before the Return goes out.
            return [self chosenOptionIsHighlightedNow] && [focused isSameNode:self->_combo] && [self mayPostTo:frontmost];
        } lastCheck:[self mayStillPost]];
        if (!burst.ok) { [self finish:SBComboBoxOutcomeFailed reason:[self reasonForBurst:burst fallback:SBComboBoxReasonFocusChanged] method:SBComboBoxMethodKeys escaped:NO cleared:NO]; return; }
        [self verifyThen:^(BOOL ok) {
            [self finish:ok ? SBComboBoxOutcomeChosen : SBComboBoxOutcomeFailed reason:ok ? nil : SBComboBoxReasonNotVerified method:SBComboBoxMethodKeys escaped:NO cleared:NO];
        }];
        return;
    }
    SBKeyStroke *arrow = (highlighted < 0 || highlighted < target) ? [SBKeyStroke downArrow] : [SBKeyStroke upArrow];
    SBKeyBurstResult *burst = [self.poster postBurst:@[ arrow ] guard:^BOOL(SBKeyStroke *stroke, pid_t frontmost, id<SBAXNode> focused) {
        return [self currentList] != nil && [focused isSameNode:self->_combo] && [self mayPostTo:frontmost];
    } lastCheck:[self mayStillPost]];
    if (!burst.ok) { [self finish:SBComboBoxOutcomeFailed reason:[self reasonForBurst:burst fallback:SBComboBoxReasonFocusChanged] method:SBComboBoxMethodKeys escaped:NO cleared:NO]; return; }
    [self later:self.keyStepDelay do:^{ [self selectWithKeysStep:step + 1]; }];
}

- (BOOL)verified {
    if ([self currentList]) return NO;
    id<SBAXNode> combo = [self.actuator refreshedNode:_combo];
    if (!combo) return NO;
    for (NSString *text in [SBComboBoxDriver shownTextsForComboBox:combo typed:_answer]) {
        if (SBSameText(text, _chosenText)) return YES;
    }
    return NO;
}

/// Nothing chosen: one Escape (only while an option list is really open), then take back what was typed, then
/// report the field as skipped. With no list showing, an Escape would travel on to the page or the window (a modal
/// closes, a native sheet cancels), so none is posted.
- (void)abandon:(NSString *)reason {
    BOOL escaped = NO;
    if ((_openedByPress || ![reason isEqualToString:SBComboBoxReasonNoList]) && [self mayPostTo:[self.state frontmostProcessIdentifier]]) {
        SBKeyBurstResult *burst = [self.poster postBurst:@[ [SBKeyStroke escape] ] guard:^BOOL(SBKeyStroke *stroke, pid_t frontmost, id<SBAXNode> focused) {
            // The expensive check first; focus, app and the user's keys are read again by the poster after it.
            return [self currentList] != nil && [focused isSameNode:self->_combo] && [self mayPostTo:frontmost];
        } lastCheck:[self mayStillPost]];
        escaped = burst.ok;
    }
    NSUInteger generation = _generation;
    self.after(self.keyStepDelay, ^{
        if (generation != self->_generation || !self->_running) return;
        if (atomic_load(&self->_userKeySeen)) {   // the user took over: not a clean skip, and nothing more is posted
            [self finish:SBComboBoxOutcomeFailed reason:SBComboBoxReasonUserKey method:SBComboBoxMethodNone escaped:escaped cleared:NO];
            return;
        }
        id<SBAXNode> combo = [self.actuator refreshedNode:self->_combo];
        NSString *left = combo.value ?: @"";
        BOOL cleared = combo != nil && left.length == 0;
        id<SBAXNode> focused = [self.state focusedElement];
        if (combo && left.length > 0 && [focused isSameNode:self->_combo] && [self mayPostTo:[self.state frontmostProcessIdentifier]]) {
            NSUInteger count = MIN(MIN(SBComposedLength(self->_answer), SBComposedLength(left)), kMaxBackspaces);
            NSMutableArray<SBKeyStroke *> *strokes = [NSMutableArray arrayWithCapacity:count];
            for (NSUInteger i = 0; i < count; i++) [strokes addObject:[SBKeyStroke backspace]];
            SBKeyBurstResult *burst = strokes.count ? [self.poster postBurst:strokes guard:^BOOL(SBKeyStroke *stroke, pid_t frontmost, id<SBAXNode> now) {
                return [now isSameNode:self->_combo] && [self mayPostTo:frontmost];
            } lastCheck:[self mayStillPost]] : nil;
            id<SBAXNode> after = [self.actuator refreshedNode:self->_combo];
            cleared = burst.ok && after.value.length == 0;
        }
        [self finish:SBComboBoxOutcomeSkipped reason:reason method:SBComboBoxMethodNone escaped:escaped cleared:cleared];
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
    __weak SBComboBoxDriver *weakSelf = self;
    return ^BOOL {
        SBComboBoxDriver *driver = weakSelf;
        return driver != nil && [driver mayPostTo:[driver.state frontmostProcessIdentifier]];
    };
}

- (BOOL)stillSafe {
    if (atomic_load(&_userKeySeen)) { [self finish:SBComboBoxOutcomeFailed reason:SBComboBoxReasonUserKey method:SBComboBoxMethodNone escaped:NO cleared:NO]; return NO; }
    if ([self.state frontmostProcessIdentifier] != _pid) { [self finish:SBComboBoxOutcomeFailed reason:SBComboBoxReasonAppChanged method:SBComboBoxMethodNone escaped:NO cleared:NO]; return NO; }
    return YES;
}

- (NSString *)reasonForBurst:(SBKeyBurstResult *)burst fallback:(NSString *)fallback {
    if ([burst.reason isEqualToString:SBKeyBurstReasonPostFailed] || [burst.reason isEqualToString:SBKeyBurstReasonMalformed]) return SBComboBoxReasonKeysRefused;
    if (atomic_load(&_userKeySeen)) return SBComboBoxReasonUserKey;
    if ([self.state frontmostProcessIdentifier] != _pid) return SBComboBoxReasonAppChanged;
    return fallback;
}

- (void)finish:(SBComboBoxOutcome)outcome reason:(NSString *)reason method:(NSString *)method escaped:(BOOL)escaped cleared:(BOOL)cleared {
    if (!_running) return;
    SBComboBoxResult *result = [[SBComboBoxResult alloc] init];
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
    void (^completion)(SBComboBoxResult *) = _completion;
    _completion = nil;
    SBLog(@"combobox: label=%@ %@ reason=%@ method=%@ options=%lu score=%.2f escape=%d cleared=%d %.0f ms", _label,
          outcome == SBComboBoxOutcomeChosen ? @"chosen" : (outcome == SBComboBoxOutcomeSkipped ? @"skipped" : @"failed"), reason ?: @"-", method,
          (unsigned long)_optionCount, _score, escaped, cleared, result.elapsed * 1000.0);
    if (_tookNeutral && outcome == SBComboBoxOutcomeChosen) SBLog(@"combobox: label=%@ took the list's own neutral option", _label);
    if (completion) completion(result);
}

- (void)noteUserKeyEvent {
    if (atomic_load(&_active)) atomic_store(&_userKeySeen, true);
}

- (void)cancel {
    [self finish:SBComboBoxOutcomeFailed reason:SBComboBoxReasonCancelled method:SBComboBoxMethodNone escaped:NO cleared:NO];
}

@end
