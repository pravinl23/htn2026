#import "GHField.h"

NSString *const GHKindText = @"text";
NSString *const GHKindEmail = @"email";
NSString *const GHKindTel = @"tel";
NSString *const GHKindURL = @"url";
NSString *const GHKindNumber = @"number";
NSString *const GHKindDate = @"date";
NSString *const GHKindMonth = @"month";
NSString *const GHKindTextArea = @"textarea";
NSString *const GHKindSelect = @"select";
NSString *const GHKindRadio = @"radio";
NSString *const GHKindCheckbox = @"checkbox";
NSString *const GHKindFile = @"file";
NSString *const GHKindButton = @"button";
NSString *const GHKindLink = @"link";
NSString *const GHKindItem = @"item";
NSString *const GHKindOther = @"other";

NSString *const GHUploadKindResume = @"resume";
NSString *const GHUploadKindCoverLetter = @"coverLetter";
NSString *const GHUploadKindOther = @"other";

@implementation GHField {
    AXUIElementRef _axElement;
}

- (instancetype)init {
    if ((self = [super init])) {
        _signature = @"";
        _label = @"";
        _kind = GHKindText;
        _rect = CGRectZero;
    }
    return self;
}

+ (instancetype)fieldWithSignature:(NSString *)signature label:(NSString *)label kind:(NSString *)kind {
    GHField *field = [[self alloc] init];
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
    GHField *copy = [[[self class] allocWithZone:zone] init];
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

static NSNumber *GHFiniteNumber(CGFloat value) {
    // NSJSONSerialization throws on NaN and infinity; a broken AX rect must not take the app down.
    return isfinite(value) ? @(value) : @0;
}

- (NSDictionary<NSString *, id> *)JSONObjectIncludingValue:(BOOL)includeValue {
    NSMutableDictionary<NSString *, id> *json = [NSMutableDictionary dictionary];
    json[@"signature"] = self.signature ?: @"";
    json[@"label"] = self.label ?: @"";
    json[@"kind"] = self.kind ?: GHKindText;
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
        @"x": GHFiniteNumber(self.rect.origin.x),
        @"y": GHFiniteNumber(self.rect.origin.y),
        @"width": GHFiniteNumber(self.rect.size.width),
        @"height": GHFiniteNumber(self.rect.size.height),
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
    NSString *kind = self.kind ?: GHKindText;
    NSMutableDictionary<NSString *, id> *json = [NSMutableDictionary dictionary];
    json[@"id"] = self.signature ?: @"";
    // AffordanceCandidate knows three kinds. A list entry is a thing you press, so it travels as a button and
    // says what it really is in `ariaRole`, which is what turns it into `primary-item` on the other side.
    BOOL item = [kind isEqualToString:GHKindItem];
    json[@"kind"] = (item || [kind isEqualToString:GHKindButton]) ? GHKindButton : ([kind isEqualToString:GHKindLink] ? kind : @"field");
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

+ (NSArray<NSDictionary<NSString *, id> *> *)candidateJSONObjectsForFields:(NSArray<GHField *> *)fields {
    NSMutableArray *out = [NSMutableArray arrayWithCapacity:fields.count];
    for (GHField *field in fields) [out addObject:[field toCandidateJSONObject]];
    return out;
}

static NSString *GHStringOrNil(id value) {
    return [value isKindOfClass:[NSString class]] ? value : nil;
}

static CGFloat GHNumber(id value) {
    return [value isKindOfClass:[NSNumber class]] ? (CGFloat)[value doubleValue] : 0;
}

+ (instancetype)fieldFromJSONObject:(NSDictionary<NSString *, id> *)json {
    if (![json isKindOfClass:[NSDictionary class]]) return nil;
    NSString *signature = GHStringOrNil(json[@"signature"]);
    if (signature.length == 0) return nil;
    GHField *field = [self fieldWithSignature:signature
                                        label:GHStringOrNil(json[@"label"]) ?: @""
                                         kind:GHStringOrNil(json[@"kind"]) ?: GHKindText];
    field.inputType = GHStringOrNil(json[@"inputType"]);
    field.name = GHStringOrNil(json[@"name"]);
    field.identifier = GHStringOrNil(json[@"id"]);
    field.placeholder = GHStringOrNil(json[@"placeholder"]);
    field.value = GHStringOrNil(json[@"value"]);
    field.context = GHStringOrNil(json[@"context"]);
    field.uploadKind = GHStringOrNil(json[@"uploadKind"]);
    field.lazyOptions = [json[@"lazyOptions"] isKindOfClass:[NSNumber class]] && [json[@"lazyOptions"] boolValue];
    field.required = [json[@"required"] isKindOfClass:[NSNumber class]] && [json[@"required"] boolValue];
    field.locked = [json[@"locked"] isKindOfClass:[NSNumber class]] && [json[@"locked"] boolValue];
    NSArray *options = json[@"options"];
    if ([options isKindOfClass:[NSArray class]]) {
        NSMutableArray *clean = [NSMutableArray array];
        for (NSDictionary *option in options) {
            if (![option isKindOfClass:[NSDictionary class]]) continue;
            [clean addObject:@{ @"value": GHStringOrNil(option[@"value"]) ?: @"", @"label": GHStringOrNil(option[@"label"]) ?: @"" }];
        }
        field.options = clean;
    }
    NSDictionary *rect = json[@"rect"];
    if ([rect isKindOfClass:[NSDictionary class]]) {
        field.rect = CGRectMake(GHNumber(rect[@"x"]), GHNumber(rect[@"y"]), GHNumber(rect[@"width"]), GHNumber(rect[@"height"]));
    }
    return field;
}

+ (NSArray<NSDictionary<NSString *, id> *> *)JSONObjectsForFields:(NSArray<GHField *> *)fields {
    NSMutableArray *out = [NSMutableArray arrayWithCapacity:fields.count];
    for (GHField *field in fields) [out addObject:[field toJSONObject]];
    return out;
}

+ (NSArray<NSDictionary<NSString *, id> *> *)wireJSONObjectsForFields:(NSArray<GHField *> *)fields {
    NSMutableArray *out = [NSMutableArray arrayWithCapacity:fields.count];
    for (GHField *field in fields) [out addObject:[field toWireJSONObject]];
    return out;
}

- (NSString *)description {
    // Never the value: descriptions end up in logs.
    return [NSString stringWithFormat:@"<GHField %@ kind=%@ locked=%d>", self.signature, self.kind, self.locked];
}

@end
