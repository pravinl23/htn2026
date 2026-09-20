// GHProfileStore: ~/Library/Application Support/Shabang/profile.json, settings.json and answers.json.
// Same shapes as the extension (`Profile`, `GhostSettings`), seeded with the fictional demo profile from
// the core, created with mode 0600 (directory 0700), and watched for edits made in any editor.
//
// settings.json carries two desktop-only keys on top of GhostSettings:
//   "pausedBundleIds": ["com.example.app", ...]   apps the user paused from the menu
//   "answerProtectedWithDecline": true            answer EEO questions with the form's own "prefer not to
//                                                 answer" option (docs/answers.md section 1); true by default
//
// answers.json is the LearnedAnswersSnapshot of shared/src/answers/store.ts: what the user answered themselves,
// keyed by the question rather than by the site. It is written only by Ghost, it never leaves the machine, and a
// missing, empty or corrupt file simply means "nothing learned yet" -- it never stops Ghost from proposing.
#import <Foundation/Foundation.h>

@class GHCore;

NS_ASSUME_NONNULL_BEGIN

/// Writes `data` to a temp file created with mode 0600 and renames it over `path` (atomic, never readable
/// by other users, not even for a moment). Used for everything Ghost keeps under Application Support.
BOOL GHWritePrivateFile(NSString *path, NSData *data, NSError *_Nullable *_Nullable error);

/// Posted on the main queue after profile.json or settings.json changed on disk or through this class.
extern NSNotificationName const GHProfileStoreDidChangeNotification;

/// profile.json facts that hold a local file for upload ghosts (desktop/profile.example.json). Validated on every
/// load: an absolute path ("~/" expanded) to an existing, readable, regular document (pdf, doc, docx, rtf, txt, odt,
/// pages) under 25 MB, without "..", without control characters. Anything else is dropped (the log names the key and
/// a reason code, never the path). They never leave the machine: not in /v1/predict/form, not in /v1/ghost-text.
extern NSString *const GHProfileResumePathKey;        // "resumePath"
extern NSString *const GHProfileCoverLetterPathKey;   // "coverLetterPath"
/// The usable absolute path for a file fact, or nil with *problem set to a short code.
NSString *_Nullable GHUsableProfileFilePath(NSString *_Nullable raw, NSString *_Nullable *_Nullable problem);

@interface GHProfileStore : NSObject

+ (NSString *)defaultDirectory;

/// `core` supplies the demo profile and the default settings. With a nil core the store still works and
/// seeds an EMPTY profile (no ghosts) rather than inventing data.
- (instancetype)initWithDirectory:(NSString *)directory core:(nullable GHCore *)core NS_DESIGNATED_INITIALIZER;
- (instancetype)initWithCore:(nullable GHCore *)core;
- (instancetype)init NS_UNAVAILABLE;

@property (nonatomic, readonly, copy) NSString *directory;
@property (nonatomic, readonly, copy) NSString *profilePath;
@property (nonatomic, readonly, copy) NSString *settingsPath;
@property (nonatomic, readonly, copy) NSString *answersPath;

/// Creates the directory and seeds missing files. Existing files are never overwritten. Returns NO when
/// the directory cannot be created (the store then serves in-memory defaults).
- (BOOL)prepare;

/// { facts: {key: string}, pastAnswers: [{question, answer, ...}] }. A file that is not valid JSON (the
/// user is mid-edit) keeps the last good profile.
@property (atomic, readonly, copy) NSDictionary<NSString *, id> *profile;
/// GhostSettings merged over the defaults, types checked, threshold clamped to 0.5...0.99.
@property (atomic, readonly, copy) NSDictionary<NSString *, id> *settings;

/// Fact keys that have a value and do not look sensitive. Keys are all the server ever learns.
- (NSArray<NSString *> *)usableFactKeys;

// ---------- learned answers (docs/answers.md) ----------
/// The answers.json snapshot as the core wants it: `{ max, answers: [...] }`. Never nil: a missing or corrupt
/// file reads as an empty snapshot. Never logged, never sent anywhere.
@property (atomic, readonly, copy) NSDictionary<NSString *, id> *answers;
/// The same as a JSON string, ready for GHCore; "" when there is nothing learned.
- (NSString *)answersJSON;
/// Replaces the snapshot and writes answers.json atomically (0600). NO when it could not be written; the
/// in-memory snapshot is updated either way, so the session keeps what it just learned.
- (BOOL)saveAnswers:(NSDictionary<NSString *, id> *)answers error:(NSError *_Nullable *_Nullable)error;
/// "Forget everything": empties the snapshot and the file.
- (BOOL)forgetAllAnswers;

@property (nonatomic, readonly) BOOL enabled;
@property (nonatomic, readonly) double confidenceThreshold;
@property (nonatomic, readonly, copy) NSString *serverURLString;
@property (nonatomic, readonly) BOOL showHud;

- (BOOL)saveProfile:(NSDictionary<NSString *, id> *)profile error:(NSError *_Nullable *_Nullable)error;
/// Merges `patch` into settings.json (unknown keys already in the file are preserved).
- (BOOL)updateSettings:(NSDictionary<NSString *, id> *)patch error:(NSError *_Nullable *_Nullable)error;
- (BOOL)setEnabled:(BOOL)enabled;
- (BOOL)resetToDemoProfile;

// ---------- per-app pause (safety rule 6) ----------
/// Password managers, terminals, Keychain Access, System Settings...: never touched, not user-removable.
+ (NSArray<NSString *> *)defaultPausedBundleIds;
- (NSArray<NSString *> *)userPausedBundleIds;
/// YES for the built-in list, the user's list, and Ghost itself. nil counts as paused (unknown app).
- (BOOL)isPausedBundleId:(nullable NSString *)bundleId;
- (BOOL)isBuiltInPausedBundleId:(nullable NSString *)bundleId;
- (BOOL)setPaused:(BOOL)paused forBundleId:(NSString *)bundleId;

// ---------- watching ----------
/// Watches the directory (editors replace files, so watching the file itself goes stale). Debounced 200 ms.
- (void)startWatching;
- (void)stopWatching;
/// Re-reads both files now. Returns YES when anything changed (and then posts the notification).
- (BOOL)reload;

@end

NS_ASSUME_NONNULL_END
