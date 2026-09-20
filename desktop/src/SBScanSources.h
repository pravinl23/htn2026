// SBScanSources: what cold start could read, counted without reading anything (docs/cold-start.md sections 2 and 4).
//
// This module answers the consent panel's question -- "how much is there, and what would you have to allow?" --
// and nothing else. It opens no document, no database and no contact card, and it NEVER asks macOS for a
// permission: every protected source is reported as `needs permission: <what the user clicks>` instead.
//
//   Spotlight counts     /usr/bin/mdfind -count: file NAMES, kinds and dates from the metadata index. No file is
//                        opened, no permission is involved (SOURCE_CAPS.spotlight.maxBytesPerItem is 0 for exactly
//                        this reason), and the query is passed as an argument vector, never through a shell.
//   readability          access(2) on a candidate file, and only under roots macOS does not protect. A path under
//                        a protected root (Safari, Mail, Calendars, AddressBook, Containers...) is classified from
//                        the PATH alone and never touched, so an automated run can never raise a TCC dialog.
//   protected sources    Contacts and Calendar report `unknown` unless the process links their framework, in which
//                        case the non-prompting authorization STATUS is read (never a request).
//
// Paths collected here are candidates for SBColdStart to open later. They are personal data: they are never
// logged and never written into a report (see SBColdStart's value-free report).
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Mirrors PermissionState in shared/src/coldstart/plan.ts.
typedef NS_ENUM(NSInteger, SBPermissionState) {
    SBPermissionNotRequired = 0,   // Spotlight metadata: no dialog exists for it
    SBPermissionGranted = 1,
    SBPermissionMissing = 2,
    SBPermissionUnknown = 3,       // the capability check has not run (treated as missing when planning)
};

/// "not-required" | "granted" | "missing" | "unknown", as plan.ts spells them.
NSString *SBPermissionStateName(SBPermissionState state);

// ColdStartSourceKind, as plan.ts spells it.
extern NSString *const SBScanKindSpotlight;
// The machine sources (docs/knowledge.md section 3): what this person USES, as opposed to who they are. Every one
// of them reads a list of application names or a Spotlight count, needs no permission dialog on any Mac, and
// produces surface records rather than facts.
extern NSString *const SBScanKindDock;
extern NSString *const SBScanKindLoginItems;
extern NSString *const SBScanKindRecentApps;
extern NSString *const SBScanKindRecentDocs;
extern NSString *const SBScanKindAppInventory;
extern NSString *const SBScanKindContacts;
extern NSString *const SBScanKindResume;
extern NSString *const SBScanKindBrowserHistory;
extern NSString *const SBScanKindCalendar;
extern NSString *const SBScanKindMail;
extern NSString *const SBScanKindProjects;

/// One row of the consent panel, before the shared planner turns it into a plan.
@interface SBScanSource : NSObject

@property (nonatomic, copy, readonly) NSString *kind;
/// What a COUNT found. Negative means "not counted" (the planner then plans for the cap).
@property (nonatomic) NSInteger itemCount;
@property (nonatomic) SBPermissionState permission;
/// A reason CODE for the report ("not-implemented", "no-profile", "protected-root"), never a path or a value.
@property (nonatomic, copy, nullable) NSString *detail;
/// YES when Shabang has no reader for this source yet, whatever the permission says.
@property (nonatomic) BOOL unavailable;
/// Candidate files for SBColdStart. Personal data: never logged, never reported.
@property (nonatomic, copy) NSArray<NSString *> *paths;

+ (instancetype)sourceWithKind:(NSString *)kind;
/// `{ kind, itemCount?, permission, enabled }` for coldStartPlan. `enabled` is the user's switch.
- (NSDictionary<NSString *, id> *)descriptorEnabled:(BOOL)enabled;

@end

/// Everything that touches the machine, so tests can hand in fakes and spawn nothing.
@protocol SBScanEnvironment <NSObject>
/// `mdfind -count`. Negative when Spotlight cannot answer (index off, tool missing, timeout).
- (NSInteger)countForSpotlightQuery:(NSString *)query;
/// `mdfind`, at most `limit` paths. Metadata only: the files themselves stay closed.
- (NSArray<NSString *> *)pathsForSpotlightQuery:(NSString *)query limit:(NSUInteger)limit;
/// The same two, over the whole machine rather than the home directory. Applications do not live in a home, so
/// counting them there answers almost nothing; documents do, and stay home-scoped.
- (NSInteger)countForSystemSpotlightQuery:(NSString *)query;
- (NSArray<NSString *> *)pathsForSystemSpotlightQuery:(NSString *)query limit:(NSUInteger)limit;
/// access(2) R_OK. MUST return NO without any syscall for a path under a protected root.
- (BOOL)isReadableFileAtPath:(NSString *)path;
- (BOOL)isDirectoryAtPath:(NSString *)path;
- (NSString *)homeDirectory;
/// The NON-PROMPTING authorization status of a protected source ("contacts", "calendar"). Unknown when the
/// framework is not linked into this process, which is the case for every command-line build.
- (SBPermissionState)authorizationStatusForKind:(NSString *)kind;
/// A property list, read directly (never through a shell). nil under a protected root, unreadable, or not a
/// dictionary. Used for the one preference file that says which applications this person keeps at hand.
- (nullable NSDictionary<NSString *, id> *)propertyListAtPath:(NSString *)path;
/// The names of a directory's entries. A listing is metadata: nothing inside is opened, and a link is not followed.
- (NSArray<NSString *> *)entryNamesAtDirectoryPath:(NSString *)path;
/// Spotlight ATTRIBUTES for a bounded list of paths: one dictionary per path, in the order asked for, missing
/// attributes simply absent. Metadata only -- the files themselves stay closed.
- (NSArray<NSDictionary<NSString *, id> *> *)metadataForPaths:(NSArray<NSString *> *)paths
                                                   attributes:(NSArray<NSString *> *)attributes;
@end

/// The real machine: mdfind, access(2) and path classification. Raises no dialog, requests no permission.
@interface SBScanEnvironmentMac : NSObject <SBScanEnvironment>
/// Seconds any one subprocess may take before it is terminated (default 8).
@property (nonatomic) NSTimeInterval subprocessTimeout;
/// YES when `path` sits under a root macOS protects (Safari, Mail, Calendars, AddressBook, Containers...).
+ (BOOL)isProtectedPath:(NSString *)path home:(NSString *)home;
@end

@interface SBScanSources : NSObject

- (instancetype)initWithEnvironment:(id<SBScanEnvironment>)environment NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

@property (nonatomic, readonly, strong) id<SBScanEnvironment> environment;
/// Candidate paths kept per source (default 200; the planner caps what is actually opened).
@property (nonatomic) NSUInteger maxPathsPerSource;

/// Counts and permission states for every source, in tier order. Opens nothing.
- (NSArray<SBScanSource *> *)discover;

/// Counts of things that are NEVER read, by name alone, so the panel can show the filter working.
/// `{ "credential-file": 12, "financial-document": 3, ... }` -- counts only, never a name.
- (NSDictionary<NSString *, NSNumber *> *)neverReadCounts;

/// The Spotlight queries, exposed so a test can see exactly what would run (and that nothing else does).
+ (NSString *)queryForResumeDocuments;
+ (NSString *)queryForVCards;
+ (NSString *)queryForCalendarFiles;
+ (NSString *)queryForProjectManifests;

/// Chromium-family history databases, relative to the home directory. Safari is deliberately absent: its
/// history sits under a protected root and is reported as needing Full Disk Access, never probed.
+ (NSArray<NSString *> *)browserHistoryRelativePaths;

/// Applications used in the last 30 days, with their use counts. Metadata predicate: nothing is opened.
+ (NSString *)queryForRecentApplications;
/// Recently used documents, COUNTED per generic content class and never listed. The key is the PageKind the shared
/// rules use ("media", "reader"); the value is the Spotlight predicate. No document name ever leaves this query.
+ (NSDictionary<NSString *, NSString *> *)queriesForRecentDocumentClasses;
/// The preference file that holds the Dock's own list, relative to the home directory.
+ (NSString *)dockRelativePath;
/// Where per-user login agents live, relative to the home directory. Their FILE NAMES are the list.
+ (NSString *)loginItemsRelativeDirectory;
/// Where applications live. Directories, not applications: nothing here names one.
+ (NSArray<NSString *> *)applicationRootsForHome:(NSString *)home;

@end

NS_ASSUME_NONNULL_END
