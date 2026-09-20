#import "SBPageContext.h"

const NSUInteger SBPageContextMaxDescription = 2000;
const NSUInteger SBPageContextMaxNodes = 6000;
const NSTimeInterval SBPageContextMaxSeconds = 0.25;

static const NSUInteger kMaxDepth = 120;
static const NSUInteger kMaxNameLength = 160;
static const NSUInteger kWebAreaSearchNodes = 2000;

typedef NS_OPTIONS(NSUInteger, SBContextFlags) {
    SBContextInLink = 1 << 0,     // link or button text: navigation, not description
    SBContextInFooter = 1 << 1,   // AXLandmarkContentInfo: "Powered by <job board>"
    SBContextInRoleHeading = 1 << 2,
};

@interface SBPageContext ()
@property (nonatomic, readwrite, copy, nullable) NSString *company;
@property (nonatomic, readwrite, copy, nullable) NSString *role;
@property (nonatomic, readwrite, copy) NSString *jobDescription;
@property (nonatomic, readwrite) NSUInteger visitedNodes;
@property (nonatomic, readwrite) BOOL truncated;
@end

static BOOL SBControlRole(NSString *role) {
    static NSSet<NSString *> *roles;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        roles = [NSSet setWithArray:@[ @"AXTextField", @"AXTextArea", @"AXComboBox", @"AXCheckBox", @"AXRadioButton", @"AXRadioGroup",
                                       @"AXPopUpButton", @"AXSecureTextField" ]];
    });
    return role && [roles containsObject:role];
}

static NSString *SBFirstMatch(NSString *text, NSString *pattern) {
    NSRegularExpression *regex = [NSRegularExpression regularExpressionWithPattern:pattern options:NSRegularExpressionCaseInsensitive error:NULL];
    NSTextCheckingResult *match = [regex firstMatchInString:text options:0 range:NSMakeRange(0, text.length)];
    if (!match || match.numberOfRanges < 2 || [match rangeAtIndex:1].location == NSNotFound) return nil;
    return [text substringWithRange:[match rangeAtIndex:1]];
}

static NSString *SBName(NSString *text) {
    NSString *name = [SBPageContext normalizedText:text];
    name = [name stringByTrimmingCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@" .,;:-|"]];
    if (name.length == 0) return nil;
    return name.length > kMaxNameLength ? [SBPageContext text:name cappedAt:kMaxNameLength] : name;
}

@implementation SBPageContext

#pragma mark pure

+ (NSString *)normalizedText:(NSString *)text {
    if (text.length == 0) return @"";
    NSArray<NSString *> *parts = [text componentsSeparatedByCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    NSMutableArray<NSString *> *words = [NSMutableArray arrayWithCapacity:parts.count];
    for (NSString *part in parts) if (part.length) [words addObject:part];
    return [words componentsJoinedByString:@" "];
}

+ (NSString *)text:(NSString *)text cappedAt:(NSUInteger)limit {
    if (text.length <= limit) return text;
    if (limit == 0) return @"";
    // Never split a composed character (emoji, accents): cut where the sequence holding index `limit` starts.
    NSUInteger cut = [text rangeOfComposedCharacterSequenceAtIndex:limit].location;
    NSUInteger window = MIN((NSUInteger)200, cut);
    NSRange space = [text rangeOfCharacterFromSet:NSCharacterSet.whitespaceAndNewlineCharacterSet options:NSBackwardsSearch
                                            range:NSMakeRange(cut - window, window)];
    if (space.location != NSNotFound && space.location > 0) cut = space.location;
    return [[text substringToIndex:cut] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

+ (NSString *)companyFromTitle:(NSString *)title role:(NSString *)role {
    NSString *text = [self normalizedText:title];
    NSString *rest = SBFirstMatch(text, @"^job application for (.+)$");
    if (!rest) return nil;
    NSString *knownRole = [self normalizedText:role];
    if (knownRole.length) {
        NSString *prefix = [knownRole stringByAppendingString:@" at "];
        if (rest.length > prefix.length && [rest rangeOfString:prefix options:NSCaseInsensitiveSearch | NSAnchoredSearch].location != NSNotFound) {
            return SBName([rest substringFromIndex:prefix.length]);
        }
    }
    NSRange at = [rest rangeOfString:@" at " options:NSCaseInsensitiveSearch | NSBackwardsSearch];
    if (at.location == NSNotFound) return nil;
    return SBName([rest substringFromIndex:NSMaxRange(at)]);
}

+ (NSString *)roleFromTitle:(NSString *)title {
    NSString *rest = SBFirstMatch([self normalizedText:title], @"^job application for (.+)$");
    NSRange at = rest ? [rest rangeOfString:@" at " options:NSCaseInsensitiveSearch | NSBackwardsSearch] : NSMakeRange(NSNotFound, 0);
    return at.location == NSNotFound ? nil : SBName([rest substringToIndex:at.location]);
}

+ (NSString *)companyFromLogoText:(NSString *)text {
    NSString *name = SBFirstMatch([self normalizedText:text], @"^(.+?)\\s+logo$");
    if (!name) return nil;
    NSString *lower = name.lowercaseString;
    // The job board's own branding, and generic words, are never the employer.
    for (NSString *board in @[ @"greenhouse", @"lever", @"workday", @"ashby", @"smartrecruiters", @"icims", @"jobvite", @"bamboohr", @"recruitee",
                               @"workable", @"teamtailor", @"breezy", @"company", @"our", @"the" ]) {
        if ([lower isEqualToString:board] || [lower hasPrefix:[board stringByAppendingString:@" "]]) return nil;
    }
    return SBName(name);
}

#pragma mark walk

static id<SBAXNode> SBFindWebArea(id<SBAXNode> root, SBAXWalkBudget *outer) {
    if ([root.role isEqualToString:@"AXWebArea"]) return root;
    SBAXWalkBudget budget = SBAXWalkBudgetNested(outer, kWebAreaSearchNodes);
    NSMutableArray<id<SBAXNode>> *queue = [NSMutableArray arrayWithObject:root];
    id<SBAXNode> found = nil;
    while (queue.count) {
        id<SBAXNode> node = queue.firstObject;
        [queue removeObjectAtIndex:0];
        if (!SBAXWalkBudgetSpend(&budget, node)) break;
        if ([node.role isEqualToString:@"AXWebArea"]) { found = node; break; }
        [queue addObjectsFromArray:node.children];
    }
    SBAXWalkBudgetAbsorb(outer, &budget);
    return found;
}

static NSString *SBHeadingText(id<SBAXNode> heading) {
    NSString *title = [SBPageContext normalizedText:heading.title];
    if (title.length) return title;
    NSMutableArray<NSString *> *parts = [NSMutableArray array];
    for (id<SBAXNode> child in heading.children) {
        NSString *text = [SBPageContext normalizedText:[child.role isEqualToString:@"AXStaticText"] ? child.value : child.title];
        if (text.length) [parts addObject:text];
    }
    return [SBPageContext normalizedText:[parts componentsJoinedByString:@" "]];
}

static BOOL SBIsApplyHeading(NSString *text) {
    return SBFirstMatch(text, @"^(apply (for|to) this (job|position|role|opening))\\W*$") != nil;
}

+ (instancetype)contextFromNode:(id<SBAXNode>)root {
    return [self contextFromNode:root maxNodes:SBPageContextMaxNodes];
}

+ (instancetype)contextFromNode:(id<SBAXNode>)root maxNodes:(NSUInteger)maxNodes {
    SBPageContext *context = [[self alloc] initPrivately];
    // Nodes AND wall clock (it runs on the main thread): a huge page or a hung app ends the walk early.
    SBAXWalkBudget budget = SBAXWalkBudgetMake(maxNodes, SBPageContextMaxSeconds);
    id<SBAXNode> page = SBFindWebArea(root, &budget) ?: root;

    NSString *role = nil;
    NSString *logoCompany = nil;
    NSMutableArray<NSString *> *pieces = [NSMutableArray array];
    NSInteger formStart = -1;   // pieces before the first form control, when no apply heading shows up
    BOOL applyHeadingSeen = NO;

    NSMutableArray<id<SBAXNode>> *stack = [NSMutableArray arrayWithObject:page];
    NSMutableArray<NSNumber *> *depths = [NSMutableArray arrayWithObject:@0];
    NSMutableArray<NSNumber *> *flags = [NSMutableArray arrayWithObject:@0];
    NSUInteger visited = 0;
    while (stack.count) {
        id<SBAXNode> node = stack.lastObject;
        NSUInteger depth = depths.lastObject.unsignedIntegerValue;
        SBContextFlags flag = flags.lastObject.unsignedIntegerValue;
        [stack removeLastObject];
        [depths removeLastObject];
        [flags removeLastObject];
        if (!SBAXWalkBudgetSpend(&budget, node)) { context.truncated = YES; break; }
        visited++;

        NSString *nodeRole = node.role ?: @"";
        if ([node.subrole isEqualToString:@"AXLandmarkContentInfo"]) flag |= SBContextInFooter;
        if ([nodeRole isEqualToString:@"AXLink"] || [nodeRole isEqualToString:@"AXButton"]) flag |= SBContextInLink;

        if ([nodeRole isEqualToString:@"AXHeading"]) {
            NSString *text = SBHeadingText(node);
            if (SBIsApplyHeading(text)) { applyHeadingSeen = YES; break; }   // everything after it is the form
            if (!role && text.length) { role = SBName(text); flag |= SBContextInRoleHeading; }
        }
        if (!logoCompany && !(flag & SBContextInFooter) && ([nodeRole isEqualToString:@"AXLink"] || [nodeRole isEqualToString:@"AXImage"])) {
            logoCompany = [self companyFromLogoText:node.title] ?: [self companyFromLogoText:node.axDescription];
        }
        if (formStart < 0 && (SBControlRole(nodeRole) || [node.subrole isEqualToString:@"AXLandmarkForm"])) formStart = (NSInteger)pieces.count;
        if ([nodeRole isEqualToString:@"AXStaticText"]) {
            // Page text only. A static text's children repeat it, so they are not visited.
            NSString *text = [self normalizedText:node.value];
            if (text.length && !(flag & (SBContextInLink | SBContextInFooter | SBContextInRoleHeading))) [pieces addObject:text];
            continue;
        }
        if (depth >= kMaxDepth) continue;
        NSArray<id<SBAXNode>> *children = node.children;
        for (NSInteger i = (NSInteger)children.count - 1; i >= 0; i--) {
            [stack addObject:children[(NSUInteger)i]];
            [depths addObject:@(depth + 1)];
            [flags addObject:@(flag)];
        }
    }
    context.visitedNodes = visited;

    NSArray<NSString *> *above = pieces;
    if (!applyHeadingSeen && formStart >= 0) above = [pieces subarrayWithRange:NSMakeRange(0, (NSUInteger)formStart)];
    context.jobDescription = [self text:[above componentsJoinedByString:@"\n"] cappedAt:SBPageContextMaxDescription];

    NSString *titleCompany = nil;
    for (NSString *title in @[ page.title ?: @"", page.axDescription ?: @"", root.title ?: @"" ]) {
        titleCompany = [self companyFromTitle:title role:role];
        if (titleCompany) break;
    }
    if (!role) {
        for (NSString *title in @[ page.title ?: @"", page.axDescription ?: @"", root.title ?: @"" ]) {
            role = [self roleFromTitle:title];
            if (role) break;
        }
    }
    context.role = role;
    context.company = titleCompany ?: logoCompany;
    return context;
}

- (instancetype)initPrivately {
    if ((self = [super init])) _jobDescription = @"";
    return self;
}

- (NSDictionary<NSString *, NSString *> *)dictionary {
    NSMutableDictionary<NSString *, NSString *> *out = [NSMutableDictionary dictionary];
    if (self.company.length) out[@"company"] = self.company;
    if (self.role.length) out[@"role"] = self.role;
    if (self.jobDescription.length) out[@"description"] = self.jobDescription;
    return out;
}

- (NSString *)description {
    // Lengths only: page text can be long.
    return [NSString stringWithFormat:@"<SBPageContext company=%lu role=%lu description=%lu>", (unsigned long)self.company.length,
            (unsigned long)self.role.length, (unsigned long)self.jobDescription.length];
}

@end
