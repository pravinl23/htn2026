#import "GHWalkState.h"
#import "GHLog.h"   // GHProductName: the brand, written down once

NSString *const GHWalkFocusElsewhere = @"elsewhere";

NSString *const GHGhostActionFill = @"fill";
NSString *const GHGhostActionSelect = @"select";
NSString *const GHGhostActionCheck = @"check";
NSString *const GHGhostActionClick = @"click";
NSString *const GHGhostActionUpload = @"upload";

#pragma mark - GHGhost

@implementation GHGhost

- (instancetype)init {
    if ((self = [super init])) {
        _signature = @"";
        _action = GHGhostActionFill;
        _displayText = @"";
        _source = @"offline";
    }
    return self;
}

+ (instancetype)ghostWithDictionary:(NSDictionary<NSString *, id> *)dictionary {
    if (![dictionary isKindOfClass:[NSDictionary class]]) return nil;
    NSString *signature = dictionary[@"signature"], *action = dictionary[@"action"];
    if (![signature isKindOfClass:[NSString class]] || signature.length == 0) return nil;
    if (![action isKindOfClass:[NSString class]]) return nil;
    if (![@[ GHGhostActionFill, GHGhostActionSelect, GHGhostActionCheck, GHGhostActionClick, GHGhostActionUpload ] containsObject:action]) return nil;
    GHGhost *ghost = [[GHGhost alloc] init];
    ghost.signature = signature;
    ghost.action = action;
    id value = dictionary[@"value"], text = dictionary[@"displayText"], confidence = dictionary[@"confidence"];
    id locked = dictionary[@"locked"], source = dictionary[@"source"], pending = dictionary[@"pending"], lazy = dictionary[@"lazy"];
    ghost.value = [value isKindOfClass:[NSString class]] ? value : nil;
    ghost.displayText = [text isKindOfClass:[NSString class]] ? text : @"";
    ghost.confidence = [confidence isKindOfClass:[NSNumber class]] ? [confidence doubleValue] : 0;
    // A click ghost only ever exists as the parked lock: anything else claiming to click is treated as locked too.
    ghost.locked = ([locked isKindOfClass:[NSNumber class]] && [locked boolValue]) || [action isEqualToString:GHGhostActionClick];
    ghost.source = [source isKindOfClass:[NSString class]] ? source : @"offline";
    ghost.pending = [pending isKindOfClass:[NSNumber class]] && [pending boolValue];
    // Only a select can be lazy: anything else claiming it is an ordinary ghost.
    ghost.lazy = [action isEqualToString:GHGhostActionSelect] && [lazy isKindOfClass:[NSNumber class]] && [lazy boolValue];
    ghost.declineAnswer = ghost.lazy && [dictionary[@"lazyMatch"] isEqual:@"decline"];
    ghost.neutralFallback = ghost.lazy && [dictionary[@"lazyMatch"] isEqual:@"neutral"];
    // A locked ghost is an action, never an answer: it is never a guess and never learned from.
    ghost.guess = !ghost.locked && [dictionary[@"guess"] isKindOfClass:[NSNumber class]] && [dictionary[@"guess"] boolValue];
    ghost.needsReview = ghost.guess || (!ghost.locked && [dictionary[@"needsReview"] isKindOfClass:[NSNumber class]] && [dictionary[@"needsReview"] boolValue]);
    ghost.answerSource = [dictionary[@"answerSource"] isKindOfClass:[NSString class]] ? dictionary[@"answerSource"] : nil;
    ghost.answerClass = [dictionary[@"answerClass"] isKindOfClass:[NSString class]] ? dictionary[@"answerClass"] : nil;
    ghost.reason = [dictionary[@"reason"] isKindOfClass:[NSString class]] ? dictionary[@"reason"] : nil;
    ghost.questionKey = [dictionary[@"questionKey"] isKindOfClass:[NSString class]] ? dictionary[@"questionKey"] : nil;
    return ghost;
}

+ (NSArray<GHGhost *> *)ghostsWithDictionaries:(NSArray *)dictionaries {
    NSMutableArray<GHGhost *> *ghosts = [NSMutableArray array];
    if (![dictionaries isKindOfClass:[NSArray class]]) return ghosts;
    for (id entry in dictionaries) {
        GHGhost *ghost = [self ghostWithDictionary:entry];
        if (ghost) [ghosts addObject:ghost];
    }
    return ghosts;
}

- (NSDictionary<NSString *, id> *)dictionary {
    NSMutableDictionary<NSString *, id> *out = [NSMutableDictionary dictionary];
    out[@"signature"] = self.signature;
    out[@"action"] = self.action;
    if (self.value) out[@"value"] = self.value;
    out[@"displayText"] = self.displayText ?: @"";
    out[@"confidence"] = @(self.confidence);
    out[@"locked"] = @(self.locked);
    out[@"source"] = self.source ?: @"offline";
    if (self.pending) out[@"pending"] = @YES;
    if (self.lazy) out[@"lazy"] = @YES;
    if (self.declineAnswer) out[@"lazyMatch"] = @"decline";
    else if (self.neutralFallback) out[@"lazyMatch"] = @"neutral";
    if (self.guess) out[@"guess"] = @YES;
    if (self.needsReview) out[@"needsReview"] = @YES;
    if (self.answerSource) out[@"answerSource"] = self.answerSource;
    if (self.answerClass) out[@"answerClass"] = self.answerClass;
    if (self.reason) out[@"reason"] = self.reason;
    if (self.questionKey) out[@"questionKey"] = self.questionKey;
    return out;
}

- (NSInteger)keystrokes {
    if ([self.action isEqualToString:GHGhostActionFill]) return (NSInteger)self.value.length;
    return 1;
}

- (id)copyWithZone:(NSZone *)zone {
    GHGhost *copy = [[GHGhost allocWithZone:zone] init];
    copy.signature = self.signature;
    copy.action = self.action;
    copy.value = self.value;
    copy.displayText = self.displayText;
    copy.confidence = self.confidence;
    copy.locked = self.locked;
    copy.source = self.source;
    copy.pending = self.pending;
    copy.lazy = self.lazy;
    copy.declineAnswer = self.declineAnswer;
    copy.neutralFallback = self.neutralFallback;
    copy.guess = self.guess;
    copy.needsReview = self.needsReview;
    copy.answerSource = self.answerSource;
    copy.answerClass = self.answerClass;
    copy.reason = self.reason;
    copy.questionKey = self.questionKey;
    return copy;
}

- (NSString *)description {
    // Never the value or the display text.
    return [NSString stringWithFormat:@"<GHGhost %@ %@%@%@%@%@>", self.action, self.signature, self.locked ? @" locked" : @"",
            self.pending ? @" pending" : @"", self.lazy ? @" lazy" : @"", self.guess ? @" guess" : @""];
}

@end

#pragma mark - key decisions

GHKeyDecision GHDecideTab(GHWalkSnapshot snapshot, GHKeyModifiers modifiers, BOOL isRepeat, GHHoldState *hold) {
    GHHoldState scratch = { NO, NO };
    if (!hold) hold = &scratch;
    // Disabled, untrusted, paused app: nothing is ever consumed. Shift+Tab and modified Tab are always native.
    if (!snapshot.active || modifiers != GHKeyModifierNone) {
        hold->walking = hold->halted = NO;
        return GHKeyDecisionPass;
    }
    // A press during a write is Ghost's only while focus is still in the walk: a fresh one is queued (and owns the
    // hold that follows), a repeat is dropped. Anywhere else (another app, another field) Tab stays native.
    if (snapshot.busy) {
        if (isRepeat) return hold->walking ? GHKeyDecisionSwallow : GHKeyDecisionPass;
        if (!snapshot.focusInWalk) {
            hold->walking = hold->halted = NO;
            return GHKeyDecisionPass;
        }
        hold->walking = YES;
        hold->halted = NO;
        return GHKeyDecisionQueue;
    }
    if (!isRepeat) hold->walking = hold->halted = NO;
    else if (!hold->walking) return GHKeyDecisionPass;   // a hold that started as native Tab stays native
    if (!snapshot.hasCurrent || !snapshot.currentVisible) {
        // The desktop jump: ghosts exist but the current one is off screen, and focus is in the walk (the page itself,
        // typically). A fresh press scrolls it into view and writes nothing; a repeat never jumps.
        if (!isRepeat && snapshot.hasCurrent && snapshot.canJump && snapshot.focusInWalk) {
            hold->walking = YES;
            return GHKeyDecisionJump;
        }
        // The walk ran out mid-hold: do not let focus race off natively. A fresh press is the app's.
        return isRepeat ? GHKeyDecisionSwallow : GHKeyDecisionPass;
    }
    // Focus outside the walk means the Tab belonged to whatever the user was focused on, and it goes back.
    //
    // This was briefly widened so that Tab also took a next-action proposal when focus was on a list row --
    // which did make Tab work in Messages and Spotify. It is not worth it. Tab is the most overloaded key on
    // the keyboard, and a "helper" that takes it where an app has its own meaning for it is a bug however
    // convenient the good case looks. Tab stays what it is: the accept key where Ghost is doing what Tab
    // already does, walking a form and filling it. Everywhere else the Ghost key is the accept key, and it
    // has no conflict surface at all (GHEventTap: a lone modifier tap, never a chord).
    if (!isRepeat && !snapshot.focusInWalk) return GHKeyDecisionPass;
    hold->walking = YES;
    if (isRepeat && hold->halted) return GHKeyDecisionSwallow;
    if (snapshot.currentLocked) {
        hold->halted = YES;   // Tab never activates a lock; the rest of this hold is swallowed
        return GHKeyDecisionPark;
    }
    return GHKeyDecisionAccept;
}

GHKeyDecision GHDecideEscape(GHWalkSnapshot snapshot, GHKeyModifiers modifiers, BOOL isRepeat, BOOL *owned) {
    BOOL scratch = NO;
    if (!owned) owned = &scratch;
    if (isRepeat) return *owned ? GHKeyDecisionSwallow : GHKeyDecisionPass;
    *owned = NO;
    if (!snapshot.active || modifiers != GHKeyModifierNone || snapshot.busy) return GHKeyDecisionPass;
    if (!snapshot.hasCurrent || !snapshot.currentVisible || !snapshot.focusInWalk) return GHKeyDecisionPass;
    *owned = YES;
    return GHKeyDecisionDismiss;
}

#pragma mark - GHWalkState

@implementation GHWalkState {
    NSMutableArray<GHGhost *> *_ghosts;
    NSMutableSet<NSString *> *_dismissed;
    NSMutableSet<NSString *> *_acceptedSignatures;
}

- (instancetype)init {
    if ((self = [super init])) {
        _ghosts = [NSMutableArray array];
        _dismissed = [NSMutableSet set];
        _acceptedSignatures = [NSMutableSet set];
        _currentIndex = -1;
    }
    return self;
}

- (NSArray<GHGhost *> *)ghosts { return [_ghosts copy]; }
- (NSSet<NSString *> *)dismissed { return [_dismissed copy]; }
- (NSSet<NSString *> *)acceptedSignatures { return [_acceptedSignatures copy]; }

- (GHGhost *)current {
    return (_currentIndex >= 0 && _currentIndex < (NSInteger)_ghosts.count) ? _ghosts[(NSUInteger)_currentIndex] : nil;
}

- (BOOL)hasUnlocked {
    for (GHGhost *ghost in _ghosts) if (!ghost.locked) return YES;
    return NO;
}

- (BOOL)keepLock { return _accepted > 0 && _lockSignature != nil; }
- (BOOL)finished { return _accepted > 0 && !self.hasUnlocked; }

- (NSInteger)indexOfSignature:(NSString *)signature {
    if (!signature) return -1;
    for (NSUInteger i = 0; i < _ghosts.count; i++) if ([_ghosts[i].signature isEqualToString:signature]) return (NSInteger)i;
    return -1;
}

- (GHGhost *)ghostWithSignature:(NSString *)signature {
    NSInteger index = [self indexOfSignature:signature];
    return index >= 0 ? _ghosts[(NSUInteger)index] : nil;
}

/// Rule 2: the lock ghost only becomes current once no unlocked ghost is left, however focus got to the button.
- (BOOL)lockedTooEarly:(NSInteger)index {
    if (index < 0 || index >= (NSInteger)_ghosts.count) return NO;
    return _ghosts[(NSUInteger)index].locked && self.hasUnlocked;
}

/// Next unlocked ghost at or after `from`, wrapping around; the locked one only when nothing else is left.
- (NSInteger)nextFrom:(NSInteger)from {
    NSInteger count = (NSInteger)_ghosts.count;
    if (count == 0) return -1;
    if (from < 0) from = 0;
    for (NSInteger step = 0; step < count; step++) {
        NSInteger index = (from + step) % count;
        if (!_ghosts[(NSUInteger)index].locked) return index;
    }
    return count - 1;   // only the lock is left, and it is last
}

/// A lone Submit ghost is only worth showing once this walk has filled something.
- (void)prune {
    if (_ghosts.count > 0 && (_accepted > 0 || self.hasUnlocked)) return;
    [_ghosts removeAllObjects];
}

/// Remembers the walk's Submit while value ghosts are around; afterwards any other lone lock ghost is a stranger.
- (void)trackLock {
    GHGhost *lock = nil;
    for (GHGhost *ghost in _ghosts) if (ghost.locked) { lock = ghost; break; }
    if (self.hasUnlocked) _lockSignature = [lock.signature copy];
    else if (lock && ![lock.signature isEqualToString:_lockSignature ?: @""]) [_ghosts removeAllObjects];
}

- (void)rescanWithGhosts:(NSArray<GHGhost *> *)ghosts {
    NSString *previous = self.current.signature;
    NSMutableArray<GHGhost *> *unlocked = [NSMutableArray array];
    NSMutableSet<NSString *> *seen = [NSMutableSet set];
    GHGhost *lock = nil;
    for (GHGhost *ghost in ghosts) {
        if (ghost.signature.length == 0 || [_dismissed containsObject:ghost.signature] || [seen containsObject:ghost.signature]) continue;
        [seen addObject:ghost.signature];
        if (ghost.locked) lock = ghost; else [unlocked addObject:ghost];
    }
    _ghosts = unlocked;
    if (lock) [_ghosts addObject:lock];   // parked last, whatever order the list came in
    [self trackLock];
    [self prune];

    NSInteger chosen = -1;
    NSString *focus = [_focusSignature isEqualToString:GHWalkFocusElsewhere] ? nil : _focusSignature;
    for (NSString *candidate in @[ previous ?: @"", focus ?: @"" ]) {
        NSInteger index = candidate.length ? [self indexOfSignature:candidate] : -1;
        if (index >= 0 && ![self lockedTooEarly:index]) { chosen = index; break; }
    }
    _currentIndex = chosen >= 0 ? chosen : [self nextFrom:0];
}

/// Drops a ghost. A different current ghost (the user moved focus mid-write) stays current.
- (void)remove:(NSString *)signature {
    NSInteger index = [self indexOfSignature:signature];
    if (index < 0) return;
    NSString *current = self.current.signature;
    _leftSignature = [signature copy];
    [_ghosts removeObjectAtIndex:(NSUInteger)index];
    [self prune];
    if (current && ![current isEqualToString:signature] && [self indexOfSignature:current] >= 0) _currentIndex = [self indexOfSignature:current];
    else _currentIndex = [self nextFrom:index];
}

- (void)accept:(NSString *)signature {
    GHGhost *ghost = [self ghostWithSignature:signature];
    if (!ghost || ghost.locked) return;   // a lock ghost is never accepted
    _accepted++;
    [_acceptedSignatures addObject:signature];
    _keystrokesSaved += ghost.keystrokes;
    _error = nil;
    [self remove:signature];
}

- (void)dismiss:(NSString *)signature {
    if (signature.length == 0) return;
    [_dismissed addObject:signature];
    [self remove:signature];
}

- (void)typedOver:(NSString *)signature {
    if (signature.length == 0 || [signature isEqualToString:GHWalkFocusElsewhere]) return;
    [self dismiss:signature];
}

- (void)drop:(NSString *)signature {
    NSString *left = _leftSignature;
    [self remove:signature];
    _leftSignature = left;   // the walk did not leave a field, the field left the walk
}

- (void)fail:(NSString *)signature reason:(NSString *)reason {
    _error = [NSString stringWithFormat:@"%@ could not fill this field (%@)", GHProductName, reason.length ? reason : @"failed"];
    [self dismiss:signature];
}

- (void)focusMoved:(NSString *)signature {
    _focusSignature = [signature copy];
    if (!signature || [signature isEqualToString:GHWalkFocusElsewhere]) return;
    NSInteger index = [self indexOfSignature:signature];
    if (index >= 0 && ![self lockedTooEarly:index]) _currentIndex = index;
}

- (BOOL)makeCurrent:(NSString *)signature {
    NSInteger index = [self indexOfSignature:signature];
    if (index < 0 || [self lockedTooEarly:index]) return NO;
    _currentIndex = index;
    return YES;
}

- (void)noteFocus:(NSString *)signature {
    _focusSignature = [signature copy];
}

- (BOOL)updateGhost:(GHGhost *)ghost {
    NSInteger index = [self indexOfSignature:ghost.signature];
    if (index < 0 || _ghosts[(NSUInteger)index].locked || ghost.locked) return NO;
    _ghosts[(NSUInteger)index] = [ghost copy];
    return YES;
}

- (BOOL)skipPendingCurrent {
    NSInteger count = (NSInteger)_ghosts.count;
    if (count == 0 || _currentIndex < 0) return NO;
    for (NSInteger step = 1; step <= count; step++) {
        NSInteger index = (_currentIndex + step) % count;
        GHGhost *ghost = _ghosts[(NSUInteger)index];
        if (!ghost.locked && !ghost.pending) { _currentIndex = index; return YES; }
    }
    return NO;
}

- (void)reset {
    [_ghosts removeAllObjects];
    [_dismissed removeAllObjects];
    [_acceptedSignatures removeAllObjects];
    _currentIndex = -1;
    _accepted = 0;
    _keystrokesSaved = 0;
    _error = nil;
    _leftSignature = nil;
    _lockSignature = nil;
    // _focusSignature is a fact about the keyboard, not about the walk: it stays.
}

#pragma mark snapshot

- (BOOL)focus:(NSString *)focus isInWalkOf:(GHGhost *)current {
    if (!focus) return YES;   // the window itself
    if ([focus isEqualToString:GHWalkFocusElsewhere]) return NO;
    if (current && [focus isEqualToString:current.signature]) return YES;
    return _leftSignature != nil && [focus isEqualToString:_leftSignature];
}

- (GHWalkSnapshot)snapshotForFocus:(NSString *)focus active:(BOOL)active currentVisible:(BOOL)currentVisible busy:(BOOL)busy {
    GHGhost *current = self.current;
    GHWalkSnapshot snapshot = { 0 };
    snapshot.active = active;
    snapshot.hasCurrent = current != nil;
    snapshot.currentVisible = current != nil && currentVisible;
    snapshot.currentLocked = current.locked;
    snapshot.currentPending = current.pending;
    snapshot.focusInWalk = [self focus:focus isInWalkOf:current];
    snapshot.focusOnField = focus != nil && ![focus isEqualToString:GHWalkFocusElsewhere];
    snapshot.busy = busy;
    return snapshot;
}

- (GHWalkSnapshot)snapshotWithActive:(BOOL)active currentVisible:(BOOL)currentVisible busy:(BOOL)busy {
    return [self snapshotForFocus:_focusSignature active:active currentVisible:currentVisible busy:busy];
}

- (BOOL)shouldConsumeTabWithModifiers:(GHKeyModifiers)modifiers isRepeat:(BOOL)isRepeat focusSignature:(NSString *)focusSignature
                       currentVisible:(BOOL)currentVisible hold:(GHHoldState *)hold {
    GHWalkSnapshot snapshot = [self snapshotForFocus:focusSignature active:YES currentVisible:currentVisible busy:NO];
    return GHKeyDecisionConsumes(GHDecideTab(snapshot, modifiers, isRepeat, hold));
}

- (BOOL)shouldConsumeEscapeWithModifiers:(GHKeyModifiers)modifiers focusSignature:(NSString *)focusSignature currentVisible:(BOOL)currentVisible {
    GHWalkSnapshot snapshot = [self snapshotForFocus:focusSignature active:YES currentVisible:currentVisible busy:NO];
    return GHKeyDecisionConsumes(GHDecideEscape(snapshot, modifiers, NO, NULL));
}

@end
