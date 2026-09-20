// GHProbe: what does this page ACTUALLY expose for one combo box?
//
// The combo box fix could not be guessed from a dump alone: a react-select control shows up in WebKit as a 4 px wide
// AXComboBox (its inner <input class="select__input">) with no children and no options, and the option list only
// exists in the tree while it is open. So this probe opens exactly one combo box, writes down everything the tree
// then shows, and closes it again.
//
// What it is allowed to do, and nothing else:
//   - read the frontmost window's tree and find ONE AXComboBox whose label contains the given substring;
//   - refuse, touching nothing, when that combo box is demographic/EEO, sensitive, disabled or already answered;
//   - set AXFocused on it, and AXPress it and the "Toggle flyout" button that belongs to it;
//   - AXPress the toggle once more to close a list it opened.
// It never posts a key (not even Escape), never presses anything else, never AXPresses an option, and never writes a
// value. Option TEXTS are page content and are reported; no field value ever is.
#import <Foundation/Foundation.h>
#import "GHAXNode.h"

NS_ASSUME_NONNULL_BEGIN

@interface GHProbe : NSObject

/// Runs the experiment on the first combo box under `window` whose label contains `labelSubstring`. Synchronous and
/// bounded (a few AX walks plus two settle waits, about 2 s). Never raises; every failure is a key in the answer.
+ (NSDictionary<NSString *, id> *)probeComboBoxUnderWindow:(id<GHAXNode>)window
                                            labelSubstring:(NSString *)labelSubstring;

/// The combo boxes under `window`, in tree order. Exposed for tests.
+ (NSArray<id<GHAXNode>> *)comboBoxesUnderWindow:(id<GHAXNode>)window limit:(NSUInteger)limit;
/// The label GHProbe matches against: title, description, the label element, placeholder, help.
+ (nullable NSString *)labelOfComboBox:(id<GHAXNode>)node;
/// The "Toggle flyout" / disclosure button that belongs to `comboBox`: an AXButton among the nodes right after it
/// (same parent) before the next combo box or text field. nil when the page has none.
+ (nullable id<GHAXNode>)toggleButtonForComboBox:(id<GHAXNode>)comboBox;
/// role, subrole, roleDescription, title, description, identifier, classes, enabled, focused, rect, childCount and
/// valueLength of `node`. Never the value itself.
+ (NSDictionary<NSString *, id> *)summaryOfNode:(nullable id<GHAXNode>)node;

@end

NS_ASSUME_NONNULL_END
