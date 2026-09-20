#import "SBColdStart.h"
#import "SBCore.h"
#import "SBLog.h"
#import "SBProfileStore.h"
#include <dlfcn.h>
#include <stdatomic.h>
#include <time.h>

// Internal helpers, defined at the bottom of this file.
/// A history row with everything but the shape thrown away: bare host, generalised path, epoch milliseconds.
/// The full URL never leaves this function, not even into the JavaScript core.
static NSDictionary<NSString *, id> *SBColdStartHistoryRow(NSString *url, long long webkitMicroseconds, NSString *fromURL);
/// "/watch/1234/abcdef" -> "/watch/:id/:id": the shape a page kind can be guessed from, never the page.
static NSString *SBColdStartPathPattern(NSString *path);
/// The `url = ` lines of a git config. Nothing else in the file is looked at.
static NSArray<NSString *> *SBColdStartRemotesInGitConfig(NSString *text);
/// Letters only, so a scan id can never be mistaken for a number, a path or anything personal.
static NSString *SBColdStartNewScanIdentifier(void);
static NSDate *_Nullable SBColdStartParseMetadataDate(id value);

NSString *SBColdStartStopName(SBColdStartStop stop) {
    switch (stop) {
        case SBColdStartStopFinished: return @"finished";
        case SBColdStartStopBudget: return @"budget";
        case SBColdStartStopCancelled: return @"cancelled";
        case SBColdStartStopNoCore: return @"no-core";
    }
    return @"finished";
}

SBColdStartBudget SBColdStartDefaultBudget(void) {
    return (SBColdStartBudget){ .wallClockSeconds = 60.0, .maxFiles = 500, .maxBytesPerFile = 2 * 1024 * 1024 };
}

#pragma mark - the real files

/// Extensions read straight off disk. Small, plain, and no subprocess.
static NSSet<NSString *> *SBPlainTextExtensions(void) {
    static NSSet<NSString *> *set;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        set = [NSSet setWithArray:@[ @"txt", @"text", @"md", @"markdown", @"vcf", @"vcard", @"json", @"config", @"ini", @"yml", @"yaml" ]];
    });
    return set;
}

/// Extensions textutil can turn into plain text.
static NSSet<NSString *> *SBTextutilExtensions(void) {
    static NSSet<NSString *> *set;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        set = [NSSet setWithArray:@[ @"doc", @"docx", @"rtf", @"rtfd", @"odt", @"html", @"htm", @"wordml", @"webarchive" ]];
    });
    return set;
}

/// Chromium visit_time is microseconds since 1601-01-01; this is the gap to the Unix epoch, in milliseconds.
static const long long kWebkitEpochOffsetMs = 11644473600000LL;

@implementation SBColdStartFilesMac

- (instancetype)init {
    if ((self = [super init])) _subprocessTimeout = 10.0;
    return self;
}

/// One subprocess, argument vector only, with a deadline and a capped amount of output. nil on any failure.
- (nullable NSString *)runTool:(NSString *)tool arguments:(NSArray<NSString *> *)arguments maxBytes:(NSUInteger)maxBytes {
    if (![NSFileManager.defaultManager isExecutableFileAtPath:tool]) return nil;
    NSTask *task = [[NSTask alloc] init];
    task.executableURL = [NSURL fileURLWithPath:tool];
    task.arguments = arguments;
    NSPipe *out = [NSPipe pipe];
    task.standardOutput = out;
    task.standardError = [NSFileHandle fileHandleWithNullDevice];
    task.standardInput = [NSFileHandle fileHandleWithNullDevice];
    if (![task launchAndReturnError:NULL]) return nil;
    __block NSMutableData *data = [NSMutableData data];
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    NSFileHandle *handle = out.fileHandleForReading;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        NSData *chunk = nil;
        while ((chunk = [handle availableData]).length > 0) {
            if (data.length < maxBytes) [data appendData:chunk];
        }
        dispatch_semaphore_signal(done);
    });
    if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(self.subprocessTimeout * NSEC_PER_SEC))) != 0) {
        [task terminate];
        SBLog(@"cold-start: %@ timed out", tool.lastPathComponent);
        return nil;
    }
    [task waitUntilExit];
    if (task.terminationStatus != 0) return nil;
    if (data.length > maxBytes) [data setLength:maxBytes];
    NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    return text ?: [[NSString alloc] initWithData:data encoding:NSISOLatin1StringEncoding];
}

/// PDFKit without linking it: the framework is dlopen()ed on first use, which needs no permission and shows
/// no dialog. A machine without it simply yields no PDF text.
- (nullable NSString *)textOfPDFAtPath:(NSString *)path maxBytes:(NSUInteger)maxBytes {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        if (!NSClassFromString(@"PDFDocument")) dlopen("/System/Library/Frameworks/Quartz.framework/Quartz", RTLD_LAZY);
    });
    Class documentClass = NSClassFromString(@"PDFDocument");
    if (!documentClass) return nil;
    NSURL *url = [NSURL fileURLWithPath:path];
    SEL initWithURL = NSSelectorFromString(@"initWithURL:");
    id document = [documentClass alloc];
    NSMethodSignature *initSignature = [document methodSignatureForSelector:initWithURL];
    if (!initSignature) return nil;
    NSInvocation *initCall = [NSInvocation invocationWithMethodSignature:initSignature];
    initCall.selector = initWithURL;
    [initCall setArgument:&url atIndex:2];
    [initCall invokeWithTarget:document];
    void *raw = NULL;
    [initCall getReturnValue:&raw];
    id opened = (__bridge id)raw;
    if (!opened) return nil;
    SEL stringSelector = NSSelectorFromString(@"string");
    NSMethodSignature *stringSignature = [opened methodSignatureForSelector:stringSelector];
    if (!stringSignature) return nil;
    NSInvocation *stringCall = [NSInvocation invocationWithMethodSignature:stringSignature];
    stringCall.selector = stringSelector;
    [stringCall invokeWithTarget:opened];
    void *rawText = NULL;
    [stringCall getReturnValue:&rawText];
    NSString *text = (__bridge NSString *)rawText;
    if (![text isKindOfClass:NSString.class]) return nil;
    return text.length * 4 > maxBytes ? [text substringToIndex:MIN(text.length, maxBytes / 4)] : text;
}

- (nullable NSString *)textOfFileAtPath:(NSString *)path maxBytes:(NSUInteger)maxBytes {
    if (path.length == 0 || maxBytes == 0) return nil;
    NSString *extension = path.pathExtension.lowercaseString;
    NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:path error:NULL];
    if (!attributes || ![attributes[NSFileType] isEqual:NSFileTypeRegular]) return nil;
    unsigned long long size = [attributes[NSFileSize] unsignedLongLongValue];
    // A file bigger than the per-item cap is not truncated into nonsense: it is left alone and counted as skipped.
    if (size > maxBytes) return nil;
    if ([SBPlainTextExtensions() containsObject:extension]) {
        NSData *data = [NSData dataWithContentsOfFile:path options:NSDataReadingMappedIfSafe error:NULL];
        if (!data) return nil;
        if (data.length > maxBytes) data = [data subdataWithRange:NSMakeRange(0, maxBytes)];
        NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
        return text ?: [[NSString alloc] initWithData:data encoding:NSISOLatin1StringEncoding];
    }
    if ([SBTextutilExtensions() containsObject:extension]) {
        return [self runTool:@"/usr/bin/textutil" arguments:@[ @"-convert", @"txt", @"-stdout", path ] maxBytes:maxBytes];
    }
    if ([extension isEqualToString:@"pdf"]) return [self textOfPDFAtPath:path maxBytes:maxBytes];
    return nil;
}

- (nullable NSString *)copyOfDatabaseAtPath:(NSString *)path {
    NSFileManager *fm = NSFileManager.defaultManager;
    if (![fm isReadableFileAtPath:path]) return nil;
    NSString *directory = [NSTemporaryDirectory() stringByAppendingPathComponent:
                              [NSString stringWithFormat:@"ghost-coldstart-%@", NSUUID.UUID.UUIDString]];
    if (![fm createDirectoryAtPath:directory withIntermediateDirectories:YES
                        attributes:@{ NSFilePosixPermissions: @(0700) } error:NULL]) return nil;
    NSString *copy = [directory stringByAppendingPathComponent:@"history.db"];
    if (![fm copyItemAtPath:path toPath:copy error:NULL]) {
        [fm removeItemAtPath:directory error:NULL];
        return nil;
    }
    // The write-ahead log holds the newest visits; without it the copy is simply older, never wrong.
    for (NSString *suffix in @[ @"-wal", @"-shm" ]) {
        NSString *side = [path stringByAppendingString:suffix];
        if ([fm isReadableFileAtPath:side]) [fm copyItemAtPath:side toPath:[copy stringByAppendingString:suffix] error:NULL];
    }
    return copy;
}

- (NSArray<NSDictionary<NSString *, id> *> *)historyRowsFromCopyAtPath:(NSString *)copyPath limit:(NSUInteger)limit {
    if (copyPath.length == 0 || limit == 0) return @[];
    NSString *unit = [NSString stringWithFormat:@"%C", (unichar)0x1f];
    NSString *newline = [NSString stringWithFormat:@"%C", (unichar)0x1e];
    NSString *sql = [NSString stringWithFormat:
        @"SELECT u.url, v.visit_time, IFNULL((SELECT p.url FROM visits pv JOIN urls p ON p.id = pv.url WHERE pv.id = v.from_visit), '') "
        @"FROM visits v JOIN urls u ON u.id = v.url ORDER BY v.visit_time DESC LIMIT %lu;", (unsigned long)limit];
    NSString *text = [self runTool:@"/usr/bin/sqlite3"
                         arguments:@[ @"-readonly", @"-separator", unit, @"-newline", newline, copyPath, sql ]
                          maxBytes:16 * 1024 * 1024];
    if (text.length == 0) return @[];
    NSMutableArray<NSDictionary<NSString *, id> *> *rows = [NSMutableArray array];
    for (NSString *line in [text componentsSeparatedByString:newline]) {
        NSArray<NSString *> *columns = [line componentsSeparatedByString:unit];
        if (columns.count < 2) continue;
        NSDictionary *row = SBColdStartHistoryRow(columns[0], [columns[1] longLongValue], columns.count > 2 ? columns[2] : @"");
        if (row) [rows addObject:row];
        if (rows.count >= limit) break;
    }
    return rows;
}

- (void)removeCopyAtPath:(NSString *)copyPath {
    if (copyPath.length == 0) return;
    NSString *directory = copyPath.stringByDeletingLastPathComponent;
    // The copy lives alone in a directory this class made: removing it takes the -wal and -shm files with it.
    if ([directory.lastPathComponent hasPrefix:@"ghost-coldstart-"]) {
        [NSFileManager.defaultManager removeItemAtPath:directory error:NULL];
        return;
    }
    [NSFileManager.defaultManager removeItemAtPath:copyPath error:NULL];
}

- (nullable NSString *)meCardText {
    // Contacts is not linked into this build on purpose: the scan never triggers a permission dialog. The panel
    // reports "needs permission: Contacts ..." instead, and an exported .vcf is read as an ordinary file.
    return nil;
}

@end

#pragma mark - rows, reduced before they are ever held

static NSDictionary<NSString *, id> *SBColdStartHistoryRow(NSString *url, long long webkitMicroseconds, NSString *fromURL) {
    if (url.length == 0 || url.length > 2048) return nil;
    NSURLComponents *components = [NSURLComponents componentsWithString:url];
    NSString *host = components.host.lowercaseString;
    if (host.length == 0) return nil;
    long long unixMs = webkitMicroseconds / 1000 - kWebkitEpochOffsetMs;
    if (unixMs <= 0) return nil;
    NSMutableDictionary *row = [NSMutableDictionary dictionary];
    row[@"origin"] = host;
    row[@"visitedAt"] = @(unixMs);
    NSString *pattern = SBColdStartPathPattern(components.path);
    if (pattern.length > 0) row[@"pathPattern"] = pattern;
    NSString *fromHost = fromURL.length > 0 ? [NSURLComponents componentsWithString:fromURL].host.lowercaseString : nil;
    if (fromHost.length > 0) row[@"transitionFromOrigin"] = fromHost;
    return row;
}

static NSString *SBColdStartPathPattern(NSString *path) {
    if (path.length == 0) return @"";
    NSMutableArray<NSString *> *out = [NSMutableArray array];
    for (NSString *segment in [path componentsSeparatedByString:@"/"]) {
        if (segment.length == 0) continue;
        BOOL identifierLike = segment.length > 12;
        if (!identifierLike) {
            NSCharacterSet *digits = [NSCharacterSet characterSetWithCharactersInString:@"0123456789"];
            identifierLike = [segment rangeOfCharacterFromSet:digits.invertedSet].location == NSNotFound;
        }
        [out addObject:identifierLike ? @":id" : segment.lowercaseString];
        if (out.count >= 3) break;
    }
    return out.count == 0 ? @"" : [@"/" stringByAppendingString:[out componentsJoinedByString:@"/"]];
}

#pragma mark - proposals

@implementation SBColdStartProposal

- (NSDictionary<NSString *, id> *)reportObject {
    // Everything a reviewer needs and nothing that identifies anyone: no value, no file name, no snippet.
    return @{
        @"id": self.identifier ?: @"",
        @"key": self.key ?: @"",
        @"label": self.label ?: @"",
        @"category": self.category ?: @"other",
        @"confidence": @(round(self.confidence * 100) / 100.0),
        @"support": @(self.support),
        @"sourceKind": self.sourceKind ?: @"",
        @"provenanceKind": self.provenanceKind ?: @"file",
        @"valueChars": @((NSInteger)self.value.length),
        @"accepted": @NO,
    };
}

- (NSDictionary<NSString *, id> *)pendingObject {
    return @{
        @"id": self.identifier ?: @"",
        @"key": self.key ?: @"",
        @"value": self.value ?: @"",
        @"label": self.label ?: @"",
        @"category": self.category ?: @"other",
        @"confidence": @(self.confidence),
        @"sourceKind": self.sourceKind ?: @"",
        @"provenanceKind": self.provenanceKind ?: @"file",
    };
}

@end

@implementation SBColdStartResult

- (instancetype)init {
    if ((self = [super init])) {
        _proposals = @[];
        _screenKinds = @[];
        _sourceReports = @[];
        _skippedCounts = @{};
        _scanIdentifier = @"";
    }
    return self;
}

- (NSDictionary<NSString *, id> *)reportObject {
    NSMutableArray *proposals = [NSMutableArray array];
    for (SBColdStartProposal *proposal in self.proposals) [proposals addObject:proposal.reportObject];
    NSMutableDictionary *report = [NSMutableDictionary dictionary];
    report[@"coldStart"] = @{ @"version": @1, @"scanId": self.scanIdentifier, @"local": @YES };
    report[@"sources"] = self.sourceReports;
    report[@"proposals"] = proposals;
    report[@"skipped"] = @{ @"total": @(self.skippedTotal), @"byReason": self.skippedCounts };
    report[@"budget"] = @{
        @"filesOpened": @(self.filesOpened),
        @"elapsedMs": @((NSInteger)(self.elapsedSeconds * 1000)),
        @"stop": SBColdStartStopName(self.stop),
    };
    if (self.habits) report[@"habits"] = self.habits;
    if (self.surfaces) report[@"surfaces"] = self.surfaces;
    if (self.screenKinds.count > 0) report[@"screenKinds"] = self.screenKinds;
    if (self.plan) {
        report[@"plan"] = @{
            @"totals": self.plan[@"totals"] ?: @{},
            @"needsPermission": self.plan[@"needsPermission"] ?: @[],
            @"neverRead": self.plan[@"neverRead"] ?: @[],
        };
    }
    return report;
}

- (NSDictionary<NSString *, id> *)pendingObject {
    NSMutableArray *proposals = [NSMutableArray array];
    for (SBColdStartProposal *proposal in self.proposals) [proposals addObject:proposal.pendingObject];
    NSMutableDictionary *pending = [NSMutableDictionary dictionary];
    pending[@"scanId"] = self.scanIdentifier;
    pending[@"proposals"] = proposals;
    if (self.roleMemory) pending[@"roleMemory"] = self.roleMemory;
    // The full aggregates name places. They live here, at 0600, and only until --apply has seeded the graph.
    if (self.historyAggregate) pending[@"historyAggregate"] = self.historyAggregate;
    if (self.surfaceAggregate) pending[@"surfaceAggregate"] = self.surfaceAggregate;
    if (self.screenKinds.count > 0) pending[@"screenKinds"] = self.screenKinds;
    return pending;
}

@end

#pragma mark - the value-free gate

/// A string that would give away a place on this machine or a person: a path, a URL, an address, a long number.
static NSString *_Nullable SBColdStartLeakInString(NSString *text) {
    static NSArray<NSRegularExpression *> *patterns;
    static NSArray<NSString *> *names;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSArray<NSString *> *sources = @[
            @"[A-Za-z][A-Za-z0-9+.-]*://",                              // any URL
            @"(^|[\\s\"'\\[(:,])(~|\\.{0,2})/[A-Za-z0-9._~%-]+/",       // a path with at least two segments
            @"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}",         // an e-mail address
            @"[0-9]{7,}",                                                // a phone number, a card, an id
        ];
        NSMutableArray *compiled = [NSMutableArray array];
        for (NSString *source in sources) {
            NSRegularExpression *expression = [NSRegularExpression regularExpressionWithPattern:source options:0 error:NULL];
            if (expression) [compiled addObject:expression];
        }
        patterns = compiled;
        names = @[ @"url", @"path", @"email", @"digits" ];
    });
    for (NSUInteger i = 0; i < patterns.count; i++) {
        if ([patterns[i] numberOfMatchesInString:text options:0 range:NSMakeRange(0, text.length)] > 0) {
            return names[MIN(i, names.count - 1)];
        }
    }
    return nil;
}

BOOL SBColdStartIsValueFree(id object, NSString **offender) {
    if ([object isKindOfClass:NSString.class]) {
        NSString *leak = SBColdStartLeakInString(object);
        if (leak) {
            if (offender) *offender = leak;
            return NO;
        }
        return YES;
    }
    if ([object isKindOfClass:NSArray.class]) {
        for (id item in (NSArray *)object) if (!SBColdStartIsValueFree(item, offender)) return NO;
        return YES;
    }
    if ([object isKindOfClass:NSDictionary.class]) {
        // `offender` is an autoreleasing out-parameter and must not be captured by the block; a __block local
        // carries the answer out instead, which is also the only version that is safe across an autorelease pool.
        __block BOOL clean = YES;
        __block NSString *found = nil;
        [(NSDictionary *)object enumerateKeysAndObjectsUsingBlock:^(id key, id value, BOOL *stop) {
            NSString *leak = nil;
            if (!SBColdStartIsValueFree(key, &leak) || !SBColdStartIsValueFree(value, &leak)) {
                clean = NO;
                found = leak;
                *stop = YES;
            }
        }];
        if (!clean && offender) *offender = found;
        return clean;
    }
    return YES;   // numbers, booleans, null
}

#pragma mark - the run

@interface SBColdStartSystemClock : NSObject <SBColdStartClock>
@end

@implementation SBColdStartSystemClock
- (NSTimeInterval)nowSeconds {
    return (NSTimeInterval)clock_gettime_nsec_np(CLOCK_MONOTONIC) / NSEC_PER_SEC;
}
@end

@interface SBColdStart ()
@property (nonatomic, strong, nullable) SBCore *core;
@property (nonatomic, strong) id<SBColdStartFiles> files;
@property (nonatomic) NSTimeInterval startedAt;
@property (nonatomic) NSUInteger filesOpened;
@end

@implementation SBColdStart {
    _Atomic(BOOL) _cancelled;
}

- (instancetype)initWithCore:(SBCore *)core files:(id<SBColdStartFiles>)files {
    if ((self = [super init])) {
        _core = core;
        _files = files;
        _budget = SBColdStartDefaultBudget();
        _clock = [[SBColdStartSystemClock alloc] init];
        _timeZoneOffsetMinutes = NSTimeZone.localTimeZone.secondsFromGMT / 60;
        _habitMinVisits = 3;
    }
    return self;
}

- (void)cancel {
    atomic_store(&_cancelled, YES);
}

- (BOOL)cancelled {
    return atomic_load(&_cancelled);
}

- (NSTimeInterval)elapsed {
    return [self.clock nowSeconds] - self.startedAt;
}

/// The one place the budget is enforced: between every item, for every source.
- (BOOL)mayContinue:(SBColdStartStop *)stop {
    if (self.cancelled) {
        if (stop) *stop = SBColdStartStopCancelled;
        return NO;
    }
    if ([self elapsed] >= self.budget.wallClockSeconds) {
        if (stop) *stop = SBColdStartStopBudget;
        return NO;
    }
    if (self.filesOpened >= self.budget.maxFiles) {
        if (stop) *stop = SBColdStartStopBudget;
        return NO;
    }
    return YES;
}

- (nullable NSDictionary<NSString *, id> *)planForSources:(NSArray<SBScanSource *> *)sources enabledKinds:(NSSet<NSString *> *)enabledKinds {
    NSMutableArray *descriptors = [NSMutableArray array];
    for (SBScanSource *source in sources) {
        BOOL enabled = [enabledKinds containsObject:source.kind] && !source.unavailable;
        [descriptors addObject:[source descriptorEnabled:enabled]];
    }
    NSString *json = SBJSONString(descriptors);
    NSString *answer = json ? [self.core callString:@"coldStartPlan" arguments:@[ json ]] : nil;
    id plan = SBJSONParse(answer);
    return [plan isKindOfClass:NSDictionary.class] ? plan : nil;
}

/// `{ sourceKind, fileName }` -- the provenance the extractors record. The file NAME stays private.
- (NSString *)originJSONForKind:(NSString *)kind fileName:(NSString *)fileName {
    return SBJSONString(@{ @"sourceKind": kind, @"fileName": fileName ?: @"local file" }) ?: @"{}";
}

/// The sensitivity gate, before a file is opened. YES when it must not be read.
- (BOOL)isSensitiveCandidate:(NSDictionary *)candidate reason:(NSString **)reason {
    NSString *json = SBJSONString(candidate);
    NSString *answer = json ? [self.core callString:@"coldStartClassify" arguments:@[ json ]] : nil;
    id verdict = SBJSONParse(answer);
    if (![verdict isKindOfClass:NSDictionary.class]) {
        if (reason) *reason = @"sensitive-label";
        return YES;   // fail closed: an unreadable verdict means the file is not read
    }
    BOOL sensitive = [verdict[@"sensitive"] boolValue];
    if (sensitive && reason) *reason = verdict[@"reason"] ?: @"sensitive-label";
    return sensitive;
}

- (nullable NSDictionary *)extractionFrom:(NSString *)function arguments:(NSArray<NSString *> *)arguments {
    NSString *answer = [self.core callString:function arguments:arguments];
    id result = SBJSONParse(answer);
    return [result isKindOfClass:NSDictionary.class] ? result : nil;
}

- (SBColdStartResult *)runSources:(NSArray<SBScanSource *> *)sources enabledKinds:(NSSet<NSString *> *)enabledKinds {
    SBColdStartResult *result = [[SBColdStartResult alloc] init];
    result.scanIdentifier = SBColdStartNewScanIdentifier();
    self.startedAt = [self.clock nowSeconds];
    self.filesOpened = 0;
    atomic_store(&_cancelled, NO);

    NSDictionary *plan = [self planForSources:sources enabledKinds:enabledKinds];
    result.plan = plan;
    if (!self.core || !plan) {
        result.stop = SBColdStartStopNoCore;
        result.elapsedSeconds = [self elapsed];
        SBLog(@"cold-start: no core bundle; nothing was read");
        return result;
    }

    NSMutableDictionary<NSString *, SBScanSource *> *byKind = [NSMutableDictionary dictionary];
    for (SBScanSource *source in sources) byKind[source.kind] = source;

    NSMutableArray<NSDictionary *> *extractions = [NSMutableArray array];
    // What the machine sources noticed about PLACES. Ids only become opaque tokens in the shared rules, which is
    // also where anything malformed is dropped: nothing native decides what a surface is.
    NSMutableArray<NSDictionary *> *observations = [NSMutableArray array];
    NSMutableArray<NSDictionary *> *screenKinds = [NSMutableArray array];
    NSMutableArray<NSDictionary *> *reports = [NSMutableArray array];
    NSMutableDictionary<NSString *, NSNumber *> *skipped = [NSMutableDictionary dictionary];
    SBColdStartStop stop = SBColdStartStopFinished;

    for (NSDictionary *row in (NSArray *)(plan[@"sources"] ?: @[])) {
        NSString *kind = row[@"kind"];
        SBScanSource *source = byKind[kind];
        NSString *status = row[@"status"] ?: @"off";
        NSMutableDictionary *report = [NSMutableDictionary dictionary];
        report[@"kind"] = kind ?: @"";
        report[@"status"] = status;
        report[@"permission"] = row[@"permission"] ?: @"unknown";
        report[@"plannedItems"] = row[@"plannedItems"] ?: @0;
        report[@"opened"] = @0;
        report[@"proposals"] = @0;
        if (row[@"needsPermission"]) report[@"needsPermission"] = row[@"needsPermission"];
        if (source.detail) report[@"detail"] = source.detail;
        if (source.unavailable) report[@"unavailable"] = @YES;

        if (![status isEqualToString:@"ready"] || !source) {
            [reports addObject:report];
            continue;
        }
        if (![self mayContinue:&stop]) {
            report[@"status"] = @"stopped";
            [reports addObject:report];
            break;
        }

        NSUInteger planned = [row[@"plannedItems"] unsignedIntegerValue];
        NSUInteger maxBytes = [row[@"caps"][@"maxBytesPerItem"] unsignedIntegerValue] ?: self.budget.maxBytesPerFile;
        maxBytes = MIN(maxBytes, self.budget.maxBytesPerFile);
        NSUInteger opened = 0;
        NSUInteger produced = 0;
        NSArray<NSDictionary *> *found = @[];

        if ([kind isEqualToString:SBScanKindContacts]) {
            found = [self readContacts:source maxBytes:maxBytes opened:&opened skipped:skipped stop:&stop];
        } else if ([kind isEqualToString:SBScanKindResume]) {
            found = [self readDocuments:source limit:planned maxBytes:maxBytes opened:&opened skipped:skipped stop:&stop];
        } else if ([kind isEqualToString:SBScanKindProjects]) {
            found = [self readProjects:source limit:planned maxBytes:maxBytes opened:&opened skipped:skipped stop:&stop];
        } else if ([kind isEqualToString:SBScanKindBrowserHistory]) {
            result.habits = [self readHistory:source limit:planned roleMemory:^(NSDictionary *memory) {
                result.roleMemory = memory;
            } aggregate:^(NSDictionary *whole) {
                result.historyAggregate = whole;
            } opened:&opened stop:&stop];
        } else if ([kind isEqualToString:SBScanKindDock]) {
            [observations addObjectsFromArray:[self readDock:source opened:&opened]];
        } else if ([kind isEqualToString:SBScanKindLoginItems]) {
            [observations addObjectsFromArray:[self readLoginItems:source limit:planned opened:&opened]];
        } else if ([kind isEqualToString:SBScanKindRecentApps]) {
            [observations addObjectsFromArray:[self readRecentApps:source limit:planned]];
        } else if ([kind isEqualToString:SBScanKindRecentDocs]) {
            [screenKinds addObjectsFromArray:[self readRecentDocumentKinds]];
        } else if ([kind isEqualToString:SBScanKindAppInventory]) {
            [observations addObjectsFromArray:[self readAppInventory:source limit:planned opened:&opened stop:&stop]];
        }
        if ([kind isEqualToString:SBScanKindDock] || [kind isEqualToString:SBScanKindLoginItems] ||
            [kind isEqualToString:SBScanKindRecentApps] || [kind isEqualToString:SBScanKindAppInventory]) {
            if (!self.environment) report[@"detail"] = @"no-environment";
        }

        for (NSDictionary *extraction in found) {
            [extractions addObject:extraction];
            produced += [(NSArray *)(extraction[@"proposals"] ?: @[]) count];
        }
        report[@"opened"] = @(opened);
        report[@"proposals"] = @(produced);
        [reports addObject:report];
        if (stop != SBColdStartStopFinished) break;
    }

    // Places, folded into counters. Transitions come from the history aggregate, which is the only source on the
    // machine that can say what follows what without a watcher running.
    result.screenKinds = screenKinds;
    if (observations.count > 0) {
        NSArray *transitions = [result.historyAggregate[@"transitions"] isKindOfClass:NSArray.class]
                                   ? result.historyAggregate[@"transitions"] : @[];
        NSString *answer = [self.core callString:@"coldStartSurfaces"
                                       arguments:@[ SBJSONString(observations) ?: @"[]", SBJSONString(transitions) ?: @"[]", @"{}" ]];
        id aggregate = SBJSONParse(answer);
        if ([aggregate isKindOfClass:NSDictionary.class]) {
            result.surfaceAggregate = aggregate;
            // The per-surface rows name places: they stay in the private half. The report gets counts and kinds.
            NSMutableDictionary *visible = [NSMutableDictionary dictionary];
            for (NSString *key in @[ @"kinds", @"bySource", @"dropped", @"capped", @"totalVisits", @"summary" ]) {
                if (aggregate[key]) visible[key] = aggregate[key];
            }
            visible[@"surfaces"] = @([(NSArray *)(aggregate[@"surfaces"] ?: @[]) count]);
            visible[@"transitions"] = @([(NSArray *)(aggregate[@"transitions"] ?: @[]) count]);
            result.surfaces = visible;
        }
    }

    // One merge over everything: the same key and value from two sources becomes one proposal with more support.
    NSString *mergedJSON = [self.core callString:@"coldStartMerge" arguments:@[ SBJSONString(extractions) ?: @"[]" ]];
    NSDictionary *merged = SBJSONParse(mergedJSON);
    NSArray *proposals = [merged isKindOfClass:NSDictionary.class] ? merged[@"proposals"] : @[];
    NSMutableArray<SBColdStartProposal *> *out = [NSMutableArray array];
    NSUInteger index = 0;
    for (NSDictionary *raw in (proposals ?: @[])) {
        if (![raw isKindOfClass:NSDictionary.class]) continue;
        SBColdStartProposal *proposal = [[SBColdStartProposal alloc] init];
        proposal.identifier = [NSString stringWithFormat:@"p%lu", (unsigned long)++index];
        proposal.key = raw[@"key"] ?: @"";
        proposal.value = raw[@"value"] ?: @"";
        proposal.label = raw[@"label"] ?: proposal.key;
        proposal.category = raw[@"category"] ?: @"other";
        proposal.confidence = [raw[@"confidence"] doubleValue];
        proposal.support = MAX(1, [raw[@"support"] integerValue]);
        proposal.sourceKind = raw[@"sourceKind"] ?: @"";
        id provenance = raw[@"source"];
        proposal.provenanceKind = [provenance isKindOfClass:NSDictionary.class] ? (provenance[@"kind"] ?: @"file") : @"file";
        if (proposal.key.length > 0 && proposal.value.length > 0) [out addObject:proposal];
    }

    NSDictionary *mergedCounts = [merged isKindOfClass:NSDictionary.class] ? merged[@"skippedCounts"] : nil;
    for (NSString *reason in mergedCounts) {
        skipped[reason] = @([skipped[reason] integerValue] + [mergedCounts[reason] integerValue]);
    }
    NSInteger skippedTotal = 0;
    for (NSNumber *count in skipped.allValues) skippedTotal += count.integerValue;

    result.proposals = out;
    result.sourceReports = reports;
    result.skippedCounts = skipped;
    result.skippedTotal = (NSUInteger)skippedTotal;
    result.filesOpened = self.filesOpened;
    result.elapsedSeconds = [self elapsed];
    result.stop = stop;
    SBLog(@"cold-start: %lu proposals from %lu files in %.1f s (%@), %ld skipped as sensitive",
          (unsigned long)out.count, (unsigned long)self.filesOpened, result.elapsedSeconds, SBColdStartStopName(stop), (long)skippedTotal);
    return result;
}

- (void)runSources:(NSArray<SBScanSource *> *)sources
      enabledKinds:(NSSet<NSString *> *)enabledKinds
        completion:(void (^)(SBColdStartResult *))completion {
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        SBColdStartResult *result = [self runSources:sources enabledKinds:enabledKinds];
        dispatch_async(dispatch_get_main_queue(), ^{ completion(result); });
    });
}

#pragma mark - per source

- (void)count:(NSMutableDictionary<NSString *, NSNumber *> *)counts reason:(NSString *)reason {
    if (reason.length == 0) reason = @"sensitive-label";
    counts[reason] = @([counts[reason] integerValue] + 1);
}

/// Tier 1. The Contacts store itself is never opened without the grant; an exported .vcf is an ordinary file.
- (NSArray<NSDictionary *> *)readContacts:(SBScanSource *)source
                                 maxBytes:(NSUInteger)maxBytes
                                   opened:(NSUInteger *)opened
                                  skipped:(NSMutableDictionary<NSString *, NSNumber *> *)skipped
                                     stop:(SBColdStartStop *)stop {
    NSString *text = [self.files meCardText];
    NSString *fileName = @"contact card";
    if (text.length == 0) {
        NSString *path = source.paths.firstObject;
        if (path.length == 0) return @[];
        fileName = path.lastPathComponent;
        NSString *reason = nil;
        if ([self isSensitiveCandidate:@{ @"pathKind": @"contact-card", @"fileName": fileName } reason:&reason]) {
            [self count:skipped reason:reason];
            return @[];
        }
        text = [self.files textOfFileAtPath:path maxBytes:maxBytes];
        self.filesOpened++;
        (*opened)++;
        if (text.length == 0) return @[];
    }
    NSDictionary *extraction = [self extractionFrom:@"coldStartVCard"
                                          arguments:@[ text, [self originJSONForKind:SBScanKindContacts fileName:fileName], @"{\"firstCardOnly\":true}" ]];
    return extraction ? @[ extraction ] : @[];
}

/// Tier 2. Résumé-shaped documents: the name is screened, then the text, then the extractor.
- (NSArray<NSDictionary *> *)readDocuments:(SBScanSource *)source
                                     limit:(NSUInteger)limit
                                  maxBytes:(NSUInteger)maxBytes
                                    opened:(NSUInteger *)opened
                                   skipped:(NSMutableDictionary<NSString *, NSNumber *> *)skipped
                                      stop:(SBColdStartStop *)stop {
    NSMutableArray<NSDictionary *> *out = [NSMutableArray array];
    for (NSString *path in source.paths) {
        if (*opened >= limit) break;
        if (![self mayContinue:stop]) break;
        NSString *fileName = path.lastPathComponent;
        NSString *reason = nil;
        if ([self isSensitiveCandidate:@{ @"pathKind": @"document", @"fileName": fileName } reason:&reason]) {
            [self count:skipped reason:reason];
            continue;
        }
        NSString *text = [self.files textOfFileAtPath:path maxBytes:maxBytes];
        self.filesOpened++;
        (*opened)++;
        if (text.length == 0) continue;
        NSDictionary *extraction = [self extractionFrom:@"coldStartResumeText"
                                              arguments:@[ text, [self originJSONForKind:SBScanKindResume fileName:fileName],
                                                           SBJSONString(@{ @"fileName": fileName }) ?: @"{}" ]];
        if (extraction) [out addObject:extraction];
    }
    return out;
}

/// Tier 6. package.json authors and the git remote beside them. Small text files, nothing else in the folder.
- (NSArray<NSDictionary *> *)readProjects:(SBScanSource *)source
                                    limit:(NSUInteger)limit
                                 maxBytes:(NSUInteger)maxBytes
                                   opened:(NSUInteger *)opened
                                  skipped:(NSMutableDictionary<NSString *, NSNumber *> *)skipped
                                     stop:(SBColdStartStop *)stop {
    NSMutableArray<NSDictionary *> *out = [NSMutableArray array];
    NSMutableSet<NSString *> *remotesSeen = [NSMutableSet set];
    for (NSString *path in source.paths) {
        if (*opened >= limit) break;
        if (![self mayContinue:stop]) break;
        NSString *reason = nil;
        if ([self isSensitiveCandidate:@{ @"pathKind": @"config", @"fileName": path.lastPathComponent } reason:&reason]) {
            [self count:skipped reason:reason];
            continue;
        }
        NSString *text = [self.files textOfFileAtPath:path maxBytes:MIN(maxBytes, (NSUInteger)256 * 1024)];
        self.filesOpened++;
        (*opened)++;
        id manifest = SBJSONParse(text);
        if ([manifest isKindOfClass:NSDictionary.class] && manifest[@"author"]) {
            // A bare string is not a JSON document, so the author travels wrapped; the core unwraps it.
            NSString *authorJSON = SBJSONString(@{ @"author": manifest[@"author"] });
            if (authorJSON) {
                NSDictionary *extraction = [self extractionFrom:@"coldStartPackageAuthor"
                                                      arguments:@[ authorJSON, [self originJSONForKind:SBScanKindProjects fileName:@"package.json"] ]];
                if (extraction) [out addObject:extraction];
            }
        }
        // The git remote of the same project: one line out of .git/config, never the repository itself.
        NSString *config = [[path.stringByDeletingLastPathComponent stringByAppendingPathComponent:@".git"] stringByAppendingPathComponent:@"config"];
        NSString *configText = [self.files textOfFileAtPath:config maxBytes:64 * 1024];
        if (configText.length == 0) continue;
        self.filesOpened++;
        for (NSString *remote in SBColdStartRemotesInGitConfig(configText)) {
            if ([remotesSeen containsObject:remote]) continue;
            [remotesSeen addObject:remote];
            NSDictionary *extraction = [self extractionFrom:@"coldStartGitRemote"
                                                  arguments:@[ remote, [self originJSONForKind:SBScanKindProjects fileName:@"git config"],
                                                               @"{\"ownerKind\":\"unknown\"}" ]];
            if (extraction) [out addObject:extraction];
        }
    }
    return out;
}

#pragma mark - the machine sources: what this person USES

// A place is worth a few visits as a prior, not a hundred: these weights only decide what leads on the FIRST day,
// and one real accept outranks any of them. They are deliberately small and deliberately explicit.
static const NSInteger kDockKeptVisits = 5;      // kept in the Dock on purpose
static const NSInteger kDockRecentVisits = 3;    // the Dock's own recents
static const NSInteger kLoginItemVisits = 4;     // starts with the day
static const NSInteger kMaxUseCount = 10000;
static const NSUInteger kMaxInventoryReads = 300;

/// `{ surface, source, visits, ... }` -- the shape shared/src/coldstart/surfaces.ts folds. The id is handed over
/// exactly as the machine spelled it; it is the SHARED rules that reduce it to an opaque token or drop it.
static NSDictionary *SBSurfaceObservation(NSString *bundleIdentifier, NSString *source, NSInteger visits) {
    NSString *trimmed = [bundleIdentifier stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (trimmed.length == 0) return nil;
    return @{ @"surface": [@"app:" stringByAppendingString:trimmed], @"source": source, @"visits": @(MAX(0, visits)) };
}

/// The Dock's own preference file: which applications this person keeps at hand, and which they reached for last.
- (NSArray<NSDictionary *> *)readDock:(SBScanSource *)source opened:(NSUInteger *)opened {
    id<SBScanEnvironment> environment = self.environment;
    NSString *path = source.paths.firstObject;
    if (!environment || path.length == 0) return @[];
    NSDictionary *plist = [environment propertyListAtPath:path];
    self.filesOpened++;
    (*opened)++;
    if (![plist isKindOfClass:NSDictionary.class]) return @[];
    NSMutableArray<NSDictionary *> *out = [NSMutableArray array];
    NSArray<NSString *> *sections = @[ @"persistent-apps", @"recent-apps" ];
    NSArray<NSNumber *> *weights = @[ @(kDockKeptVisits), @(kDockRecentVisits) ];
    for (NSUInteger i = 0; i < sections.count; i++) {
        id entries = plist[sections[i]];
        if (![entries isKindOfClass:NSArray.class]) continue;
        for (id entry in (NSArray *)entries) {
            if (![entry isKindOfClass:NSDictionary.class]) continue;
            id tile = ((NSDictionary *)entry)[@"tile-data"];
            if (![tile isKindOfClass:NSDictionary.class]) continue;
            id identifier = ((NSDictionary *)tile)[@"bundle-identifier"];
            if (![identifier isKindOfClass:NSString.class]) continue;
            NSDictionary *observation = SBSurfaceObservation(identifier, SBScanKindDock, weights[i].integerValue);
            if (observation) [out addObject:observation];
            if (out.count >= 300) return out;
        }
    }
    return out;
}

/// Per-user login agents. Their FILE NAMES are the list: nothing inside one is opened, so this can read nothing
/// but a name even if a file held something else.
- (NSArray<NSDictionary *> *)readLoginItems:(SBScanSource *)source limit:(NSUInteger)limit opened:(NSUInteger *)opened {
    id<SBScanEnvironment> environment = self.environment;
    NSString *directory = source.paths.firstObject;
    if (!environment || directory.length == 0) return @[];
    NSMutableArray<NSDictionary *> *out = [NSMutableArray array];
    for (NSString *name in [environment entryNamesAtDirectoryPath:directory]) {
        if (out.count >= limit) break;
        if ([name.pathExtension caseInsensitiveCompare:@"plist"] != NSOrderedSame) continue;
        NSDictionary *observation = SBSurfaceObservation(name.stringByDeletingPathExtension, SBScanKindLoginItems, kLoginItemVisits);
        if (observation) [out addObject:observation];
    }
    (*opened) += out.count;
    return out;
}

/// How recently and how often each application was used, from the metadata index. Nothing is opened: the counts
/// and the dates are what Spotlight already holds.
- (NSArray<NSDictionary *> *)readRecentApps:(SBScanSource *)source limit:(NSUInteger)limit {
    id<SBScanEnvironment> environment = self.environment;
    if (!environment || limit == 0) return @[];
    NSArray<NSString *> *paths = [environment pathsForSystemSpotlightQuery:[SBScanSources queryForRecentApplications]
                                                                     limit:MIN(limit, (NSUInteger)500)];
    if (paths.count == 0) return @[];
    NSArray<NSString *> *attributes = @[ @"kMDItemCFBundleIdentifier", @"kMDItemLastUsedDate", @"kMDItemUseCount" ];
    NSMutableArray<NSDictionary *> *out = [NSMutableArray array];
    for (NSDictionary *record in [environment metadataForPaths:paths attributes:attributes]) {
        id identifier = record[@"kMDItemCFBundleIdentifier"];
        if (![identifier isKindOfClass:NSString.class]) continue;
        NSInteger uses = MIN(kMaxUseCount, MAX(1, [record[@"kMDItemUseCount"] integerValue]));
        NSMutableDictionary *observation = [SBSurfaceObservation(identifier, SBScanKindRecentApps, uses) mutableCopy];
        if (!observation) continue;
        NSDate *last = SBColdStartParseMetadataDate(record[@"kMDItemLastUsedDate"]);
        if (last) {
            NSInteger hour = [[NSCalendar currentCalendar] component:NSCalendarUnitHour fromDate:last];
            NSTimeInterval ago = [NSDate.date timeIntervalSinceDate:last];
            observation[@"hours"] = @[ @(hour) ];
            observation[@"lastUsedDaysAgo"] = @(MAX(0, (NSInteger)(ago / 86400.0)));
        }
        [out addObject:observation];
    }
    return out;
}

/// Recently used documents, as COUNTS per kind of screen. No document is listed, named or opened: five Spotlight
/// counts is the whole source, which is why it can say "you read a lot" without saying what.
- (NSArray<NSDictionary *> *)readRecentDocumentKinds {
    id<SBScanEnvironment> environment = self.environment;
    if (!environment) return @[];
    NSMutableArray<NSDictionary *> *out = [NSMutableArray array];
    NSDictionary<NSString *, NSString *> *queries = [SBScanSources queriesForRecentDocumentClasses];
    for (NSString *kind in [queries.allKeys sortedArrayUsingSelector:@selector(compare:)]) {
        NSInteger count = [environment countForSpotlightQuery:queries[kind]];
        if (count > 0) [out addObject:@{ @"kind": kind, @"count": @(count) }];
    }
    return out;
}

/// What is installed. One tiny identifier file per application bundle, bounded and budgeted; an application the
/// person owns but has never been seen using becomes a surface Shabang can recognise, and never a habit.
- (NSArray<NSDictionary *> *)readAppInventory:(SBScanSource *)source
                                        limit:(NSUInteger)limit
                                       opened:(NSUInteger *)opened
                                         stop:(SBColdStartStop *)stop {
    id<SBScanEnvironment> environment = self.environment;
    if (!environment) return @[];
    NSMutableArray<NSDictionary *> *out = [NSMutableArray array];
    NSUInteger budget = MIN(limit, kMaxInventoryReads);
    for (NSString *root in source.paths) {
        for (NSString *name in [environment entryNamesAtDirectoryPath:root]) {
            if (out.count >= budget) return out;
            if (![self mayContinue:stop]) return out;
            if ([name.pathExtension caseInsensitiveCompare:@"app"] != NSOrderedSame) continue;
            NSString *info = [[root stringByAppendingPathComponent:name] stringByAppendingPathComponent:@"Contents/Info.plist"];
            NSDictionary *plist = [environment propertyListAtPath:info];
            self.filesOpened++;
            (*opened)++;
            id identifier = plist[@"CFBundleIdentifier"];
            if (![identifier isKindOfClass:NSString.class]) continue;
            NSMutableDictionary *observation = [SBSurfaceObservation(identifier, SBScanKindAppInventory, 0) mutableCopy];
            if (!observation) continue;
            observation[@"installedOnly"] = @YES;
            [out addObject:observation];
        }
    }
    return out;
}

/// Tier 3. Copy, aggregate, delete -- in that order, in one call, whatever happens in between.
- (nullable NSDictionary *)readHistory:(SBScanSource *)source
                                 limit:(NSUInteger)limit
                            roleMemory:(void (^)(NSDictionary *memory))roleMemory
                             aggregate:(void (^)(NSDictionary *whole))aggregateOut
                                opened:(NSUInteger *)opened
                                  stop:(SBColdStartStop *)stop {
    NSMutableArray<NSDictionary *> *rows = [NSMutableArray array];
    for (NSString *path in source.paths) {
        if (rows.count >= limit) break;
        if (![self mayContinue:stop]) break;
        NSString *copy = [self.files copyOfDatabaseAtPath:path];
        if (copy.length == 0) continue;
        self.filesOpened++;
        (*opened)++;
        @try {
            NSUInteger want = limit > rows.count ? limit - rows.count : 0;
            [rows addObjectsFromArray:[self.files historyRowsFromCopyAtPath:copy limit:want]];
        } @finally {
            // The copy never outlives the aggregation, not even when something above threw.
            [self.files removeCopyAtPath:copy];
        }
    }
    if (rows.count == 0) return nil;
    NSString *options = SBJSONString(@{ @"timeZoneOffsetMinutes": @(self.timeZoneOffsetMinutes), @"minVisits": @(self.habitMinVisits) }) ?: @"{}";
    NSString *answer = [self.core callString:@"coldStartHabits" arguments:@[ SBJSONString(rows) ?: @"[]", options ]];
    id aggregate = SBJSONParse(answer);
    if (![aggregate isKindOfClass:NSDictionary.class]) return nil;
    if (roleMemory && [aggregate[@"roleMemory"] isKindOfClass:NSDictionary.class]) roleMemory(aggregate[@"roleMemory"]);
    if (aggregateOut) aggregateOut(aggregate);
    // The per-origin rows name hosts: they stay in the private half. The report gets counts, kinds and summaries.
    NSMutableDictionary *visible = [NSMutableDictionary dictionary];
    for (NSString *key in @[ @"rows", @"droppedRows", @"totalVisits", @"distinctOrigins", @"rareOrigins", @"rareVisits", @"minVisits" ]) {
        if (aggregate[key]) visible[key] = aggregate[key];
    }
    if (aggregate[@"pageKinds"]) visible[@"pageKinds"] = aggregate[@"pageKinds"];
    if (aggregate[@"kindTransitions"]) visible[@"kindTransitions"] = aggregate[@"kindTransitions"];
    if (aggregate[@"summary"]) visible[@"summary"] = aggregate[@"summary"];
    return visible;
}

@end

#pragma mark - helpers

/// `2026-09-19 21:13:05 +0000`, as mdls prints it. nil for anything else, which is how a surprise stays harmless.
static NSDate *_Nullable SBColdStartParseMetadataDate(id value) {
    if (![value isKindOfClass:NSString.class]) return nil;
    static NSDateFormatter *formatter;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        formatter = [[NSDateFormatter alloc] init];
        formatter.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
        formatter.dateFormat = @"yyyy-MM-dd HH:mm:ss Z";
    });
    return [formatter dateFromString:value];
}

static NSString *SBColdStartNewScanIdentifier(void) {
    const char *alphabet = "abcdefghijklmnopqrstuvwxyz";
    NSMutableString *identifier = [NSMutableString stringWithString:@"scan-"];
    for (int i = 0; i < 10; i++) [identifier appendFormat:@"%c", alphabet[arc4random_uniform(26)]];
    return identifier;
}

static NSArray<NSString *> *SBColdStartRemotesInGitConfig(NSString *text) {
    NSMutableArray<NSString *> *remotes = [NSMutableArray array];
    for (NSString *line in [text componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet]) {
        NSString *trimmed = [line stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
        if (![trimmed hasPrefix:@"url"]) continue;
        NSRange equals = [trimmed rangeOfString:@"="];
        if (equals.location == NSNotFound) continue;
        NSString *value = [[trimmed substringFromIndex:NSMaxRange(equals)] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
        if (value.length > 0 && value.length < 300) [remotes addObject:value];
        if (remotes.count >= 4) break;
    }
    return remotes;
}

#pragma mark - apply

SBColdStartApplyCounts SBColdStartApply(NSDictionary *report, NSDictionary *pending, SBProfileStore *store, NSError **error) {
    SBColdStartApplyCounts counts = (SBColdStartApplyCounts){ 0, 0, 0, 0 };
    NSString *reportScan = [report[@"coldStart"] isKindOfClass:NSDictionary.class] ? report[@"coldStart"][@"scanId"] : nil;
    NSString *pendingScan = pending[@"scanId"];
    if (![reportScan isKindOfClass:NSString.class] || ![pendingScan isKindOfClass:NSString.class] || ![reportScan isEqualToString:pendingScan]) {
        if (error) {
            *error = [NSError errorWithDomain:@"SBColdStart" code:1
                                     userInfo:@{ NSLocalizedDescriptionKey: @"the report and the pending proposals are from different scans" }];
        }
        return counts;
    }
    NSMutableDictionary<NSString *, NSDictionary *> *byIdentifier = [NSMutableDictionary dictionary];
    for (NSDictionary *proposal in (NSArray *)(pending[@"proposals"] ?: @[])) {
        if ([proposal isKindOfClass:NSDictionary.class] && [proposal[@"id"] isKindOfClass:NSString.class]) byIdentifier[proposal[@"id"]] = proposal;
    }

    NSMutableDictionary *profile = [store.profile mutableCopy] ?: [NSMutableDictionary dictionary];
    NSMutableDictionary *facts = [profile[@"facts"] mutableCopy] ?: [NSMutableDictionary dictionary];
    for (NSDictionary *row in (NSArray *)(report[@"proposals"] ?: @[])) {
        if (![row isKindOfClass:NSDictionary.class]) continue;
        if (![row[@"accepted"] boolValue]) {
            counts.ignored++;
            continue;
        }
        NSDictionary *proposal = byIdentifier[row[@"id"] ?: @""];
        NSString *key = proposal[@"key"];
        NSString *value = proposal[@"value"];
        // The report may not carry a value, so a mismatch here means the two files do not belong together.
        if (key.length == 0 || value.length == 0 || ![key isEqualToString:row[@"key"] ?: key]) {
            counts.ignored++;
            continue;
        }
        NSString *existing = facts[key];
        if ([existing isEqualToString:value]) {
            counts.unchanged++;
            continue;
        }
        if (existing.length > 0) {
            // Never overwrite what the user has: a conflict is theirs to settle.
            counts.conflicts++;
            continue;
        }
        facts[key] = value;
        counts.applied++;
    }
    profile[@"facts"] = facts;
    if (counts.applied > 0 && ![store saveProfile:profile error:error]) {
        counts.applied = 0;
        return counts;
    }
    return counts;
}

BOOL SBColdStartSeedRoleMemory(NSDictionary *pending, NSString *memoryPath) {
    NSDictionary *memory = pending[@"roleMemory"];
    if (![memory isKindOfClass:NSDictionary.class] || memoryPath.length == 0) return NO;
    // Priors are a starting point, never a replacement: an existing memory.json is left exactly as it is.
    if ([NSFileManager.defaultManager fileExistsAtPath:memoryPath]) return NO;
    NSString *json = SBJSONString(memory);
    NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
    return data ? SBWritePrivateFile(memoryPath, data, NULL) : NO;
}

#pragma mark - the one small file (docs/storage.md)

/// The file, or "" when there is none yet. Never throws and never guesses: a corrupt file is handled by the
/// shared rules, which start from an empty brain rather than from half a brain.
static NSString *SBReadFileText(NSString *path) {
    NSString *text = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:NULL];
    return text ?: @"";
}

static NSDictionary *_Nullable SBCallGraph(SBCore *core, NSString *function, NSArray<NSString *> *arguments) {
    if (!core) return nil;
    id answer = SBJSONParse([core callString:function arguments:arguments]);
    return [answer isKindOfClass:NSDictionary.class] ? answer : nil;
}

BOOL SBColdStartApplyGraph(SBCore *core, NSDictionary *report, NSDictionary *pending, NSString *graphPath,
                           NSDictionary<NSString *, id> **summary) {
    if (!core || graphPath.length == 0) return NO;

    // Only the proposals the report marks accepted, and only their values from the private half: the two files
    // have to agree before a single fact moves, exactly as SBColdStartApply requires for the profile.
    NSMutableDictionary<NSString *, NSDictionary *> *values = [NSMutableDictionary dictionary];
    for (NSDictionary *raw in (NSArray *)(pending[@"proposals"] ?: @[])) {
        if ([raw isKindOfClass:NSDictionary.class] && [raw[@"id"] isKindOfClass:NSString.class]) values[raw[@"id"]] = raw;
    }
    NSMutableArray<NSDictionary *> *facts = [NSMutableArray array];
    for (NSDictionary *row in (NSArray *)(report[@"proposals"] ?: @[])) {
        if (![row isKindOfClass:NSDictionary.class] || ![row[@"accepted"] boolValue]) continue;
        NSDictionary *value = values[row[@"id"] ?: @""];
        if (value) [facts addObject:value];
    }

    NSMutableDictionary *input = [NSMutableDictionary dictionary];
    input[@"file"] = SBReadFileText(graphPath);
    if ([pending[@"historyAggregate"] isKindOfClass:NSDictionary.class]) input[@"history"] = pending[@"historyAggregate"];
    if ([pending[@"surfaceAggregate"] isKindOfClass:NSDictionary.class]) input[@"surfaces"] = pending[@"surfaceAggregate"];
    if ([pending[@"screenKinds"] isKindOfClass:NSArray.class]) input[@"kinds"] = pending[@"screenKinds"];
    if (facts.count > 0) input[@"facts"] = facts;
    id skipped = [report[@"skipped"] isKindOfClass:NSDictionary.class] ? report[@"skipped"][@"byReason"] : nil;
    if ([skipped isKindOfClass:NSDictionary.class]) input[@"skipped"] = @{ @"spotlight": skipped };

    NSString *json = SBJSONString(input);
    NSDictionary *result = json ? SBCallGraph(core, @"coldStartGraphApply", @[ json ]) : nil;
    NSString *text = [result[@"file"] isKindOfClass:NSString.class] ? result[@"file"] : nil;
    if (text.length == 0) return NO;
    NSData *data = [text dataUsingEncoding:NSUTF8StringEncoding];
    if (!data || !SBWritePrivateFile(graphPath, data, NULL)) return NO;
    if (summary) {
        NSMutableDictionary *counts = [result mutableCopy];
        // The file text itself never travels back to a caller that might print it.
        [counts removeObjectForKey:@"file"];
        *summary = counts;
    }
    SBLog(@"cold-start: graph now holds %@ surfaces and %@ habits (%@ bytes)",
          result[@"surfaces"] ?: @0, result[@"habits"] ?: @0, result[@"bytes"] ?: @0);
    return YES;
}

NSDictionary<NSString *, id> *_Nullable SBColdStartDescribeGraph(SBCore *core, NSString *graphPath) {
    return SBCallGraph(core, @"coldStartGraphDescribe", @[ SBReadFileText(graphPath), @"10" ]);
}

BOOL SBColdStartForgetSource(SBCore *core, NSString *graphPath, NSString *kind, NSDictionary<NSString *, id> **removed) {
    if (!core || graphPath.length == 0 || kind.length == 0) return NO;
    NSDictionary *result = SBCallGraph(core, @"coldStartGraphForget", @[ SBReadFileText(graphPath), kind ]);
    NSString *text = [result[@"file"] isKindOfClass:NSString.class] ? result[@"file"] : nil;
    if (text.length == 0) return NO;
    NSData *data = [text dataUsingEncoding:NSUTF8StringEncoding];
    if (!data || !SBWritePrivateFile(graphPath, data, NULL)) return NO;
    if (removed) {
        NSMutableDictionary *counts = [result mutableCopy];
        [counts removeObjectForKey:@"file"];
        *removed = counts;
    }
    return YES;
}

BOOL SBColdStartForgetEverything(NSString *directory) {
    if (directory.length == 0) return NO;
    BOOL removedSomething = NO;
    // Everything a scan can ever have written, including the half-finished states. Deleting is instant and needs
    // no confirmation beyond the click: a brain the user cannot delete is not one they will trust.
    for (NSString *name in @[ @"graph.json", @"coldstart-pending.json", @"memory.json", @"coldstart.lock" ]) {
        NSString *path = [directory stringByAppendingPathComponent:name];
        if ([NSFileManager.defaultManager fileExistsAtPath:path] &&
            [NSFileManager.defaultManager removeItemAtPath:path error:NULL]) {
            removedSomething = YES;
        }
    }
    SBLog(@"cold-start: forget everything (%@)", removedSomething ? @"removed" : @"nothing to remove");
    return removedSomething;
}
