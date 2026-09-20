// GHField: the shared model of one captured interactive element. Mirrors `CapturedField` in
// shared/src/types.ts, plus the live AXUIElementRef the writer and the overlay need.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ApplicationServices/ApplicationServices.h>

NS_ASSUME_NONNULL_BEGIN

// FieldKind values (same strings as the TypeScript union).
extern NSString *const GHKindText;
extern NSString *const GHKindEmail;
extern NSString *const GHKindTel;
extern NSString *const GHKindURL;
extern NSString *const GHKindNumber;
extern NSString *const GHKindDate;
extern NSString *const GHKindMonth;
extern NSString *const GHKindTextArea;
extern NSString *const GHKindSelect;
extern NSString *const GHKindRadio;
extern NSString *const GHKindCheckbox;
extern NSString *const GHKindFile;
extern NSString *const GHKindButton;
extern NSString *const GHKindLink;
extern NSString *const GHKindOther;

// What a `file` field wants (serialized as `uploadKind`). The core maps them to resumePath / coverLetterPath.
extern NSString *const GHUploadKindResume;       // "resume"
extern NSString *const GHUploadKindCoverLetter;  // "coverLetter"
extern NSString *const GHUploadKindOther;        // "other": never answered

@interface GHField : NSObject <NSCopying>

/// Stable across reloads of the same window. Never contains the field's value.
@property (nonatomic, copy) NSString *signature;
@property (nonatomic, copy) NSString *label;
/// One of the GHKind* strings. Defaults to GHKindText.
@property (nonatomic, copy) NSString *kind;
@property (nonatomic, copy, nullable) NSString *inputType;
@property (nonatomic, copy, nullable) NSString *name;
/// DOM identifier (AXDOMIdentifier) or AXIdentifier. Serialized as `id`.
@property (nonatomic, copy, nullable) NSString *identifier;
@property (nonatomic, copy, nullable) NSString *placeholder;
/// Array of @{ @"value": NSString, @"label": NSString } for selects and radio groups.
@property (nonatomic, copy, nullable) NSArray<NSDictionary<NSString *, NSString *> *> *options;
@property (nonatomic) BOOL required;
/// Current value. Stays in this process: it is never sent to the server and never logged.
@property (nonatomic, copy, nullable) NSString *value;
/// Global display coordinates with a TOP-LEFT origin (what AXPosition/AXSize report).
@property (nonatomic) CGRect rect;
/// Irreversible action: never pressed by Ghost.
@property (nonatomic) BOOL locked;
@property (nonatomic, copy, nullable) NSString *context;
/// `file` fields only: one of the GHUploadKind* strings. Serialized as `uploadKind`.
@property (nonatomic, copy, nullable) NSString *uploadKind;
/// Selects whose options only exist once the list is open (react-select, ARIA comboboxes). A ghost for such a
/// field carries the intended answer; the writer matches it against the real options at accept time.
@property (nonatomic) BOOL lazyOptions;

// ---------- Ghost anywhere (docs/anywhere.md): generic hints for the affordance layer ----------
// Every one of these is derived from what the control OFFERS. None of them may ever hold page text, a value,
// or anything that identifies an app or a site. They travel to the in-process core only, never to a server.

/// The control has no readable name anywhere in the tree (kept only with `capturesUnnamedControls`). It never
/// gets a value ghost; the affordance layer and the vision fallback are what give it a meaning.
@property (nonatomic) BOOL unnamed;
/// AXDescription when it says something the label does not. Read exactly like the name, one notch weaker.
@property (nonatomic, copy, nullable) NSString *axDescription;
/// AXDOMClassList: a design system's vocabulary, read ONLY for icon words ("player-play-button" -> play).
@property (nonatomic, copy, nullable) NSArray<NSString *> *classTokens;
/// The control sits in a media-controls cluster: a group whose subtree holds a media element or a scrubber.
@property (nonatomic) BOOL insideMediaControls;
/// Membership of a repeated sibling structure (a feed, a grid, a result list): the group's signature...
@property (nonatomic, copy, nullable) NSString *listSignature;
/// ...and this control's position in it. Only meaningful with `listSignature`.
@property (nonatomic) NSUInteger listIndex;
/// A price-shaped string (any currency) is drawn beside the control. The boolean is kept, never the string.
@property (nonatomic) BOOL nearbyPrice;
/// A small count drawn on the control (a cart count, an unread count). 0 = none.
@property (nonatomic) NSUInteger badgeCount;
/// Live element. Retained by the setter, released on dealloc. NULL in tests.
@property (nonatomic, nullable) AXUIElementRef axElement;

+ (instancetype)fieldWithSignature:(NSString *)signature label:(NSString *)label kind:(NSString *)kind;

/// `CapturedField` JSON for the in-process core (includes `value` so filled fields are skipped). No axElement.
- (NSDictionary<NSString *, id> *)toJSONObject;
/// The same without `value`: what may leave the process (server requests, --dump, logs).
- (NSDictionary<NSString *, id> *)toWireJSONObject;
/// Rebuilds a field from `CapturedField` JSON (tests, caches). Returns nil without a signature.
+ (nullable instancetype)fieldFromJSONObject:(NSDictionary<NSString *, id> *)json;

/// `AffordanceCandidate` JSON for the in-process core (docs/anywhere.md): what this control OFFERS, with the
/// generic hints above. No value, no options, no rect. Never leaves the process.
- (NSDictionary<NSString *, id> *)toCandidateJSONObject;
+ (NSArray<NSDictionary<NSString *, id> *> *)candidateJSONObjectsForFields:(NSArray<GHField *> *)fields;

+ (NSArray<NSDictionary<NSString *, id> *> *)JSONObjectsForFields:(NSArray<GHField *> *)fields;
+ (NSArray<NSDictionary<NSString *, id> *> *)wireJSONObjectsForFields:(NSArray<GHField *> *)fields;

@end

NS_ASSUME_NONNULL_END
