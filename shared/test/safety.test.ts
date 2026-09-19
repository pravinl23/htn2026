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

  it("leaves navigation and harmless buttons unlocked", () => {
    for (const text of ["Next", "Open calendar", "Back to inbox", "Add row", "Reply", "View invoice"]) {
      expect(isLockedAction({ text, buttonType: "button" }), text).toBe(false);
    }
  });
});
