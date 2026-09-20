// GHAffordance: what the window in front OFFERS, read off the accessibility tree (docs/anywhere.md sections 2
// and 3). Capture already turns a window into GHFields; this adds the generic hints the shared affordance layer
// needs and measures the page itself, so the core can say what kind of place this is and what people do here.
//
// Nothing in this file may name an app, a bundle id, a host or a brand. Every signal is structural:
//
//   insideMediaControls   the control shares a small ancestor with a media element or a scrubber
//   list { signature, index }   the control sits in a repeated sibling structure (a feed, a grid, a result list)
//   nearbyPrice           a price-shaped string (any currency) is drawn beside it
//   badgeCount            a small count is drawn on it
//   hasMediaElement / mainListSignature / mainRegionRepeats / textDensity   the page-level measurements
//
// Privacy: page text is COUNTED, never kept. The only strings that survive are a control's own short name, its
// identifier and its class tokens, all of which the capture already holds. Nothing here reaches a server.
#import <Foundation/Foundation.h>
#import "GHAXNode.h"
#import "GHCapture.h"

NS_ASSUME_NONNULL_BEGIN

/// The page-level half of what the core's `nextAction` reads (its `signals` argument).
@interface GHPageSignals : NSObject <NSCopying>
/// The window holds a media element (a video, an audio player).
@property (nonatomic) BOOL hasMediaElement;
/// The repeated list the MAIN region shows, or nil for "this window has no main list". Always authoritative:
/// without it a navigation bar's items classify as feed items (measured on a real shop).
@property (nonatomic, copy, nullable) NSString *mainListSignature;
/// How many members that list has.
@property (nonatomic) NSUInteger mainRegionRepeats;
/// 0 to 1: how much of the window is running text rather than controls. Derived from character COUNTS only.
@property (nonatomic) double textDensity;
/// Frontmost app's bundle id: a grouping key for role memory, never matched against a vendor.
@property (nonatomic, copy, nullable) NSString *appBundleId;
/// A value-free "path" for this window (a generalized URL path in a browser, else nil).
@property (nonatomic, copy, nullable) NSString *pathPattern;
/// The media element fills the screen already, so proposing fullscreen again would be the classic wrong ghost.
@property (nonatomic) BOOL isFullscreen;
/// The role of the action the user took last in this window ("" when this is the first proposal of the view).
@property (nonatomic, copy, nullable) NSString *previousRole;
/// A password (or any AXSecureTextField) is on screen in this window. Nothing may be screenshotted here:
/// the vision fallback refuses the whole window, not just that control (docs/anywhere.md section 4).
@property (nonatomic) BOOL sensitiveOnScreen;
/// How many nodes the scan visited, and whether it ran out of budget (the HUD and tests read these).
@property (nonatomic) NSUInteger visitedNodes;
@property (nonatomic) BOOL partial;

/// The `signals` JSON the core's `nextAction` takes. Keys are omitted when nothing is known about them,
/// EXCEPT `mainListSignature`, which is `null` when the window has no main list.
- (NSDictionary<NSString *, id> *)toJSONObject;
@end

@interface GHAffordance : NSObject

/// Reads `window` (bounded: at most `maxNodes` nodes and `timeBudget` seconds), annotates the fields of
/// `result` in place with the generic hints above, and returns what it measured about the page.
/// Safe on a partial or empty capture: the hints are simply weaker.
+ (GHPageSignals *)annotateResult:(nullable GHCaptureResult *)result window:(nullable id<GHAXNode>)window;
+ (GHPageSignals *)annotateResult:(nullable GHCaptureResult *)result
                           window:(nullable id<GHAXNode>)window
                         maxNodes:(NSUInteger)maxNodes
                      timeBudget:(NSTimeInterval)timeBudget;

// Pure helpers, exposed for tests.
/// A duration ("0:42", "1:03:11"), which is what a player draws beside its scrubber.
+ (BOOL)looksLikeDuration:(nullable NSString *)text;
/// A price in any currency: a symbol beside digits, or digits beside a currency code.
+ (BOOL)looksLikePrice:(nullable NSString *)text;
/// A small count drawn on an icon ("3", "12 items", "7 unread"). 0 when there is none.
+ (NSUInteger)countInBadgeText:(nullable NSString *)text;

@end

NS_ASSUME_NONNULL_END
