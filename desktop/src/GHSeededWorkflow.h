// Small, explicit workflow seeds for the hackathon demo.  A seed is deliberately a state machine over the
// accessibility capture, not a replay of coordinates or DOM selectors: every rescan asks which visible semantic
// milestone comes next.  That lets the same workflow survive layout changes and page navigation.
#import <Foundation/Foundation.h>

@class GHField, GHGhost;

NS_ASSUME_NONNULL_BEGIN

@interface GHSeededWorkflow : NSObject

/// Returns the one next workflow milestone for `origin`, or nil when no seed applies / no milestone is visible.
/// Values are kept in the returned in-memory ghost and are never logged or sent to the server.
+ (nullable GHGhost *)ghostForOrigin:(nullable NSString *)origin fields:(NSArray<GHField *> *)fields;

@end

NS_ASSUME_NONNULL_END
