#import "GHProfileStore.h"
#import "GHCore.h"
#import "GHLog.h"
#import "GHOpenPanelDriver.h"
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

NSNotificationName const GHProfileStoreDidChangeNotification = @"GHProfileStoreDidChangeNotification";

static NSString *const kPausedKey = @"pausedBundleIds";
static const double kMinThreshold = 0.5;
static const double kMaxThreshold = 0.99;

#pragma mark - file helpers

/// A crash mid-write cannot leave half a profile behind: the rename is the commit.
BOOL GHWritePrivateFile(NSString *path, NSData *data, NSError **error) {
    NSString *tmp = [path stringByAppendingFormat:@".tmp-%d", getpid()];
    int fd = open(tmp.fileSystemRepresentation, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0600);
    BOOL ok = fd >= 0 && fchmod(fd, 0600) == 0;
    const uint8_t *bytes = data.bytes;
    size_t left = data.length;
    while (ok && left > 0) {
        ssize_t wrote = write(fd, bytes, left);
        if (wrote < 0) { ok = (errno == EINTR); continue; }
        bytes += wrote;
        left -= (size_t)wrote;
    }
    if (fd >= 0) {
        if (ok) fsync(fd);
        close(fd);
    }
    ok = ok && rename(tmp.fileSystemRepresentation, path.fileSystemRepresentation) == 0;
    if (!ok) {
        int code = errno;
        unlink(tmp.fileSystemRepresentation);
        if (error) *error = [NSError errorWithDomain:NSPOSIXErrorDomain code:code userInfo:@{ NSFilePathErrorKey: path }];
    }
    return ok;
}

static NSData *GHPrettyJSON(NSDictionary *object) {
    if (![NSJSONSerialization isValidJSONObject:object]) return nil;
    NSJSONWritingOptions options = NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys | NSJSONWritingWithoutEscapingSlashes;
    NSMutableData *data = [[NSJSONSerialization dataWithJSONObject:object options:options error:NULL] mutableCopy];
    [data appendBytes:"\n" length:1];
    return data;
}

static NSDictionary *GHReadJSONDictionary(NSString *path) {
    NSData *data = [NSData dataWithContentsOfFile:path];
    if (!data) return nil;
    id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
    return [parsed isKindOfClass:[NSDictionary class]] ? parsed : nil;
}

#pragma mark - learned answers

/// The cap of shared/src/answers/store.ts (MAX_LEARNED_ANSWERS). A file that claims more is trimmed.
static const NSUInteger kMaxLearnedAnswers = 500;

static NSDictionary *GHEmptyAnswers(void) {
    return @{ @"max": @(kMaxLearnedAnswers), @"answers": @[] };
}

/// One learned answer, checked exactly as shared/src/answers/store.ts `isLearnedAnswer` does: anything that is
/// not the right shape is dropped rather than handed to the core. Values are never inspected or logged.
static BOOL GHIsLearnedAnswer(id entry) {
    if (![entry isKindOfClass:[NSDictionary class]]) return NO;
    NSDictionary *a = entry;
    for (NSString *key in @[ @"signature", @"textSignature", @"label", @"kind", @"value", @"updatedAt" ]) {
        if (![a[key] isKindOfClass:[NSString class]]) return NO;
    }
    if ([a[@"signature"] length] == 0) return NO;
    if (![a[@"count"] isKindOfClass:[NSNumber class]]) return NO;
    if (![a[@"origins"] isKindOfClass:[NSArray class]]) return NO;
    for (id origin in a[@"origins"]) if (![origin isKindOfClass:[NSString class]]) return NO;
    return [@[ @"ordinary", @"protected", @"declaration" ] containsObject:a[@"class"] ?: @""];
}

/// A LearnedAnswersSnapshot with every malformed entry dropped. Missing, corrupt or the wrong type all read as
/// "nothing learned yet": a broken file must never stop Ghost from proposing an answer (docs/answers.md 1).
static NSDictionary *GHCleanAnswers(NSDictionary *raw) {
    if (![raw isKindOfClass:[NSDictionary class]]) return GHEmptyAnswers();
    NSMutableArray *answers = [NSMutableArray array];
    NSArray *entries = [raw[@"answers"] isKindOfClass:[NSArray class]] ? raw[@"answers"] : @[];
    for (id entry in entries) if (GHIsLearnedAnswer(entry)) [answers addObject:entry];
    if (answers.count > kMaxLearnedAnswers) [answers removeObjectsInRange:NSMakeRange(0, answers.count - kMaxLearnedAnswers)];
    NSNumber *max = [raw[@"max"] isKindOfClass:[NSNumber class]] ? raw[@"max"] : nil;
    NSUInteger cap = max && max.doubleValue >= 1 ? (NSUInteger)MIN((double)kMaxLearnedAnswers, max.doubleValue) : kMaxLearnedAnswers;
    return @{ @"max": @(cap), @"answers": answers };
}

#pragma mark - validation

NSString *const GHProfileResumePathKey = @"resumePath";
NSString *const GHProfileCoverLetterPathKey = @"coverLetterPath";

static BOOL GHIsFilePathFact(NSString *key) {
    return [key isEqualToString:GHProfileResumePathKey] || [key isEqualToString:GHProfileCoverLetterPathKey];
}

NSString *GHUsableProfileFilePath(NSString *raw, NSString **problem) {
    NSString *reason = nil;
    NSString *path = nil;
    if (![raw isKindOfClass:[NSString class]] || raw.length == 0) reason = GHUploadPathEmpty;
    else {
        // A control character anywhere (even a trailing newline) would be a key press in the open panel.
        NSCharacterSet *control = NSCharacterSet.controlCharacterSet;
        if ([raw rangeOfCharacterFromSet:control].location != NSNotFound) reason = GHUploadPathControlCharacter;
        path = [raw stringByTrimmingCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@" "]];
        if ([path hasPrefix:@"~/"]) path = [NSHomeDirectory() stringByAppendingPathComponent:[path substringFromIndex:2]];
        if (!reason && [path.pathComponents containsObject:@".."]) reason = @"dot-dot";
        NSSet<NSString *> *documents = [NSSet setWithArray:@[ @"pdf", @"doc", @"docx", @"rtf", @"txt", @"odt", @"pages" ]];
        if (!reason && ![path hasPrefix:@"/"]) reason = GHUploadPathNotAbsolute;
        if (!reason && ![documents containsObject:path.pathExtension.lowercaseString]) reason = @"not-a-document";
        if (!reason) reason = [GHOpenPanelDriver problemWithUploadPath:path];
    }
    if (problem) *problem = reason;
    return reason ? nil : path;
}

static NSDictionary *GHCleanProfile(NSDictionary *raw) {
    NSMutableDictionary<NSString *, NSString *> *facts = [NSMutableDictionary dictionary];
    NSDictionary *rawFacts = raw[@"facts"];
    if ([rawFacts isKindOfClass:[NSDictionary class]]) {
        [rawFacts enumerateKeysAndObjectsUsingBlock:^(id key, id value, BOOL *stop) {
            if (![key isKindOfClass:[NSString class]] || ![value isKindOfClass:[NSString class]]) return;
            if (!GHIsFilePathFact(key)) { facts[key] = value; return; }
            if ([(NSString *)value length] == 0) return;
            // File facts: an absolute path to a readable document ("~/" is expanded), or nothing at all. Only the
            // file name is ever logged.
            NSString *problem = nil;
            NSString *path = GHUsableProfileFilePath(value, &problem);
            if (path) facts[key] = path;
            else GHLog(@"store: %@ ignored (%@)", key, problem ?: @"invalid");
        }];
    }
    NSMutableArray<NSDictionary *> *answers = [NSMutableArray array];
    NSArray *rawAnswers = raw[@"pastAnswers"];
    if ([rawAnswers isKindOfClass:[NSArray class]]) {
        for (NSDictionary *item in rawAnswers) {
            if (![item isKindOfClass:[NSDictionary class]]) continue;
            if (![item[@"question"] isKindOfClass:[NSString class]] || ![item[@"answer"] isKindOfClass:[NSString class]]) continue;
            NSMutableDictionary *answer = [NSMutableDictionary dictionary];
            for (NSString *key in @[ @"question", @"answer", @"origin", @"savedAt" ]) {
                if ([item[key] isKindOfClass:[NSString class]]) answer[key] = item[key];
            }
            [answers addObject:answer];
        }
    }
    return @{ @"facts": facts, @"pastAnswers": answers };
}

static NSDictionary *GHFallbackSettings(void) {
    // Same values as DEFAULT_SETTINGS in shared/src/types.ts, for the case where the core did not load.
    return @{ @"enabled": @YES, @"confidenceThreshold": @0.7, @"serverUrl": @"http://localhost:8787", @"showHud": @NO,
              @"learningEnabled": @NO, @"answerProtectedWithDecline": @YES, @"acceptKey": @"right-command" };
}

static BOOL GHIsPlainHTTPURL(NSString *string) {
    NSURLComponents *parts = [NSURLComponents componentsWithString:string];
    if (!parts.host.length || parts.user || parts.password) return NO;
    return [parts.scheme isEqualToString:@"http"] || [parts.scheme isEqualToString:@"https"];
}

static NSDictionary *GHCleanSettings(NSDictionary *raw, NSDictionary *defaults) {
    NSMutableDictionary *settings = [defaults mutableCopy];
    for (NSString *key in @[ @"enabled", @"showHud", @"learningEnabled", @"answerProtectedWithDecline" ]) {
        if ([raw[key] isKindOfClass:[NSNumber class]]) settings[key] = @([raw[key] boolValue]);
    }
    NSNumber *threshold = raw[@"confidenceThreshold"];
    if ([threshold isKindOfClass:[NSNumber class]] && isfinite(threshold.doubleValue)) {
        // A settings file can lower the bar, never remove it: a wrong ghost is worse than no ghost.
        settings[@"confidenceThreshold"] = @(MIN(kMaxThreshold, MAX(kMinThreshold, threshold.doubleValue)));
    }
    NSString *server = raw[@"serverUrl"];
    if ([server isKindOfClass:[NSString class]] && GHIsPlainHTTPURL(server)) settings[@"serverUrl"] = server;
    // Which lone modifier tap accepts a ghost outside a form. Only the two Ghost knows: anything else in the
    // file leaves the default in place rather than turning the accept key off.
    NSString *acceptKey = raw[@"acceptKey"];
    if ([acceptKey isKindOfClass:[NSString class]] && ([acceptKey isEqualToString:@"right-option"] || [acceptKey isEqualToString:@"right-command"])) {
        settings[@"acceptKey"] = acceptKey;
    }
    NSMutableArray<NSString *> *paused = [NSMutableArray array];
    if ([raw[kPausedKey] isKindOfClass:[NSArray class]]) {
        for (id item in raw[kPausedKey]) {
            if ([item isKindOfClass:[NSString class]] && [item length] > 0 && [item length] < 200 && ![paused containsObject:item]) [paused addObject:item];
        }
    }
    settings[kPausedKey] = paused;
    return settings;
}

#pragma mark - store

@interface GHProfileStore ()
@property (atomic, readwrite, copy) NSDictionary<NSString *, id> *profile;
@property (atomic, readwrite, copy) NSDictionary<NSString *, id> *settings;
@property (atomic, readwrite, copy) NSDictionary<NSString *, id> *answers;
@end

@implementation GHProfileStore {
    GHCore *_core;
    NSDictionary *_defaultSettings;
    NSMutableArray<dispatch_source_t> *_sources;
    BOOL _watching;
    BOOL _reloadScheduled;
}

+ (NSString *)defaultDirectory {
    NSString *support = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES).firstObject;
    return [support ?: [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support"] stringByAppendingPathComponent:@"Ghost"];
}

- (instancetype)initWithCore:(GHCore *)core {
    return [self initWithDirectory:[GHProfileStore defaultDirectory] core:core];
}

- (instancetype)initWithDirectory:(NSString *)directory core:(GHCore *)core {
    if (!(self = [super init])) return nil;
    _core = core;
    _directory = [directory copy];
    _profilePath = [[directory stringByAppendingPathComponent:@"profile.json"] copy];
    _settingsPath = [[directory stringByAppendingPathComponent:@"settings.json"] copy];
    _answersPath = [[directory stringByAppendingPathComponent:@"answers.json"] copy];
    _sources = [NSMutableArray array];
    NSDictionary *coreDefaults = [core defaultSettings];
    _defaultSettings = coreDefaults.count ? GHCleanSettings(coreDefaults, GHFallbackSettings()) : GHCleanSettings(@{}, GHFallbackSettings());
    _profile = @{ @"facts": @{}, @"pastAnswers": @[] };
    _settings = _defaultSettings;
    _answers = GHEmptyAnswers();
    return self;
}

- (void)dealloc {
    [self stopWatching];
}

- (NSDictionary *)seedProfile {
    NSDictionary *demo = [_core demoProfile];
    return GHCleanProfile(demo ?: @{});
}

- (BOOL)prepare {
    NSFileManager *fm = NSFileManager.defaultManager;
    NSError *error;
    if (![fm createDirectoryAtPath:self.directory withIntermediateDirectories:YES attributes:@{ NSFilePosixPermissions: @0700 } error:&error]) {
        GHLog(@"store: cannot create the data directory (%@)", error.localizedDescription);
        self.profile = [self seedProfile];
        return NO;
    }
    if (![fm fileExistsAtPath:self.profilePath]) {
        GHWritePrivateFile(self.profilePath, GHPrettyJSON([self seedProfile]), NULL);
        GHLog(@"store: seeded profile.json with the fictional demo profile");
    }
    if (![fm fileExistsAtPath:self.settingsPath]) {
        GHWritePrivateFile(self.settingsPath, GHPrettyJSON(_defaultSettings), NULL);
    }
    // Whatever an editor or an older build left world-readable is tightened; the content is untouched.
    // answers.json is NOT seeded: an absent file is exactly "nothing learned yet".
    chmod(self.directory.fileSystemRepresentation, 0700);
    for (NSString *path in @[ self.profilePath, self.settingsPath, self.answersPath ]) chmod(path.fileSystemRepresentation, 0600);
    [self reloadNotifying:NO];
    return YES;
}

- (BOOL)reload {
    return [self reloadNotifying:YES];
}

- (BOOL)reloadNotifying:(BOOL)notify {
    BOOL changed = NO;
    NSDictionary *rawProfile = GHReadJSONDictionary(self.profilePath);
    if (rawProfile) {
        NSDictionary *clean = GHCleanProfile(rawProfile);
        if (![clean isEqualToDictionary:self.profile]) { self.profile = clean; changed = YES; }
    } else if ([NSFileManager.defaultManager fileExistsAtPath:self.profilePath]) {
        GHLog(@"store: profile.json is not valid JSON; keeping the previous profile");
    }
    NSDictionary *rawSettings = GHReadJSONDictionary(self.settingsPath);
    if (rawSettings) {
        NSDictionary *clean = GHCleanSettings(rawSettings, _defaultSettings);
        if (![clean isEqualToDictionary:self.settings]) { self.settings = clean; changed = YES; }
    } else if ([NSFileManager.defaultManager fileExistsAtPath:self.settingsPath]) {
        GHLog(@"store: settings.json is not valid JSON; keeping the previous settings");
    }
    // A corrupt or truncated answers.json is never fatal and never blocks a proposal: it reads as an empty
    // snapshot, and the next correction rewrites the file. The log says how many, never what.
    NSDictionary *cleanAnswers = GHCleanAnswers(GHReadJSONDictionary(self.answersPath));
    if (![cleanAnswers isEqualToDictionary:self.answers]) { self.answers = cleanAnswers; changed = YES; }
    if (changed && notify) {
        GHLog(@"store: reloaded (facts=%lu, enabled=%d)", (unsigned long)[self.profile[@"facts"] count], self.enabled);
        dispatch_async(dispatch_get_main_queue(), ^{
            [NSNotificationCenter.defaultCenter postNotificationName:GHProfileStoreDidChangeNotification object:self];
        });
    }
    return changed;
}

#pragma mark - learned answers

- (NSString *)answersJSON {
    NSDictionary *snapshot = self.answers;
    if ([snapshot[@"answers"] count] == 0) return @"";
    NSData *data = [NSJSONSerialization isValidJSONObject:snapshot]
        ? [NSJSONSerialization dataWithJSONObject:snapshot options:0 error:NULL] : nil;
    return data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"" : @"";
}

- (BOOL)saveAnswers:(NSDictionary<NSString *, id> *)answers error:(NSError **)error {
    NSDictionary *clean = GHCleanAnswers(answers);
    // In memory first: a disk that refuses the write must not lose what the user just taught Ghost.
    self.answers = clean;
    NSData *data = GHPrettyJSON(clean);
    if (!data) {
        if (error) *error = [NSError errorWithDomain:NSCocoaErrorDomain code:NSPropertyListWriteInvalidError userInfo:nil];
        return NO;
    }
    BOOL ok = GHWritePrivateFile(self.answersPath, data, error);
    // Counts only: never a question, never an answer.
    GHLog(@"store: answers.json %@ (%lu learned)", ok ? @"written" : @"could NOT be written", (unsigned long)[clean[@"answers"] count]);
    return ok;
}

- (BOOL)forgetAllAnswers {
    return [self saveAnswers:GHEmptyAnswers() error:NULL];
}

#pragma mark - reads

- (NSArray<NSString *> *)usableFactKeys {
    NSDictionary<NSString *, NSString *> *facts = self.profile[@"facts"];
    NSMutableArray<NSString *> *keys = [NSMutableArray array];
    for (NSString *key in [facts.allKeys sortedArrayUsingSelector:@selector(compare:)]) {
        if ([facts[key] length] == 0) continue;
        // A fact named like a secret ("ssn", "cardNumber") is never offered, whatever the file says.
        if (_core ? [_core isSensitive:@{ @"name": key }] : NO) continue;
        [keys addObject:key];
    }
    return keys;
}

- (BOOL)enabled { return [self.settings[@"enabled"] boolValue]; }
- (double)confidenceThreshold { return [self.settings[@"confidenceThreshold"] doubleValue]; }
- (NSString *)serverURLString { return self.settings[@"serverUrl"]; }
- (BOOL)showHud { return [self.settings[@"showHud"] boolValue]; }

#pragma mark - writes

- (BOOL)saveProfile:(NSDictionary<NSString *, id> *)profile error:(NSError **)error {
    NSDictionary *clean = GHCleanProfile(profile ?: @{});
    NSData *data = GHPrettyJSON(clean);
    if (!data || ![self ensureDirectory] || !GHWritePrivateFile(self.profilePath, data, error)) return NO;
    [self reloadNotifying:YES];
    return YES;
}

- (BOOL)updateSettings:(NSDictionary<NSString *, id> *)patch error:(NSError **)error {
    // Start from the file so keys this build does not know survive, then lay the validated view on top.
    NSMutableDictionary *onDisk = [GHReadJSONDictionary(self.settingsPath) ?: @{} mutableCopy];
    [onDisk addEntriesFromDictionary:patch ?: @{}];
    [onDisk addEntriesFromDictionary:GHCleanSettings(onDisk, _defaultSettings)];
    NSData *data = GHPrettyJSON(onDisk);
    if (!data || ![self ensureDirectory] || !GHWritePrivateFile(self.settingsPath, data, error)) return NO;
    [self reloadNotifying:YES];
    return YES;
}

- (BOOL)ensureDirectory {
    return [NSFileManager.defaultManager createDirectoryAtPath:self.directory withIntermediateDirectories:YES attributes:@{ NSFilePosixPermissions: @0700 } error:NULL];
}

- (BOOL)setEnabled:(BOOL)enabled {
    return [self updateSettings:@{ @"enabled": @(enabled) } error:NULL];
}

- (BOOL)resetToDemoProfile {
    return [self saveProfile:[self seedProfile] error:NULL];
}

#pragma mark - pause list

+ (NSArray<NSString *> *)defaultPausedBundleIds {
    return @[
        // Ghost itself
        @"dev.ghost.desktop",
        // terminals
        @"com.apple.Terminal", @"com.googlecode.iterm2", @"dev.warp.Warp-Stable", @"net.kovidgoyal.kitty",
        @"com.github.wez.wezterm", @"io.alacritty", @"org.alacritty", @"co.zeit.hyper", @"com.mitchellh.ghostty",
        // secrets and system
        @"com.apple.keychainaccess", @"com.apple.Passwords", @"com.apple.systempreferences", @"com.apple.SecurityAgent",
        @"com.apple.loginwindow", @"com.apple.LocalAuthentication.UIAgent",
        // password managers (prefixes are matched too, see isBuiltInPausedBundleId:)
        @"com.1password.1password", @"com.agilebits.onepassword7", @"com.bitwarden.desktop", @"com.lastpass.LastPass",
        @"com.dashlane.Dashlane", @"org.keepassxc.keepassxc", @"com.nordpass.macos.app", @"me.proton.pass.electron",
        @"in.sinew.Enpass-Desktop",
    ];
}

- (BOOL)isBuiltInPausedBundleId:(NSString *)bundleId {
    if (bundleId.length == 0) return YES;
    NSString *lower = bundleId.lowercaseString;
    for (NSString *builtIn in [GHProfileStore defaultPausedBundleIds]) {
        if ([lower isEqualToString:builtIn.lowercaseString]) return YES;
    }
    for (NSString *prefix in @[ @"com.1password.", @"com.agilebits.", @"com.bitwarden.", @"com.lastpass.", @"com.dashlane." ]) {
        if ([lower hasPrefix:prefix]) return YES;
    }
    return NO;
}

- (NSArray<NSString *> *)userPausedBundleIds {
    return self.settings[kPausedKey] ?: @[];
}

- (BOOL)isPausedBundleId:(NSString *)bundleId {
    if ([self isBuiltInPausedBundleId:bundleId]) return YES;
    return [[self userPausedBundleIds] containsObject:bundleId];
}

- (BOOL)setPaused:(BOOL)paused forBundleId:(NSString *)bundleId {
    if (bundleId.length == 0) return NO;
    NSMutableArray<NSString *> *list = [[self userPausedBundleIds] mutableCopy];
    if (paused && ![list containsObject:bundleId]) [list addObject:bundleId];
    if (!paused) [list removeObject:bundleId];
    return [self updateSettings:@{ kPausedKey: list } error:NULL];
}

#pragma mark - watching

- (void)startWatching {
    if (_watching) return;
    _watching = YES;
    [self armSources];
}

- (void)stopWatching {
    _watching = NO;
    for (dispatch_source_t source in _sources) dispatch_source_cancel(source);
    [_sources removeAllObjects];
}

/// The directory catches editors that save by rename; the files catch editors that write in place.
/// File descriptors go stale when a file is replaced, so everything is re-armed after each reload.
- (void)armSources {
    for (dispatch_source_t source in _sources) dispatch_source_cancel(source);
    [_sources removeAllObjects];
    for (NSString *path in @[ self.directory, self.profilePath, self.settingsPath ]) {
        int fd = open(path.fileSystemRepresentation, O_EVTONLY);
        if (fd < 0) continue;
        unsigned long mask = DISPATCH_VNODE_WRITE | DISPATCH_VNODE_EXTEND | DISPATCH_VNODE_RENAME | DISPATCH_VNODE_DELETE | DISPATCH_VNODE_ATTRIB;
        dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_VNODE, (uintptr_t)fd, mask, dispatch_get_main_queue());
        __weak GHProfileStore *weakSelf = self;
        dispatch_source_set_event_handler(source, ^{ [weakSelf scheduleReload]; });
        dispatch_source_set_cancel_handler(source, ^{ close(fd); });
        dispatch_resume(source);
        [_sources addObject:source];
    }
}

- (void)scheduleReload {
    if (_reloadScheduled || !_watching) return;
    _reloadScheduled = YES;
    __weak GHProfileStore *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.2 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        GHProfileStore *store = weakSelf;
        if (!store) return;
        store->_reloadScheduled = NO;
        if (!store->_watching) return;
        [store reload];
        [store armSources];
    });
}

@end
