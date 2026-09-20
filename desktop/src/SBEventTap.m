#import "SBEventTap.h"
#import "SBLog.h"
#import <stdatomic.h>
#import <os/lock.h>

const int64_t SBSyntheticEventUserData = 0x5348424E47;   // "SHBNG": our own events, tagged so the tap ignores them
const CGKeyCode SBKeyCodeTab = 48;
const CGKeyCode SBKeyCodeEscape = 53;
const CGKeyCode SBKeyCodeRightOption = 61;
const CGKeyCode SBKeyCodeRightCommand = 54;

SBGhostKey SBGhostKeyFromName(NSString *name) {
    return [name isEqualToString:@"right-option"] ? SBGhostKeyRightOption : SBGhostKeyRightCommand;
}

CGKeyCode SBGhostKeyCode(SBGhostKey key) {
    return key == SBGhostKeyRightCommand ? SBKeyCodeRightCommand : SBKeyCodeRightOption;
}

CGEventFlags SBGhostKeyFlagMask(SBGhostKey key) {
    return key == SBGhostKeyRightCommand ? kCGEventFlagMaskCommand : kCGEventFlagMaskAlternate;
}

NSString *SBGhostKeyDisplayName(SBGhostKey key) {
    return key == SBGhostKeyRightCommand ? @"right \u2318" : @"right \u2325";
}
const NSTimeInterval SBGhostKeyTapSeconds = 0.3;

static const NSTimeInterval kWatchdogInterval = 5.0;
static const NSUInteger kChunkUnits = 20;   // CGEventKeyboardSetUnicodeString is unreliable past 20 UTF-16 units

typedef NS_OPTIONS(uint32_t, SBTapBits) {
    SBTapBitActive         = 1u << 0,
    SBTapBitHasCurrent     = 1u << 1,
    SBTapBitCurrentVisible = 1u << 2,
    SBTapBitCurrentLocked  = 1u << 3,
    SBTapBitCurrentPending = 1u << 4,
    SBTapBitFocusInWalk    = 1u << 5,
    SBTapBitFocusOnField   = 1u << 6,
    SBTapBitBusy           = 1u << 7,
    SBTapBitCanJump        = 1u << 8,
};

static _Atomic(bool) gRealKeyEventsForbidden = false;

void SBForbidRealKeyEvents(void) {
    atomic_store(&gRealKeyEventsForbidden, true);
}

BOOL SBRealKeyEventsForbidden(void) {
    return atomic_load(&gRealKeyEventsForbidden);
}

SBKeyModifiers SBKeyModifiersFromFlags(CGEventFlags flags) {
    SBKeyModifiers modifiers = SBKeyModifierNone;
    if (flags & kCGEventFlagMaskShift) modifiers |= SBKeyModifierShift;
    if (flags & kCGEventFlagMaskControl) modifiers |= SBKeyModifierControl;
    if (flags & kCGEventFlagMaskAlternate) modifiers |= SBKeyModifierOption;
    if (flags & kCGEventFlagMaskCommand) modifiers |= SBKeyModifierCommand;
    return modifiers;
}

static uint32_t SBPack(SBWalkSnapshot s) {
    return (s.active ? SBTapBitActive : 0) | (s.hasCurrent ? SBTapBitHasCurrent : 0) | (s.currentVisible ? SBTapBitCurrentVisible : 0)
         | (s.currentLocked ? SBTapBitCurrentLocked : 0) | (s.currentPending ? SBTapBitCurrentPending : 0)
         | (s.focusInWalk ? SBTapBitFocusInWalk : 0) | (s.focusOnField ? SBTapBitFocusOnField : 0) | (s.busy ? SBTapBitBusy : 0)
         | (s.canJump ? SBTapBitCanJump : 0);
}

static SBWalkSnapshot SBUnpack(uint32_t bits) {
    SBWalkSnapshot s = { 0 };
    s.active = (bits & SBTapBitActive) != 0;
    s.hasCurrent = (bits & SBTapBitHasCurrent) != 0;
    s.currentVisible = (bits & SBTapBitCurrentVisible) != 0;
    s.currentLocked = (bits & SBTapBitCurrentLocked) != 0;
    s.currentPending = (bits & SBTapBitCurrentPending) != 0;
    s.focusInWalk = (bits & SBTapBitFocusInWalk) != 0;
    s.focusOnField = (bits & SBTapBitFocusOnField) != 0;
    s.busy = (bits & SBTapBitBusy) != 0;
    s.canJump = (bits & SBTapBitCanJump) != 0;
    return s;
}

@interface SBEventTap ()
- (CGEventRef)handleEvent:(CGEventRef)event type:(CGEventType)type;
@end

static CGEventRef SBEventTapCallback(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *refcon) {
    SBEventTap *tap = (__bridge SBEventTap *)refcon;
    return [tap handleEvent:event type:type];
}

@implementation SBEventTap {
    _Atomic(uint32_t) _bits;
    _Atomic(bool) _haltRequested;
    _Atomic(bool) _scrollPending;
    _Atomic(bool) _typingPending;
    // Touched only by whoever feeds events in: the tap thread (or the test, which has no tap thread).
    SBHoldState _hold;
    BOOL _escapeOwned;
    /// Shabang key: when right Option went down, and whether the press is still a candidate for a lone tap.
    CFAbsoluteTime _ghostKeyDownAt;
    BOOL _ghostKeyArmed;
    os_unfair_lock _observerLock;
    void (^_userKeyObserver)(void);

    NSThread *_thread;
    dispatch_semaphore_t _threadDone;
    CFMachPortRef _port;
    CFRunLoopSourceRef _source;
    CFRunLoopRef _runLoop;
    NSTimer *_watchdog;
    BOOL _refusalLogged;
}

- (void)dealloc {
    [self uninstall];
}

#pragma mark snapshot

- (void)publishSnapshot:(SBWalkSnapshot)snapshot {
    atomic_store(&_bits, SBPack(snapshot));
}

- (SBWalkSnapshot)publishedSnapshot {
    return SBUnpack(atomic_load(&_bits));
}

- (void)haltHold {
    atomic_store(&_haltRequested, true);
}

#pragma mark user keys

- (void (^)(void))userKeyObserver {
    os_unfair_lock_lock(&_observerLock);
    void (^observer)(void) = _userKeyObserver;
    os_unfair_lock_unlock(&_observerLock);
    return observer;
}

- (void)setUserKeyObserver:(void (^)(void))observer {
    void (^copied)(void) = [observer copy];
    os_unfair_lock_lock(&_observerLock);
    _userKeyObserver = copied;
    os_unfair_lock_unlock(&_observerLock);
}

- (void)noteUserKeyDown {
    _ghostKeyArmed = NO;   // right Option plus another key is a chord, and chords are never ours
    @autoreleasepool {
        void (^observer)(void) = self.userKeyObserver;
        if (observer) observer();
    }
}

#pragma mark delivery

- (void)deliver:(void (^)(id<SBEventTapDelegate> delegate))block {
    __weak SBEventTap *weakSelf = self;
    void (^call)(void) = ^{
        id<SBEventTapDelegate> delegate = weakSelf.delegate;
        if (delegate) block(delegate);
    };
    if (self.deliversSynchronously) call(); else dispatch_async(dispatch_get_main_queue(), call);
}

#pragma mark the rule

- (BOOL)handleKeyDown:(CGKeyCode)keyCode flags:(CGEventFlags)flags isRepeat:(BOOL)isRepeat userData:(int64_t)userData printable:(BOOL)printable {
    if (userData == SBSyntheticEventUserData) return NO;   // our own typing
    [self noteUserKeyDown];
    SBWalkSnapshot snapshot = SBUnpack(atomic_load(&_bits));
    SBKeyModifiers modifiers = SBKeyModifiersFromFlags(flags);

    if (keyCode == SBKeyCodeTab) {
        if (!isRepeat) atomic_store(&_haltRequested, false);
        else if (atomic_exchange(&_haltRequested, false) && _hold.walking) _hold.halted = YES;
        SBKeyDecision decision = SBDecideTab(snapshot, modifiers, isRepeat, &_hold);
        if (decision == SBKeyDecisionPass) return NO;
        if (decision != SBKeyDecisionSwallow) {
            [self deliver:^(id<SBEventTapDelegate> delegate) { [delegate eventTap:self didConsumeTab:decision isRepeat:isRepeat]; }];
        }
        return YES;
    }
    if (keyCode == SBKeyCodeEscape) {
        SBKeyDecision decision = SBDecideEscape(snapshot, modifiers, isRepeat, &_escapeOwned);
        if (decision == SBKeyDecisionPass) return NO;
        if (decision == SBKeyDecisionDismiss) [self deliver:^(id<SBEventTapDelegate> delegate) { [delegate eventTapDidConsumeEscape:self]; }];
        return YES;
    }
    // Typing overrides. The key always goes to the app; Command and Control chords are shortcuts, not typing.
    if (snapshot.active && snapshot.focusOnField && printable && !(modifiers & (SBKeyModifierCommand | SBKeyModifierControl))) {
        if (!atomic_exchange(&_typingPending, true)) {
            [self deliver:^(id<SBEventTapDelegate> delegate) {
                atomic_store(&self->_typingPending, false);
                [delegate eventTapDidSeeTypingInField:self];
            }];
        }
    }
    return NO;
}

- (void)handleKeyUp:(CGKeyCode)keyCode userData:(int64_t)userData {
    if (userData == SBSyntheticEventUserData) return;
    if (keyCode == SBKeyCodeTab) _hold.walking = _hold.halted = NO;
    else if (keyCode == SBKeyCodeEscape) _escapeOwned = NO;
}

- (void)handleFlagsChanged:(CGEventFlags)flags keyCode:(CGKeyCode)keyCode {
    // A modifier pressed mid-hold ends Shabang's hold: what follows is a chord, and chords are never ours.
    if (SBKeyModifiersFromFlags(flags) != SBKeyModifierNone) _hold.walking = _hold.halted = NO;

    // The Shabang key (docs/accept-key.md). Tab belongs to the app on most screens - a video page, a mail
    // client, an editor, a spreadsheet, a file list all bind it - so the key that always works is a lone tap
    // of a right-hand modifier. The flagsChanged event is never consumed, so holding that key as a real
    // modifier, or using right Option for an accented character, is untouched: only a down-and-up with
    // nothing at all in between counts as a tap, which is what leaves no conflict surface.
    SBGhostKey ghostKey = self.ghostKey;
    if (keyCode != SBGhostKeyCode(ghostKey)) {
        // Some other modifier moved during the hold: that makes it a chord, not a tap.
        _ghostKeyArmed = NO;
        return;
    }
    BOOL down = (flags & SBGhostKeyFlagMask(ghostKey)) != 0;
    if (down) {
        _ghostKeyDownAt = CFAbsoluteTimeGetCurrent();
        _ghostKeyArmed = YES;
        return;
    }
    BOOL wasTap = _ghostKeyArmed && (CFAbsoluteTimeGetCurrent() - _ghostKeyDownAt) <= SBGhostKeyTapSeconds;
    _ghostKeyArmed = NO;
    if (!wasTap) return;
    // Only when a ghost is actually on screen. A stray tap anywhere else does nothing at all.
    SBWalkSnapshot snapshot = SBUnpack(atomic_load(&_bits));
    if (!snapshot.active || !snapshot.hasCurrent) return;
    [self deliver:^(id<SBEventTapDelegate> delegate) { [delegate eventTapDidTapGhostKey:self]; }];
}

- (void)handleScroll {
    uint32_t bits = atomic_load(&_bits);
    if (!(bits & SBTapBitActive) || !(bits & SBTapBitHasCurrent)) return;
    if (atomic_exchange(&_scrollPending, true)) return;
    [self deliver:^(id<SBEventTapDelegate> delegate) {
        atomic_store(&self->_scrollPending, false);
        [delegate eventTapDidSeeScroll:self];
    }];
}

static BOOL SBEventIsPrintable(CGEventRef event) {
    UniChar chars[4] = { 0 };
    UniCharCount length = 0;
    CGEventKeyboardGetUnicodeString(event, 4, &length, chars);
    if (length == 0) return NO;
    UniChar c = chars[0];
    if (c < 0x20 || c == 0x7F) return NO;          // control characters: Return, Tab, Backspace, Escape
    if (c >= 0xF700 && c <= 0xF8FF) return NO;     // arrows and function keys (AppKit's private range)
    return YES;
}

- (CGEventRef)handleEvent:(CGEventRef)event type:(CGEventType)type {
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
        if (_port) CGEventTapEnable(_port, true);
        _reenableCount++;
        _hold.walking = _hold.halted = NO;
        _escapeOwned = NO;
        return event;
    }
    if (!event) return event;
    // Fast path: Shabang is off, untrusted or paused. Nothing is looked at, but a user key still aborts a sequence
    // in flight (the frontmost app may have changed under it).
    if (!(atomic_load(&_bits) & SBTapBitActive)) {
        if (type == kCGEventKeyDown && CGEventGetIntegerValueField(event, kCGEventSourceUserData) != SBSyntheticEventUserData) [self noteUserKeyDown];
        _hold.walking = _hold.halted = NO;
        _escapeOwned = NO;
        return event;
    }
    switch (type) {
        case kCGEventKeyDown: {
            int64_t userData = CGEventGetIntegerValueField(event, kCGEventSourceUserData);
            CGKeyCode keyCode = (CGKeyCode)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
            BOOL isRepeat = CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat) != 0;
            BOOL special = keyCode == SBKeyCodeTab || keyCode == SBKeyCodeEscape;
            BOOL printable = !special && (atomic_load(&_bits) & SBTapBitFocusOnField) && SBEventIsPrintable(event);
            return [self handleKeyDown:keyCode flags:CGEventGetFlags(event) isRepeat:isRepeat userData:userData printable:printable] ? NULL : event;
        }
        case kCGEventKeyUp:
            [self handleKeyUp:(CGKeyCode)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode)
                     userData:CGEventGetIntegerValueField(event, kCGEventSourceUserData)];
            return event;
        case kCGEventFlagsChanged:
            [self handleFlagsChanged:CGEventGetFlags(event) keyCode:(CGKeyCode)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode)];
            return event;
        case kCGEventScrollWheel:
            [self handleScroll];
            return event;
        default:
            return event;
    }
}

#pragma mark install

- (BOOL)installed {
    return _port != NULL && CGEventTapIsEnabled(_port);
}

- (BOOL)install {
    _wanted = YES;
    [self startWatchdog];
    return [self createTap];
}

- (BOOL)createTap {
    if (_port) return YES;
    CGEventMask mask = CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp) | CGEventMaskBit(kCGEventFlagsChanged) | CGEventMaskBit(kCGEventScrollWheel);
    CFMachPortRef port = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault, mask, SBEventTapCallback, (__bridge void *)self);
    if (!port) {
        if (!_refusalLogged) SBLog(@"tap: the system refused the event tap (Accessibility permission missing?); Tab stays native, retrying every %.0f s", kWatchdogInterval);
        _refusalLogged = YES;
        return NO;
    }
    _refusalLogged = NO;
    _port = port;
    _source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0);
    _hold = (SBHoldState){ NO, NO };
    _escapeOwned = NO;

    CFRunLoopSourceRef source = _source;
    dispatch_semaphore_t ready = dispatch_semaphore_create(0);
    dispatch_semaphore_t finished = dispatch_semaphore_create(0);
    _threadDone = finished;
    __block CFRunLoopRef runLoop = NULL;
    _thread = [[NSThread alloc] initWithBlock:^{
        runLoop = CFRunLoopGetCurrent();
        CFRetain(runLoop);
        CFRunLoopAddSource(runLoop, source, kCFRunLoopCommonModes);
        dispatch_semaphore_signal(ready);
        CFRunLoopRun();
        dispatch_semaphore_signal(finished);
    }];
    _thread.name = @"dev.shabang.desktop.eventtap";
    _thread.qualityOfService = NSQualityOfServiceUserInteractive;
    [_thread start];
    dispatch_semaphore_wait(ready, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2 * NSEC_PER_SEC)));
    _runLoop = runLoop;
    CGEventTapEnable(port, true);
    SBLog(@"tap: installed (session level, head insert: keyDown, keyUp, flagsChanged, scrollWheel)");
    return YES;
}

- (void)destroyTap {
    if (!_port) return;
    CGEventTapEnable(_port, false);
    if (_runLoop) {
        if (_source) CFRunLoopRemoveSource(_runLoop, _source, kCFRunLoopCommonModes);
        CFRunLoopStop(_runLoop);
        CFRelease(_runLoop);
        _runLoop = NULL;
        // No callback may still be running when the port goes away (it re-enables the port on a timeout).
        if (_threadDone) dispatch_semaphore_wait(_threadDone, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1 * NSEC_PER_SEC)));
        _threadDone = nil;
    }
    CFMachPortInvalidate(_port);
    if (_source) CFRelease(_source);
    CFRelease(_port);
    _source = NULL;
    _port = NULL;
    _thread = nil;
    SBLog(@"tap: removed");
}

- (void)uninstall {
    _wanted = NO;
    [_watchdog invalidate];
    _watchdog = nil;
    SBWalkSnapshot off = { 0 };
    [self publishSnapshot:off];
    [self destroyTap];
}

- (void)startWatchdog {
    if (_watchdog) return;
    __weak SBEventTap *weakSelf = self;
    _watchdog = [NSTimer timerWithTimeInterval:kWatchdogInterval repeats:YES block:^(NSTimer *timer) {
        SBEventTap *tap = weakSelf;
        if (!tap || !tap.wanted) { [timer invalidate]; return; }
        [tap checkTap];
    }];
    _watchdog.tolerance = 1.0;
    [[NSRunLoop mainRunLoop] addTimer:_watchdog forMode:NSRunLoopCommonModes];
}

- (void)checkTap {
    if (!_port) { [self createTap]; return; }
    if (CGEventTapIsEnabled(_port)) return;
    CGEventTapEnable(_port, true);
    _reenableCount++;
    SBLog(@"tap: was disabled by the system, re-enabled (%lu so far)", (unsigned long)_reenableCount);
}

#pragma mark posting

+ (NSArray<NSString *> *)chunksForText:(NSString *)text {
    NSMutableString *clean = [NSMutableString stringWithCapacity:text.length];
    BOOL lastWasSpace = NO;
    for (NSUInteger i = 0; i < text.length; i++) {
        unichar c = [text characterAtIndex:i];
        BOOL control = c < 0x20 || c == 0x7F || c == 0x2028 || c == 0x2029;
        if (control) {
            // Never an Enter, never a Tab: a line break becomes one space.
            if (!lastWasSpace && clean.length > 0) [clean appendString:@" "];
            lastWasSpace = YES;
            continue;
        }
        [clean appendFormat:@"%C", c];
        lastWasSpace = c == ' ';
    }
    NSMutableArray<NSString *> *chunks = [NSMutableArray array];
    NSUInteger index = 0;
    while (index < clean.length) {
        NSUInteger length = MIN(kChunkUnits, clean.length - index);
        NSRange range = [clean rangeOfComposedCharacterSequencesForRange:NSMakeRange(index, length)];
        // The composed range may grow past the limit by one sequence; shrink by whole sequences when it can.
        while (range.length > kChunkUnits) {
            NSRange last = [clean rangeOfComposedCharacterSequenceAtIndex:NSMaxRange(range) - 1];
            if (last.location <= range.location) break;
            range.length = last.location - range.location;
        }
        [chunks addObject:[clean substringWithRange:range]];
        index = NSMaxRange(range);
    }
    return chunks;
}

+ (BOOL)postEventWithSource:(CGEventSourceRef)source keyCode:(CGKeyCode)keyCode text:(NSString *)text {
    if (SBRealKeyEventsForbidden()) return NO;
    for (int down = 1; down >= 0; down--) {
        CGEventRef event = CGEventCreateKeyboardEvent(source, keyCode, down == 1);
        if (!event) return NO;
        CGEventSetFlags(event, 0);
        if (text.length) {
            UniChar buffer[kChunkUnits * 2];
            NSUInteger length = MIN(text.length, (NSUInteger)(kChunkUnits * 2));
            [text getCharacters:buffer range:NSMakeRange(0, length)];
            CGEventKeyboardSetUnicodeString(event, length, buffer);
        }
        CGEventSetIntegerValueField(event, kCGEventSourceUserData, SBSyntheticEventUserData);
        CGEventPost(kCGHIDEventTap, event);
        CFRelease(event);
    }
    return YES;
}

+ (BOOL)postKeyCode:(CGKeyCode)keyCode {
    CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStatePrivate);
    if (!source) return NO;
    CGEventSourceSetUserData(source, SBSyntheticEventUserData);
    BOOL ok = [self postEventWithSource:source keyCode:keyCode text:nil];
    CFRelease(source);
    return ok;
}

@end
