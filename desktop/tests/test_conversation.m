// GHConversation: reading a thread off the screen, against a tree shaped like a real Messages window.
//
// The shape here is taken from a live `ghostctl dump-tree` of Messages: each message is an AXGroup whose
// AXDescription reads "<who>, <what they said>, <when>", repeated once more on the group inside it, with the
// bubble itself carrying no text at all. The words below are invented; only the shape is real.
#import "GHTest.h"
#import "GHConversation.h"

static GHFakeAXNode *CVNode(NSString *role, CGRect frame) {
    GHFakeAXNode *node = [GHFakeAXNode nodeWithRole:role];
    node.frame = frame;
    return node;
}

/// One message, exactly as macOS publishes it: the description on the row AND on the group inside it, and an
/// empty AXTextArea at the bottom. `x` decides who sent it, which is how every chat app draws a thread.
static void CVAddMessage(GHFakeAXNode *thread, NSString *described, CGFloat x, CGFloat y, CGFloat width) {
    GHFakeAXNode *row = [thread addChild:CVNode(@"AXGroup", CGRectMake(x, y, width, 33))];
    row.axDescription = described;
    GHFakeAXNode *inner = [row addChild:CVNode(@"AXGroup", CGRectMake(x, y, width, 33))];
    inner.axDescription = described;   // macOS says it twice
    [inner addChild:CVNode(@"AXTextArea", CGRectMake(x + 7, y, width - 14, 33))];
}

/// Thread box 356..1444: left-hugging messages are theirs, right-hugging ones are the user's.
static GHFakeAXNode *CVMessagesWindow(void) {
    GHFakeAXNode *window = CVNode(@"AXWindow", CGRectMake(0, 0, 1470, 806));
    GHFakeAXNode *thread = [window addChild:CVNode(@"AXGroup", CGRectMake(1, 33, 1470, 806))];
    CVAddMessage(thread, @"Tahseen Rayhan, are you coming to the thing tonight, 7:04 PM", 356, 100, 300);
    CVAddMessage(thread, @"Alex Chen, yes, 7:05 PM", 1300, 140, 144);
    CVAddMessage(thread, @"Tahseen Rayhan, bring the adapter, and the cable, 7:06 PM", 356, 180, 340);
    return window;
}

GH_TEST(conversation_reads_a_thread_and_knows_who_said_what) {
    GHConversation *conversation = [GHConversation conversationFromNode:CVMessagesWindow()];
    GH_ASSERT_EQUAL_INT(conversation.messages.count, 3);   // three, not six: the repeat is folded away

    GH_ASSERT_EQUAL_OBJECTS(conversation.messages[0].from, @"Tahseen Rayhan");
    GH_ASSERT_EQUAL_OBJECTS(conversation.messages[0].text, @"are you coming to the thing tonight");
    GH_ASSERT_FALSE(conversation.messages[0].fromMe);

    // Hugging the right edge of the thread is what every chat app means by "you said this".
    GH_ASSERT(conversation.messages[1].fromMe);

    // A message with commas in it keeps them: only the name and the time are split off.
    GH_ASSERT_EQUAL_OBJECTS(conversation.messages[2].text, @"bring the adapter, and the cable");
    GH_ASSERT_FALSE(conversation.messages[2].fromMe);

    // Whom a reply would be to: the most recent message that is not the user's own.
    GH_ASSERT_EQUAL_OBJECTS(conversation.correspondent, @"Tahseen Rayhan");
}

GH_TEST(conversation_wire_shape_is_what_the_draft_route_takes) {
    NSDictionary *json = [[GHConversation conversationFromNode:CVMessagesWindow()] dictionary];
    GH_ASSERT(json != nil);
    GH_ASSERT_EQUAL_OBJECTS(json[@"correspondent"], @"Tahseen Rayhan");
    NSArray *messages = json[@"messages"];
    GH_ASSERT_EQUAL_INT(messages.count, 3);
    GH_ASSERT_EQUAL_OBJECTS(messages[0][@"from"], @"Tahseen Rayhan");
    GH_ASSERT_EQUAL_OBJECTS(messages[1][@"fromMe"], @YES);
    GH_ASSERT_EQUAL_OBJECTS(messages[2][@"fromMe"], @NO);
}

GH_TEST(conversation_is_empty_where_there_is_no_thread) {
    // A window of ordinary controls, including prose with commas in it. Nothing here is a message, and the
    // giveaway is that none of it ends in a time.
    GHFakeAXNode *window = CVNode(@"AXWindow", CGRectMake(0, 0, 900, 600));
    GHFakeAXNode *group = [window addChild:CVNode(@"AXGroup", CGRectMake(0, 0, 900, 600))];
    group.axDescription = @"First name, last name, and email";
    [group addChild:CVNode(@"AXTextField", CGRectMake(10, 10, 300, 30))];
    GHConversation *conversation = [GHConversation conversationFromNode:window];
    GH_ASSERT_EQUAL_INT(conversation.messages.count, 0);
    GH_ASSERT(conversation.dictionary == nil);
}

GH_TEST(conversation_description_parsing_needs_a_name_words_and_a_time) {
    GH_ASSERT([GHConversation messageFromDescription:@"Sam, on my way, 9:41 AM"] != nil);
    GH_ASSERT([GHConversation messageFromDescription:@"Sam, on my way, 21:41"] != nil);
    GH_ASSERT([GHConversation messageFromDescription:@"Sam, on my way, 9:41 a.m."] != nil);
    // No time on the end: ordinary prose, a label, a summary. Never a message.
    GH_ASSERT([GHConversation messageFromDescription:@"Sam, on my way, tomorrow"] == nil);
    GH_ASSERT([GHConversation messageFromDescription:@"Search, Messages"] == nil);
    GH_ASSERT([GHConversation messageFromDescription:@"9:41 AM"] == nil);
    GH_ASSERT([GHConversation messageFromDescription:nil] == nil);
    // A name and a time with nothing between them is not a message either.
    GH_ASSERT([GHConversation messageFromDescription:@"Sam, , 9:41 AM"] == nil);
}

GH_TEST(conversation_keeps_only_the_last_messages) {
    GHFakeAXNode *window = CVNode(@"AXWindow", CGRectMake(0, 0, 1470, 806));
    GHFakeAXNode *thread = [window addChild:CVNode(@"AXGroup", CGRectMake(1, 33, 1470, 806))];
    for (NSUInteger i = 0; i < 40; i++) {
        NSString *said = [NSString stringWithFormat:@"Sam, message number %lu, 7:04 PM", (unsigned long)i];
        CVAddMessage(thread, said, 356, (CGFloat)(60 + i * 20), 300);
    }
    GHConversation *conversation = [GHConversation conversationFromNode:window];
    GH_ASSERT(conversation.messages.count <= GHConversationMaxMessages);
    GH_ASSERT(conversation.messages.count > 0);
    // Oldest first, and the LAST thing said is the last one kept: that is what a reply answers.
    GH_ASSERT_EQUAL_OBJECTS(conversation.messages.lastObject.text, @"message number 39");
}

GH_TEST(conversation_outgoing_test_needs_both_edges) {
    CGRect thread = CGRectMake(356, 0, 1088, 800);   // 356 .. 1444
    GH_ASSERT([GHConversation frameLooksOutgoing:CGRectMake(1300, 10, 144, 33) inThread:thread]);
    GH_ASSERT_FALSE([GHConversation frameLooksOutgoing:CGRectMake(356, 10, 300, 33) inThread:thread]);
    // A message that spans the whole thread belongs to nobody in particular.
    GH_ASSERT_FALSE([GHConversation frameLooksOutgoing:thread inThread:thread]);
    GH_ASSERT_FALSE([GHConversation frameLooksOutgoing:CGRectZero inThread:thread]);
    GH_ASSERT_FALSE([GHConversation frameLooksOutgoing:CGRectMake(1300, 10, 144, 33) inThread:CGRectZero]);
}
