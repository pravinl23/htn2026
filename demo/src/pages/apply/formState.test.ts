import { describe, expect, it } from "vitest";
import { EMPTY_VALUES, firstInvalidId, toSubmission, validate, type ApplyValues } from "./formState";

const COMPLETE: ApplyValues = {
  ...EMPTY_VALUES,
  firstName: "Alex",
  lastName: "Chen",
  email: "alex.chen.dev@example.com",
  phone: "+1 519 555 0142",
  location: "Waterloo, ON",
  school: "University of Waterloo",
  degree: "BCS Computer Science",
  graduationDate: "2028-04",
  workAuthorization: "yes",
  sponsorship: "no",
  whyNorthwind: "Robots that ship.",
  consent: true,
};

describe("validate", () => {
  it("accepts a complete application with optional fields left blank", () => {
    expect(validate(COMPLETE)).toEqual({});
  });

  it("flags every required field on an empty form and focuses the first one", () => {
    const errors = validate(EMPTY_VALUES);
    expect(Object.keys(errors)).toHaveLength(12);
    expect(firstInvalidId(errors)).toBe("first-name");
  });

  it("requires consent and a well-formed email", () => {
    const errors = validate({ ...COMPLETE, consent: false, email: "alex" });
    expect(errors).toEqual({ consent: "Privacy policy consent is required", email: "Enter a valid email address" });
    expect(firstInvalidId(errors)).toBe("email");
  });
});

describe("toSubmission", () => {
  it("never echoes the payroll trap fields", () => {
    const echoed = toSubmission({ ...COMPLETE, sin: "000 000 000", payrollPassword: "hunter2" });
    expect(echoed).not.toHaveProperty("sin");
    expect(echoed).not.toHaveProperty("payrollPassword");
    expect(JSON.stringify(echoed)).not.toContain("hunter2");
  });
});
