import { describe, expect, it } from "vitest";
import { ROUTES, matchRoute } from "./routes";

describe("matchRoute", () => {
  it("matches with or without a trailing slash", () => {
    expect(matchRoute("/apply")?.component).toBeDefined();
    expect(matchRoute("/apply/")?.path).toBe("/apply");
    expect(matchRoute("/apply-plain")?.path).toBe("/apply-plain/");
  });

  it("treats /apply-plain/ as a static page and unknown paths as missing", () => {
    expect(matchRoute("/apply-plain/")?.component).toBeUndefined();
    expect(matchRoute("/nope")).toBeUndefined();
    expect(matchRoute("/")).toBeUndefined();
  });

  it("keeps route paths unique", () => {
    expect(new Set(ROUTES.map((r) => r.path)).size).toBe(ROUTES.length);
  });
});
