#import "GHKeyPoster.h"
#import "GHEventTap.h"
#import "GHLog.h"
#import <AppKit/AppKit.h>

const CGKeyCode GHKeyCodeTextCarrier = 0;
const CGKeyCode GHKeyCodeANSIG = 5;
const CGKeyCode GHKeyCodeReturn = 36;
const CGKeyCode GHKeyCodeBackspace = 51;
const CGKeyCode GHKeyCodeDownArrow = 125;
const CGKeyCode GHKeyCodeUpArrow = 126;

NSString *const GHKeyBurstReasonEmpty = @"empty";
NSString *const GHKeyBurstReasonMalformed = @"malformed";
NSString *const GHKeyBurstReasonGuardRefused = @"guard";
NSString *const GHKeyBurstReasonPostFailed = @"post-failed";

#pragma mark - stroke

@interface GHKeyStroke ()
- (instancetype)initWithKind:(GHKeyStrokeKind)kind keyCode:(CGKeyCode)keyCode flags:(CGEventFlags)flags text:(NSString *)text name:(NSString *)name NS_DESIGNATED_INITIALIZER;
@end

@implementation GHKeyStroke

- (instancetype)initWithKind:(GHKeyStrokeKind)kind keyCode:(CGKeyCode)keyCode flags:(CGEventFlags)flags text:(NSString *)text name:(NSString *)name {
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
    return [[self alloc] initWithKind:GHKeyStrokeKindText keyCode:GHKeyCodeTextCarrier flags:0 text:text ?: @"" name:@"text"];
}
+ (instancetype)escape { return [[self alloc] initWithKind:GHKeyStrokeKindEscape keyCode:GHKeyCodeEscape flags:0 text:nil name:@"escape"]; }
+ (instancetype)downArrow { return [[self alloc] initWithKind:GHKeyStrokeKindDownArrow keyCode:GHKeyCodeDownArrow flags:0 text:nil name:@"down"]; }
+ (instancetype)upArrow { return [[self alloc] initWithKind:GHKeyStrokeKindUpArrow keyCode:GHKeyCodeUpArrow flags:0 text:nil name:@"up"]; }
+ (instancetype)backspace { return [[self alloc] initWithKind:GHKeyStrokeKindBackspace keyCode:GHKeyCodeBackspace flags:0 text:nil name:@"backspace"]; }
+ (instancetype)goToFolder {
    return [[self alloc] initWithKind:GHKeyStrokeKindGoToFolder keyCode:GHKeyCodeANSIG flags:kCGEventFlagMaskCommand | kCGEventFlagMaskShift text:nil name:@"go-to-folder"];
}
+ (instancetype)returnKey { return [[self alloc] initWithKind:GHKeyStrokeKindReturn keyCode:GHKeyCodeReturn flags:0 text:nil name:@"return"]; }

- (NSString *)description {
    // Never the text: only its length.
    return self.kind == GHKeyStrokeKindText ? [NSString stringWithFormat:@"<GHKeyStroke text:%lu>", (unsigned long)self.text.length]
                                           : [NSString stringWithFormat:@"<GHKeyStroke %@>", self.name];
}

@end

#pragma mark - result

@interface GHKeyBurstResult ()
@property (nonatomic, readwrite) BOOL ok;
@property (nonatomic, readwrite) NSUInteger postedCount;
@property (nonatomic, readwrite) NSUInteger failedIndex;
@property (nonatomic, readwrite, copy, nullable) NSString *reason;
@end

@implementation GHKeyBurstResult

+ (instancetype)resultWithReason:(NSString *)reason posted:(NSUInteger)posted index:(NSUInteger)index {
    GHKeyBurstResult *result = [[self alloc] init];
    result.ok = reason == nil;
    result.reason = reason;
    result.postedCount = posted;
    result.failedIndex = reason ? index : NSNotFound;
    return result;
}

- (NSString *)description {
    return [NSString stringWithFormat:@"<GHKeyBurstResult ok=%d posted=%lu reason=%@>", self.ok, (unsigned long)self.postedCount, self.reason ?: @"-"];
}

@end

#pragma mark - live state

@implementation GHLiveDesktopState

- (pid_t)frontmostProcessIdentifier {
    // The ACTIVE app. A sandboxed app's open panel is drawn by a helper service that never becomes active, so the
    // browser stays frontmost while its panel is up; the user switching apps changes this at once.
    NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
    return front ? front.processIdentifier : 0;
}

- (id<GHAXNode>)focusedElement {
    AXUIElementRef systemWide = AXUIElementCreateSystemWide();
    if (!systemWide) return nil;
    AXUIElementSetMessagingTimeout(systemWide, GHAXMessagingTimeoutSeconds);
    CFTypeRef value = NULL;
    AXError error = AXUIElementCopyAttributeValue(systemWide, kAXFocusedUIElementAttribute, &value);
    CFRelease(systemWide);
    if (error != kAXErrorSuccess || !value) return nil;
    id<GHAXNode> node = nil;
    if (CFGetTypeID(value) == AXUIElementGetTypeID()) node = [GHAXElementNode nodeWithElement:(AXUIElementRef)value];
    CFRelease(value);
    return node;
}

- (NSArray<id<GHAXNode>> *)windowsOfProcess:(pid_t)pid {
    if (pid <= 0) return @[];
    AXUIElementRef application = AXUIElementCreateApplication(pid);
    if (!application) return @[];
    AXUIElementSetMessagingTimeout(application, GHAXMessagingTimeoutSeconds);
    CFTypeRef value = NULL;
    AXError error = AXUIElementCopyAttributeValue(application, kAXWindowsAttribute, &value);
    CFRelease(application);
    if (error != kAXErrorSuccess || !value) return @[];
    NSMutableArray<id<GHAXNode>> *windows = [NSMutableArray array];
    if (CFGetTypeID(value) == CFArrayGetTypeID()) {
        for (id entry in (__bridge NSArray *)value) {
            if (CFGetTypeID((__bridge CFTypeRef)entry) != AXUIElementGetTypeID()) continue;
            GHAXElementNode *node = [GHAXElementNode nodeWithElement:(__bridge AXUIElementRef)entry];
            if (node) [windows addObject:node];
        }
    }
    CFRelease(value);
    return windows;
}

@end

#pragma mark - fake state

@implementation GHFakeDesktopState

- (instancetype)init {
    if ((self = [super init])) _windowsByPID = [NSMutableDictionary dictionary];
    return self;
}

- (pid_t)frontmostProcessIdentifier {
    _frontmostReads++;
    return self.frontmostPID;
}

- (id<GHAXNode>)focusedElement {
    _focusReads++;
    return self.focusedNode;
}

- (NSArray<id<GHAXNode>> *)windowsOfProcess:(pid_t)pid {
    return [self.windowsByPID[@(pid)] copy] ?: @[];
}

- (void)addWindow:(id<GHAXNode>)window forPID:(pid_t)pid {
    NSMutableArray *windows = self.windowsByPID[@(pid)];
    if (!windows) self.windowsByPID[@(pid)] = windows = [NSMutableArray array];
    [windows addObject:window];
}

- (void)removeWindow:(id<GHAXNode>)window forPID:(pid_t)pid {
    [self.windowsByPID[@(pid)] removeObject:window];
}

@end

#pragma mark - live sink

@implementation GHTaggedKeyEventSink {
    CGEventSourceRef _source;
}

- (void)dealloc {
    if (_source) CFRelease(_source);
}

- (BOOL)sendKeyCode:(CGKeyCode)keyCode flags:(CGEventFlags)flags text:(NSString *)text {
    if (GHRealKeyEventsForbidden()) return NO;                                     // the test runner
    if (![[GHKeyPoster postableKeyCodes] containsObject:@(keyCode)]) return NO;   // belt and braces
    if (!_source) {
        _source = CGEventSourceCreate(kCGEventSourceStatePrivate);
        if (!_source) return NO;
        CGEventSourceSetUserData(_source, GHSyntheticEventUserData);
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
        CGEventSetIntegerValueField(event, kCGEventSourceUserData, GHSyntheticEventUserData);
        CGEventPost(kCGHIDEventTap, event);
        CFRelease(event);
    }
    return YES;
}

@end

#pragma mark - poster

static BOOL GHHasControlCharacter(NSString *text) {
    for (NSUInteger i = 0; i < text.length; i++) {
        unichar c = [text characterAtIndex:i];
        if (c < 0x20 || c == 0x7F || (c >= 0x80 && c < 0xA0) || c == 0x2028 || c == 0x2029) return YES;
    }
    return NO;
}

@implementation GHKeyPoster

- (instancetype)initWithState:(id<GHDesktopState>)state sink:(id<GHKeyEventSink>)sink {
    if ((self = [super init])) {
        _state = state;
        _sink = sink;
    }
    return self;
}

+ (GHKeyPoster *)livePoster {
    GHKeyPoster *poster = [[GHKeyPoster alloc] initWithState:[[GHLiveDesktopState alloc] init] sink:[[GHTaggedKeyEventSink alloc] init]];
    poster.interPostDelay = 0.002;
    return poster;
}

+ (NSArray<NSNumber *> *)postableKeyCodes {
    return @[ @(GHKeyCodeTextCarrier), @(GHKeyCodeANSIG), @(GHKeyCodeReturn), @(GHKeyCodeBackspace), @(GHKeyCodeEscape),
              @(GHKeyCodeDownArrow), @(GHKeyCodeUpArrow) ];
}

+ (NSArray<GHKeyStroke *> *)atomicStrokesForBurst:(NSArray<GHKeyStroke *> *)strokes reason:(NSString **)reason {
    if (strokes.count == 0) {
        if (reason) *reason = GHKeyBurstReasonEmpty;
        return nil;
    }
    NSMutableArray<GHKeyStroke *> *atoms = [NSMutableArray array];
    for (GHKeyStroke *stroke in strokes) {
        BOOL bad = ![[self postableKeyCodes] containsObject:@(stroke.keyCode)];
        if (stroke.kind == GHKeyStrokeKindReturn && strokes.count != 1) bad = YES;   // a Return is always alone
        if (stroke.kind == GHKeyStrokeKindText && (stroke.text.length == 0 || GHHasControlCharacter(stroke.text))) bad = YES;
        if (bad) {
            if (reason) *reason = GHKeyBurstReasonMalformed;
            return nil;
        }
        if (stroke.kind != GHKeyStrokeKindText) { [atoms addObject:stroke]; continue; }
        for (NSString *chunk in [GHEventTap chunksForText:stroke.text]) [atoms addObject:[GHKeyStroke text:chunk]];
    }
    return atoms;
}

static BOOL GHSameFocus(id<GHAXNode> before, id<GHAXNode> after) {
    if (!before || !after) return before == nil && after == nil;
    return [before isSameNode:after] && [after isSameNode:before];
}

- (GHKeyBurstResult *)postBurst:(NSArray<GHKeyStroke *> *)strokes guard:(GHKeyGuard)guard {
    return [self postBurst:strokes guard:guard lastCheck:nil];
}

- (GHKeyBurstResult *)postBurst:(NSArray<GHKeyStroke *> *)strokes guard:(GHKeyGuard)guard lastCheck:(GHKeyLastCheck)lastCheck {
    NSString *malformed = nil;
    NSArray<GHKeyStroke *> *atoms = [GHKeyPoster atomicStrokesForBurst:strokes reason:&malformed];
    if (!atoms || !guard) {
        GHLog(@"keys: burst refused before posting (%@)", malformed ?: @"no guard");
        return [GHKeyBurstResult resultWithReason:malformed ?: GHKeyBurstReasonMalformed posted:0 index:0];
    }
    // Map each atomic post back to the stroke it came from, for failedIndex.
    NSMutableArray<NSNumber *> *owner = [NSMutableArray arrayWithCapacity:atoms.count];
    for (NSUInteger i = 0; i < strokes.count; i++) {
        NSUInteger pieces = strokes[i].kind == GHKeyStrokeKindText ? [GHEventTap chunksForText:strokes[i].text].count : 1;
        for (NSUInteger p = 0; p < pieces; p++) [owner addObject:@(i)];
    }
    NSUInteger posted = 0;
    for (NSUInteger i = 0; i < atoms.count; i++) {
        GHKeyStroke *atom = atoms[i];
        // Read NOW, for this very post.
        pid_t frontmost = [self.state frontmostProcessIdentifier];
        id<GHAXNode> focused = [self.state focusedElement];
        if (!guard(atom, frontmost, focused)) {
            GHLog(@"keys: guard refused %@ (%lu of %lu posts done); burst aborted", atom.name, (unsigned long)posted, (unsigned long)atoms.count);
            return [GHKeyBurstResult resultWithReason:GHKeyBurstReasonGuardRefused posted:posted index:owner[i].unsignedIntegerValue];
        }
        // The guard may have taken a while: the world must still be the one it approved.
        if ([self.state frontmostProcessIdentifier] != frontmost || !GHSameFocus(focused, [self.state focusedElement])) {
            GHLog(@"keys: focus or the app changed while the guard ran; %@ not posted (%lu of %lu posts done)", atom.name,
                  (unsigned long)posted, (unsigned long)atoms.count);
            return [GHKeyBurstResult resultWithReason:GHKeyBurstReasonGuardRefused posted:posted index:owner[i].unsignedIntegerValue];
        }
        if (lastCheck && !lastCheck()) {
            GHLog(@"keys: last check refused %@ (%lu of %lu posts done); burst aborted", atom.name, (unsigned long)posted, (unsigned long)atoms.count);
            return [GHKeyBurstResult resultWithReason:GHKeyBurstReasonGuardRefused posted:posted index:owner[i].unsignedIntegerValue];
        }
        if (![self.sink sendKeyCode:atom.keyCode flags:atom.flags text:atom.text]) {
            GHLog(@"keys: the system did not take %@; burst aborted", atom.name);
            return [GHKeyBurstResult resultWithReason:GHKeyBurstReasonPostFailed posted:posted index:owner[i].unsignedIntegerValue];
        }
        posted++;
        if (self.interPostDelay > 0 && i + 1 < atoms.count) usleep((useconds_t)(self.interPostDelay * 1e6));
    }
    return [GHKeyBurstResult resultWithReason:nil posted:posted index:NSNotFound];
}

@end

#pragma mark - fake poster

@interface GHRecordingKeySink : NSObject <GHKeyEventSink>
@property (nonatomic, readonly) NSMutableArray<GHKeyStroke *> *posted;
@property (nonatomic, copy, nullable) void (^onPost)(GHKeyStroke *stroke);
@property (nonatomic) BOOL fails;
@end

@implementation GHRecordingKeySink

- (instancetype)init {
    if ((self = [super init])) _posted = [NSMutableArray array];
    return self;
}

- (BOOL)sendKeyCode:(CGKeyCode)keyCode flags:(CGEventFlags)flags text:(NSString *)text {
    if (self.fails) return NO;
    GHKeyStroke *stroke = nil;
    if (keyCode == GHKeyCodeTextCarrier && text.length) stroke = [GHKeyStroke text:text];
    else if (keyCode == GHKeyCodeEscape) stroke = [GHKeyStroke escape];
    else if (keyCode == GHKeyCodeDownArrow) stroke = [GHKeyStroke downArrow];
    else if (keyCode == GHKeyCodeUpArrow) stroke = [GHKeyStroke upArrow];
    else if (keyCode == GHKeyCodeBackspace) stroke = [GHKeyStroke backspace];
    else if (keyCode == GHKeyCodeReturn) stroke = [GHKeyStroke returnKey];
    else if (keyCode == GHKeyCodeANSIG && (flags & kCGEventFlagMaskCommand) && (flags & kCGEventFlagMaskShift)) stroke = [GHKeyStroke goToFolder];
    if (!stroke) return NO;   // something the live sink would not post either
    [self.posted addObject:stroke];
    if (self.onPost) self.onPost(stroke);
    return YES;
}

@end

@implementation GHFakeKeyPoster {
    GHRecordingKeySink *_recorder;
}

- (instancetype)initWithState:(GHFakeDesktopState *)state {
    GHRecordingKeySink *recorder = [[GHRecordingKeySink alloc] init];
    if ((self = [super initWithState:state sink:recorder])) {
        _recorder = recorder;
        _fakeState = state;
    }
    return self;
}

- (NSArray<GHKeyStroke *> *)posted { return [_recorder.posted copy]; }

- (NSArray<NSString *> *)postedNames {
    NSMutableArray<NSString *> *names = [NSMutableArray array];
    for (GHKeyStroke *stroke in _recorder.posted) [names addObject:stroke.name];
    return names;
}

- (NSString *)typedText {
    NSMutableString *text = [NSMutableString string];
    for (GHKeyStroke *stroke in _recorder.posted) if (stroke.kind == GHKeyStrokeKindText) [text appendString:stroke.text];
    return text;
}

- (NSUInteger)countOfKind:(GHKeyStrokeKind)kind {
    NSUInteger count = 0;
    for (GHKeyStroke *stroke in _recorder.posted) if (stroke.kind == kind) count++;
    return count;
}

- (void (^)(GHKeyStroke *))onPost { return _recorder.onPost; }
- (void)setOnPost:(void (^)(GHKeyStroke *))onPost { _recorder.onPost = onPost; }
- (BOOL)sinkFails { return _recorder.fails; }
- (void)setSinkFails:(BOOL)sinkFails { _recorder.fails = sinkFails; }

- (GHKeyBurstResult *)postBurst:(NSArray<GHKeyStroke *> *)strokes guard:(GHKeyGuard)guard lastCheck:(GHKeyLastCheck)lastCheck {
    _burstCount++;
    __weak GHFakeKeyPoster *weakSelf = self;
    GHKeyGuard counting = guard ? ^BOOL(GHKeyStroke *stroke, pid_t frontmostPID, id<GHAXNode> focused) {
        GHFakeKeyPoster *poster = weakSelf;
        if (poster) poster->_guardCalls++;
        return guard(stroke, frontmostPID, focused);
    } : nil;
    return [super postBurst:strokes guard:counting lastCheck:lastCheck];
}

@end
