import { describe, expect, it } from "vitest";
import { InvalidContext, normalizeContextSnapshot } from "../src/workflows/context";

describe("workflow context normalization", () => {
  it("keeps a compact AX-derived snapshot and redacts secret-looking text", () => {
    const context = normalizeContextSnapshot({
      version: 99,
      timestamp: 123,
      activeApplication: { name: "Mail", bundleIdentifier: "com.apple.mail", ignored: "x" },
      windowTitle: "Quick chat Thursday afternoon?",
      focusedElement: { role: "AXTextArea", label: "Reply", editableValue: "", safeValueToInsert: "Thursday works", ignored: "x" },
      nearbyText: ["Can we meet Thursday? token=super-secret", "4111 1111 1111 1111", ...Array.from({ length: 20 }, (_, i) => `line ${i}`)],
      preferences: { timezone: "America/Toronto", apiKey: "must not leave", count: 2, nested: { no: true } },
      unknown: "discarded",
    });
    expect(context).toMatchObject({
      version: 1,
      timestamp: 123,
      activeApplication: { name: "Mail", bundleIdentifier: "com.apple.mail" },
      focusedElement: { role: "AXTextArea", label: "Reply", safeValueToInsert: "Thursday works" },
      preferences: { timezone: "America/Toronto", count: 2 },
    });
    expect(context.nearbyText).toHaveLength(10);
    expect(JSON.stringify(context)).not.toContain("super-secret");
    expect(JSON.stringify(context)).not.toContain("4111");
    expect(JSON.stringify(context)).not.toContain("unknown");
    expect(context.preferences).not.toHaveProperty("apiKey");
  });

  it("drops the entire focused element when its role or label is sensitive", () => {
    const base = { activeApplication: { name: "Browser", bundleIdentifier: "com.example.browser" } };
    expect(normalizeContextSnapshot({ ...base, focusedElement: { role: "AXSecureTextField", label: "Login", editableValue: "secret" } }).focusedElement).toBeUndefined();
    expect(normalizeContextSnapshot({ ...base, focusedElement: { role: "AXTextField", label: "Credit card number", editableValue: "123" } }).focusedElement).toBeUndefined();
  });

  it("rejects snapshots without an application identity", () => {
    expect(() => normalizeContextSnapshot({})).toThrow(InvalidContext);
  });
});
