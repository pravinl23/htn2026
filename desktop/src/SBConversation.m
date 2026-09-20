#import "SBConversation.h"
#import "SBPageContext.h"   // normalizedText / text:cappedAt: -- the same trimming every context uses

const NSUInteger SBConversationMaxMessages = 14;
const NSUInteger SBConversationMaxMessageChars = 400;
const NSUInteger SBConversationMaxTotalChars = 2000;
const NSUInteger SBConversationMaxNodes = 4000;
const NSTimeInterval SBConversationMaxSeconds = 0.20;

static const NSUInteger kMaxNameChars = 80;
/// A message drawn within this fraction of the thread's right edge, and not starting at its left, is the
/// user's own. Chat apps leave a wide gutter on the other side, so the test does not need to be delicate.
static const CGFloat kOutgoingEdgeFraction = 0.12;
static const CGFloat kOutgoingMinGutter = 40;
/// A message row is a handful of nodes; this only has to be bigger than that.
static const NSUInteger kBubbleSearchNodes = 40;

#pragma mark - SBMessage

@interface SBMessage ()
@property (nonatomic, readwrite, copy) NSString *from;
@property (nonatomic, readwrite, copy) NSString *text;
@property (nonatomic, readwrite) BOOL fromMe;
@end

@implementation SBMessage

+ (instancetype)messageFrom:(NSString *)from text:(NSString *)text fromMe:(BOOL)fromMe {
    SBMessage *message = [[self alloc] init];
    message.from = from ?: @"";
    message.text = text ?: @"";
    message.fromMe = fromMe;
    return message;
}

- (NSString *)description {
    // Lengths only: a conversation never reaches a log.
    return [NSString stringWithFormat:@"<SBMessage from=%lu chars=%lu mine=%d>", (unsigned long)self.from.length,
            (unsigned long)self.text.length, self.fromMe];
}

@end

#pragma mark - SBConversation

@interface SBConversation ()
@property (nonatomic, readwrite, copy) NSArray<SBMessage *> *messages;
@property (nonatomic, readwrite, copy) NSString *correspondent;
@property (nonatomic, readwrite) NSUInteger visitedNodes;
@property (nonatomic, readwrite) BOOL truncated;
@end

/// "3:07 PM", "15:07", "9:41 a.m.". A trailing time is what tells a message apart from ordinary prose that
/// happens to contain commas: every app that follows the convention stamps one on.
static BOOL SBLooksLikeATime(NSString *text) {
    static NSRegularExpression *regex;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        regex = [NSRegularExpression regularExpressionWithPattern:@"^\\s*\\d{1,2}[:.]\\d{2}(\\s*[ap]\\.?\\s*m\\.?)?\\s*$"
                                                          options:NSRegularExpressionCaseInsensitive error:NULL];
    });
    if (text.length == 0) return NO;
    return [regex firstMatchInString:text options:0 range:NSMakeRange(0, text.length)] != nil;
}

@implementation SBConversation

+ (instancetype)conversationFromNode:(id<SBAXNode>)root {
    return [self conversationFromNode:root maxNodes:SBConversationMaxNodes];
}

+ (instancetype)conversationFromNode:(id<SBAXNode>)root maxNodes:(NSUInteger)maxNodes {
    return [self conversationFromNode:root maxNodes:maxNodes column:CGRectNull];
}

/// A frame shares a column with `column` when they overlap horizontally at all. Generous on purpose: a bubble
/// is narrower than the compose box and sits anywhere across the thread, while another COLUMN shares no x at all.
+ (BOOL)frame:(CGRect)frame sharesColumnWith:(CGRect)column {
    if (CGRectIsNull(column) || CGRectIsEmpty(column)) return YES;
    if (CGRectIsEmpty(frame)) return YES;   // no box to judge by: keep it rather than lose a real message
    return CGRectGetMinX(frame) < CGRectGetMaxX(column) && CGRectGetMaxX(frame) > CGRectGetMinX(column);
}

+ (instancetype)conversationFromNode:(id<SBAXNode>)root maxNodes:(NSUInteger)maxNodes column:(CGRect)column {
    SBConversation *conversation = [[self alloc] init];
    conversation.messages = @[];
    conversation.correspondent = @"";
    if (!root) return conversation;

    SBAXWalkBudget budget = SBAXWalkBudgetMake(maxNodes, SBConversationMaxSeconds);
    NSMutableArray<SBMessage *> *found = [NSMutableArray array];
    NSMutableArray<NSValue *> *frames = [NSMutableArray array];
    NSMutableArray<NSString *> *rawDescriptions = [NSMutableArray array];
    [self collect:root budget:&budget into:found frames:frames raw:rawDescriptions column:column];
    conversation.visitedNodes = maxNodes - budget.nodes;
    conversation.truncated = budget.exhausted || budget.hung;
    if (found.count == 0) return conversation;

    // The thread is the box the messages live in: the union of them all. Their own edges are then read
    // against it, which is how "left is theirs, right is yours" works without knowing the window layout.
    CGRect thread = CGRectNull;
    for (NSValue *value in frames) {
        CGRect frame = value.rectValue;
        if (CGRectIsEmpty(frame)) continue;
        thread = CGRectIsNull(thread) ? frame : CGRectUnion(thread, frame);
    }
    for (NSUInteger i = 0; i < found.count; i++) {
        found[i].fromMe = [self frameLooksOutgoing:frames[i].rectValue inThread:thread];
    }

    NSArray<SBMessage *> *kept = [self lastMessages:found];
    conversation.messages = kept;
    for (SBMessage *message in kept.reverseObjectEnumerator) {
        if (message.fromMe || message.from.length == 0) continue;
        conversation.correspondent = message.from;
        break;
    }
    return conversation;
}

/// The tail that fits, oldest first. Long threads are cut from the front: the last thing said matters most.
+ (NSArray<SBMessage *> *)lastMessages:(NSArray<SBMessage *> *)all {
    NSMutableArray<SBMessage *> *kept = [NSMutableArray array];
    NSUInteger total = 0;
    for (SBMessage *message in all.reverseObjectEnumerator) {
        if (kept.count >= SBConversationMaxMessages) break;
        if (total + message.text.length > SBConversationMaxTotalChars && kept.count > 0) break;
        total += message.text.length;
        [kept insertObject:message atIndex:0];
    }
    return kept;
}

/// Breadth-first, bounded. A group that IS a message is not descended into: the same words are repeated on
/// the group inside it, and taking both would double every line of the thread.
+ (void)collect:(id<SBAXNode>)node
         budget:(SBAXWalkBudget *)budget
           into:(NSMutableArray<SBMessage *> *)found
         frames:(NSMutableArray<NSValue *> *)frames
            raw:(NSMutableArray<NSString *> *)raw
         column:(CGRect)column {
    NSMutableArray<id<SBAXNode>> *queue = [NSMutableArray arrayWithObject:node];
    NSUInteger head = 0;
    while (head < queue.count) {
        id<SBAXNode> current = queue[head++];
        if (!SBAXWalkBudgetSpend(budget, current)) return;
        SBMessage *message = [self messageFromDescription:current.axDescription];
        if (message) {
            // macOS repeats a message's description on the group inside it. The outer one is seen first, so
            // an identical description in a row is the same message being reported twice.
            NSString *key = [SBPageContext normalizedText:current.axDescription];
            CGRect bubble = [self bubbleFrameOf:current];
            // Another column's "message" is another conversation's last line. Skipped, and NOT descended into:
            // whatever is inside a sidebar row is still the sidebar.
            if (![self frame:bubble sharesColumnWith:column]) continue;
            if (raw.count == 0 || ![raw.lastObject isEqualToString:key]) {
                [raw addObject:key];
                [found addObject:message];
                [frames addObject:[NSValue valueWithRect:bubble]];
            }
            continue;   // never descend into a message
        }
        for (id<SBAXNode> child in current.children) [queue addObject:child];
    }
}

/**
 * Where the message is actually DRAWN, which is not where its row is.
 *
 * A message row spans the whole width of the thread -- measured on a live window, every one of them was
 * 1470 points wide in a 1470 point window -- and only the bubble inside it sits on one side or the other.
 * Read the row's box and every message looks like it belongs to nobody; read the bubble's and the thread
 * falls into two columns immediately.
 *
 * The bubble is the text area (or areas) inside the row. With none, the narrowest box below the row is the
 * next best thing, and the row's own box is the last resort.
 */
+ (CGRect)bubbleFrameOf:(id<SBAXNode>)row {
    CGRect bubbles = CGRectNull;
    CGRect narrowest = CGRectNull;
    NSMutableArray<id<SBAXNode>> *queue = [NSMutableArray arrayWithObject:row];
    NSUInteger head = 0, visited = 0;
    while (head < queue.count && visited < kBubbleSearchNodes) {
        id<SBAXNode> node = queue[head++];
        visited++;
        CGRect frame = node.frame;
        if (!CGRectIsEmpty(frame) && node != row) {
            if ([node.role isEqualToString:@"AXTextArea"] || [node.role isEqualToString:@"AXStaticText"]) {
                bubbles = CGRectIsNull(bubbles) ? frame : CGRectUnion(bubbles, frame);
            }
            if (CGRectIsNull(narrowest) || CGRectGetWidth(frame) < CGRectGetWidth(narrowest)) narrowest = frame;
        }
        for (id<SBAXNode> child in node.children) [queue addObject:child];
    }
    if (!CGRectIsNull(bubbles)) return bubbles;
    if (!CGRectIsNull(narrowest)) return narrowest;
    return row.frame;
}

+ (SBMessage *)messageFromDescription:(NSString *)description {
    NSString *text = [SBPageContext normalizedText:description];
    if (text.length == 0) return nil;
    NSArray<NSString *> *parts = [text componentsSeparatedByString:@","];
    if (parts.count < 3) return nil;
    if (!SBLooksLikeATime(parts.lastObject)) return nil;   // no timestamp, not a message

    NSString *from = [parts.firstObject stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    // Everything between the name and the time is the message, commas and all.
    NSRange body = NSMakeRange(1, parts.count - 2);
    NSString *said = [[parts subarrayWithRange:body] componentsJoinedByString:@","];
    said = [SBPageContext normalizedText:said];
    if (said.length == 0) return nil;

    if (from.length > kMaxNameChars) from = [SBPageContext text:from cappedAt:kMaxNameChars];
    if (said.length > SBConversationMaxMessageChars) said = [SBPageContext text:said cappedAt:SBConversationMaxMessageChars];
    return [SBMessage messageFrom:from text:said fromMe:NO];
}

+ (BOOL)frameLooksOutgoing:(CGRect)frame inThread:(CGRect)thread {
    if (CGRectIsEmpty(frame) || CGRectIsEmpty(thread) || CGRectIsNull(thread)) return NO;
    CGFloat width = CGRectGetWidth(thread);
    if (width <= 0) return NO;
    CGFloat slack = MAX(kOutgoingMinGutter, width * kOutgoingEdgeFraction);
    BOOL hugsRight = CGRectGetMaxX(thread) - CGRectGetMaxX(frame) <= slack;
    BOOL leavesLeft = CGRectGetMinX(frame) - CGRectGetMinX(thread) > slack;
    return hugsRight && leavesLeft;
}

- (NSDictionary<NSString *, id> *)dictionary {
    if (self.messages.count == 0) return nil;
    NSMutableArray<NSDictionary *> *wire = [NSMutableArray arrayWithCapacity:self.messages.count];
    for (SBMessage *message in self.messages) {
        NSMutableDictionary *entry = [NSMutableDictionary dictionary];
        entry[@"text"] = message.text;
        entry[@"fromMe"] = @(message.fromMe);
        if (message.from.length) entry[@"from"] = message.from;
        [wire addObject:entry];
    }
    NSMutableDictionary<NSString *, id> *json = [NSMutableDictionary dictionary];
    json[@"messages"] = wire;
    if (self.correspondent.length) json[@"correspondent"] = self.correspondent;
    return json;
}

- (NSString *)description {
    return [NSString stringWithFormat:@"<SBConversation %lu messages, %lu nodes%@>", (unsigned long)self.messages.count,
            (unsigned long)self.visitedNodes, self.truncated ? @", truncated" : @""];
}

@end
