// GHOverlayModel: pure view-model of the overlay. Turns (ghosts + AX rects + current index + HUD info) into a flat
// list of draw items with frames in overlay-panel coordinates, one panel per display. No windows, no layers, no AX:
// everything here runs in the test runner. The layout rules mirror extension/src/content/overlay.ts.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import "GHGeometry.h"

@class GHField;

NS_ASSUME_NONNULL_BEGIN

/// How a ghost is shown on its control.
typedef NS_ENUM(NSInteger, GHOverlayMode) {
    GHOverlayModeText,        // gray text inside a single-line field
    GHOverlayModeMultiline,   // wrapped gray text inside a text area
    GHOverlayModeSelectPill,  // pill inside a popup / combo box, left of its arrow
    GHOverlayModePill,        // pill beside a checkbox or radio group, or an upload control (the file name)
    GHOverlayModeTarget,      // button or link: ring and cursor only (the parked lock ghost)
};

GHOverlayMode GHOverlayModeForKind(NSString *_Nullable kind);
/// AX exposes no fonts: about 0.46 x field height clamped to 11...17 pt, and 13 pt for text areas.
CGFloat GHGhostFontSize(CGFloat fieldHeight, BOOL multiline);
/// Left/right inset of ghost text inside its field: about 8 pt, a little less in very small native fields.
CGFloat GHGhostTextPadding(CGFloat fieldHeight);

/// One live ghost with the rect of its control. `displayText` stays in memory: it is never logged.
@interface GHOverlayEntry : NSObject
@property (nonatomic, copy) NSString *signature;
@property (nonatomic, copy) NSString *kind;         // FieldKind string ("text", "textarea", "select", "button"...)
@property (nonatomic, copy) NSString *displayText;
@property (nonatomic) CGRect axRect;                // AX global, top-left origin
@property (nonatomic) BOOL locked;
@property (nonatomic) BOOL streaming;               // Ghost.pending: free text still streaming in
/// Ghost.guess: the answer engine guessed this (docs/answers.md). Drawn with a dotted underline and a "guess"
/// chip so it is never mistaken for a fact; hold-Tab stops here.
@property (nonatomic) BOOL guess;
/// What the keycap says. Tab is form-only now, so a keycap reading "Tab" beside a ghost the Ghost key
/// accepts is simply wrong. The controller passes whichever key is really bound.
@property (nonatomic, copy, nullable) NSString *keyName;
+ (instancetype)entryWithSignature:(NSString *)signature
                              kind:(NSString *)kind
                       displayText:(NSString *)displayText
                            axRect:(CGRect)axRect
                            locked:(BOOL)locked;
/// `ghost` is one element of GhostCore.ghostsFor (displayText, locked, pending). The rect is the field's.
+ (instancetype)entryWithField:(GHField *)field ghost:(NSDictionary<NSString *, id> *)ghost keyName:(nullable NSString *)keyName;
@end

@interface GHOverlayHUDInfo : NSObject <NSCopying>
@property (nonatomic, copy) NSString *provider;
@property (nonatomic, copy, nullable) NSNumber *latencyMs;   // nil draws a dash
@property (nonatomic, copy) NSString *cache;                  // "hit" | "miss" | "offline"
@property (nonatomic) NSInteger keystrokesSaved;
+ (instancetype)infoWithProvider:(NSString *)provider
                       latencyMs:(nullable NSNumber *)latencyMs
                           cache:(NSString *)cache
                 keystrokesSaved:(NSInteger)keystrokesSaved;
/// "via", provider, "last", "182 ms", "cache", "hit", "saved", "12 keys": keys at even indexes, values at odd ones.
@property (nonatomic, readonly) NSArray<NSString *> *segments;
@end

@interface GHOverlayInput : NSObject
@property (nonatomic, copy) NSArray<GHOverlayEntry *> *entries;   // live ghosts in walk order, lock ghost last
@property (nonatomic) NSInteger currentIndex;                      // -1 when nothing is current
@property (nonatomic) CGRect windowAXFrame;                        // focused window; CGRectNull when unknown
@property (nonatomic, strong, nullable) GHOverlayHUDInfo *hud;
@property (nonatomic, copy, nullable) NSString *error;             // HUD error chip; never contains values
@property (nonatomic, copy, nullable) NSString *status;            // HUD progress chip ("Picking resume.pdf"); never a value
@end

typedef NS_ENUM(NSInteger, GHDrawKind) {
    GHDrawKindGhostText,
    GHDrawKindPill,
    GHDrawKindRing,
    GHDrawKindCursor,
    GHDrawKindKeycap,
    GHDrawKindHUD,
    GHDrawKindHUDError,
    GHDrawKindHUDStatus,
};

/// How a content-sized layer (pill, badge, HUD) sits in its frame. The frame is the room it may use.
typedef NS_ENUM(NSInteger, GHDrawAnchor) {
    GHDrawAnchorFill,
    GHDrawAnchorLeftCenter,
    GHDrawAnchorRightCenter,
    GHDrawAnchorTopLeft,
    GHDrawAnchorBottomRight,
};

@interface GHDrawItem : NSObject
/// Layer identity inside one panel: "text:<signature>", "pill:<signature>", "ring", "cursor", "keycap", "lock", "hud".
@property (nonatomic, copy, readonly) NSString *key;
@property (nonatomic, readonly) GHDrawKind kind;
@property (nonatomic, readonly) NSUInteger screenIndex;
/// Panel coordinates of display `screenIndex`: bottom-left origin, points, pixel aligned.
@property (nonatomic, readonly) CGRect frame;
/// The part of `frame` that may be painted (field cut by the window or the display edge). Equals `frame` when whole.
@property (nonatomic, readonly) CGRect clipRect;
@property (nonatomic, readonly) GHDrawAnchor anchor;
@property (nonatomic, copy, readonly, nullable) NSString *text;
@property (nonatomic, readonly) CGFloat fontSize;
@property (nonatomic, readonly) CGFloat padLeft;
@property (nonatomic, readonly) CGFloat padRight;   // grows to keep ghost text clear of the keycap
@property (nonatomic, readonly) CGFloat cornerRadius;
@property (nonatomic, readonly) BOOL multiline;
@property (nonatomic, readonly) BOOL current;
@property (nonatomic, readonly) BOOL locked;
@property (nonatomic, readonly) BOOL streaming;
/// The answer under this item is a guess: dotted underline (ghost text) or a "guess" chip (pill).
@property (nonatomic, readonly) BOOL guess;
@property (nonatomic, readonly) BOOL showsKeycap;   // pills carry their own keycap
/// Cursor only: where the pointer's tip rests, panel coordinates.
@property (nonatomic, readonly) CGPoint tip;
/// Ring, cursor, keycap, lock: the ghost they belong to. A change means "glide", the same one means "track exactly".
@property (nonatomic, copy, readonly, nullable) NSString *targetSignature;
@property (nonatomic, strong, readonly, nullable) GHOverlayHUDInfo *hud;
@property (nonatomic, readonly) CGFloat scale;
/// Everything that affects pixels. Equal signature = the layer is left alone.
@property (nonatomic, copy, readonly) NSString *contentSignature;
@end

@interface GHOverlayModel : NSObject
+ (instancetype)modelWithInput:(GHOverlayInput *)input layout:(GHScreenLayout *)layout;
+ (instancetype)emptyModel;
@property (nonatomic, copy, readonly) NSArray<GHDrawItem *> *items;
@property (nonatomic, copy, readonly) NSString *layoutFingerprint;
/// True when the current ghost is visible enough to draw. GHEventTap may only consume Tab while this holds.
@property (nonatomic, readonly) BOOL currentVisible;
/// AX global point of the ghost cursor's tip; CGPointZero while hidden.
@property (nonatomic, readonly) CGPoint currentTipAX;
- (NSArray<GHDrawItem *> *)itemsForScreen:(NSUInteger)screenIndex;
- (nullable GHDrawItem *)itemWithKey:(NSString *)key screen:(NSUInteger)screenIndex;
@end

/// Keyed diff of two item lists (of ONE panel). Rendering the same model twice yields an empty diff.
@interface GHOverlayDiff : NSObject
+ (instancetype)diffFromItems:(NSArray<GHDrawItem *> *)oldItems toItems:(NSArray<GHDrawItem *> *)newItems;
@property (nonatomic, copy, readonly) NSArray<GHDrawItem *> *added;
@property (nonatomic, copy, readonly) NSArray<GHDrawItem *> *changed;     // same key, new content: reuse the layer
@property (nonatomic, copy, readonly) NSArray<GHDrawItem *> *unchanged;
@property (nonatomic, copy, readonly) NSArray<NSString *> *removedKeys;
@property (nonatomic, readonly) BOOL isEmpty;
@end

NS_ASSUME_NONNULL_END
