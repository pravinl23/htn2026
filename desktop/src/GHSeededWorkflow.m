#import "GHSeededWorkflow.h"
#import "GHField.h"
#import "GHWalkState.h"

static NSString *GHWorkflowText(NSString *text) {
    NSString *lower = (text ?: @"").lowercaseString;
    lower = [lower stringByReplacingOccurrencesOfString:@"’" withString:@"'"];
    lower = [lower stringByReplacingOccurrencesOfString:@"\u00a0" withString:@" "];
    return [lower stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

static BOOL GHWorkflowContains(NSString *text, NSString *needle) {
    return [GHWorkflowText(text) rangeOfString:GHWorkflowText(needle)].location != NSNotFound;
}

static GHField *GHFirstField(NSArray<GHField *> *fields, BOOL (^matches)(GHField *field)) {
    for (GHField *field in fields) if (matches(field)) return field;
    return nil;
}

static GHGhost *GHWorkflowGhost(GHField *field, NSString *action, NSString *value, BOOL locked, NSString *reason) {
    if (!field) return nil;
    GHGhost *ghost = [[GHGhost alloc] init];
    ghost.signature = field.signature;
    ghost.action = action;
    ghost.value = value;
    ghost.displayText = value.length ? value : (field.label ?: @"");
    ghost.confidence = 1.0;
    ghost.locked = locked;
    ghost.source = @"workflow";
    ghost.reason = reason;
    return ghost;
}

static BOOL GHIsOpenTableOrigin(NSString *origin) {
    NSURLComponents *parts = origin.length ? [NSURLComponents componentsWithString:origin] : nil;
    // Live origins are privacy-shaped as app://<bundle>/<web-host>; direct https origins remain useful in pure
    // tests and future callers. Never infer from a window title.
    NSString *webHost = [parts.scheme.lowercaseString isEqualToString:@"app"]
        ? [parts.path stringByTrimmingCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@"/"]].lowercaseString
        : parts.host.lowercaseString;
    return [webHost isEqualToString:@"opentable.ca"] || [webHost hasSuffix:@".opentable.ca"];
}

@implementation GHSeededWorkflow

+ (GHGhost *)ghostForOrigin:(NSString *)origin fields:(NSArray<GHField *> *)fields {
    if (!GHIsOpenTableOrigin(origin) || fields.count == 0) return nil;

    // Work backwards from the terminal state. OpenTable can leave earlier controls mounted while later panels
    // are visible; the most advanced visible milestone is therefore the truthful state of the workflow.
    GHField *complete = GHFirstField(fields, ^BOOL(GHField *field) {
        return [field.kind isEqualToString:GHKindButton] && GHWorkflowContains(field.label, @"complete reservation");
    });
    if (complete) {
        // Completing a reservation is consequential. Ghost may point and park, but Tab can never press it.
        return GHWorkflowGhost(complete, GHGhostActionClick, nil, YES, @"OpenTable reservation ready for your confirmation");
    }

    GHField *details = GHFirstField(fields, ^BOOL(GHField *field) {
        if (![field.kind isEqualToString:GHKindSelect]) return NO;
        return GHWorkflowContains(field.label, @"reservation details") || GHWorkflowContains(field.label, @"special occasion");
    });
    if (details && !GHWorkflowContains(details.value, @"birthday")) {
        GHGhost *ghost = GHWorkflowGhost(details, GHGhostActionSelect, @"Birthday", NO, @"OpenTable reservation occasion");
        ghost.lazy = details.lazyOptions || details.options.count == 0;
        return ghost;
    }

    GHField *standard = GHFirstField(fields, ^BOOL(GHField *field) {
        return ([field.kind isEqualToString:GHKindButton] || [field.kind isEqualToString:GHKindRadio] ||
                [field.kind isEqualToString:GHKindItem]) &&
               ([GHWorkflowText(field.label) isEqualToString:@"standard"] || GHWorkflowContains(field.label, @"standard seating"));
    });
    if (standard) return GHWorkflowGhost(standard, GHGhostActionClick, nil, NO, @"OpenTable standard seating");

    GHField *seven = GHFirstField(fields, ^BOOL(GHField *field) {
        if (![field.kind isEqualToString:GHKindButton]) return NO;
        NSString *label = GHWorkflowText(field.label);
        BOOL sevenPM = [label hasPrefix:@"7:00 p.m."] || [label hasPrefix:@"7:00 pm"] || [label hasPrefix:@"7:00pm"];
        return sevenPM && GHWorkflowContains(label, @"reserve table");
    });
    if (seven) {
        // The generic safety vocabulary locks every label containing "reserve". On OpenTable this particular
        // control only opens the reversible seating/details step; the later "Complete reservation" control is
        // the action that creates the reservation and remains locked. This exact, origin-scoped milestone is
        // therefore safe to accept while the terminal action still cannot be activated by Tab.
        GHGhost *ghost = GHWorkflowGhost(seven, GHGhostActionClick, nil, NO, @"OpenTable 7:00 PM reservation time");
        ghost.auditedLockedLabel = seven.label;
        return ghost;
    }

    GHField *location = GHFirstField(fields, ^BOOL(GHField *field) {
        BOOL writable = [field.kind isEqualToString:GHKindText] || [field.kind isEqualToString:GHKindTextArea] ||
                        [field.kind isEqualToString:GHKindSelect];
        return writable && (GHWorkflowContains(field.label, @"location") ||
                            GHWorkflowContains(field.placeholder, @"location, restaurant") ||
                            GHWorkflowContains(field.placeholder, @"restaurant or cuisine") ||
                            [GHWorkflowText(field.identifier) isEqualToString:@"home-autocomplete-label"] ||
                            [GHWorkflowText(field.identifier) isEqualToString:@"home-autocomplete-input"]);
    });
    if (location && !GHWorkflowContains(location.value, @"waterloo")) {
        BOOL select = [location.kind isEqualToString:GHKindSelect];
        GHGhost *ghost = GHWorkflowGhost(location, select ? GHGhostActionSelect : GHGhostActionFill,
                                         @"Waterloo", NO, @"OpenTable seeded location");
        ghost.lazy = select && (location.lazyOptions || location.options.count == 0);
        return ghost;
    }

    GHField *go = GHFirstField(fields, ^BOOL(GHField *field) {
        return [field.kind isEqualToString:GHKindButton] && [GHWorkflowText(field.label) isEqualToString:@"let's go"];
    });
    if (go && location && GHWorkflowContains(location.value, @"waterloo")) {
        return GHWorkflowGhost(go, GHGhostActionClick, nil, NO, @"OpenTable search Waterloo");
    }
    return nil;
}

@end
