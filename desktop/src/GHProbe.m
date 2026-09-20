#import "GHProbe.h"
#import "GHComboBoxDriver.h"
#import "GHLog.h"

static const NSUInteger kProbeWalkNodes = 4000;
static const NSTimeInterval kProbeWalkSeconds = 3.0;
static const NSUInteger kProbeSiblingWindow = 6;
static const NSUInteger kProbeMaxOptionsReported = 40;
static const NSTimeInterval kProbeSettle = 0.45;

/// Everything after an AXPress needs the page to have re-rendered; there is no notification to wait for here. The
/// probe runs on the harness's own background queue, so plain wall-clock sleeping is the right (and only) wait.
static void GHProbeSettle(NSTimeInterval seconds) {
    [NSThread sleepForTimeInterval:seconds];
}

static void GHProbeCollectComboBoxes(id<GHAXNode> node, NSMutableArray<id<GHAXNode>> *into, GHAXWalkBudget *budget, NSUInteger limit) {
    if (into.count >= limit || !GHAXWalkBudgetSpend(budget, node)) return;
    if ([GHComboBoxDriver isComboBox:node]) [into addObject:node];
    for (id<GHAXNode> child in node.children) {
        if (into.count >= limit) return;
        GHProbeCollectComboBoxes(child, into, budget, limit);
    }
}

@implementation GHProbe

+ (NSArray<id<GHAXNode>> *)comboBoxesUnderWindow:(id<GHAXNode>)window limit:(NSUInteger)limit {
    NSMutableArray<id<GHAXNode>> *found = [NSMutableArray array];
    GHAXWalkBudget budget = GHAXWalkBudgetMake(kProbeWalkNodes, kProbeWalkSeconds);
    if (window) GHProbeCollectComboBoxes(window, found, &budget, limit);
    return found;
}

+ (NSString *)labelOfComboBox:(id<GHAXNode>)node {
    for (NSString *candidate in @[ node.title ?: @"", node.axDescription ?: @"", node.titleUIElement.value ?: @"",
                                   node.titleUIElement.title ?: @"", node.placeholder ?: @"", node.help ?: @"" ]) {
        if (candidate.length) return candidate;
    }
    return nil;
}

+ (id<GHAXNode>)toggleButtonForComboBox:(id<GHAXNode>)comboBox {
    id<GHAXNode> parent = comboBox.parent;
    NSArray<id<GHAXNode>> *siblings = parent.children;
    NSUInteger index = NSNotFound;
    for (NSUInteger i = 0; i < siblings.count; i++) if ([siblings[i] isSameNode:comboBox]) { index = i; break; }
    if (index == NSNotFound) return nil;
    for (NSUInteger i = index + 1; i < siblings.count && i <= index + kProbeSiblingWindow; i++) {
        id<GHAXNode> sibling = siblings[i];
        // Stop before the NEXT control: a button that far away belongs to something else.
        if ([GHComboBoxDriver isComboBox:sibling] || [sibling.role isEqualToString:(__bridge NSString *)kAXTextFieldRole]) return nil;
        if ([sibling.role isEqualToString:(__bridge NSString *)kAXButtonRole]) return sibling;
    }
    return nil;
}

+ (NSDictionary<NSString *, id> *)summaryOfNode:(id<GHAXNode>)node {
    if (!node) return @{ @"present": @NO };
    NSMutableDictionary<NSString *, id> *out = [@{ @"present": @YES, @"role": node.role ?: @"",
                                                   @"childCount": @(node.children.count), @"enabled": @(node.enabled),
                                                   @"focused": @(node.isFocused), @"valueLength": @(node.value.length) } mutableCopy];
    if (node.subrole.length) out[@"subrole"] = node.subrole;
    if (node.roleDescription.length) out[@"roleDescription"] = node.roleDescription;
    if (node.title.length) out[@"title"] = node.title;
    if (node.axDescription.length) out[@"description"] = node.axDescription;
    if (node.identifier.length) out[@"identifier"] = node.identifier;
    if (node.domClassList.count) out[@"classes"] = node.domClassList;
    CGRect frame = node.frame;
    out[@"rect"] = @{ @"x": @((NSInteger)frame.origin.x), @"y": @((NSInteger)frame.origin.y),
                      @"width": @((NSInteger)frame.size.width), @"height": @((NSInteger)frame.size.height) };
    if (node.axElement) {
        CFArrayRef names = NULL;
        if (AXUIElementCopyActionNames(node.axElement, &names) == kAXErrorSuccess && names) out[@"actions"] = CFBridgingRelease(names);
    }
    return out;
}

/// The nodes around `comboBox` under the same parent: what the page adds when a list opens shows up here.
+ (NSArray<NSDictionary *> *)neighbourhoodOf:(id<GHAXNode>)comboBox {
    id<GHAXNode> parent = comboBox.parent;
    NSArray<id<GHAXNode>> *siblings = parent.children;
    NSUInteger index = NSNotFound;
    for (NSUInteger i = 0; i < siblings.count; i++) if ([siblings[i] isSameNode:comboBox]) { index = i; break; }
    NSMutableArray<NSDictionary *> *out = [NSMutableArray array];
    if (index == NSNotFound) return out;
    NSUInteger from = index > 2 ? index - 2 : 0;
    for (NSUInteger i = from; i < siblings.count && i <= index + kProbeSiblingWindow; i++) {
        NSMutableDictionary *entry = [[self summaryOfNode:siblings[i]] mutableCopy];
        entry[@"siblingIndex"] = @(i);
        if (i == index) entry[@"isTheComboBox"] = @YES;
        [out addObject:entry];
    }
    return out;
}

/// The raw shape of a subtree: what the page really exposes, before any of the driver's rules run.
+ (NSDictionary<NSString *, id> *)shallowTreeOf:(id<GHAXNode>)node depth:(NSUInteger)depth {
    NSMutableDictionary<NSString *, id> *out = [@{ @"role": node.role ?: @"" } mutableCopy];
    if (node.subrole.length) out[@"subrole"] = node.subrole;
    if (node.roleDescription.length) out[@"roleDescription"] = node.roleDescription;
    if (node.domClassList.count) out[@"classes"] = node.domClassList;
    // Option TEXT is page content, not a field value: which attribute carries it is the whole question here.
    if (node.title.length) out[@"title"] = node.title;
    if (node.value.length) out[@"value"] = node.value;
    if (node.axDescription.length) out[@"description"] = node.axDescription;
    if (node.isFocused) out[@"focused"] = @YES;
    if (!node.enabled) out[@"enabled"] = @NO;
    if (node.axElement) {
        CFArrayRef names = NULL;
        if (AXUIElementCopyActionNames(node.axElement, &names) == kAXErrorSuccess && names) out[@"actions"] = CFBridgingRelease(names);
    }
    NSArray<id<GHAXNode>> *children = node.children;
    out[@"childCount"] = @(children.count);
    if (depth > 0 && children.count) {
        NSMutableArray *kids = [NSMutableArray array];
        for (id<GHAXNode> child in children) {
            if (kids.count >= 12) break;
            [kids addObject:[self shallowTreeOf:child depth:depth - 1]];
        }
        out[@"children"] = kids;
    }
    return out;
}

/// Every sibling after the combo box, scanned ONE AT A TIME with a fresh budget. `listForComboBox:` has a single
/// 0.2 s budget for its whole search, so this separates "the driver cannot recognise this list" from "the driver
/// ran out of time before it got here".
+ (NSArray<NSDictionary *> *)listCandidatesAfter:(id<GHAXNode>)comboBox {
    id<GHAXNode> parent = comboBox.parent;
    NSArray<id<GHAXNode>> *siblings = parent.children;
    NSUInteger index = NSNotFound;
    for (NSUInteger i = 0; i < siblings.count; i++) if ([siblings[i] isSameNode:comboBox]) { index = i; break; }
    NSMutableArray<NSDictionary *> *out = [NSMutableArray array];
    if (index == NSNotFound) return out;
    for (NSUInteger i = index + 1; i < siblings.count && i <= index + 8; i++) {
        id<GHAXNode> sibling = siblings[i];
        NSArray<id<GHAXNode>> *options = [GHComboBoxDriver optionsInList:sibling];
        NSMutableArray<NSString *> *texts = [NSMutableArray array];
        for (id<GHAXNode> option in options) {
            if (texts.count >= kProbeMaxOptionsReported) break;
            [texts addObject:[GHComboBoxDriver textOfOption:option] ?: @""];
        }
        NSMutableDictionary *entry = [@{ @"siblingIndex": @(i), @"role": sibling.role ?: @"",
                                         @"classes": sibling.domClassList ?: @[],
                                         @"directOptionCount": @(options.count), @"directOptions": texts,
                                         @"saysNothingFound": @([GHComboBoxDriver listSaysNothingFound:sibling]) } mutableCopy];
        if (options.count) entry[@"firstOptionShape"] = [self summaryOfNode:options.firstObject];
        if ([sibling.role isEqualToString:@"AXList"] || [sibling.role isEqualToString:@"AXMenu"] || sibling.children.count > 2) {
            entry[@"raw"] = [self shallowTreeOf:sibling depth:3];
        }
        [out addObject:entry];
    }
    return out;
}

/// What GHComboBoxDriver itself would find right now: the answer to "can the shipping code see this list?".
+ (NSDictionary<NSString *, id> *)driverViewOf:(id<GHAXNode>)comboBox {
    id<GHAXNode> list = [GHComboBoxDriver listForComboBox:comboBox];
    NSMutableDictionary<NSString *, id> *out = [@{ @"listFound": @(list != nil) } mutableCopy];
    if (!list) return out;
    out[@"list"] = [self summaryOfNode:list];
    out[@"saysNothingFound"] = @([GHComboBoxDriver listSaysNothingFound:list]);
    NSArray<id<GHAXNode>> *options = [GHComboBoxDriver optionsInList:list];
    out[@"optionCount"] = @(options.count);
    NSMutableArray<NSString *> *texts = [NSMutableArray array];
    NSMutableArray<NSDictionary *> *shapes = [NSMutableArray array];
    for (id<GHAXNode> option in options) {
        if (texts.count >= kProbeMaxOptionsReported) break;
        [texts addObject:[GHComboBoxDriver textOfOption:option] ?: @""];
        if (shapes.count < 3) [shapes addObject:[self summaryOfNode:option]];
    }
    out[@"options"] = texts;
    out[@"optionShapes"] = shapes;
    return out;
}

+ (NSDictionary<NSString *, id> *)systemFocus {
    AXUIElementRef systemWide = AXUIElementCreateSystemWide();
    if (!systemWide) return @{ @"present": @NO };
    CFTypeRef focused = NULL;
    AXError error = AXUIElementCopyAttributeValue(systemWide, kAXFocusedUIElementAttribute, &focused);
    CFRelease(systemWide);
    if (error != kAXErrorSuccess || !focused) return @{ @"present": @NO, @"axError": @((int)error) };
    NSDictionary *summary = [self summaryOfNode:[GHAXElementNode nodeWithElement:(AXUIElementRef)focused]];
    CFRelease(focused);
    return summary;
}

+ (NSDictionary<NSString *, id> *)probeComboBoxUnderWindow:(id<GHAXNode>)window labelSubstring:(NSString *)labelSubstring {
    NSMutableDictionary<NSString *, id> *report = [@{ @"want": labelSubstring ?: @"" } mutableCopy];
    NSArray<id<GHAXNode>> *comboBoxes = [self comboBoxesUnderWindow:window limit:40];
    NSMutableArray<NSString *> *seen = [NSMutableArray array];
    id<GHAXNode> target = nil;
    NSString *targetLabel = nil;
    for (id<GHAXNode> candidate in comboBoxes) {
        NSString *label = [self labelOfComboBox:candidate] ?: @"";
        [seen addObject:label];
        if (!target && label.length && labelSubstring.length
            && [label rangeOfString:labelSubstring options:NSCaseInsensitiveSearch].location != NSNotFound) {
            target = candidate;
            targetLabel = label;
        }
    }
    report[@"comboBoxLabels"] = seen;
    if (!target) { report[@"error"] = @"no-such-combobox"; return report; }
    report[@"label"] = targetLabel;

    // The same refusals the driver makes, before anything is touched.
    if ([GHComboBoxDriver isDemographicComboBox:target]) { report[@"error"] = @"demographic"; return report; }
    if (!target.enabled) { report[@"error"] = @"disabled"; return report; }

    report[@"before"] = [self summaryOfNode:target];
    report[@"beforeNeighbourhood"] = [self neighbourhoodOf:target];
    report[@"beforeDriverView"] = [self driverViewOf:target];
    report[@"shownBefore"] = [GHComboBoxDriver shownTextsForComboBox:target typed:nil] ?: @[];

    // 1. Does AXFocused even land on this element?
    BOOL focusSet = target.axElement && AXUIElementSetAttributeValue(target.axElement, kAXFocusedAttribute, kCFBooleanTrue) == kAXErrorSuccess;
    GHProbeSettle(0.15);
    report[@"focus"] = @{ @"setAccepted": @(focusSet),
                          @"nodeFocusedAfter": @([GHAXElementNode nodeWithElement:target.axElement].isFocused),
                          @"systemFocus": [self systemFocus] };

    // 2. AXPress the combo box itself.
    AXError pressError = target.axElement ? AXUIElementPerformAction(target.axElement, kAXPressAction) : kAXErrorInvalidUIElement;
    GHProbeSettle(kProbeSettle);
    id<GHAXNode> afterPress = [GHAXElementNode nodeWithElement:target.axElement];
    report[@"press"] = @{ @"axError": @((int)pressError),
                          @"neighbourhood": [self neighbourhoodOf:afterPress],
                          @"driverView": [self driverViewOf:afterPress],
                          @"listCandidates": [self listCandidatesAfter:afterPress],
                          @"systemFocus": [self systemFocus] };
    BOOL open = [[report[@"press"][@"driverView"] objectForKey:@"listFound"] boolValue];

    // 3. Only if that did nothing: the "Toggle flyout" button beside it.
    id<GHAXNode> toggle = [self toggleButtonForComboBox:afterPress];
    report[@"toggleButton"] = [self summaryOfNode:toggle];
    if (!open && toggle.axElement) {
        AXError toggleError = AXUIElementPerformAction(toggle.axElement, kAXPressAction);
        GHProbeSettle(kProbeSettle);
        id<GHAXNode> afterToggle = [GHAXElementNode nodeWithElement:target.axElement];
        report[@"toggle"] = @{ @"axError": @((int)toggleError),
                               @"neighbourhood": [self neighbourhoodOf:afterToggle],
                               @"driverView": [self driverViewOf:afterToggle],
                               @"systemFocus": [self systemFocus] };
        open = [[report[@"toggle"][@"driverView"] objectForKey:@"listFound"] boolValue];
    }

    // 4. Leave the page as it was found. No key is posted: the toggle closes what the toggle opened.
    if (open && toggle.axElement) {
        AXUIElementPerformAction(toggle.axElement, kAXPressAction);
        GHProbeSettle(kProbeSettle);
        open = [self driverViewOf:[GHAXElementNode nodeWithElement:target.axElement]][@"listFound"] != nil
             && [[self driverViewOf:[GHAXElementNode nodeWithElement:target.axElement]][@"listFound"] boolValue];
    }
    report[@"leftOpen"] = @(open);
    report[@"shownAfter"] = [GHComboBoxDriver shownTextsForComboBox:[GHAXElementNode nodeWithElement:target.axElement] typed:nil] ?: @[];
    GHLog(@"probe: combobox %@ leftOpen=%d", GHLogLabel(targetLabel), open);
    return report;
}

@end
