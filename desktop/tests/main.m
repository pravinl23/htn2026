// Plain executable test runner. Prints each test name, exits non-zero on the first run with failures.
#import "SBTest.h"
#import "SBEventTap.h"
#import "SBLog.h"

typedef struct {
    const char *name;
    const char *file;
    SBTestFunction function;
} SBTestCase;

static SBTestCase *gTests;
static size_t gTestCount;
static size_t gTestCapacity;
static int gFailuresInCurrentTest;
static NSMutableArray<NSString *> *gTempDirectories;

void SBTestRegister(const char *name, const char *file, SBTestFunction function) {
    // Runs from constructors, before main(): plain C only.
    if (gTestCount == gTestCapacity) {
        gTestCapacity = gTestCapacity ? gTestCapacity * 2 : 64;
        gTests = realloc(gTests, gTestCapacity * sizeof(SBTestCase));
    }
    gTests[gTestCount++] = (SBTestCase){ name, file, function };
}

void SBTestFail(const char *file, int line, NSString *message) {
    gFailuresInCurrentTest++;
    const char *base = strrchr(file, '/');
    printf("    FAIL %s:%d %s\n", base ? base + 1 : file, line, message.UTF8String);
}

BOOL SBTestWaitUntil(NSTimeInterval timeout, BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
    while (!done() && [deadline timeIntervalSinceNow] > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    return done();
}

NSString *SBTestTempDirectory(void) {
    NSString *path = [NSTemporaryDirectory() stringByAppendingPathComponent:[NSString stringWithFormat:@"ghost-tests-%@", NSUUID.UUID.UUIDString]];
    [NSFileManager.defaultManager createDirectoryAtPath:path withIntermediateDirectories:YES attributes:nil error:NULL];
    if (!gTempDirectories) gTempDirectories = [NSMutableArray array];
    [gTempDirectories addObject:path];
    return path;
}

static int SBCompareTests(const void *a, const void *b) {
    const SBTestCase *x = a, *y = b;
    int byFile = strcmp(x->file, y->file);
    return byFile ? byFile : strcmp(x->name, y->name);
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        // Nothing under test may ever reach the real keyboard: every live posting path refuses from here on.
        SBForbidRealKeyEvents();
        // Tests must never write into the user's real log.
        SBLogSetPath([SBTestTempDirectory() stringByAppendingPathComponent:@"desktop.log"]);
        SBLogSetMirrorToStderr(NO);

        const char *filter = argc > 1 ? argv[1] : NULL;
        qsort(gTests, gTestCount, sizeof(SBTestCase), SBCompareTests);

        int ran = 0, failed = 0;
        const char *currentFile = NULL;
        for (size_t i = 0; i < gTestCount; i++) {
            SBTestCase test = gTests[i];
            if (filter && !strstr(test.name, filter)) continue;
            if (!currentFile || strcmp(currentFile, test.file) != 0) {
                currentFile = test.file;
                const char *base = strrchr(currentFile, '/');
                printf("%s\n", base ? base + 1 : currentFile);
            }
            gFailuresInCurrentTest = 0;
            printf("  %s\n", test.name);
            fflush(stdout);
            @autoreleasepool {
                @try {
                    test.function();
                } @catch (NSException *exception) {
                    SBTestFail(test.file, 0, [NSString stringWithFormat:@"uncaught exception %@: %@", exception.name, exception.reason]);
                }
            }
            ran++;
            if (gFailuresInCurrentTest > 0) failed++;
        }

        SBLogFlush();
        for (NSString *dir in gTempDirectories) [NSFileManager.defaultManager removeItemAtPath:dir error:NULL];
        if (ran == 0) {
            printf("no tests ran%s%s\n", filter ? " matching " : "", filter ?: "");
            return 1;
        }
        printf("\n%d tests, %d failed\n", ran, failed);
        return failed == 0 ? 0 : 1;
    }
}
