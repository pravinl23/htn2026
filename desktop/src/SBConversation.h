// SBConversation: reading a thread of messages off the screen, so the reply can be drafted.
//
// The sibling of SBPageContext. That one reads what a job posting is about; this one reads what the last few
// messages said, so `/v1/shabang-text` can draft an answer to them.
//
// It is NOT written against one app. The pattern it keys on is the one macOS asks every messaging app to
// publish, and which Messages, Mail and several others do: each message is a group whose accessible
// description reads
//
//     "<who>, <what they said>, <when>"
//
// Verified against a live Messages window: 21 of them, with the text on the group and nothing at all on the
// bubble inside it. An app that names its messages some other way simply yields no conversation, and Shabang
// falls back to behaving as it does anywhere else.
//
// Who sent what comes from geometry, which every chat app in existence agrees on: their messages sit against
// the left edge of the thread, yours against the right. The name in the description is kept as well, so a
// group chat still reads correctly.
//
// Nothing here is sent anywhere by itself. The controller decides whether a draft is wanted at all, and the
// sensitivity rules that guard every other draft guard this one too.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import "SBAXNode.h"

NS_ASSUME_NONNULL_BEGIN

/// The most recent messages kept. More than this and the draft stops being about the last thing said.
extern const NSUInteger SBConversationMaxMessages;      // 14
/// Per message, and for the whole thread. A wall of text makes a worse draft, not a better one.
extern const NSUInteger SBConversationMaxMessageChars;  // 400
extern const NSUInteger SBConversationMaxTotalChars;    // 2000
extern const NSUInteger SBConversationMaxNodes;         // 4000
extern const NSTimeInterval SBConversationMaxSeconds;   // 0.20

@interface SBMessage : NSObject
/// Who said it, as the app itself names them. "" when the app gave no name.
@property (nonatomic, readonly, copy) NSString *from;
@property (nonatomic, readonly, copy) NSString *text;
/// The message sits against the right edge of the thread, which every chat app means as "you said this".
@property (nonatomic, readonly) BOOL fromMe;
+ (instancetype)messageFrom:(NSString *)from text:(NSString *)text fromMe:(BOOL)fromMe;
@end

@interface SBConversation : NSObject

/// Oldest first, so the last one is the message a reply would answer. Empty when this is not a thread.
@property (nonatomic, readonly, copy) NSArray<SBMessage *> *messages;
/// The other side's name, taken from the most recent message that is not the user's own. "" when unknown.
@property (nonatomic, readonly, copy) NSString *correspondent;
@property (nonatomic, readonly) NSUInteger visitedNodes;
@property (nonatomic, readonly) BOOL truncated;

/// Walks `root` (a window) for messages. Never reads the value of a text box: only accessible descriptions,
/// which is where the apps that follow the convention put the words.
+ (instancetype)conversationFromNode:(id<SBAXNode>)root;
+ (instancetype)conversationFromNode:(id<SBAXNode>)root maxNodes:(NSUInteger)maxNodes;
/**
 * The thread in ONE column of the window, which is the only way to read a chat app that shows a list of
 * conversations beside the open one.
 *
 * A sidebar row publishes the same "<who>, <what>, <when>" description a message does -- it IS a message,
 * the last one of some other conversation -- so a walk from the window root finds the sidebar first and
 * fills the thread with seven other people's previews. Measured in Messages: 8 "messages", 7 of which were
 * sidebar rows, which is why every draft came out the same whatever conversation was open.
 *
 * `column` is the compose box's frame. Every chat app in existence puts its compose box under the thread and
 * beside nothing else, so a message that shares no x with it belongs to some other column. CGRectNull reads
 * the whole window, as before.
 */
+ (instancetype)conversationFromNode:(id<SBAXNode>)root maxNodes:(NSUInteger)maxNodes column:(CGRect)column;
- (instancetype)init NS_UNAVAILABLE;

/// `{ messages: [{ from, text, fromMe }], correspondent }` for `/v1/shabang-text`. nil when there is no thread.
- (nullable NSDictionary<NSString *, id> *)dictionary;

// ---------- pure, exposed for tests ----------
/// Splits "<who>, <what>, <when>" into its first two parts. nil when the text is not that shape: the last
/// part has to read as a time, which is what keeps ordinary prose from being mistaken for a message.
+ (nullable SBMessage *)messageFromDescription:(nullable NSString *)description;
/// YES when `frame` sits against the right-hand side of `thread`, the way every chat app draws your own
/// messages. Needs both boxes; a message that fills the width is nobody's in particular.
+ (BOOL)frameLooksOutgoing:(CGRect)frame inThread:(CGRect)thread;

@end

NS_ASSUME_NONNULL_END
