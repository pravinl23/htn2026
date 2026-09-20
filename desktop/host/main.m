// Ghost host: the ONLY code inside Shabang.app, and it never changes. macOS ties the Accessibility grant of an
// ad-hoc signed app to its code hash, so everything that does change lives in libshabang.dylib OUTSIDE the
// bundle (docs/desktop-realworld.md section 1). Do not add anything here: a rebuilt host loses the grant.
//
// Library: $SHABANG_LIB (when set it is the only candidate), else ~/Library/Application Support/Shabang/libshabang.dylib,
// else <bundle>/../libshabang.dylib, else the path written in ~/Library/Application Support/Shabang/lib-path.txt.
#import <AppKit/AppKit.h>
#import <dlfcn.h>

__attribute__((used)) static const char kGhostHostMarker[] = "ghost-host-v1";   // `make host` looks for it

static int Fail(int argc, const char **argv, NSString *message) {
    fprintf(stderr, "Ghost: %s\n", message.UTF8String);
    for (int i = 1; i + 1 < argc; i++) {
        if (strcmp(argv[i], "--out") != 0) continue;   // a harness run: answer in the file, never block on a dialog
        NSData *json = [NSJSONSerialization dataWithJSONObject:@{ @"error": @"library not loaded", @"detail": message } options:0 error:NULL];
        [json writeToFile:@(argv[i + 1]) atomically:YES];
        return 70;
    }
    if (isatty(STDERR_FILENO)) return 70;
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp activateIgnoringOtherApps:YES];
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"Ghost cannot start";
    alert.informativeText = message;
    [alert runModal];
    return 70;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        NSString *support = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support/Shabang"];
        NSMutableArray<NSString *> *candidates = [NSMutableArray array];
        const char *env = getenv("SHABANG_LIB");
        if (env && *env) {
            [candidates addObject:@(env)];
        } else {
            [candidates addObject:[support stringByAppendingPathComponent:@"libshabang.dylib"]];
            [candidates addObject:[NSBundle.mainBundle.bundlePath.stringByDeletingLastPathComponent stringByAppendingPathComponent:@"libshabang.dylib"]];
            NSString *pointer = [NSString stringWithContentsOfFile:[support stringByAppendingPathComponent:@"lib-path.txt"] encoding:NSUTF8StringEncoding error:NULL];
            pointer = [pointer stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
            if (pointer.length) [candidates addObject:pointer];
        }
        NSString *path = nil;
        for (NSString *candidate in candidates) {
            if ([NSFileManager.defaultManager fileExistsAtPath:candidate]) { path = candidate; break; }
        }
        if (!path) {
            return Fail(argc, argv, [NSString stringWithFormat:@"libshabang.dylib not found. Looked at:\n%@\nBuild it with `make -C desktop lib` (and `make -C desktop install-lib`).",
                                     [candidates componentsJoinedByString:@"\n"]]);
        }
        void *library = dlopen(path.fileSystemRepresentation, RTLD_NOW | RTLD_GLOBAL);
        if (!library) return Fail(argc, argv, [NSString stringWithFormat:@"could not load %@: %s", path, dlerror() ?: "unknown error"]);
        int (*ghostMain)(int, const char **) = dlsym(library, "GhostMain");
        if (!ghostMain) return Fail(argc, argv, [NSString stringWithFormat:@"%@ has no GhostMain symbol (stale or foreign library). Rebuild it with `make -C desktop lib`.", path]);
        return ghostMain(argc, argv);
    }
}
