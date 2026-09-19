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

  it("does not flag ordinary fields", () => {
    for (const label of ["First name", "Email", "Phone", "LinkedIn", "Why Northwind?", "Single sign-on hint", "Business name"]) {
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
