import type { CapturedField, FieldKind, FormPredictRequest } from "@ghost/shared";

/** A 12-field job application (fictional company) shared by the contract tests and `pnpm test:live`. No personal data. */
const SAMPLE: [label: string, kind: FieldKind, extra?: Partial<CapturedField>][] = [
  ["First name", "text", { autocomplete: "given-name" }],
  ["Last name", "text", { autocomplete: "family-name" }],
  ["Email", "email"],
  ["Phone", "tel"],
  ["LinkedIn profile", "url", { placeholder: "https://linkedin.com/in/..." }],
  ["GitHub", "url"],
  ["Portfolio or personal site", "url"],
  ["School", "text", { context: "Education" }],
  ["Degree", "text", { context: "Education" }],
  ["Expected graduation", "month", { context: "Education" }],
  ["How did you hear about us?", "select", { options: ["Job board", "Hackathon", "Friend", "Other"].map((label) => ({ value: label.toLowerCase(), label })) }],
  ["Why do you want to work at Northwind Robotics?", "textarea"],
];

export const SAMPLE_FACT_KEYS = [
  "firstName", "lastName", "email", "phone", "linkedin", "github", "website", "school", "degree", "graduationDate", "referralSource",
];

export function sampleFormFields(): CapturedField[] {
  return SAMPLE.map(([label, kind, extra], i) => ({
    signature: `sample-${i}`,
    label,
    kind,
    rect: { x: 0, y: 40 * i, width: 320, height: 32 },
    ...extra,
  }));
}

export function sampleFormRequest(): FormPredictRequest {
  return { origin: "http://localhost:5173", formSignature: "sample-apply-v1", fields: sampleFormFields(), factKeys: [...SAMPLE_FACT_KEYS] };
}
