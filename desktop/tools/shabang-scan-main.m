// shabang-scan: the command-line half of cold start (docs/cold-start.md), driven by tools/shabangctl.
//
//   shabang-scan --dry-run [--sources a,b] [--out FILE]   the consent plan: counts only, opens nothing
//   shabang-scan --sources a,b [--out FILE]               runs the scan and writes a VALUE-FREE report
//   shabang-scan --apply FILE                             applies the proposals the report marks accepted
//
// Deliberately its own executable and deliberately started from the shell, NOT through LaunchServices: it must
// not borrow Shabang.app's Accessibility grant, and it asks macOS for nothing. A protected source (Contacts,
// Calendar, Safari history, Mail) is reported as "needs permission: <what to click>" and never touched, so
// running this can raise no permission dialog.
//
// Everything stays on the machine. The report carries labels, categories, confidences, provenance KINDS and
// counts; the values live only in ~/Library/Application Support/Shabang/coldstart-pending.json (mode 0600) until
// the user accepts or discards them.
#import <Foundation/Foundation.h>
#import "SBColdStart.h"
#import "SBCore.h"
#import "SBLog.h"
#import "SBProfileStore.h"
#include <signal.h>

static void SBOut(NSString *format, ...) NS_FORMAT_FUNCTION(1, 2);
static void SBOut(NSString *format, ...) {
    va_list args;
    va_start(args, format);
    NSString *line = [[NSString alloc] initWithFormat:format arguments:args];
    va_end(args);
    printf("%s\n", line.UTF8String);
}

static void SBErr(NSString *format, ...) NS_FORMAT_FUNCTION(1, 2);
static void SBErr(NSString *format, ...) {
    va_list args;
    va_start(args, format);
    NSString *line = [[NSString alloc] initWithFormat:format arguments:args];
    va_end(args);
    fprintf(stderr, "shabang-scan: %s\n", line.UTF8String);
}

static NSString *SBUsage(void) {
    return @"shabang-scan --dry-run [--sources a,b] [--out FILE]\n"
           @"          --sources a,b [--out FILE] [--budget SECONDS] [--max-files N]\n"
           @"          --safe [--out FILE]   every source that can raise no permission dialog\n"
           @"          --apply FILE\n"
           @"          --graph\n"
           @"          --forget KIND | --forget-all\n"
           @"sources needing no permission: dock, login-items, recent-apps, recent-docs, app-inventory, browser-history\n"
           @"sources needing a click:       contacts, resume, calendar, mail, projects\n"
           @"(spotlight is always counted, never read)";
}

#pragma mark - the run lock

static NSString *SBSupportDirectory(void) {
    return [SBProfileStore defaultDirectory];
}

static NSString *SBLockPath(void) {
    return [SBSupportDirectory() stringByAppendingPathComponent:@"coldstart.lock"];
}

static NSString *SBPendingPath(void) {
    return [SBSupportDirectory() stringByAppendingPathComponent:@"coldstart-pending.json"];
}

/// The one small file (docs/storage.md section 1). The native agent owns it; nothing else writes it.
static NSString *SBGraphPath(void) {
    return [SBSupportDirectory() stringByAppendingPathComponent:@"graph.json"];
}

static SBCore *_Nullable SBLoadCore(void) {
    NSString *bundle = [SBCore defaultBundlePath];
    return bundle ? [[SBCore alloc] initWithBundlePath:bundle error:NULL] : nil;
}

/// One scan at a time, the same promise the harness makes with --expect-field: a second run refuses rather than
/// racing the first. A lock whose process is gone (or older than ten minutes) is stale and may be taken.
static BOOL SBTakeLock(NSString **problem) {
    NSString *path = SBLockPath();
    [NSFileManager.defaultManager createDirectoryAtPath:SBSupportDirectory() withIntermediateDirectories:YES
                                             attributes:@{ NSFilePosixPermissions: @(0700) } error:NULL];
    NSDictionary *existing = SBJSONParse([NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:NULL]);
    if ([existing isKindOfClass:NSDictionary.class]) {
        pid_t pid = (pid_t)[existing[@"pid"] intValue];
        NSTimeInterval age = [NSDate.date timeIntervalSince1970] - [existing[@"startedAt"] doubleValue];
        if (pid > 0 && pid != getpid() && kill(pid, 0) == 0 && age < 600) {
            if (problem) *problem = [NSString stringWithFormat:@"another scan is running (pid %d, %.0f s ago)", pid, age];
            return NO;
        }
    }
    NSDictionary *mine = @{ @"pid": @(getpid()), @"startedAt": @([NSDate.date timeIntervalSince1970]) };
    NSData *data = [SBJSONString(mine) dataUsingEncoding:NSUTF8StringEncoding];
    return data ? SBWritePrivateFile(path, data, NULL) : NO;
}

static void SBReleaseLock(void) {
    [NSFileManager.defaultManager removeItemAtPath:SBLockPath() error:NULL];
}

#pragma mark - printing

static NSString *SBSeconds(NSNumber *milliseconds) {
    return [NSString stringWithFormat:@"%.1fs", milliseconds.doubleValue / 1000.0];
}

/// The consent panel, on a terminal. Counts, statuses and what the user would have to click. No path, ever.
static void SBPrintPlan(NSDictionary *plan, NSDictionary<NSString *, NSNumber *> *neverRead,
                        NSDictionary<NSString *, NSString *> *details) {
    SBOut(@"Cold start plan (nothing has been read)");
    SBOut(@"  %-16s %-16s %8s %8s %8s", "source", "status", "found", "planned", "est");
    for (NSDictionary *row in (NSArray *)(plan[@"sources"] ?: @[])) {
        NSString *found = row[@"itemCount"] ? [row[@"itemCount"] stringValue] : @"-";
        SBOut(@"  %-16s %-16s %8s %8s %8s", [row[@"kind"] UTF8String], [row[@"status"] UTF8String], found.UTF8String,
              [row[@"plannedItems"] stringValue].UTF8String, SBSeconds(row[@"estimatedMs"]).UTF8String);
        NSString *detail = details[row[@"kind"] ?: @""];
        if (detail) SBOut(@"      (%@)", detail);
        if (row[@"needsPermission"]) SBOut(@"      %@", row[@"needsPermission"]);
    }
    NSDictionary *totals = plan[@"totals"] ?: @{};
    SBOut(@"  totals: %@ sources, %@ items, about %@, %@ need permission",
          totals[@"enabledSources"] ?: @0, totals[@"plannedItems"] ?: @0, SBSeconds(totals[@"estimatedMs"] ?: @0),
          totals[@"sourcesNeedingPermission"] ?: @0);
    if (neverRead.count > 0) {
        NSMutableArray *parts = [NSMutableArray array];
        for (NSString *reason in [neverRead.allKeys sortedArrayUsingSelector:@selector(compare:)]) {
            [parts addObject:[NSString stringWithFormat:@"%@ %@", neverRead[reason], reason]];
        }
        SBOut(@"  never read (matched by name): %@", [parts componentsJoinedByString:@", "]);
    }
    for (NSString *line in (NSArray *)(plan[@"neverRead"] ?: @[])) SBOut(@"  never: %@", line);
}

/// What Ghost knows, on a terminal. Counts, kinds and sizes ONLY: the file legitimately stores the ids of the
/// places this person uses, and this command deliberately does not print a single one of them.
static void SBPrintGraph(NSDictionary *summary) {
    double kilobytes = [summary[@"bytes"] doubleValue] / 1024.0;
    SBOut(@"What Ghost knows (%.1f KB, %@ the 200 KB target)", kilobytes,
          [summary[@"withinTarget"] boolValue] ? @"inside" : @"OVER");
    SBOut(@"  surfaces %@, habits %@, facts %@", summary[@"surfaces"] ?: @0, summary[@"habits"] ?: @0, summary[@"facts"] ?: @0);

    NSDictionary *byKind = [summary[@"byScreenKind"] isKindOfClass:NSDictionary.class] ? summary[@"byScreenKind"] : @{};
    if (byKind.count > 0) {
        NSMutableArray *parts = [NSMutableArray array];
        for (NSString *kind in [byKind.allKeys sortedArrayUsingSelector:@selector(compare:)]) {
            [parts addObject:[NSString stringWithFormat:@"%@ %@", byKind[kind], kind]];
        }
        SBOut(@"  by kind of screen: %@", [parts componentsJoinedByString:@", "]);
    }

    NSDictionary *bySource = [summary[@"bySource"] isKindOfClass:NSDictionary.class] ? summary[@"bySource"] : @{};
    if (bySource.count > 0) {
        SBOut(@"  %-16s %9s %7s %6s %9s %12s", "source", "surfaces", "habits", "facts", "visits", "last scan");
        for (NSString *kind in [bySource.allKeys sortedArrayUsingSelector:@selector(compare:)]) {
            NSDictionary *row = bySource[kind];
            SBOut(@"  %-16s %9s %7s %6s %9s %12s", kind.UTF8String,
                  [(row[@"surfaces"] ?: @0) stringValue].UTF8String, [(row[@"habits"] ?: @0) stringValue].UTF8String,
                  [(row[@"facts"] ?: @0) stringValue].UTF8String, [(row[@"visits"] ?: @0) stringValue].UTF8String,
                  [(row[@"lastScanDay"] ?: @"-") UTF8String]);
        }
    }

    NSArray *top = [summary[@"topSurfaces"] isKindOfClass:NSArray.class] ? summary[@"topSurfaces"] : @[];
    if (top.count > 0) {
        // The ids are in the file, on purpose. They are not in this output, also on purpose.
        NSMutableArray *visits = [NSMutableArray array];
        for (NSDictionary *place in top) [visits addObject:[(place[@"visits"] ?: @0) stringValue]];
        SBOut(@"  the %lu places you use most, by visits (ids stay in the file): %@",
              (unsigned long)top.count, [visits componentsJoinedByString:@", "]);
    }
}

static void SBPrintResult(SBColdStartResult *result) {
    SBOut(@"Cold start finished: %@ (%.1f s, %lu files opened)", SBColdStartStopName(result.stop),
          result.elapsedSeconds, (unsigned long)result.filesOpened);
    for (NSDictionary *source in result.sourceReports) {
        SBOut(@"  %-16s %-16s opened %@, proposals %@%@", [source[@"kind"] UTF8String], [source[@"status"] UTF8String],
              source[@"opened"] ?: @0, source[@"proposals"] ?: @0,
              source[@"needsPermission"] ? [NSString stringWithFormat:@" (%@)", source[@"needsPermission"]] : @"");
    }
    SBOut(@"  proposals: %lu, skipped as sensitive: %lu", (unsigned long)result.proposals.count, (unsigned long)result.skippedTotal);
    for (SBColdStartProposal *proposal in result.proposals) {
        SBOut(@"    %-4s %-28s %-12s %.2f  %@ chars, from %@",
              proposal.identifier.UTF8String, proposal.key.UTF8String, proposal.category.UTF8String,
              proposal.confidence, @(proposal.value.length), proposal.sourceKind);
    }
    for (NSString *line in (NSArray *)(result.habits[@"summary"] ?: @[])) SBOut(@"    habit: %@", line);
    if (result.surfaces) {
        SBOut(@"  places: %@ known, %@ transitions, %@ visits (%@ dropped, %@ past the cap)",
              result.surfaces[@"surfaces"] ?: @0, result.surfaces[@"transitions"] ?: @0,
              result.surfaces[@"totalVisits"] ?: @0, result.surfaces[@"dropped"] ?: @0, result.surfaces[@"capped"] ?: @0);
        for (NSString *line in (NSArray *)(result.surfaces[@"summary"] ?: @[])) SBOut(@"    place: %@", line);
    }
    for (NSDictionary *kind in result.screenKinds) SBOut(@"    screens: %@ %@", kind[@"count"] ?: @0, kind[@"kind"] ?: @"?");
}

/// Writes JSON, but only after proving it carries nothing personal. A leak fails the write.
static BOOL SBWriteValueFree(id object, NSString *path) {
    NSString *offender = nil;
    if (!SBColdStartIsValueFree(object, &offender)) {
        SBErr(@"refusing to write the report: it contains something that looks like a %@", offender ?: @"value");
        return NO;
    }
    NSData *data = [NSJSONSerialization dataWithJSONObject:object
                                                   options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys error:NULL];
    if (!data) return NO;
    NSError *error = nil;
    if (!SBWritePrivateFile(path, data, &error)) {
        SBErr(@"could not write the report (%@)", error.localizedDescription ?: @"?");
        return NO;
    }
    return YES;
}

#pragma mark - commands

static NSSet<NSString *> *SBKindsFromArgument(NSString *value) {
    NSMutableSet *kinds = [NSMutableSet set];
    for (NSString *part in [value componentsSeparatedByString:@","]) {
        NSString *kind = [part stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
        if (kind.length > 0) [kinds addObject:kind];
    }
    return kinds;
}

static NSSet<NSString *> *SBAllKinds(void) {
    return [NSSet setWithArray:@[ SBScanKindSpotlight, SBScanKindDock, SBScanKindLoginItems, SBScanKindRecentApps,
                                  SBScanKindRecentDocs, SBScanKindAppInventory, SBScanKindContacts, SBScanKindResume,
                                  SBScanKindBrowserHistory, SBScanKindCalendar, SBScanKindMail, SBScanKindProjects ]];
}

/// Everything that can run unattended: not one of these can raise a permission dialog on any Mac.
static NSSet<NSString *> *SBDialogFreeKinds(void) {
    return [NSSet setWithArray:@[ SBScanKindSpotlight, SBScanKindDock, SBScanKindLoginItems, SBScanKindRecentApps,
                                  SBScanKindRecentDocs, SBScanKindAppInventory, SBScanKindBrowserHistory ]];
}

static int SBGraph(void) {
    SBCore *core = SBLoadCore();
    if (!core) {
        SBErr(@"shabang-core.js not found (run 'make -C desktop core')");
        return 1;
    }
    NSDictionary *summary = SBColdStartDescribeGraph(core, SBGraphPath());
    if (!summary) {
        SBErr(@"could not read the graph");
        return 1;
    }
    SBPrintGraph(summary);
    return 0;
}

static int SBForget(NSString *kind) {
    SBCore *core = SBLoadCore();
    if (!core) {
        SBErr(@"shabang-core.js not found (run 'make -C desktop core')");
        return 1;
    }
    NSDictionary *removed = nil;
    if (!SBColdStartForgetSource(core, SBGraphPath(), kind, &removed)) {
        SBErr(@"could not forget %@", kind);
        return 1;
    }
    SBOut(@"Forgot %@: %@ places, %@ habits, %@ facts (%@ facts kept because you confirmed them)",
          kind, removed[@"surfaces"] ?: @0, removed[@"habits"] ?: @0, removed[@"facts"] ?: @0, removed[@"factsKept"] ?: @0);
    return 0;
}

static int SBForgetAll(void) {
    BOOL removed = SBColdStartForgetEverything(SBSupportDirectory());
    SBOut(@"%@", removed ? @"Everything Ghost had learned is gone." : @"There was nothing to forget.");
    return 0;
}

static int SBApply(NSString *reportPath) {
    NSDictionary *report = SBJSONParse([NSString stringWithContentsOfFile:reportPath encoding:NSUTF8StringEncoding error:NULL]);
    if (![report isKindOfClass:NSDictionary.class]) {
        SBErr(@"%@ is not a scan report", reportPath.lastPathComponent);
        return 64;
    }
    NSDictionary *pending = SBJSONParse([NSString stringWithContentsOfFile:SBPendingPath() encoding:NSUTF8StringEncoding error:NULL]);
    if (![pending isKindOfClass:NSDictionary.class]) {
        SBErr(@"there are no pending proposals to apply (run a scan first)");
        return 1;
    }
    SBProfileStore *store = [[SBProfileStore alloc] initWithDirectory:SBSupportDirectory() core:[SBCore sharedCore]];
    [store prepare];
    NSError *error = nil;
    SBColdStartApplyCounts counts = SBColdStartApply(report, pending, store, &error);
    if (error) {
        SBErr(@"%@", error.localizedDescription);
        return 1;
    }
    BOOL seeded = SBColdStartSeedRoleMemory(pending, [SBSupportDirectory() stringByAppendingPathComponent:@"memory.json"]);
    SBOut(@"Applied %lu facts (%lu already there, %lu conflicts left for you, %lu not accepted)%@",
          (unsigned long)counts.applied, (unsigned long)counts.unchanged, (unsigned long)counts.conflicts,
          (unsigned long)counts.ignored, seeded ? @", habit priors seeded" : @"");
    // The values are not kept around after they have been accepted or refused.
    [NSFileManager.defaultManager removeItemAtPath:SBPendingPath() error:NULL];
    return 0;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        SBLogSetMirrorToStderr(NO);
        NSMutableArray<NSString *> *args = [NSMutableArray array];
        for (int i = 1; i < argc; i++) [args addObject:@(argv[i] ?: "")];

        BOOL dryRun = NO, graph = NO, forgetAll = NO, safe = NO;
        NSString *out = nil, *applyPath = nil, *sourcesArgument = nil, *forgetKind = nil;
        double budgetSeconds = 0;
        NSUInteger maxFiles = 0;
        for (NSUInteger i = 0; i < args.count; i++) {
            NSString *flag = args[i];
            NSString *value = i + 1 < args.count ? args[i + 1] : nil;
            if ([flag isEqualToString:@"--dry-run"]) dryRun = YES;
            else if ([flag isEqualToString:@"--graph"]) graph = YES;
            else if ([flag isEqualToString:@"--safe"]) safe = YES;
            else if ([flag isEqualToString:@"--forget-all"]) forgetAll = YES;
            else if ([flag isEqualToString:@"--forget"] && value) { forgetKind = value; i++; }
            else if ([flag isEqualToString:@"--help"] || [flag isEqualToString:@"-h"]) { SBOut(@"%@", SBUsage()); return 0; }
            else if ([flag isEqualToString:@"--sources"] && value) { sourcesArgument = value; i++; }
            else if ([flag isEqualToString:@"--out"] && value) { out = value; i++; }
            else if ([flag isEqualToString:@"--apply"] && value) { applyPath = value; i++; }
            else if ([flag isEqualToString:@"--budget"] && value) { budgetSeconds = value.doubleValue; i++; }
            else if ([flag isEqualToString:@"--max-files"] && value) { maxFiles = (NSUInteger)MAX(0, value.integerValue); i++; }
            else { SBErr(@"unknown option '%@'\n%@", flag, SBUsage()); return 64; }
        }
        if (graph) return SBGraph();
        if (forgetAll) return SBForgetAll();
        if (forgetKind) return SBForget(forgetKind);
        if (applyPath) return SBApply(applyPath);
        if (!dryRun && !sourcesArgument && !safe) {
            SBErr(@"say what to scan\n%@", SBUsage());
            return 64;
        }

        NSString *problem = nil;
        if (!SBTakeLock(&problem)) {
            SBErr(@"%@", problem ?: @"could not take the scan lock");
            return 1;
        }

        SBCore *core = SBLoadCore();
        if (!core) {
            SBReleaseLock();
            SBErr(@"shabang-core.js not found (run 'make -C desktop core')");
            return 1;
        }

        SBScanEnvironmentMac *environment = [[SBScanEnvironmentMac alloc] init];
        SBScanSources *discovery = [[SBScanSources alloc] initWithEnvironment:environment];
        NSArray<SBScanSource *> *sources = [discovery discover];
        // A dry run shows the whole panel. A real scan with no --sources reads only what can raise no dialog:
        // the default has to be the one that is always safe to run, not the one that asks for the most.
        NSSet<NSString *> *kinds = sourcesArgument ? SBKindsFromArgument(sourcesArgument)
                                  : (safe && !dryRun ? SBDialogFreeKinds() : SBAllKinds());

        SBColdStartFilesMac *files = [[SBColdStartFilesMac alloc] init];
        SBColdStart *coldStart = [[SBColdStart alloc] initWithCore:core files:files];
        // The same machine the discovery used: the plist reads, directory listings and metadata queries the
        // no-permission sources need. It asks macOS for nothing, exactly like the discovery pass.
        coldStart.environment = environment;
        if (budgetSeconds > 0 || maxFiles > 0) {
            SBColdStartBudget budget = coldStart.budget;
            if (budgetSeconds > 0) budget.wallClockSeconds = MIN(budgetSeconds, budget.wallClockSeconds);
            if (maxFiles > 0) budget.maxFiles = MIN(maxFiles, budget.maxFiles);
            coldStart.budget = budget;
        }

        int status = 0;
        if (dryRun) {
            NSDictionary *plan = [coldStart planForSources:sources enabledKinds:kinds];
            NSDictionary<NSString *, NSNumber *> *neverRead = [discovery neverReadCounts];
            if (!plan) {
                SBErr(@"the core could not build a plan");
                status = 1;
            } else {
                NSMutableDictionary<NSString *, NSString *> *details = [NSMutableDictionary dictionary];
                for (SBScanSource *source in sources) if (source.detail) details[source.kind] = source.detail;
                SBPrintPlan(plan, neverRead, details);
                if (out) {
                    NSMutableDictionary *document = [plan mutableCopy];
                    document[@"neverReadCounts"] = neverRead;
                    document[@"dryRun"] = @YES;
                    status = SBWriteValueFree(document, out) ? 0 : 1;
                    if (status == 0) SBErr(@"wrote %@", out.lastPathComponent);
                }
            }
        } else {
            SBColdStartResult *result = [coldStart runSources:sources enabledKinds:kinds];
            SBPrintResult(result);
            if (out) {
                status = SBWriteValueFree(result.reportObject, out) ? 0 : 1;
                if (status == 0) SBErr(@"wrote %@ (value-free)", out.lastPathComponent);
            }
            NSDictionary *pending = result.pendingObject;
            if (result.proposals.count > 0 || result.roleMemory || result.surfaceAggregate || result.historyAggregate) {
                NSData *data = [NSJSONSerialization dataWithJSONObject:pending options:0 error:NULL];
                if (data && SBWritePrivateFile(SBPendingPath(), data, NULL)) {
                    SBErr(@"the values stay in coldstart-pending.json (0600) until you accept or discard them");
                }
            }
            // Places and habits go into the graph now; FACTS still wait for --apply, because a fact is a value
            // about a person and a surface count is not (docs/cold-start.md section 1: proposals, never silent
            // writes). `shabang-scan --graph` shows what landed, `--forget <source>` takes it back out.
            if (result.surfaceAggregate || result.historyAggregate || result.screenKinds.count > 0) {
                NSDictionary *summary = nil;
                NSMutableDictionary *habitsOnly = [pending mutableCopy];
                habitsOnly[@"proposals"] = @[];
                if (SBColdStartApplyGraph(core, @{ @"proposals": @[] }, habitsOnly, SBGraphPath(), &summary)) {
                    SBOut(@"  graph: %@ places, %@ habits, %.1f KB", summary[@"surfaces"] ?: @0, summary[@"habits"] ?: @0,
                          [summary[@"bytes"] doubleValue] / 1024.0);
                } else {
                    SBErr(@"the graph could not be written; nothing was changed");
                }
            }
        }
        SBReleaseLock();
        SBLogFlush();
        return status;
    }
}
