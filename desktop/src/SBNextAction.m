#import "SBNextAction.h"
#import "SBCore.h"
#import "SBCapture.h"
#import "SBField.h"
#import "SBGeometry.h"
#import "SBLog.h"
#import "SBProfileStore.h"   // SBWritePrivateFile: the atomic 0600 write every Shabang file uses

NSString *const SBRoleOutcomeAccepted = @"accepted";
NSString *const SBRoleOutcomeDismissed = @"dismissed";
NSString *const SBRoleOutcomeReplaced = @"replaced";

/// A memory file bigger than this is not ours (the core caps the store at 400 entries).
static const NSUInteger kMaxMemoryBytes = 256 * 1024;
static const double kDefaultThreshold = 0.7;
/// What counts as "the app is showing the answers under this box": at least two entries, starting no more
/// than this far below it, and allowed to begin slightly above it (a menu that overlaps its own field).
static const NSUInteger kCandidatesNeeded = 2;
static const CGFloat kCandidateReach = 320;
static const CGFloat kCandidateOverlap = 8;

#pragma mark - SBNextProposal

@implementation SBNextProposal

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

- (SBGhost *)ghostWithDisplayText:(NSString *)displayText {
    SBGhost *ghost = [[SBGhost alloc] init];
    ghost.signature = self.signature;
    ghost.action = SBGhostActionClick;
    ghost.displayText = displayText ?: @"";
    ghost.confidence = self.confidence;
    ghost.locked = self.locked;
    ghost.source = @"offline";   // the whole pass is local: no network, no key
    ghost.reason = self.reason;
    return ghost;
}

- (NSString *)description {
    // Never a label: descriptions reach logs.
    return [NSString stringWithFormat:@"<SBNextProposal %@ role=%@ %.2f locked=%d guess=%d>", self.signature, self.role, self.confidence, self.locked, self.guess];
}

@end

#pragma mark - SBRoleMemoryStore

@implementation SBRoleMemoryStore {
    SBCore *_core;
    NSString *_snapshot;
}

- (instancetype)initWithPath:(NSString *)path core:(SBCore *)core {
    if ((self = [super init])) {
        _path = [path copy];
        _core = core;
        _snapshot = @"";
        [self reload];
    }
    return self;
}

+ (NSString *)defaultPath {
    return [[SBProfileStore defaultDirectory] stringByAppendingPathComponent:@"memory.json"];
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
    if (data && !SBWritePrivateFile(_path, data, &error)) {
        // Never load-bearing: a memory that cannot be written just means nothing is remembered yet.
        SBLog(@"next-action: memory.json could not be written (%ld)", (long)error.code);
    }
}

@end

#pragma mark - SBNextAction

@implementation SBNextAction {
    SBCore *_core;
    SBRoleMemoryStore *_memory;
}

- (instancetype)initWithCore:(SBCore *)core memory:(SBRoleMemoryStore *)memory {
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

- (SBNextProposal *)proposeForResult:(SBCaptureResult *)result window:(id<SBAXNode>)window signals:(SBPageSignals *)signals {
    _pageKind = @"unknown";
    _pageEvidence = @[];
    _unnamedSignatures = @[];
    _ranked = @[];
    _lastSignals = nil;
    if (!_core || result.fields.count == 0) return nil;

    // Capture's fields plus the generic hints read off the tree (docs/anywhere.md section 2).
    SBPageSignals *measured = [SBAffordance annotateResult:result window:window ?: result.webAreaNode];
    if (signals) {
        // What only the app knows wins over what the tree could show.
        measured.appBundleId = signals.appBundleId ?: measured.appBundleId;
        measured.pathPattern = signals.pathPattern ?: measured.pathPattern;
        measured.previousRole = signals.previousRole ?: measured.previousRole;
        if (signals.isFullscreen) measured.isFullscreen = YES;
        if (signals.hasMediaElement) measured.hasMediaElement = YES;
    }
    // The app's own cursor is the sequence signal: it says what comes next without Shabang having to have seen
    // this app, this window or this user before.
    // Somebody waiting for an answer outranks everything else the screen offers.
    for (SBField *field in result.fields) if (field.unread) { measured.hasUnreadItem = YES; break; }
    NSString *focusedSignature = nil;
    if (!measured.hasUnreadItem && [SBNextAction window:result hasAFocusedEmptyField:&focusedSignature]) {
        // ...unless the app is ALREADY showing the answers under it. Then the next action is to take one of
        // them, not to type: nobody types a name they can see. Leaving `field` unboosted lets the list's own
        // first row win on its ordinary prior, which is what "pick, never generate" looks like in the rank.
        measured.focusedEmptyField = ![SBNextAction result:result showsCandidatesUnder:focusedSignature];
    }
    _lastSignals = measured;

    NSArray<NSDictionary *> *candidates = [SBField candidateJSONObjectsForFields:result.fields];
    NSDictionary *answer = [_core nextActionForCandidates:candidates
                                                  signals:[measured toJSONObject]
                                                   memory:_memory.snapshotJSON
                                                  options:@{ @"threshold": @(self.threshold), @"limit": @8 }];
    if (answer.count == 0) return nil;

    NSString *kind = [answer[@"pageKind"] isKindOfClass:[NSString class]] ? answer[@"pageKind"] : @"unknown";
    _pageKind = kind;
    _pageEvidence = [answer[@"pageEvidence"] isKindOfClass:[NSArray class]] ? answer[@"pageEvidence"] : @[];
    _unnamedSignatures = [answer[@"unnamed"] isKindOfClass:[NSArray class]] ? answer[@"unnamed"] : @[];

    NSMutableArray<SBNextProposal *> *ranked = [NSMutableArray array];
    for (id row in ([answer[@"proposals"] isKindOfClass:[NSArray class]] ? answer[@"proposals"] : @[])) {
        SBNextProposal *proposal = [self proposalFromRow:row kind:kind previousRole:measured.previousRole result:result];
        if (proposal) [ranked addObject:proposal];
    }
    _ranked = ranked;

    // docs/always-propose.md: if the core's own top row is one this client cannot act on (a value field that
    // belongs to the form walk, an element that moved since the capture), the best row that SURVIVED is still a
    // proposal. Silence is only right when nothing here is actionable at all.
    SBNextProposal *top = [self proposalFromRow:answer[@"top"] kind:kind previousRole:measured.previousRole result:result] ?: ranked.firstObject;
    if (!top) return nil;
    SBLog(@"next-action: %@ proposes %@ (%.2f, %@)%@%@", kind, top.role, top.confidence, top.source,
          top.guess ? @" guess" : @"", top.locked ? @" locked" : @"");
    return top;
}

/// An empty box somebody types in that the app has put the keyboard into. `outSignature` receives its
/// signature when there is one.
+ (BOOL)window:(SBCaptureResult *)result hasAFocusedEmptyField:(NSString **)outSignature {
    for (SBField *field in result.fields) {
        if (!field.focused || field.value.length > 0) continue;
        if (![field.kind isEqualToString:SBKindText] && ![field.kind isEqualToString:SBKindTextArea]) continue;
        if (outSignature) *outSignature = field.signature;
        return YES;
    }
    return NO;
}

/**
 * Is the app already showing a list of answers directly under this box?
 *
 * An autocomplete menu, a "Suggested" list, a recent-files list: every one of them is the app saying "here
 * are the things you might mean". When that is on screen, typing is the long way round -- the answer is a
 * row you can press, and Shabang's job is to pick one of them rather than to invent a string.
 *
 * Read entirely off the capture Shabang already has: entries that sit below the box, overlap its column, and
 * start close enough underneath it to belong to it. No extra walk, no app knowledge, no list of sites.
 */
+ (BOOL)result:(SBCaptureResult *)result showsCandidatesUnder:(NSString *)signature {
    SBField *box = nil;
    for (SBField *field in result.fields) if ([field.signature isEqualToString:signature ?: @""]) box = field;
    if (!box || !SBRectIsUsable(box.rect)) return NO;
    CGFloat bottom = CGRectGetMaxY(box.rect);
    NSUInteger found = 0;
    for (SBField *other in result.fields) {
        if (![other.kind isEqualToString:SBKindItem] && ![other.kind isEqualToString:SBKindLink]) continue;
        CGRect r = other.rect;
        if (!SBRectIsUsable(r)) continue;
        CGFloat top = CGRectGetMinY(r);
        if (top < bottom - kCandidateOverlap || top > bottom + kCandidateReach) continue;
        // A different column of the window is a different thing entirely (a sidebar beside a search box).
        if (CGRectGetMaxX(r) <= CGRectGetMinX(box.rect) || CGRectGetMinX(r) >= CGRectGetMaxX(box.rect)) continue;
        if (++found >= kCandidatesNeeded) return YES;
    }
    return NO;
}

/// One ranked row, refused unless it still names a live, visible control of this capture.
- (SBNextProposal *)proposalFromRow:(id)row kind:(NSString *)kind previousRole:(NSString *)previousRole result:(SBCaptureResult *)result {
    if (![row isKindOfClass:[NSDictionary class]]) return nil;
    NSDictionary *dictionary = row;
    NSString *signature = [dictionary[@"id"] isKindOfClass:[NSString class]] ? dictionary[@"id"] : nil;
    if (signature.length == 0 || ![result nodeForSignature:signature]) return nil;

    SBField *target = nil;
    for (SBField *field in result.fields) if ([field.signature isEqualToString:signature]) target = field;
    if (!target) return nil;
    NSString *role = [dictionary[@"role"] isKindOfClass:[NSString class]] ? dictionary[@"role"] : @"unknown";
    // A proposal is a place to GO, not a value to write. A button, a link or a list entry is pressed; a box
    // you type in is offered by putting the cursor in it, which is what the writer does with a typeable
    // control instead of pressing it. Nothing here ever writes a value: the form walk does that, and this
    // whole path only runs when the form walk has nothing to offer at all.
    //
    // `field` is here as well as `search` because of what comes after an action: start a new message and the
    // next thing is the empty box that just appeared. Refusing it left Shabang proposing the search box that
    // was always there instead -- which is exactly the kind of guess that makes no sense to a person.
    BOOL clickable = [target.kind isEqualToString:SBKindButton] || [target.kind isEqualToString:SBKindLink] ||
                     [target.kind isEqualToString:SBKindItem];
    BOOL typeable = [target.kind isEqualToString:SBKindText] || [target.kind isEqualToString:SBKindTextArea];
    NSString *source = [dictionary[@"source"] isKindOfClass:[NSString class]] ? dictionary[@"source"] : @"prior";
    // "affordance" is the core's word for "nothing here ranks this role at all". A cursor dropped into a box
    // that nothing ranks is the noise that made every guess look like a text box, so `field` is offered only
    // where the place, or what the user just did, actually asks for one. `search` always ranks somewhere.
    BOOL ranked = ![source isEqualToString:@"affordance"];
    BOOL offerable = [role isEqualToString:@"search"] || ([role isEqualToString:@"field"] && ranked);
    if (!clickable && !(typeable && offerable)) return nil;
    // Never a box somebody has already written in: that is their text, and the cursor belongs where they left it.
    if (typeable && target.value.length > 0) return nil;
    // And never the box the cursor is ALREADY in. Accepting it would move the cursor to where the cursor is,
    // which is not an action. The focus signal is worth having because it says what the app thinks comes
    // next; it is not worth offering back to the user as a thing to press. Without this, opening a new
    // message in a chat app proposed the `To` field the app had just focused -- and the step after that,
    // knowing who to write to, is the one thing Shabang cannot help with at all.
    if (typeable && target.focused) return nil;

    SBNextProposal *proposal = [[SBNextProposal alloc] init];
    proposal.signature = signature;
    proposal.role = role;
    proposal.confidence = [dictionary[@"confidence"] isKindOfClass:[NSNumber class]] ? [dictionary[@"confidence"] doubleValue] : 0;
    // Rule 2 is belt AND braces: the core locked it, or the capture did.
    proposal.locked = [dictionary[@"locked"] isKindOfClass:[NSNumber class]] && [dictionary[@"locked"] boolValue];
    if (target.locked) proposal.locked = YES;
    proposal.source = source;
    proposal.guess = [dictionary[@"guess"] isKindOfClass:[NSNumber class]] && [dictionary[@"guess"] boolValue];
    proposal.reason = [dictionary[@"reason"] isKindOfClass:[NSString class]] ? dictionary[@"reason"] : @"";
    proposal.pageKind = kind;
    proposal.previousRole = previousRole.length ? previousRole : nil;
    return proposal;
}

- (void)recordOutcome:(NSString *)outcome forProposal:(SBNextProposal *)proposal {
    if (!proposal || proposal.role.length == 0 || [proposal.role isEqualToString:@"unknown"]) return;
    NSMutableDictionary<NSString *, NSString *> *parts = [NSMutableDictionary dictionary];
    parts[@"pageKind"] = proposal.pageKind ?: @"unknown";
    parts[@"role"] = proposal.role;
    if (proposal.previousRole.length) parts[@"previousRole"] = proposal.previousRole;
    [_memory record:parts outcome:outcome];
}

@end
