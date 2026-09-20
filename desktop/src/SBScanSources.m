#import "SBScanSources.h"
#import "SBLog.h"
#include <unistd.h>

NSString *const SBScanKindSpotlight = @"spotlight";
NSString *const SBScanKindDock = @"dock";
NSString *const SBScanKindLoginItems = @"login-items";
NSString *const SBScanKindRecentApps = @"recent-apps";
NSString *const SBScanKindRecentDocs = @"recent-docs";
NSString *const SBScanKindAppInventory = @"app-inventory";
NSString *const SBScanKindContacts = @"contacts";
NSString *const SBScanKindResume = @"resume";
NSString *const SBScanKindBrowserHistory = @"browser-history";
NSString *const SBScanKindCalendar = @"calendar";
NSString *const SBScanKindMail = @"mail";
NSString *const SBScanKindProjects = @"projects";

NSString *SBPermissionStateName(SBPermissionState state) {
    switch (state) {
        case SBPermissionNotRequired: return @"not-required";
        case SBPermissionGranted: return @"granted";
        case SBPermissionMissing: return @"missing";
        case SBPermissionUnknown: break;
    }
    return @"unknown";
}

#pragma mark - SBScanSource

@implementation SBScanSource

+ (instancetype)sourceWithKind:(NSString *)kind {
    SBScanSource *source = [[SBScanSource alloc] init];
    source->_kind = [kind copy];
    source.itemCount = -1;
    source.permission = SBPermissionUnknown;
    source.paths = @[];
    return source;
}

- (NSDictionary<NSString *, id> *)descriptorEnabled:(BOOL)enabled {
    NSMutableDictionary *descriptor = [NSMutableDictionary dictionary];
    descriptor[@"kind"] = self.kind;
    descriptor[@"permission"] = SBPermissionStateName(self.permission);
    descriptor[@"enabled"] = @(enabled);
    // A negative count means "not counted": the planner then plans for the cap instead of for zero.
    if (self.itemCount >= 0) descriptor[@"itemCount"] = @(self.itemCount);
    return descriptor;
}

- (NSString *)description {
    // Never the paths: they are the user's own file names.
    return [NSString stringWithFormat:@"<SBScanSource %@ count=%ld permission=%@ files=%lu%@>", self.kind, (long)self.itemCount,
                                      SBPermissionStateName(self.permission), (unsigned long)self.paths.count,
                                      self.unavailable ? @" unavailable" : @""];
}

@end

#pragma mark - the real machine

// Roots macOS protects. A path under one of these is classified from the PATH ALONE and never touched, so that
// an automated run (a test, the scan tool, the agent) can never raise a TCC dialog or a silent denial.
static NSArray<NSString *> *SBProtectedRelativeRoots(void) {
    static NSArray<NSString *> *roots;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        roots = @[
            @"Library/Safari", @"Library/Mail", @"Library/Calendars", @"Library/Application Support/AddressBook",
            @"Library/Containers", @"Library/Group Containers", @"Library/Cookies", @"Library/Messages",
            @"Library/Suggestions", @"Library/IdentityServices", @"Library/Sharing", @"Library/HomeKit",
            @"Library/Metadata/CoreSpotlight", @"Library/PersonalizationPortrait", @"Library/Trial",
        ];
    });
    return roots;
}

@implementation SBScanEnvironmentMac

- (instancetype)init {
    if ((self = [super init])) _subprocessTimeout = 8.0;
    return self;
}

+ (BOOL)isProtectedPath:(NSString *)path home:(NSString *)home {
    NSString *full = path.stringByStandardizingPath;
    if (full.length == 0) return YES;
    for (NSString *relative in SBProtectedRelativeRoots()) {
        NSString *root = [home stringByAppendingPathComponent:relative];
        if ([full isEqualToString:root] || [full hasPrefix:[root stringByAppendingString:@"/"]]) return YES;
    }
    // Another user's home, and the system's own private stores.
    if ([full hasPrefix:@"/private/var/db/"] || [full hasPrefix:@"/Library/Application Support/com.apple."]) return YES;
    return NO;
}

- (NSString *)homeDirectory {
    return NSHomeDirectory();
}

- (BOOL)isReadableFileAtPath:(NSString *)path {
    if (path.length == 0) return NO;
    // No syscall at all under a protected root: the answer is the classification, not an attempt.
    if ([SBScanEnvironmentMac isProtectedPath:path home:self.homeDirectory]) return NO;
    return access(path.fileSystemRepresentation, R_OK) == 0;
}

- (BOOL)isDirectoryAtPath:(NSString *)path {
    if (path.length == 0) return NO;
    if ([SBScanEnvironmentMac isProtectedPath:path home:self.homeDirectory]) return NO;
    BOOL directory = NO;
    return [NSFileManager.defaultManager fileExistsAtPath:path isDirectory:&directory] && directory;
}

/// One subprocess, argument vector only (never a shell), with a deadline. nil on any failure.
- (nullable NSString *)runTool:(NSString *)tool arguments:(NSArray<NSString *> *)arguments {
    if (![NSFileManager.defaultManager isExecutableFileAtPath:tool]) return nil;
    NSTask *task = [[NSTask alloc] init];
    task.executableURL = [NSURL fileURLWithPath:tool];
    task.arguments = arguments;
    NSPipe *out = [NSPipe pipe];
    task.standardOutput = out;
    task.standardError = [NSFileHandle fileHandleWithNullDevice];
    task.standardInput = [NSFileHandle fileHandleWithNullDevice];
    NSError *error = nil;
    if (![task launchAndReturnError:&error]) {
        SBLog(@"scan: %@ did not start (%@)", tool.lastPathComponent, error.localizedDescription ?: @"?");
        return nil;
    }
    // Read while it runs: a full pipe buffer would deadlock a query with many results.
    __block NSMutableData *data = [NSMutableData data];
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    NSFileHandle *handle = out.fileHandleForReading;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        NSData *chunk = nil;
        while ((chunk = [handle availableData]).length > 0) [data appendData:chunk];
        dispatch_semaphore_signal(done);
    });
    if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(self.subprocessTimeout * NSEC_PER_SEC))) != 0) {
        [task terminate];
        SBLog(@"scan: %@ timed out after %.0f s", tool.lastPathComponent, self.subprocessTimeout);
        return nil;
    }
    [task waitUntilExit];
    if (task.terminationStatus != 0) return nil;
    return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

- (NSInteger)countForSpotlightQuery:(NSString *)query {
    return [self countForQuery:query arguments:@[ @"-onlyin", self.homeDirectory, @"-count", query ]];
}

- (NSInteger)countForSystemSpotlightQuery:(NSString *)query {
    return [self countForQuery:query arguments:@[ @"-count", query ]];
}

- (NSInteger)countForQuery:(NSString *)query arguments:(NSArray<NSString *> *)arguments {
    NSString *text = [self runTool:@"/usr/bin/mdfind" arguments:arguments];
    NSString *trimmed = [text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (trimmed.length == 0) return -1;
    NSScanner *scanner = [NSScanner scannerWithString:trimmed];
    long long value = 0;
    if (![scanner scanLongLong:&value] || value < 0) return -1;
    return (NSInteger)MIN(value, (long long)NSIntegerMax);
}

- (NSArray<NSString *> *)pathsForSpotlightQuery:(NSString *)query limit:(NSUInteger)limit {
    return [self pathsForQueryArguments:@[ @"-onlyin", self.homeDirectory, query ] limit:limit];
}

- (NSArray<NSString *> *)pathsForSystemSpotlightQuery:(NSString *)query limit:(NSUInteger)limit {
    return [self pathsForQueryArguments:@[ query ] limit:limit];
}

- (NSArray<NSString *> *)pathsForQueryArguments:(NSArray<NSString *> *)arguments limit:(NSUInteger)limit {
    if (limit == 0) return @[];
    NSString *text = [self runTool:@"/usr/bin/mdfind" arguments:arguments];
    if (text.length == 0) return @[];
    NSMutableArray<NSString *> *paths = [NSMutableArray array];
    for (NSString *line in [text componentsSeparatedByString:@"\n"]) {
        if (line.length == 0 || ![line hasPrefix:@"/"]) continue;
        if ([SBScanEnvironmentMac isProtectedPath:line home:self.homeDirectory]) continue;
        [paths addObject:line];
        if (paths.count >= limit) break;
    }
    return paths;
}

- (SBPermissionState)authorizationStatusForKind:(NSString *)kind {
    // The status query itself never prompts -- but the class only exists when the process LINKS the framework,
    // which a command-line build deliberately does not. Unknown then, which the panel reports as "needs
    // permission: <what to click>" rather than pretending either way.
    NSString *className = [kind isEqualToString:SBScanKindContacts] ? @"CNContactStore"
                        : [kind isEqualToString:SBScanKindCalendar] ? @"EKEventStore" : nil;
    Class store = className ? NSClassFromString(className) : Nil;
    if (!store) return SBPermissionUnknown;
    SEL selector = NSSelectorFromString(@"authorizationStatusForEntityType:");
    if (![store respondsToSelector:selector]) return SBPermissionUnknown;
    NSMethodSignature *signature = [store methodSignatureForSelector:selector];
    if (!signature) return SBPermissionUnknown;
    NSInvocation *call = [NSInvocation invocationWithMethodSignature:signature];
    call.selector = selector;
    NSInteger entity = 0;   // CNEntityTypeContacts == 0, EKEntityTypeEvent == 0
    [call setArgument:&entity atIndex:2];
    [call invokeWithTarget:store];
    NSInteger status = 0;
    [call getReturnValue:&status];
    // 3 = authorized, 4 = limited (Contacts, macOS 14+). Everything else means Shabang may not read it.
    return (status == 3 || status == 4) ? SBPermissionGranted : SBPermissionMissing;
}

- (nullable NSDictionary<NSString *, id> *)propertyListAtPath:(NSString *)path {
    // The readability check already refuses a protected root without a syscall, so this cannot raise a dialog.
    if (![self isReadableFileAtPath:path]) return nil;
    NSData *data = [NSData dataWithContentsOfFile:path options:NSDataReadingMappedIfSafe error:NULL];
    if (data.length == 0 || data.length > 8 * 1024 * 1024) return nil;
    id plist = [NSPropertyListSerialization propertyListWithData:data options:NSPropertyListImmutable format:NULL error:NULL];
    return [plist isKindOfClass:NSDictionary.class] ? plist : nil;
}

- (NSArray<NSString *> *)entryNamesAtDirectoryPath:(NSString *)path {
    if (path.length == 0) return @[];
    if ([SBScanEnvironmentMac isProtectedPath:path home:self.homeDirectory]) return @[];
    NSArray<NSString *> *names = [NSFileManager.defaultManager contentsOfDirectoryAtPath:path error:NULL];
    if (names.count == 0) return @[];
    // A listing is metadata, and a bounded one: a directory with a hundred thousand entries is not a source.
    NSUInteger limit = MIN(names.count, (NSUInteger)5000);
    return [names subarrayWithRange:NSMakeRange(0, limit)];
}

/// `mdls -name A -name B ...` over a bounded list of paths. mdls prints one block per file, in the order asked
/// for, with a line per requested attribute; a new block starts when the FIRST attribute name comes round again.
- (NSArray<NSDictionary<NSString *, id> *> *)metadataForPaths:(NSArray<NSString *> *)paths
                                                   attributes:(NSArray<NSString *> *)attributes {
    if (paths.count == 0 || attributes.count == 0) return @[];
    NSMutableArray<NSString *> *arguments = [NSMutableArray array];
    for (NSString *attribute in attributes) {
        [arguments addObject:@"-name"];
        [arguments addObject:attribute];
    }
    [arguments addObjectsFromArray:paths];
    NSString *text = [self runTool:@"/usr/bin/mdls" arguments:arguments];
    if (text.length == 0) return @[];

    NSMutableArray<NSDictionary<NSString *, id> *> *out = [NSMutableArray array];
    NSMutableDictionary<NSString *, id> *current = [NSMutableDictionary dictionary];
    NSString *first = attributes.firstObject;
    for (NSString *line in [text componentsSeparatedByString:@"\n"]) {
        NSRange equals = [line rangeOfString:@" = "];
        if (equals.location == NSNotFound) continue;
        NSString *key = [[line substringToIndex:equals.location] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
        NSString *value = [[line substringFromIndex:NSMaxRange(equals)] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
        if (![attributes containsObject:key]) continue;
        if ([key isEqualToString:first] && current.count > 0) {
            [out addObject:[current copy]];
            current = [NSMutableDictionary dictionary];
        }
        if ([value isEqualToString:@"(null)"]) continue;
        if ([value hasPrefix:@"\""] && [value hasSuffix:@"\""] && value.length >= 2) {
            value = [value substringWithRange:NSMakeRange(1, value.length - 2)];
        }
        current[key] = value;
    }
    if (current.count > 0) [out addObject:[current copy]];
    return out;
}

@end

#pragma mark - SBScanSources

@implementation SBScanSources

- (instancetype)initWithEnvironment:(id<SBScanEnvironment>)environment {
    if ((self = [super init])) {
        _environment = environment;
        _maxPathsPerSource = 200;
    }
    return self;
}

// Spotlight queries. Metadata predicates only (names and content types): the index answers them, no file is read.
+ (NSString *)queryForResumeDocuments {
    return @"(kMDItemContentType == 'com.adobe.pdf' || kMDItemContentType == 'org.openxmlformats.wordprocessingml.document' || "
           @"kMDItemContentType == 'com.microsoft.word.doc' || kMDItemContentType == 'public.rtf' || kMDItemContentType == 'public.plain-text') && "
           @"(kMDItemFSName == '*resum*'cd || kMDItemFSName == '*curriculum*'cd || kMDItemFSName == 'cv.*'cd || "
           @"kMDItemFSName == '*-cv.*'cd || kMDItemFSName == '*_cv.*'cd || kMDItemFSName == '* cv.*'cd || kMDItemFSName == '*cover*letter*'cd)";
}

+ (NSString *)queryForVCards {
    return @"kMDItemFSName == '*.vcf'c";
}

+ (NSString *)queryForCalendarFiles {
    return @"kMDItemFSName == '*.ics'c";
}

+ (NSString *)queryForProjectManifests {
    return @"kMDItemFSName == 'package.json'c";
}

+ (NSString *)queryForRecentApplications {
    return @"kMDItemContentType == 'com.apple.application-bundle' && kMDItemLastUsedDate >= $time.today(-30)";
}

+ (NSDictionary<NSString *, NSString *> *)queriesForRecentDocumentClasses {
    // Generic UTI classes, not file names: the answer is a COUNT per kind of screen, and no document is listed.
    // The key is the PageKind the shared rules use, so nothing native has to invent a second vocabulary.
    return @{
        @"media": @"kMDItemContentTypeTree == 'public.audiovisual-content' && kMDItemLastUsedDate >= $time.today(-30)",
        @"reader": @"(kMDItemContentTypeTree == 'public.composite-content' || kMDItemContentTypeTree == 'public.text') && "
                   @"kMDItemLastUsedDate >= $time.today(-30)",
    };
}

+ (NSString *)dockRelativePath {
    return @"Library/Preferences/com.apple.dock.plist";
}

+ (NSString *)loginItemsRelativeDirectory {
    return @"Library/LaunchAgents";
}

+ (NSArray<NSString *> *)applicationRootsForHome:(NSString *)home {
    return @[ @"/Applications", @"/System/Applications", [home stringByAppendingPathComponent:@"Applications"] ];
}

+ (NSArray<NSString *> *)browserHistoryRelativePaths {
    static NSArray<NSString *> *paths;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSArray<NSString *> *roots = @[
            @"Library/Application Support/Google/Chrome",
            @"Library/Application Support/BraveSoftware/Brave-Browser",
            @"Library/Application Support/Arc/User Data",
            @"Library/Application Support/Microsoft Edge",
            @"Library/Application Support/Chromium",
            @"Library/Application Support/Vivaldi",
        ];
        NSArray<NSString *> *profiles = @[ @"Default", @"Profile 1", @"Profile 2", @"Profile 3" ];
        NSMutableArray<NSString *> *out = [NSMutableArray array];
        for (NSString *root in roots) {
            for (NSString *profile in profiles) {
                [out addObject:[NSString stringWithFormat:@"%@/%@/History", root, profile]];
            }
        }
        paths = out;
    });
    return paths;
}

/// Names that are never read, whatever is switched on (docs/cold-start.md section 5). Counted by NAME only.
+ (NSDictionary<NSString *, NSString *> *)neverReadQueries {
    return @{
        @"credential-file": @"kMDItemFSName == '*.pem'c || kMDItemFSName == '*.key'c || kMDItemFSName == 'id_rsa*'c || "
                            @"kMDItemFSName == '*.p12'c || kMDItemFSName == '*credential*'cd || kMDItemFSName == '*secret*'cd",
        @"keychain-file": @"kMDItemFSName == '*.keychain*'c || kMDItemFSName == '*.kdbx'c || kMDItemFSName == '*.opvault'c",
        @"financial-document": @"kMDItemFSName == '*statement*'cd || kMDItemFSName == '*payslip*'cd || kMDItemFSName == '*paystub*'cd",
        @"health-document": @"kMDItemFSName == '*medical*'cd || kMDItemFSName == '*prescription*'cd || kMDItemFSName == '*lab result*'cd",
        @"identity-document": @"kMDItemFSName == '*passport*'cd || kMDItemFSName == '*birth certificate*'cd || kMDItemFSName == '*drivers licen*'cd",
    };
}

- (NSDictionary<NSString *, NSNumber *> *)neverReadCounts {
    NSMutableDictionary<NSString *, NSNumber *> *counts = [NSMutableDictionary dictionary];
    [[SBScanSources neverReadQueries] enumerateKeysAndObjectsUsingBlock:^(NSString *reason, NSString *query, BOOL *stop) {
        NSInteger count = [self.environment countForSpotlightQuery:query];
        if (count > 0) counts[reason] = @(count);
    }];
    return counts;
}

- (SBScanSource *)spotlightSourceWithDocuments:(NSInteger)documents
                                         cards:(NSInteger)cards
                                        events:(NSInteger)events
                                     manifests:(NSInteger)manifests {
    SBScanSource *source = [SBScanSource sourceWithKind:SBScanKindSpotlight];
    source.permission = SBPermissionNotRequired;
    NSInteger total = MAX(documents, 0) + MAX(cards, 0) + MAX(events, 0) + MAX(manifests, 0);
    if (documents < 0 && cards < 0 && events < 0 && manifests < 0) {
        source.permission = SBPermissionNotRequired;
        source.itemCount = -1;
        source.detail = @"spotlight-unavailable";
    } else {
        source.itemCount = total;
    }
    return source;
}

#pragma mark - the machine sources

/// The Dock's own preference file. Not counted: counting it means reading it, and the panel promises that nothing
/// is read before the switch is on. Readable or not is all this decides.
- (SBScanSource *)dockSource {
    SBScanSource *source = [SBScanSource sourceWithKind:SBScanKindDock];
    NSString *path = [[self.environment homeDirectory] stringByAppendingPathComponent:[SBScanSources dockRelativePath]];
    source.itemCount = -1;
    if ([self.environment isReadableFileAtPath:path]) {
        source.permission = SBPermissionNotRequired;
        source.paths = @[ path ];
    } else {
        source.permission = SBPermissionMissing;
        source.detail = @"no-dock-preferences";
    }
    return source;
}

/// Per-user login agents. Their FILE NAMES are the list; nothing inside one is opened to count them.
- (SBScanSource *)loginItemsSource {
    SBScanSource *source = [SBScanSource sourceWithKind:SBScanKindLoginItems];
    NSString *directory = [[self.environment homeDirectory] stringByAppendingPathComponent:[SBScanSources loginItemsRelativeDirectory]];
    NSArray<NSString *> *names = [self.environment entryNamesAtDirectoryPath:directory];
    NSInteger count = 0;
    for (NSString *name in names) {
        if ([name.pathExtension caseInsensitiveCompare:@"plist"] == NSOrderedSame) count++;
    }
    source.permission = SBPermissionNotRequired;
    source.itemCount = count;
    source.paths = count > 0 ? @[ directory ] : @[];
    if (count == 0) source.detail = @"no-login-items";
    return source;
}

- (SBScanSource *)recentAppsSourceWithCount:(NSInteger)count {
    SBScanSource *source = [SBScanSource sourceWithKind:SBScanKindRecentApps];
    source.permission = SBPermissionNotRequired;
    source.itemCount = count >= 0 ? count : -1;
    if (count < 0) source.detail = @"spotlight-unavailable";
    return source;
}

- (SBScanSource *)recentDocsSourceWithCount:(NSInteger)count {
    SBScanSource *source = [SBScanSource sourceWithKind:SBScanKindRecentDocs];
    source.permission = SBPermissionNotRequired;
    source.itemCount = count >= 0 ? count : -1;
    if (count < 0) source.detail = @"spotlight-unavailable";
    return source;
}

/// What is installed. Directory listings only: an application's own identifier is read at scan time, not here.
- (SBScanSource *)appInventorySource {
    SBScanSource *source = [SBScanSource sourceWithKind:SBScanKindAppInventory];
    source.permission = SBPermissionNotRequired;
    NSMutableArray<NSString *> *roots = [NSMutableArray array];
    NSInteger count = 0;
    for (NSString *root in [SBScanSources applicationRootsForHome:[self.environment homeDirectory]]) {
        NSInteger here = 0;
        for (NSString *name in [self.environment entryNamesAtDirectoryPath:root]) {
            if ([name.pathExtension caseInsensitiveCompare:@"app"] == NSOrderedSame) here++;
        }
        if (here > 0) {
            [roots addObject:root];
            count += here;
        }
    }
    source.itemCount = count;
    source.paths = roots;
    if (count == 0) source.detail = @"no-applications";
    return source;
}

- (SBScanSource *)contactsSourceWithCards:(NSArray<NSString *> *)cards {
    SBScanSource *source = [SBScanSource sourceWithKind:SBScanKindContacts];
    source.permission = [self.environment authorizationStatusForKind:SBScanKindContacts];
    // An exported .vcf the user already has is the one contact path that needs no Contacts permission at all.
    NSMutableArray<NSString *> *readable = [NSMutableArray array];
    for (NSString *path in cards) {
        if ([self.environment isReadableFileAtPath:path]) [readable addObject:path];
        if (readable.count >= self.maxPathsPerSource) break;
    }
    source.paths = readable;
    if (source.permission == SBPermissionGranted) {
        source.itemCount = 1;   // the "me" card
    } else if (readable.count > 0) {
        // Not the Contacts store, but the same facts: a card file the user exported themselves.
        source.permission = SBPermissionGranted;
        source.itemCount = 1;
        source.detail = @"exported-card";
    } else {
        source.itemCount = 0;
        source.detail = @"needs-contacts";
    }
    return source;
}

- (SBScanSource *)resumeSourceWithCount:(NSInteger)count {
    SBScanSource *source = [SBScanSource sourceWithKind:SBScanKindResume];
    source.itemCount = MAX(count, 0);
    NSArray<NSString *> *candidates = count == 0 ? @[] : [self.environment pathsForSpotlightQuery:[SBScanSources queryForResumeDocuments]
                                                                                            limit:self.maxPathsPerSource];
    NSMutableArray<NSString *> *readable = [NSMutableArray array];
    for (NSString *path in candidates) {
        if ([self.environment isReadableFileAtPath:path]) [readable addObject:path];
    }
    source.paths = readable;
    if (count < 0) {
        source.itemCount = -1;
        source.permission = SBPermissionUnknown;
        source.detail = @"spotlight-unavailable";
    } else if (readable.count > 0) {
        source.permission = SBPermissionGranted;
        source.itemCount = (NSInteger)readable.count;
    } else if (count > 0) {
        // Spotlight can see them, this process cannot open them: that is exactly the Files and Folders grant.
        source.permission = SBPermissionMissing;
        source.detail = @"files-not-readable";
    } else {
        source.permission = SBPermissionGranted;
        source.itemCount = 0;
    }
    return source;
}

- (SBScanSource *)browserHistorySource {
    SBScanSource *source = [SBScanSource sourceWithKind:SBScanKindBrowserHistory];
    NSString *home = [self.environment homeDirectory];
    NSMutableArray<NSString *> *readable = [NSMutableArray array];
    for (NSString *relative in [SBScanSources browserHistoryRelativePaths]) {
        NSString *path = [home stringByAppendingPathComponent:relative];
        if ([self.environment isReadableFileAtPath:path]) [readable addObject:path];
    }
    source.paths = readable;
    // Rows are NOT counted: counting them means opening the database, which is the thing the panel promises
    // not to do before the user says yes. The planner plans for the cap instead.
    source.itemCount = -1;
    if (readable.count > 0) {
        source.permission = SBPermissionGranted;
        // Safari is never in `readable`: its history sits under a protected root and is classified, never probed.
        // Saying so here is the difference between "we read your browsers" and "we read the ones we may".
        source.detail = [NSString stringWithFormat:@"%lu-chromium-profile%@, safari-needs-full-disk-access",
                                                   (unsigned long)readable.count, readable.count == 1 ? @"" : @"s"];
    } else {
        source.permission = SBPermissionMissing;
        source.detail = @"no-readable-profile";
    }
    return source;
}

- (SBScanSource *)calendarSourceWithCount:(NSInteger)count {
    SBScanSource *source = [SBScanSource sourceWithKind:SBScanKindCalendar];
    source.permission = [self.environment authorizationStatusForKind:SBScanKindCalendar];
    source.itemCount = count >= 0 ? count : -1;
    source.unavailable = YES;   // no calendar extractor yet (docs/cold-start.md tier 4)
    source.detail = @"not-implemented";
    return source;
}

- (SBScanSource *)mailSource {
    SBScanSource *source = [SBScanSource sourceWithKind:SBScanKindMail];
    // ~/Library/Mail is a protected root: classified, never probed. And there is no signature extractor yet.
    source.permission = SBPermissionMissing;
    source.itemCount = -1;
    source.unavailable = YES;
    source.detail = @"not-implemented";
    return source;
}

- (SBScanSource *)projectsSourceWithCount:(NSInteger)count {
    SBScanSource *source = [SBScanSource sourceWithKind:SBScanKindProjects];
    source.itemCount = MAX(count, 0);
    NSArray<NSString *> *manifests = count == 0 ? @[] : [self.environment pathsForSpotlightQuery:[SBScanSources queryForProjectManifests]
                                                                                           limit:self.maxPathsPerSource];
    NSMutableArray<NSString *> *readable = [NSMutableArray array];
    for (NSString *path in manifests) {
        // A manifest inside node_modules is somebody else's package, not the user's project.
        if ([path containsString:@"/node_modules/"]) continue;
        if ([self.environment isReadableFileAtPath:path]) [readable addObject:path];
    }
    source.paths = readable;
    if (count < 0) {
        source.itemCount = -1;
        source.permission = SBPermissionUnknown;
        source.detail = @"spotlight-unavailable";
    } else if (readable.count > 0) {
        source.permission = SBPermissionGranted;
        source.itemCount = (NSInteger)readable.count;
    } else if (count > 0) {
        source.permission = SBPermissionMissing;
        source.detail = @"files-not-readable";
    } else {
        source.permission = SBPermissionGranted;
        source.itemCount = 0;
    }
    return source;
}

- (NSArray<SBScanSource *> *)discover {
    NSInteger resumeCount = [self.environment countForSpotlightQuery:[SBScanSources queryForResumeDocuments]];
    NSInteger cardCount = [self.environment countForSpotlightQuery:[SBScanSources queryForVCards]];
    NSInteger eventCount = [self.environment countForSpotlightQuery:[SBScanSources queryForCalendarFiles]];
    NSInteger projectCount = [self.environment countForSpotlightQuery:[SBScanSources queryForProjectManifests]];
    NSArray<NSString *> *cards = cardCount <= 0 ? @[] : [self.environment pathsForSpotlightQuery:[SBScanSources queryForVCards] limit:self.maxPathsPerSource];
    NSInteger recentApps = [self.environment countForSystemSpotlightQuery:[SBScanSources queryForRecentApplications]];
    NSInteger recentDocs = -1;
    for (NSString *query in [SBScanSources queriesForRecentDocumentClasses].allValues) {
        NSInteger here = [self.environment countForSpotlightQuery:query];
        if (here >= 0) recentDocs = MAX(recentDocs, 0) + here;
    }
    return @[
        [self spotlightSourceWithDocuments:resumeCount cards:cardCount events:eventCount manifests:projectCount],
        [self dockSource],
        [self loginItemsSource],
        [self recentAppsSourceWithCount:recentApps],
        [self recentDocsSourceWithCount:recentDocs],
        [self appInventorySource],
        [self contactsSourceWithCards:cards],
        [self resumeSourceWithCount:resumeCount],
        [self browserHistorySource],
        [self calendarSourceWithCount:eventCount],
        [self mailSource],
        [self projectsSourceWithCount:projectCount],
    ];
}

@end
