#import "GHEventTap.h"
#import "GHLog.h"
#import <stdatomic.h>
#import <os/lock.h>

const int64_t GHSyntheticEventUserData = 0x47484F5354;   // "GHOST"
const CGKeyCode GHKeyCodeTab = 48;
const CGKeyCode GHKeyCodeEscape = 53;
const CGKeyCode GHKeyCodeRightOption = 61;
const NSTimeInterval GHGhostKeyTapSeconds = 0.3;

static const NSTimeInterval kWatchdogInterval = 5.0;
static const NSUInteger kChunkUnits = 20;   // CGEventKeyboardSetUnicodeString is unreliable past 20 UTF-16 units

typedef NS_OPTIONS(uint32_t, GHTapBits) {
    GHTapBitActive         = 1u << 0,
    GHTapBitHasCurrent     = 1u << 1,
    GHTapBitCurrentVisible = 1u << 2,
    GHTapBitCurrentLocked  = 1u << 3,
    GHTapBitCurrentPending = 1u << 4,
    GHTapBitFocusInWalk    = 1u << 5,
    GHTapBitFocusOnField   = 1u << 6,
    GHTapBitBusy           = 1u << 7,
    GHTapBitCanJump        = 1u << 8,
};

static _Atomic(bool) gRealKeyEventsForbidden = false;

void GHForbidRealKeyEvents(void) {
    atomic_store(&gRealKeyEventsForbidden, true);
}

BOOL GHRealKeyEventsForbidden(void) {
    return atomic_load(&gRealKeyEventsForbidden);
}

GHKeyModifiers GHKeyModifiersFromFlags(CGEventFlags flags) {
    GHKeyModifiers modifiers = GHKeyModifierNone;
    if (flags & kCGEventFlagMaskShift) modifiers |= GHKeyModifierShift;
    if (flags & kCGEventFlagMaskControl) modifiers |= GHKeyModifierControl;
    if (flags & kCGEventFlagMaskAlternate) modifiers |= GHKeyModifierOption;
    if (flags & kCGEventFlagMaskCommand) modifiers |= GHKeyModifierCommand;
    return modifiers;
}

static uint32_t GHPack(GHWalkSnapshot s) {
    return (s.active ? GHTapBitActive : 0) | (s.hasCurrent ? GHTapBitHasCurrent : 0) | (s.currentVisible ? GHTapBitCurrentVisible : 0)
         | (s.currentLocked ? GHTapBitCurrentLocked : 0) | (s.currentPending ? GHTapBitCurrentPending : 0)
         | (s.focusInWalk ? GHTapBitFocusInWalk : 0) | (s.focusOnField ? GHTapBitFocusOnField : 0) | (s.busy ? GHTapBitBusy : 0)
         | (s.canJump ? GHTapBitCanJump : 0);
}

static GHWalkSnapshot GHUnpack(uint32_t bits) {
    GHWalkSnapshot s = { 0 };
    s.active = (bits & GHTapBitActive) != 0;
    s.hasCurrent = (bits & GHTapBitHasCurrent) != 0;
    s.currentVisible = (bits & GHTapBitCurrentVisible) != 0;
    s.currentLocked = (bits & GHTapBitCurrentLocked) != 0;
    s.currentPending = (bits & GHTapBitCurrentPending) != 0;
    s.focusInWalk = (bits & GHTapBitFocusInWalk) != 0;
    s.focusOnField = (bits & GHTapBitFocusOnField) != 0;
    s.busy = (bits & GHTapBitBusy) != 0;
    s.canJump = (bits & GHTapBitCanJump) != 0;
    return s;
}

@interface GHEventTap ()
- (CGEventRef)handleEvent:(CGEventRef)event type:(CGEventType)type;
@end

static CGEventRef GHEventTapCallback(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *refcon) {
    GHEventTap *tap = (__bridge GHEventTap *)refcon;
    return [tap handleEvent:event type:type];
}

@implementation GHEventTap {
    _Atomic(uint32_t) _bits;
    _Atomic(bool) _haltRequested;
    _Atomic(bool) _scrollPending;
    _Atomic(bool) _typingPending;
    // Touched only by whoever feeds events in: the tap thread (or the test, which has no tap thread).
    GHHoldState _hold;
    BOOL _escapeOwned;
    /// Ghost key: when right Option went down, and whether the press is still a candidate for a lone tap.
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

- (void)publishSnapshot:(GHWalkSnapshot)snapshot {
    atomic_store(&_bits, GHPack(snapshot));
}

- (GHWalkSnapshot)publishedSnapshot {
    return GHUnpack(atomic_load(&_bits));
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

- (void)deliver:(void (^)(id<GHEventTapDelegate> delegate))block {
    __weak GHEventTap *weakSelf = self;
    void (^call)(void) = ^{
        id<GHEventTapDelegate> delegate = weakSelf.delegate;
        if (delegate) block(delegate);
    };
    if (self.deliversSynchronously) call(); else dispatch_async(dispatch_get_main_queue(), call);
}

#pragma mark the rule

- (BOOL)handleKeyDown:(CGKeyCode)keyCode flags:(CGEventFlags)flags isRepeat:(BOOL)isRepeat userData:(int64_t)userData printable:(BOOL)printable {
    if (userData == GHSyntheticEventUserData) return NO;   // our own typing
    [self noteUserKeyDown];
    GHWalkSnapshot snapshot = GHUnpack(atomic_load(&_bits));
    GHKeyModifiers modifiers = GHKeyModifiersFromFlags(flags);

    if (keyCode == GHKeyCodeTab) {
        if (!isRepeat) atomic_store(&_haltRequested, false);
        else if (atomic_exchange(&_haltRequested, false) && _hold.walking) _hold.halted = YES;
        GHKeyDecision decision = GHDecideTab(snapshot, modifiers, isRepeat, &_hold);
        if (decision == GHKeyDecisionPass) return NO;
        if (decision != GHKeyDecisionSwallow) {
            [self deliver:^(id<GHEventTapDelegate> delegate) { [delegate eventTap:self didConsumeTab:decision isRepeat:isRepeat]; }];
        }
        return YES;
    }
    if (keyCode == GHKeyCodeEscape) {
        GHKeyDecision decision = GHDecideEscape(snapshot, modifiers, isRepeat, &_escapeOwned);
        if (decision == GHKeyDecisionPass) return NO;
        if (decision == GHKeyDecisionDismiss) [self deliver:^(id<GHEventTapDelegate> delegate) { [delegate eventTapDidConsumeEscape:self]; }];
        return YES;
    }
    // Typing overrides. The key always goes to the app; Command and Control chords are shortcuts, not typing.
    if (snapshot.active && snapshot.focusOnField && printable && !(modifiers & (GHKeyModifierCommand | GHKeyModifierControl))) {
        if (!atomic_exchange(&_typingPending, true)) {
            [self deliver:^(id<GHEventTapDelegate> delegate) {
                atomic_store(&self->_typingPending, false);
                [delegate eventTapDidSeeTypingInField:self];
            }];
        }
    }
    return NO;
}

- (void)handleKeyUp:(CGKeyCode)keyCode userData:(int64_t)userData {
    if (userData == GHSyntheticEventUserData) return;
    if (keyCode == GHKeyCodeTab) _hold.walking = _hold.halted = NO;
    else if (keyCode == GHKeyCodeEscape) _escapeOwned = NO;
}

- (void)handleFlagsChanged:(CGEventFlags)flags keyCode:(CGKeyCode)keyCode {
    // A modifier pressed mid-hold ends Ghost's hold: what follows is a chord, and chords are never ours.
    if (GHKeyModifiersFromFlags(flags) != GHKeyModifierNone) _hold.walking = _hold.halted = NO;

    // The Ghost key (docs/accept-key.md). Tab belongs to the app on most screens - a video page, a mail
    // client, an editor, a spreadsheet all bind it - so the key that always works is a lone tap of right
    // Option. The flagsChanged event is never consumed, so holding right Option as a real modifier, or
    // using it for an accented character, is untouched: only a down-and-up with nothing in between counts.
    if (keyCode != GHKeyCodeRightOption) {
        // Some other modifier moved during the hold: that makes it a chord, not a tap.
        _ghostKeyArmed = NO;
        return;
    }
    BOOL down = (flags & kCGEventFlagMaskAlternate) != 0;
    if (down) {
        _ghostKeyDownAt = CFAbsoluteTimeGetCurrent();
        _ghostKeyArmed = YES;
        return;
    }
    BOOL wasTap = _ghostKeyArmed && (CFAbsoluteTimeGetCurrent() - _ghostKeyDownAt) <= GHGhostKeyTapSeconds;
    _ghostKeyArmed = NO;
    if (!wasTap) return;
    // Only when a ghost is actually on screen. A stray tap anywhere else does nothing at all.
    GHWalkSnapshot snapshot = GHUnpack(atomic_load(&_bits));
    if (!snapshot.active || !snapshot.hasCurrent) return;
    [self deliver:^(id<GHEventTapDelegate> delegate) { [delegate eventTapDidTapGhostKey:self]; }];
}

- (void)handleScroll {
    uint32_t bits = atomic_load(&_bits);
    if (!(bits & GHTapBitActive) || !(bits & GHTapBitHasCurrent)) return;
    if (atomic_exchange(&_scrollPending, true)) return;
    [self deliver:^(id<GHEventTapDelegate> delegate) {
        atomic_store(&self->_scrollPending, false);
        [delegate eventTapDidSeeScroll:self];
    }];
}

static BOOL GHEventIsPrintable(CGEventRef event) {
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
    // Fast path: Ghost is off, untrusted or paused. Nothing is looked at, but a user key still aborts a sequence
    // in flight (the frontmost app may have changed under it).
    if (!(atomic_load(&_bits) & GHTapBitActive)) {
        if (type == kCGEventKeyDown && CGEventGetIntegerValueField(event, kCGEventSourceUserData) != GHSyntheticEventUserData) [self noteUserKeyDown];
        _hold.walking = _hold.halted = NO;
        _escapeOwned = NO;
        return event;
    }
    switch (type) {
        case kCGEventKeyDown: {
            int64_t userData = CGEventGetIntegerValueField(event, kCGEventSourceUserData);
            CGKeyCode keyCode = (CGKeyCode)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
            BOOL isRepeat = CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat) != 0;
            BOOL special = keyCode == GHKeyCodeTab || keyCode == GHKeyCodeEscape;
            BOOL printable = !special && (atomic_load(&_bits) & GHTapBitFocusOnField) && GHEventIsPrintable(event);
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
    CFMachPortRef port = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault, mask, GHEventTapCallback, (__bridge void *)self);
    if (!port) {
        if (!_refusalLogged) GHLog(@"tap: the system refused the event tap (Accessibility permission missing?); Tab stays native, retrying every %.0f s", kWatchdogInterval);
        _refusalLogged = YES;
        return NO;
    }
    _refusalLogged = NO;
    _port = port;
    _source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0);
    _hold = (GHHoldState){ NO, NO };
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
    _thread.name = @"dev.ghost.desktop.eventtap";
    _thread.qualityOfService = NSQualityOfServiceUserInteractive;
    [_thread start];
    dispatch_semaphore_wait(ready, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2 * NSEC_PER_SEC)));
    _runLoop = runLoop;
    CGEventTapEnable(port, true);
    GHLog(@"tap: installed (session level, head insert: keyDown, keyUp, flagsChanged, scrollWheel)");
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
    GHLog(@"tap: removed");
}

- (void)uninstall {
    _wanted = NO;
    [_watchdog invalidate];
    _watchdog = nil;
    GHWalkSnapshot off = { 0 };
    [self publishSnapshot:off];
    [self destroyTap];
}

- (void)startWatchdog {
    if (_watchdog) return;
    __weak GHEventTap *weakSelf = self;
    _watchdog = [NSTimer timerWithTimeInterval:kWatchdogInterval repeats:YES block:^(NSTimer *timer) {
        GHEventTap *tap = weakSelf;
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
    GHLog(@"tap: was disabled by the system, re-enabled (%lu so far)", (unsigned long)_reenableCount);
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
    if (GHRealKeyEventsForbidden()) return NO;
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
        CGEventSetIntegerValueField(event, kCGEventSourceUserData, GHSyntheticEventUserData);
        CGEventPost(kCGHIDEventTap, event);
        CFRelease(event);
    }
    return YES;
}

+ (BOOL)postKeyCode:(CGKeyCode)keyCode {
    CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStatePrivate);
    if (!source) return NO;
    CGEventSourceSetUserData(source, GHSyntheticEventUserData);
    BOOL ok = [self postEventWithSource:source keyCode:keyCode text:nil];
    CFRelease(source);
    return ok;
}

@end
