// GHWorkflowCoordinator: the narrow workflow interface beside (not inside) the existing Tab walk.
//
// The controller/event-tap teammate can ask for a prediction, render currentSuggestion through the existing
// overlay, approve it with the confirmation the UI actually collected, execute it, and report a verified local
// result. This module never installs a key listener, draws UI, or writes through Accessibility.
//
// Context is compact AX metadata. Secure/sensitive fields are omitted by GHCapture and checked again here.
#import <Foundation/Foundation.h>
#import "GHField.h"

NS_ASSUME_NONNULL_BEGIN

@interface GHWorkflowSuggestion : NSObject
@property (nonatomic, readonly, copy) NSString *workflowIdentifier;
@property (nonatomic, readonly, copy) NSString *actionIdentifier;
@property (nonatomic, readonly, copy) NSString *title;
@property (nonatomic, readonly, copy) NSString *preview;
@property (nonatomic, readonly, copy) NSString *safety;       // read | reversible | high-impact
@property (nonatomic, readonly, copy) NSString *confirmation; // tab | review | explicit
@property (nonatomic, readonly) double confidence;
@property (nonatomic, readonly) BOOL simulated;
@end

@interface GHWorkflowContextBuilder : NSObject

/// Builds exactly the value allowlist accepted by /v1/workflows/predict. Unknown/native objects never cross the wire.
+ (NSDictionary<NSString *, id> *)snapshotWithApplicationName:(NSString *)applicationName
                                              bundleIdentifier:(NSString *)bundleIdentifier
                                                   windowTitle:(nullable NSString *)windowTitle
                                                  focusedField:(nullable GHField *)focusedField
                                                    nearbyText:(nullable NSArray<NSString *> *)nearbyText
                                             safeValueToInsert:(nullable NSString *)safeValueToInsert
                                             connectedToolkits:(nullable NSArray<NSString *> *)connectedToolkits
                                                     workflow:(nullable NSDictionary<NSString *, id> *)workflow;

@end

typedef void (^GHWorkflowCompletion)(id _Nullable value, NSString *_Nullable errorCode);

@interface GHWorkflowCoordinator : NSObject

- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithBaseURLString:(nullable NSString *)baseURLString
                                userId:(NSString *)userId
                         configuration:(nullable NSURLSessionConfiguration *)configuration NS_DESIGNATED_INITIALIZER;

@property (nonatomic, copy, nullable) NSString *baseURLString;
/// Per-install secret matching server `GHOST_EXECUTE_TOKEN`. Never serialized into a body or logged.
@property (nonatomic, copy, nullable) NSString *executeToken;
@property (nonatomic, readonly, copy) NSString *userId;
@property (nonatomic, readonly, nullable) GHWorkflowSuggestion *currentSuggestion;
@property (nonatomic, readonly, copy, nullable) NSDictionary<NSString *, id> *workflowState;
@property (nonatomic, readonly) BOOL busy;

/// `demo` is side-effect-free and explicit. The production native path always passes NO.
- (void)requestPredictionForContext:(NSDictionary<NSString *, id> *)context
                               demo:(BOOL)demo
                         completion:(GHWorkflowCompletion)completion;

/// Rejecting is local evaluation feedback for now; it clears the suggestion and never executes anything.
- (void)rejectSuggestion;

/// The caller passes what the UI actually collected: tab, review, or explicit. A weaker mode is refused by the server.
- (void)approveSuggestionWithConfirmation:(NSString *)confirmation completion:(GHWorkflowCompletion)completion;

/// Runs only after approveSuggestion succeeded. A local action returns an instruction; GHWriter performs and verifies it.
- (void)executeApprovedActionWithCompletion:(GHWorkflowCompletion)completion;

/// Feed GHWriter's verified outcome back so the next prediction can use it.
- (void)completeLocalActionWithToken:(NSString *)completionToken
                                  ok:(BOOL)ok
                           errorCode:(nullable NSString *)errorCode
                          completion:(GHWorkflowCompletion)completion;

- (void)cancelAll;

@end

NS_ASSUME_NONNULL_END
