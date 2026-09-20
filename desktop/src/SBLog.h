// SBLog: append-only file log at ~/Library/Logs/Shabang/desktop.log.
// RULE: never pass field values or profile values. Labels go through SBLogLabel() (truncated).
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// What the product is called, wherever a person can read it. The one place the brand is written down.
/// NOT the bundle name: System Settings and Finder show CFBundleName, which -grantName reads at runtime.
extern NSString *const SBProductName;
/// What System Settings actually lists this app as, so a "grant it there" message can never be wrong.
NSString *SBBundleDisplayName(void);

/// printf-style. Thread safe. Also mirrored to stderr when SHABANG_LOG_STDERR=1 or after SBLogSetMirrorToStderr(YES).
void SBLog(NSString *format, ...) NS_FORMAT_FUNCTION(1, 2);

/// A label made safe for the log: single line, at most 40 characters, and "[sensitive]" when it
/// looks like it names a secret (cheap native check; capture already drops such fields).
NSString *SBLogLabel(NSString *_Nullable label);

/// Default ~/Library/Logs/Shabang/desktop.log. Tests point it at a temp file. nil restores the default.
void SBLogSetPath(NSString *_Nullable path);
NSString *SBLogPath(void);
void SBLogSetMirrorToStderr(BOOL mirror);

/// Rotates desktop.log to desktop.log.1 when it grows past this many bytes (default 2 MB).
void SBLogSetMaxBytes(unsigned long long maxBytes);

/// Blocks until queued lines are on disk (tests, and right before exit).
void SBLogFlush(void);

NS_ASSUME_NONNULL_END
