#import "GHCapture.h"

#pragma mark - Roles

static NSString *const kRoleWindow = @"AXWindow";
static NSString *const kRoleWebArea = @"AXWebArea";
static NSString *const kRoleGroup = @"AXGroup";
static NSString *const kRoleStaticText = @"AXStaticText";
static NSString *const kRoleHeading = @"AXHeading";
static NSString *const kRoleTextField = @"AXTextField";
static NSString *const kRoleSecureTextField = @"AXSecureTextField";
static NSString *const kRoleTextArea = @"AXTextArea";
static NSString *const kRoleComboBox = @"AXComboBox";
static NSString *const kRolePopUpButton = @"AXPopUpButton";
static NSString *const kRoleCheckBox = @"AXCheckBox";
static NSString *const kRoleRadioGroup = @"AXRadioGroup";
static NSString *const kRoleRadioButton = @"AXRadioButton";
static NSString *const kRoleButton = @"AXButton";
static NSString *const kRoleLink = @"AXLink";
static NSString *const kRoleTabGroup = @"AXTabGroup";
static NSString *const kRoleRow = @"AXRow";
static NSString *const kRoleCell = @"AXCell";
static NSString *const kRoleMenuButton = @"AXMenuButton";
static NSString *const kRoleDisclosureTriangle = @"AXDisclosureTriangle";
static NSString *const kSubroleFileUpload = @"AXFileUploadButton";
static NSString *const kSubroleTabButton = @"AXTabButton";

static const NSUInteger kMaxLabel = 160;
static const NSUInteger kMaxContext = 80;
static const NSUInteger kMaxSignatureLabel = 80;
static const NSUInteger kCheapOptionCount = 60;   // more than this and options are read lazily
static const NSUInteger kPrecedingSiblingScan = 8;
static const NSUInteger kHeadingSiblingScan = 20;
static const NSUInteger kLabelLevelsUp = 2;
static const NSUInteger kContextLevelsUp = 6;
static const NSUInteger kUploadLevelsUp = 3;       // file input -> its wrapper -> the upload widget (Greenhouse: 2)
static const NSUInteger kComboAccessoryScan = 3;   // siblings around a combo box that belong to it (placeholder, toggle)
static const CGFloat kMinBox = 2;                  // same floor as the extension: honeypots live below it

static NSSet<NSString *> *GHSet(NSArray<NSString *> *items) { return [NSSet setWithArray:items]; }

/// Never entered, wherever they are.
static NSSet<NSString *> *GHAlwaysSkippedRoles(void) {
    static NSSet *roles; static dispatch_once_t once;
    dispatch_once(&once, ^{ roles = GHSet(@[ @"AXMenuBar", @"AXMenuBarItem", @"AXMenu", @"AXMenuItem", @"AXScrollBar", @"AXGrowArea", @"AXRuler", @"AXSplitter" ]); });
    return roles;
}

/// Containers that repeat one row shape. Only the first `maxListRows` children are entered: a Finder folder or a
/// Spotify playlist has thousands, nobody wants the 900th, and walking them all spends the whole time budget.
static NSSet<NSString *> *GHListContainerRoles(void) {
    static NSSet *roles; static dispatch_once_t once;
    dispatch_once(&once, ^{ roles = GHSet(@[ @"AXTable", @"AXOutline", @"AXList", @"AXGrid", @"AXBrowser" ]); });
    return roles;
}

/// Visited (they can label a field) but never expanded.
static NSSet<NSString *> *GHLeafRoles(void) {
    static NSSet *roles; static dispatch_once_t once;
    dispatch_once(&once, ^{
        roles = GHSet(@[ kRoleStaticText, @"AXImage", @"AXValueIndicator", @"AXProgressIndicator", @"AXBusyIndicator",
                         @"AXIncrementor", @"AXSlider", @"AXColorWell", @"AXDateField", @"AXTimeField",
                         @"AXLevelIndicator", @"AXRelevanceIndicator" ]);
    });
    return roles;
}

/// Window furniture that happens to be an AXButton. AXToolbarButton is deliberately NOT here: in a native app
/// the toolbar is where the app keeps the thing you came to press (Compose, New Folder, Share).
static NSSet<NSString *> *GHSkippedButtonSubroles(void) {
    static NSSet *roles; static dispatch_once_t once;
    dispatch_once(&once, ^{
        roles = GHSet(@[ @"AXCloseButton", @"AXMinimizeButton", @"AXZoomButton", @"AXFullScreenButton",
                         @"AXSortButton", @"AXIncrementArrow", @"AXDecrementArrow", @"AXIncrementPage", @"AXDecrementPage" ]);
    });
    return roles;
}

static NSSet<NSString *> *GHFieldRoles(void) {
    static NSSet *roles; static dispatch_once_t once;
    dispatch_once(&once, ^{
        roles = GHSet(@[ kRoleTextField, kRoleSecureTextField, kRoleTextArea, kRoleComboBox, kRolePopUpButton, kRoleCheckBox,
                         kRoleRadioGroup, kRoleRadioButton, kRoleButton, kRoleLink ]);
    });
    return roles;
}

#pragma mark - Patterns

static NSRegularExpression *GHRegex(NSString *pattern) {
    NSError *error = nil;
    NSRegularExpression *regex = [NSRegularExpression regularExpressionWithPattern:pattern options:NSRegularExpressionCaseInsensitive error:&error];
    NSCAssert(regex != nil, @"bad pattern %@: %@", pattern, error);
    return regex;
}

static BOOL GHMatches(NSRegularExpression *regex, NSString *text) {
    if (text.length == 0) return NO;
    return [regex firstMatchInString:text options:0 range:NSMakeRange(0, text.length)] != nil;
}

/// Compiling a pattern costs more than running it on a label, and a capture cleans hundreds of labels.
static NSString *GHReplace(NSString *text, NSString *pattern, NSString *replacement, BOOL caseInsensitive) {
    static NSMutableDictionary<NSString *, NSRegularExpression *> *compiled;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ compiled = [NSMutableDictionary dictionary]; });
    NSString *key = [NSString stringWithFormat:@"%d%@", caseInsensitive, pattern];
    NSRegularExpression *regex = nil;
    @synchronized (compiled) {
        regex = compiled[key];
        if (!regex) {
            NSRegularExpressionOptions options = caseInsensitive ? NSRegularExpressionCaseInsensitive : 0;
            regex = [NSRegularExpression regularExpressionWithPattern:pattern options:options error:NULL];
            if (regex) compiled[key] = regex;
        }
    }
    if (!regex || text.length == 0) return text;
    return [regex stringByReplacingMatchesInString:text options:0 range:NSMakeRange(0, text.length) withTemplate:replacement];
}

// Port of SENSITIVE_TEXT_SOURCE (shared/src/sensitive.ts). Second opinion only: the shared core is the
// source of truth and the two answers are ORed, so drift can only make capture stricter.
static NSRegularExpression *GHSensitivePattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{
        regex = GHRegex([@[
            @"passw(or)?d", @"passcode", @"\\bpwd\\b", @"\\bpin\\b", @"\\botp\\b", @"one[- ]time code", @"verification code", @"2fa", @"\\bmfa\\b",
            @"authenticat(ion|or) code", @"recovery (phrase|code|key)",
            @"\\bssn\\b", @"social security", @"\\bsin\\b", @"social insurance", @"national (id|insurance)", @"\\bnino\\b",
            @"passport", @"driver'?s? licen[cs]e", @"licen[cs]e number", @"tax(payer)? id", @"\\btin\\b", @"\\bitin\\b",
            @"government id", @"health (card|number)", @"\\bohip\\b",
            @"card ?(number|num\\b|no\\b|#)", @"credit card", @"debit card", @"name on (the )?card", @"card ?holder",
            @"\\bcc ?(num|number|no|exp|name|csc|cvv|cvc)", @"\\bcvv\\d?\\b", @"\\bcvc\\d?\\b", @"\\bcsc\\b", @"security code",
            @"expir(y|ation|es)", @"\\bmm ?/ ?yy",
            @"routing", @"account number", @"\\biban\\b", @"\\bswift\\b", @"bank account",
            @"secret", @"api[- _]?key", @"private key", @"seed phrase",
        ] componentsJoinedByString:@"|"]);
    });
    return regex;
}

// Port of IRREVERSIBLE (shared/src/locks.ts). ORed with the shared core: when in doubt, lock.
static NSRegularExpression *GHLockPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{
        regex = GHRegex([@[
            @"submit", @"send", @"\\bpay\\b", @"pay now", @"place (my |your )?order", @"order now", @"\\bbuy\\b", @"purchase",
            @"check ?out", @"delete", @"remove", @"discard", @"confirm", @"apply now", @"\\bapply\\b", @"publish", @"\\bpost\\b",
            @"transfer", @"withdraw", @"\\bsign\\b", @"unsubscribe", @"cancel (my |your )?(subscription|order|account)",
            @"book now", @"reserve", @"donate", @"finish", @"complete",
        ] componentsJoinedByString:@"|"]);
    });
    return regex;
}

// "Card details > Number" is a card number even though neither word alone says so (same rule as the extension).
static NSRegularExpression *GHCardContextPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = GHRegex(@"\\bcards?\\b|\\bpayment\\b"); });
    return regex;
}

static NSRegularExpression *GHGenericCardLabelPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{
        regex = GHRegex(@"^(name|full name|holder|number|num|no|#|expiry|expiration|exp|exp date|valid (thru|until|to)|code|security)$");
    });
    return regex;
}

static NSRegularExpression *GHRequiredMarkPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = GHRegex(@"^\\*|\\*$|\\(required\\)$"); });
    return regex;
}

static NSRegularExpression *GHPlaceholderChoicePattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = GHRegex(@"^(select|choose|please|--)"); });
    return regex;
}

static NSRegularExpression *GHEmailLabelPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = GHRegex(@"e[- ]?mail"); });
    return regex;
}

static NSRegularExpression *GHTelLabelPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = GHRegex(@"phone|mobile|telephone|\\bcell\\b|\\btel\\b"); });
    return regex;
}

static NSRegularExpression *GHURLLabelPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = GHRegex(@"\\burl\\b|web ?site|homepage|portfolio"); });
    return regex;
}

// A field that is nothing but the name of a profile site ("LinkedIn Profile", "Github", "Portfolio URL") wants a
// link. Anchored on purpose: "GitHub username" wants a handle, and "How did you hear about us (LinkedIn...)" is prose.
static NSRegularExpression *GHProfileLinkLabelPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{
        regex = GHRegex(@"^(your )?(personal )?(linked ?in|git ?hub|git ?lab|bitbucket|behance|dribbble|stack ?overflow|portfolio|web ?site|blog|home ?page)"
                        @"( (profile|page|account|site))?( (url|link|address))?$");
    });
    return regex;
}

// Safari's address field outside any web area (Chrome's lives in a toolbar, which is skipped as a whole).
static NSRegularExpression *GHAddressFieldIdentifierPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = GHRegex(@"^WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD$|address_?and_?search|omnibox|^url ?bar$|^location ?bar$"); });
    return regex;
}

// The control that opens the file picker of an upload widget, as opposed to its cloud-drive alternatives.
static NSRegularExpression *GHAttachLabelPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = GHRegex(@"^(attach|upload|browse|choose( a)? files?|select( a)? files?|add( a)? files?)\\b"); });
    return regex;
}

// Removing an attached file is locked everywhere else; inside an upload widget it belongs to that widget.
static NSRegularExpression *GHFileRemovalPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = GHRegex(@"\\b(remove|delete|clear|discard)\\b"); });
    return regex;
}

// What the file input itself is called in WebKit and Chromium: says nothing about WHICH file.
static NSRegularExpression *GHGenericUploadNamePattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = GHRegex(@"^(choose|select|browse|attach|upload|add)( an?)?( (file|files|document))?$|^no files? (selected|chosen)$|^file upload( button)?$"); });
    return regex;
}

static NSRegularExpression *GHAttachedFileNamePattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = GHRegex(@"\\S\\.(pdf|docx?|rtf|txt|odt|pages)$"); });
    return regex;
}

// The disclosure button a combo box brings along (react-select: "Toggle flyout"). Part of the select, never a field.
static NSRegularExpression *GHComboToggleLabelPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{
        regex = GHRegex(@"^((toggle|open|show|close|hide|expand|collapse)( (the )?(flyout|menu|options|list|dropdown|suggestions|choices))?|flyout|dropdown|clear( (selection|value|all))?)$");
    });
    return regex;
}

// A site's own "Autofill my application" (resume parsing) competes with Ghost for the same fields: ignored.
static NSRegularExpression *GHSiteAutofillPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = GHRegex(@"\\bauto[- ]?fill\\b"); });
    return regex;
}

static NSRegularExpression *GHCoverLetterPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = GHRegex(@"\\bcover ?letters?\\b|\\bmotivation(al)? letter\\b"); });
    return regex;
}

static NSRegularExpression *GHResumePattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = GHRegex(@"\\br[eé]sum[eé]s?\\b|\\bcv\\b|\\bcurriculum vitae\\b"); });
    return regex;
}

// React useId (":r1:"), long digit runs and hex blobs change on every load: useless in a signature.
static NSRegularExpression *GHUnstableIdentifierPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = GHRegex(@"^:r[0-9a-z]+:$|\\d{4,}|[0-9a-f]{8,}"); });
    return regex;
}

#pragma mark - Small helpers

static NSString *GHSquash(NSString *text) {
    if (text.length == 0) return @"";
    NSArray<NSString *> *parts = [text componentsSeparatedByCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    NSMutableArray<NSString *> *words = [NSMutableArray arrayWithCapacity:parts.count];
    for (NSString *part in parts) if (part.length) [words addObject:part];
    return [words componentsJoinedByString:@" "];
}

static NSString *GHTruncate(NSString *text, NSUInteger max) {
    if (text.length <= max) return text;
    NSRange safe = [text rangeOfComposedCharacterSequencesForRange:NSMakeRange(0, max)];
    return [text substringWithRange:safe];
}

/// sensitiveProbeText from shared/src/sensitive.ts: "card_number" and "cardNumber" read as words, "S.I.N." as "SIN".
static NSString *GHSensitiveProbeText(NSString *text) {
    NSString *out = GHReplace(text, @"([a-z])([A-Z])", @"$1 $2", NO);
    out = GHReplace(out, @"[_-]+", @" ", NO);
    return GHReplace(out, @"\\b(\\w)\\.", @"$1", NO);
}

static NSString *GHTextOfNode(id<GHAXNode> node) {
    NSString *text = GHSquash(node.value);
    if (text.length == 0) text = GHSquash(node.title);
    if (text.length == 0) text = GHSquash(node.axDescription);
    return text;
}

static NSString *GHFNV1a(NSString *text) {
    uint64_t hash = 1469598103934665603ULL;
    NSData *bytes = [text dataUsingEncoding:NSUTF8StringEncoding];
    const uint8_t *cursor = bytes.bytes;
    for (NSUInteger i = 0; i < bytes.length; i++) {
        hash ^= cursor[i];
        hash *= 1099511628211ULL;
    }
    return [NSString stringWithFormat:@"%016llx", hash];
}

static BOOL GHIsValueKind(NSString *kind) {
    return ![kind isEqualToString:GHKindButton] && ![kind isEqualToString:GHKindLink] &&
           ![kind isEqualToString:GHKindItem] && ![kind isEqualToString:GHKindOther];
}

#pragma mark - Walk bookkeeping

/// One visited node plus what the walk knew when it got there. Parents are strong, children are not
/// referenced, so there are no cycles.
@interface GHWalkEntry : NSObject
@property (nonatomic, strong) id<GHAXNode> node;
@property (nonatomic, strong, nullable) GHWalkEntry *parent;
@property (nonatomic, copy, nullable) NSArray<id<GHAXNode>> *siblings; // the parent's children, this node included
@property (nonatomic) NSUInteger indexInParent;
@property (nonatomic) NSUInteger depth;
@property (nonatomic) BOOL insideWebArea;
/// Safari puts its AXWebArea below an outer AXTabGroup. Until a complete walk proves that the tab
/// group belongs to a native app, candidates below it are provisional browser chrome.
@property (nonatomic) BOOL insideUnresolvedTabGroup;
@property (nonatomic) CGRect webAreaFrame;   // document box of the nearest web area
@property (nonatomic) CGRect viewportFrame;  // what the user can see of it
@property (nonatomic, strong, nullable) GHWalkEntry *radioGroup; // nearest AXRadioGroup ancestor
@end
@implementation GHWalkEntry
@end

@interface GHCandidate : NSObject
@property (nonatomic, strong) GHWalkEntry *entry;
@property (nonatomic, strong) GHField *field;
@property (nonatomic, strong) id<GHAXNode> node;       // what nodeForSignature returns
@property (nonatomic, copy) NSString *signatureRole;
@property (nonatomic, copy, nullable) NSString *signatureSubrole;
@property (nonatomic, strong, nullable) NSDictionary<NSString *, id<GHAXNode>> *radioNodes;
@property (nonatomic, strong, nullable) id<GHAXNode> uploadNode;    // file fields: the page's own file input
@property (nonatomic) NSUInteger order;
@end
@implementation GHCandidate
@end

#pragma mark - Limits and result

@implementation GHCaptureLimits

+ (instancetype)defaultLimits {
    GHCaptureLimits *limits = [[self alloc] init];
    limits.maxNodes = 1500;
    limits.maxDepth = 40;
    limits.timeBudget = 0.350;
    limits.webAreaTimeBudget = 0.600;
    limits.maxLinks = 40;
    limits.maxOptions = 255;
    limits.maxListRows = 12;
    return limits;
}

- (id)copyWithZone:(NSZone *)zone {
    GHCaptureLimits *copy = [[[self class] allocWithZone:zone] init];
    copy.maxNodes = self.maxNodes;
    copy.maxDepth = self.maxDepth;
    copy.timeBudget = self.timeBudget;
    copy.webAreaTimeBudget = self.webAreaTimeBudget;
    copy.maxLinks = self.maxLinks;
    copy.maxOptions = self.maxOptions;
    copy.maxListRows = self.maxListRows;
    return copy;
}

@end

@interface GHCaptureResult ()
@property (nonatomic, readwrite, copy) NSArray<GHField *> *fields;
@property (nonatomic, readwrite) NSUInteger visitedNodes;
@property (nonatomic, readwrite) GHCaptureStop stop;
@property (nonatomic, readwrite) BOOL partial;
@property (nonatomic, readwrite) NSTimeInterval elapsed;
@property (nonatomic, readwrite) CGRect windowFrame;
@property (nonatomic, readwrite) BOOL sawWebArea;
@property (nonatomic, readwrite, strong, nullable) id<GHAXNode> windowNode;
@property (nonatomic, readwrite, strong, nullable) id<GHAXNode> webAreaNode;
@property (nonatomic, readwrite, copy) NSString *formSignature;
@property (nonatomic, strong) NSDictionary<NSString *, id<GHAXNode>> *nodes;
@property (nonatomic, strong) NSDictionary<NSString *, NSDictionary<NSString *, id<GHAXNode>> *> *radioNodes;
@property (nonatomic, strong) NSDictionary<NSString *, id<GHAXNode>> *uploadNodes;
@end

@implementation GHCaptureResult

- (id<GHAXNode>)nodeForSignature:(NSString *)signature {
    return self.nodes[signature];
}

- (id<GHAXNode>)radioNodeForSignature:(NSString *)signature optionLabel:(NSString *)label {
    return self.radioNodes[signature][label];
}

- (id<GHAXNode>)uploadNodeForSignature:(NSString *)signature {
    return self.uploadNodes[signature];
}

@end

#pragma mark - Capture

/// Everything that names an element. `label` is the winner; `sources` is every candidate, because a
/// benign AXDescription must not hide a visible "Social Insurance Number".
@interface GHNaming : NSObject
@property (nonatomic, copy) NSString *label;
@property (nonatomic, copy) NSString *rawLabel;
@property (nonatomic, strong) NSMutableArray<NSString *> *sources;
@end
@implementation GHNaming
@end

@implementation GHCapture {
    id<GHSafetyChecking> _safety;
}

- (instancetype)initWithSafety:(id<GHSafetyChecking>)safety {
    if ((self = [super init])) {
        _safety = safety;
        _limits = [GHCaptureLimits defaultLimits];
        _clock = ^NSTimeInterval { return [NSProcessInfo processInfo].systemUptime; };
    }
    return self;
}

#pragma mark Pure helpers

+ (NSString *)kindForRole:(NSString *)role subrole:(NSString *)subrole {
    if (role.length == 0) return nil;
    if ([role isEqualToString:kRoleSecureTextField] || [subrole isEqualToString:kRoleSecureTextField]) return nil;
    if ([role isEqualToString:kRoleTextField]) return GHKindText;
    if ([role isEqualToString:kRoleTextArea]) return GHKindTextArea;
    if ([role isEqualToString:kRoleComboBox] || [role isEqualToString:kRolePopUpButton]) return GHKindSelect;
    if ([role isEqualToString:kRoleCheckBox]) return GHKindCheckbox;
    if ([role isEqualToString:kRoleRadioGroup] || [role isEqualToString:kRoleRadioButton]) return GHKindRadio;
    if ([role isEqualToString:kRoleButton]) return GHKindButton;
    if ([role isEqualToString:kRoleLink]) return GHKindLink;
    // A menu button and a disclosure triangle are buttons that happen to open something.
    if ([role isEqualToString:kRoleMenuButton] || [role isEqualToString:kRoleDisclosureTriangle]) return GHKindButton;
    // The native half of the world. A conversation in Messages, a track in Spotify, a file in Finder and a
    // message in Mail are all AXRow; a collection-view tile is a bare AXCell. Without these a native window
    // yields nothing at all: Finder exposed 3,269 nodes and Ghost found zero candidates in it.
    if ([role isEqualToString:kRoleRow] || [role isEqualToString:kRoleCell]) return GHKindItem;
    return nil;
}

+ (NSString *)cleanLabel:(NSString *)raw {
    NSString *label = GHSquash(raw ?: @"");
    label = GHReplace(label, @"\\s*\\(required\\)\\s*$", @"", YES);
    label = GHReplace(label, @"^\\*\\s*|\\s*\\*$", @"", NO);
    label = GHReplace(label, @"\\s*:$", @"", NO);
    return GHTruncate(GHSquash(label), kMaxLabel);
}

/// Same steps as `normalize` in shared/src/heuristic.ts.
+ (NSString *)normalizedLabel:(NSString *)label {
    NSString *out = GHReplace(label ?: @"", @"([a-z])([A-Z])", @"$1 $2", NO);
    out = GHReplace(out.lowercaseString, @"[_\\-./:*]+", @" ", NO);
    return GHSquash(out);
}

+ (BOOL)nativeLooksSensitive:(NSString *)text {
    return GHMatches(GHSensitivePattern(), GHSensitiveProbeText(text ?: @""));
}

+ (BOOL)nativeLooksLocked:(NSString *)text {
    return GHMatches(GHLockPattern(), text ?: @"");
}

static BOOL GHSameRow(CGRect anchor, CGRect rect) {
    CGFloat tolerance = 0.5 * MAX(1.0, MIN(anchor.size.height, rect.size.height));
    if (fabs(CGRectGetMinY(rect) - CGRectGetMinY(anchor)) <= tolerance) return YES;
    return fabs(CGRectGetMidY(rect) - CGRectGetMidY(anchor)) <= tolerance;
}

/// Rows top to bottom (a row is everything within half a field height of its first member), each row
/// left to right. Built from rows instead of a tolerant comparator, which would not be transitive.
static NSArray *GHReadingOrder(NSArray *items, CGRect (^rectOf)(id item)) {
    NSArray *byTop = [items sortedArrayWithOptions:NSSortStable usingComparator:^NSComparisonResult(id a, id b) {
        CGFloat ya = CGRectGetMinY(rectOf(a)), yb = CGRectGetMinY(rectOf(b));
        if (ya != yb) return ya < yb ? NSOrderedAscending : NSOrderedDescending;
        return NSOrderedSame;
    }];
    NSMutableArray *ordered = [NSMutableArray arrayWithCapacity:byTop.count];
    NSMutableArray *row = [NSMutableArray array];
    void (^flush)(void) = ^{
        [row sortWithOptions:NSSortStable usingComparator:^NSComparisonResult(id a, id b) {
            CGFloat xa = CGRectGetMinX(rectOf(a)), xb = CGRectGetMinX(rectOf(b));
            if (xa != xb) return xa < xb ? NSOrderedAscending : NSOrderedDescending;
            return NSOrderedSame;
        }];
        [ordered addObjectsFromArray:row];
        [row removeAllObjects];
    };
    for (id item in byTop) {
        if (row.count > 0 && !GHSameRow(rectOf(row.firstObject), rectOf(item))) flush();
        [row addObject:item];
    }
    flush();
    return ordered;
}

+ (NSArray<GHField *> *)fieldsInReadingOrder:(NSArray<GHField *> *)fields {
    return GHReadingOrder(fields, ^CGRect(GHField *field) { return field.rect; });
}

#pragma mark Safety

- (BOOL)isTextSensitive:(NSString *)text placeholder:(NSString *)placeholder identifier:(NSString *)identifier {
    NSString *all = [@[ text ?: @"", placeholder ?: @"", identifier ?: @"" ] componentsJoinedByString:@" "];
    if ([GHCapture nativeLooksSensitive:all]) return YES;
    NSMutableDictionary<NSString *, id> *probe = [NSMutableDictionary dictionary];
    if (text.length) probe[@"label"] = text;
    if (placeholder.length) probe[@"placeholder"] = placeholder;
    if (identifier.length) probe[@"id"] = identifier;
    if (probe.count == 0) return NO;
    return [_safety isSensitiveProbe:probe];
}

- (BOOL)isLabelLocked:(NSString *)label {
    if (label.length == 0) return NO;
    if ([GHCapture nativeLooksLocked:label]) return YES;
    return [_safety isLockedProbe:@{ @"text": label }];
}

/// A control with no name that is still worth keeping for the next-action path: it is drawn at a size a person
/// could click, and it carries SOMETHING a name could be derived from later -- an identifier, class tokens, a
/// description, or simply pixels a vision label can read (docs/anywhere.md section 4). Purely structural: no
/// word list, no site. Anything smaller than a tap target is a spacer, a decoration or a hit-box artifact.
- (BOOL)isWorthNamingLater:(id<GHAXNode>)node {
    CGRect frame = node.frame;
    if (frame.size.width < 12.0 || frame.size.height < 12.0) return NO;
    if (frame.size.width > 600.0 && frame.size.height > 600.0) return NO; // a whole region, not a control
    return YES;
}

static BOOL GHIsSecure(id<GHAXNode> node) {
    return [node.role isEqualToString:kRoleSecureTextField] || [node.subrole isEqualToString:kRoleSecureTextField];
}

- (BOOL)isNodeSensitive:(id<GHAXNode>)node {
    if (GHIsSecure(node)) return YES;
    NSMutableArray<NSString *> *sources = [NSMutableArray array];
    id<GHAXNode> titleElement = node.titleUIElement;
    for (NSString *text in @[ titleElement ? GHTextOfNode(titleElement) : @"", node.title ?: @"", node.axDescription ?: @"", node.help ?: @"" ]) {
        if (text.length) [sources addObject:text];
    }
    return [self isTextSensitive:[sources componentsJoinedByString:@" "] placeholder:node.placeholder identifier:node.identifier];
}

#pragma mark Labels

/// Last static text inside `node` (a label wrapper). nil when the subtree holds a field: that text is someone else's.
static NSString *GHTrailingText(id<GHAXNode> node, NSUInteger depth, BOOL *blocked) {
    NSString *role = node.role;
    if ([role isEqualToString:kRoleStaticText]) return GHTextOfNode(node);
    if ([GHFieldRoles() containsObject:role ?: @""] || [role isEqualToString:kRoleHeading]) {
        *blocked = YES;
        return nil;
    }
    if (depth == 0 || ![role isEqualToString:kRoleGroup]) return nil;
    NSString *found = nil;
    for (id<GHAXNode> child in node.children) {
        NSString *text = GHTrailingText(child, depth - 1, blocked);
        if (*blocked) return nil;
        if (text.length) found = text;
    }
    return found;
}

/// Nearest static text before the entry, climbing at most `levels` plain groups. Stops at another field or a heading.
static NSString *GHPrecedingText(GHWalkEntry *entry, NSUInteger levels, NSSet<NSString *> *ignored) {
    GHWalkEntry *cursor = entry;
    for (NSUInteger level = 0; cursor && level <= levels; level++) {
        NSArray<id<GHAXNode>> *siblings = cursor.siblings;
        NSUInteger scanned = 0;
        for (NSInteger i = (NSInteger)cursor.indexInParent - 1; i >= 0 && scanned < kPrecedingSiblingScan; i--, scanned++) {
            if ((NSUInteger)i >= siblings.count) continue;
            BOOL blocked = NO;
            NSString *text = GHTrailingText(siblings[(NSUInteger)i], 2, &blocked);
            if (blocked) return nil;
            if (text.length && ![ignored containsObject:text]) return text;
        }
        GHWalkEntry *parent = cursor.parent;
        // Only climb out of anonymous wrappers; a titled group or a web area is a boundary.
        if (!parent || ![parent.node.role isEqualToString:kRoleGroup] || parent.node.title.length || parent.node.axDescription.length) return nil;
        cursor = parent;
    }
    return nil;
}

/// The static text right after the entry (checkboxes and radios are usually followed by their text).
static NSString *GHFollowingText(GHWalkEntry *entry) {
    NSUInteger next = entry.indexInParent + 1;
    if (next >= entry.siblings.count || ![entry.siblings[next].role isEqualToString:kRoleStaticText]) return nil;
    return GHTextOfNode(entry.siblings[next]);
}

/// Text of the static texts inside a button or a link.
static NSString *GHDescendantText(id<GHAXNode> node, NSUInteger depth) {
    NSMutableArray<NSString *> *parts = [NSMutableArray array];
    for (id<GHAXNode> child in node.children) {
        NSString *text = [child.role isEqualToString:kRoleStaticText] ? GHTextOfNode(child) : (depth > 0 ? GHDescendantText(child, depth - 1) : @"");
        if (text.length) [parts addObject:text];
        if (parts.count >= 4) break;
    }
    return [parts componentsJoinedByString:@" "];
}

/// Label precedence: AXTitle, AXDescription, AXTitleUIElement, AXPlaceholderValue, AXHelp, nearest preceding
/// static text. WebKit and Chromium put the computed accessible name (label, aria-label) into AXTitle, so it wins;
/// the title element is what native forms use. A candidate equal to the current value is skipped: some native
/// popups report the selected item as their title, and a value must never become a label.
- (GHNaming *)namingForEntry:(GHWalkEntry *)entry kind:(NSString *)kind {
    id<GHAXNode> node = entry.node;
    // A list entry carries no AXTitle: what names it is the text inside it ("Tahseen Rayhan", a track name),
    // which is exactly how a button with only a glyph and a caption is named. It is read the same way.
    BOOL actionable = [kind isEqualToString:GHKindButton] || [kind isEqualToString:GHKindLink] || [kind isEqualToString:GHKindItem];
    NSString *value = GHSquash(node.value);
    // Links skip the title element: they never get a ghost and the lookup is one more round trip.
    id<GHAXNode> titleElement = [kind isEqualToString:GHKindLink] ? nil : node.titleUIElement;
    NSArray<NSString *> *explicitNames = @[ GHSquash(node.title), GHSquash(node.axDescription), titleElement ? GHTextOfNode(titleElement) : @"" ];
    NSMutableArray<NSString *> *candidates = [explicitNames mutableCopy];
    [candidates addObject:actionable ? GHDescendantText(node, 2) : GHSquash(node.placeholder)];
    [candidates addObject:GHSquash(node.help)];

    GHNaming *naming = [[GHNaming alloc] init];
    naming.sources = [NSMutableArray array];
    for (NSString *candidate in candidates) {
        if (candidate.length == 0) continue;
        if (!actionable && value.length && [candidate isEqualToString:value]) continue;
        [naming.sources addObject:candidate];
    }
    // Loose text only names a field that has no explicit name, like the extension. It ranks last.
    BOOL hasExplicit = NO;
    for (NSString *name in explicitNames) {
        BOOL isValue = !actionable && value.length && [name isEqualToString:value];
        hasExplicit = hasExplicit || (name.length > 0 && !isValue);
    }
    if (!actionable && !hasExplicit) {
        NSString *loose = nil;
        if ([kind isEqualToString:GHKindCheckbox]) loose = GHFollowingText(entry); // a box's text follows it
        if (loose.length == 0) loose = GHPrecedingText(entry, kLabelLevelsUp, nil);
        if (loose.length && !(value.length && [loose isEqualToString:value])) [naming.sources addObject:loose];
    }
    naming.rawLabel = naming.sources.firstObject ?: @"";
    naming.label = [GHCapture cleanLabel:naming.rawLabel];
    return naming;
}

#pragma mark Context

static NSString *GHHeadingText(id<GHAXNode> heading) {
    NSString *text = GHSquash(heading.title);
    if (text.length == 0) text = GHSquash(heading.value);
    if (text.length == 0) text = GHSquash(heading.axDescription);
    if (text.length == 0) text = GHDescendantText(heading, 1);
    return text;
}

/// Legend (title of an enclosing group) and nearest preceding heading, both possibly empty.
static void GHLegendAndHeading(GHWalkEntry *entry, NSString **legend, NSString **heading) {
    *legend = @"";
    *heading = @"";
    GHWalkEntry *cursor = entry;
    for (NSUInteger level = 0; cursor && level < kContextLevelsUp; level++) {
        if ((*heading).length == 0) {
            NSArray<id<GHAXNode>> *siblings = cursor.siblings;
            NSUInteger scanned = 0;
            for (NSInteger i = (NSInteger)cursor.indexInParent - 1; i >= 0 && scanned < kHeadingSiblingScan; i--, scanned++) {
                if ((NSUInteger)i >= siblings.count) continue;
                id<GHAXNode> sibling = siblings[(NSUInteger)i];
                if (![sibling.role isEqualToString:kRoleHeading]) continue;
                *heading = GHHeadingText(sibling);
                break;
            }
        }
        GHWalkEntry *parent = cursor.parent;
        if (!parent) break;
        NSString *parentRole = parent.node.role;
        if ((*legend).length == 0 && ([parentRole isEqualToString:kRoleGroup] || [parentRole isEqualToString:kRoleRadioGroup])) {
            NSString *title = GHSquash(parent.node.title);
            if (title.length == 0) title = GHSquash(parent.node.axDescription);
            *legend = title;
        }
        if ((*legend).length && (*heading).length) break;
        if ([parentRole isEqualToString:kRoleWebArea] || [parentRole isEqualToString:kRoleWindow]) break;
        cursor = parent;
    }
}

- (BOOL)isCardFieldWithLabel:(NSString *)label legend:(NSString *)legend heading:(NSString *)heading {
    NSString *bare = GHReplace(label, @"[.\\s]+$", @"", NO);
    if (!GHMatches(GHGenericCardLabelPattern(), bare)) return NO;
    return GHMatches(GHCardContextPattern(), [NSString stringWithFormat:@"%@ %@", legend, heading]);
}

/// The group's legend AND the section heading, both kept (each capped): a section such as "Voluntary
/// Self-Identification" must still reach the EEO guard when the question also sits in a titled group. A heading can
/// name a neighbouring sensitive field; that text must not ride along as context.
- (NSString *)contextFromLegend:(NSString *)legend heading:(NSString *)heading label:(NSString *)label {
    NSMutableArray<NSString *> *parts = [NSMutableArray array];
    for (NSString *raw in @[ legend ?: @"", heading ?: @"" ]) {
        NSString *text = [GHCapture cleanLabel:raw];
        if (text.length == 0 || [text isEqualToString:label] || [parts containsObject:text]) continue;
        if ([self isTextSensitive:text placeholder:nil identifier:nil]) continue;
        [parts addObject:text];
    }
    if (parts.count == 0) return nil;
    if (parts.count == 1) return GHTruncate(parts[0], kMaxContext);
    // Both: each gets its share, so a long legend never pushes the heading out.
    NSUInteger share = kMaxContext / 2;
    return [NSString stringWithFormat:@"%@ / %@", GHTruncate(parts[0], share), GHTruncate(parts[1], share)];
}

#pragma mark Kinds

static NSArray<NSString *> *GHHintTokens(id<GHAXNode> node) {
    NSMutableArray<NSString *> *tokens = [NSMutableArray array];
    NSMutableArray<NSString *> *raw = [NSMutableArray arrayWithArray:node.domClassList ?: @[]];
    if (node.identifier.length) [raw addObject:node.identifier];
    for (NSString *item in raw) {
        NSString *spaced = [GHCapture normalizedLabel:item];
        [tokens addObjectsFromArray:[spaced componentsSeparatedByString:@" "]];
    }
    return tokens;
}

/// email / tel / url / number from the DOM input type when the browser leaks it (role description,
/// subrole), then id and class tokens, then the label. Date-like widgets become "other": typing a
/// string into a date picker is a wrong ghost waiting to happen.
- (void)refineTextField:(GHField *)field node:(id<GHAXNode>)node {
    NSString *description = node.roleDescription.lowercaseString ?: @"";
    NSString *subrole = node.subrole ?: @"";
    if ([subrole isEqualToString:@"AXSearchField"] || [description containsString:@"search"]) {
        field.inputType = @"search";
        return;
    }
    for (NSString *word in @[ @"date", @"month", @"week", @"time" ]) {
        if ([description containsString:word]) {
            field.kind = GHKindOther;
            field.inputType = word;
            return;
        }
    }
    if ([description containsString:@"email"] || [description containsString:@"e-mail"]) { field.kind = GHKindEmail; field.inputType = @"email"; return; }
    if ([description containsString:@"telephone"] || [description containsString:@"phone"]) { field.kind = GHKindTel; field.inputType = @"tel"; return; }
    if ([description containsString:@"url"] || [description containsString:@"web address"]) { field.kind = GHKindURL; field.inputType = @"url"; return; }
    if ([description containsString:@"number"]) { field.kind = GHKindNumber; field.inputType = @"number"; return; }

    NSSet<NSString *> *tokens = [NSSet setWithArray:GHHintTokens(node)];
    if ([tokens containsObject:@"email"]) { field.kind = GHKindEmail; return; }
    if ([tokens containsObject:@"tel"] || [tokens containsObject:@"phone"] || [tokens containsObject:@"telephone"] || [tokens containsObject:@"mobile"]) { field.kind = GHKindTel; return; }
    if ([tokens containsObject:@"url"] || [tokens containsObject:@"website"]) { field.kind = GHKindURL; return; }

    NSString *label = field.label;
    if (GHMatches(GHEmailLabelPattern(), label)) field.kind = GHKindEmail;
    else if (GHMatches(GHTelLabelPattern(), label)) field.kind = GHKindTel;
    else if (GHMatches(GHURLLabelPattern(), label)) field.kind = GHKindURL;
    else if (GHMatches(GHProfileLinkLabelPattern(), [GHCapture normalizedLabel:label])) field.kind = GHKindURL;
}

#pragma mark Options

static void GHCollectOptions(id<GHAXNode> node, NSUInteger depth, NSUInteger max, NSMutableArray<NSDictionary<NSString *, NSString *> *> *out, NSMutableSet<NSString *> *seen) {
    for (id<GHAXNode> child in node.children) {
        if (out.count >= max) return;
        NSString *role = child.role ?: @"";
        BOOL container = [role isEqualToString:@"AXMenu"] || [role isEqualToString:@"AXList"] || [role isEqualToString:@"AXScrollArea"] || [role isEqualToString:kRoleGroup];
        if (container) {
            if (depth > 0) GHCollectOptions(child, depth - 1, max, out, seen);
            continue;
        }
        BOOL option = [role isEqualToString:@"AXMenuItem"] || [role isEqualToString:kRoleStaticText] || [role isEqualToString:@"AXCell"] || [role isEqualToString:@"AXRow"];
        if (!option || !child.enabled) continue;
        NSString *title = GHSquash(child.title);
        if (title.length == 0 && [role isEqualToString:kRoleStaticText]) title = GHSquash(child.value);
        if (title.length == 0) title = GHSquash(child.axDescription);
        title = GHTruncate(title, kMaxLabel);
        if (title.length == 0 || [seen containsObject:title]) continue;
        [seen addObject:title];
        [out addObject:@{ @"value": title, @"label": title }];
    }
}

- (NSArray<NSDictionary<NSString *, NSString *> *> *)optionsForSelectNode:(id<GHAXNode>)node {
    NSMutableArray<NSDictionary<NSString *, NSString *> *> *options = [NSMutableArray array];
    GHCollectOptions(node, 2, self.limits.maxOptions, options, [NSMutableSet set]);
    return options;
}

/// "When cheap": every option is one more round trip, so a long menu waits until its ghost is current.
- (NSArray<NSDictionary<NSString *, NSString *> *> *)cheapOptionsForSelectNode:(id<GHAXNode>)node {
    NSUInteger items = 0;
    for (id<GHAXNode> child in node.children) {
        NSString *role = child.role ?: @"";
        if ([role isEqualToString:@"AXMenu"] || [role isEqualToString:@"AXList"]) items += child.children.count;
        else items += 1;
        if (items > kCheapOptionCount) return nil;
    }
    NSArray *options = [self optionsForSelectNode:node];
    return options.count ? options : nil;
}

#pragma mark Visibility

static BOOL GHHasBox(CGRect frame) {
    return frame.size.width >= kMinBox && frame.size.height >= kMinBox;
}

- (BOOL)isFrame:(CGRect)frame reachableFromEntry:(GHWalkEntry *)entry window:(CGRect)window {
    if (!GHHasBox(frame)) return [self keepsFramelessNodeInEntry:entry];
    if (!GHHasBox(window)) return YES; // no window box to compare with (tests passing a bare subtree)
    CGRect visibleArea = entry.insideWebArea && GHHasBox(entry.viewportFrame) ? entry.viewportFrame : window;
    CGRect visible = CGRectIntersection(frame, visibleArea);
    if (!CGRectIsNull(visible) && GHHasBox(visible)) return YES;
    if (!self.keepsScrolledOutFields || !entry.insideWebArea || !GHHasBox(entry.webAreaFrame)) return NO;
    if (!CGRectIntersectsRect(frame, entry.webAreaFrame)) return NO;
    return CGRectGetMaxX(frame) > CGRectGetMinX(visibleArea) && CGRectGetMinX(frame) < CGRectGetMaxX(visibleArea);
}

/// A node with no box at all inside a Chromium web area: scrolled out, not hidden (see the header).
- (BOOL)keepsFramelessNodeInEntry:(GHWalkEntry *)entry {
    return self.treatsFramelessWebNodesAsScrolledOut && self.keepsScrolledOutFields
        && entry.insideWebArea && GHHasBox(entry.webAreaFrame);
}

#pragma mark Combo boxes

/// "value" / "placeholder" for the part of a react-select box that shows what is chosen, from its DOM classes.
static NSString *GHComboDisplayPart(id<GHAXNode> node) {
    for (NSString *name in node.domClassList) {
        NSString *lower = name.lowercaseString;
        if ([lower containsString:@"single-value"] || [lower containsString:@"singlevalue"] || [lower containsString:@"multi-value"]) return @"value";
        if ([lower containsString:@"placeholder"]) return @"placeholder";
    }
    return nil;
}

/// react-select keeps its input 4 px wide and empty: what the box shows (the placeholder or the chosen value) is a
/// sibling right before it. That sibling gives the field its visible box and, once something is chosen, its value.
static void GHAdoptComboDisplay(GHField *field, GHWalkEntry *entry) {
    NSArray<id<GHAXNode>> *siblings = entry.siblings;
    NSUInteger scanned = 0;
    for (NSInteger i = (NSInteger)entry.indexInParent - 1; i >= 0 && scanned < kComboAccessoryScan; i--, scanned++) {
        if ((NSUInteger)i >= siblings.count) continue;
        id<GHAXNode> sibling = siblings[(NSUInteger)i];
        if (![sibling.role isEqualToString:kRoleGroup]) continue;
        NSString *part = GHComboDisplayPart(sibling);
        if (!part) continue;
        CGRect box = sibling.frame;
        if (GHHasBox(box) && GHSameRow(field.rect, box)) field.rect = CGRectUnion(field.rect, box);
        if ([part isEqualToString:@"value"] && field.value.length == 0) {
            NSString *shown = GHDescendantText(sibling, 1);
            if (!GHMatches(GHPlaceholderChoicePattern(), shown)) field.value = shown;
        }
        return;
    }
}

/// The toggle / clear buttons that follow a combo box are part of it: dropped, their box joins the field's.
- (void)foldComboAccessoriesIn:(NSMutableArray<GHCandidate *> *)candidates {
    NSMutableArray<GHCandidate *> *accessories = [NSMutableArray array];
    for (GHCandidate *combo in candidates) {
        if (![combo.signatureRole isEqualToString:kRoleComboBox]) continue;
        GHWalkEntry *entry = combo.entry;
        for (GHCandidate *other in candidates) {
            if (other == combo || ![other.field.kind isEqualToString:GHKindButton] || other.field.locked) continue;
            if (other.entry.siblings != entry.siblings || other.entry.indexInParent <= entry.indexInParent) continue;
            if (other.entry.indexInParent - entry.indexInParent > kComboAccessoryScan) continue;
            if (!GHMatches(GHComboToggleLabelPattern(), other.field.label)) continue;
            // Nothing but the combo box's own furniture may sit between the two (another field would own it).
            BOOL adjacent = YES;
            for (NSUInteger i = entry.indexInParent + 1; i < other.entry.indexInParent && i < entry.siblings.count; i++) {
                if ([GHFieldRoles() containsObject:entry.siblings[i].role ?: @""]) adjacent = NO;
            }
            if (!adjacent) continue;
            if (GHSameRow(combo.field.rect, other.field.rect)) combo.field.rect = CGRectUnion(combo.field.rect, other.field.rect);
            [accessories addObject:other];
        }
    }
    [candidates removeObjectsInArray:accessories];
}

#pragma mark File uploads

static BOOL GHIsFileUploadButton(id<GHAXNode> node) {
    if ([node.subrole isEqualToString:kSubroleFileUpload]) return YES;
    return [node.roleDescription.lowercaseString isEqualToString:@"file upload button"];
}

static BOOL GHEntryIsInside(GHWalkEntry *entry, GHWalkEntry *container) {
    for (GHWalkEntry *cursor = entry; cursor; cursor = cursor.parent) if (cursor == container) return YES;
    return NO;
}

static BOOL GHUploadContainerIsNamed(id<GHAXNode> node) {
    if (GHSquash(node.title).length || GHSquash(node.axDescription).length) return YES;
    for (NSString *name in node.domClassList) {
        NSString *lower = name.lowercaseString;
        if ([lower containsString:@"upload"] || [lower containsString:@"file"] || [lower containsString:@"dropzone"]) return YES;
    }
    return NO;
}

/// First static text in document order, not looking inside controls (their text is theirs).
static NSString *GHFirstText(id<GHAXNode> node, NSUInteger depth) {
    for (id<GHAXNode> child in node.children) {
        NSString *role = child.role ?: @"";
        if ([role isEqualToString:kRoleStaticText]) {
            NSString *text = GHTextOfNode(child);
            if (text.length) return text;
            continue;
        }
        if (depth == 0 || [GHFieldRoles() containsObject:role]) continue;
        NSString *found = GHFirstText(child, depth - 1);
        if (found.length) return found;
    }
    return nil;
}

/// The name of a file the widget already holds ("resume.pdf"): a filled upload is never offered again.
static NSString *GHAttachedFileName(id<GHAXNode> node, NSUInteger depth) {
    for (id<GHAXNode> child in node.children) {
        NSString *role = child.role ?: @"";
        if ([role isEqualToString:kRoleStaticText]) {
            NSString *text = GHTextOfNode(child);
            if (GHMatches(GHAttachedFileNamePattern(), text)) return text;
            continue;
        }
        if (depth == 0 || ![role isEqualToString:kRoleGroup]) continue;
        NSString *found = GHAttachedFileName(child, depth - 1);
        if (found.length) return found;
    }
    return nil;
}

static NSString *GHUploadKindForText(NSString *text) {
    NSString *probe = [GHCapture normalizedLabel:text];
    BOOL cover = GHMatches(GHCoverLetterPattern(), probe);
    BOOL resume = GHMatches(GHResumePattern(), probe);
    if (cover == resume) return nil; // neither, or "resume or cover letter": which file is a guess
    return cover ? GHUploadKindCoverLetter : GHUploadKindResume;
}

/// The widget one file input belongs to: climb anonymous wrappers until a named one (title, description, an
/// upload-ish class), never past something that holds a value field, another file input or a real locked action.
- (GHWalkEntry *)uploadContainerForEntry:(GHWalkEntry *)upload uploads:(NSArray<GHWalkEntry *> *)uploads candidates:(NSArray<GHCandidate *> *)candidates {
    GHWalkEntry *container = nil;
    GHWalkEntry *cursor = upload.parent;
    for (NSUInteger level = 0; cursor && level < kUploadLevelsUp; level++, cursor = cursor.parent) {
        if (![cursor.node.role isEqualToString:kRoleGroup]) break;
        BOOL clean = YES;
        for (GHWalkEntry *other in uploads) if (other != upload && GHEntryIsInside(other, cursor)) clean = NO;
        for (GHCandidate *candidate in candidates) {
            if (!clean || !GHEntryIsInside(candidate.entry, cursor)) continue;
            NSString *kind = candidate.field.kind;
            BOOL action = [kind isEqualToString:GHKindButton] || [kind isEqualToString:GHKindLink];
            if (!action) clean = NO;
            else if (candidate.field.locked && !GHMatches(GHFileRemovalPattern(), candidate.field.label)) clean = NO;
        }
        if (!clean) break;
        container = cursor;
        if (GHUploadContainerIsNamed(cursor.node)) break;
    }
    return container;
}

/// Which file: the input's own label, else the widget's name or first text, else the text before it. The input's
/// title is only trusted when it is more than the browser's "Choose File".
- (NSString *)uploadLabelForEntry:(GHWalkEntry *)upload container:(GHWalkEntry *)container sources:(NSMutableArray<NSString *> *)sources {
    id<GHAXNode> node = upload.node;
    id<GHAXNode> titleElement = node.titleUIElement;
    NSMutableArray<NSString *> *names = [NSMutableArray array];
    [names addObject:titleElement ? GHTextOfNode(titleElement) : @""];
    if (container) {
        [names addObject:GHSquash(container.node.title)];
        [names addObject:GHSquash(container.node.axDescription)];
        [names addObject:GHFirstText(container.node, 2) ?: @""];
    }
    for (NSString *own in @[ GHSquash(node.title), GHSquash(node.axDescription) ]) {
        if (!GHMatches(GHGenericUploadNamePattern(), own)) [names addObject:own];
    }
    [names addObject:GHPrecedingText(container ?: upload, kLabelLevelsUp, nil) ?: @""];
    NSString *label = nil;
    for (NSString *name in names) {
        if (name.length == 0) continue;
        [sources addObject:name];
        if (!label && !GHMatches(GHAttachLabelPattern(), name)) label = name;
    }
    return [GHCapture cleanLabel:label ?: @""];
}

/// One `file` field per upload widget: labelled by the widget, acted on through its visible "Attach" button (the
/// real file input is usually a 2 px visually-hidden element). Every other control of the widget (Dropbox,
/// Google Drive, "Enter manually", "Remove") is part of it and not a field of its own.
- (void)foldUploadEntries:(NSArray<GHWalkEntry *> *)uploads intoCandidates:(NSMutableArray<GHCandidate *> *)candidates window:(CGRect)window order:(NSUInteger *)order {
    NSArray<GHCandidate *> *snapshot = [candidates copy];
    for (GHWalkEntry *upload in uploads) {
        id<GHAXNode> node = upload.node;
        GHWalkEntry *container = [self uploadContainerForEntry:upload uploads:uploads candidates:snapshot];
        NSMutableArray<GHCandidate *> *members = [NSMutableArray array];
        if (container) for (GHCandidate *candidate in candidates) if (GHEntryIsInside(candidate.entry, container)) [members addObject:candidate];
        [candidates removeObjectsInArray:members];
        if (!node.enabled) continue;

        GHCandidate *attach = nil;
        for (GHCandidate *member in members) {
            if ([member.field.kind isEqualToString:GHKindButton] && !member.field.locked && GHMatches(GHAttachLabelPattern(), member.field.label)) { attach = member; break; }
        }
        CGRect rect = attach ? attach.field.rect : node.frame;
        GHWalkEntry *anchor = container ?: upload;
        if (![self isFrame:rect reachableFromEntry:anchor window:window]) {
            if (attach || !container || ![self isFrame:container.node.frame reachableFromEntry:anchor window:window]) continue;
            rect = container.node.frame;
        }

        NSMutableArray<NSString *> *sources = [NSMutableArray array];
        NSString *label = [self uploadLabelForEntry:upload container:container sources:sources];
        NSString *legend = @"", *heading = @"";
        GHLegendAndHeading(upload, &legend, &heading);
        NSString *everyName = [[sources arrayByAddingObject:legend] componentsJoinedByString:@" "];
        if ([self isTextSensitive:everyName placeholder:node.placeholder identifier:node.identifier]) continue;
        if (label.length == 0 && node.identifier.length == 0) continue;
        if (label.length == 0) label = [GHCapture cleanLabel:[GHCapture normalizedLabel:node.identifier]];

        GHField *field = [GHField fieldWithSignature:@"" label:label kind:GHKindFile];
        field.identifier = node.identifier;
        field.inputType = @"file";
        field.uploadKind = GHUploadKindForText(label) ?: GHUploadKindForText(node.identifier ?: @"") ?: GHUploadKindOther;
        field.rect = rect;
        field.axElement = attach ? attach.node.axElement : node.axElement;
        field.required = node.required || GHMatches(GHRequiredMarkPattern(), label);
        field.context = [self contextFromLegend:legend heading:heading label:label];
        field.value = (container ? GHAttachedFileName(container.node, 3) : nil) ?: @"";

        GHCandidate *candidate = [[GHCandidate alloc] init];
        candidate.entry = anchor;
        candidate.field = field;
        candidate.node = attach ? attach.node : node;
        candidate.uploadNode = node;
        candidate.signatureRole = node.role ?: kRoleButton;
        candidate.signatureSubrole = kSubroleFileUpload;
        candidate.order = (*order)++;
        [candidates addObject:candidate];
    }
}

#pragma mark Field building

- (GHCandidate *)candidateForEntry:(GHWalkEntry *)entry kind:(NSString *)kind window:(CGRect)window order:(NSUInteger)order {
    id<GHAXNode> node = entry.node;
    if (!node.enabled) return nil;
    CGRect frame = node.frame;
    if (![self isFrame:frame reachableFromEntry:entry window:window]) return nil;
    BOOL isButton = [kind isEqualToString:GHKindButton];
    BOOL isLink = [kind isEqualToString:GHKindLink];
    BOOL isItem = [kind isEqualToString:GHKindItem];
    // Buttons, links and list entries are all places to GO: pressed, never filled, named by their own text.
    BOOL isAction = isButton || isLink || isItem;
    if (isButton && [GHSkippedButtonSubroles() containsObject:node.subrole ?: @""]) return nil;

    GHNaming *naming = [self namingForEntry:entry kind:kind];
    NSString *label = naming.label;
    // A control with no readable name is useless to the FORM walk (nothing can be mapped to it) and is dropped.
    // Ghost anywhere needs it anyway: a player's fullscreen button, a cart glyph and a kebab menu have no name
    // anywhere in the tree, and naming them is exactly what the affordance layer and the vision fallback are
    // for (docs/anywhere.md sections 2 and 4). With `capturesUnnamedControls` such a control is kept, marked
    // `unnamed`, and only ever reaches the next-action path: it can never carry a value ghost.
    // A list entry with nothing readable in it is not worth naming later either: it is an empty row.
    if (isItem && label.length == 0) return nil;
    if ((isButton || isLink) && label.length == 0 && !(self.capturesUnnamedControls && [self isWorthNamingLater:node])) return nil;

    NSString *legend = @"", *heading = @"";
    if (!isLink) GHLegendAndHeading(entry, &legend, &heading);
    if (!isAction) {
        NSString *everyName = [[naming.sources arrayByAddingObject:legend] componentsJoinedByString:@" "];
        if ([self isTextSensitive:everyName placeholder:node.placeholder identifier:node.identifier]) return nil;
        if ([self isCardFieldWithLabel:label legend:legend heading:heading]) return nil;
    }

    GHField *field = [GHField fieldWithSignature:@"" label:label kind:kind];
    field.identifier = node.identifier;
    field.rect = frame;
    field.axElement = node.axElement;
    field.required = node.required || GHMatches(GHRequiredMarkPattern(), GHSquash(naming.rawLabel));
    if (!isLink) field.context = [self contextFromLegend:legend heading:heading label:label];

    if (isAction) {
        field.locked = [self isLabelLocked:label];
        field.unnamed = label.length == 0;
        // Generic naming evidence the affordance layer reads as icon words, and the raw description a vision
        // label would replace. Never a value, never page text: a description is at most a control's own name.
        field.axDescription = GHSquash(node.axDescription).length ? GHSquash(node.axDescription) : nil;
        field.classTokens = node.domClassList.count ? node.domClassList : nil;
    } else {
        field.placeholder = GHSquash(node.placeholder).length ? GHSquash(node.placeholder) : nil;
        NSString *value = node.value ?: @"";
        if ([kind isEqualToString:GHKindText]) {
            [self refineTextField:field node:node];
            field.value = value;
        } else if ([kind isEqualToString:GHKindTextArea]) {
            field.value = value;
        } else if ([kind isEqualToString:GHKindCheckbox]) {
            // "2" is the mixed state: report it as ticked so no ghost ever offers to change it.
            field.value = ([value isEqualToString:@"0"] || value.length == 0) ? @"false" : @"true";
        } else if ([kind isEqualToString:GHKindSelect]) {
            NSString *shown = GHSquash(value);
            field.value = GHMatches(GHPlaceholderChoicePattern(), shown) ? @"" : shown;
            field.options = [self cheapOptionsForSelectNode:node];
            if ([node.role isEqualToString:kRoleComboBox] && field.options.count == 0) {
                // react-select and ARIA combo boxes: the options only exist while the list is open.
                field.options = nil;
                field.lazyOptions = YES;
                GHAdoptComboDisplay(field, entry);
            }
        }
    }

    GHCandidate *candidate = [[GHCandidate alloc] init];
    candidate.entry = entry;
    candidate.field = field;
    candidate.node = node;
    candidate.signatureRole = node.role ?: @"";
    candidate.signatureSubrole = node.subrole;
    candidate.order = order;
    return candidate;
}

#pragma mark Radios

static NSString *GHRadioOptionLabel(GHWalkEntry *entry) {
    id<GHAXNode> node = entry.node;
    NSString *label = GHSquash(node.title);
    if (label.length == 0) label = GHSquash(node.axDescription);
    if (label.length == 0) {
        id<GHAXNode> titleElement = node.titleUIElement;
        if (titleElement) label = GHTextOfNode(titleElement);
    }
    if (label.length == 0) label = GHDescendantText(node, 1);
    if (label.length == 0) label = GHFollowingText(entry) ?: @"";
    if (label.length == 0) label = GHSquash(node.help);
    return GHTruncate([GHCapture cleanLabel:label], kMaxLabel);
}

/// Where a loose radio sits for grouping purposes: its parent, or the grandparent when the parent only wraps this one radio.
static void GHRadioSeat(GHWalkEntry *radio, GHWalkEntry *__strong *container, NSUInteger *position) {
    GHWalkEntry *parent = radio.parent;
    *container = parent;
    *position = radio.indexInParent;
    if (!parent) return;
    NSUInteger radios = 0;
    for (id<GHAXNode> sibling in radio.siblings) if ([sibling.role isEqualToString:kRoleRadioButton]) radios++;
    if (radios == 1 && parent.parent && [parent.node.role isEqualToString:kRoleGroup]) {
        *container = parent.parent;
        *position = parent.indexInParent;
    }
}

/// HTML radios often have no AXRadioGroup. Radios under one container form a group until something
/// other than a single static text (an option label) sits between two of them: that is the next question.
- (NSArray<NSArray<GHWalkEntry *> *> *)groupLooseRadios:(NSArray<GHWalkEntry *> *)radios {
    NSMutableArray<NSMutableArray<GHWalkEntry *> *> *groups = [NSMutableArray array];
    GHWalkEntry *lastContainer = nil;
    NSUInteger lastPosition = 0;
    for (GHWalkEntry *radio in radios) {
        GHWalkEntry *container = nil;
        NSUInteger position = 0;
        GHRadioSeat(radio, &container, &position);
        BOOL joins = groups.count > 0 && container != nil && container == lastContainer && position > lastPosition;
        if (joins) {
            NSArray<id<GHAXNode>> *siblings = container.node.children;
            NSUInteger between = position - lastPosition - 1;
            if (between > 1) joins = NO;
            else if (between == 1 && lastPosition + 1 < siblings.count) joins = [siblings[lastPosition + 1].role isEqualToString:kRoleStaticText];
        }
        if (joins) [groups.lastObject addObject:radio];
        else [groups addObject:[NSMutableArray arrayWithObject:radio]];
        lastContainer = container;
        lastPosition = position;
    }
    return groups;
}

- (GHCandidate *)radioCandidateForGroup:(GHWalkEntry *)groupEntry radios:(NSArray<GHWalkEntry *> *)radios window:(CGRect)window order:(NSUInteger)order {
    NSMutableArray<NSDictionary<NSString *, NSString *> *> *options = [NSMutableArray array];
    NSMutableDictionary<NSString *, id<GHAXNode>> *radioNodes = [NSMutableDictionary dictionary];
    NSMutableSet<NSString *> *optionLabels = [NSMutableSet set];
    NSString *selected = @"";
    CGRect rect = CGRectNull;
    GHWalkEntry *first = nil;
    for (GHWalkEntry *radio in radios) {
        if (options.count >= self.limits.maxOptions) break;
        id<GHAXNode> node = radio.node;
        if (!node.enabled || ![self isFrame:node.frame reachableFromEntry:radio window:window]) continue;
        NSString *label = GHRadioOptionLabel(radio);
        if (label.length == 0 || [optionLabels containsObject:label]) continue;
        [optionLabels addObject:label];
        [options addObject:@{ @"value": label, @"label": label }];
        radioNodes[label] = node;
        if ([node.value isEqualToString:@"1"]) selected = label;
        rect = CGRectIsNull(rect) ? node.frame : CGRectUnion(rect, node.frame);
        if (!first) first = radio;
    }
    if (!first) return nil;

    GHNaming *naming = nil;
    NSString *legend = @"", *heading = @"";
    GHWalkEntry *anchor = groupEntry ?: first;
    if (groupEntry) {
        if (!groupEntry.node.enabled) return nil;
        naming = [self namingForEntry:groupEntry kind:GHKindRadio];
    } else {
        naming = [[GHNaming alloc] init];
        naming.sources = [NSMutableArray array];
    }
    GHLegendAndHeading(anchor, &legend, &heading);
    if (naming.sources.count == 0) {
        // Loose radios: the legend of their container, else the question text right before the first radio.
        NSString *question = legend.length ? legend : GHPrecedingText(first, kLabelLevelsUp, optionLabels);
        if (question.length) [naming.sources addObject:question];
        naming.rawLabel = naming.sources.firstObject ?: @"";
        naming.label = [GHCapture cleanLabel:naming.rawLabel];
    }
    NSString *everyName = [[naming.sources arrayByAddingObject:legend] componentsJoinedByString:@" "];
    NSString *identifier = groupEntry ? groupEntry.node.identifier : nil;
    if ([self isTextSensitive:everyName placeholder:nil identifier:identifier]) return nil;
    for (GHWalkEntry *radio in radios) {
        if ([self isTextSensitive:nil placeholder:nil identifier:radio.node.identifier]) return nil;
    }

    GHField *field = [GHField fieldWithSignature:@"" label:naming.label kind:GHKindRadio];
    field.options = options;
    field.value = selected;
    field.rect = rect;
    field.identifier = identifier;
    field.axElement = first.node.axElement; // like findElement in the extension: the first radio of the group
    field.required = (groupEntry && groupEntry.node.required) || GHMatches(GHRequiredMarkPattern(), GHSquash(naming.rawLabel));
    field.context = [self contextFromLegend:legend heading:heading label:naming.label];

    GHCandidate *candidate = [[GHCandidate alloc] init];
    candidate.entry = anchor;
    candidate.field = field;
    candidate.node = groupEntry ? groupEntry.node : first.node;
    candidate.signatureRole = kRoleRadioGroup; // same signature whether or not the page declares a radiogroup
    candidate.radioNodes = radioNodes;
    candidate.order = order;
    return candidate;
}

#pragma mark Signatures

- (NSString *)signatureBaseForCandidate:(GHCandidate *)candidate {
    GHField *field = candidate.field;
    NSString *identifier = field.identifier ?: @"";
    if (GHMatches(GHUnstableIdentifierPattern(), identifier)) identifier = @"";
    NSString *label = GHTruncate([GHCapture normalizedLabel:field.label], kMaxSignatureLabel);
    return [@[ @"ax", candidate.signatureRole ?: @"", candidate.signatureSubrole ?: @"", label, identifier ] componentsJoinedByString:@"|"];
}

#pragma mark Walk

/// Browser chrome that is not a whole toolbar: tab-bar items (AXRadioButton / AXTabButton, never a form choice)
/// and the address/search field. Only consulted outside web areas: inside one, the same roles are page content.
static BOOL GHIsBrowserChrome(id<GHAXNode> node, NSString *role) {
    if ([node.subrole isEqualToString:kSubroleTabButton]) return YES;
    NSString *identifier = node.identifier;
    return identifier.length > 0 && GHMatches(GHAddressFieldIdentifierPattern(), identifier);
}

- (GHCaptureResult *)captureWindow:(id<GHAXNode>)window {
    GHCaptureLimits *limits = [self.limits copy];
    NSTimeInterval (^clock)(void) = self.clock;
    NSTimeInterval started = clock();
    CGRect windowFrame = window.frame;

    GHCaptureResult *result = [[GHCaptureResult alloc] init];
    result.windowFrame = windowFrame;

    NSMutableArray<GHCandidate *> *candidates = [NSMutableArray array];
    NSMutableArray<GHWalkEntry *> *looseRadios = [NSMutableArray array];
    NSMutableArray<GHWalkEntry *> *uploads = [NSMutableArray array];
    NSMutableArray<GHWalkEntry *> *radioGroups = [NSMutableArray array];
    NSMapTable<GHWalkEntry *, NSMutableArray<GHWalkEntry *> *> *groupedRadios = [NSMapTable strongToStrongObjectsMapTable];
    NSUInteger order = 0;
    BOOL depthLimited = NO;

    GHWalkEntry *root = [[GHWalkEntry alloc] init];
    root.node = window;
    root.webAreaFrame = CGRectZero;
    root.viewportFrame = CGRectZero;
    NSMutableArray<GHWalkEntry *> *queue = [NSMutableArray arrayWithObject:root];
    NSUInteger head = 0;
    NSUInteger visited = 0;

    while (head < queue.count) {
        if (visited >= limits.maxNodes) { result.stop = GHCaptureStopNodes; break; }
        NSTimeInterval budget = result.sawWebArea ? MAX(limits.timeBudget, limits.webAreaTimeBudget) : limits.timeBudget;
        if (clock() - started > budget) { result.stop = GHCaptureStopTime; break; }
        GHWalkEntry *entry = queue[head++];
        visited++;
        id<GHAXNode> node = entry.node;
        NSString *role = node.role;
        if (role.length == 0) continue; // dead element or a failed fetch: nothing to trust below it
        if ([GHAlwaysSkippedRoles() containsObject:role]) continue;
        if (!entry.insideWebArea && GHIsBrowserChrome(node, role)) continue;
        if (GHIsSecure(node)) continue;

        // Safari nests the page INSIDE its tab group, so a tab group is walked; its own controls stay provisional.
        if (!entry.insideWebArea && [role isEqualToString:kRoleTabGroup]) {
            entry.insideUnresolvedTabGroup = YES;
        }

        if ([role isEqualToString:kRoleWebArea]) {
            result.sawWebArea = YES;
            if (!result.webAreaNode) result.webAreaNode = node;
            entry.insideWebArea = YES;
            entry.insideUnresolvedTabGroup = NO;
            entry.webAreaFrame = node.frame;
            CGRect viewport = GHHasBox(windowFrame) ? windowFrame : CGRectZero;
            CGRect holder = entry.parent ? entry.parent.node.frame : CGRectZero;
            if (GHHasBox(holder)) viewport = GHHasBox(viewport) ? CGRectIntersection(viewport, holder) : holder;
            entry.viewportFrame = CGRectIsNull(viewport) ? CGRectZero : viewport;
        }

        NSString *kind = [GHCapture kindForRole:role subrole:node.subrole];
        if ([role isEqualToString:kRoleButton] && GHIsFileUploadButton(node)) {
            [uploads addObject:entry]; // folded into one `file` field with its widget after the walk
            continue;
        }
        if ([role isEqualToString:kRoleRadioButton]) {
            if (entry.radioGroup) {
                NSMutableArray *members = [groupedRadios objectForKey:entry.radioGroup];
                [members addObject:entry];
            } else {
                [looseRadios addObject:entry];
            }
            continue;
        }
        if ([role isEqualToString:kRoleRadioGroup]) {
            [radioGroups addObject:entry];
            [groupedRadios setObject:[NSMutableArray array] forKey:entry];
            entry.radioGroup = entry;
        } else if (kind) {
            GHCandidate *candidate = [self candidateForEntry:entry kind:kind window:windowFrame order:order++];
            if (candidate) [candidates addObject:candidate];
            continue; // a control's children are its own business (options, button text)
        } else if ([GHLeafRoles() containsObject:role]) {
            continue;
        }

        if (entry.depth >= limits.maxDepth) { depthLimited = YES; continue; }
        NSArray<id<GHAXNode>> *children = node.children;
        // A list keeps only its first rows. Nobody wants the 900th track, and the rest would eat the walk.
        if (children.count > limits.maxListRows && [GHListContainerRoles() containsObject:role]) {
            children = [children subarrayWithRange:NSMakeRange(0, limits.maxListRows)];
        }
        NSUInteger index = 0;
        for (id<GHAXNode> child in children) {
            GHWalkEntry *next = [[GHWalkEntry alloc] init];
            next.node = child;
            next.parent = entry;
            next.siblings = children;
            next.indexInParent = index++;
            next.depth = entry.depth + 1;
            next.insideWebArea = entry.insideWebArea;
            next.insideUnresolvedTabGroup = entry.insideUnresolvedTabGroup;
            next.webAreaFrame = entry.webAreaFrame;
            next.viewportFrame = entry.viewportFrame;
            next.radioGroup = entry.radioGroup;
            [queue addObject:next];
        }
    }

    // Radio groups are assembled after the walk, from nodes that are already cached.
    for (GHWalkEntry *group in radioGroups) {
        GHCandidate *candidate = [self radioCandidateForGroup:group radios:[groupedRadios objectForKey:group] window:windowFrame order:order++];
        if (candidate) [candidates addObject:candidate];
    }
    for (NSArray<GHWalkEntry *> *group in [self groupLooseRadios:looseRadios]) {
        GHCandidate *candidate = [self radioCandidateForGroup:nil radios:group window:windowFrame order:order++];
        if (candidate) [candidates addObject:candidate];
    }
    [self foldUploadEntries:uploads intoCandidates:candidates window:windowFrame order:&order];
    [self foldComboAccessoriesIn:candidates];
    [candidates filterUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(GHCandidate *candidate, NSDictionary *bindings) {
        return !([candidate.field.kind isEqualToString:GHKindButton] && GHMatches(GHSiteAutofillPattern(), candidate.field.label));
    }]];

    // In a browser window the page is the only place Ghost works: the URL bar and the find bar are not forms.
    if (result.sawWebArea) {
        [candidates filterUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(GHCandidate *candidate, NSDictionary *bindings) {
            return candidate.entry.insideWebArea;
        }]];
    } else if (result.stop != GHCaptureStopNone || depthLimited) {
        // A partial browser walk may stop before Safari's nested AXWebArea. Never mistake tab-strip,
        // address/search or other provisional controls for a native form when discovery is incomplete.
        [candidates filterUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(GHCandidate *candidate, NSDictionary *bindings) {
            return !candidate.entry.insideUnresolvedTabGroup;
        }]];
    }

    NSArray<GHCandidate *> *ordered = GHReadingOrder(candidates, ^CGRect(GHCandidate *candidate) { return candidate.field.rect; });

    NSMutableArray<GHField *> *fields = [NSMutableArray array];
    NSMutableDictionary<NSString *, id<GHAXNode>> *nodes = [NSMutableDictionary dictionary];
    NSMutableDictionary<NSString *, NSDictionary *> *radioNodes = [NSMutableDictionary dictionary];
    NSMutableDictionary<NSString *, id<GHAXNode>> *uploadNodes = [NSMutableDictionary dictionary];
    NSMutableDictionary<NSString *, NSNumber *> *seen = [NSMutableDictionary dictionary];
    NSMutableArray<NSString *> *formParts = [NSMutableArray array];
    NSUInteger links = 0;
    for (GHCandidate *candidate in ordered) {
        GHField *field = candidate.field;
        if ([field.kind isEqualToString:GHKindLink] && ++links > limits.maxLinks) continue;
        NSString *base = [self signatureBaseForCandidate:candidate];
        NSUInteger index = seen[base].unsignedIntegerValue;
        seen[base] = @(index + 1);
        field.signature = [NSString stringWithFormat:@"%@|%lu", base, (unsigned long)index];
        [fields addObject:field];
        nodes[field.signature] = candidate.node;
        if (candidate.radioNodes) radioNodes[field.signature] = candidate.radioNodes;
        if (candidate.uploadNode) uploadNodes[field.signature] = candidate.uploadNode;
        if (GHIsValueKind(field.kind)) [formParts addObject:field.signature];
    }

    result.windowNode = window;
    result.fields = fields;
    result.nodes = nodes;
    result.radioNodes = radioNodes;
    result.uploadNodes = uploadNodes;
    result.visitedNodes = visited;
    result.partial = result.stop != GHCaptureStopNone || depthLimited;
    result.formSignature = GHFNV1a([formParts componentsJoinedByString:@"\n"]);
    result.elapsed = clock() - started;
    return result;
}

@end
