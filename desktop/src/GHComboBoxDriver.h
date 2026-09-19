// GHComboBoxDriver: choose one option of a web combobox (react-select, location and other type-ahead controls)
// without the mouse (docs/desktop-realworld.md, "Real combobox target contract").
//
//   1. refuse at once, touching nothing: not a combobox, EEO/demographic question, sensitive, disabled, already
//      showing a value, empty answer
//   2. focus the combobox (AXFocused) and check that focus really is there
//   3. type the intended answer through GHKeyPoster, only while the focused element IS the combobox
//   4. wait up to 1.5 s for a list of options near it (AXList / AXMenu / role description "list box", "listbox",
//      "menu"; options AXMenuItem, role description "option", else AXStaticText; notices like "No options" are not
//      options)
//   5. pick with the injected matcher (native port of shared matchOption); below 0.7 there is no pick
//   6. AXPress the option; if that did nothing, arrow keys to it and Return, only while the list is open and that
//      very option is highlighted (the guard re-reads both right before the Return)
//   7. verify: the list closed and the combobox shows the chosen text
//   otherwise: one Escape (only while the combobox has focus), backspace away what was typed (only while it still
//   has focus and still holds text), and report SKIPPED so the walk leaves the field alone.
//
// Outcomes: Chosen (verified), Skipped (the field is left as it was: skip it and go on), Failed (something may have
// changed that could not be verified, or the user took over: stop the walk).
// The answer and the option texts are never logged: only the field label (GHLogLabel), counts, scores and codes.
#import <Foundation/Foundation.h>
#import "GHAXNode.h"
#import "GHKeyPoster.h"
#import "GHWriter.h"

NS_ASSUME_NONNULL_BEGIN

extern const double GHComboBoxMatchThreshold;   // 0.7
/// Wall clock for one search for a combobox's option list (it runs in every poll and key guard). A search that runs
/// out, or meets a hung app, finds no list.
extern const NSTimeInterval GHComboBoxListSearchSeconds;   // 0.2

typedef struct {
    NSInteger index;   // into the option texts; -1 = no match
    double score;
} GHOptionMatch;

typedef GHOptionMatch (^GHOptionMatcher)(NSArray<NSString *> *options, NSString *answer);

/// Native port of shared/src/resolve.ts matchOption over option labels: exact 1, yes/no by first word 0.95, whole
/// words contained 0.88, keyword overlap 0.6 + 0.25 * overlap; placeholders are never options; nothing under 0.7;
/// a tie under 1 is no answer. Keep in step with the TypeScript (tests/test_combobox.m pins the cases).
GHOptionMatch GHMatchOption(NSArray<NSString *> *options, NSString *answer);

typedef NS_ENUM(NSInteger, GHComboBoxOutcome) {
    GHComboBoxOutcomeChosen = 1,
    GHComboBoxOutcomeSkipped,
    GHComboBoxOutcomeFailed,
};

// Skipped: nothing is left behind.
extern NSString *const GHComboBoxReasonUnsupported;
extern NSString *const GHComboBoxReasonGone;
extern NSString *const GHComboBoxReasonDemographic;
extern NSString *const GHComboBoxReasonSensitive;
extern NSString *const GHComboBoxReasonDisabled;
extern NSString *const GHComboBoxReasonHasValue;
extern NSString *const GHComboBoxReasonNoFrontmostApp;
extern NSString *const GHComboBoxReasonNotFocused;
extern NSString *const GHComboBoxReasonFocusChanged;      // before anything was typed
extern NSString *const GHComboBoxReasonNoList;
extern NSString *const GHComboBoxReasonNoMatchingOption;
extern NSString *const GHComboBoxReasonOptionVanished;
extern NSString *const GHComboBoxReasonNoHighlight;
// Failed: stop the walk.
extern NSString *const GHComboBoxReasonBusy;
extern NSString *const GHComboBoxReasonTypingInterrupted;
extern NSString *const GHComboBoxReasonNotVerified;
extern NSString *const GHComboBoxReasonListClosed;
extern NSString *const GHComboBoxReasonKeysRefused;
extern NSString *const GHComboBoxReasonAppChanged;
extern NSString *const GHComboBoxReasonUserKey;
extern NSString *const GHComboBoxReasonCancelled;

extern NSString *const GHComboBoxMethodNone;
extern NSString *const GHComboBoxMethodPress;
extern NSString *const GHComboBoxMethodKeys;

@interface GHComboBoxResult : NSObject
@property (nonatomic, readonly) GHComboBoxOutcome outcome;
@property (nonatomic, readonly, copy, nullable) NSString *reason;
@property (nonatomic, readonly, copy) NSString *method;
@property (nonatomic, readonly) double score;
@property (nonatomic, readonly) NSUInteger optionCount;
@property (nonatomic, readonly) BOOL typed;
@property (nonatomic, readonly) BOOL pressedEscape;
/// What was typed is gone again (the list's own Escape handling or our backspaces).
@property (nonatomic, readonly) BOOL clearedTyping;
@property (nonatomic, readonly) NSTimeInterval elapsed;
@property (nonatomic, readonly) BOOL chosen;
/// The walk should skip this field and go on.
@property (nonatomic, readonly) BOOL skipsField;
/// The walk should stop here.
@property (nonatomic, readonly) BOOL stopsWalk;
@end

@interface GHComboBoxDriver : NSObject

- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithActuator:(id<GHAXActuating>)actuator poster:(id<GHKeyPosting>)poster state:(id<GHDesktopState>)state NS_DESIGNATED_INITIALIZER;

@property (nonatomic, readonly) id<GHAXActuating> actuator;
@property (nonatomic, readonly) id<GHKeyPosting> poster;
@property (nonatomic, readonly) id<GHDesktopState> state;

/// Default GHMatchOption.
@property (nonatomic, copy, null_resettable) GHOptionMatcher matcher;
@property (nonatomic) double threshold;                  // GHComboBoxMatchThreshold
/// Same contract as GHWriter.isNodeSensitive: with no block set every combobox counts as sensitive (fail closed).
@property (nonatomic, copy, nullable) BOOL (^isNodeSensitive)(id<GHAXNode> node);
/// Is this option highlighted now? Default: AXFocused, or AXSelected of a live element.
@property (nonatomic, copy, null_resettable) BOOL (^isHighlighted)(id<GHAXNode> option);
@property (nonatomic, copy) void (^after)(NSTimeInterval delay, dispatch_block_t block);
@property (nonatomic, copy) NSTimeInterval (^clock)(void);
@property (nonatomic) NSTimeInterval pollInterval;       // 0.1
@property (nonatomic) NSTimeInterval focusSettleDelay;   // 0.05
@property (nonatomic) NSTimeInterval listTimeout;        // 1.5
@property (nonatomic) NSTimeInterval verifyDelay;        // 0.15
@property (nonatomic) NSTimeInterval keyStepDelay;       // 0.06
@property (nonatomic, readonly) BOOL running;

/// `completion` runs exactly once (inline for refusals, else on the queue `after` uses).
- (void)chooseAnswer:(NSString *)answer inComboBox:(id<GHAXNode>)comboBox completion:(void (^)(GHComboBoxResult *result))completion;
/// The event tap calls this for every UNTAGGED keyDown while a run is going. Any thread.
- (void)noteUserKeyEvent;
- (void)cancel;

// ---------- pure, exposed for tests ----------
/// Shared DEMOGRAPHIC rule of shared/src/heuristic.ts plus date of birth and age.
+ (BOOL)isDemographicText:(nullable NSString *)text;
/// Title, description, placeholder, help, identifier and the title element of `node`.
+ (BOOL)isDemographicComboBox:(id<GHAXNode>)node;
+ (BOOL)isComboBox:(nullable id<GHAXNode>)node;
/// The option list that belongs to `comboBox`: inside it, else among the few siblings that follow it before the
/// next control (up to 4 levels up), else a portal at the end of the web area. Content lists never count.
+ (nullable id<GHAXNode>)listForComboBox:(id<GHAXNode>)comboBox;
+ (NSArray<id<GHAXNode>> *)optionsInList:(id<GHAXNode>)list;
/// An open list that says "No options" / "No results found": the page's answer that nothing matches what was typed.
+ (BOOL)listSaysNothingFound:(nullable id<GHAXNode>)list;
+ (NSString *)textOfOption:(id<GHAXNode>)option;
/// What the combobox displays as its choice: its own value (unless that is just `typed`) and the texts right before
/// it (react-select's single value), stopping at its label or the previous control. Placeholders and live regions
/// are left out.
+ (NSArray<NSString *> *)shownTextsForComboBox:(id<GHAXNode>)comboBox typed:(nullable NSString *)typed;

@end

NS_ASSUME_NONNULL_END
