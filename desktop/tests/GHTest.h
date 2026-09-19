// GHTest: a tiny test harness (no XCTest on this machine).
//
//   #import "GHTest.h"
//   GH_TEST(core_maps_first_name) {
//       GH_ASSERT(thing);
//       GH_ASSERT_EQUAL_OBJECTS(a, b);          // wrap literals that contain commas: (@[ @1, @2 ])
//   }
//
// Every tests/test_*.m is linked into build/ghost-tests by the Makefile. GH_TEST registers the function
// before main() runs; tests/main.m prints each name, runs it, and exits non-zero when any assertion failed.
// A failed assertion records the failure and RETURNS from the test function.
// Filter: `build/ghost-tests core_` runs only the tests whose name contains "core_".
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef void (*GHTestFunction)(void);

void GHTestRegister(const char *name, const char *file, GHTestFunction function);
void GHTestFail(const char *file, int line, NSString *message);
/// Spins the main run loop until `done()` is true or `timeout` seconds passed. Returns done().
BOOL GHTestWaitUntil(NSTimeInterval timeout, BOOL (^done)(void));
/// A fresh empty directory under the system temp directory, removed when the run ends.
NSString *GHTestTempDirectory(void);

NS_ASSUME_NONNULL_END

#define GH_TEST(name) \
    static void ghtest_##name(void); \
    __attribute__((constructor)) static void ghtest_register_##name(void) { GHTestRegister(#name, __FILE__, ghtest_##name); } \
    static void ghtest_##name(void)

#define GH_FAIL(...) \
    do { GHTestFail(__FILE__, __LINE__, [NSString stringWithFormat:__VA_ARGS__]); return; } while (0)

// Variadic so that Objective-C literals with commas (@{ a: b, c: d }, @[ x, y ]) need no extra parentheses.
#define GH_ASSERT(...) \
    do { if (!(__VA_ARGS__)) { GHTestFail(__FILE__, __LINE__, @"expected true: " #__VA_ARGS__); return; } } while (0)

#define GH_ASSERT_FALSE(...) \
    do { if ((__VA_ARGS__)) { GHTestFail(__FILE__, __LINE__, @"expected false: " #__VA_ARGS__); return; } } while (0)

#define GH_ASSERT_MSG(condition, ...) \
    do { if (!(condition)) { GHTestFail(__FILE__, __LINE__, [NSString stringWithFormat:__VA_ARGS__]); return; } } while (0)

#define GH_ASSERT_EQUAL_OBJECTS(actual, expected) \
    do { \
        id gh_a = (actual); id gh_e = (expected); \
        if (!(gh_a == gh_e || [gh_a isEqual:gh_e])) { \
            GHTestFail(__FILE__, __LINE__, [NSString stringWithFormat:@"%s: got %@, expected %@", #actual, gh_a, gh_e]); return; \
        } \
    } while (0)

#define GH_ASSERT_EQUAL_INT(actual, expected) \
    do { \
        long long gh_a = (long long)(actual); long long gh_e = (long long)(expected); \
        if (gh_a != gh_e) { GHTestFail(__FILE__, __LINE__, [NSString stringWithFormat:@"%s: got %lld, expected %lld", #actual, gh_a, gh_e]); return; } \
    } while (0)

#define GH_ASSERT_NEAR(actual, expected, tolerance) \
    do { \
        double gh_a = (double)(actual); double gh_e = (double)(expected); \
        if (fabs(gh_a - gh_e) > (tolerance)) { GHTestFail(__FILE__, __LINE__, [NSString stringWithFormat:@"%s: got %g, expected %g", #actual, gh_a, gh_e]); return; } \
    } while (0)
