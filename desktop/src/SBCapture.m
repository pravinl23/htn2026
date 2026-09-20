#import "SBCapture.h"

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

static NSSet<NSString *> *SBSet(NSArray<NSString *> *items) { return [NSSet setWithArray:items]; }

/// Never entered, wherever they are.
static NSSet<NSString *> *SBAlwaysSkippedRoles(void) {
    static NSSet *roles; static dispatch_once_t once;
    dispatch_once(&once, ^{ roles = SBSet(@[ @"AXMenuBar", @"AXMenuBarItem", @"AXMenu", @"AXMenuItem", @"AXScrollBar", @"AXGrowArea", @"AXRuler", @"AXSplitter" ]); });
    return roles;
}

/// Containers that repeat one row shape. Only the first `maxListRows` children are entered: a Finder folder or a
/// Spotify playlist has thousands, nobody wants the 900th, and walking them all spends the whole time budget.
static NSSet<NSString *> *SBListContainerRoles(void) {
    static NSSet *roles; static dispatch_once_t once;
    dispatch_once(&once, ^{ roles = SBSet(@[ @"AXTable", @"AXOutline", @"AXList", @"AXGrid", @"AXBrowser" ]); });
    return roles;
}

/// Visited (they can label a field) but never expanded.
static NSSet<NSString *> *SBLeafRoles(void) {
    static NSSet *roles; static dispatch_once_t once;
    dispatch_once(&once, ^{
        roles = SBSet(@[ kRoleStaticText, @"AXImage", @"AXValueIndicator", @"AXProgressIndicator", @"AXBusyIndicator",
                         @"AXIncrementor", @"AXSlider", @"AXColorWell", @"AXDateField", @"AXTimeField",
                         @"AXLevelIndicator", @"AXRelevanceIndicator" ]);
    });
    return roles;
}

/// Window furniture that happens to be an AXButton. AXToolbarButton is deliberately NOT here: in a native app
/// the toolbar is where the app keeps the thing you came to press (Compose, New Folder, Share).
static NSSet<NSString *> *SBSkippedButtonSubroles(void) {
    static NSSet *roles; static dispatch_once_t once;
    dispatch_once(&once, ^{
        roles = SBSet(@[ @"AXCloseButton", @"AXMinimizeButton", @"AXZoomButton", @"AXFullScreenButton",
                         @"AXSortButton", @"AXIncrementArrow", @"AXDecrementArrow", @"AXIncrementPage", @"AXDecrementPage" ]);
    });
    return roles;
}

static NSSet<NSString *> *SBFieldRoles(void) {
    static NSSet *roles; static dispatch_once_t once;
    dispatch_once(&once, ^{
        roles = SBSet(@[ kRoleTextField, kRoleSecureTextField, kRoleTextArea, kRoleComboBox, kRolePopUpButton, kRoleCheckBox,
                         kRoleRadioGroup, kRoleRadioButton, kRoleButton, kRoleLink ]);
    });
    return roles;
}

#pragma mark - Patterns

static NSRegularExpression *SBRegex(NSString *pattern) {
    NSError *error = nil;
    NSRegularExpression *regex = [NSRegularExpression regularExpressionWithPattern:pattern options:NSRegularExpressionCaseInsensitive error:&error];
    NSCAssert(regex != nil, @"bad pattern %@: %@", pattern, error);
    return regex;
}

static BOOL SBMatches(NSRegularExpression *regex, NSString *text) {
    if (text.length == 0) return NO;
    return [regex firstMatchInString:text options:0 range:NSMakeRange(0, text.length)] != nil;
}

/// Compiling a pattern costs more than running it on a label, and a capture cleans hundreds of labels.
static NSString *SBReplace(NSString *text, NSString *pattern, NSString *replacement, BOOL caseInsensitive) {
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
static NSRegularExpression *SBSensitivePattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{
        regex = SBRegex([@[
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
static NSRegularExpression *SBLockPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{
        regex = SBRegex([@[
            @"submit", @"send", @"\\bpay\\b", @"pay now", @"place (my |your )?order", @"order now", @"\\bbuy\\b", @"purchase",
            @"check ?out", @"delete", @"remove", @"discard", @"confirm", @"apply now", @"\\bapply\\b", @"publish", @"\\bpost\\b",
            @"transfer", @"withdraw", @"\\bsign\\b", @"unsubscribe", @"cancel (my |your )?(subscription|order|account)",
            @"book now", @"reserve", @"donate", @"finish", @"complete",
        ] componentsJoinedByString:@"|"]);
    });
    return regex;
}

// "Card details > Number" is a card number even though neither word alone says so (same rule as the extension).
static NSRegularExpression *SBCardContextPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = SBRegex(@"\\bcards?\\b|\\bpayment\\b"); });
    return regex;
}

static NSRegularExpression *SBGenericCardLabelPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{
        regex = SBRegex(@"^(name|full name|holder|number|num|no|#|expiry|expiration|exp|exp date|valid (thru|until|to)|code|security)$");
    });
    return regex;
}

static NSRegularExpression *SBRequiredMarkPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = SBRegex(@"^\\*|\\*$|\\(required\\)$"); });
    return regex;
}

static NSRegularExpression *SBPlaceholderChoicePattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = SBRegex(@"^(select|choose|please|--)"); });
    return regex;
}

static NSRegularExpression *SBEmailLabelPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = SBRegex(@"e[- ]?mail"); });
    return regex;
}

static NSRegularExpression *SBTelLabelPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = SBRegex(@"phone|mobile|telephone|\\bcell\\b|\\btel\\b"); });
    return regex;
}

static NSRegularExpression *SBURLLabelPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = SBRegex(@"\\burl\\b|web ?site|homepage|portfolio"); });
    return regex;
}

// A field that is nothing but the name of a profile site ("LinkedIn Profile", "Github", "Portfolio URL") wants a
// link. Anchored on purpose: "GitHub username" wants a handle, and "How did you hear about us (LinkedIn...)" is prose.
static NSRegularExpression *SBProfileLinkLabelPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{
        regex = SBRegex(@"^(your )?(personal )?(linked ?in|git ?hub|git ?lab|bitbucket|behance|dribbble|stack ?overflow|portfolio|web ?site|blog|home ?page)"
                        @"( (profile|page|account|site))?( (url|link|address))?$");
    });
    return regex;
}

// Safari's address field outside any web area (Chrome's lives in a toolbar, which is skipped as a whole).
static NSRegularExpression *SBAddressFieldIdentifierPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = SBRegex(@"^WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD$|address_?and_?search|omnibox|^url ?bar$|^location ?bar$"); });
    return regex;
}

// The control that opens the file picker of an upload widget, as opposed to its cloud-drive alternatives.
static NSRegularExpression *SBAttachLabelPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = SBRegex(@"^(attach|upload|browse|choose( a)? files?|select( a)? files?|add( a)? files?)\\b"); });
    return regex;
}

// Removing an attached file is locked everywhere else; inside an upload widget it belongs to that widget.
static NSRegularExpression *SBFileRemovalPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = SBRegex(@"\\b(remove|delete|clear|discard)\\b"); });
    return regex;
}

// What the file input itself is called in WebKit and Chromium: says nothing about WHICH file.
static NSRegularExpression *SBGenericUploadNamePattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = SBRegex(@"^(choose|select|browse|attach|upload|add)( an?)?( (file|files|document))?$|^no files? (selected|chosen)$|^file upload( button)?$"); });
    return regex;
}

static NSRegularExpression *SBAttachedFileNamePattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = SBRegex(@"\\S\\.(pdf|docx?|rtf|txt|odt|pages)$"); });
    return regex;
}

// The disclosure button a combo box brings along (react-select: "Toggle flyout"). Part of the select, never a field.
static NSRegularExpression *SBComboToggleLabelPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{
        regex = SBRegex(@"^((toggle|open|show|close|hide|expand|collapse)( (the )?(flyout|menu|options|list|dropdown|suggestions|choices))?|flyout|dropdown|clear( (selection|value|all))?)$");
    });
    return regex;
}

// A site's own "Autofill my application" (resume parsing) competes with Shabang for the same fields: ignored.
static NSRegularExpression *SBSiteAutofillPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = SBRegex(@"\\bauto[- ]?fill\\b"); });
    return regex;
}

static NSRegularExpression *SBCoverLetterPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = SBRegex(@"\\bcover ?letters?\\b|\\bmotivation(al)? letter\\b"); });
    return regex;
}

static NSRegularExpression *SBResumePattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = SBRegex(@"\\br[eé]sum[eé]s?\\b|\\bcv\\b|\\bcurriculum vitae\\b"); });
    return regex;
}

// React useId (":r1:"), long digit runs and hex blobs change on every load: useless in a signature.
static NSRegularExpression *SBUnstableIdentifierPattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = SBRegex(@"^:r[0-9a-z]+:$|\\d{4,}|[0-9a-f]{8,}"); });
    return regex;
}

#pragma mark - Small helpers

static NSString *SBSquash(NSString *text) {
    if (text.length == 0) return @"";
    NSArray<NSString *> *parts = [text componentsSeparatedByCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    NSMutableArray<NSString *> *words = [NSMutableArray arrayWithCapacity:parts.count];
    for (NSString *part in parts) if (part.length) [words addObject:part];
    return [words componentsJoinedByString:@" "];
}

static NSString *SBTruncate(NSString *text, NSUInteger max) {
    if (text.length <= max) return text;
    NSRange safe = [text rangeOfComposedCharacterSequencesForRange:NSMakeRange(0, max)];
    return [text substringWithRange:safe];
}

/// sensitiveProbeText from shared/src/sensitive.ts: "card_number" and "cardNumber" read as words, "S.I.N." as "SIN".
static NSString *SBSensitiveProbeText(NSString *text) {
    NSString *out = SBReplace(text, @"([a-z])([A-Z])", @"$1 $2", NO);
    out = SBReplace(out, @"[_-]+", @" ", NO);
    return SBReplace(out, @"\\b(\\w)\\.", @"$1", NO);
}

static NSString *SBTextOfNode(id<SBAXNode> node) {
    NSString *text = SBSquash(node.value);
    if (text.length == 0) text = SBSquash(node.title);
    if (text.length == 0) text = SBSquash(node.axDescription);
    return text;
}

static NSString *SBFNV1a(NSString *text) {
    uint64_t hash = 1469598103934665603ULL;
    NSData *bytes = [text dataUsingEncoding:NSUTF8StringEncoding];
    const uint8_t *cursor = bytes.bytes;
    for (NSUInteger i = 0; i < bytes.length; i++) {
        hash ^= cursor[i];
        hash *= 1099511628211ULL;
    }
    return [NSString stringWithFormat:@"%016llx", hash];
}

/// Worth asking whether it can be pressed: a leaf with a name and a box big enough to aim at. The size floor
/// keeps the question off the thousands of small text runs that make up a page's prose.
static const CGFloat kPressableLabelMinHeight = 18;
static const CGFloat kPressableLabelMinWidth = 40;

/**
 * The entry is waiting to be read.
 *
 * macOS asks apps to say so in the accessible name, because that is how VoiceOver announces it: a row reads
 * "Unread, <who>, <what>, <when>". Read from the name Shabang already has, so it costs nothing.
 *
 * NOT verified against a live unread row -- the inbox it was written against had none, every conversation
 * offering "Mark as Unread" rather than "Mark as Read". It fails safe: no match means no boost, and the
 * behaviour is exactly what it was before.
 */
static BOOL SBLooksUnread(NSString *text) {
    static NSRegularExpression *regex;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        regex = [NSRegularExpression regularExpressionWithPattern:@"^\\s*(unread|new message)\\b|\\bunread\\b\\s*[,.]"
                                                          options:NSRegularExpressionCaseInsensitive error:NULL];
    });
    NSString *name = SBSquash(text ?: @"");
    return name.length > 0 && [regex firstMatchInString:name options:0 range:NSMakeRange(0, name.length)] != nil;
}

static BOOL SBCouldBeAPressableLabel(id<SBAXNode> node, NSString *role) {
    if (![role isEqualToString:kRoleStaticText] && ![role isEqualToString:@"AXImage"]) return NO;
    CGRect box = node.frame;
    if (CGRectGetHeight(box) < kPressableLabelMinHeight || CGRectGetWidth(box) < kPressableLabelMinWidth) return NO;
    if (SBSquash(node.title).length == 0 && SBSquash(node.axDescription).length == 0) return NO;
    return node.pressable;
}

/// Kinds whose whole purpose is that you type into them (a select or a checkbox is a value too, but nobody
/// types into one, and their AXValue settability says nothing useful).
static BOOL SBIsTypeableKind(NSString *kind) {
    return [kind isEqualToString:SBKindText] || [kind isEqualToString:SBKindTextArea];
}

static BOOL SBIsValueKind(NSString *kind) {
    return ![kind isEqualToString:SBKindButton] && ![kind isEqualToString:SBKindLink] &&
           ![kind isEqualToString:SBKindItem] && ![kind isEqualToString:SBKindOther];
}

#pragma mark - Walk bookkeeping

/// One visited node plus what the walk knew when it got there. Parents are strong, children are not
/// referenced, so there are no cycles.
@interface SBWalkEntry : NSObject
@property (nonatomic, strong) id<SBAXNode> node;
@property (nonatomic, strong, nullable) SBWalkEntry *parent;
@property (nonatomic, copy, nullable) NSArray<id<SBAXNode>> *siblings; // the parent's children, this node included
@property (nonatomic) NSUInteger indexInParent;
@property (nonatomic) NSUInteger depth;
@property (nonatomic) BOOL insideWebArea;
/// Safari puts its AXWebArea below an outer AXTabGroup. Until a complete walk proves that the tab
/// group belongs to a native app, candidates below it are provisional browser chrome.
@property (nonatomic) BOOL insideUnresolvedTabGroup;
@property (nonatomic) CGRect webAreaFrame;   // document box of the nearest web area
@property (nonatomic) CGRect viewportFrame;  // what the user can see of it
@property (nonatomic, strong, nullable) SBWalkEntry *radioGroup; // nearest AXRadioGroup ancestor
@end
@implementation SBWalkEntry
@end

@interface SBCandidate : NSObject
@property (nonatomic, strong) SBWalkEntry *entry;
@property (nonatomic, strong) SBField *field;
@property (nonatomic, strong) id<SBAXNode> node;       // what nodeForSignature returns
@property (nonatomic, copy) NSString *signatureRole;
@property (nonatomic, copy, nullable) NSString *signatureSubrole;
@property (nonatomic, strong, nullable) NSDictionary<NSString *, id<SBAXNode>> *radioNodes;
@property (nonatomic, strong, nullable) id<SBAXNode> uploadNode;    // file fields: the page's own file input
@property (nonatomic) NSUInteger order;
@end
@implementation SBCandidate
@end

#pragma mark - Limits and result

@implementation SBCaptureLimits

+ (instancetype)defaultLimits {
    SBCaptureLimits *limits = [[self alloc] init];
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
    SBCaptureLimits *copy = [[[self class] allocWithZone:zone] init];
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

@interface SBCaptureResult ()
@property (nonatomic, readwrite, copy) NSArray<SBField *> *fields;
@property (nonatomic, readwrite) NSUInteger visitedNodes;
@property (nonatomic, readwrite) SBCaptureStop stop;
@property (nonatomic, readwrite) BOOL partial;
@property (nonatomic, readwrite) NSTimeInterval elapsed;
@property (nonatomic, readwrite) CGRect windowFrame;
@property (nonatomic, readwrite) BOOL sawWebArea;
@property (nonatomic, readwrite, strong, nullable) id<SBAXNode> windowNode;
@property (nonatomic, readwrite, strong, nullable) id<SBAXNode> webAreaNode;
@property (nonatomic, readwrite, copy) NSString *formSignature;
@property (nonatomic, strong) NSDictionary<NSString *, id<SBAXNode>> *nodes;
@property (nonatomic, strong) NSDictionary<NSString *, NSDictionary<NSString *, id<SBAXNode>> *> *radioNodes;
@property (nonatomic, strong) NSDictionary<NSString *, id<SBAXNode>> *uploadNodes;
@end

@implementation SBCaptureResult

- (id<SBAXNode>)nodeForSignature:(NSString *)signature {
    return self.nodes[signature];
}

- (id<SBAXNode>)radioNodeForSignature:(NSString *)signature optionLabel:(NSString *)label {
    return self.radioNodes[signature][label];
}

- (id<SBAXNode>)uploadNodeForSignature:(NSString *)signature {
    return self.uploadNodes[signature];
}

@end

#pragma mark - Capture

/// Everything that names an element. `label` is the winner; `sources` is every candidate, because a
/// benign AXDescription must not hide a visible "Social Insurance Number".
@interface SBNaming : NSObject
@property (nonatomic, copy) NSString *label;
@property (nonatomic, copy) NSString *rawLabel;
@property (nonatomic, strong) NSMutableArray<NSString *> *sources;
@end
@implementation SBNaming
@end

@implementation SBCapture {
    id<SBSafetyChecking> _safety;
}

- (instancetype)initWithSafety:(id<SBSafetyChecking>)safety {
    if ((self = [super init])) {
        _safety = safety;
        _limits = [SBCaptureLimits defaultLimits];
        _clock = ^NSTimeInterval { return [NSProcessInfo processInfo].systemUptime; };
    }
    return self;
}

#pragma mark Pure helpers

+ (NSString *)kindForRole:(NSString *)role subrole:(NSString *)subrole {
    if (role.length == 0) return nil;
    if ([role isEqualToString:kRoleSecureTextField] || [subrole isEqualToString:kRoleSecureTextField]) return nil;
    if ([role isEqualToString:kRoleTextField]) return SBKindText;
    if ([role isEqualToString:kRoleTextArea]) return SBKindTextArea;
    if ([role isEqualToString:kRoleComboBox] || [role isEqualToString:kRolePopUpButton]) return SBKindSelect;
    if ([role isEqualToString:kRoleCheckBox]) return SBKindCheckbox;
    if ([role isEqualToString:kRoleRadioGroup] || [role isEqualToString:kRoleRadioButton]) return SBKindRadio;
    if ([role isEqualToString:kRoleButton]) return SBKindButton;
    if ([role isEqualToString:kRoleLink]) return SBKindLink;
    // A menu button and a disclosure triangle are buttons that happen to open something.
    if ([role isEqualToString:kRoleMenuButton] || [role isEqualToString:kRoleDisclosureTriangle]) return SBKindButton;
    // The native half of the world. A conversation in Messages, a track in Spotify, a file in Finder and a
    // message in Mail are all AXRow; a collection-view tile is a bare AXCell. Without these a native window
    // yields nothing at all: Finder exposed 3,269 nodes and Shabang found zero candidates in it.
    if ([role isEqualToString:kRoleRow] || [role isEqualToString:kRoleCell]) return SBKindItem;
    return nil;
}

+ (NSString *)cleanLabel:(NSString *)raw {
    NSString *label = SBSquash(raw ?: @"");
    label = SBReplace(label, @"\\s*\\(required\\)\\s*$", @"", YES);
    label = SBReplace(label, @"^\\*\\s*|\\s*\\*$", @"", NO);
    label = SBReplace(label, @"\\s*:$", @"", NO);
    return SBTruncate(SBSquash(label), kMaxLabel);
}

/// Same steps as `normalize` in shared/src/heuristic.ts.
+ (NSString *)normalizedLabel:(NSString *)label {
    NSString *out = SBReplace(label ?: @"", @"([a-z])([A-Z])", @"$1 $2", NO);
    out = SBReplace(out.lowercaseString, @"[_\\-./:*]+", @" ", NO);
    return SBSquash(out);
}

+ (BOOL)nativeLooksSensitive:(NSString *)text {
    return SBMatches(SBSensitivePattern(), SBSensitiveProbeText(text ?: @""));
}

+ (BOOL)nativeLooksLocked:(NSString *)text {
    return SBMatches(SBLockPattern(), text ?: @"");
}

static BOOL SBSameRow(CGRect anchor, CGRect rect) {
    CGFloat tolerance = 0.5 * MAX(1.0, MIN(anchor.size.height, rect.size.height));
    if (fabs(CGRectGetMinY(rect) - CGRectGetMinY(anchor)) <= tolerance) return YES;
    return fabs(CGRectGetMidY(rect) - CGRectGetMidY(anchor)) <= tolerance;
}

/// Rows top to bottom (a row is everything within half a field height of its first member), each row
/// left to right. Built from rows instead of a tolerant comparator, which would not be transitive.
static NSArray *SBReadingOrder(NSArray *items, CGRect (^rectOf)(id item)) {
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
        if (row.count > 0 && !SBSameRow(rectOf(row.firstObject), rectOf(item))) flush();
        [row addObject:item];
    }
    flush();
    return ordered;
}

+ (NSArray<SBField *> *)fieldsInReadingOrder:(NSArray<SBField *> *)fields {
    return SBReadingOrder(fields, ^CGRect(SBField *field) { return field.rect; });
}

#pragma mark Safety

- (BOOL)isTextSensitive:(NSString *)text placeholder:(NSString *)placeholder identifier:(NSString *)identifier {
    NSString *all = [@[ text ?: @"", placeholder ?: @"", identifier ?: @"" ] componentsJoinedByString:@" "];
    if ([SBCapture nativeLooksSensitive:all]) return YES;
    NSMutableDictionary<NSString *, id> *probe = [NSMutableDictionary dictionary];
    if (text.length) probe[@"label"] = text;
    if (placeholder.length) probe[@"placeholder"] = placeholder;
    if (identifier.length) probe[@"id"] = identifier;
    if (probe.count == 0) return NO;
    return [_safety isSensitiveProbe:probe];
}

- (BOOL)isLabelLocked:(NSString *)label {
    if (label.length == 0) return NO;
    if ([SBCapture nativeLooksLocked:label]) return YES;
    return [_safety isLockedProbe:@{ @"text": label }];
}

/// A control with no name that is still worth keeping for the next-action path: it is drawn at a size a person
/// could click, and it carries SOMETHING a name could be derived from later -- an identifier, class tokens, a
/// description, or simply pixels a vision label can read (docs/anywhere.md section 4). Purely structural: no
/// word list, no site. Anything smaller than a tap target is a spacer, a decoration or a hit-box artifact.
- (BOOL)isWorthNamingLater:(id<SBAXNode>)node {
    CGRect frame = node.frame;
    if (frame.size.width < 12.0 || frame.size.height < 12.0) return NO;
    if (frame.size.width > 600.0 && frame.size.height > 600.0) return NO; // a whole region, not a control
    return YES;
}

static BOOL SBIsSecure(id<SBAXNode> node) {
    return [node.role isEqualToString:kRoleSecureTextField] || [node.subrole isEqualToString:kRoleSecureTextField];
}

- (BOOL)isNodeSensitive:(id<SBAXNode>)node {
    if (SBIsSecure(node)) return YES;
    NSMutableArray<NSString *> *sources = [NSMutableArray array];
    id<SBAXNode> titleElement = node.titleUIElement;
    for (NSString *text in @[ titleElement ? SBTextOfNode(titleElement) : @"", node.title ?: @"", node.axDescription ?: @"", node.help ?: @"" ]) {
        if (text.length) [sources addObject:text];
    }
    return [self isTextSensitive:[sources componentsJoinedByString:@" "] placeholder:node.placeholder identifier:node.identifier];
}

#pragma mark Labels

/// Last static text inside `node` (a label wrapper). nil when the subtree holds a field: that text is someone else's.
/**
 * Text that is only a required marker or punctuation: "*", "(required)", ":", "-".
 *
 * A required label renders its star with a CSS ::after, and Chromium publishes generated content as its OWN
 * static text node -- so a label group reads ["Location", "*"] and the nearest text before the field is the
 * star, not the label. Cleaning it then leaves an empty string, and the field ends up with no name at all.
 * Measured on a live application form, where this was the one field a whole walk skipped.
 */
static BOOL SBTextIsOnlyAMarker(NSString *text) {
    NSString *clean = [SBCapture cleanLabel:text ?: @""];
    return clean.length == 0;
}

static NSString *SBTrailingText(id<SBAXNode> node, NSUInteger depth, BOOL *blocked) {
    NSString *role = node.role;
    if ([role isEqualToString:kRoleStaticText]) return SBTextOfNode(node);
    if ([SBFieldRoles() containsObject:role ?: @""] || [role isEqualToString:kRoleHeading]) {
        *blocked = YES;
        return nil;
    }
    if (depth == 0 || ![role isEqualToString:kRoleGroup]) return nil;
    NSString *found = nil;
    for (id<SBAXNode> child in node.children) {
        NSString *text = SBTrailingText(child, depth - 1, blocked);
        if (*blocked) return nil;
        // The LAST text wins, because it is the one nearest the field -- but a bare marker is not a name, and
        // must never displace the label it decorates.
        if (text.length && !(found.length && SBTextIsOnlyAMarker(text))) found = text;
    }
    return found;
}

/// Nearest static text before the entry, climbing at most `levels` plain groups. Stops at another field or a heading.
static NSString *SBPrecedingText(SBWalkEntry *entry, NSUInteger levels, NSSet<NSString *> *ignored) {
    SBWalkEntry *cursor = entry;
    for (NSUInteger level = 0; cursor && level <= levels; level++) {
        NSArray<id<SBAXNode>> *siblings = cursor.siblings;
        NSUInteger scanned = 0;
        for (NSInteger i = (NSInteger)cursor.indexInParent - 1; i >= 0 && scanned < kPrecedingSiblingScan; i--, scanned++) {
            if ((NSUInteger)i >= siblings.count) continue;
            BOOL blocked = NO;
            NSString *text = SBTrailingText(siblings[(NSUInteger)i], 2, &blocked);
            if (blocked) return nil;
            if (text.length && ![ignored containsObject:text]) return text;
        }
        SBWalkEntry *parent = cursor.parent;
        // Only climb out of anonymous wrappers; a titled group or a web area is a boundary.
        if (!parent || ![parent.node.role isEqualToString:kRoleGroup] || parent.node.title.length || parent.node.axDescription.length) return nil;
        cursor = parent;
    }
    return nil;
}

/// The static text right after the entry (checkboxes and radios are usually followed by their text).
static NSString *SBFollowingText(SBWalkEntry *entry) {
    NSUInteger next = entry.indexInParent + 1;
    if (next >= entry.siblings.count || ![entry.siblings[next].role isEqualToString:kRoleStaticText]) return nil;
    return SBTextOfNode(entry.siblings[next]);
}

/// Text of the static texts inside a button or a link.
static NSString *SBDescendantText(id<SBAXNode> node, NSUInteger depth) {
    NSMutableArray<NSString *> *parts = [NSMutableArray array];
    for (id<SBAXNode> child in node.children) {
        NSString *text = [child.role isEqualToString:kRoleStaticText] ? SBTextOfNode(child) : (depth > 0 ? SBDescendantText(child, depth - 1) : @"");
        if (text.length) [parts addObject:text];
        if (parts.count >= 4) break;
    }
    return [parts componentsJoinedByString:@" "];
}

/**
 * A placeholder that says nothing about the field it is in: a prompt to the typist, not a name.
 * "Start typing...", "Type here...", "Select...", "Search...".
 *
 * These must not outrank a real label. Measured on a live application form: the Location field is a combobox
 * that publishes NO accessible name at all -- no AXTitle, no aria-label, no aria-labelledby -- so naming fell
 * through to its placeholder, "Start typing...", and that became its label. The real "Location" was sitting in
 * the static text right before it and was found, but ranked BELOW the placeholder and never used. Nothing could
 * map "Start typing..." to a fact, so it was the one field a whole walk skipped while every other field filled.
 *
 * Such a placeholder is still kept as a LAST resort, after the preceding text: a field named badly beats a
 * field named not at all.
 */
static BOOL SBPlaceholderSaysNothing(NSString *text) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{
        regex = SBRegex(@"^(start typing|begin typing|type here|type to search|type a|type\\.\\.\\.|select|select one|choose|choose one|pick one|search|enter|e\\.g\\.|eg)\\b[\\s.\\u2026:-]*$");
    });
    return SBMatches(regex, SBSquash(text));
}

/// Label precedence: AXTitle, AXDescription, AXTitleUIElement, AXPlaceholderValue, AXHelp, nearest preceding
/// static text. WebKit and Chromium put the computed accessible name (label, aria-label) into AXTitle, so it wins;
/// the title element is what native forms use. A candidate equal to the current value is skipped: some native
/// popups report the selected item as their title, and a value must never become a label.
- (SBNaming *)namingForEntry:(SBWalkEntry *)entry kind:(NSString *)kind {
    id<SBAXNode> node = entry.node;
    // A list entry carries no AXTitle: what names it is the text inside it ("Sam Okafor", a track name),
    // which is exactly how a button with only a glyph and a caption is named. It is read the same way.
    BOOL actionable = [kind isEqualToString:SBKindButton] || [kind isEqualToString:SBKindLink] || [kind isEqualToString:SBKindItem];
    NSString *value = SBSquash(node.value);
    // Links skip the title element: they never get a ghost and the lookup is one more round trip.
    id<SBAXNode> titleElement = [kind isEqualToString:SBKindLink] ? nil : node.titleUIElement;
    NSArray<NSString *> *explicitNames = @[ SBSquash(node.title), SBSquash(node.axDescription), titleElement ? SBTextOfNode(titleElement) : @"" ];
    NSMutableArray<NSString *> *candidates = [explicitNames mutableCopy];
    NSString *placeholder = actionable ? SBDescendantText(node, 2) : SBSquash(node.placeholder);
    // A content-free placeholder is demoted below the preceding text rather than dropped, so it still names a
    // field that has nothing else at all.
    NSString *weakPlaceholder = (!actionable && SBPlaceholderSaysNothing(placeholder)) ? placeholder : nil;
    if (!weakPlaceholder) [candidates addObject:placeholder];
    [candidates addObject:SBSquash(node.help)];

    SBNaming *naming = [[SBNaming alloc] init];
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
        if ([kind isEqualToString:SBKindCheckbox]) loose = SBFollowingText(entry); // a box's text follows it
        if (loose.length == 0) loose = SBPrecedingText(entry, kLabelLevelsUp, nil);
        if (loose.length && !(value.length && [loose isEqualToString:value])) [naming.sources addObject:loose];
    }
    // Last resort, after everything including the preceding text.
    if (weakPlaceholder.length) [naming.sources addObject:weakPlaceholder];
    naming.rawLabel = naming.sources.firstObject ?: @"";
    naming.label = [SBCapture cleanLabel:naming.rawLabel];
    return naming;
}

#pragma mark Context

static NSString *SBHeadingText(id<SBAXNode> heading) {
    NSString *text = SBSquash(heading.title);
    if (text.length == 0) text = SBSquash(heading.value);
    if (text.length == 0) text = SBSquash(heading.axDescription);
    if (text.length == 0) text = SBDescendantText(heading, 1);
    return text;
}

/// Legend (title of an enclosing group) and nearest preceding heading, both possibly empty.
static void SBLegendAndHeading(SBWalkEntry *entry, NSString **legend, NSString **heading) {
    *legend = @"";
    *heading = @"";
    SBWalkEntry *cursor = entry;
    for (NSUInteger level = 0; cursor && level < kContextLevelsUp; level++) {
        if ((*heading).length == 0) {
            NSArray<id<SBAXNode>> *siblings = cursor.siblings;
            NSUInteger scanned = 0;
            for (NSInteger i = (NSInteger)cursor.indexInParent - 1; i >= 0 && scanned < kHeadingSiblingScan; i--, scanned++) {
                if ((NSUInteger)i >= siblings.count) continue;
                id<SBAXNode> sibling = siblings[(NSUInteger)i];
                if (![sibling.role isEqualToString:kRoleHeading]) continue;
                *heading = SBHeadingText(sibling);
                break;
            }
        }
        SBWalkEntry *parent = cursor.parent;
        if (!parent) break;
        NSString *parentRole = parent.node.role;
        if ((*legend).length == 0 && ([parentRole isEqualToString:kRoleGroup] || [parentRole isEqualToString:kRoleRadioGroup])) {
            NSString *title = SBSquash(parent.node.title);
            if (title.length == 0) title = SBSquash(parent.node.axDescription);
            *legend = title;
        }
        if ((*legend).length && (*heading).length) break;
        if ([parentRole isEqualToString:kRoleWebArea] || [parentRole isEqualToString:kRoleWindow]) break;
        cursor = parent;
    }
}

- (BOOL)isCardFieldWithLabel:(NSString *)label legend:(NSString *)legend heading:(NSString *)heading {
    NSString *bare = SBReplace(label, @"[.\\s]+$", @"", NO);
    if (!SBMatches(SBGenericCardLabelPattern(), bare)) return NO;
    return SBMatches(SBCardContextPattern(), [NSString stringWithFormat:@"%@ %@", legend, heading]);
}

/// The group's legend AND the section heading, both kept (each capped): a section such as "Voluntary
/// Self-Identification" must still reach the EEO guard when the question also sits in a titled group. A heading can
/// name a neighbouring sensitive field; that text must not ride along as context.
- (NSString *)contextFromLegend:(NSString *)legend heading:(NSString *)heading label:(NSString *)label {
    NSMutableArray<NSString *> *parts = [NSMutableArray array];
    for (NSString *raw in @[ legend ?: @"", heading ?: @"" ]) {
        NSString *text = [SBCapture cleanLabel:raw];
        if (text.length == 0 || [text isEqualToString:label] || [parts containsObject:text]) continue;
        if ([self isTextSensitive:text placeholder:nil identifier:nil]) continue;
        [parts addObject:text];
    }
    if (parts.count == 0) return nil;
    if (parts.count == 1) return SBTruncate(parts[0], kMaxContext);
    // Both: each gets its share, so a long legend never pushes the heading out.
    NSUInteger share = kMaxContext / 2;
    return [NSString stringWithFormat:@"%@ / %@", SBTruncate(parts[0], share), SBTruncate(parts[1], share)];
}

#pragma mark Kinds

static NSArray<NSString *> *SBHintTokens(id<SBAXNode> node) {
    NSMutableArray<NSString *> *tokens = [NSMutableArray array];
    NSMutableArray<NSString *> *raw = [NSMutableArray arrayWithArray:node.domClassList ?: @[]];
    if (node.identifier.length) [raw addObject:node.identifier];
    for (NSString *item in raw) {
        NSString *spaced = [SBCapture normalizedLabel:item];
        [tokens addObjectsFromArray:[spaced componentsSeparatedByString:@" "]];
    }
    return tokens;
}

/// email / tel / url / number from the DOM input type when the browser leaks it (role description,
/// subrole), then id and class tokens, then the label. Date-like widgets become "other": typing a
/// string into a date picker is a wrong ghost waiting to happen.
- (void)refineTextField:(SBField *)field node:(id<SBAXNode>)node {
    NSString *description = node.roleDescription.lowercaseString ?: @"";
    NSString *subrole = node.subrole ?: @"";
    if ([subrole isEqualToString:@"AXSearchField"] || [description containsString:@"search"]) {
        field.inputType = @"search";
        return;
    }
    for (NSString *word in @[ @"date", @"month", @"week", @"time" ]) {
        if ([description containsString:word]) {
            field.kind = SBKindOther;
            field.inputType = word;
            return;
        }
    }
    if ([description containsString:@"email"] || [description containsString:@"e-mail"]) { field.kind = SBKindEmail; field.inputType = @"email"; return; }
    if ([description containsString:@"telephone"] || [description containsString:@"phone"]) { field.kind = SBKindTel; field.inputType = @"tel"; return; }
    if ([description containsString:@"url"] || [description containsString:@"web address"]) { field.kind = SBKindURL; field.inputType = @"url"; return; }
    if ([description containsString:@"number"]) { field.kind = SBKindNumber; field.inputType = @"number"; return; }

    NSSet<NSString *> *tokens = [NSSet setWithArray:SBHintTokens(node)];
    if ([tokens containsObject:@"email"]) { field.kind = SBKindEmail; return; }
    if ([tokens containsObject:@"tel"] || [tokens containsObject:@"phone"] || [tokens containsObject:@"telephone"] || [tokens containsObject:@"mobile"]) { field.kind = SBKindTel; return; }
    if ([tokens containsObject:@"url"] || [tokens containsObject:@"website"]) { field.kind = SBKindURL; return; }

    NSString *label = field.label;
    if (SBMatches(SBEmailLabelPattern(), label)) field.kind = SBKindEmail;
    else if (SBMatches(SBTelLabelPattern(), label)) field.kind = SBKindTel;
    else if (SBMatches(SBURLLabelPattern(), label)) field.kind = SBKindURL;
    else if (SBMatches(SBProfileLinkLabelPattern(), [SBCapture normalizedLabel:label])) field.kind = SBKindURL;
}

#pragma mark Options

static void SBCollectOptions(id<SBAXNode> node, NSUInteger depth, NSUInteger max, NSMutableArray<NSDictionary<NSString *, NSString *> *> *out, NSMutableSet<NSString *> *seen) {
    for (id<SBAXNode> child in node.children) {
        if (out.count >= max) return;
        NSString *role = child.role ?: @"";
        BOOL container = [role isEqualToString:@"AXMenu"] || [role isEqualToString:@"AXList"] || [role isEqualToString:@"AXScrollArea"] || [role isEqualToString:kRoleGroup];
        if (container) {
            if (depth > 0) SBCollectOptions(child, depth - 1, max, out, seen);
            continue;
        }
        BOOL option = [role isEqualToString:@"AXMenuItem"] || [role isEqualToString:kRoleStaticText] || [role isEqualToString:@"AXCell"] || [role isEqualToString:@"AXRow"];
        if (!option || !child.enabled) continue;
        NSString *title = SBSquash(child.title);
        if (title.length == 0 && [role isEqualToString:kRoleStaticText]) title = SBSquash(child.value);
        if (title.length == 0) title = SBSquash(child.axDescription);
        title = SBTruncate(title, kMaxLabel);
        if (title.length == 0 || [seen containsObject:title]) continue;
        [seen addObject:title];
        [out addObject:@{ @"value": title, @"label": title }];
    }
}

- (NSArray<NSDictionary<NSString *, NSString *> *> *)optionsForSelectNode:(id<SBAXNode>)node {
    NSMutableArray<NSDictionary<NSString *, NSString *> *> *options = [NSMutableArray array];
    SBCollectOptions(node, 2, self.limits.maxOptions, options, [NSMutableSet set]);
    return options;
}

/// "When cheap": every option is one more round trip, so a long menu waits until its ghost is current.
- (NSArray<NSDictionary<NSString *, NSString *> *> *)cheapOptionsForSelectNode:(id<SBAXNode>)node {
    NSUInteger items = 0;
    for (id<SBAXNode> child in node.children) {
        NSString *role = child.role ?: @"";
        if ([role isEqualToString:@"AXMenu"] || [role isEqualToString:@"AXList"]) items += child.children.count;
        else items += 1;
        if (items > kCheapOptionCount) return nil;
    }
    NSArray *options = [self optionsForSelectNode:node];
    return options.count ? options : nil;
}

#pragma mark Visibility

static BOOL SBHasBox(CGRect frame) {
    return frame.size.width >= kMinBox && frame.size.height >= kMinBox;
}

- (BOOL)isFrame:(CGRect)frame reachableFromEntry:(SBWalkEntry *)entry window:(CGRect)window {
    if (!SBHasBox(frame)) return [self keepsFramelessNodeInEntry:entry];
    if (!SBHasBox(window)) return YES; // no window box to compare with (tests passing a bare subtree)
    CGRect visibleArea = entry.insideWebArea && SBHasBox(entry.viewportFrame) ? entry.viewportFrame : window;
    CGRect visible = CGRectIntersection(frame, visibleArea);
    if (!CGRectIsNull(visible) && SBHasBox(visible)) return YES;
    if (!self.keepsScrolledOutFields || !entry.insideWebArea || !SBHasBox(entry.webAreaFrame)) return NO;
    if (!CGRectIntersectsRect(frame, entry.webAreaFrame)) return NO;
    return CGRectGetMaxX(frame) > CGRectGetMinX(visibleArea) && CGRectGetMinX(frame) < CGRectGetMaxX(visibleArea);
}

/// A node with no box at all inside a Chromium web area: scrolled out, not hidden (see the header).
- (BOOL)keepsFramelessNodeInEntry:(SBWalkEntry *)entry {
    return self.treatsFramelessWebNodesAsScrolledOut && self.keepsScrolledOutFields
        && entry.insideWebArea && SBHasBox(entry.webAreaFrame);
}

#pragma mark Combo boxes

/// "value" / "placeholder" for the part of a react-select box that shows what is chosen, from its DOM classes.
static NSString *SBComboDisplayPart(id<SBAXNode> node) {
    for (NSString *name in node.domClassList) {
        NSString *lower = name.lowercaseString;
        if ([lower containsString:@"single-value"] || [lower containsString:@"singlevalue"] || [lower containsString:@"multi-value"]) return @"value";
        if ([lower containsString:@"placeholder"]) return @"placeholder";
    }
    return nil;
}

/// react-select keeps its input 4 px wide and empty: what the box shows (the placeholder or the chosen value) is a
/// sibling right before it. That sibling gives the field its visible box and, once something is chosen, its value.
static void SBAdoptComboDisplay(SBField *field, SBWalkEntry *entry) {
    NSArray<id<SBAXNode>> *siblings = entry.siblings;
    NSUInteger scanned = 0;
    for (NSInteger i = (NSInteger)entry.indexInParent - 1; i >= 0 && scanned < kComboAccessoryScan; i--, scanned++) {
        if ((NSUInteger)i >= siblings.count) continue;
        id<SBAXNode> sibling = siblings[(NSUInteger)i];
        if (![sibling.role isEqualToString:kRoleGroup]) continue;
        NSString *part = SBComboDisplayPart(sibling);
        if (!part) continue;
        CGRect box = sibling.frame;
        if (SBHasBox(box) && SBSameRow(field.rect, box)) field.rect = CGRectUnion(field.rect, box);
        if ([part isEqualToString:@"value"] && field.value.length == 0) {
            NSString *shown = SBDescendantText(sibling, 1);
            if (!SBMatches(SBPlaceholderChoicePattern(), shown)) field.value = shown;
        }
        return;
    }
}

/// The toggle / clear buttons that follow a combo box are part of it: dropped, their box joins the field's.
- (void)foldComboAccessoriesIn:(NSMutableArray<SBCandidate *> *)candidates {
    NSMutableArray<SBCandidate *> *accessories = [NSMutableArray array];
    for (SBCandidate *combo in candidates) {
        if (![combo.signatureRole isEqualToString:kRoleComboBox]) continue;
        SBWalkEntry *entry = combo.entry;
        for (SBCandidate *other in candidates) {
            if (other == combo || ![other.field.kind isEqualToString:SBKindButton] || other.field.locked) continue;
            if (other.entry.siblings != entry.siblings || other.entry.indexInParent <= entry.indexInParent) continue;
            if (other.entry.indexInParent - entry.indexInParent > kComboAccessoryScan) continue;
            if (!SBMatches(SBComboToggleLabelPattern(), other.field.label)) continue;
            // Nothing but the combo box's own furniture may sit between the two (another field would own it).
            BOOL adjacent = YES;
            for (NSUInteger i = entry.indexInParent + 1; i < other.entry.indexInParent && i < entry.siblings.count; i++) {
                if ([SBFieldRoles() containsObject:entry.siblings[i].role ?: @""]) adjacent = NO;
            }
            if (!adjacent) continue;
            if (SBSameRow(combo.field.rect, other.field.rect)) combo.field.rect = CGRectUnion(combo.field.rect, other.field.rect);
            [accessories addObject:other];
        }
    }
    [candidates removeObjectsInArray:accessories];
}

#pragma mark File uploads

/**
 * What a browser appends to a file input's accessible name: its own state, which no other control has.
 * "Resume / CV: No file chosen", "Cover letter: 1 file selected".
 *
 * Chromium publishes <input type=file> as a PLAIN AXButton -- no AXFileUploadButton subrole, and a role
 * description of "button" -- so the two tests below can never fire there. Measured in Chrome on a real
 * application form: the resume control captured as an ordinary button, the upload path never engaged at all,
 * and the walk filled thirteen fields and silently skipped the resume. WebKit does publish the subrole, which
 * is why this only ever worked in Safari and looked like a browser-specific mystery rather than a missing rule.
 */
static NSRegularExpression *SBFileInputStatePattern(void) {
    static NSRegularExpression *regex; static dispatch_once_t once;
    dispatch_once(&once, ^{ regex = SBRegex(@"\\bno files? (chosen|selected)\\b|\\b\\d+ files? (chosen|selected)\\b"); });
    return regex;
}

/// The file a file input already holds, when its name says so: "Resume / CV: alex-chen.pdf". "" when it is empty
/// or says nothing. Rule 9 reads this -- Shabang never replaces a file somebody already attached.
static NSString *SBFileInputStateValue(id<SBAXNode> node) {
    NSString *name = SBSquash(node.title);
    NSRange colon = [name rangeOfString:@":" options:NSBackwardsSearch];
    if (colon.location == NSNotFound) return @"";
    NSString *state = SBSquash([name substringFromIndex:colon.location + 1]);
    if (state.length == 0) return @"";
    if (SBMatches(SBRegex(@"^no files? (chosen|selected)$"), state)) return @"";
    return SBMatches(SBFileInputStatePattern(), state) || SBMatches(SBAttachedFileNamePattern(), state) ? state : @"";
}

static BOOL SBIsFileUploadButton(id<SBAXNode> node) {
    if ([node.subrole isEqualToString:kSubroleFileUpload]) return YES;
    if ([node.roleDescription.lowercaseString isEqualToString:@"file upload button"]) return YES;
    // Chromium: the control's own state is the only thing that gives it away.
    return SBMatches(SBFileInputStatePattern(), SBSquash(node.title)) ||
           SBMatches(SBFileInputStatePattern(), SBSquash(node.axDescription));
}

static BOOL SBEntryIsInside(SBWalkEntry *entry, SBWalkEntry *container) {
    for (SBWalkEntry *cursor = entry; cursor; cursor = cursor.parent) if (cursor == container) return YES;
    return NO;
}

static BOOL SBUploadContainerIsNamed(id<SBAXNode> node) {
    if (SBSquash(node.title).length || SBSquash(node.axDescription).length) return YES;
    for (NSString *name in node.domClassList) {
        NSString *lower = name.lowercaseString;
        if ([lower containsString:@"upload"] || [lower containsString:@"file"] || [lower containsString:@"dropzone"]) return YES;
    }
    return NO;
}

/// First static text in document order, not looking inside controls (their text is theirs).
static NSString *SBFirstText(id<SBAXNode> node, NSUInteger depth) {
    for (id<SBAXNode> child in node.children) {
        NSString *role = child.role ?: @"";
        if ([role isEqualToString:kRoleStaticText]) {
            NSString *text = SBTextOfNode(child);
            if (text.length) return text;
            continue;
        }
        if (depth == 0 || [SBFieldRoles() containsObject:role]) continue;
        NSString *found = SBFirstText(child, depth - 1);
        if (found.length) return found;
    }
    return nil;
}

/// The name of a file the widget already holds ("resume.pdf"): a filled upload is never offered again.
static NSString *SBAttachedFileName(id<SBAXNode> node, NSUInteger depth) {
    for (id<SBAXNode> child in node.children) {
        NSString *role = child.role ?: @"";
        if ([role isEqualToString:kRoleStaticText]) {
            NSString *text = SBTextOfNode(child);
            if (SBMatches(SBAttachedFileNamePattern(), text)) return text;
            continue;
        }
        if (depth == 0 || ![role isEqualToString:kRoleGroup]) continue;
        NSString *found = SBAttachedFileName(child, depth - 1);
        if (found.length) return found;
    }
    return nil;
}

static NSString *SBUploadKindForText(NSString *text) {
    NSString *probe = [SBCapture normalizedLabel:text];
    BOOL cover = SBMatches(SBCoverLetterPattern(), probe);
    BOOL resume = SBMatches(SBResumePattern(), probe);
    if (cover == resume) return nil; // neither, or "resume or cover letter": which file is a guess
    return cover ? SBUploadKindCoverLetter : SBUploadKindResume;
}

/// The widget one file input belongs to: climb anonymous wrappers until a named one (title, description, an
/// upload-ish class), never past something that holds a value field, another file input or a real locked action.
- (SBWalkEntry *)uploadContainerForEntry:(SBWalkEntry *)upload uploads:(NSArray<SBWalkEntry *> *)uploads candidates:(NSArray<SBCandidate *> *)candidates {
    SBWalkEntry *container = nil;
    SBWalkEntry *cursor = upload.parent;
    for (NSUInteger level = 0; cursor && level < kUploadLevelsUp; level++, cursor = cursor.parent) {
        if (![cursor.node.role isEqualToString:kRoleGroup]) break;
        BOOL clean = YES;
        for (SBWalkEntry *other in uploads) if (other != upload && SBEntryIsInside(other, cursor)) clean = NO;
        for (SBCandidate *candidate in candidates) {
            if (!clean || !SBEntryIsInside(candidate.entry, cursor)) continue;
            NSString *kind = candidate.field.kind;
            BOOL action = [kind isEqualToString:SBKindButton] || [kind isEqualToString:SBKindLink];
            if (!action) clean = NO;
            else if (candidate.field.locked && !SBMatches(SBFileRemovalPattern(), candidate.field.label)) clean = NO;
        }
        if (!clean) break;
        container = cursor;
        if (SBUploadContainerIsNamed(cursor.node)) break;
    }
    return container;
}

/// Which file: the input's own label, else the widget's name or first text, else the text before it. The input's
/// title is only trusted when it is more than the browser's "Choose File".
- (NSString *)uploadLabelForEntry:(SBWalkEntry *)upload container:(SBWalkEntry *)container sources:(NSMutableArray<NSString *> *)sources {
    id<SBAXNode> node = upload.node;
    id<SBAXNode> titleElement = node.titleUIElement;
    NSMutableArray<NSString *> *names = [NSMutableArray array];
    [names addObject:titleElement ? SBTextOfNode(titleElement) : @""];
    if (container) {
        [names addObject:SBSquash(container.node.title)];
        [names addObject:SBSquash(container.node.axDescription)];
        [names addObject:SBFirstText(container.node, 2) ?: @""];
    }
    for (NSString *own in @[ SBSquash(node.title), SBSquash(node.axDescription) ]) {
        if (!SBMatches(SBGenericUploadNamePattern(), own)) [names addObject:own];
    }
    [names addObject:SBPrecedingText(container ?: upload, kLabelLevelsUp, nil) ?: @""];
    NSString *label = nil;
    for (NSString *name in names) {
        if (name.length == 0) continue;
        [sources addObject:name];
        if (!label && !SBMatches(SBAttachLabelPattern(), name)) label = name;
    }
    return [SBCapture cleanLabel:label ?: @""];
}

/// One `file` field per upload widget: labelled by the widget, acted on through its visible "Attach" button (the
/// real file input is usually a 2 px visually-hidden element). Every other control of the widget (Dropbox,
/// Google Drive, "Enter manually", "Remove") is part of it and not a field of its own.
- (void)foldUploadEntries:(NSArray<SBWalkEntry *> *)uploads intoCandidates:(NSMutableArray<SBCandidate *> *)candidates window:(CGRect)window order:(NSUInteger *)order {
    NSArray<SBCandidate *> *snapshot = [candidates copy];
    for (SBWalkEntry *upload in uploads) {
        id<SBAXNode> node = upload.node;
        SBWalkEntry *container = [self uploadContainerForEntry:upload uploads:uploads candidates:snapshot];
        NSMutableArray<SBCandidate *> *members = [NSMutableArray array];
        if (container) for (SBCandidate *candidate in candidates) if (SBEntryIsInside(candidate.entry, container)) [members addObject:candidate];
        [candidates removeObjectsInArray:members];
        if (!node.enabled) continue;

        SBCandidate *attach = nil;
        for (SBCandidate *member in members) {
            if ([member.field.kind isEqualToString:SBKindButton] && !member.field.locked && SBMatches(SBAttachLabelPattern(), member.field.label)) { attach = member; break; }
        }
        CGRect rect = attach ? attach.field.rect : node.frame;
        SBWalkEntry *anchor = container ?: upload;
        if (![self isFrame:rect reachableFromEntry:anchor window:window]) {
            if (attach || !container || ![self isFrame:container.node.frame reachableFromEntry:anchor window:window]) continue;
            rect = container.node.frame;
        }

        NSMutableArray<NSString *> *sources = [NSMutableArray array];
        NSString *label = [self uploadLabelForEntry:upload container:container sources:sources];
        NSString *legend = @"", *heading = @"";
        SBLegendAndHeading(upload, &legend, &heading);
        NSString *everyName = [[sources arrayByAddingObject:legend] componentsJoinedByString:@" "];
        if ([self isTextSensitive:everyName placeholder:node.placeholder identifier:node.identifier]) continue;
        if (label.length == 0 && node.identifier.length == 0) continue;
        if (label.length == 0) label = [SBCapture cleanLabel:[SBCapture normalizedLabel:node.identifier]];

        SBField *field = [SBField fieldWithSignature:@"" label:label kind:SBKindFile];
        field.identifier = node.identifier;
        field.inputType = @"file";
        field.uploadKind = SBUploadKindForText(label) ?: SBUploadKindForText(node.identifier ?: @"") ?: SBUploadKindOther;
        field.rect = rect;
        field.axElement = attach ? attach.node.axElement : node.axElement;
        field.required = node.required || SBMatches(SBRequiredMarkPattern(), label);
        field.context = [self contextFromLegend:legend heading:heading label:label];
        field.value = (container ? SBAttachedFileName(container.node, 3) : nil) ?: SBFileInputStateValue(node);

        SBCandidate *candidate = [[SBCandidate alloc] init];
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

- (SBCandidate *)candidateForEntry:(SBWalkEntry *)entry kind:(NSString *)kind window:(CGRect)window order:(NSUInteger)order {
    id<SBAXNode> node = entry.node;
    if (!node.enabled) return nil;
    CGRect frame = node.frame;
    if (![self isFrame:frame reachableFromEntry:entry window:window]) return nil;
    BOOL isButton = [kind isEqualToString:SBKindButton];
    BOOL isLink = [kind isEqualToString:SBKindLink];
    BOOL isItem = [kind isEqualToString:SBKindItem];
    // Buttons, links and list entries are all places to GO: pressed, never filled, named by their own text.
    BOOL isAction = isButton || isLink || isItem;
    if (isButton && [SBSkippedButtonSubroles() containsObject:node.subrole ?: @""]) return nil;

    SBNaming *naming = [self namingForEntry:entry kind:kind];
    NSString *label = naming.label;
    // A control with no readable name is useless to the FORM walk (nothing can be mapped to it) and is dropped.
    // Shabang anywhere needs it anyway: a player's fullscreen button, a cart glyph and a kebab menu have no name
    // anywhere in the tree, and naming them is exactly what the affordance layer and the vision fallback are
    // for (docs/anywhere.md sections 2 and 4). With `capturesUnnamedControls` such a control is kept, marked
    // `unnamed`, and only ever reaches the next-action path: it can never carry a value ghost.
    // A list entry with nothing readable in it is not worth naming later either: it is an empty row.
    if (isItem && label.length == 0) return nil;
    // Outside a web area, a box you can type into but that nothing anywhere names is not a field: it is text
    // that happens to live in a text role. Messages, Mail, Slack and Discord all publish every message on
    // screen as a bare AXTextArea, so one open conversation looked like a twenty-one field form and Shabang
    // offered to fill in the other person's messages. This is the rule buttons and links already live by --
    // nothing can be mapped to a control with no name -- and the same read-only check the writer would apply.
    //
    // Never inside a web area: forms there do omit labels, a web input often refuses AXValue and is filled by
    // typing instead (which is what the writer's fallback chain is for), and no form may lose a field to this.
    if (!isAction && !entry.insideWebArea && SBIsTypeableKind(kind)) {
        if (label.length == 0 && SBSquash(node.placeholder).length == 0) return nil;
        if (!node.valueIsSettable) return nil;
    }
    if ((isButton || isLink) && label.length == 0 && !(self.capturesUnnamedControls && [self isWorthNamingLater:node])) return nil;

    NSString *legend = @"", *heading = @"";
    if (!isLink) SBLegendAndHeading(entry, &legend, &heading);
    if (!isAction) {
        NSString *everyName = [[naming.sources arrayByAddingObject:legend] componentsJoinedByString:@" "];
        if ([self isTextSensitive:everyName placeholder:node.placeholder identifier:node.identifier]) return nil;
        if ([self isCardFieldWithLabel:label legend:legend heading:heading]) return nil;
    }

    SBField *field = [SBField fieldWithSignature:@"" label:label kind:kind];
    field.focused = node.isFocused;
    field.identifier = node.identifier;
    field.rect = frame;
    field.axElement = node.axElement;
    field.required = node.required || SBMatches(SBRequiredMarkPattern(), SBSquash(naming.rawLabel));
    if (!isLink) field.context = [self contextFromLegend:legend heading:heading label:label];

    if (isAction) {
        field.unread = SBLooksUnread(naming.rawLabel) || SBLooksUnread(node.axDescription);
        field.locked = [self isLabelLocked:label];
        field.unnamed = label.length == 0;
        // Generic naming evidence the affordance layer reads as icon words, and the raw description a vision
        // label would replace. Never a value, never page text: a description is at most a control's own name.
        field.axDescription = SBSquash(node.axDescription).length ? SBSquash(node.axDescription) : nil;
        field.classTokens = node.domClassList.count ? node.domClassList : nil;
    } else {
        field.placeholder = SBSquash(node.placeholder).length ? SBSquash(node.placeholder) : nil;
        NSString *value = node.value ?: @"";
        if ([kind isEqualToString:SBKindText]) {
            [self refineTextField:field node:node];
            field.value = value;
        } else if ([kind isEqualToString:SBKindTextArea]) {
            field.value = value;
        } else if ([kind isEqualToString:SBKindCheckbox]) {
            // "2" is the mixed state: report it as ticked so no ghost ever offers to change it.
            field.value = ([value isEqualToString:@"0"] || value.length == 0) ? @"false" : @"true";
        } else if ([kind isEqualToString:SBKindSelect]) {
            NSString *shown = SBSquash(value);
            field.value = SBMatches(SBPlaceholderChoicePattern(), shown) ? @"" : shown;
            field.options = [self cheapOptionsForSelectNode:node];
            if ([node.role isEqualToString:kRoleComboBox] && field.options.count == 0) {
                // react-select and ARIA combo boxes: the options only exist while the list is open.
                field.options = nil;
                field.lazyOptions = YES;
                SBAdoptComboDisplay(field, entry);
            }
        }
    }

    SBCandidate *candidate = [[SBCandidate alloc] init];
    candidate.entry = entry;
    candidate.field = field;
    candidate.node = node;
    candidate.signatureRole = node.role ?: @"";
    candidate.signatureSubrole = node.subrole;
    candidate.order = order;
    return candidate;
}

#pragma mark Radios

static NSString *SBRadioOptionLabel(SBWalkEntry *entry) {
    id<SBAXNode> node = entry.node;
    NSString *label = SBSquash(node.title);
    if (label.length == 0) label = SBSquash(node.axDescription);
    if (label.length == 0) {
        id<SBAXNode> titleElement = node.titleUIElement;
        if (titleElement) label = SBTextOfNode(titleElement);
    }
    if (label.length == 0) label = SBDescendantText(node, 1);
    if (label.length == 0) label = SBFollowingText(entry) ?: @"";
    if (label.length == 0) label = SBSquash(node.help);
    return SBTruncate([SBCapture cleanLabel:label], kMaxLabel);
}

/// Where a loose radio sits for grouping purposes: its parent, or the grandparent when the parent only wraps this one radio.
static void SBRadioSeat(SBWalkEntry *radio, SBWalkEntry *__strong *container, NSUInteger *position) {
    SBWalkEntry *parent = radio.parent;
    *container = parent;
    *position = radio.indexInParent;
    if (!parent) return;
    NSUInteger radios = 0;
    for (id<SBAXNode> sibling in radio.siblings) if ([sibling.role isEqualToString:kRoleRadioButton]) radios++;
    if (radios == 1 && parent.parent && [parent.node.role isEqualToString:kRoleGroup]) {
        *container = parent.parent;
        *position = parent.indexInParent;
    }
}

/// HTML radios often have no AXRadioGroup. Radios under one container form a group until something
/// other than a single static text (an option label) sits between two of them: that is the next question.
- (NSArray<NSArray<SBWalkEntry *> *> *)groupLooseRadios:(NSArray<SBWalkEntry *> *)radios {
    NSMutableArray<NSMutableArray<SBWalkEntry *> *> *groups = [NSMutableArray array];
    SBWalkEntry *lastContainer = nil;
    NSUInteger lastPosition = 0;
    for (SBWalkEntry *radio in radios) {
        SBWalkEntry *container = nil;
        NSUInteger position = 0;
        SBRadioSeat(radio, &container, &position);
        BOOL joins = groups.count > 0 && container != nil && container == lastContainer && position > lastPosition;
        if (joins) {
            NSArray<id<SBAXNode>> *siblings = container.node.children;
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

- (SBCandidate *)radioCandidateForGroup:(SBWalkEntry *)groupEntry radios:(NSArray<SBWalkEntry *> *)radios window:(CGRect)window order:(NSUInteger)order {
    NSMutableArray<NSDictionary<NSString *, NSString *> *> *options = [NSMutableArray array];
    NSMutableDictionary<NSString *, id<SBAXNode>> *radioNodes = [NSMutableDictionary dictionary];
    NSMutableSet<NSString *> *optionLabels = [NSMutableSet set];
    NSString *selected = @"";
    CGRect rect = CGRectNull;
    SBWalkEntry *first = nil;
    for (SBWalkEntry *radio in radios) {
        if (options.count >= self.limits.maxOptions) break;
        id<SBAXNode> node = radio.node;
        if (!node.enabled || ![self isFrame:node.frame reachableFromEntry:radio window:window]) continue;
        NSString *label = SBRadioOptionLabel(radio);
        if (label.length == 0 || [optionLabels containsObject:label]) continue;
        [optionLabels addObject:label];
        [options addObject:@{ @"value": label, @"label": label }];
        radioNodes[label] = node;
        if ([node.value isEqualToString:@"1"]) selected = label;
        rect = CGRectIsNull(rect) ? node.frame : CGRectUnion(rect, node.frame);
        if (!first) first = radio;
    }
    if (!first) return nil;

    SBNaming *naming = nil;
    NSString *legend = @"", *heading = @"";
    SBWalkEntry *anchor = groupEntry ?: first;
    if (groupEntry) {
        if (!groupEntry.node.enabled) return nil;
        naming = [self namingForEntry:groupEntry kind:SBKindRadio];
    } else {
        naming = [[SBNaming alloc] init];
        naming.sources = [NSMutableArray array];
    }
    SBLegendAndHeading(anchor, &legend, &heading);
    if (naming.sources.count == 0) {
        // Loose radios: the legend of their container, else the question text right before the first radio.
        NSString *question = legend.length ? legend : SBPrecedingText(first, kLabelLevelsUp, optionLabels);
        if (question.length) [naming.sources addObject:question];
        naming.rawLabel = naming.sources.firstObject ?: @"";
        naming.label = [SBCapture cleanLabel:naming.rawLabel];
    }
    NSString *everyName = [[naming.sources arrayByAddingObject:legend] componentsJoinedByString:@" "];
    NSString *identifier = groupEntry ? groupEntry.node.identifier : nil;
    if ([self isTextSensitive:everyName placeholder:nil identifier:identifier]) return nil;
    for (SBWalkEntry *radio in radios) {
        if ([self isTextSensitive:nil placeholder:nil identifier:radio.node.identifier]) return nil;
    }

    SBField *field = [SBField fieldWithSignature:@"" label:naming.label kind:SBKindRadio];
    field.options = options;
    field.value = selected;
    field.rect = rect;
    field.identifier = identifier;
    field.axElement = first.node.axElement; // like findElement in the extension: the first radio of the group
    field.required = (groupEntry && groupEntry.node.required) || SBMatches(SBRequiredMarkPattern(), SBSquash(naming.rawLabel));
    field.context = [self contextFromLegend:legend heading:heading label:naming.label];

    SBCandidate *candidate = [[SBCandidate alloc] init];
    candidate.entry = anchor;
    candidate.field = field;
    candidate.node = groupEntry ? groupEntry.node : first.node;
    candidate.signatureRole = kRoleRadioGroup; // same signature whether or not the page declares a radiogroup
    candidate.radioNodes = radioNodes;
    candidate.order = order;
    return candidate;
}

#pragma mark Signatures

- (NSString *)signatureBaseForCandidate:(SBCandidate *)candidate {
    SBField *field = candidate.field;
    NSString *identifier = field.identifier ?: @"";
    if (SBMatches(SBUnstableIdentifierPattern(), identifier)) identifier = @"";
    NSString *label = SBTruncate([SBCapture normalizedLabel:field.label], kMaxSignatureLabel);
    return [@[ @"ax", candidate.signatureRole ?: @"", candidate.signatureSubrole ?: @"", label, identifier ] componentsJoinedByString:@"|"];
}

#pragma mark Walk

/// Browser chrome that is not a whole toolbar: tab-bar items (AXRadioButton / AXTabButton, never a form choice)
/// and the address/search field. Only consulted outside web areas: inside one, the same roles are page content.
static BOOL SBIsBrowserChrome(id<SBAXNode> node, NSString *role) {
    if ([node.subrole isEqualToString:kSubroleTabButton]) return YES;
    NSString *identifier = node.identifier;
    return identifier.length > 0 && SBMatches(SBAddressFieldIdentifierPattern(), identifier);
}

- (SBCaptureResult *)captureWindow:(id<SBAXNode>)window {
    SBCaptureLimits *limits = [self.limits copy];
    NSTimeInterval (^clock)(void) = self.clock;
    NSTimeInterval started = clock();
    CGRect windowFrame = window.frame;

    SBCaptureResult *result = [[SBCaptureResult alloc] init];
    result.windowFrame = windowFrame;

    NSMutableArray<SBCandidate *> *candidates = [NSMutableArray array];
    NSMutableArray<SBWalkEntry *> *looseRadios = [NSMutableArray array];
    NSMutableArray<SBWalkEntry *> *uploads = [NSMutableArray array];
    NSMutableArray<SBWalkEntry *> *radioGroups = [NSMutableArray array];
    NSMapTable<SBWalkEntry *, NSMutableArray<SBWalkEntry *> *> *groupedRadios = [NSMapTable strongToStrongObjectsMapTable];
    NSUInteger order = 0;
    BOOL depthLimited = NO;

    SBWalkEntry *root = [[SBWalkEntry alloc] init];
    root.node = window;
    root.webAreaFrame = CGRectZero;
    root.viewportFrame = CGRectZero;
    NSMutableArray<SBWalkEntry *> *queue = [NSMutableArray arrayWithObject:root];
    NSUInteger head = 0;
    NSUInteger visited = 0;

    while (head < queue.count) {
        if (visited >= limits.maxNodes) { result.stop = SBCaptureStopNodes; break; }
        NSTimeInterval budget = result.sawWebArea ? MAX(limits.timeBudget, limits.webAreaTimeBudget) : limits.timeBudget;
        if (clock() - started > budget) { result.stop = SBCaptureStopTime; break; }
        SBWalkEntry *entry = queue[head++];
        visited++;
        id<SBAXNode> node = entry.node;
        NSString *role = node.role;
        if (role.length == 0) continue; // dead element or a failed fetch: nothing to trust below it
        if ([SBAlwaysSkippedRoles() containsObject:role]) continue;
        if (!entry.insideWebArea && SBIsBrowserChrome(node, role)) continue;
        if (SBIsSecure(node)) continue;

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
            CGRect viewport = SBHasBox(windowFrame) ? windowFrame : CGRectZero;
            CGRect holder = entry.parent ? entry.parent.node.frame : CGRectZero;
            if (SBHasBox(holder)) viewport = SBHasBox(viewport) ? CGRectIntersection(viewport, holder) : holder;
            entry.viewportFrame = CGRectIsNull(viewport) ? CGRectZero : viewport;
        }

        NSString *kind = [SBCapture kindForRole:role subrole:node.subrole];
        // A label that publishes AXPress is not a label, it is a row. Measured on a live Messages window:
        // every conversation in the sidebar is an AXStaticText with an AXPress and a name, and no AXRow or
        // AXCell exists anywhere in that app -- so without this a chat list is nine pieces of text and
        // Shabang has nothing to offer but "new message", which is the one thing it cannot help with.
        // The press check costs a round trip, so it is asked only of a named, list-sized leaf.
        if (!kind && SBCouldBeAPressableLabel(node, role)) kind = SBKindItem;
        if ([role isEqualToString:kRoleButton] && SBIsFileUploadButton(node)) {
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
            SBCandidate *candidate = [self candidateForEntry:entry kind:kind window:windowFrame order:order++];
            if (candidate) [candidates addObject:candidate];
            continue; // a control's children are its own business (options, button text)
        } else if ([SBLeafRoles() containsObject:role]) {
            continue;
        }

        if (entry.depth >= limits.maxDepth) { depthLimited = YES; continue; }
        NSArray<id<SBAXNode>> *children = node.children;
        // A list keeps only its first rows. Nobody wants the 900th track, and the rest would eat the walk.
        if (children.count > limits.maxListRows && [SBListContainerRoles() containsObject:role]) {
            children = [children subarrayWithRange:NSMakeRange(0, limits.maxListRows)];
        }
        NSUInteger index = 0;
        for (id<SBAXNode> child in children) {
            SBWalkEntry *next = [[SBWalkEntry alloc] init];
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
    for (SBWalkEntry *group in radioGroups) {
        SBCandidate *candidate = [self radioCandidateForGroup:group radios:[groupedRadios objectForKey:group] window:windowFrame order:order++];
        if (candidate) [candidates addObject:candidate];
    }
    for (NSArray<SBWalkEntry *> *group in [self groupLooseRadios:looseRadios]) {
        SBCandidate *candidate = [self radioCandidateForGroup:nil radios:group window:windowFrame order:order++];
        if (candidate) [candidates addObject:candidate];
    }
    [self foldUploadEntries:uploads intoCandidates:candidates window:windowFrame order:&order];
    [self foldComboAccessoriesIn:candidates];
    [candidates filterUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(SBCandidate *candidate, NSDictionary *bindings) {
        return !([candidate.field.kind isEqualToString:SBKindButton] && SBMatches(SBSiteAutofillPattern(), candidate.field.label));
    }]];

    // In a browser window the page is the only place Shabang works: the URL bar and the find bar are not forms.
    if (result.sawWebArea) {
        [candidates filterUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(SBCandidate *candidate, NSDictionary *bindings) {
            return candidate.entry.insideWebArea;
        }]];
    } else if (result.stop != SBCaptureStopNone || depthLimited) {
        // A partial browser walk may stop before Safari's nested AXWebArea. Never mistake tab-strip,
        // address/search or other provisional controls for a native form when discovery is incomplete.
        [candidates filterUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(SBCandidate *candidate, NSDictionary *bindings) {
            return !candidate.entry.insideUnresolvedTabGroup;
        }]];
    }

    NSArray<SBCandidate *> *ordered = SBReadingOrder(candidates, ^CGRect(SBCandidate *candidate) { return candidate.field.rect; });

    NSMutableArray<SBField *> *fields = [NSMutableArray array];
    NSMutableDictionary<NSString *, id<SBAXNode>> *nodes = [NSMutableDictionary dictionary];
    NSMutableDictionary<NSString *, NSDictionary *> *radioNodes = [NSMutableDictionary dictionary];
    NSMutableDictionary<NSString *, id<SBAXNode>> *uploadNodes = [NSMutableDictionary dictionary];
    NSMutableDictionary<NSString *, NSNumber *> *seen = [NSMutableDictionary dictionary];
    NSMutableArray<NSString *> *formParts = [NSMutableArray array];
    NSUInteger links = 0;
    for (SBCandidate *candidate in ordered) {
        SBField *field = candidate.field;
        if ([field.kind isEqualToString:SBKindLink] && ++links > limits.maxLinks) continue;
        NSString *base = [self signatureBaseForCandidate:candidate];
        NSUInteger index = seen[base].unsignedIntegerValue;
        seen[base] = @(index + 1);
        field.signature = [NSString stringWithFormat:@"%@|%lu", base, (unsigned long)index];
        [fields addObject:field];
        nodes[field.signature] = candidate.node;
        if (candidate.radioNodes) radioNodes[field.signature] = candidate.radioNodes;
        if (candidate.uploadNode) uploadNodes[field.signature] = candidate.uploadNode;
        if (SBIsValueKind(field.kind)) [formParts addObject:field.signature];
    }

    result.windowNode = window;
    result.fields = fields;
    result.nodes = nodes;
    result.radioNodes = radioNodes;
    result.uploadNodes = uploadNodes;
    result.visitedNodes = visited;
    result.partial = result.stop != SBCaptureStopNone || depthLimited;
    result.formSignature = SBFNV1a([formParts componentsJoinedByString:@"\n"]);
    result.elapsed = clock() - started;
    return result;
}

@end
