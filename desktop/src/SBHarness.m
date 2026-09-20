#import "SBHarness.h"
#import <AppKit/AppKit.h>
#import <dlfcn.h>
#import <sys/file.h>
#import <sys/stat.h>
#import "SBAccessibility.h"
#import "SBCapture.h"
#import "SBController.h"
#import "SBCore.h"
#import "SBField.h"
#import "SBLog.h"
#import "SBAffordance.h"
#import "SBNextAction.h"
#import "SBProbe.h"
#import "SBProfileStore.h"

NSString *const SBHarnessModeTrust = @"trust";
NSString *const SBHarnessModeDump = @"dump";
NSString *const SBHarnessModeDumpTree = @"dump-tree";
NSString *const SBHarnessModeNext = @"next";
NSString *const SBHarnessModeAutotab = @"autotab";
NSString *const SBHarnessModeAccept = @"accept";
NSString *const SBHarnessModeProbeComboBox = @"probe-combobox";
NSString *const SBHarnessRequestNotification = @"dev.shabang.desktop.harness.request";

const NSInteger SBHarnessMaxAutotabCount = 200;
const NSInteger SBHarnessDefaultIntervalMs = 450;
const NSInteger SBHarnessDefaultDepth = 60;
const NSUInteger SBHarnessMaxTreeNodes = 8000;
const NSUInteger SBHarnessMaxTextLength = 120;
const NSTimeInterval SBHarnessRequestMaxAge = 120.0;

static const NSTimeInterval kTreeTimeBudget = 25.0;
static const NSTimeInterval kCaptureTimeBudget = 2.0;
static const NSUInteger kCaptureMaxNodes = 6000;
static const NSTimeInterval kGuardTimeBudget = 2.0;   // the --expect-field re-capture, once per press
static const NSUInteger kMaxClasses = 12;
static const NSUInteger kStallLimit = 3;

#pragma mark - request

static NSDictionary<NSString *, NSString *> *SBHarnessModeFlags(void) {
    return @{ @"--trust": SBHarnessModeTrust, @"--dump": SBHarnessModeDump, @"--dump-tree": SBHarnessModeDumpTree,
              @"--autotab": SBHarnessModeAutotab, @"--probe-combobox": SBHarnessModeProbeComboBox,
              @"--next": SBHarnessModeNext, @"--accept": SBHarnessModeAccept };
}

/// Flags that take a value, and the dictionary key the value travels under.
static NSDictionary<NSString *, NSString *> *SBHarnessValueFlags(void) {
    return @{ @"--autotab": @"count", @"--interval": @"intervalMs", @"--depth": @"depth", @"--delay": @"delay",
              @"--frontmost": @"frontmost", @"--expect-field": @"expectField", @"--out": @"out",
              @"--probe-combobox": @"probeLabel" };
}

static BOOL SBHarnessFail(NSString **error, NSString *message) {
    if (error) *error = message;
    return NO;
}

static NSNumber *SBHarnessParseNumber(NSString *text, BOOL whole) {
    NSScanner *scanner = [NSScanner scannerWithString:text];
    scanner.charactersToBeSkipped = nil;
    double value = 0;
    if (![scanner scanDouble:&value] || !scanner.isAtEnd || !isfinite(value)) return nil;
    if (whole && value != floor(value)) return nil;
    return @(value);
}

static BOOL SBHarnessIsBoolean(id value) {
    return value && CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID();
}

/// A number in [low, high] from `dictionary[key]`, `fallback` when the key is absent. NO for anything else.
static BOOL SBHarnessReadNumber(NSDictionary *dictionary, NSString *key, BOOL whole, double low, double high, double fallback, double *out, NSString **error) {
    id raw = dictionary[key];
    if (!raw) { *out = fallback; return YES; }
    if (![raw isKindOfClass:[NSNumber class]] || SBHarnessIsBoolean(raw)) return SBHarnessFail(error, [NSString stringWithFormat:@"%@ must be a number", key]);
    double value = [raw doubleValue];
    if (!isfinite(value) || (whole && value != floor(value)) || value < low || value > high) {
        return SBHarnessFail(error, [NSString stringWithFormat:@"%@ must be between %g and %g", key, low, high]);
    }
    *out = value;
    return YES;
}

static BOOL SBHarnessIdentifierIsSafe(NSString *identifier) {
    if (identifier.length == 0 || identifier.length > 64) return NO;
    NSCharacterSet *unsafe = [NSCharacterSet characterSetWithCharactersInString:@"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-"].invertedSet;
    return [identifier rangeOfCharacterFromSet:unsafe].location == NSNotFound;
}

@implementation SBHarnessRequest

+ (NSString *)outPathInArguments:(NSArray<NSString *> *)arguments {
    NSUInteger index = [arguments indexOfObject:@"--out"];
    if (index == NSNotFound || index + 1 >= arguments.count) return nil;
    NSString *path = arguments[index + 1];
    return SBHarnessProblemWithOutPath(path) ? nil : path;
}

+ (instancetype)requestWithArguments:(NSArray<NSString *> *)arguments error:(NSString **)error {
    if (error) *error = nil;
    NSDictionary *modes = SBHarnessModeFlags(), *values = SBHarnessValueFlags();
    NSMutableDictionary<NSString *, id> *dictionary = [NSMutableDictionary dictionary];
    BOOL sawHarnessFlag = NO;
    for (NSUInteger i = 0; i < arguments.count; i++) {
        NSString *flag = arguments[i];
        if (!modes[flag] && !values[flag]) continue;
        sawHarnessFlag = YES;
        if (modes[flag]) {
            if (dictionary[@"mode"]) { SBHarnessFail(error, @"one mode at a time: --trust, --dump, --dump-tree or --autotab N"); return nil; }
            dictionary[@"mode"] = modes[flag];
        }
        NSString *key = values[flag];
        if (!key) continue;
        NSString *value = i + 1 < arguments.count ? arguments[i + 1] : nil;
        if (!value || [value hasPrefix:@"--"]) { SBHarnessFail(error, [NSString stringWithFormat:@"%@ needs a value", flag]); return nil; }
        i++;
        if ([key isEqualToString:@"frontmost"] || [key isEqualToString:@"expectField"] || [key isEqualToString:@"out"]
            || [key isEqualToString:@"probeLabel"]) { dictionary[key] = value; continue; }
        NSNumber *number = SBHarnessParseNumber(value, ![key isEqualToString:@"delay"]);
        if (!number) { SBHarnessFail(error, [NSString stringWithFormat:@"%@ needs a number", flag]); return nil; }
        dictionary[key] = number;
    }
    if (!sawHarnessFlag) return nil;
    if (!dictionary[@"mode"]) { SBHarnessFail(error, @"no mode: --trust, --dump, --dump-tree or --autotab N"); return nil; }
    dictionary[@"id"] = NSUUID.UUID.UUIDString.lowercaseString;
    dictionary[@"createdAt"] = @(NSDate.date.timeIntervalSince1970);
    return [self requestWithDictionary:dictionary error:error];
}

+ (instancetype)requestWithDictionary:(NSDictionary<NSString *, id> *)dictionary error:(NSString **)error {
    if (error) *error = nil;
    if (![dictionary isKindOfClass:[NSDictionary class]]) { SBHarnessFail(error, @"not a request"); return nil; }
    NSString *mode = dictionary[@"mode"], *identifier = dictionary[@"id"], *frontmost = dictionary[@"frontmost"], *outPath = dictionary[@"out"];
    NSString *expectField = dictionary[@"expectField"], *probeLabel = dictionary[@"probeLabel"];
    if (![mode isKindOfClass:[NSString class]] || ![SBHarnessModeFlags().allValues containsObject:mode]) { SBHarnessFail(error, @"unknown mode"); return nil; }
    if (![identifier isKindOfClass:[NSString class]] || !SBHarnessIdentifierIsSafe(identifier)) { SBHarnessFail(error, @"bad id"); return nil; }
    if (frontmost && (![frontmost isKindOfClass:[NSString class]] || frontmost.length == 0 || frontmost.length > 200
                      || [frontmost rangeOfCharacterFromSet:NSCharacterSet.newlineCharacterSet].location != NSNotFound)) {
        SBHarnessFail(error, @"--frontmost needs an app name or a bundle id");
        return nil;
    }
    if (expectField && (![expectField isKindOfClass:[NSString class]] || expectField.length == 0 || expectField.length > 200
                        || [expectField rangeOfCharacterFromSet:NSCharacterSet.newlineCharacterSet].location != NSNotFound)) {
        SBHarnessFail(error, @"--expect-field needs a one-line piece of a field label");
        return nil;
    }
    if (outPath) {
        NSString *problem = [outPath isKindOfClass:[NSString class]] ? SBHarnessProblemWithOutPath(outPath) : @"--out needs an absolute path";
        if (problem) { SBHarnessFail(error, problem); return nil; }
    }
    if (probeLabel && (![probeLabel isKindOfClass:[NSString class]] || probeLabel.length == 0 || probeLabel.length > 200
                       || [probeLabel rangeOfCharacterFromSet:NSCharacterSet.newlineCharacterSet].location != NSNotFound)) {
        SBHarnessFail(error, @"--probe-combobox needs a one-line piece of a combo box label");
        return nil;
    }
    if ([mode isEqualToString:SBHarnessModeProbeComboBox] && !probeLabel.length) {
        SBHarnessFail(error, @"--probe-combobox needs a label");
        return nil;
    }
    BOOL autotab = [mode isEqualToString:SBHarnessModeAutotab];
    if (autotab && !dictionary[@"count"]) { SBHarnessFail(error, @"--autotab needs a count"); return nil; }
    double count = 0, interval = 0, depth = 0, delay = 0, createdAt = 0;
    if (!SBHarnessReadNumber(dictionary, @"count", YES, autotab ? 1 : 0, SBHarnessMaxAutotabCount, 0, &count, error)) return nil;
    if (!SBHarnessReadNumber(dictionary, @"intervalMs", YES, 50, 5000, SBHarnessDefaultIntervalMs, &interval, error)) return nil;
    if (!SBHarnessReadNumber(dictionary, @"depth", YES, 1, 200, SBHarnessDefaultDepth, &depth, error)) return nil;
    if (!SBHarnessReadNumber(dictionary, @"delay", NO, 0, 60, 0, &delay, error)) return nil;
    if (!SBHarnessReadNumber(dictionary, @"createdAt", NO, 0, 1e11, NSDate.date.timeIntervalSince1970, &createdAt, error)) return nil;

    SBHarnessRequest *request = [[SBHarnessRequest alloc] init];
    request.identifier = identifier;
    request.mode = mode;
    request.count = autotab ? (NSInteger)count : 0;
    request.intervalMs = (NSInteger)interval;
    request.depth = (NSInteger)depth;
    request.delay = delay;
    request.frontmost = frontmost;
    request.expectField = expectField;
    request.probeLabel = probeLabel;
    request.outPath = outPath;
    request.createdAt = createdAt;
    return request;
}

+ (instancetype)requestWithData:(NSData *)data error:(NSString **)error {
    id object = data.length ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
    if (!object) { SBHarnessFail(error, @"not JSON"); return nil; }
    return [self requestWithDictionary:object error:error];
}

- (NSDictionary<NSString *, id> *)dictionary {
    NSMutableDictionary<NSString *, id> *out = [@{
        @"version": @1, @"id": self.identifier ?: @"", @"mode": self.mode ?: @"", @"intervalMs": @(self.intervalMs),
        @"depth": @(self.depth), @"delay": @(self.delay), @"createdAt": @(self.createdAt),
    } mutableCopy];
    if ([self.mode isEqualToString:SBHarnessModeAutotab]) out[@"count"] = @(self.count);
    if (self.frontmost) out[@"frontmost"] = self.frontmost;
    if (self.expectField) out[@"expectField"] = self.expectField;
    if (self.probeLabel) out[@"probeLabel"] = self.probeLabel;
    if (self.outPath) out[@"out"] = self.outPath;
    return out;
}

- (NSData *)data {
    return [NSJSONSerialization dataWithJSONObject:[self dictionary] options:NSJSONWritingSortedKeys error:NULL] ?: [NSData data];
}

- (NSTimeInterval)autotabBudget {
    // --expect-field re-captures the window before every press: that capture has its own budget (kGuardTimeBudget)
    // and the run must be allowed to pay it `count` times over, or the guard would time the run out by itself.
    NSTimeInterval perPress = (NSTimeInterval)self.intervalMs / 1000.0 + 1.0 + (self.expectField.length ? 2.5 : 0.0);
    return (NSTimeInterval)self.count * perPress + 8.0;
}

- (NSTimeInterval)deadline {
    NSTimeInterval total = self.delay + 15.0 + (self.frontmost ? 2.0 : 0.0);
    if ([self.mode isEqualToString:SBHarnessModeAutotab]) total += self.autotabBudget;
    if ([self.mode isEqualToString:SBHarnessModeDumpTree]) total += kTreeTimeBudget + 5.0;
    if ([self.mode isEqualToString:SBHarnessModeProbeComboBox]) total += 20.0;
    if ([self.mode isEqualToString:SBHarnessModeNext]) total += kCaptureTimeBudget + 10.0;
    if ([self.mode isEqualToString:SBHarnessModeAccept]) total += kCaptureTimeBudget + 12.0;
    return total;
}

@end

#pragma mark - response

/// Lower case, no diacritics, whitespace (including the &nbsp; Greenhouse puts in labels) collapsed to one space,
/// trimmed. Both sides go through this, so "first name" matches "First Name *".
static NSString *SBHarnessFoldedLabel(NSString *text) {
    if (![text isKindOfClass:[NSString class]] || text.length == 0) return @"";
    NSString *folded = [text stringByFoldingWithOptions:NSCaseInsensitiveSearch | NSDiacriticInsensitiveSearch | NSWidthInsensitiveSearch
                                                 locale:[NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"]];
    NSArray<NSString *> *pieces = [folded componentsSeparatedByCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    NSMutableArray<NSString *> *words = [NSMutableArray array];
    for (NSString *piece in pieces) if (piece.length) [words addObject:piece];
    return [words componentsJoinedByString:@" "];
}

BOOL SBHarnessLabelsMeetExpectation(NSArray<NSString *> *labels, NSString *expectation) {
    NSString *wanted = SBHarnessFoldedLabel(expectation);
    if (wanted.length == 0) return YES;                     // no guard asked for
    if (![labels isKindOfClass:[NSArray class]]) return NO;
    for (NSString *label in labels) {
        NSString *folded = SBHarnessFoldedLabel([label isKindOfClass:[NSString class]] ? label : nil);
        if (folded.length && [folded rangeOfString:wanted].location != NSNotFound) return YES;
    }
    return NO;
}

NSDictionary<NSString *, id> *SBHarnessNotTrustedResponse(void) {
    return @{ @"error": @"not trusted", @"trusted": @NO };
}

NSDictionary<NSString *, id> *SBHarnessErrorResponse(NSString *code, NSString *detail) {
    return detail.length ? @{ @"error": code, @"detail": detail } : @{ @"error": code };
}

NSData *SBHarnessEncodeResponse(NSDictionary<NSString *, id> *response) {
    NSJSONWritingOptions options = NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys | NSJSONWritingWithoutEscapingSlashes;
    id object = [NSJSONSerialization isValidJSONObject:response] ? response : SBHarnessErrorResponse(@"encoding-failed", nil);
    NSMutableData *data = [[NSJSONSerialization dataWithJSONObject:object options:options error:NULL] mutableCopy] ?: [NSMutableData data];
    [data appendBytes:"\n" length:1];
    return data;
}

NSString *SBHarnessProblemWithOutPath(NSString *path) {
    if (path.length == 0 || !path.isAbsolutePath || path.length > 1024 || [path containsString:@"\0"]) return @"--out needs an absolute path";
    if (![path.pathExtension isEqualToString:@"json"]) return @"--out must name a .json file";
    for (NSString *component in path.pathComponents) {
        if ([component isEqualToString:@".."] || [component isEqualToString:@"."]) return @"--out must not contain . or ..";
    }
    struct stat info;
    NSString *parent = path.stringByDeletingLastPathComponent;
    // The directory must already exist and belong to this user: the harness never creates directories.
    if (lstat(parent.fileSystemRepresentation, &info) != 0 || !S_ISDIR(info.st_mode) || info.st_uid != getuid()) {
        return @"--out must be inside an existing directory of yours";
    }
    if (lstat(path.fileSystemRepresentation, &info) == 0 && !S_ISREG(info.st_mode)) return @"--out names something that is not a plain file";
    return nil;
}

BOOL SBHarnessRemoveOldAnswer(NSString *path) {
    if (SBHarnessProblemWithOutPath(path)) return NO;
    struct stat info;
    if (lstat(path.fileSystemRepresentation, &info) != 0) return YES;           // nothing there
    if (!S_ISREG(info.st_mode) || info.st_uid != getuid()) return NO;          // never a directory, a link, or someone else's
    return unlink(path.fileSystemRepresentation) == 0;
}

BOOL SBHarnessWriteResponse(NSDictionary<NSString *, id> *response, NSString *outPath) {
    NSData *data = SBHarnessEncodeResponse(response);
    if (!outPath) {
        fwrite(data.bytes, 1, data.length, stdout);
        fflush(stdout);
        return YES;
    }
    NSString *problem = SBHarnessProblemWithOutPath(outPath);
    if (problem) { SBLog(@"harness: answer not written (%@)", problem); return NO; }
    // A private temporary file (0600, created fresh, never through a link), then an atomic rename onto the name:
    // whoever waits for the file sees all of it or nothing, and nobody else can read it.
    NSString *template = [outPath.stringByDeletingLastPathComponent stringByAppendingPathComponent:@".ghost-answer-XXXXXX"];
    char buffer[PATH_MAX];
    if (strlcpy(buffer, template.fileSystemRepresentation, sizeof(buffer)) >= sizeof(buffer)) return NO;
    int fd = mkstemp(buffer);
    if (fd < 0) { SBLog(@"harness: could not write the answer file"); return NO; }
    fchmod(fd, 0600);
    BOOL ok = write(fd, data.bytes, data.length) == (ssize_t)data.length;
    ok = (close(fd) == 0) && ok;
    if (ok) ok = rename(buffer, outPath.fileSystemRepresentation) == 0;   // replaces a file or a link, never follows one
    if (!ok) { unlink(buffer); SBLog(@"harness: could not write the answer file"); }
    return ok;
}

#pragma mark - channel

@implementation SBHarnessChannel {
    int _lockFd;
}

- (instancetype)initWithDirectory:(NSString *)directory {
    if ((self = [super init])) {
        _directory = [directory copy];
        _requestsDirectory = [[directory stringByAppendingPathComponent:@"requests"] copy];
        _lockFd = -1;
        NSDictionary *private = @{ NSFilePosixPermissions: @0700 };
        for (NSString *path in @[ _directory, _requestsDirectory, [_directory stringByAppendingPathComponent:@"responses"] ]) {
            [NSFileManager.defaultManager createDirectoryAtPath:path withIntermediateDirectories:YES attributes:private error:NULL];
        }
    }
    return self;
}

+ (instancetype)defaultChannel {
    NSString *support = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support/Shabang/harness"];
    return [[SBHarnessChannel alloc] initWithDirectory:support];
}

- (void)dealloc {
    [self releaseAgentLock];
}

- (NSString *)requestPathForIdentifier:(NSString *)identifier {
    return [[_requestsDirectory stringByAppendingPathComponent:identifier] stringByAppendingPathExtension:@"json"];
}

- (NSString *)responsePathForIdentifier:(NSString *)identifier {
    return [[[_directory stringByAppendingPathComponent:@"responses"] stringByAppendingPathComponent:identifier] stringByAppendingPathExtension:@"json"];
}

- (BOOL)sendRequest:(SBHarnessRequest *)request {
    if (!SBHarnessIdentifierIsSafe(request.identifier)) return NO;
    if (![[request data] writeToFile:[self requestPathForIdentifier:request.identifier] options:NSDataWritingAtomic error:NULL]) return NO;
    [NSDistributedNotificationCenter.defaultCenter postNotificationName:SBHarnessRequestNotification object:nil userInfo:nil deliverImmediately:YES];
    return YES;
}

- (BOOL)requestIsPending:(NSString *)identifier {
    return SBHarnessIdentifierIsSafe(identifier) && [NSFileManager.defaultManager fileExistsAtPath:[self requestPathForIdentifier:identifier]];
}

- (void)withdrawRequest:(NSString *)identifier {
    if (SBHarnessIdentifierIsSafe(identifier)) unlink([self requestPathForIdentifier:identifier].fileSystemRepresentation);
}

- (NSString *)lockPath {
    return [_directory stringByAppendingPathComponent:@"agent.lock"];
}

- (BOOL)acquireAgentLock {
    if (_lockFd >= 0) return YES;
    int fd = open([self lockPath].fileSystemRepresentation, O_RDWR | O_CREAT | O_CLOEXEC, 0600);
    if (fd < 0) return NO;
    // A launched harness process probes this lock for a few microseconds: try again before giving up.
    for (int attempt = 0; attempt < 5; attempt++) {
        if (flock(fd, LOCK_EX | LOCK_NB) == 0) {
            _lockFd = fd;
            if (ftruncate(fd, 0) == 0) dprintf(fd, "%d\n", getpid());
            return YES;
        }
        usleep(60 * 1000);
    }
    close(fd);
    return NO;
}

- (void)releaseAgentLock {
    if (_lockFd < 0) return;
    flock(_lockFd, LOCK_UN);
    close(_lockFd);
    _lockFd = -1;
}

- (BOOL)agentIsRunning {
    if (_lockFd >= 0) return YES;
    int fd = open([self lockPath].fileSystemRepresentation, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return NO;
    BOOL held = flock(fd, LOCK_SH | LOCK_NB) != 0;
    if (!held) flock(fd, LOCK_UN);
    close(fd);
    return held;
}

- (NSArray<SBHarnessRequest *> *)claimPendingRequests {
    NSFileManager *fm = NSFileManager.defaultManager;
    NSMutableArray<SBHarnessRequest *> *claimed = [NSMutableArray array];
    NSTimeInterval now = NSDate.date.timeIntervalSince1970;
    for (NSString *name in [[fm contentsOfDirectoryAtPath:_requestsDirectory error:NULL] sortedArrayUsingSelector:@selector(compare:)]) {
        if (![name.pathExtension isEqualToString:@"json"] || [name hasPrefix:@"."]) continue;
        NSString *path = [_requestsDirectory stringByAppendingPathComponent:name];
        struct stat info;
        // A plain file of this user only (never a link, a directory or another account's file), removed with unlink.
        if (lstat(path.fileSystemRepresentation, &info) != 0 || !S_ISREG(info.st_mode) || info.st_uid != getuid()) continue;
        NSData *data = [NSData dataWithContentsOfFile:path];
        // Deleting IS the claim: a file that cannot be removed is not run (it would run again on every scan).
        if (unlink(path.fileSystemRepresentation) != 0) continue;
        NSString *error;
        SBHarnessRequest *request = [SBHarnessRequest requestWithData:data error:&error];
        if (!request) { SBLog(@"harness: dropped a malformed request (%@)", error ?: @"?"); continue; }
        if (![request.identifier isEqualToString:name.stringByDeletingPathExtension]) { SBLog(@"harness: dropped a request whose id is not its file name"); continue; }
        if (fabs(now - request.createdAt) > SBHarnessRequestMaxAge) { SBLog(@"harness: dropped a stale request mode=%@", request.mode); continue; }
        [claimed addObject:request];
    }
    [claimed sortUsingComparator:^NSComparisonResult(SBHarnessRequest *a, SBHarnessRequest *b) { return [@(a.createdAt) compare:@(b.createdAt)]; }];
    return claimed;
}

@end

#pragma mark - server

@implementation SBHarnessServer {
    SBHarnessChannel *_channel;
    SBController * (^_controller)(void);
    NSMutableArray<SBHarnessRequest *> *_queue;
    dispatch_source_t _watch;
    BOOL _observing;
    BOOL _running;
}

- (instancetype)initWithChannel:(SBHarnessChannel *)channel controller:(SBController * (^)(void))controller {
    if ((self = [super init])) {
        _channel = channel;
        _controller = [controller copy];
        _queue = [NSMutableArray array];
        __weak SBHarnessServer *weakSelf = self;
        _perform = ^(SBHarnessRequest *request, void (^completion)(NSDictionary<NSString *, id> *)) {
            SBHarnessServer *server = weakSelf;
            [SBHarness performRequest:request controller:server ? server->_controller() : nil completion:completion];
        };
    }
    return self;
}

- (void)dealloc {
    [self stop];
}

- (void)start {
    if (_observing) return;
    _observing = YES;
    [NSDistributedNotificationCenter.defaultCenter addObserver:self selector:@selector(requestPosted:) name:SBHarnessRequestNotification object:nil
                                            suspensionBehavior:NSNotificationSuspensionBehaviorDeliverImmediately];
    int fd = open(_channel.requestsDirectory.fileSystemRepresentation, O_EVTONLY | O_CLOEXEC);
    if (fd >= 0) {
        _watch = dispatch_source_create(DISPATCH_SOURCE_TYPE_VNODE, (uintptr_t)fd, DISPATCH_VNODE_WRITE, dispatch_get_main_queue());
        __weak SBHarnessServer *weakSelf = self;
        dispatch_source_set_event_handler(_watch, ^{ [weakSelf drain]; });
        dispatch_source_set_cancel_handler(_watch, ^{ close(fd); });
        dispatch_resume(_watch);
    }
    [self drain];   // a request written while no agent was looking: run it if it is fresh, drop it if it is stale
}

- (void)stop {
    if (!_observing) return;
    _observing = NO;
    [NSDistributedNotificationCenter.defaultCenter removeObserver:self];
    if (_watch) { dispatch_source_cancel(_watch); _watch = nil; }
}

- (void)requestPosted:(NSNotification *)notification {
    dispatch_async(dispatch_get_main_queue(), ^{ [self drain]; });
}

- (void)drain {
    [_queue addObjectsFromArray:[_channel claimPendingRequests]];
    [self runNext];
}

/// One at a time: two autotab runs pressing Tab into the same walk would make both reports meaningless.
- (void)runNext {
    if (_running || _queue.count == 0) return;
    SBHarnessRequest *request = _queue.firstObject;
    [_queue removeObjectAtIndex:0];
    _running = YES;
    CFAbsoluteTime started = CFAbsoluteTimeGetCurrent();
    SBLog(@"harness: request mode=%@ id=%@ (running agent)", request.mode, request.identifier);
    self.perform(request, ^(NSDictionary<NSString *, id> *response) {
        NSMutableDictionary<NSString *, id> *answer = [response mutableCopy];
        answer[@"mode"] = request.mode;
        answer[@"agent"] = @"running";
        answer[@"totalMs"] = @(round((CFAbsoluteTimeGetCurrent() - started) * 1000.0));
        SBHarnessWriteResponse(answer, request.outPath ?: [self->_channel responsePathForIdentifier:request.identifier]);
        SBLog(@"harness: answered mode=%@ id=%@ error=%@", request.mode, request.identifier, response[@"error"] ?: @"none");
        self->_servedCount++;
        self->_running = NO;
        [self runNext];
    });
}

@end

#pragma mark - --dump-tree

static NSRegularExpression *SBHarnessContactPattern(void) {
    static NSRegularExpression *regex;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        regex = [NSRegularExpression regularExpressionWithPattern:@"[^\\s@]+@[^\\s@]+\\.[^\\s@]+|\\+?\\d[\\d\\s().-]{6,}\\d" options:0 error:NULL];
    });
    return regex;
}

static BOOL SBHarnessIsSecure(id<SBAXNode> node) {
    return [node.role isEqualToString:@"AXSecureTextField"] || [node.subrole isEqualToString:@"AXSecureTextField"];
}

/// Roles whose label often lives in a separate title element: worth one more AX call.
static BOOL SBHarnessIsFormControl(NSString *role) {
    static NSSet<NSString *> *roles;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        roles = [NSSet setWithArray:@[ @"AXTextField", @"AXTextArea", @"AXComboBox", @"AXPopUpButton", @"AXCheckBox", @"AXRadioButton",
                                       @"AXRadioGroup", @"AXSearchField", @"AXSlider", @"AXDateField", @"AXSecureTextField" ]];
    });
    return role && [roles containsObject:role];
}

typedef struct {
    NSUInteger maxDepth;
    NSUInteger maxNodes;
    NSUInteger visited;
    BOOL truncated;
    CFAbsoluteTime stopAt;   // 0 = no time limit
} SBHarnessTreeWalk;

@implementation SBHarnessTree

+ (NSString *)safeText:(NSString *)text {
    if (text.length == 0) return nil;
    NSArray<NSString *> *words = [text componentsSeparatedByCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    NSString *line = [[words filteredArrayUsingPredicate:[NSPredicate predicateWithFormat:@"length > 0"]] componentsJoinedByString:@" "];
    if (line.length == 0) return nil;
    if ([SBHarnessContactPattern() firstMatchInString:line options:0 range:NSMakeRange(0, line.length)]) {
        return [NSString stringWithFormat:@"[redacted:%lu]", (unsigned long)line.length];
    }
    if (line.length <= SBHarnessMaxTextLength) return line;
    NSRange cut = [line rangeOfComposedCharacterSequencesForRange:NSMakeRange(0, SBHarnessMaxTextLength)];
    return [[line substringWithRange:cut] stringByAppendingString:@"..."];
}

/// Text-entry controls: what is inside them (a rich-text editor's paragraphs, a combo box's typed text) is the
/// user's input, so a dump never descends into them.
static BOOL SBHarnessIsTextEntry(NSString *role) {
    static NSSet<NSString *> *roles;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        roles = [NSSet setWithArray:@[ @"AXTextField", @"AXTextArea", @"AXComboBox", @"AXSearchField", @"AXSecureTextField", @"AXDateField", @"AXTimeField" ]];
    });
    return role && [roles containsObject:role];
}

/// Browser chrome outside any web area: toolbars, tab-bar items (every open tab's title), the address field.
/// Never the path to the page (Safari keeps its AXWebArea INSIDE the outer AXTabGroup).
static BOOL SBHarnessIsBrowserChrome(id<SBAXNode> node, NSString *role) {
    if ([role isEqualToString:@"AXToolbar"] || [node.subrole isEqualToString:@"AXTabButton"]) return YES;
    NSString *identifier = node.identifier.lowercaseString ?: @"";
    return [identifier isEqualToString:@"web_browser_address_and_search_field"] || [identifier containsString:@"omnibox"]
        || [identifier containsString:@"addressandsearch"] || [identifier containsString:@"address_and_search"];
}

/// A widget that shows a CHOSEN value as page text (react-select's single-value, a tag list): input, not page text.
static BOOL SBHarnessShowsChosenValue(id<SBAXNode> node) {
    for (NSString *name in node.domClassList) {
        NSString *lower = name.lowercaseString;
        if ([lower containsString:@"single-value"] || [lower containsString:@"singlevalue"] || [lower containsString:@"multi-value"]
            || [lower containsString:@"multivalue"]) return YES;
    }
    return NO;
}

+ (NSDictionary<NSString *, id> *)describe:(id<SBAXNode>)node depth:(NSUInteger)depth walk:(SBHarnessTreeWalk *)walk
                                   actions:(NSArray<NSString *> * (^)(id<SBAXNode>))actions inWebArea:(BOOL)inWebArea {
    walk->visited++;
    NSMutableDictionary<NSString *, id> *out = [NSMutableDictionary dictionary];
    NSString *role = node.role;
    out[@"role"] = role ?: @"";

    // Sensitive first: the role and the flag, nothing else. Not the label, not a length, not what is inside.
    NSString *labelledBy = nil;
    if (SBHarnessIsFormControl(role)) {
        id<SBAXNode> titleElement = node.titleUIElement;
        labelledBy = titleElement.title.length ? titleElement.title : titleElement.value;
    }
    NSString *naming = [@[ node.title ?: @"", node.axDescription ?: @"", node.placeholder ?: @"", node.help ?: @"", node.identifier ?: @"", labelledBy ?: @"" ]
                        componentsJoinedByString:@" "];
    if (SBHarnessIsSecure(node) || [SBCapture nativeLooksSensitive:naming]) {
        out[@"sensitive"] = @YES;
        return out;
    }
    if (!inWebArea && SBHarnessIsBrowserChrome(node, role)) {
        out[@"omitted"] = @"browser-chrome";
        return out;
    }

    // Titles that name a window, a document or a tab are the user's browsing, not the page: never written.
    BOOL namesTheWindow = [role isEqualToString:@"AXWindow"] || [role isEqualToString:@"AXWebArea"] || (!inWebArea && [role isEqualToString:@"AXTabGroup"]);
    NSMutableDictionary<NSString *, NSString *> *texts = [@{
        @"subrole": node.subrole ?: @"", @"roleDescription": node.roleDescription ?: @"", @"placeholder": node.placeholder ?: @"",
        @"help": node.help ?: @"", @"identifier": node.identifier ?: @"",
    } mutableCopy];
    if (!namesTheWindow) {
        texts[@"title"] = node.title ?: @"";
        texts[@"description"] = node.axDescription ?: @"";
    }
    for (NSString *key in texts) {
        NSString *safe = [self safeText:texts[key]];
        if (safe) out[key] = safe;
    }
    NSArray<NSString *> *classes = node.domClassList;
    if (classes.count) out[@"classes"] = [classes subarrayWithRange:NSMakeRange(0, MIN(classes.count, kMaxClasses))];
    NSArray<NSString *> *names = actions ? actions(node) : nil;
    if (names.count) out[@"actions"] = names;
    NSString *safeLabel = [self safeText:labelledBy];
    if (safeLabel) out[@"labelledBy"] = safeLabel;

    NSString *value = node.value;
    if ([role isEqualToString:@"AXStaticText"] && !namesTheWindow) {
        NSString *safe = [self safeText:value];
        if (safe) out[@"text"] = safe;
    } else if (value) {
        out[@"valueLength"] = @(value.length);
    }

    CGRect frame = node.frame;
    if (!CGRectIsEmpty(frame) && !CGRectIsInfinite(frame)) {
        out[@"rect"] = @{ @"x": @(round(frame.origin.x)), @"y": @(round(frame.origin.y)), @"width": @(round(frame.size.width)), @"height": @(round(frame.size.height)) };
    }
    if (!node.enabled) out[@"enabled"] = @NO;
    if (node.isFocused) out[@"focused"] = @YES;
    if (node.required) out[@"required"] = @YES;

    NSArray<id<SBAXNode>> *children = node.children;
    if (children.count == 0) return out;
    if (SBHarnessIsTextEntry(role) || SBHarnessShowsChosenValue(node)) {
        out[@"childrenOmitted"] = @(children.count);   // the user's input, not page structure
        return out;
    }
    if (depth >= walk->maxDepth) {
        walk->truncated = YES;
        out[@"childrenOmitted"] = @(children.count);
        return out;
    }
    BOOL childInWeb = inWebArea || [role isEqualToString:@"AXWebArea"];
    NSMutableArray<NSDictionary *> *described = [NSMutableArray arrayWithCapacity:children.count];
    for (id<SBAXNode> child in children) {
        BOOL outOfTime = walk->stopAt > 0 && CFAbsoluteTimeGetCurrent() > walk->stopAt;
        if (walk->visited >= walk->maxNodes || outOfTime) {
            walk->truncated = YES;
            out[@"childrenOmitted"] = @(children.count - described.count);
            break;
        }
        [described addObject:[self describe:child depth:depth + 1 walk:walk actions:actions inWebArea:childInWeb]];
    }
    if (described.count) out[@"children"] = described;
    return out;
}

+ (NSDictionary<NSString *, id> *)treeFromNode:(id<SBAXNode>)root maxDepth:(NSUInteger)maxDepth maxNodes:(NSUInteger)maxNodes
                                      actions:(NSArray<NSString *> * (^)(id<SBAXNode>))actions visited:(NSUInteger *)visited truncated:(BOOL *)truncated
                                   timeBudget:(NSTimeInterval)timeBudget {
    SBHarnessTreeWalk walk = { .maxDepth = maxDepth, .maxNodes = MAX(maxNodes, (NSUInteger)1), .visited = 0, .truncated = NO,
                               .stopAt = timeBudget > 0 ? CFAbsoluteTimeGetCurrent() + timeBudget : 0 };
    NSDictionary<NSString *, id> *tree = [self describe:root depth:0 walk:&walk actions:actions inWebArea:NO];
    if (visited) *visited = walk.visited;
    if (truncated) *truncated = walk.truncated;
    return tree;
}

+ (NSDictionary<NSString *, id> *)treeFromNode:(id<SBAXNode>)root maxDepth:(NSUInteger)maxDepth maxNodes:(NSUInteger)maxNodes
                                      actions:(NSArray<NSString *> * (^)(id<SBAXNode>))actions visited:(NSUInteger *)visited truncated:(BOOL *)truncated {
    return [self treeFromNode:root maxDepth:maxDepth maxNodes:maxNodes actions:actions visited:visited truncated:truncated timeBudget:0];
}

@end

#pragma mark - --autotab

static const CGKeyCode kHarnessTabKeyCode = 48;

@implementation SBHarnessTabPoster

+ (NSArray<NSNumber *> *)postableKeyCodes {
    return @[ @(kHarnessTabKeyCode) ];
}

- (BOOL)postTab {
    if (SBRealKeyEventsForbidden()) return NO;   // the test runner
    // HID-state source and NO user data: Shabang's tap cannot tell this press from the user's, which is the point.
    CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
    if (!source) return NO;
    CGEventRef down = CGEventCreateKeyboardEvent(source, kHarnessTabKeyCode, true);
    CGEventRef up = CGEventCreateKeyboardEvent(source, kHarnessTabKeyCode, false);
    BOOL ok = down != NULL && up != NULL;
    if (ok) {
        CGEventSetFlags(down, (CGEventFlags)0);
        CGEventSetFlags(up, (CGEventFlags)0);
        CGEventPost(kCGHIDEventTap, down);
        CGEventPost(kCGHIDEventTap, up);
    }
    if (down) CFRelease(down);
    if (up) CFRelease(up);
    CFRelease(source);
    return ok;
}

@end

@implementation SBAutotabRunner {
    id<SBAutotabSubject> _subject;
    id<SBAutotabKeyPosting> _poster;
    NSInteger _count;
    NSTimeInterval _interval;
    NSInteger _posted;
    NSUInteger _notConsumedInARow;
    NSTimeInterval _startedAt;
    NSMutableArray<NSDictionary *> *_steps;
    void (^_completion)(NSDictionary<NSString *, id> *);
    // the press in flight
    NSUInteger _stepCountBefore;
    NSTimeInterval _pressedAt;
    NSDictionary *_currentBefore;
}

- (instancetype)initWithSubject:(id<SBAutotabSubject>)subject poster:(id<SBAutotabKeyPosting>)poster {
    if ((self = [super init])) {
        _subject = subject;
        _poster = poster;
        _maxSettle = 8.0;
        _after = ^(NSTimeInterval delay, dispatch_block_t block) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)), dispatch_get_main_queue(), block);
        };
        _clock = ^NSTimeInterval { return NSProcessInfo.processInfo.systemUptime; };
    }
    return self;
}

- (void)runCount:(NSInteger)count intervalMs:(NSInteger)intervalMs completion:(void (^)(NSDictionary<NSString *, id> *))completion {
    _count = MAX(0, MIN(count, SBHarnessMaxAutotabCount));
    _interval = (NSTimeInterval)MAX(50, MIN(intervalMs, 5000)) / 1000.0;
    _posted = 0;
    _notConsumedInARow = 0;
    _steps = [NSMutableArray array];
    _completion = [completion copy];
    _startedAt = self.clock();
    [self pressNext];
}

- (void)finish:(NSString *)stopped state:(NSDictionary *)state {
    NSMutableDictionary<NSString *, id> *report = [@{ @"requested": @(_count), @"posted": @(_posted), @"stopped": stopped,
                                                      @"steps": [_steps copy], @"final": state ?: @{} } mutableCopy];
    if ([stopped isEqualToString:@"locked"]) report[@"lockedLabel"] = state[@"current"][@"label"] ?: @"";
    if (self.expectField.length) report[@"expectField"] = self.expectField;
    void (^completion)(NSDictionary<NSString *, id> *) = _completion;
    _completion = nil;
    if (completion) completion(report);
}

- (void)pressNext {
    NSDictionary *state = [_subject harnessState] ?: @{};
    NSDictionary *current = [state[@"current"] isKindOfClass:[NSDictionary class]] ? state[@"current"] : nil;
    NSString *stop = nil;
    if (![state[@"active"] boolValue]) stop = @"inactive";
    else if ([current[@"locked"] boolValue]) stop = @"locked";            // the rule: never a Tab onto a locked ghost
    else if (_posted >= _count) stop = @"count";
    else if (!current) stop = @"no-ghost";
    else if (_notConsumedInARow >= kStallLimit) stop = @"stalled";
    else if (self.maxDuration > 0 && self.clock() - _startedAt > self.maxDuration) stop = @"timeout";
    if (stop) { [self finish:stop state:state]; return; }

    // Last, because it is the only check that costs a window capture, and it must be the most recent thing known
    // before the key goes out: everything above is about Shabang, this one is about the page still being the page.
    if (!self.precondition) { [self press:current]; return; }
    __block BOOL answered = NO;
    self.precondition(^(NSString *problem) {
        if (answered) return;                                    // a guard that answers twice must not press twice
        answered = YES;
        if (problem.length) { [self finish:problem state:[self->_subject harnessState] ?: @{}]; return; }
        [self press:current];
    });
}

- (void)press:(NSDictionary *)current {
    if (!_completion) return;                                    // cancelled while the guard was looking
    _stepCountBefore = _subject.stepCount;
    _currentBefore = current;
    _pressedAt = self.clock();
    if (![_poster postTab]) { [self finish:@"post-failed" state:[_subject harnessState] ?: @{}]; return; }
    _posted++;
    self.after(_interval, ^{ [self settle]; });
}

- (void)settle {
    BOOL waitedLongEnough = self.clock() - _pressedAt >= _interval + self.maxSettle;
    if (_subject.busy && !waitedLongEnough) { self.after(0.05, ^{ [self settle]; }); return; }

    BOOL consumed = _subject.stepCount > _stepCountBefore;
    NSDictionary *last = consumed ? _subject.lastStep : nil;
    NSMutableDictionary<NSString *, id> *step = [NSMutableDictionary dictionary];
    step[@"step"] = @(_posted);
    step[@"ghost"] = last[@"label"] ?: _currentBefore[@"label"] ?: @"";
    step[@"action"] = last[@"action"] ?: _currentBefore[@"action"] ?: @"";
    step[@"consumed"] = @(consumed);
    step[@"outcome"] = consumed ? (last[@"outcome"] ?: @"unknown") : (_subject.busy ? @"still-busy" : @"not-consumed");
    step[@"verified"] = @(consumed && [last[@"verified"] boolValue]);
    if (last[@"reason"]) step[@"reason"] = last[@"reason"];
    step[@"ms"] = @(round((self.clock() - _pressedAt) * 1000.0));
    if (last[@"ms"]) step[@"writeMs"] = last[@"ms"];
    NSDictionary *next = [_subject harnessState][@"current"];
    if ([next isKindOfClass:[NSDictionary class]]) step[@"next"] = next[@"label"] ?: @"";
    [_steps addObject:step];
    _notConsumedInARow = consumed ? 0 : _notConsumedInARow + 1;
    [self pressNext];
}

@end

#pragma mark - live

static BOOL (^gTrustProbe)(void);

static dispatch_queue_t SBHarnessQueue(void) {
    static dispatch_queue_t queue;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ queue = dispatch_queue_create("dev.shabang.desktop.harness", DISPATCH_QUEUE_SERIAL); });
    return queue;
}

static BOOL SBHarnessIsGhost(NSRunningApplication *app) {
    NSString *own = NSBundle.mainBundle.bundleIdentifier;
    return app.processIdentifier == getpid() || (own.length && [app.bundleIdentifier isEqualToString:own]);
}

/// The app the user is working in. A Shabang process launched for the harness can be "frontmost" for a moment
/// without owning a window: then the owner of the top-most ordinary window is the one that is meant.
static NSRunningApplication *SBHarnessTargetApplication(void) {
    NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
    if (front && !SBHarnessIsGhost(front)) return front;
    NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    for (NSDictionary *window in windows) {
        if ([window[(__bridge NSString *)kCGWindowLayer] integerValue] != 0) continue;
        NSRunningApplication *owner = [NSRunningApplication runningApplicationWithProcessIdentifier:[window[(__bridge NSString *)kCGWindowOwnerPID] intValue]];
        if (owner && !SBHarnessIsGhost(owner) && owner.activationPolicy == NSApplicationActivationPolicyRegular) return owner;
    }
    return nil;
}

static NSRunningApplication *SBHarnessFindApplication(NSString *nameOrBundleId) {
    for (NSRunningApplication *app in NSWorkspace.sharedWorkspace.runningApplications) {
        if (SBHarnessIsGhost(app) || app.activationPolicy != NSApplicationActivationPolicyRegular) continue;
        if ([app.bundleIdentifier caseInsensitiveCompare:nameOrBundleId] == NSOrderedSame) return app;
        if ([app.localizedName caseInsensitiveCompare:nameOrBundleId] == NSOrderedSame) return app;
    }
    return nil;
}

/// Every piece of text in a redacted --dump-tree that could carry a field label. Values never reach the tree, so
/// this can only ever see labels and page text.
static void SBHarnessCollectTreeLabels(id node, NSMutableArray<NSString *> *into) {
    if (into.count > 4000) return;
    if ([node isKindOfClass:[NSArray class]]) {
        for (id child in (NSArray *)node) SBHarnessCollectTreeLabels(child, into);
        return;
    }
    if (![node isKindOfClass:[NSDictionary class]]) return;
    NSDictionary *dictionary = node;
    for (NSString *key in @[ @"title", @"description", @"placeholder", @"help", @"text", @"labelledBy", @"roleDescription" ]) {
        NSString *text = dictionary[key];
        if ([text isKindOfClass:[NSString class]] && text.length) [into addObject:text];
    }
    SBHarnessCollectTreeLabels(dictionary[@"children"], into);
}

static AXUIElementRef SBHarnessCopyWindow(AXUIElementRef application, AXError *error) {
    CFTypeRef window = NULL;
    for (NSString *attribute in @[ (__bridge NSString *)kAXFocusedWindowAttribute, (__bridge NSString *)kAXMainWindowAttribute ]) {
        *error = AXUIElementCopyAttributeValue(application, (__bridge CFStringRef)attribute, &window);
        if (*error == kAXErrorSuccess && window) return (AXUIElementRef)window;
    }
    CFTypeRef windows = NULL;
    *error = AXUIElementCopyAttributeValue(application, kAXWindowsAttribute, &windows);
    if (*error != kAXErrorSuccess || !windows) return NULL;
    NSArray *list = CFBridgingRelease(windows);
    return list.count ? (AXUIElementRef)CFBridgingRetain(list.firstObject) : NULL;
}

/// A bounded capture of `pid`'s frontmost window, for the --expect-field guard only: the field LABELS, nothing else.
/// nil (never an empty array) when there is no window, no core or the walk found nothing, so that the caller cannot
/// confuse "the page is gone" with "the page has no matching field" -- both refuse the press either way.
static NSArray<NSString *> *SBHarnessCapturedLabels(pid_t pid, NSString *bundleId, NSURL *bundleURL, SBCore *core) {
    if (!core) return nil;
    AXUIElementRef application = AXUIElementCreateApplication(pid);
    if (!application) return nil;
    AXUIElementSetMessagingTimeout(application, 1.0);
    if ([SBAccessibility appNeedsEnhancedUserInterface:bundleId bundleURL:bundleURL]) {
        AXUIElementSetAttributeValue(application, CFSTR("AXEnhancedUserInterface"), kCFBooleanTrue);
        AXUIElementSetAttributeValue(application, CFSTR("AXManualAccessibility"), kCFBooleanTrue);
    }
    AXError axError = kAXErrorSuccess;
    AXUIElementRef window = SBHarnessCopyWindow(application, &axError);
    NSArray<NSString *> *labels = nil;
    id<SBAXNode> node = window ? [SBAXElementNode nodeWithElement:window] : nil;
    if (node) {
        SBCapture *capture = [[SBCapture alloc] initWithSafety:core];
        SBCaptureLimits *limits = [SBCaptureLimits defaultLimits];
        limits.maxNodes = kCaptureMaxNodes;
        limits.timeBudget = kGuardTimeBudget;
        limits.webAreaTimeBudget = kGuardTimeBudget;
        capture.limits = limits;
        capture.keepsScrolledOutFields = YES;
        capture.treatsFramelessWebNodesAsScrolledOut = [SBAccessibility appNeedsEnhancedUserInterface:bundleId bundleURL:bundleURL];
        SBCaptureResult *result = [capture captureWindow:node];
        NSMutableArray<NSString *> *found = [NSMutableArray array];
        for (SBField *field in result.fields) if (field.label.length) [found addObject:field.label];
        labels = found.count ? [found copy] : nil;
    }
    if (window) CFRelease(window);
    CFRelease(application);
    return labels;
}

@implementation SBHarness

+ (void)setTrustProbe:(BOOL (^)(void))probe {
    gTrustProbe = [probe copy];
}

static BOOL (^gPauseCheck)(NSString *);

+ (void)setPauseCheck:(BOOL (^)(NSString *))check {
    gPauseCheck = [check copy];
}

+ (BOOL)bundleIdentifierIsPaused:(NSString *)bundleId {
    if (gPauseCheck) return gPauseCheck(bundleId);
    if ([[[SBAccessibility alloc] init] isBundleIdentifierPaused:bundleId]) return YES;   // the built-in list
    // The user's own pause list (menu: "Pause in <app>"), read fresh from settings.json: the same list the running
    // controller honours. An unreadable settings file leaves the built-in list only.
    SBProfileStore *store = [[SBProfileStore alloc] initWithCore:nil];
    [store reload];
    return [store isPausedBundleId:bundleId];
}

+ (BOOL)processIsTrusted {
    return gTrustProbe ? gTrustProbe() : (AXIsProcessTrusted() ? YES : NO);
}

+ (NSString *)libraryPath {
    Dl_info info;
    if (!dladdr((__bridge void *)[SBHarness class], &info) || !info.dli_fname) return nil;
    return @(info.dli_fname);
}

+ (NSDictionary<NSString *, id> *)trustResponse {
    BOOL trusted = [self processIsTrusted];
    NSMutableDictionary<NSString *, id> *response = [@{ @"trusted": @(trusted), @"pid": @(getpid()), @"library": [self libraryPath] ?: @"" } mutableCopy];
    if (!trusted) response[@"error"] = @"not trusted";
    return response;
}

+ (void)performRequest:(SBHarnessRequest *)request controller:(SBController *)controller
            completion:(void (^)(NSDictionary<NSString *, id> *))completion {
    if (![self processIsTrusted]) { completion(SBHarnessNotTrustedResponse()); return; }
    if ([request.mode isEqualToString:SBHarnessModeTrust]) { completion([self trustResponse]); return; }

    NSRunningApplication *wanted = nil;
    if (request.frontmost.length) {
        wanted = SBHarnessFindApplication(request.frontmost);
        if (!wanted) { completion(SBHarnessErrorResponse(@"app-not-running", request.frontmost)); return; }
        [wanted activateWithOptions:NSApplicationActivateAllWindows];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.4 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == wanted.processIdentifier || !wanted.bundleURL) return;
            // A background app may be refused activation: LaunchServices is never refused.
            NSWorkspaceOpenConfiguration *configuration = [NSWorkspaceOpenConfiguration configuration];
            configuration.activates = YES;
            [NSWorkspace.sharedWorkspace openApplicationAtURL:wanted.bundleURL configuration:configuration completionHandler:nil];
        });
    }
    NSTimeInterval wait = MAX(request.delay, wanted ? 1.2 : 0.0);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(wait * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        NSRunningApplication *target = SBHarnessTargetApplication();
        if (wanted && target.processIdentifier != wanted.processIdentifier) {
            // Dumping, or worse tabbing through, the wrong window is never better than an error.
            completion(SBHarnessErrorResponse(@"frontmost-failed", request.frontmost));
            return;
        }
        if (!target) { completion(SBHarnessErrorResponse(@"no-frontmost-app", nil)); return; }
        if ([request.mode isEqualToString:SBHarnessModeAutotab]) [self autotab:request controller:controller target:target completion:completion];
        else if ([request.mode isEqualToString:SBHarnessModeAccept]) [self accept:request controller:controller target:target completion:completion];
        else [self look:request target:target completion:completion];
    });
}

/**
 * Take the ghost that is on screen, the same way the Shabang key does, and report what actually happened.
 *
 * This is the only harness mode that touches anything. It exists because a press and a real click are
 * indistinguishable from the outside until one of them works: a Chromium-hosted app answers AXPress with
 * success and does nothing, so "did the accept do something" can only be settled by taking one and looking.
 * `before` and `after` are what the window proposed either side of it -- when they are identical, nothing moved.
 */
+ (void)accept:(SBHarnessRequest *)request controller:(SBController *)controller target:(NSRunningApplication *)target
    completion:(void (^)(NSDictionary<NSString *, id> *))completion {
    if (!controller) { completion(SBHarnessErrorResponse(@"no-pipeline", ([NSString stringWithFormat:@"%@ is off, or its pipeline is not running", SBProductName]))); return; }
    NSDictionary<NSString *, id> *before = [controller harnessState];
    NSDictionary<NSString *, id> *ghost = before[@"current"];
    if (!ghost) { completion(SBHarnessErrorResponse(@"no-ghost", @"nothing is proposed in this window right now")); return; }
    NSUInteger stepsBefore = controller.stepCount;
    SBLog(@"harness: accept taking the current ghost in %@", target.bundleIdentifier ?: @"unknown");
    [controller eventTapDidTapGhostKey:controller.eventTap];
    // Long enough for the write to finish, the app to react and the next rescan to land.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        NSDictionary<NSString *, id> *after = [controller harnessState];
        NSMutableDictionary<NSString *, id> *out = [NSMutableDictionary dictionary];
        out[@"app"] = target.bundleIdentifier ?: @"unknown";
        out[@"appName"] = target.localizedName ?: @"";
        out[@"took"] = ghost;
        out[@"step"] = controller.lastStep ?: @{};
        out[@"stepped"] = @(controller.stepCount > stepsBefore);
        out[@"before"] = before[@"statusLine"] ?: @"";
        out[@"after"] = after[@"statusLine"] ?: @"";
        out[@"nowProposes"] = after[@"current"] ?: [NSNull null];
        // The one question this mode exists to answer: did the window move at all?
        NSString *wasLabel = ghost[@"label"] ?: @"";
        NSString *nowLabel = after[@"current"][@"label"] ?: @"";
        out[@"windowChanged"] = @(![wasLabel isEqualToString:nowLabel] || ![(before[@"statusLine"] ?: @"") isEqualToString:(after[@"statusLine"] ?: @"")]);
        completion(out);
    });
}

+ (void)autotab:(SBHarnessRequest *)request controller:(SBController *)controller target:(NSRunningApplication *)target
     completion:(void (^)(NSDictionary<NSString *, id> *))completion {
    if (!controller) { completion(SBHarnessErrorResponse(@"no-pipeline", ([NSString stringWithFormat:@"%@ is off, or its pipeline is not running", SBProductName]))); return; }
    SBAutotabRunner *runner = [[SBAutotabRunner alloc] initWithSubject:(id<SBAutotabSubject>)controller poster:[[SBHarnessTabPoster alloc] init]];
    runner.maxDuration = request.autotabBudget;
    NSString *bundleId = target.bundleIdentifier ?: @"unknown";
    if (request.expectField.length) {
        // The page guard. `--frontmost Safari` only says Safari is in front; this says the window in front is still
        // the one the run was aimed at. It runs before EVERY press, so a tab the user (or a redirect) switched under
        // the run costs zero keystrokes.
        NSString *expected = [request.expectField copy];
        pid_t pid = target.processIdentifier;
        NSURL *bundleURL = target.bundleURL;
        SBCore *core = [SBCore sharedCore];
        runner.expectField = expected;
        runner.precondition = ^(void (^allow)(NSString *problem)) {
            NSRunningApplication *now = SBHarnessTargetApplication();       // main queue: NSWorkspace lives there
            if (!now || now.processIdentifier != pid) { allow(@"frontmost-changed"); return; }
            dispatch_async(SBHarnessQueue(), ^{
                NSArray<NSString *> *labels = SBHarnessCapturedLabels(pid, bundleId, bundleURL, core);
                BOOL ok = SBHarnessLabelsMeetExpectation(labels, expected);
                if (!ok) SBLog(@"harness: expect-field guard refused a press (app=%@, %lu labels)", bundleId, (unsigned long)labels.count);
                dispatch_async(dispatch_get_main_queue(), ^{ allow(ok ? nil : @"expect-field-missing"); });
            });
        };
    }
    __block SBAutotabRunner *keepAlive = runner;   // nothing else owns the runner while it waits between presses
    [runner runCount:request.count intervalMs:request.intervalMs completion:^(NSDictionary<NSString *, id> *report) {
        NSMutableDictionary<NSString *, id> *response = [report mutableCopy];
        response[@"trusted"] = @YES;
        response[@"app"] = bundleId;
        SBLog(@"harness: autotab app=%@ posted=%@ stopped=%@", bundleId, report[@"posted"], report[@"stopped"]);
        keepAlive = nil;
        completion(response);
    }];
}


/// --next: what Shabang would PROPOSE on this window, in the terms docs/anywhere.md uses. Read-only in every
/// sense: it presses nothing, posts no key, and reads role memory without ever writing it back.
static NSDictionary<NSString *, id> *SBHarnessNextActionReport(SBCore *core, SBCaptureResult *result,
                                                               id<SBAXNode> window, NSString *bundleId) {
    SBNextAction *engine = [[SBNextAction alloc] initWithCore:core
                                                      memory:[[SBRoleMemoryStore alloc] initWithPath:[SBRoleMemoryStore defaultPath] core:core]];
    SBPageSignals *given = [[SBPageSignals alloc] init];
    given.appBundleId = bundleId;
    CFAbsoluteTime started = CFAbsoluteTimeGetCurrent();
    SBNextProposal *top = [engine proposeForResult:result window:window signals:given];
    double elapsed = round((CFAbsoluteTimeGetCurrent() - started) * 1000.0);

    NSMutableDictionary<NSString *, SBField *> *bySignature = [NSMutableDictionary dictionary];
    for (SBField *field in result.fields) if (field.signature.length) bySignature[field.signature] = field;

    NSDictionary *(^row)(SBNextProposal *) = ^NSDictionary *(SBNextProposal *proposal) {
        if (!proposal) return nil;
        SBField *field = bySignature[proposal.signature];
        NSMutableDictionary<NSString *, id> *out = [@{
            @"role": proposal.role ?: @"unknown",
            @"confidence": @(round(proposal.confidence * 1000.0) / 1000.0),
            @"source": proposal.source ?: @"prior",
            @"locked": @(proposal.locked),
            @"guess": @(proposal.guess),
            @"reason": proposal.reason ?: @"",
        } mutableCopy];
        if (field) {
            out[@"kind"] = field.kind ?: @"";
            out[@"label"] = field.label ?: @"";           // --dump already reports labels; never a value
            out[@"unnamed"] = @(field.unnamed);
            out[@"insideMediaControls"] = @(field.insideMediaControls);
            out[@"nearbyPrice"] = @(field.nearbyPrice);
            if (field.badgeCount > 0) out[@"badgeCount"] = @(field.badgeCount);
            if (field.listSignature.length) out[@"listIndex"] = @(field.listIndex);
        }
        return out;
    };

    NSMutableArray<NSDictionary *> *ranked = [NSMutableArray array];
    for (SBNextProposal *proposal in engine.ranked) {
        NSDictionary *encoded = row(proposal);
        if (encoded) [ranked addObject:encoded];
    }
    NSMutableDictionary<NSString *, id> *report = [@{
        @"pageKind": engine.pageKind ?: @"unknown",
        @"pageEvidence": engine.pageEvidence ?: @[],
        @"threshold": @(engine.threshold),
        @"ranked": ranked,
        @"unnamedCount": @(engine.unnamedSignatures.count),
        @"proposeMs": @(elapsed),
    } mutableCopy];
    NSDictionary *topRow = row(top);
    if (topRow) report[@"top"] = topRow;
    if (engine.lastSignals) report[@"signals"] = [engine.lastSignals toJSONObject];
    return report;
}

/// --dump and --dump-tree. The AX walk runs off the main queue; the answer comes back on it.
+ (void)look:(SBHarnessRequest *)request target:(NSRunningApplication *)target completion:(void (^)(NSDictionary<NSString *, id> *))completion {
    NSString *bundleId = target.bundleIdentifier;
    if ([self bundleIdentifierIsPaused:bundleId]) {
        completion(SBHarnessErrorResponse(@"paused-app", bundleId ?: @"unknown"));   // password managers, terminals, the user's list: Shabang never looks
        return;
    }
    pid_t pid = target.processIdentifier;
    NSURL *bundleURL = target.bundleURL;
    NSString *appName = target.localizedName ?: @"";
    BOOL wantsTree = [request.mode isEqualToString:SBHarnessModeDumpTree];
    BOOL wantsProbe = [request.mode isEqualToString:SBHarnessModeProbeComboBox];
    BOOL wantsNext = [request.mode isEqualToString:SBHarnessModeNext];
    NSUInteger depth = (NSUInteger)request.depth;
    SBCore *core = (wantsTree || wantsProbe) ? nil : [SBCore sharedCore];
    if (!wantsTree && !wantsProbe && !core) { completion(SBHarnessErrorResponse(@"no-core", @"shabang-core.js is missing; run make core lib")); return; }

    dispatch_async(SBHarnessQueue(), ^{
        CFAbsoluteTime started = CFAbsoluteTimeGetCurrent();
        AXUIElementRef application = AXUIElementCreateApplication(pid);
        AXUIElementSetMessagingTimeout(application, 1.0);
        if ([SBAccessibility appNeedsEnhancedUserInterface:bundleId bundleURL:bundleURL]) {
            // Chromium and Electron only build their web accessibility tree when asked.
            AXUIElementSetAttributeValue(application, CFSTR("AXEnhancedUserInterface"), kCFBooleanTrue);
            AXUIElementSetAttributeValue(application, CFSTR("AXManualAccessibility"), kCFBooleanTrue);
            [NSThread sleepForTimeInterval:0.6];
        }
        AXError axError = kAXErrorSuccess;
        AXUIElementRef window = SBHarnessCopyWindow(application, &axError);
        NSMutableDictionary<NSString *, id> *response = [@{ @"trusted": @YES, @"app": bundleId ?: @"unknown", @"appName": appName } mutableCopy];
        id<SBAXNode> node = window ? [SBAXElementNode nodeWithElement:window] : nil;
        if (!node) {
            [response addEntriesFromDictionary:SBHarnessErrorResponse(@"no-window", [NSString stringWithFormat:@"AXError %d", (int)axError])];
        } else if (wantsTree) {
            NSUInteger visited = 0;
            BOOL truncated = NO;
            response[@"tree"] = [SBHarnessTree treeFromNode:node maxDepth:depth maxNodes:SBHarnessMaxTreeNodes actions:^NSArray<NSString *> *(id<SBAXNode> each) {
                CFArrayRef names = NULL;
                if (!each.axElement || AXUIElementCopyActionNames(each.axElement, &names) != kAXErrorSuccess || !names) return nil;
                return CFBridgingRelease(names);
            } visited:&visited truncated:&truncated timeBudget:kTreeTimeBudget];
            response[@"depth"] = @(depth);
            response[@"visitedNodes"] = @(visited);
            response[@"truncated"] = @(truncated);
            if (request.expectField.length) {
                NSMutableArray<NSString *> *texts = [NSMutableArray array];
                SBHarnessCollectTreeLabels(response[@"tree"], texts);
                BOOL matched = SBHarnessLabelsMeetExpectation(texts, request.expectField);
                response[@"expectField"] = request.expectField;
                response[@"expectFieldMatched"] = @(matched);
                if (!matched) response[@"error"] = @"expect-field-missing";
            }
        } else if (wantsProbe) {
            [response addEntriesFromDictionary:[SBProbe probeComboBoxUnderWindow:node labelSubstring:request.probeLabel]];
        } else {
            SBCapture *capture = [[SBCapture alloc] initWithSafety:core];
            SBCaptureLimits *limits = [SBCaptureLimits defaultLimits];
            limits.maxNodes = kCaptureMaxNodes;
            limits.timeBudget = kCaptureTimeBudget;
            // webAreaTimeBudget REPLACES timeBudget once the walk meets the page, so raising only timeBudget left
            // the real budget at the 0.12 s default's 0.6 s successor -- enough for Safari, not for Chrome, whose
            // AX round trips are several times slower.
            limits.webAreaTimeBudget = kCaptureTimeBudget;
            capture.limits = limits;
            capture.keepsScrolledOutFields = YES;   // the same view of the page as the running controller
            capture.treatsFramelessWebNodesAsScrolledOut = [SBAccessibility appNeedsEnhancedUserInterface:bundleId bundleURL:bundleURL];
            SBCaptureResult *result = [capture captureWindow:node];
            NSUInteger locked = 0;
            for (SBField *field in result.fields) if (field.locked) locked++;
            response[@"formSignature"] = result.formSignature ?: @"";
            response[@"visitedNodes"] = @(result.visitedNodes);
            response[@"partial"] = @(result.partial);
            response[@"fieldCount"] = @(result.fields.count);
            response[@"lockedCount"] = @(locked);
            response[@"fields"] = [SBField wireJSONObjectsForFields:result.fields];   // wire objects: never a value
            if (wantsNext) [response addEntriesFromDictionary:SBHarnessNextActionReport(core, result, result.windowNode ?: node, bundleId)];
            if (request.expectField.length) {
                NSMutableArray<NSString *> *labels = [NSMutableArray array];
                for (SBField *field in result.fields) if (field.label.length) [labels addObject:field.label];
                BOOL matched = SBHarnessLabelsMeetExpectation(labels, request.expectField);
                response[@"expectField"] = request.expectField;
                response[@"expectFieldMatched"] = @(matched);
                // The fields stay in the answer: seeing WHAT was captured instead is the whole point of a failed guard.
                if (!matched) response[@"error"] = @"expect-field-missing";
            }
        }
        response[@"elapsedMs"] = @(round((CFAbsoluteTimeGetCurrent() - started) * 1000.0));
        if (window) CFRelease(window);
        CFRelease(application);
        SBLog(@"harness: %@ app=%@ nodes=%@ error=%@", request.mode, bundleId ?: @"unknown", response[@"visitedNodes"] ?: @0, response[@"error"] ?: @"none");
        dispatch_async(dispatch_get_main_queue(), ^{ completion(response); });
    });
}

@end
