#import "SBKeyPoster.h"
#import "SBEventTap.h"
#import "SBLog.h"
#import <AppKit/AppKit.h>

const CGKeyCode SBKeyCodeTextCarrier = 0;
const CGKeyCode SBKeyCodeANSIG = 5;
const CGKeyCode SBKeyCodeReturn = 36;
const CGKeyCode SBKeyCodeBackspace = 51;
const CGKeyCode SBKeyCodeDownArrow = 125;
const CGKeyCode SBKeyCodeUpArrow = 126;

NSString *const SBKeyBurstReasonEmpty = @"empty";
NSString *const SBKeyBurstReasonMalformed = @"malformed";
NSString *const SBKeyBurstReasonGuardRefused = @"guard";
NSString *const SBKeyBurstReasonPostFailed = @"post-failed";

#pragma mark - stroke

@interface SBKeyStroke ()
- (instancetype)initWithKind:(SBKeyStrokeKind)kind keyCode:(CGKeyCode)keyCode flags:(CGEventFlags)flags text:(NSString *)text name:(NSString *)name NS_DESIGNATED_INITIALIZER;
@end

@implementation SBKeyStroke

- (instancetype)initWithKind:(SBKeyStrokeKind)kind keyCode:(CGKeyCode)keyCode flags:(CGEventFlags)flags text:(NSString *)text name:(NSString *)name {
    if ((self = [super init])) {
        _kind = kind;
        _keyCode = keyCode;
        _flags = flags;
        _text = [text copy];
        _name = [name copy];
    }
    return self;
}

+ (instancetype)text:(NSString *)text {
    return [[self alloc] initWithKind:SBKeyStrokeKindText keyCode:SBKeyCodeTextCarrier flags:0 text:text ?: @"" name:@"text"];
}
+ (instancetype)escape { return [[self alloc] initWithKind:SBKeyStrokeKindEscape keyCode:SBKeyCodeEscape flags:0 text:nil name:@"escape"]; }
+ (instancetype)downArrow { return [[self alloc] initWithKind:SBKeyStrokeKindDownArrow keyCode:SBKeyCodeDownArrow flags:0 text:nil name:@"down"]; }
+ (instancetype)upArrow { return [[self alloc] initWithKind:SBKeyStrokeKindUpArrow keyCode:SBKeyCodeUpArrow flags:0 text:nil name:@"up"]; }
+ (instancetype)backspace { return [[self alloc] initWithKind:SBKeyStrokeKindBackspace keyCode:SBKeyCodeBackspace flags:0 text:nil name:@"backspace"]; }
+ (instancetype)goToFolder {
    return [[self alloc] initWithKind:SBKeyStrokeKindGoToFolder keyCode:SBKeyCodeANSIG flags:kCGEventFlagMaskCommand | kCGEventFlagMaskShift text:nil name:@"go-to-folder"];
}
+ (instancetype)returnKey { return [[self alloc] initWithKind:SBKeyStrokeKindReturn keyCode:SBKeyCodeReturn flags:0 text:nil name:@"return"]; }

- (NSString *)description {
    // Never the text: only its length.
    return self.kind == SBKeyStrokeKindText ? [NSString stringWithFormat:@"<SBKeyStroke text:%lu>", (unsigned long)self.text.length]
                                           : [NSString stringWithFormat:@"<SBKeyStroke %@>", self.name];
}

@end

#pragma mark - result

@interface SBKeyBurstResult ()
@property (nonatomic, readwrite) BOOL ok;
@property (nonatomic, readwrite) NSUInteger postedCount;
@property (nonatomic, readwrite) NSUInteger failedIndex;
@property (nonatomic, readwrite, copy, nullable) NSString *reason;
@end

@implementation SBKeyBurstResult

+ (instancetype)resultWithReason:(NSString *)reason posted:(NSUInteger)posted index:(NSUInteger)index {
    SBKeyBurstResult *result = [[self alloc] init];
    result.ok = reason == nil;
    result.reason = reason;
    result.postedCount = posted;
    result.failedIndex = reason ? index : NSNotFound;
    return result;
}

- (NSString *)description {
    return [NSString stringWithFormat:@"<SBKeyBurstResult ok=%d posted=%lu reason=%@>", self.ok, (unsigned long)self.postedCount, self.reason ?: @"-"];
}

@end

#pragma mark - live state

@implementation SBLiveDesktopState

- (pid_t)frontmostProcessIdentifier {
    // The ACTIVE app. A sandboxed app's open panel is drawn by a helper service that never becomes active, so the
    // browser stays frontmost while its panel is up; the user switching apps changes this at once.
    NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
    return front ? front.processIdentifier : 0;
}

- (id<SBAXNode>)focusedElement {
    AXUIElementRef systemWide = AXUIElementCreateSystemWide();
    if (!systemWide) return nil;
    AXUIElementSetMessagingTimeout(systemWide, SBAXMessagingTimeoutSeconds);
    CFTypeRef value = NULL;
    AXError error = AXUIElementCopyAttributeValue(systemWide, kAXFocusedUIElementAttribute, &value);
    CFRelease(systemWide);
    if (error != kAXErrorSuccess || !value) return nil;
    id<SBAXNode> node = nil;
    if (CFGetTypeID(value) == AXUIElementGetTypeID()) node = [SBAXElementNode nodeWithElement:(AXUIElementRef)value];
    CFRelease(value);
    return node;
}

- (NSArray<id<SBAXNode>> *)windowsOfProcess:(pid_t)pid {
    if (pid <= 0) return @[];
    AXUIElementRef application = AXUIElementCreateApplication(pid);
    if (!application) return @[];
    AXUIElementSetMessagingTimeout(application, SBAXMessagingTimeoutSeconds);
    CFTypeRef value = NULL;
    AXError error = AXUIElementCopyAttributeValue(application, kAXWindowsAttribute, &value);
    CFRelease(application);
    if (error != kAXErrorSuccess || !value) return @[];
    NSMutableArray<id<SBAXNode>> *windows = [NSMutableArray array];
    if (CFGetTypeID(value) == CFArrayGetTypeID()) {
        for (id entry in (__bridge NSArray *)value) {
            if (CFGetTypeID((__bridge CFTypeRef)entry) != AXUIElementGetTypeID()) continue;
            SBAXElementNode *node = [SBAXElementNode nodeWithElement:(__bridge AXUIElementRef)entry];
            if (node) [windows addObject:node];
        }
    }
    CFRelease(value);
    return windows;
}

@end

#pragma mark - fake state

@implementation SBFakeDesktopState

- (instancetype)init {
    if ((self = [super init])) _windowsByPID = [NSMutableDictionary dictionary];
    return self;
}

- (pid_t)frontmostProcessIdentifier {
    _frontmostReads++;
    return self.frontmostPID;
}

- (id<SBAXNode>)focusedElement {
    _focusReads++;
    return self.focusedNode;
}

- (NSArray<id<SBAXNode>> *)windowsOfProcess:(pid_t)pid {
    return [self.windowsByPID[@(pid)] copy] ?: @[];
}

- (void)addWindow:(id<SBAXNode>)window forPID:(pid_t)pid {
    NSMutableArray *windows = self.windowsByPID[@(pid)];
    if (!windows) self.windowsByPID[@(pid)] = windows = [NSMutableArray array];
    [windows addObject:window];
}

- (void)removeWindow:(id<SBAXNode>)window forPID:(pid_t)pid {
    [self.windowsByPID[@(pid)] removeObject:window];
}

@end

#pragma mark - live sink

@implementation SBTaggedKeyEventSink {
    CGEventSourceRef _source;
}

- (void)dealloc {
    if (_source) CFRelease(_source);
}

- (BOOL)sendKeyCode:(CGKeyCode)keyCode flags:(CGEventFlags)flags text:(NSString *)text {
    if (SBRealKeyEventsForbidden()) return NO;                                     // the test runner
    if (![[SBKeyPoster postableKeyCodes] containsObject:@(keyCode)]) return NO;   // belt and braces
    if (!_source) {
        _source = CGEventSourceCreate(kCGEventSourceStatePrivate);
        if (!_source) return NO;
        CGEventSourceSetUserData(_source, SBSyntheticEventUserData);
    }
    for (int down = 1; down >= 0; down--) {
        CGEventRef event = CGEventCreateKeyboardEvent(_source, keyCode, down == 1);
        if (!event) return NO;
        CGEventSetFlags(event, flags);
        if (text.length) {
            UniChar buffer[64];
            NSUInteger length = MIN(text.length, (NSUInteger)64);
            [text getCharacters:buffer range:NSMakeRange(0, length)];
            CGEventKeyboardSetUnicodeString(event, length, buffer);
        }
        CGEventSetIntegerValueField(event, kCGEventSourceUserData, SBSyntheticEventUserData);
        CGEventPost(kCGHIDEventTap, event);
        CFRelease(event);
    }
    return YES;
}

@end

#pragma mark - poster

static BOOL SBHasControlCharacter(NSString *text) {
    for (NSUInteger i = 0; i < text.length; i++) {
        unichar c = [text characterAtIndex:i];
        if (c < 0x20 || c == 0x7F || (c >= 0x80 && c < 0xA0) || c == 0x2028 || c == 0x2029) return YES;
    }
    return NO;
}

@implementation SBKeyPoster

- (instancetype)initWithState:(id<SBDesktopState>)state sink:(id<SBKeyEventSink>)sink {
    if ((self = [super init])) {
        _state = state;
        _sink = sink;
    }
    return self;
}

+ (SBKeyPoster *)livePoster {
    SBKeyPoster *poster = [[SBKeyPoster alloc] initWithState:[[SBLiveDesktopState alloc] init] sink:[[SBTaggedKeyEventSink alloc] init]];
    poster.interPostDelay = 0.002;
    return poster;
}

+ (NSArray<NSNumber *> *)postableKeyCodes {
    return @[ @(SBKeyCodeTextCarrier), @(SBKeyCodeANSIG), @(SBKeyCodeReturn), @(SBKeyCodeBackspace), @(SBKeyCodeEscape),
              @(SBKeyCodeDownArrow), @(SBKeyCodeUpArrow) ];
}

+ (NSArray<SBKeyStroke *> *)atomicStrokesForBurst:(NSArray<SBKeyStroke *> *)strokes reason:(NSString **)reason {
    if (strokes.count == 0) {
        if (reason) *reason = SBKeyBurstReasonEmpty;
        return nil;
    }
    NSMutableArray<SBKeyStroke *> *atoms = [NSMutableArray array];
    for (SBKeyStroke *stroke in strokes) {
        BOOL bad = ![[self postableKeyCodes] containsObject:@(stroke.keyCode)];
        if (stroke.kind == SBKeyStrokeKindReturn && strokes.count != 1) bad = YES;   // a Return is always alone
        if (stroke.kind == SBKeyStrokeKindText && (stroke.text.length == 0 || SBHasControlCharacter(stroke.text))) bad = YES;
        if (bad) {
            if (reason) *reason = SBKeyBurstReasonMalformed;
            return nil;
        }
        if (stroke.kind != SBKeyStrokeKindText) { [atoms addObject:stroke]; continue; }
        for (NSString *chunk in [SBEventTap chunksForText:stroke.text]) [atoms addObject:[SBKeyStroke text:chunk]];
    }
    return atoms;
}

static BOOL SBSameFocus(id<SBAXNode> before, id<SBAXNode> after) {
    if (!before || !after) return before == nil && after == nil;
    return [before isSameNode:after] && [after isSameNode:before];
}

- (SBKeyBurstResult *)postBurst:(NSArray<SBKeyStroke *> *)strokes guard:(SBKeyGuard)guard {
    return [self postBurst:strokes guard:guard lastCheck:nil];
}

- (SBKeyBurstResult *)postBurst:(NSArray<SBKeyStroke *> *)strokes guard:(SBKeyGuard)guard lastCheck:(SBKeyLastCheck)lastCheck {
    NSString *malformed = nil;
    NSArray<SBKeyStroke *> *atoms = [SBKeyPoster atomicStrokesForBurst:strokes reason:&malformed];
    if (!atoms || !guard) {
        SBLog(@"keys: burst refused before posting (%@)", malformed ?: @"no guard");
        return [SBKeyBurstResult resultWithReason:malformed ?: SBKeyBurstReasonMalformed posted:0 index:0];
    }
    // Map each atomic post back to the stroke it came from, for failedIndex.
    NSMutableArray<NSNumber *> *owner = [NSMutableArray arrayWithCapacity:atoms.count];
    for (NSUInteger i = 0; i < strokes.count; i++) {
        NSUInteger pieces = strokes[i].kind == SBKeyStrokeKindText ? [SBEventTap chunksForText:strokes[i].text].count : 1;
        for (NSUInteger p = 0; p < pieces; p++) [owner addObject:@(i)];
    }
    NSUInteger posted = 0;
    for (NSUInteger i = 0; i < atoms.count; i++) {
        SBKeyStroke *atom = atoms[i];
        // Read NOW, for this very post.
        pid_t frontmost = [self.state frontmostProcessIdentifier];
        id<SBAXNode> focused = [self.state focusedElement];
        if (!guard(atom, frontmost, focused)) {
            SBLog(@"keys: guard refused %@ (%lu of %lu posts done); burst aborted", atom.name, (unsigned long)posted, (unsigned long)atoms.count);
            return [SBKeyBurstResult resultWithReason:SBKeyBurstReasonGuardRefused posted:posted index:owner[i].unsignedIntegerValue];
        }
        // The guard may have taken a while: the world must still be the one it approved.
        if ([self.state frontmostProcessIdentifier] != frontmost || !SBSameFocus(focused, [self.state focusedElement])) {
            SBLog(@"keys: focus or the app changed while the guard ran; %@ not posted (%lu of %lu posts done)", atom.name,
                  (unsigned long)posted, (unsigned long)atoms.count);
            return [SBKeyBurstResult resultWithReason:SBKeyBurstReasonGuardRefused posted:posted index:owner[i].unsignedIntegerValue];
        }
        if (lastCheck && !lastCheck()) {
            SBLog(@"keys: last check refused %@ (%lu of %lu posts done); burst aborted", atom.name, (unsigned long)posted, (unsigned long)atoms.count);
            return [SBKeyBurstResult resultWithReason:SBKeyBurstReasonGuardRefused posted:posted index:owner[i].unsignedIntegerValue];
        }
        if (![self.sink sendKeyCode:atom.keyCode flags:atom.flags text:atom.text]) {
            SBLog(@"keys: the system did not take %@; burst aborted", atom.name);
            return [SBKeyBurstResult resultWithReason:SBKeyBurstReasonPostFailed posted:posted index:owner[i].unsignedIntegerValue];
        }
        posted++;
        if (self.interPostDelay > 0 && i + 1 < atoms.count) usleep((useconds_t)(self.interPostDelay * 1e6));
    }
    return [SBKeyBurstResult resultWithReason:nil posted:posted index:NSNotFound];
}

@end

#pragma mark - fake poster

@interface SBRecordingKeySink : NSObject <SBKeyEventSink>
@property (nonatomic, readonly) NSMutableArray<SBKeyStroke *> *posted;
@property (nonatomic, copy, nullable) void (^onPost)(SBKeyStroke *stroke);
@property (nonatomic) BOOL fails;
@end

@implementation SBRecordingKeySink

- (instancetype)init {
    if ((self = [super init])) _posted = [NSMutableArray array];
    return self;
}

- (BOOL)sendKeyCode:(CGKeyCode)keyCode flags:(CGEventFlags)flags text:(NSString *)text {
    if (self.fails) return NO;
    SBKeyStroke *stroke = nil;
    if (keyCode == SBKeyCodeTextCarrier && text.length) stroke = [SBKeyStroke text:text];
    else if (keyCode == SBKeyCodeEscape) stroke = [SBKeyStroke escape];
    else if (keyCode == SBKeyCodeDownArrow) stroke = [SBKeyStroke downArrow];
    else if (keyCode == SBKeyCodeUpArrow) stroke = [SBKeyStroke upArrow];
    else if (keyCode == SBKeyCodeBackspace) stroke = [SBKeyStroke backspace];
    else if (keyCode == SBKeyCodeReturn) stroke = [SBKeyStroke returnKey];
    else if (keyCode == SBKeyCodeANSIG && (flags & kCGEventFlagMaskCommand) && (flags & kCGEventFlagMaskShift)) stroke = [SBKeyStroke goToFolder];
    if (!stroke) return NO;   // something the live sink would not post either
    [self.posted addObject:stroke];
    if (self.onPost) self.onPost(stroke);
    return YES;
}

@end

@implementation SBFakeKeyPoster {
    SBRecordingKeySink *_recorder;
}

- (instancetype)initWithState:(SBFakeDesktopState *)state {
    SBRecordingKeySink *recorder = [[SBRecordingKeySink alloc] init];
    if ((self = [super initWithState:state sink:recorder])) {
        _recorder = recorder;
        _fakeState = state;
    }
    return self;
}

- (NSArray<SBKeyStroke *> *)posted { return [_recorder.posted copy]; }

- (NSArray<NSString *> *)postedNames {
    NSMutableArray<NSString *> *names = [NSMutableArray array];
    for (SBKeyStroke *stroke in _recorder.posted) [names addObject:stroke.name];
    return names;
}

- (NSString *)typedText {
    NSMutableString *text = [NSMutableString string];
    for (SBKeyStroke *stroke in _recorder.posted) if (stroke.kind == SBKeyStrokeKindText) [text appendString:stroke.text];
    return text;
}

- (NSUInteger)countOfKind:(SBKeyStrokeKind)kind {
    NSUInteger count = 0;
    for (SBKeyStroke *stroke in _recorder.posted) if (stroke.kind == kind) count++;
    return count;
}

- (void (^)(SBKeyStroke *))onPost { return _recorder.onPost; }
- (void)setOnPost:(void (^)(SBKeyStroke *))onPost { _recorder.onPost = onPost; }
- (BOOL)sinkFails { return _recorder.fails; }
- (void)setSinkFails:(BOOL)sinkFails { _recorder.fails = sinkFails; }

- (SBKeyBurstResult *)postBurst:(NSArray<SBKeyStroke *> *)strokes guard:(SBKeyGuard)guard lastCheck:(SBKeyLastCheck)lastCheck {
    _burstCount++;
    __weak SBFakeKeyPoster *weakSelf = self;
    SBKeyGuard counting = guard ? ^BOOL(SBKeyStroke *stroke, pid_t frontmostPID, id<SBAXNode> focused) {
        SBFakeKeyPoster *poster = weakSelf;
        if (poster) poster->_guardCalls++;
        return guard(stroke, frontmostPID, focused);
    } : nil;
    return [super postBurst:strokes guard:counting lastCheck:lastCheck];
}

@end
