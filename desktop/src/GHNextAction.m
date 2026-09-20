#import "GHNextAction.h"
#import "GHCore.h"
#import "GHCapture.h"
#import "GHField.h"
#import "GHLog.h"
#import "GHProfileStore.h"   // GHWritePrivateFile: the atomic 0600 write every Ghost file uses

NSString *const GHRoleOutcomeAccepted = @"accepted";
NSString *const GHRoleOutcomeDismissed = @"dismissed";
NSString *const GHRoleOutcomeReplaced = @"replaced";

/// A memory file bigger than this is not ours (the core caps the store at 400 entries).
static const NSUInteger kMaxMemoryBytes = 256 * 1024;
static const double kDefaultThreshold = 0.7;

#pragma mark - GHNextProposal

@implementation GHNextProposal

- (instancetype)init {
    if ((self = [super init])) {
        _signature = @"";
        _role = @"unknown";
        _source = @"prior";
        _reason = @"";
        _pageKind = @"unknown";
    }
    return self;
}

- (GHGhost *)ghostWithDisplayText:(NSString *)displayText {
    GHGhost *ghost = [[GHGhost alloc] init];
    ghost.signature = self.signature;
    ghost.action = GHGhostActionClick;
    ghost.displayText = displayText ?: @"";
    ghost.confidence = self.confidence;
    ghost.locked = self.locked;
    ghost.source = @"offline";   // the whole pass is local: no network, no key
    ghost.reason = self.reason;
    return ghost;
}

- (NSString *)description {
    // Never a label: descriptions reach logs.
    return [NSString stringWithFormat:@"<GHNextProposal %@ role=%@ %.2f locked=%d guess=%d>", self.signature, self.role, self.confidence, self.locked, self.guess];
}

@end

#pragma mark - GHRoleMemoryStore

@implementation GHRoleMemoryStore {
    GHCore *_core;
    NSString *_snapshot;
}

- (instancetype)initWithPath:(NSString *)path core:(GHCore *)core {
    if ((self = [super init])) {
        _path = [path copy];
        _core = core;
        _snapshot = @"";
        [self reload];
    }
    return self;
}

+ (NSString *)defaultPath {
    return [[GHProfileStore defaultDirectory] stringByAppendingPathComponent:@"memory.json"];
}

- (void)reload {
    NSData *data = [NSData dataWithContentsOfFile:_path];
    if (data.length == 0 || data.length > kMaxMemoryBytes) {
        _snapshot = @"";
        return;
    }
    NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    // The core's own reader is tolerant: an unparseable or foreign snapshot simply becomes an empty store.
    _snapshot = text ?: @"";
}

- (NSString *)snapshotJSON {
    return _snapshot ?: @"";
}

- (void)record:(NSDictionary<NSString *, NSString *> *)parts outcome:(NSString *)outcome {
    if (!_core) return;
    NSString *updated = [_core roleMemoryByRecording:_snapshot parts:parts outcome:outcome];
    if (updated.length == 0 || [updated isEqualToString:_snapshot ?: @""]) return;
    _snapshot = [updated copy];
    [self write];
}

- (void)write {
    NSString *directory = [_path stringByDeletingLastPathComponent];
    NSFileManager *fm = NSFileManager.defaultManager;
    if (![fm fileExistsAtPath:directory]) {
        [fm createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:@{ NSFilePosixPermissions: @0700 } error:NULL];
    }
    NSData *data = [[_snapshot stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding];
    NSError *error = nil;
    if (data && !GHWritePrivateFile(_path, data, &error)) {
        // Never load-bearing: a memory that cannot be written just means nothing is remembered yet.
        GHLog(@"next-action: memory.json could not be written (%ld)", (long)error.code);
    }
}

@end

#pragma mark - GHNextAction

@implementation GHNextAction {
    GHCore *_core;
    GHRoleMemoryStore *_memory;
}

- (instancetype)initWithCore:(GHCore *)core memory:(GHRoleMemoryStore *)memory {
    if ((self = [super init])) {
        _core = core;
        _memory = memory;
        _threshold = kDefaultThreshold;
        _pageKind = @"unknown";
        _pageEvidence = @[];
        _unnamedSignatures = @[];
        _ranked = @[];
    }
    return self;
}

- (GHNextProposal *)proposeForResult:(GHCaptureResult *)result window:(id<GHAXNode>)window signals:(GHPageSignals *)signals {
    _pageKind = @"unknown";
    _pageEvidence = @[];
    _unnamedSignatures = @[];
    _ranked = @[];
    _lastSignals = nil;
    if (!_core || result.fields.count == 0) return nil;

    // Capture's fields plus the generic hints read off the tree (docs/anywhere.md section 2).
    GHPageSignals *measured = [GHAffordance annotateResult:result window:window ?: result.webAreaNode];
    if (signals) {
        // What only the app knows wins over what the tree could show.
        measured.appBundleId = signals.appBundleId ?: measured.appBundleId;
        measured.pathPattern = signals.pathPattern ?: measured.pathPattern;
        measured.previousRole = signals.previousRole ?: measured.previousRole;
        if (signals.isFullscreen) measured.isFullscreen = YES;
        if (signals.hasMediaElement) measured.hasMediaElement = YES;
    }
    _lastSignals = measured;

    NSArray<NSDictionary *> *candidates = [GHField candidateJSONObjectsForFields:result.fields];
    NSDictionary *answer = [_core nextActionForCandidates:candidates
                                                  signals:[measured toJSONObject]
                                                   memory:_memory.snapshotJSON
                                                  options:@{ @"threshold": @(self.threshold), @"limit": @8 }];
    if (answer.count == 0) return nil;

    NSString *kind = [answer[@"pageKind"] isKindOfClass:[NSString class]] ? answer[@"pageKind"] : @"unknown";
    _pageKind = kind;
    _pageEvidence = [answer[@"pageEvidence"] isKindOfClass:[NSArray class]] ? answer[@"pageEvidence"] : @[];
    _unnamedSignatures = [answer[@"unnamed"] isKindOfClass:[NSArray class]] ? answer[@"unnamed"] : @[];

    NSMutableArray<GHNextProposal *> *ranked = [NSMutableArray array];
    for (id row in ([answer[@"proposals"] isKindOfClass:[NSArray class]] ? answer[@"proposals"] : @[])) {
        GHNextProposal *proposal = [self proposalFromRow:row kind:kind previousRole:measured.previousRole result:result];
        if (proposal) [ranked addObject:proposal];
    }
    _ranked = ranked;

    // docs/always-propose.md: if the core's own top row is one this client cannot act on (a value field that
    // belongs to the form walk, an element that moved since the capture), the best row that SURVIVED is still a
    // proposal. Silence is only right when nothing here is actionable at all.
    GHNextProposal *top = [self proposalFromRow:answer[@"top"] kind:kind previousRole:measured.previousRole result:result] ?: ranked.firstObject;
    if (!top) return nil;
    GHLog(@"next-action: %@ proposes %@ (%.2f, %@)%@%@", kind, top.role, top.confidence, top.source,
          top.guess ? @" guess" : @"", top.locked ? @" locked" : @"");
    return top;
}

/// One ranked row, refused unless it still names a live, visible control of this capture.
- (GHNextProposal *)proposalFromRow:(id)row kind:(NSString *)kind previousRole:(NSString *)previousRole result:(GHCaptureResult *)result {
    if (![row isKindOfClass:[NSDictionary class]]) return nil;
    NSDictionary *dictionary = row;
    NSString *signature = [dictionary[@"id"] isKindOfClass:[NSString class]] ? dictionary[@"id"] : nil;
    if (signature.length == 0 || ![result nodeForSignature:signature]) return nil;

    GHField *target = nil;
    for (GHField *field in result.fields) if ([field.signature isEqualToString:signature]) target = field;
    if (!target) return nil;
    NSString *role = [dictionary[@"role"] isKindOfClass:[NSString class]] ? dictionary[@"role"] : @"unknown";
    // A proposal is a place to GO, not a value to write. A button or a link is pressed; the one value field
    // worth offering is a search box, and offering it means putting the cursor in it (the writer focuses a
    // typeable control instead of pressing it). Every other field belongs to the form walk, which fills it.
    BOOL clickable = [target.kind isEqualToString:GHKindButton] || [target.kind isEqualToString:GHKindLink] ||
                     [target.kind isEqualToString:GHKindItem];
    if (!clickable && !([role isEqualToString:@"search"] && [target.kind isEqualToString:GHKindText])) return nil;

    GHNextProposal *proposal = [[GHNextProposal alloc] init];
    proposal.signature = signature;
    proposal.role = role;
    proposal.confidence = [dictionary[@"confidence"] isKindOfClass:[NSNumber class]] ? [dictionary[@"confidence"] doubleValue] : 0;
    // Rule 2 is belt AND braces: the core locked it, or the capture did.
    proposal.locked = [dictionary[@"locked"] isKindOfClass:[NSNumber class]] && [dictionary[@"locked"] boolValue];
    if (target.locked) proposal.locked = YES;
    proposal.source = [dictionary[@"source"] isKindOfClass:[NSString class]] ? dictionary[@"source"] : @"prior";
    proposal.guess = [dictionary[@"guess"] isKindOfClass:[NSNumber class]] && [dictionary[@"guess"] boolValue];
    proposal.reason = [dictionary[@"reason"] isKindOfClass:[NSString class]] ? dictionary[@"reason"] : @"";
    proposal.pageKind = kind;
    proposal.previousRole = previousRole.length ? previousRole : nil;
    return proposal;
}

- (void)recordOutcome:(NSString *)outcome forProposal:(GHNextProposal *)proposal {
    if (!proposal || proposal.role.length == 0 || [proposal.role isEqualToString:@"unknown"]) return;
    NSMutableDictionary<NSString *, NSString *> *parts = [NSMutableDictionary dictionary];
    parts[@"pageKind"] = proposal.pageKind ?: @"unknown";
    parts[@"role"] = proposal.role;
    if (proposal.previousRole.length) parts[@"previousRole"] = proposal.previousRole;
    [_memory record:parts outcome:outcome];
}

@end
