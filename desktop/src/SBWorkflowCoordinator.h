// SBWorkflowCoordinator: the narrow workflow interface beside (not inside) the existing Tab walk.
//
// The controller/event-tap teammate can ask for a prediction, render currentSuggestion through the existing
// overlay, approve it with the confirmation the UI actually collected, execute it, and report a verified local
// result. This module never installs a key listener, draws UI, or writes through Accessibility.
//
// Context is compact AX metadata. Secure/sensitive fields are omitted by SBCapture and checked again here.
#import <Foundation/Foundation.h>
#import "SBField.h"

NS_ASSUME_NONNULL_BEGIN

@interface SBWorkflowSuggestion : NSObject
@property (nonatomic, readonly, copy) NSString *workflowIdentifier;
@property (nonatomic, readonly, copy) NSString *actionIdentifier;
@property (nonatomic, readonly, copy) NSString *title;
@property (nonatomic, readonly, copy) NSString *preview;
@property (nonatomic, readonly, copy) NSString *safety;       // read | reversible | high-impact
@property (nonatomic, readonly, copy) NSString *confirmation; // tab | review | explicit
@property (nonatomic, readonly) double confidence;
@property (nonatomic, readonly) BOOL simulated;
@end

@interface SBWorkflowContextBuilder : NSObject

/// Builds exactly the value allowlist accepted by /v1/workflows/predict. Unknown/native objects never cross the wire.
/// Never on the wire: the window title (ignored), the focused field's value (only `hasValue`), a secure, sensitive or
/// EEO / demographic field (no `focusedElement` at all), nearby lines with contact data or sensitive / EEO words.
/// `nearbyText` must be page static text outside form controls: the caller never passes what the user typed.
+ (NSDictionary<NSString *, id> *)snapshotWithApplicationName:(NSString *)applicationName
                                              bundleIdentifier:(NSString *)bundleIdentifier
                                                   windowTitle:(nullable NSString *)windowTitle
                                                  focusedField:(nullable SBField *)focusedField
                                                    nearbyText:(nullable NSArray<NSString *> *)nearbyText
                                             safeValueToInsert:(nullable NSString *)safeValueToInsert
                                             connectedToolkits:(nullable NSArray<NSString *> *)connectedToolkits
                                                     workflow:(nullable NSDictionary<NSString *, id> *)workflow;

@end

typedef void (^SBWorkflowCompletion)(id _Nullable value, NSString *_Nullable errorCode);

@interface SBWorkflowCoordinator : NSObject

- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithBaseURLString:(nullable NSString *)baseURLString
                                userId:(NSString *)userId
                         configuration:(nullable NSURLSessionConfiguration *)configuration NS_DESIGNATED_INITIALIZER;

@property (nonatomic, copy, nullable) NSString *baseURLString;
/// Per-install secret matching server `SHABANG_EXECUTE_TOKEN`. Never serialized into a body or logged.
@property (nonatomic, copy, nullable) NSString *executeToken;
@property (nonatomic, readonly, copy) NSString *userId;
@property (nonatomic, readonly, nullable) SBWorkflowSuggestion *currentSuggestion;
@property (nonatomic, readonly, copy, nullable) NSDictionary<NSString *, id> *workflowState;
@property (nonatomic, readonly) BOOL busy;

/// Warm Composio account/tool metadata after a relevant focus change. Prediction itself never calls Composio.
- (void)prefetchComposioForContext:(NSDictionary<NSString *, id> *)context
                        completion:(SBWorkflowCompletion)completion;

/// `demo` is side-effect-free and explicit. The production native path always passes NO.
- (void)requestPredictionForContext:(NSDictionary<NSString *, id> *)context
                               demo:(BOOL)demo
                         completion:(SBWorkflowCompletion)completion;

/// Rejecting is local evaluation feedback for now; it clears the suggestion and never executes anything.
- (void)rejectSuggestion;

/// The caller passes what the UI actually collected: tab, review, or explicit. A weaker mode is refused by the server.
- (void)approveSuggestionWithConfirmation:(NSString *)confirmation completion:(SBWorkflowCompletion)completion;

/// Runs only after approveSuggestion succeeded. A local action returns an instruction; SBWriter performs and verifies it.
- (void)executeApprovedActionWithCompletion:(SBWorkflowCompletion)completion;

/// Feed SBWriter's verified outcome back so the next prediction can use it.
- (void)completeLocalActionWithToken:(NSString *)completionToken
                                  ok:(BOOL)ok
                           errorCode:(nullable NSString *)errorCode
                          completion:(SBWorkflowCompletion)completion;

- (void)cancelAll;

@end

NS_ASSUME_NONNULL_END
