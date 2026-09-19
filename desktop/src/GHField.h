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
/// Live element. Retained by the setter, released on dealloc. NULL in tests.
@property (nonatomic, nullable) AXUIElementRef axElement;

+ (instancetype)fieldWithSignature:(NSString *)signature label:(NSString *)label kind:(NSString *)kind;

/// `CapturedField` JSON for the in-process core (includes `value` so filled fields are skipped). No axElement.
- (NSDictionary<NSString *, id> *)toJSONObject;
/// The same without `value`: what may leave the process (server requests, --dump, logs).
- (NSDictionary<NSString *, id> *)toWireJSONObject;
/// Rebuilds a field from `CapturedField` JSON (tests, caches). Returns nil without a signature.
+ (nullable instancetype)fieldFromJSONObject:(NSDictionary<NSString *, id> *)json;

+ (NSArray<NSDictionary<NSString *, id> *> *)JSONObjectsForFields:(NSArray<GHField *> *)fields;
+ (NSArray<NSDictionary<NSString *, id> *> *)wireJSONObjectsForFields:(NSArray<GHField *> *)fields;

@end

NS_ASSUME_NONNULL_END
