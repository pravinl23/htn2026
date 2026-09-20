// SBVision: naming what has no name (docs/anywhere.md section 4, docs/server-api.md `/v1/vision/label`).
//
// After the heuristics, a control can still be `unknown` with nothing readable on it: an icon-only button in a
// canvas app, a custom-drawn widget, a player's glyph with no identifier. Shabang then crops THOSE CONTROLS ONLY
// out of a screenshot, lays them side by side into one small strip, and asks the local server for their names.
// The strip carries nothing but the controls themselves: no page text, no window title, no surroundings.
//
// Rules, enforced here:
//   - at most ONE call per page view, and a cache keyed by the page and the exact box geometry;
//   - never for a window with a sensitive field on screen (SBPageSignals.sensitiveOnScreen), at all;
//   - at most 40 boxes (the route's limit), each a control that is actually on screen;
//   - never blocking: the ghost from the heuristics is already drawn, and a label only upgrades it;
//   - a returned label that the shared rules call irreversible LOCKS the control, and one they call sensitive
//     drops it. A model can lock, never unlock.
//
// Screen Recording: taking a screenshot needs the macOS Screen Recording permission, which Shabang may not have.
// Then `available` is NO, `unavailableReason` says so for the HUD, one line is logged once, and everything else
// keeps working exactly as before, blind to icons.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import "SBField.h"

NS_ASSUME_NONNULL_BEGIN

/// Reasons the fallback is not available. Short codes: they reach the HUD and the log, never a server.
extern NSString *const SBVisionReasonScreenRecording;  // "needs Screen Recording"
extern NSString *const SBVisionReasonSensitive;        // a sensitive field is on screen: nothing is captured
extern NSString *const SBVisionReasonNothingToName;    // every control already has a name and a role
extern NSString *const SBVisionReasonCaptureFailed;    // the screenshot API returned nothing

/// One control to name: where it is on screen, and which captured field it belongs to.
@interface SBVisionBox : NSObject
@property (nonatomic, copy) NSString *signature;
@property (nonatomic) CGRect rect;   // global display coordinates, top-left origin (what AX reports)
+ (instancetype)boxWithSignature:(NSString *)signature rect:(CGRect)rect;
@end

@interface SBVision : NSObject

- (instancetype)initWithBaseURLString:(nullable NSString *)baseURLString NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

/// Shabang may take a screenshot right now (the Screen Recording permission is granted), or a `screenshot`
/// block was supplied, which answers for the permission itself. Never prompts.
@property (nonatomic, readonly) BOOL screenRecordingAllowed;
/// nil when the fallback is usable, else a short code for the HUD ("needs Screen Recording").
@property (nonatomic, readonly, copy, nullable) NSString *unavailableReason;
/// How many calls this process has made, and how many were answered from the cache.
@property (nonatomic, readonly) NSUInteger calls;
@property (nonatomic, readonly) NSUInteger cacheHits;

/// Test seam: the HTTP round trip. nil = a real NSURLSession POST to the local server.
@property (nonatomic, copy, nullable) void (^transport)(NSURLRequest *request, void (^done)(NSData *_Nullable body, NSInteger status));
/// Test seam: the screenshot. nil = CGWindowListCreateImage of the whole rect. Returns NULL when it failed.
@property (nonatomic, copy, nullable) CGImageRef _Nullable (^screenshot)(CGRect rect);

/// Which controls of this capture are worth a crop: the ones the core could not name, that are on screen and
/// big enough to see. At most 40, in reading order. Empty when `sensitiveOnScreen` is YES.
+ (NSArray<SBVisionBox *> *)boxesForFields:(NSArray<SBField *> *)fields
                                   unnamed:(NSArray<NSString *> *)unnamedSignatures
                          sensitiveOnScreen:(BOOL)sensitiveOnScreen;

/// Names `boxes` for the page `pageKey`. Calls back on the main queue with `signature -> label` for the ones
/// that came back usable (never a sensitive one), plus `locked` for the ones the shared rules call irreversible.
/// Calls back immediately with nothing when the fallback is unavailable or this page was asked already.
- (void)labelBoxes:(NSArray<SBVisionBox *> *)boxes
           pageKey:(NSString *)pageKey
        completion:(void (^)(NSDictionary<NSString *, NSString *> *labels, NSSet<NSString *> *locked, NSString *_Nullable reason))completion;

/// A new page view: the one-call-per-page rule starts over (the cache does not).
- (void)forgetPage;

// Pure helpers, exposed for tests.
/// The request body for `/v1/vision/label`: the strip, the boxes in image pixels, nothing else. nil when the
/// image could not be built.
+ (nullable NSDictionary<NSString *, id> *)requestBodyForStrip:(NSData *)png
                                                          size:(CGSize)size
                                                         boxes:(NSArray<SBVisionBox *> *)boxes
                                                       origins:(NSArray<NSValue *> *)origins;
/// `signature -> label` from a `/v1/vision/label` reply, dropping anything sensitive, unusable or unknown.
/// Fills `locked` with the signatures the reply (or the shared rules, re-applied by the server) marked irreversible.
+ (NSDictionary<NSString *, NSString *> *)labelsFromReply:(nullable id)reply locked:(NSMutableSet<NSString *> *)locked;
/// The cache key: the page plus the exact geometry of the boxes, in order. Any move is a miss (a stale label
/// is a wrong ghost).
+ (NSString *)cacheKeyForPage:(NSString *)pageKey boxes:(NSArray<SBVisionBox *> *)boxes;

@end

NS_ASSUME_NONNULL_END
