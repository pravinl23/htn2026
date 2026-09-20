#import "SBField.h"

NSString *const SBKindText = @"text";
NSString *const SBKindEmail = @"email";
NSString *const SBKindTel = @"tel";
NSString *const SBKindURL = @"url";
NSString *const SBKindNumber = @"number";
NSString *const SBKindDate = @"date";
NSString *const SBKindMonth = @"month";
NSString *const SBKindTextArea = @"textarea";
NSString *const SBKindSelect = @"select";
NSString *const SBKindRadio = @"radio";
NSString *const SBKindCheckbox = @"checkbox";
NSString *const SBKindFile = @"file";
NSString *const SBKindButton = @"button";
NSString *const SBKindLink = @"link";
NSString *const SBKindItem = @"item";
NSString *const SBKindOther = @"other";

NSString *const SBUploadKindResume = @"resume";
NSString *const SBUploadKindCoverLetter = @"coverLetter";
NSString *const SBUploadKindOther = @"other";

@implementation SBField {
    AXUIElementRef _axElement;
}

- (instancetype)init {
    if ((self = [super init])) {
        _signature = @"";
        _label = @"";
        _kind = SBKindText;
        _rect = CGRectZero;
    }
    return self;
}

+ (instancetype)fieldWithSignature:(NSString *)signature label:(NSString *)label kind:(NSString *)kind {
    SBField *field = [[self alloc] init];
    field.signature = signature;
    field.label = label;
    field.kind = kind;
    return field;
}

- (void)dealloc {
    if (_axElement) CFRelease(_axElement);
}

- (AXUIElementRef)axElement {
    return _axElement;
}

- (void)setAxElement:(AXUIElementRef)axElement {
    if (axElement == _axElement) return;
    if (axElement) CFRetain(axElement);
    if (_axElement) CFRelease(_axElement);
    _axElement = axElement;
}

- (id)copyWithZone:(NSZone *)zone {
    SBField *copy = [[[self class] allocWithZone:zone] init];
    copy.signature = self.signature;
    copy.label = self.label;
    copy.kind = self.kind;
    copy.focused = self.focused;
    copy.inputType = self.inputType;
    copy.name = self.name;
    copy.identifier = self.identifier;
    copy.placeholder = self.placeholder;
    copy.options = self.options;
    copy.required = self.required;
    copy.value = self.value;
    copy.rect = self.rect;
    copy.locked = self.locked;
    copy.context = self.context;
    copy.uploadKind = self.uploadKind;
    copy.lazyOptions = self.lazyOptions;
    copy.unnamed = self.unnamed;
    copy.axDescription = self.axDescription;
    copy.classTokens = self.classTokens;
    copy.insideMediaControls = self.insideMediaControls;
    copy.listSignature = self.listSignature;
    copy.listIndex = self.listIndex;
    copy.nearbyPrice = self.nearbyPrice;
    copy.badgeCount = self.badgeCount;
    copy.unread = self.unread;
    copy.axElement = self.axElement;
    return copy;
}

static NSNumber *SBFiniteNumber(CGFloat value) {
    // NSJSONSerialization throws on NaN and infinity; a broken AX rect must not take the app down.
    return isfinite(value) ? @(value) : @0;
}

- (NSDictionary<NSString *, id> *)JSONObjectIncludingValue:(BOOL)includeValue {
    NSMutableDictionary<NSString *, id> *json = [NSMutableDictionary dictionary];
    json[@"signature"] = self.signature ?: @"";
    json[@"label"] = self.label ?: @"";
    json[@"kind"] = self.kind ?: SBKindText;
    if (self.inputType.length) json[@"inputType"] = self.inputType;
    if (self.name.length) json[@"name"] = self.name;
    if (self.identifier.length) json[@"id"] = self.identifier;
    if (self.placeholder.length) json[@"placeholder"] = self.placeholder;
    if (self.options) {
        NSMutableArray *options = [NSMutableArray arrayWithCapacity:self.options.count];
        for (NSDictionary *option in self.options) {
            if (![option isKindOfClass:[NSDictionary class]]) continue;
            id value = option[@"value"], label = option[@"label"];
            [options addObject:@{
                @"value": [value isKindOfClass:[NSString class]] ? value : @"",
                @"label": [label isKindOfClass:[NSString class]] ? label : @"",
            }];
        }
        json[@"options"] = options;
    }
    if (self.required) json[@"required"] = @YES;
    if (includeValue && self.value) json[@"value"] = self.value;
    json[@"rect"] = @{
        @"x": SBFiniteNumber(self.rect.origin.x),
        @"y": SBFiniteNumber(self.rect.origin.y),
        @"width": SBFiniteNumber(self.rect.size.width),
        @"height": SBFiniteNumber(self.rect.size.height),
    };
    if (self.locked) json[@"locked"] = @YES;
    if (self.context.length) json[@"context"] = self.context;
    if (self.uploadKind.length) json[@"uploadKind"] = self.uploadKind;
    if (self.lazyOptions) json[@"lazyOptions"] = @YES;
    return json;
}

- (NSDictionary<NSString *, id> *)toJSONObject {
    return [self JSONObjectIncludingValue:YES];
}

- (NSDictionary<NSString *, id> *)toWireJSONObject {
    return [self JSONObjectIncludingValue:NO];
}

/// `AffordanceCandidate` (shared/src/affordance/roles.ts) for the in-process core: what this control OFFERS.
/// Deliberately NOT the CapturedField shape -- no value, no options, no rect -- and deliberately not sent
/// anywhere: it stays inside the process, like every other hint in docs/anywhere.md.
- (NSDictionary<NSString *, id> *)toCandidateJSONObject {
    NSString *kind = self.kind ?: SBKindText;
    NSMutableDictionary<NSString *, id> *json = [NSMutableDictionary dictionary];
    json[@"id"] = self.signature ?: @"";
    // AffordanceCandidate knows three kinds. A list entry is a thing you press, so it travels as a button and
    // says what it really is in `ariaRole`, which is what turns it into `primary-item` on the other side.
    BOOL item = [kind isEqualToString:SBKindItem];
    json[@"kind"] = (item || [kind isEqualToString:SBKindButton]) ? SBKindButton : ([kind isEqualToString:SBKindLink] ? kind : @"field");
    json[@"label"] = self.label ?: @"";
    json[@"locked"] = @(self.locked);
    if (item) json[@"ariaRole"] = @"listitem";
    if (self.focused) json[@"focused"] = @YES;
    if (self.unread) json[@"unread"] = @YES;
    if (self.context.length) json[@"context"] = self.context;
    if (self.axDescription.length) json[@"description"] = self.axDescription;
    if (self.inputType.length) json[@"inputType"] = self.inputType;
    if (self.placeholder.length) json[@"placeholder"] = self.placeholder;
    if (self.name.length) json[@"name"] = self.name;
    if (self.identifier.length) json[@"identifier"] = self.identifier;
    if (self.classTokens.count) json[@"classTokens"] = self.classTokens;
    if (self.insideMediaControls) json[@"insideMediaControls"] = @YES;
    if (self.nearbyPrice) json[@"nearbyPrice"] = @YES;
    if (self.namesDuration) json[@"namesDuration"] = @YES;
    if (self.badgeCount > 0) json[@"badgeCount"] = @(self.badgeCount);
    if (self.listSignature.length) json[@"list"] = @{ @"listSignature": self.listSignature, @"index": @(self.listIndex) };
    return json;
}

+ (NSArray<NSDictionary<NSString *, id> *> *)candidateJSONObjectsForFields:(NSArray<SBField *> *)fields {
    NSMutableArray *out = [NSMutableArray arrayWithCapacity:fields.count];
    for (SBField *field in fields) [out addObject:[field toCandidateJSONObject]];
    return out;
}

static NSString *SBStringOrNil(id value) {
    return [value isKindOfClass:[NSString class]] ? value : nil;
}

static CGFloat SBNumber(id value) {
    return [value isKindOfClass:[NSNumber class]] ? (CGFloat)[value doubleValue] : 0;
}

+ (instancetype)fieldFromJSONObject:(NSDictionary<NSString *, id> *)json {
    if (![json isKindOfClass:[NSDictionary class]]) return nil;
    NSString *signature = SBStringOrNil(json[@"signature"]);
    if (signature.length == 0) return nil;
    SBField *field = [self fieldWithSignature:signature
                                        label:SBStringOrNil(json[@"label"]) ?: @""
                                         kind:SBStringOrNil(json[@"kind"]) ?: SBKindText];
    field.inputType = SBStringOrNil(json[@"inputType"]);
    field.name = SBStringOrNil(json[@"name"]);
    field.identifier = SBStringOrNil(json[@"id"]);
    field.placeholder = SBStringOrNil(json[@"placeholder"]);
    field.value = SBStringOrNil(json[@"value"]);
    field.context = SBStringOrNil(json[@"context"]);
    field.uploadKind = SBStringOrNil(json[@"uploadKind"]);
    field.lazyOptions = [json[@"lazyOptions"] isKindOfClass:[NSNumber class]] && [json[@"lazyOptions"] boolValue];
    field.required = [json[@"required"] isKindOfClass:[NSNumber class]] && [json[@"required"] boolValue];
    field.locked = [json[@"locked"] isKindOfClass:[NSNumber class]] && [json[@"locked"] boolValue];
    NSArray *options = json[@"options"];
    if ([options isKindOfClass:[NSArray class]]) {
        NSMutableArray *clean = [NSMutableArray array];
        for (NSDictionary *option in options) {
            if (![option isKindOfClass:[NSDictionary class]]) continue;
            [clean addObject:@{ @"value": SBStringOrNil(option[@"value"]) ?: @"", @"label": SBStringOrNil(option[@"label"]) ?: @"" }];
        }
        field.options = clean;
    }
    NSDictionary *rect = json[@"rect"];
    if ([rect isKindOfClass:[NSDictionary class]]) {
        field.rect = CGRectMake(SBNumber(rect[@"x"]), SBNumber(rect[@"y"]), SBNumber(rect[@"width"]), SBNumber(rect[@"height"]));
    }
    return field;
}

+ (NSArray<NSDictionary<NSString *, id> *> *)JSONObjectsForFields:(NSArray<SBField *> *)fields {
    NSMutableArray *out = [NSMutableArray arrayWithCapacity:fields.count];
    for (SBField *field in fields) [out addObject:[field toJSONObject]];
    return out;
}

+ (NSArray<NSDictionary<NSString *, id> *> *)wireJSONObjectsForFields:(NSArray<SBField *> *)fields {
    NSMutableArray *out = [NSMutableArray arrayWithCapacity:fields.count];
    for (SBField *field in fields) [out addObject:[field toWireJSONObject]];
    return out;
}

- (NSString *)description {
    // Never the value: descriptions end up in logs.
    return [NSString stringWithFormat:@"<SBField %@ kind=%@ locked=%d>", self.signature, self.kind, self.locked];
}

@end
