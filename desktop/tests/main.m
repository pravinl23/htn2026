// Plain executable test runner. Prints each test name, exits non-zero on the first run with failures.
#import "GHTest.h"
#import "GHEventTap.h"
#import "GHLog.h"

typedef struct {
    const char *name;
    const char *file;
    GHTestFunction function;
} GHTestCase;

static GHTestCase *gTests;
static size_t gTestCount;
static size_t gTestCapacity;
static int gFailuresInCurrentTest;
static NSMutableArray<NSString *> *gTempDirectories;

void GHTestRegister(const char *name, const char *file, GHTestFunction function) {
    // Runs from constructors, before main(): plain C only.
    if (gTestCount == gTestCapacity) {
        gTestCapacity = gTestCapacity ? gTestCapacity * 2 : 64;
        gTests = realloc(gTests, gTestCapacity * sizeof(GHTestCase));
    }
    gTests[gTestCount++] = (GHTestCase){ name, file, function };
}

void GHTestFail(const char *file, int line, NSString *message) {
    gFailuresInCurrentTest++;
    const char *base = strrchr(file, '/');
    printf("    FAIL %s:%d %s\n", base ? base + 1 : file, line, message.UTF8String);
}

BOOL GHTestWaitUntil(NSTimeInterval timeout, BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
    while (!done() && [deadline timeIntervalSinceNow] > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    return done();
}

NSString *GHTestTempDirectory(void) {
    NSString *path = [NSTemporaryDirectory() stringByAppendingPathComponent:[NSString stringWithFormat:@"ghost-tests-%@", NSUUID.UUID.UUIDString]];
    [NSFileManager.defaultManager createDirectoryAtPath:path withIntermediateDirectories:YES attributes:nil error:NULL];
    if (!gTempDirectories) gTempDirectories = [NSMutableArray array];
    [gTempDirectories addObject:path];
    return path;
}

static int GHCompareTests(const void *a, const void *b) {
    const GHTestCase *x = a, *y = b;
    int byFile = strcmp(x->file, y->file);
    return byFile ? byFile : strcmp(x->name, y->name);
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        // Nothing under test may ever reach the real keyboard: every live posting path refuses from here on.
        GHForbidRealKeyEvents();
        // Tests must never write into the user's real log.
        GHLogSetPath([GHTestTempDirectory() stringByAppendingPathComponent:@"desktop.log"]);
        GHLogSetMirrorToStderr(NO);

        const char *filter = argc > 1 ? argv[1] : NULL;
        qsort(gTests, gTestCount, sizeof(GHTestCase), GHCompareTests);

        int ran = 0, failed = 0;
        const char *currentFile = NULL;
        for (size_t i = 0; i < gTestCount; i++) {
            GHTestCase test = gTests[i];
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
                    GHTestFail(test.file, 0, [NSString stringWithFormat:@"uncaught exception %@: %@", exception.name, exception.reason]);
                }
            }
            ran++;
            if (gFailuresInCurrentTest > 0) failed++;
        }

        GHLogFlush();
        for (NSString *dir in gTempDirectories) [NSFileManager.defaultManager removeItemAtPath:dir error:NULL];
        if (ran == 0) {
            printf("no tests ran%s%s\n", filter ? " matching " : "", filter ?: "");
            return 1;
        }
        printf("\n%d tests, %d failed\n", ran, failed);
        return failed == 0 ? 0 : 1;
    }
}
