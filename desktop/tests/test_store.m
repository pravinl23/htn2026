// GHProfileStore tests. Everything happens in a temp directory: the user's real Application Support is never touched.
#import "GHTest.h"
#import "GHCore.h"
#import "GHProfileStore.h"
#import "GHAppDelegate.h"
#include <sys/stat.h>

static GHCore *StoreCore(void) {
    static GHCore *core;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSString *path = [GHCore defaultBundlePath];
        core = path ? [[GHCore alloc] initWithBundlePath:path error:NULL] : nil;
    });
    return core;
}

static int ModeOf(NSString *path) {
    struct stat st;
    return stat(path.fileSystemRepresentation, &st) == 0 ? (int)(st.st_mode & 0777) : -1;
}

static GHProfileStore *FreshStore(void) {
    NSString *directory = [GHTestTempDirectory() stringByAppendingPathComponent:@"Ghost"];
    GHProfileStore *store = [[GHProfileStore alloc] initWithDirectory:directory core:StoreCore()];
    [store prepare];
    return store;
}

GH_TEST(store_seeds_demo_profile_with_private_modes) {
    GHProfileStore *store = FreshStore();
    GH_ASSERT_EQUAL_INT(ModeOf(store.directory), 0700);
    GH_ASSERT_EQUAL_INT(ModeOf(store.profilePath), 0600);
    GH_ASSERT_EQUAL_INT(ModeOf(store.settingsPath), 0600);
    GH_ASSERT_EQUAL_INT(ModeOf(store.answersPath), 0600);
    GH_ASSERT_EQUAL_INT([store.learnedAnswers[@"answers"] count], 0);
    GH_ASSERT_EQUAL_OBJECTS(store.profile[@"facts"][@"firstName"], @"Alex");
    GH_ASSERT_EQUAL_OBJECTS(store.profile[@"facts"][@"email"], @"alex.chen.dev@example.com");
    GH_ASSERT(store.enabled);
    GH_ASSERT_NEAR(store.confidenceThreshold, 0.7, 1e-9);
    GH_ASSERT_EQUAL_OBJECTS(store.serverURLString, @"http://localhost:8787");
    GH_ASSERT([[store usableFactKeys] containsObject:@"linkedin"]);
}

GH_TEST(store_profile_round_trip_keeps_0600) {
    GHProfileStore *store = FreshStore();
    NSDictionary *profile = @{ @"facts": @{ @"firstName": @"Alex", @"nickname": @"Al", @"empty": @"", @"bogus": @42 },
                               @"pastAnswers": @[ @{ @"question": @"Why us?", @"answer": @"Because.", @"origin": @"app://demo" }, @{ @"question": @"no answer" } ] };
    NSError *error;
    GH_ASSERT([store saveProfile:profile error:&error]);
    GH_ASSERT_EQUAL_INT(ModeOf(store.profilePath), 0600);

    GHProfileStore *reopened = [[GHProfileStore alloc] initWithDirectory:store.directory core:StoreCore()];
    [reopened prepare];
    GH_ASSERT_EQUAL_OBJECTS(reopened.profile[@"facts"][@"nickname"], @"Al");
    GH_ASSERT(reopened.profile[@"facts"][@"bogus"] == nil);          // only string facts survive
    GH_ASSERT_EQUAL_INT([reopened.profile[@"pastAnswers"] count], 1);
    GH_ASSERT_EQUAL_OBJECTS([reopened usableFactKeys], (@[ @"firstName", @"nickname" ])); // empty facts are not offered
    // No temp file left behind.
    NSArray *files = [NSFileManager.defaultManager contentsOfDirectoryAtPath:store.directory error:NULL];
    GH_ASSERT_EQUAL_INT(files.count, 3);
}

GH_TEST(store_records_only_safe_opt_in_answers_in_private_storage) {
    GHProfileStore *store = FreshStore();
    GHField *authorization = [GHField fieldWithSignature:@"gh-auth" label:@"Are you legally authorized to work in Canada for any employer?" kind:GHKindSelect];
    authorization.options = @[ @{ @"value": @"0", @"label": @"No" }, @{ @"value": @"1", @"label": @"Yes" } ];
    GH_ASSERT_FALSE([store recordCorrectionForField:authorization value:@"1" optionLabel:@"Yes" origin:@"https://greenhouse.example"]);
    GH_ASSERT([store updateSettings:@{ @"learningEnabled": @YES } error:NULL]);
    GH_ASSERT(store.learningEnabled);
    GH_ASSERT([store recordCorrectionForField:authorization value:@"1" optionLabel:@"Yes" origin:@"https://greenhouse.example"]);
    GH_ASSERT_EQUAL_INT([store.learnedAnswers[@"answers"] count], 1);
    GH_ASSERT_EQUAL_INT(ModeOf(store.answersPath), 0600);

    GHProfileStore *reopened = [[GHProfileStore alloc] initWithDirectory:store.directory core:StoreCore()];
    [reopened prepare];
    GH_ASSERT_EQUAL_INT([reopened.learnedAnswers[@"answers"] count], 1);
    GHField *card = [GHField fieldWithSignature:@"card" label:@"Card number" kind:GHKindText];
    GH_ASSERT_FALSE([reopened recordCorrectionForField:card value:@"4111111111111111" optionLabel:nil origin:@"https://shop.example"]);
    GH_ASSERT_EQUAL_INT([reopened.learnedAnswers[@"answers"] count], 1);
}

GH_TEST(store_never_overwrites_existing_files_and_tightens_modes) {
    NSString *directory = [GHTestTempDirectory() stringByAppendingPathComponent:@"Ghost"];
    [NSFileManager.defaultManager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:NULL];
    NSString *profilePath = [directory stringByAppendingPathComponent:@"profile.json"];
    [@"{\"facts\":{\"firstName\":\"Sam\"},\"pastAnswers\":[]}" writeToFile:profilePath atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    chmod(profilePath.fileSystemRepresentation, 0644);
    GHProfileStore *store = [[GHProfileStore alloc] initWithDirectory:directory core:StoreCore()];
    [store prepare];
    GH_ASSERT_EQUAL_OBJECTS(store.profile[@"facts"][@"firstName"], @"Sam");
    GH_ASSERT(store.profile[@"facts"][@"lastName"] == nil);
    GH_ASSERT_EQUAL_INT(ModeOf(profilePath), 0600);
}

GH_TEST(store_keeps_last_good_profile_when_json_breaks) {
    GHProfileStore *store = FreshStore();
    [@"{ \"facts\": { \"firstName\": \"Al" writeToFile:store.profilePath atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    GH_ASSERT_FALSE([store reload]);
    GH_ASSERT_EQUAL_OBJECTS(store.profile[@"facts"][@"firstName"], @"Alex");
    // The broken file is the user's: it is not "repaired" behind their back.
    NSString *onDisk = [NSString stringWithContentsOfFile:store.profilePath encoding:NSUTF8StringEncoding error:NULL];
    GH_ASSERT([onDisk hasSuffix:@"\"Al"]);
}

GH_TEST(store_settings_are_validated_and_merged) {
    GHProfileStore *store = FreshStore();
    [@"{\"enabled\":false,\"confidenceThreshold\":0.01,\"serverUrl\":\"ftp://evil.example\",\"showHud\":\"yes\",\"futureKey\":{\"a\":1},\"pausedBundleIds\":[\"com.example.app\",7,\"com.example.app\"]}"
        writeToFile:store.settingsPath atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    GH_ASSERT([store reload]);
    GH_ASSERT_FALSE(store.enabled);
    GH_ASSERT_NEAR(store.confidenceThreshold, 0.5, 1e-9);                       // clamped: the gate cannot be removed
    GH_ASSERT_EQUAL_OBJECTS(store.serverURLString, @"http://localhost:8787");   // not http(s): ignored
    GH_ASSERT(store.showHud);                                                   // wrong type: default kept
    GH_ASSERT_EQUAL_OBJECTS([store userPausedBundleIds], (@[ @"com.example.app" ]));

    GH_ASSERT([store updateSettings:@{ @"confidenceThreshold": @0.85, @"serverUrl": @"http://127.0.0.1:8787" } error:NULL]);
    GH_ASSERT_NEAR(store.confidenceThreshold, 0.85, 1e-9);
    GH_ASSERT_EQUAL_OBJECTS(store.serverURLString, @"http://127.0.0.1:8787");
    GH_ASSERT_EQUAL_INT(ModeOf(store.settingsPath), 0600);
    NSDictionary *raw = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:store.settingsPath] options:0 error:NULL];
    GH_ASSERT_EQUAL_OBJECTS(raw[@"futureKey"], (@{ @"a": @1 }));                // keys this build does not know survive
    GH_ASSERT_EQUAL_OBJECTS(raw[@"enabled"], @NO);

    GH_ASSERT([store setEnabled:YES]);
    GH_ASSERT(store.enabled);
}

GH_TEST(store_pause_list) {
    GHProfileStore *store = FreshStore();
    for (NSString *bundleId in @[ @"com.apple.Terminal", @"com.googlecode.iterm2", @"com.apple.keychainaccess", @"com.apple.systempreferences",
                                  @"com.1password.1password", @"com.1password.browser-helper", @"com.bitwarden.desktop", @"dev.ghost.desktop" ]) {
        GH_ASSERT_MSG([store isPausedBundleId:bundleId], @"%@ must always be skipped", bundleId);
    }
    GH_ASSERT([store isPausedBundleId:nil]); // unknown app: stay out
    GH_ASSERT_FALSE([store isPausedBundleId:@"com.apple.Safari"]);
    GH_ASSERT([store setPaused:YES forBundleId:@"com.apple.Safari"]);
    GH_ASSERT([store isPausedBundleId:@"com.apple.Safari"]);
    GH_ASSERT([store setPaused:YES forBundleId:@"com.apple.Safari"]);
    GH_ASSERT_EQUAL_INT([store userPausedBundleIds].count, 1);
    GH_ASSERT([store setPaused:NO forBundleId:@"com.apple.Safari"]);
    GH_ASSERT_FALSE([store isPausedBundleId:@"com.apple.Safari"]);
    // The built-in list cannot be resumed from settings.
    [store setPaused:NO forBundleId:@"com.apple.Terminal"];
    GH_ASSERT([store isPausedBundleId:@"com.apple.Terminal"]);
}

GH_TEST(store_does_not_offer_sensitive_fact_keys) {
    GHProfileStore *store = FreshStore();
    [store saveProfile:@{ @"facts": @{ @"firstName": @"Alex", @"ssn": @"000-00-0000", @"cardNumber": @"4111111111111111", @"password": @"hunter2" } } error:NULL];
    GH_ASSERT_EQUAL_OBJECTS([store usableFactKeys], (@[ @"firstName" ]));
}

GH_TEST(store_without_core_seeds_empty_profile) {
    NSString *directory = [GHTestTempDirectory() stringByAppendingPathComponent:@"Ghost"];
    GHProfileStore *store = [[GHProfileStore alloc] initWithDirectory:directory core:nil];
    GH_ASSERT([store prepare]);
    GH_ASSERT_EQUAL_INT([store.profile[@"facts"] count], 0);
    GH_ASSERT(store.enabled);
    GH_ASSERT_NEAR(store.confidenceThreshold, 0.7, 1e-9);
}

GH_TEST(store_watches_for_edits) {
    GHProfileStore *store = FreshStore();
    [store startWatching];
    __block NSUInteger notifications = 0;
    id token = [NSNotificationCenter.defaultCenter addObserverForName:GHProfileStoreDidChangeNotification object:store queue:nil
                                                           usingBlock:^(NSNotification *note) { notifications++; }];
    // An editor that saves by rename (atomically:YES)...
    [@"{\"facts\":{\"firstName\":\"Robin\"},\"pastAnswers\":[]}" writeToFile:store.profilePath atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    BOOL sawRename = GHTestWaitUntil(3.0, ^BOOL { return [store.profile[@"facts"][@"firstName"] isEqual:@"Robin"] && notifications == 1; });
    // ...and one that writes in place.
    NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:store.profilePath];
    [handle truncateFileAtOffset:0];
    [handle writeData:[@"{\"facts\":{\"firstName\":\"Jamie\"},\"pastAnswers\":[]}" dataUsingEncoding:NSUTF8StringEncoding]];
    [handle closeFile];
    BOOL sawInPlace = GHTestWaitUntil(3.0, ^BOOL { return [store.profile[@"facts"][@"firstName"] isEqual:@"Jamie"] && notifications == 2; });
    [store stopWatching];
    [NSNotificationCenter.defaultCenter removeObserver:token];
    GH_ASSERT(sawRename);
    GH_ASSERT(sawInPlace);
}

GH_TEST(app_status_title) {
    GH_ASSERT_EQUAL_OBJECTS([GHAppDelegate statusTitleForTrusted:NO enabled:YES coreLoaded:YES provider:@"jev" latencyMs:@120], @"Needs Accessibility permission");
    GH_ASSERT_EQUAL_OBJECTS([GHAppDelegate statusTitleForTrusted:YES enabled:NO coreLoaded:YES provider:@"jev" latencyMs:@120], @"Off");
    GH_ASSERT_EQUAL_OBJECTS([GHAppDelegate statusTitleForTrusted:YES enabled:YES coreLoaded:YES provider:nil latencyMs:nil], @"On: heuristic only (server offline)");
    GH_ASSERT_EQUAL_OBJECTS([GHAppDelegate statusTitleForTrusted:YES enabled:YES coreLoaded:YES provider:@"jev-gateway" latencyMs:@182.4], @"On: jev-gateway, 182 ms");
    GH_ASSERT([[GHAppDelegate statusTitleForTrusted:YES enabled:YES coreLoaded:NO provider:nil latencyMs:nil] containsString:@"make core"]);
}

#pragma mark - file facts

GH_TEST(store_validates_resume_and_cover_letter_paths_on_load) {
    GHProfileStore *store = FreshStore();
    NSString *dir = GHTestTempDirectory();
    NSString *resume = [dir stringByAppendingPathComponent:@"resume-alex-chen.pdf"];
    NSString *letter = [dir stringByAppendingPathComponent:@"Cover Letter.docx"];
    NSString *binary = [dir stringByAppendingPathComponent:@"resume.exe"];
    for (NSString *path in @[ resume, letter, binary ]) [@"fictional" writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    NSString *link = [dir stringByAppendingPathComponent:@"linked.pdf"];
    [NSFileManager.defaultManager createSymbolicLinkAtPath:link withDestinationPath:resume error:NULL];

    NSMutableDictionary *profile = [[StoreCore() demoProfile] mutableCopy];
    NSMutableDictionary *facts = [profile[@"facts"] mutableCopy];
    facts[@"resumePath"] = resume;
    facts[@"coverLetterPath"] = letter;
    profile[@"facts"] = facts;
    GH_ASSERT([store saveProfile:profile error:NULL]);
    GH_ASSERT_EQUAL_OBJECTS(store.profile[@"facts"][@"resumePath"], resume);
    GH_ASSERT_EQUAL_OBJECTS(store.profile[@"facts"][@"coverLetterPath"], letter);
    GH_ASSERT([[store usableFactKeys] containsObject:@"resumePath"]);

    NSArray *bad = @[ @"resume-alex-chen.pdf", [dir stringByAppendingPathComponent:@"missing.pdf"], binary, link, dir,
                      [resume stringByAppendingString:@"\n"], [[dir stringByAppendingPathComponent:@"x/.."] stringByAppendingPathComponent:@"resume-alex-chen.pdf"] ];
    for (NSString *path in bad) {
        facts[@"resumePath"] = path;
        profile[@"facts"] = facts;
        NSData *json = [NSJSONSerialization dataWithJSONObject:profile options:0 error:NULL];
        [json writeToFile:store.profilePath atomically:YES];
        [store reload];
        GH_ASSERT_MSG(store.profile[@"facts"][@"resumePath"] == nil, @"path #%lu must be dropped", (unsigned long)[bad indexOfObject:path]);
        GH_ASSERT_EQUAL_OBJECTS(store.profile[@"facts"][@"firstName"], @"Alex");   // the rest of the profile is untouched
    }
    NSString *problem = nil;
    GH_ASSERT(GHUsableProfileFilePath(@"~/ghost-tests-surely-missing-9f1c.pdf", &problem) == nil);
    GH_ASSERT_EQUAL_OBJECTS(problem, @"missing");                   // "~/" was expanded before the checks
    GH_ASSERT(GHUsableProfileFilePath(@"  ", &problem) == nil);
    GH_ASSERT_EQUAL_OBJECTS(GHUsableProfileFilePath(resume, NULL), resume);
}

GH_TEST(store_example_profile_is_the_demo_profile_plus_the_fictional_resume) {
    NSString *here = [@(__FILE__) stringByDeletingLastPathComponent];
    if (!here.isAbsolutePath) here = [NSFileManager.defaultManager.currentDirectoryPath stringByAppendingPathComponent:here];
    NSString *examplePath = [[here stringByAppendingPathComponent:@"../profile.example.json"] stringByStandardizingPath];
    NSDictionary *example = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:examplePath] ?: [NSData data] options:0 error:NULL];
    GH_ASSERT_MSG([example isKindOfClass:NSDictionary.class], @"desktop/profile.example.json must be valid JSON");
    NSMutableDictionary *facts = [example[@"facts"] mutableCopy];
    GH_ASSERT([facts[@"resumePath"] hasSuffix:@"/demo/fixtures/resume-alex-chen.pdf"]);
    [facts removeObjectForKey:@"resumePath"];
    GH_ASSERT_EQUAL_OBJECTS(facts, [StoreCore() demoProfile][@"facts"]);   // fictional Alex Chen, nothing else

    // Loaded through the store (with the path of this checkout): _readme is ignored, the resume path is kept.
    NSString *resume = [[here stringByAppendingPathComponent:@"../../demo/fixtures/resume-alex-chen.pdf"] stringByStandardizingPath];
    NSMutableDictionary *profile = [example mutableCopy];
    NSMutableDictionary *withPath = [example[@"facts"] mutableCopy];
    withPath[@"resumePath"] = resume;
    profile[@"facts"] = withPath;
    GHProfileStore *store = FreshStore();
    [[NSJSONSerialization dataWithJSONObject:profile options:0 error:NULL] writeToFile:store.profilePath atomically:YES];
    [store reload];
    GH_ASSERT_EQUAL_OBJECTS(store.profile[@"facts"][@"resumePath"], resume);
    GH_ASSERT(store.profile[@"_readme"] == nil);
    GH_ASSERT_FALSE([[store usableFactKeys] containsObject:@"_readme"]);
}
