// GHSafetyChecking: the two shared safety rules (shared/src/sensitive.ts, shared/src/locks.ts) as seen
// from native code. GHCore conforms by forwarding to GhostCore.isSensitive / GhostCore.isLockedAction;
// tests use a fake. Capture ORs these answers with its own native patterns, so a core that failed to
// load can only make Ghost stricter, never looser.
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@protocol GHSafetyChecking <NSObject>

/// `probe` is a SensitiveProbe: { inputType?, autocomplete?, name?, id?, label?, placeholder?, markedSensitive? }.
- (BOOL)isSensitiveProbe:(NSDictionary<NSString *, id> *)probe;

/// `probe` is a LockProbe: { text, buttonType?, markedLocked?, insideForm? }.
- (BOOL)isLockedProbe:(NSDictionary<NSString *, id> *)probe;

@end

NS_ASSUME_NONNULL_END
