#import "GHLog.h"
#include <sys/stat.h>

static NSString *gPath;
static BOOL gMirror;
static BOOL gMirrorSet;
static unsigned long long gMaxBytes = 2ULL * 1024 * 1024;

static dispatch_queue_t GHLogQueue(void) {
    static dispatch_queue_t queue;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ queue = dispatch_queue_create("dev.ghost.desktop.log", DISPATCH_QUEUE_SERIAL); });
    return queue;
}

static NSString *GHDefaultLogPath(void) {
    return [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Logs/Ghost/desktop.log"];
}

NSString *GHLogPath(void) {
    __block NSString *path;
    dispatch_sync(GHLogQueue(), ^{ path = gPath ?: GHDefaultLogPath(); });
    return path;
}

void GHLogSetPath(NSString *path) {
    dispatch_sync(GHLogQueue(), ^{ gPath = [path copy]; });
}

void GHLogSetMirrorToStderr(BOOL mirror) {
    dispatch_sync(GHLogQueue(), ^{ gMirror = mirror; gMirrorSet = YES; });
}

void GHLogSetMaxBytes(unsigned long long maxBytes) {
    dispatch_sync(GHLogQueue(), ^{ gMaxBytes = maxBytes; });
}

static BOOL GHShouldMirror(void) {
    if (gMirrorSet) return gMirror;
    const char *env = getenv("GHOST_LOG_STDERR");
    return env && env[0] == '1';
}

static void GHRotateIfNeeded(NSString *path) {
    struct stat st;
    if (stat(path.fileSystemRepresentation, &st) != 0 || (unsigned long long)st.st_size < gMaxBytes) return;
    NSString *old = [path stringByAppendingString:@".1"];
    NSFileManager *fm = NSFileManager.defaultManager;
    [fm removeItemAtPath:old error:NULL];
    [fm moveItemAtPath:path toPath:old error:NULL];
}

static void GHAppendLine(NSString *line) {
    NSString *path = gPath ?: GHDefaultLogPath();
    NSFileManager *fm = NSFileManager.defaultManager;
    [fm createDirectoryAtPath:path.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:NULL];
    GHRotateIfNeeded(path);
    if (![fm fileExistsAtPath:path]) {
        [fm createFileAtPath:path contents:nil attributes:@{ NSFilePosixPermissions: @0600 }];
    }
    NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:path];
    if (!handle) return;
    @try {
        [handle seekToEndOfFile];
        [handle writeData:[line dataUsingEncoding:NSUTF8StringEncoding]];
    } @catch (NSException *exception) {
        // a full disk must not crash the agent
    }
    [handle closeFile];
}

void GHLog(NSString *format, ...) {
    va_list args;
    va_start(args, format);
    NSString *message = [[NSString alloc] initWithFormat:format arguments:args];
    va_end(args);

    static NSDateFormatter *formatter;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        formatter = [[NSDateFormatter alloc] init];
        formatter.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
        formatter.dateFormat = @"yyyy-MM-dd'T'HH:mm:ss.SSSZZZZZ";
    });
    NSDate *now = [NSDate date];
    dispatch_async(GHLogQueue(), ^{
        NSString *oneLine = [message stringByReplacingOccurrencesOfString:@"\n" withString:@" "];
        NSString *line = [NSString stringWithFormat:@"%@ %@\n", [formatter stringFromDate:now], oneLine];
        GHAppendLine(line);
        if (GHShouldMirror()) fputs(line.UTF8String, stderr);
    });
}

void GHLogFlush(void) {
    dispatch_sync(GHLogQueue(), ^{});
}

NSString *GHLogLabel(NSString *label) {
    if (label.length == 0) return @"(no label)";
    static NSRegularExpression *secret;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        secret = [NSRegularExpression regularExpressionWithPattern:
                  @"passw|passcode|\\bpin\\b|\\botp\\b|\\bssn\\b|social (security|insurance)|passport|licen[cs]e|card|cvv|cvc|secret|api[- _]?key|account number|routing|iban"
                                                           options:NSRegularExpressionCaseInsensitive error:NULL];
    });
    if ([secret firstMatchInString:label options:0 range:NSMakeRange(0, label.length)]) return @"[sensitive]";
    NSArray<NSString *> *parts = [label componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet];
    NSString *flat = [parts componentsJoinedByString:@" "];
    if (flat.length <= 40) return flat;
    NSRange safe = [flat rangeOfComposedCharacterSequencesForRange:NSMakeRange(0, 40)];
    return [[flat substringWithRange:safe] stringByAppendingString:@"..."];
}
