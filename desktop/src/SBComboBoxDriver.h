// SBComboBoxDriver: choose one option of a web combobox (react-select, location and other type-ahead controls)
// without the mouse (docs/desktop-realworld.md, "Real combobox target contract").
//
//   1. refuse at once, touching nothing: not a combobox, EEO/demographic question, sensitive, disabled, already
//      showing a value, empty answer
//   2. focus the combobox (AXFocused) and check that focus really is there
//   3a. AXPress the combobox: react-select opens its menu on a press, and then nothing has to be typed at all.
//       Only a control that does not answer a press (a type-ahead/location field) goes on to
//   3. type the intended answer through SBKeyPoster, only while the focused element IS the combobox
//   4. wait up to 1.5 s for a list of options near it (AXList / AXMenu / role description "list box", "listbox",
//      "menu"; options AXMenuItem, role description "option", else AXStaticText; notices like "No options" are not
//      options)
//   5. pick with the injected matcher (native port of shared matchOption); below 0.7 there is no pick
//   6. AXPress the option; if that did nothing, arrow keys to it and Return, only while the list is open and that
//      very option is highlighted (the guard re-reads both right before the Return). A press that CLOSED the list
//      without choosing anything (react-select answers a real mouse press on its row, not a synthesized one) opens
//      the menu once more and takes that same keyboard path -- once, and only while the control still shows nothing.
//   7. verify: the list closed and the combobox shows the chosen text (looked for up to `verifyAttempts` times)
//   otherwise: one Escape (only while the combobox has focus), backspace away what was typed (only while it still
//   has focus and still holds text), and report SKIPPED so the walk leaves the field alone.
//
// Outcomes: Chosen (verified), Skipped (the field is left as it was: skip it and go on), Failed (something may have
// changed that could not be verified, or the user took over: stop the walk).
// The answer and the option texts are never logged: only the field label (SBLogLabel), counts, scores and codes.
#import <Foundation/Foundation.h>
#import "SBAXNode.h"
#import "SBKeyPoster.h"
#import "SBWriter.h"

NS_ASSUME_NONNULL_BEGIN

extern const double SBComboBoxMatchThreshold;   // 0.7
/// Wall clock for one search for a combobox's option list (it runs in every poll and key guard). A search that runs
/// out, or meets a hung app, finds no list.
extern const NSTimeInterval SBComboBoxListSearchSeconds;   // 0.2

typedef struct {
    NSInteger index;   // into the option texts; -1 = no match
    double score;
} SBOptionMatch;

typedef SBOptionMatch (^SBOptionMatcher)(NSArray<NSString *> *options, NSString *answer);

/// Native port of shared/src/resolve.ts matchOption over option labels: exact 1, yes/no by first word 0.95, whole
/// words contained 0.88, keyword overlap 0.6 + 0.25 * overlap; placeholders are never options; nothing under 0.7;
/// a tie under 1 is no answer. Keep in step with the TypeScript (tests/test_combobox.m pins the cases).
SBOptionMatch SBMatchOption(NSArray<NSString *> *options, NSString *answer);

/// Native port of `isDeclineOption` (shared/src/answers/classify.ts): the option that means "I am not
/// answering this", in any ATS's wording ("Decline To Self Identify", "I don't wish to answer", "I do not want
/// to answer", "Prefer not to say"). The first one wins, with score 1; -1 when the list offers no way to
/// decline. `answer` is ignored: declining is the same answer however it is spelled.
/// Keep in step with the TypeScript (tests/test_combobox.m pins the wordings).
SBOptionMatch SBMatchDeclineOption(NSArray<NSString *> *options, NSString *answer);

/// Native port of `neutralOption` (shared/src/answers/propose.ts): the option that commits the applicant to the
/// least -- "Other" first, then "None of the above", "N/A", a decline, "No preference" -- ignoring options that
/// state something legal ("I certify..."). Score 1 when there is one; -1 when every option is a claim about the
/// applicant. `answer` is ignored. Keep in step with the TypeScript (tests/test_combobox.m pins the ranking).
SBOptionMatch SBMatchNeutralOption(NSArray<NSString *> *options, NSString *answer);

typedef NS_ENUM(NSInteger, SBComboBoxOutcome) {
    SBComboBoxOutcomeChosen = 1,
    SBComboBoxOutcomeSkipped,
    SBComboBoxOutcomeFailed,
};

// Skipped: nothing is left behind.
extern NSString *const SBComboBoxReasonUnsupported;
extern NSString *const SBComboBoxReasonGone;
extern NSString *const SBComboBoxReasonDemographic;
extern NSString *const SBComboBoxReasonSensitive;
extern NSString *const SBComboBoxReasonDisabled;
extern NSString *const SBComboBoxReasonHasValue;
extern NSString *const SBComboBoxReasonNoFrontmostApp;
extern NSString *const SBComboBoxReasonNotFocused;
extern NSString *const SBComboBoxReasonFocusChanged;      // before anything was typed
extern NSString *const SBComboBoxReasonNoList;
extern NSString *const SBComboBoxReasonNoMatchingOption;
extern NSString *const SBComboBoxReasonOptionVanished;
extern NSString *const SBComboBoxReasonNoHighlight;
// Failed: stop the walk.
extern NSString *const SBComboBoxReasonBusy;
extern NSString *const SBComboBoxReasonTypingInterrupted;
extern NSString *const SBComboBoxReasonNotVerified;
extern NSString *const SBComboBoxReasonListClosed;
extern NSString *const SBComboBoxReasonKeysRefused;
extern NSString *const SBComboBoxReasonAppChanged;
extern NSString *const SBComboBoxReasonUserKey;
extern NSString *const SBComboBoxReasonCancelled;

extern NSString *const SBComboBoxMethodNone;
extern NSString *const SBComboBoxMethodPress;
extern NSString *const SBComboBoxMethodKeys;

@interface SBComboBoxResult : NSObject
@property (nonatomic, readonly) SBComboBoxOutcome outcome;
@property (nonatomic, readonly, copy, nullable) NSString *reason;
@property (nonatomic, readonly, copy) NSString *method;
@property (nonatomic, readonly) double score;
@property (nonatomic, readonly) NSUInteger optionCount;
@property (nonatomic, readonly) BOOL typed;
@property (nonatomic, readonly) BOOL pressedEscape;
/// What was typed is gone again (the list's own Escape handling or our backspaces).
@property (nonatomic, readonly) BOOL clearedTyping;
/// The answer was not among the options and the list's own neutral choice ("Other") was taken instead: a guess,
/// and the walk shows it as one.
@property (nonatomic, readonly) BOOL tookNeutral;
@property (nonatomic, readonly) NSTimeInterval elapsed;
@property (nonatomic, readonly) BOOL chosen;
/// The walk should skip this field and go on.
@property (nonatomic, readonly) BOOL skipsField;
/// The walk should stop here.
@property (nonatomic, readonly) BOOL stopsWalk;
@end

@interface SBComboBoxDriver : NSObject

- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithActuator:(id<SBAXActuating>)actuator poster:(id<SBKeyPosting>)poster state:(id<SBDesktopState>)state NS_DESIGNATED_INITIALIZER;

@property (nonatomic, readonly) id<SBAXActuating> actuator;
@property (nonatomic, readonly) id<SBKeyPosting> poster;
@property (nonatomic, readonly) id<SBDesktopState> state;

/// Default SBMatchOption.
@property (nonatomic, copy, null_resettable) SBOptionMatcher matcher;
/// Used instead of `matcher` when a run asks to decline. Default SBMatchDeclineOption.
@property (nonatomic, copy, null_resettable) SBOptionMatcher declineMatcher;
/// Used when a run asks for a neutral fallback and `matcher` found nothing. Default SBMatchNeutralOption.
@property (nonatomic, copy, null_resettable) SBOptionMatcher neutralMatcher;
@property (nonatomic) double threshold;                  // SBComboBoxMatchThreshold
/// Same contract as SBWriter.isNodeSensitive: with no block set every combobox counts as sensitive (fail closed).
@property (nonatomic, copy, nullable) BOOL (^isNodeSensitive)(id<SBAXNode> node);
/// Is this option highlighted now? Default: AXFocused, or AXSelected of a live element.
@property (nonatomic, copy, null_resettable) BOOL (^isHighlighted)(id<SBAXNode> option);
@property (nonatomic, copy) void (^after)(NSTimeInterval delay, dispatch_block_t block);
@property (nonatomic, copy) NSTimeInterval (^clock)(void);
@property (nonatomic) NSTimeInterval pollInterval;       // 0.1
@property (nonatomic) NSTimeInterval focusSettleDelay;   // 0.05
@property (nonatomic) NSTimeInterval listTimeout;        // 1.5
@property (nonatomic) NSTimeInterval openTimeout;        // 0.7: how long a press gets to open a menu before typing
@property (nonatomic) NSTimeInterval verifyDelay;        // 0.15
/// How many times a verification looks before it gives up, `verifyDelay` apart. A page updates its accessibility
/// tree after it updates itself, so one look is a race (the same lesson the upload check learned). Default 6.
@property (nonatomic) NSUInteger verifyAttempts;         // 6
@property (nonatomic) NSTimeInterval keyStepDelay;       // 0.06
@property (nonatomic, readonly) BOOL running;

/// `completion` runs exactly once (inline for refusals, else on the queue `after` uses).
- (void)chooseAnswer:(NSString *)answer inComboBox:(id<SBAXNode>)comboBox completion:(void (^)(SBComboBoxResult *result))completion;
/// With `decline` YES the run picks whichever option MEANS "prefer not to answer" (`declineMatcher`) instead of
/// matching `answer` literally, and a demographic combo box is no longer refused: declining is the one answer
/// Shabang may give to an EEO question, because it claims nothing about anybody (docs/answers.md section 1).
/// Everything else -- sensitivity, disabled, already answered, verification -- is unchanged.
- (void)chooseAnswer:(NSString *)answer
          inComboBox:(id<SBAXNode>)comboBox
             decline:(BOOL)decline
          completion:(void (^)(SBComboBoxResult *result))completion;
/// With `neutralFallback` YES an answer the list does not offer falls back to whatever the list itself calls the
/// neutral choice ("Other", "None of the above", "N/A"), which is what docs/answers.md section 3 asks of an
/// ORDINARY question whose profile fact is not among the options -- "Hack the North" on a list of eight sources.
/// It is never combined with `decline`, and never used for a declaration (a Yes/No question has no neutral side).
- (void)chooseAnswer:(NSString *)answer
          inComboBox:(id<SBAXNode>)comboBox
             decline:(BOOL)decline
     neutralFallback:(BOOL)neutralFallback
          completion:(void (^)(SBComboBoxResult *result))completion;
/// The event tap calls this for every UNTAGGED keyDown while a run is going. Any thread.
- (void)noteUserKeyEvent;
- (void)cancel;

// ---------- pure, exposed for tests ----------
/// Shared DEMOGRAPHIC rule of shared/src/heuristic.ts plus date of birth and age.
+ (BOOL)isDemographicText:(nullable NSString *)text;
/// Title, description, placeholder, help, identifier and the title element of `node`.
+ (BOOL)isDemographicComboBox:(id<SBAXNode>)node;
+ (BOOL)isComboBox:(nullable id<SBAXNode>)node;
/// The option list that belongs to `comboBox`: inside it, else among the few siblings that follow it before the
/// next control (up to 4 levels up), else a portal at the end of the web area. Content lists never count.
+ (nullable id<SBAXNode>)listForComboBox:(id<SBAXNode>)comboBox;
+ (NSArray<id<SBAXNode>> *)optionsInList:(id<SBAXNode>)list;
/// An open list that says "No options" / "No results found": the page's answer that nothing matches what was typed.
+ (BOOL)listSaysNothingFound:(nullable id<SBAXNode>)list;
+ (NSString *)textOfOption:(id<SBAXNode>)option;
/// What the combobox displays as its choice: its own value (unless that is just `typed`) and the texts right before
/// it (react-select's single value), stopping at its label or the previous control. Placeholders and live regions
/// are left out.
+ (NSArray<NSString *> *)shownTextsForComboBox:(id<SBAXNode>)comboBox typed:(nullable NSString *)typed;

@end

NS_ASSUME_NONNULL_END
