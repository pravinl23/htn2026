// SBPageContext: what a job posting is about, read from the accessibility tree of the page, so drafted answers
// (cover letter, "Why us?") can name the company and the role.
//
//   role         the first AXHeading of the web area
//   company      "<role> at <company>" in the web area's title/description ("Job Application for X at Viam"), else
//                the first link or image named "<Company> Logo" outside the footer (never the job board's own logo)
//   description  page text (AXStaticText) above the "Apply for this job" heading (or above the first form control),
//                whitespace-normalized, links and buttons left out, at most 2000 characters
//
// Pure: a bounded walk over SBAXNode, so it runs on live trees and on saved fixtures alike. Only page text is read;
// the value of an input is never looked at.
#import <Foundation/Foundation.h>
#import "SBAXNode.h"

NS_ASSUME_NONNULL_BEGIN

extern const NSUInteger SBPageContextMaxDescription;   // 2000
extern const NSUInteger SBPageContextMaxNodes;         // 6000
/// Wall clock for one walk (main thread): a huge page or a hung app ends it early, `truncated` says so.
extern const NSTimeInterval SBPageContextMaxSeconds;   // 0.25

@interface SBPageContext : NSObject

@property (nonatomic, readonly, copy, nullable) NSString *company;
@property (nonatomic, readonly, copy, nullable) NSString *role;
/// "" when there is none. At most SBPageContextMaxDescription characters.
@property (nonatomic, readonly, copy) NSString *jobDescription;
/// Nodes looked at, and whether the walk hit its budget.
@property (nonatomic, readonly) NSUInteger visitedNodes;
@property (nonatomic, readonly) BOOL truncated;

/// `root` is a window or a web area; the first AXWebArea below it is used when there is one.
+ (instancetype)contextFromNode:(id<SBAXNode>)root;
+ (instancetype)contextFromNode:(id<SBAXNode>)root maxNodes:(NSUInteger)maxNodes;
- (instancetype)init NS_UNAVAILABLE;

/// { company, role, description }; keys without a value are left out ("description" only when non-empty).
- (NSDictionary<NSString *, NSString *> *)dictionary;

// ---------- pure, exposed for tests ----------
/// "Job Application for <role> at <company>" -> company. With `role` known, the text after "<role> at " wins;
/// otherwise the part after the last " at ". nil when the pattern is not there.
+ (nullable NSString *)companyFromTitle:(nullable NSString *)title role:(nullable NSString *)role;
/// "Viam Logo" -> "Viam". nil for anything else, and for job boards' own logos (Greenhouse, Lever, Workday...).
+ (nullable NSString *)companyFromLogoText:(nullable NSString *)text;
/// Single spaces, trimmed.
+ (NSString *)normalizedText:(nullable NSString *)text;
/// Cut at a composed-character boundary, preferring the last whitespace in the final 200 characters.
+ (NSString *)text:(NSString *)text cappedAt:(NSUInteger)limit;

@end

NS_ASSUME_NONNULL_END
