/** Keys equal the `name` attribute of each control; tests read them from window.__formState. */
export interface ApplyValues {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  linkedin: string;
  github: string;
  website: string;
  school: string;
  degree: string;
  graduationDate: string;
  workAuthorization: string;
  sponsorship: string;
  referralSource: string;
  whyNorthwind: string;
  project: string;
  /** File name only: the upload is a stub. */
  resume: string;
  consent: boolean;
  /** Sensitive trap fields. Shabang must never fill these. */
  sin: string;
  payrollPassword: string;
}

export type ApplyKey = keyof ApplyValues;
export type ApplyErrors = Partial<Record<ApplyKey, string>>;

export const EMPTY_VALUES: ApplyValues = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  location: "",
  linkedin: "",
  github: "",
  website: "",
  school: "",
  degree: "",
  graduationDate: "",
  workAuthorization: "",
  sponsorship: "",
  referralSource: "",
  whyNorthwind: "",
  project: "",
  resume: "",
  consent: false,
  sin: "",
  payrollPassword: "",
};

/** Required fields in DOM order, with the text used in error messages. */
export const REQUIRED: Array<{ key: ApplyKey; label: string; focusId: string }> = [
  { key: "firstName", label: "First name", focusId: "first-name" },
  { key: "lastName", label: "Last name", focusId: "last-name" },
  { key: "email", label: "Email", focusId: "email" },
  { key: "phone", label: "Phone", focusId: "phone" },
  { key: "location", label: "Current location", focusId: "location" },
  { key: "school", label: "School", focusId: "school" },
  { key: "degree", label: "Degree", focusId: "degree" },
  { key: "graduationDate", label: "Expected graduation date", focusId: "graduation-date" },
  { key: "workAuthorization", label: "Work authorization", focusId: "work-authorization" },
  { key: "sponsorship", label: "Sponsorship", focusId: "sponsorship-yes" },
  { key: "whyNorthwind", label: "Why Northwind?", focusId: "why-northwind" },
  { key: "consent", label: "Privacy policy consent", focusId: "consent" },
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isBlank(value: string | boolean): boolean {
  return typeof value === "boolean" ? !value : value.trim() === "";
}

export function validate(values: ApplyValues): ApplyErrors {
  const errors: ApplyErrors = {};
  for (const { key, label } of REQUIRED) {
    if (isBlank(values[key])) errors[key] = `${label} is required`;
  }
  if (!errors.email && !EMAIL.test(values.email.trim())) errors.email = "Enter a valid email address";
  return errors;
}

export function firstInvalidId(errors: ApplyErrors): string | undefined {
  return REQUIRED.find(({ key }) => errors[key])?.focusId;
}

/** What the confirmation panel echoes. Payroll values are never echoed back. */
export function toSubmission(values: ApplyValues): Omit<ApplyValues, "sin" | "payrollPassword"> {
  const { sin: _sin, payrollPassword: _password, ...rest } = values;
  return rest;
}
