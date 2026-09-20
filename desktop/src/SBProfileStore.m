#import "SBProfileStore.h"
#import "SBCore.h"
#import "SBLog.h"
#import "SBOpenPanelDriver.h"
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

NSNotificationName const SBProfileStoreDidChangeNotification = @"SBProfileStoreDidChangeNotification";

static NSString *const kPausedKey = @"pausedBundleIds";
static const double kMinThreshold = 0.5;
static const double kMaxThreshold = 0.99;

#pragma mark - file helpers

/// A crash mid-write cannot leave half a profile behind: the rename is the commit.
BOOL SBWritePrivateFile(NSString *path, NSData *data, NSError **error) {
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

static NSData *SBPrettyJSON(NSDictionary *object) {
    if (![NSJSONSerialization isValidJSONObject:object]) return nil;
    NSJSONWritingOptions options = NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys | NSJSONWritingWithoutEscapingSlashes;
    NSMutableData *data = [[NSJSONSerialization dataWithJSONObject:object options:options error:NULL] mutableCopy];
    [data appendBytes:"\n" length:1];
    return data;
}

static NSDictionary *SBReadJSONDictionary(NSString *path) {
    NSData *data = [NSData dataWithContentsOfFile:path];
    if (!data) return nil;
    id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
    return [parsed isKindOfClass:[NSDictionary class]] ? parsed : nil;
}

#pragma mark - learned answers

/// The cap of shared/src/answers/store.ts (MAX_LEARNED_ANSWERS). A file that claims more is trimmed.
static const NSUInteger kMaxLearnedAnswers = 500;

static NSDictionary *SBEmptyAnswers(void) {
    return @{ @"max": @(kMaxLearnedAnswers), @"answers": @[] };
}

/// One learned answer, checked exactly as shared/src/answers/store.ts `isLearnedAnswer` does: anything that is
/// not the right shape is dropped rather than handed to the core. Values are never inspected or logged.
static BOOL SBIsLearnedAnswer(id entry) {
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
/// "nothing learned yet": a broken file must never stop Shabang from proposing an answer (docs/answers.md 1).
static NSDictionary *SBCleanAnswers(NSDictionary *raw) {
    if (![raw isKindOfClass:[NSDictionary class]]) return SBEmptyAnswers();
    NSMutableArray *answers = [NSMutableArray array];
    NSArray *entries = [raw[@"answers"] isKindOfClass:[NSArray class]] ? raw[@"answers"] : @[];
    for (id entry in entries) if (SBIsLearnedAnswer(entry)) [answers addObject:entry];
    if (answers.count > kMaxLearnedAnswers) [answers removeObjectsInRange:NSMakeRange(0, answers.count - kMaxLearnedAnswers)];
    NSNumber *max = [raw[@"max"] isKindOfClass:[NSNumber class]] ? raw[@"max"] : nil;
    NSUInteger cap = max && max.doubleValue >= 1 ? (NSUInteger)MIN((double)kMaxLearnedAnswers, max.doubleValue) : kMaxLearnedAnswers;
    return @{ @"max": @(cap), @"answers": answers };
}

#pragma mark - validation

NSString *const SBProfileResumePathKey = @"resumePath";
NSString *const SBProfileCoverLetterPathKey = @"coverLetterPath";

static BOOL SBIsFilePathFact(NSString *key) {
    return [key isEqualToString:SBProfileResumePathKey] || [key isEqualToString:SBProfileCoverLetterPathKey];
}

NSString *SBUsableProfileFilePath(NSString *raw, NSString **problem) {
    NSString *reason = nil;
    NSString *path = nil;
    if (![raw isKindOfClass:[NSString class]] || raw.length == 0) reason = SBUploadPathEmpty;
    else {
        // A control character anywhere (even a trailing newline) would be a key press in the open panel.
        NSCharacterSet *control = NSCharacterSet.controlCharacterSet;
        if ([raw rangeOfCharacterFromSet:control].location != NSNotFound) reason = SBUploadPathControlCharacter;
        path = [raw stringByTrimmingCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@" "]];
        if ([path hasPrefix:@"~/"]) path = [NSHomeDirectory() stringByAppendingPathComponent:[path substringFromIndex:2]];
        if (!reason && [path.pathComponents containsObject:@".."]) reason = @"dot-dot";
        NSSet<NSString *> *documents = [NSSet setWithArray:@[ @"pdf", @"doc", @"docx", @"rtf", @"txt", @"odt", @"pages" ]];
        if (!reason && ![path hasPrefix:@"/"]) reason = SBUploadPathNotAbsolute;
        if (!reason && ![documents containsObject:path.pathExtension.lowercaseString]) reason = @"not-a-document";
        if (!reason) reason = [SBOpenPanelDriver problemWithUploadPath:path];
    }
    if (problem) *problem = reason;
    return reason ? nil : path;
}

static NSDictionary *SBCleanProfile(NSDictionary *raw) {
    NSMutableDictionary<NSString *, NSString *> *facts = [NSMutableDictionary dictionary];
    NSDictionary *rawFacts = raw[@"facts"];
    if ([rawFacts isKindOfClass:[NSDictionary class]]) {
        [rawFacts enumerateKeysAndObjectsUsingBlock:^(id key, id value, BOOL *stop) {
            if (![key isKindOfClass:[NSString class]] || ![value isKindOfClass:[NSString class]]) return;
            if (!SBIsFilePathFact(key)) { facts[key] = value; return; }
            if ([(NSString *)value length] == 0) return;
            // File facts: an absolute path to a readable document ("~/" is expanded), or nothing at all. Only the
            // file name is ever logged.
            NSString *problem = nil;
            NSString *path = SBUsableProfileFilePath(value, &problem);
            if (path) facts[key] = path;
            else SBLog(@"store: %@ ignored (%@)", key, problem ?: @"invalid");
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

static NSDictionary *SBFallbackSettings(void) {
    // Same values as DEFAULT_SETTINGS in shared/src/types.ts, for the case where the core did not load.
    return @{ @"enabled": @YES, @"confidenceThreshold": @0.7, @"serverUrl": @"http://localhost:8787", @"showHud": @NO,
              @"learningEnabled": @NO, @"answerProtectedWithDecline": @YES, @"acceptKey": @"right-command" };
}

static BOOL SBIsPlainHTTPURL(NSString *string) {
    NSURLComponents *parts = [NSURLComponents componentsWithString:string];
    if (!parts.host.length || parts.user || parts.password) return NO;
    return [parts.scheme isEqualToString:@"http"] || [parts.scheme isEqualToString:@"https"];
}

static NSDictionary *SBCleanSettings(NSDictionary *raw, NSDictionary *defaults) {
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
    if ([server isKindOfClass:[NSString class]] && SBIsPlainHTTPURL(server)) settings[@"serverUrl"] = server;
    // Which lone modifier tap accepts a ghost outside a form. Only the two Shabang knows: anything else in the
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

@interface SBProfileStore ()
@property (atomic, readwrite, copy) NSDictionary<NSString *, id> *profile;
@property (atomic, readwrite, copy) NSDictionary<NSString *, id> *settings;
@property (atomic, readwrite, copy) NSDictionary<NSString *, id> *answers;
@end

@implementation SBProfileStore {
    SBCore *_core;
    NSDictionary *_defaultSettings;
    NSMutableArray<dispatch_source_t> *_sources;
    BOOL _watching;
    BOOL _reloadScheduled;
}

+ (NSString *)defaultDirectory {
    NSString *support = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES).firstObject;
    return [support ?: [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support"] stringByAppendingPathComponent:@"Shabang"];
}

- (instancetype)initWithCore:(SBCore *)core {
    return [self initWithDirectory:[SBProfileStore defaultDirectory] core:core];
}

- (instancetype)initWithDirectory:(NSString *)directory core:(SBCore *)core {
    if (!(self = [super init])) return nil;
    _core = core;
    _directory = [directory copy];
    _profilePath = [[directory stringByAppendingPathComponent:@"profile.json"] copy];
    _settingsPath = [[directory stringByAppendingPathComponent:@"settings.json"] copy];
    _answersPath = [[directory stringByAppendingPathComponent:@"answers.json"] copy];
    _sources = [NSMutableArray array];
    NSDictionary *coreDefaults = [core defaultSettings];
    _defaultSettings = coreDefaults.count ? SBCleanSettings(coreDefaults, SBFallbackSettings()) : SBCleanSettings(@{}, SBFallbackSettings());
    _profile = @{ @"facts": @{}, @"pastAnswers": @[] };
    _settings = _defaultSettings;
    _answers = SBEmptyAnswers();
    return self;
}

- (void)dealloc {
    [self stopWatching];
}

- (NSDictionary *)seedProfile {
    NSDictionary *demo = [_core demoProfile];
    return SBCleanProfile(demo ?: @{});
}

- (BOOL)prepare {
    NSFileManager *fm = NSFileManager.defaultManager;
    NSError *error;
    if (![fm createDirectoryAtPath:self.directory withIntermediateDirectories:YES attributes:@{ NSFilePosixPermissions: @0700 } error:&error]) {
        SBLog(@"store: cannot create the data directory (%@)", error.localizedDescription);
        self.profile = [self seedProfile];
        return NO;
    }
    if (![fm fileExistsAtPath:self.profilePath]) {
        SBWritePrivateFile(self.profilePath, SBPrettyJSON([self seedProfile]), NULL);
        SBLog(@"store: seeded profile.json with the fictional demo profile");
    }
    if (![fm fileExistsAtPath:self.settingsPath]) {
        SBWritePrivateFile(self.settingsPath, SBPrettyJSON(_defaultSettings), NULL);
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
    NSDictionary *rawProfile = SBReadJSONDictionary(self.profilePath);
    if (rawProfile) {
        NSDictionary *clean = SBCleanProfile(rawProfile);
        if (![clean isEqualToDictionary:self.profile]) { self.profile = clean; changed = YES; }
    } else if ([NSFileManager.defaultManager fileExistsAtPath:self.profilePath]) {
        SBLog(@"store: profile.json is not valid JSON; keeping the previous profile");
    }
    NSDictionary *rawSettings = SBReadJSONDictionary(self.settingsPath);
    if (rawSettings) {
        NSDictionary *clean = SBCleanSettings(rawSettings, _defaultSettings);
        if (![clean isEqualToDictionary:self.settings]) { self.settings = clean; changed = YES; }
    } else if ([NSFileManager.defaultManager fileExistsAtPath:self.settingsPath]) {
        SBLog(@"store: settings.json is not valid JSON; keeping the previous settings");
    }
    // A corrupt or truncated answers.json is never fatal and never blocks a proposal: it reads as an empty
    // snapshot, and the next correction rewrites the file. The log says how many, never what.
    NSDictionary *cleanAnswers = SBCleanAnswers(SBReadJSONDictionary(self.answersPath));
    if (![cleanAnswers isEqualToDictionary:self.answers]) { self.answers = cleanAnswers; changed = YES; }
    if (changed && notify) {
        SBLog(@"store: reloaded (facts=%lu, enabled=%d)", (unsigned long)[self.profile[@"facts"] count], self.enabled);
        dispatch_async(dispatch_get_main_queue(), ^{
            [NSNotificationCenter.defaultCenter postNotificationName:SBProfileStoreDidChangeNotification object:self];
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
    NSDictionary *clean = SBCleanAnswers(answers);
    // In memory first: a disk that refuses the write must not lose what the user just taught Shabang.
    self.answers = clean;
    NSData *data = SBPrettyJSON(clean);
    if (!data) {
        if (error) *error = [NSError errorWithDomain:NSCocoaErrorDomain code:NSPropertyListWriteInvalidError userInfo:nil];
        return NO;
    }
    BOOL ok = SBWritePrivateFile(self.answersPath, data, error);
    // Counts only: never a question, never an answer.
    SBLog(@"store: answers.json %@ (%lu learned)", ok ? @"written" : @"could NOT be written", (unsigned long)[clean[@"answers"] count]);
    return ok;
}

- (BOOL)forgetAllAnswers {
    return [self saveAnswers:SBEmptyAnswers() error:NULL];
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
    NSDictionary *clean = SBCleanProfile(profile ?: @{});
    NSData *data = SBPrettyJSON(clean);
    if (!data || ![self ensureDirectory] || !SBWritePrivateFile(self.profilePath, data, error)) return NO;
    [self reloadNotifying:YES];
    return YES;
}

- (BOOL)updateSettings:(NSDictionary<NSString *, id> *)patch error:(NSError **)error {
    // Start from the file so keys this build does not know survive, then lay the validated view on top.
    NSMutableDictionary *onDisk = [SBReadJSONDictionary(self.settingsPath) ?: @{} mutableCopy];
    [onDisk addEntriesFromDictionary:patch ?: @{}];
    [onDisk addEntriesFromDictionary:SBCleanSettings(onDisk, _defaultSettings)];
    NSData *data = SBPrettyJSON(onDisk);
    if (!data || ![self ensureDirectory] || !SBWritePrivateFile(self.settingsPath, data, error)) return NO;
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
        // Shabang itself
        @"dev.shabang.desktop",
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
    for (NSString *builtIn in [SBProfileStore defaultPausedBundleIds]) {
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
        __weak SBProfileStore *weakSelf = self;
        dispatch_source_set_event_handler(source, ^{ [weakSelf scheduleReload]; });
        dispatch_source_set_cancel_handler(source, ^{ close(fd); });
        dispatch_resume(source);
        [_sources addObject:source];
    }
}

- (void)scheduleReload {
    if (_reloadScheduled || !_watching) return;
    _reloadScheduled = YES;
    __weak SBProfileStore *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.2 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        SBProfileStore *store = weakSelf;
        if (!store) return;
        store->_reloadScheduled = NO;
        if (!store->_watching) return;
        [store reload];
        [store armSources];
    });
}

@end
