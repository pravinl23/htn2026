import { describe, expect, it } from "vitest";
import { isLockedAction, isSensitive } from "../src";

describe("isSensitive", () => {
  it("flags passwords, cards, government ids and marked fields", () => {
    expect(isSensitive({ inputType: "password" })).toBe(true);
    expect(isSensitive({ autocomplete: "cc-number" })).toBe(true);
    expect(isSensitive({ autocomplete: "section-pay cc-exp" })).toBe(true);
    expect(isSensitive({ autocomplete: "one-time-code" })).toBe(true);
    expect(isSensitive({ label: "Social Insurance Number (SIN)" })).toBe(true);
    expect(isSensitive({ label: "SSN" })).toBe(true);
    expect(isSensitive({ name: "passport_no" })).toBe(true);
    expect(isSensitive({ label: "Card number" })).toBe(true);
    expect(isSensitive({ id: "cvv" })).toBe(true);
    expect(isSensitive({ label: "Driver's license number" })).toBe(true);
    expect(isSensitive({ markedSensitive: true, label: "Nickname" })).toBe(true);
  });

  it("flags card and id fields that carry no autocomplete hint", () => {
    const labels = [
      "Name on card", "Cardholder name", "Card holder", "CVV2", "CVC2", "CSC", "Card No.", "Card #", "Expiry date", "Expiration",
      "MM/YY", "MM / YY", "S.I.N.", "S.S.N.", "OHIP number", "Health number", "MFA code", "Authentication code", "Authenticator code",
      "Recovery phrase", "Recovery code",
    ];
    for (const label of labels) expect(isSensitive({ label }), label).toBe(true);
    for (const name of ["cc-number", "ccnum", "cc-exp", "cc_csc", "ccName", "cardNumber", "pwd", "securityCode"]) {
      expect(isSensitive({ name }), name).toBe(true);
    }
    expect(isSensitive({ placeholder: "MM/YY" })).toBe(true);
  });

  it("flags birth dates, security questions, bank routing details and national ids from around the world", () => {
    const labels = [
      "Date of birth", "Birth date", "Birthdate", "D.O.B.", "DOB", "Year of birth", "Mother's maiden name", "Maiden name",
      "Security question", "Security answer", "Answer to your security question", "Challenge answer", "Memorable word",
      "Bank account number", "Bank number", "Bank code", "Banking details", "Branch number", "Branch code", "Transit number", "Transit No.",
      "Institution number", "Sort code", "BSB", "IFSC", "SWIFT", "SWIFT code", "SWIFT/BIC", "BIC", "IBAN", "Routing number",
      "PIN", "PIN code", "Card PIN number", "CVV", "CVV code", "CVN", "CVD", "Card verification value", "Card security code", "Verification number",
      "Valid thru", "Exp date", "National identification number", "National identity card", "National ID", "Identity card number",
      "Aadhaar number", "Aadhar", "NRIC", "NRIC/FIN", "CPF", "TFN", "Tax file number", "NHS number", "NHS No.", "Medicare number", "PAN card",
    ];
    for (const label of labels) expect(isSensitive({ label }), label).toBe(true);
    for (const name of ["dob", "birthDate", "date_of_birth", "cardcvv", "securityAnswer", "bank_account", "swift_code", "aadhaar", "nhsNumber", "client_secret"]) {
      expect(isSensitive({ name }), name).toBe(true);
    }
    expect(isSensitive({ label: "Expiry", placeholder: "MM/YYYY" })).toBe(true);
    expect(isSensitive({ placeholder: "MM/YYYY" })).toBe(true);
  });

  it("does not flag ordinary labels that merely look like the patterns", () => {
    const labels = [
      "Business name", "Pinterest profile", "Spin class", "Pinned repositories", "Secretary", "Swift experience", "Years of SwiftUI experience",
      "Experience with Swift", "Branch of service", "Git branch", "Transit pass", "Banking experience", "Food bank volunteer", "Security clearance",
      "Bicycle commuter?", "Japan office", "National sales manager", "Identity and access management", "Medicare experience", "Memorable project",
      "Expected start", "Institution", "Birthplace of the company", "Verification status", "Challenge you are proud of",
    ];
    for (const label of labels) expect(isSensitive({ label }), label).toBe(false);
  });

  it("reads MM/YYYY next to education words as a date hint, not a card expiry", () => {
    expect(isSensitive({ label: "Expected graduation (MM/YYYY)" })).toBe(false);
    expect(isSensitive({ name: "graduationDate", id: "graduation-date", label: "Graduation date", placeholder: "MM/YYYY" })).toBe(false);
    expect(isSensitive({ placeholder: "MM/YYYY", label: "When did you finish your degree?" })).toBe(false);
    expect(isSensitive({ label: "Card expiry (MM/YY)" })).toBe(true);
    expect(isSensitive({ label: "MM/YY", name: "school_store_card" })).toBe(true);
  });

  it("does not flag ordinary fields", () => {
    for (const label of ["First name", "Email", "Phone", "LinkedIn", "Why Northwind?", "Single sign-on hint", "Business name", "Full name", "Company", "Discard draft", "Account", "No. of years"]) {
      expect(isSensitive({ label }), label).toBe(false);
    }
    expect(isSensitive({ autocomplete: "given-name" })).toBe(false);
  });
});

describe("isLockedAction", () => {
  it("locks irreversible actions", () => {
    for (const text of ["Submit application", "Send", "Pay now", "Place order", "Delete", "Confirm", "Checkout", "Apply now", "Reply & send"]) {
      expect(isLockedAction({ text }), text).toBe(true);
    }
    expect(isLockedAction({ text: "Go", buttonType: "submit" })).toBe(true);
    expect(isLockedAction({ text: "Continue", insideForm: true })).toBe(true);
    expect(isLockedAction({ text: "Anything", markedLocked: true })).toBe(true);
  });

  it("locks payments, consent, account, destructive and deploy actions however they are phrased", () => {
    const texts = [
      "Complete purchase", "Submit payment", "Make a payment", "Send message", "Resend invite", "Yes, delete", "Yes", "OK", "Agree and continue", "I agree",
      "Accept", "Accept all cookies", "Allow", "Authorize app", "Sign up", "Signup", "Register", "Create account", "Join now", "Enroll", "Approve", "Reject",
      "Decline offer", "Merge", "Squash and merge", "Merge pull request", "Deploy", "Deploy to production", "Redeploy", "Release", "Push", "Revert", "Roll back",
      "Transfer funds", "Withdraw", "Deposit", "Log out", "Logout", "Sign out", "Subscribe", "Unsubscribe", "Upgrade plan", "Start free trial", "Place bid",
      "Order again", "Book", "Book now", "Reserve", "RSVP", "Vote", "Remove", "Remove item", "Remove member", "Erase all data", "Empty trash", "Move to trash",
      "Clear all", "Reset password", "Cancel subscription", "Cancel my booking", "Close account", "Close issue", "Deactivate", "Uninstall", "Run", "Execute",
      "Post", "Post comment", "Comment", "Tweet", "Publish", "Invite", "Proceed to checkout", "Finish", "Withdraw application",
    ];
    for (const text of texts) expect(isLockedAction({ text, buttonType: "button" }), text).toBe(true);
  });

  it("does not lock view-only controls or look-alike words", () => {
    const texts = [
      "Remove filter", "Remove all filters", "Remove sort", "Clear all filters", "Reset filters", "Reset zoom", "Apply filters", "Post code", "Postcode",
      "Emergency contacts", "Autocomplete", "Facebook", "Ascending", "Save draft", "Save", "Cancel", "Close", "Edit", "Preview", "Show more", "Trash",
    ];
    for (const text of texts) expect(isLockedAction({ text, buttonType: "button" }), text).toBe(false);
  });

  it("leaves navigation and harmless buttons unlocked", () => {
    for (const text of ["Next", "Open calendar", "Back to inbox", "Add row", "Reply", "View invoice"]) {
      expect(isLockedAction({ text, buttonType: "button" }), text).toBe(false);
    }
  });
});
