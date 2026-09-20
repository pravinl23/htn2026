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
#import "GHColdStart.h"
#import "GHCore.h"
#import "GHLog.h"
#import "GHProfileStore.h"
#include <signal.h>

static void GHOut(NSString *format, ...) NS_FORMAT_FUNCTION(1, 2);
static void GHOut(NSString *format, ...) {
    va_list args;
    va_start(args, format);
    NSString *line = [[NSString alloc] initWithFormat:format arguments:args];
    va_end(args);
    printf("%s\n", line.UTF8String);
}

static void GHErr(NSString *format, ...) NS_FORMAT_FUNCTION(1, 2);
static void GHErr(NSString *format, ...) {
    va_list args;
    va_start(args, format);
    NSString *line = [[NSString alloc] initWithFormat:format arguments:args];
    va_end(args);
    fprintf(stderr, "shabang-scan: %s\n", line.UTF8String);
}

static NSString *GHUsage(void) {
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

static NSString *GHSupportDirectory(void) {
    return [GHProfileStore defaultDirectory];
}

static NSString *GHLockPath(void) {
    return [GHSupportDirectory() stringByAppendingPathComponent:@"coldstart.lock"];
}

static NSString *GHPendingPath(void) {
    return [GHSupportDirectory() stringByAppendingPathComponent:@"coldstart-pending.json"];
}

/// The one small file (docs/storage.md section 1). The native agent owns it; nothing else writes it.
static NSString *GHGraphPath(void) {
    return [GHSupportDirectory() stringByAppendingPathComponent:@"graph.json"];
}

static GHCore *_Nullable GHLoadCore(void) {
    NSString *bundle = [GHCore defaultBundlePath];
    return bundle ? [[GHCore alloc] initWithBundlePath:bundle error:NULL] : nil;
}

/// One scan at a time, the same promise the harness makes with --expect-field: a second run refuses rather than
/// racing the first. A lock whose process is gone (or older than ten minutes) is stale and may be taken.
static BOOL GHTakeLock(NSString **problem) {
    NSString *path = GHLockPath();
    [NSFileManager.defaultManager createDirectoryAtPath:GHSupportDirectory() withIntermediateDirectories:YES
                                             attributes:@{ NSFilePosixPermissions: @(0700) } error:NULL];
    NSDictionary *existing = GHJSONParse([NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:NULL]);
    if ([existing isKindOfClass:NSDictionary.class]) {
        pid_t pid = (pid_t)[existing[@"pid"] intValue];
        NSTimeInterval age = [NSDate.date timeIntervalSince1970] - [existing[@"startedAt"] doubleValue];
        if (pid > 0 && pid != getpid() && kill(pid, 0) == 0 && age < 600) {
            if (problem) *problem = [NSString stringWithFormat:@"another scan is running (pid %d, %.0f s ago)", pid, age];
            return NO;
        }
    }
    NSDictionary *mine = @{ @"pid": @(getpid()), @"startedAt": @([NSDate.date timeIntervalSince1970]) };
    NSData *data = [GHJSONString(mine) dataUsingEncoding:NSUTF8StringEncoding];
    return data ? GHWritePrivateFile(path, data, NULL) : NO;
}

static void GHReleaseLock(void) {
    [NSFileManager.defaultManager removeItemAtPath:GHLockPath() error:NULL];
}

#pragma mark - printing

static NSString *GHSeconds(NSNumber *milliseconds) {
    return [NSString stringWithFormat:@"%.1fs", milliseconds.doubleValue / 1000.0];
}

/// The consent panel, on a terminal. Counts, statuses and what the user would have to click. No path, ever.
static void GHPrintPlan(NSDictionary *plan, NSDictionary<NSString *, NSNumber *> *neverRead,
                        NSDictionary<NSString *, NSString *> *details) {
    GHOut(@"Cold start plan (nothing has been read)");
    GHOut(@"  %-16s %-16s %8s %8s %8s", "source", "status", "found", "planned", "est");
    for (NSDictionary *row in (NSArray *)(plan[@"sources"] ?: @[])) {
        NSString *found = row[@"itemCount"] ? [row[@"itemCount"] stringValue] : @"-";
        GHOut(@"  %-16s %-16s %8s %8s %8s", [row[@"kind"] UTF8String], [row[@"status"] UTF8String], found.UTF8String,
              [row[@"plannedItems"] stringValue].UTF8String, GHSeconds(row[@"estimatedMs"]).UTF8String);
        NSString *detail = details[row[@"kind"] ?: @""];
        if (detail) GHOut(@"      (%@)", detail);
        if (row[@"needsPermission"]) GHOut(@"      %@", row[@"needsPermission"]);
    }
    NSDictionary *totals = plan[@"totals"] ?: @{};
    GHOut(@"  totals: %@ sources, %@ items, about %@, %@ need permission",
          totals[@"enabledSources"] ?: @0, totals[@"plannedItems"] ?: @0, GHSeconds(totals[@"estimatedMs"] ?: @0),
          totals[@"sourcesNeedingPermission"] ?: @0);
    if (neverRead.count > 0) {
        NSMutableArray *parts = [NSMutableArray array];
        for (NSString *reason in [neverRead.allKeys sortedArrayUsingSelector:@selector(compare:)]) {
            [parts addObject:[NSString stringWithFormat:@"%@ %@", neverRead[reason], reason]];
        }
        GHOut(@"  never read (matched by name): %@", [parts componentsJoinedByString:@", "]);
    }
    for (NSString *line in (NSArray *)(plan[@"neverRead"] ?: @[])) GHOut(@"  never: %@", line);
}

/// What Ghost knows, on a terminal. Counts, kinds and sizes ONLY: the file legitimately stores the ids of the
/// places this person uses, and this command deliberately does not print a single one of them.
static void GHPrintGraph(NSDictionary *summary) {
    double kilobytes = [summary[@"bytes"] doubleValue] / 1024.0;
    GHOut(@"What Ghost knows (%.1f KB, %@ the 200 KB target)", kilobytes,
          [summary[@"withinTarget"] boolValue] ? @"inside" : @"OVER");
    GHOut(@"  surfaces %@, habits %@, facts %@", summary[@"surfaces"] ?: @0, summary[@"habits"] ?: @0, summary[@"facts"] ?: @0);

    NSDictionary *byKind = [summary[@"byScreenKind"] isKindOfClass:NSDictionary.class] ? summary[@"byScreenKind"] : @{};
    if (byKind.count > 0) {
        NSMutableArray *parts = [NSMutableArray array];
        for (NSString *kind in [byKind.allKeys sortedArrayUsingSelector:@selector(compare:)]) {
            [parts addObject:[NSString stringWithFormat:@"%@ %@", byKind[kind], kind]];
        }
        GHOut(@"  by kind of screen: %@", [parts componentsJoinedByString:@", "]);
    }

    NSDictionary *bySource = [summary[@"bySource"] isKindOfClass:NSDictionary.class] ? summary[@"bySource"] : @{};
    if (bySource.count > 0) {
        GHOut(@"  %-16s %9s %7s %6s %9s %12s", "source", "surfaces", "habits", "facts", "visits", "last scan");
        for (NSString *kind in [bySource.allKeys sortedArrayUsingSelector:@selector(compare:)]) {
            NSDictionary *row = bySource[kind];
            GHOut(@"  %-16s %9s %7s %6s %9s %12s", kind.UTF8String,
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
        GHOut(@"  the %lu places you use most, by visits (ids stay in the file): %@",
              (unsigned long)top.count, [visits componentsJoinedByString:@", "]);
    }
}

static void GHPrintResult(GHColdStartResult *result) {
    GHOut(@"Cold start finished: %@ (%.1f s, %lu files opened)", GHColdStartStopName(result.stop),
          result.elapsedSeconds, (unsigned long)result.filesOpened);
    for (NSDictionary *source in result.sourceReports) {
        GHOut(@"  %-16s %-16s opened %@, proposals %@%@", [source[@"kind"] UTF8String], [source[@"status"] UTF8String],
              source[@"opened"] ?: @0, source[@"proposals"] ?: @0,
              source[@"needsPermission"] ? [NSString stringWithFormat:@" (%@)", source[@"needsPermission"]] : @"");
    }
    GHOut(@"  proposals: %lu, skipped as sensitive: %lu", (unsigned long)result.proposals.count, (unsigned long)result.skippedTotal);
    for (GHColdStartProposal *proposal in result.proposals) {
        GHOut(@"    %-4s %-28s %-12s %.2f  %@ chars, from %@",
              proposal.identifier.UTF8String, proposal.key.UTF8String, proposal.category.UTF8String,
              proposal.confidence, @(proposal.value.length), proposal.sourceKind);
    }
    for (NSString *line in (NSArray *)(result.habits[@"summary"] ?: @[])) GHOut(@"    habit: %@", line);
    if (result.surfaces) {
        GHOut(@"  places: %@ known, %@ transitions, %@ visits (%@ dropped, %@ past the cap)",
              result.surfaces[@"surfaces"] ?: @0, result.surfaces[@"transitions"] ?: @0,
              result.surfaces[@"totalVisits"] ?: @0, result.surfaces[@"dropped"] ?: @0, result.surfaces[@"capped"] ?: @0);
        for (NSString *line in (NSArray *)(result.surfaces[@"summary"] ?: @[])) GHOut(@"    place: %@", line);
    }
    for (NSDictionary *kind in result.screenKinds) GHOut(@"    screens: %@ %@", kind[@"count"] ?: @0, kind[@"kind"] ?: @"?");
}

/// Writes JSON, but only after proving it carries nothing personal. A leak fails the write.
static BOOL GHWriteValueFree(id object, NSString *path) {
    NSString *offender = nil;
    if (!GHColdStartIsValueFree(object, &offender)) {
        GHErr(@"refusing to write the report: it contains something that looks like a %@", offender ?: @"value");
        return NO;
    }
    NSData *data = [NSJSONSerialization dataWithJSONObject:object
                                                   options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys error:NULL];
    if (!data) return NO;
    NSError *error = nil;
    if (!GHWritePrivateFile(path, data, &error)) {
        GHErr(@"could not write the report (%@)", error.localizedDescription ?: @"?");
        return NO;
    }
    return YES;
}

#pragma mark - commands

static NSSet<NSString *> *GHKindsFromArgument(NSString *value) {
    NSMutableSet *kinds = [NSMutableSet set];
    for (NSString *part in [value componentsSeparatedByString:@","]) {
        NSString *kind = [part stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
        if (kind.length > 0) [kinds addObject:kind];
    }
    return kinds;
}

static NSSet<NSString *> *GHAllKinds(void) {
    return [NSSet setWithArray:@[ GHScanKindSpotlight, GHScanKindDock, GHScanKindLoginItems, GHScanKindRecentApps,
                                  GHScanKindRecentDocs, GHScanKindAppInventory, GHScanKindContacts, GHScanKindResume,
                                  GHScanKindBrowserHistory, GHScanKindCalendar, GHScanKindMail, GHScanKindProjects ]];
}

/// Everything that can run unattended: not one of these can raise a permission dialog on any Mac.
static NSSet<NSString *> *GHDialogFreeKinds(void) {
    return [NSSet setWithArray:@[ GHScanKindSpotlight, GHScanKindDock, GHScanKindLoginItems, GHScanKindRecentApps,
                                  GHScanKindRecentDocs, GHScanKindAppInventory, GHScanKindBrowserHistory ]];
}

static int GHGraph(void) {
    GHCore *core = GHLoadCore();
    if (!core) {
        GHErr(@"shabang-core.js not found (run 'make -C desktop core')");
        return 1;
    }
    NSDictionary *summary = GHColdStartDescribeGraph(core, GHGraphPath());
    if (!summary) {
        GHErr(@"could not read the graph");
        return 1;
    }
    GHPrintGraph(summary);
    return 0;
}

static int GHForget(NSString *kind) {
    GHCore *core = GHLoadCore();
    if (!core) {
        GHErr(@"shabang-core.js not found (run 'make -C desktop core')");
        return 1;
    }
    NSDictionary *removed = nil;
    if (!GHColdStartForgetSource(core, GHGraphPath(), kind, &removed)) {
        GHErr(@"could not forget %@", kind);
        return 1;
    }
    GHOut(@"Forgot %@: %@ places, %@ habits, %@ facts (%@ facts kept because you confirmed them)",
          kind, removed[@"surfaces"] ?: @0, removed[@"habits"] ?: @0, removed[@"facts"] ?: @0, removed[@"factsKept"] ?: @0);
    return 0;
}

static int GHForgetAll(void) {
    BOOL removed = GHColdStartForgetEverything(GHSupportDirectory());
    GHOut(@"%@", removed ? @"Everything Ghost had learned is gone." : @"There was nothing to forget.");
    return 0;
}

static int GHApply(NSString *reportPath) {
    NSDictionary *report = GHJSONParse([NSString stringWithContentsOfFile:reportPath encoding:NSUTF8StringEncoding error:NULL]);
    if (![report isKindOfClass:NSDictionary.class]) {
        GHErr(@"%@ is not a scan report", reportPath.lastPathComponent);
        return 64;
    }
    NSDictionary *pending = GHJSONParse([NSString stringWithContentsOfFile:GHPendingPath() encoding:NSUTF8StringEncoding error:NULL]);
    if (![pending isKindOfClass:NSDictionary.class]) {
        GHErr(@"there are no pending proposals to apply (run a scan first)");
        return 1;
    }
    GHProfileStore *store = [[GHProfileStore alloc] initWithDirectory:GHSupportDirectory() core:[GHCore sharedCore]];
    [store prepare];
    NSError *error = nil;
    GHColdStartApplyCounts counts = GHColdStartApply(report, pending, store, &error);
    if (error) {
        GHErr(@"%@", error.localizedDescription);
        return 1;
    }
    BOOL seeded = GHColdStartSeedRoleMemory(pending, [GHSupportDirectory() stringByAppendingPathComponent:@"memory.json"]);
    GHOut(@"Applied %lu facts (%lu already there, %lu conflicts left for you, %lu not accepted)%@",
          (unsigned long)counts.applied, (unsigned long)counts.unchanged, (unsigned long)counts.conflicts,
          (unsigned long)counts.ignored, seeded ? @", habit priors seeded" : @"");
    // The values are not kept around after they have been accepted or refused.
    [NSFileManager.defaultManager removeItemAtPath:GHPendingPath() error:NULL];
    return 0;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        GHLogSetMirrorToStderr(NO);
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
            else if ([flag isEqualToString:@"--help"] || [flag isEqualToString:@"-h"]) { GHOut(@"%@", GHUsage()); return 0; }
            else if ([flag isEqualToString:@"--sources"] && value) { sourcesArgument = value; i++; }
            else if ([flag isEqualToString:@"--out"] && value) { out = value; i++; }
            else if ([flag isEqualToString:@"--apply"] && value) { applyPath = value; i++; }
            else if ([flag isEqualToString:@"--budget"] && value) { budgetSeconds = value.doubleValue; i++; }
            else if ([flag isEqualToString:@"--max-files"] && value) { maxFiles = (NSUInteger)MAX(0, value.integerValue); i++; }
            else { GHErr(@"unknown option '%@'\n%@", flag, GHUsage()); return 64; }
        }
        if (graph) return GHGraph();
        if (forgetAll) return GHForgetAll();
        if (forgetKind) return GHForget(forgetKind);
        if (applyPath) return GHApply(applyPath);
        if (!dryRun && !sourcesArgument && !safe) {
            GHErr(@"say what to scan\n%@", GHUsage());
            return 64;
        }

        NSString *problem = nil;
        if (!GHTakeLock(&problem)) {
            GHErr(@"%@", problem ?: @"could not take the scan lock");
            return 1;
        }

        GHCore *core = GHLoadCore();
        if (!core) {
            GHReleaseLock();
            GHErr(@"shabang-core.js not found (run 'make -C desktop core')");
            return 1;
        }

        GHScanEnvironmentMac *environment = [[GHScanEnvironmentMac alloc] init];
        GHScanSources *discovery = [[GHScanSources alloc] initWithEnvironment:environment];
        NSArray<GHScanSource *> *sources = [discovery discover];
        // A dry run shows the whole panel. A real scan with no --sources reads only what can raise no dialog:
        // the default has to be the one that is always safe to run, not the one that asks for the most.
        NSSet<NSString *> *kinds = sourcesArgument ? GHKindsFromArgument(sourcesArgument)
                                  : (safe && !dryRun ? GHDialogFreeKinds() : GHAllKinds());

        GHColdStartFilesMac *files = [[GHColdStartFilesMac alloc] init];
        GHColdStart *coldStart = [[GHColdStart alloc] initWithCore:core files:files];
        // The same machine the discovery used: the plist reads, directory listings and metadata queries the
        // no-permission sources need. It asks macOS for nothing, exactly like the discovery pass.
        coldStart.environment = environment;
        if (budgetSeconds > 0 || maxFiles > 0) {
            GHColdStartBudget budget = coldStart.budget;
            if (budgetSeconds > 0) budget.wallClockSeconds = MIN(budgetSeconds, budget.wallClockSeconds);
            if (maxFiles > 0) budget.maxFiles = MIN(maxFiles, budget.maxFiles);
            coldStart.budget = budget;
        }

        int status = 0;
        if (dryRun) {
            NSDictionary *plan = [coldStart planForSources:sources enabledKinds:kinds];
            NSDictionary<NSString *, NSNumber *> *neverRead = [discovery neverReadCounts];
            if (!plan) {
                GHErr(@"the core could not build a plan");
                status = 1;
            } else {
                NSMutableDictionary<NSString *, NSString *> *details = [NSMutableDictionary dictionary];
                for (GHScanSource *source in sources) if (source.detail) details[source.kind] = source.detail;
                GHPrintPlan(plan, neverRead, details);
                if (out) {
                    NSMutableDictionary *document = [plan mutableCopy];
                    document[@"neverReadCounts"] = neverRead;
                    document[@"dryRun"] = @YES;
                    status = GHWriteValueFree(document, out) ? 0 : 1;
                    if (status == 0) GHErr(@"wrote %@", out.lastPathComponent);
                }
            }
        } else {
            GHColdStartResult *result = [coldStart runSources:sources enabledKinds:kinds];
            GHPrintResult(result);
            if (out) {
                status = GHWriteValueFree(result.reportObject, out) ? 0 : 1;
                if (status == 0) GHErr(@"wrote %@ (value-free)", out.lastPathComponent);
            }
            NSDictionary *pending = result.pendingObject;
            if (result.proposals.count > 0 || result.roleMemory || result.surfaceAggregate || result.historyAggregate) {
                NSData *data = [NSJSONSerialization dataWithJSONObject:pending options:0 error:NULL];
                if (data && GHWritePrivateFile(GHPendingPath(), data, NULL)) {
                    GHErr(@"the values stay in coldstart-pending.json (0600) until you accept or discard them");
                }
            }
            // Places and habits go into the graph now; FACTS still wait for --apply, because a fact is a value
            // about a person and a surface count is not (docs/cold-start.md section 1: proposals, never silent
            // writes). `shabang-scan --graph` shows what landed, `--forget <source>` takes it back out.
            if (result.surfaceAggregate || result.historyAggregate || result.screenKinds.count > 0) {
                NSDictionary *summary = nil;
                NSMutableDictionary *habitsOnly = [pending mutableCopy];
                habitsOnly[@"proposals"] = @[];
                if (GHColdStartApplyGraph(core, @{ @"proposals": @[] }, habitsOnly, GHGraphPath(), &summary)) {
                    GHOut(@"  graph: %@ places, %@ habits, %.1f KB", summary[@"surfaces"] ?: @0, summary[@"habits"] ?: @0,
                          [summary[@"bytes"] doubleValue] / 1024.0);
                } else {
                    GHErr(@"the graph could not be written; nothing was changed");
                }
            }
        }
        GHReleaseLock();
        GHLogFlush();
        return status;
    }
}
