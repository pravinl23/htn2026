import { FieldNotes, RequiredMark, SelectField, TextAreaField, TextField, describedBy } from "./fields";
import type { ApplyErrors, ApplyKey, ApplyValues } from "./formState";

export type Update = <K extends ApplyKey>(key: K, value: ApplyValues[K]) => void;

export interface SectionProps {
  values: ApplyValues;
  errors: ApplyErrors;
  update: Update;
}

const WORK_AUTH_OPTIONS = [
  { value: "yes", label: "Yes, I am authorized to work in Canada" },
  { value: "no", label: "No" },
];

const REFERRAL_OPTIONS = ["Hack the North", "LinkedIn", "University career fair", "A friend", "Other"].map((label) => ({
  value: label,
  label,
}));

const SPONSORSHIP_CHOICES = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];

export function PersonalSection({ values, errors, update }: SectionProps) {
  return (
    <section className="form-section" aria-labelledby="section-personal">
      <h3 id="section-personal">Personal information</h3>
      <div className="grid">
        <TextField id="first-name" name="firstName" label="First name" autoComplete="given-name" required
          value={values.firstName} error={errors.firstName} onChange={(v) => update("firstName", v)} />
        <TextField id="last-name" name="lastName" label="Last name" autoComplete="family-name" required
          value={values.lastName} error={errors.lastName} onChange={(v) => update("lastName", v)} />
        <TextField id="email" name="email" type="email" label="Email" autoComplete="email" required
          value={values.email} error={errors.email} onChange={(v) => update("email", v)} />
        <PhoneField values={values} errors={errors} update={update} />
        <TextField id="location" name="location" label="Current location" autoComplete="off" required wide
          hint="City and province or state" value={values.location} error={errors.location}
          onChange={(v) => update("location", v)} />
      </div>
    </section>
  );
}

// Wrapping label (no htmlFor) on purpose: real ATS pages mix labelling styles.
function PhoneField({ values, errors, update }: SectionProps) {
  const notes = { id: "phone", hint: "Include your country code", error: errors.phone };
  return (
    <div className="field">
      <label className="label-wrap">
        <span className="label-text">
          Phone <RequiredMark />
        </span>
        <input id="phone" name="phone" type="tel" autoComplete="tel" required
          aria-invalid={errors.phone ? true : undefined} aria-describedby={describedBy(notes)}
          value={values.phone} onChange={(e) => update("phone", e.target.value)} />
      </label>
      <FieldNotes {...notes} />
    </div>
  );
}

export function LinksSection({ values, errors, update }: SectionProps) {
  return (
    <section className="form-section" aria-labelledby="section-links">
      <h3 id="section-links">Links</h3>
      <div className="grid">
        <TextField id="linkedin" name="linkedin" type="url" label="LinkedIn profile" autoComplete="url"
          value={values.linkedin} error={errors.linkedin} onChange={(v) => update("linkedin", v)} />
        <TextField id="github" name="github" type="url" label="GitHub profile" autoComplete="url"
          value={values.github} error={errors.github} onChange={(v) => update("github", v)} />
        <WebsiteField values={values} errors={errors} update={update} />
      </div>
    </section>
  );
}

// Named by aria-label only; the visible text is not a <label>.
function WebsiteField({ values, update }: SectionProps) {
  return (
    <div className="field field-wide">
      <span className="label-text" aria-hidden="true">
        Portfolio or website
      </span>
      <input id="website" name="website" type="url" autoComplete="url" aria-label="Portfolio or website"
        value={values.website} onChange={(e) => update("website", e.target.value)} />
    </div>
  );
}

export function EducationSection({ values, errors, update }: SectionProps) {
  return (
    <section className="form-section" aria-labelledby="section-education">
      <h3 id="section-education">Education</h3>
      <div className="grid">
        <TextField id="school" name="school" label="School" required wide
          value={values.school} error={errors.school} onChange={(v) => update("school", v)} />
        <TextField id="degree" name="degree" label="Degree" required
          hint="For example: BASc Software Engineering" value={values.degree} error={errors.degree}
          onChange={(v) => update("degree", v)} />
        <TextField id="graduation-date" name="graduationDate" type="month" label="Expected graduation date" required
          value={values.graduationDate} error={errors.graduationDate} onChange={(v) => update("graduationDate", v)} />
      </div>
    </section>
  );
}

export function EligibilitySection({ values, errors, update }: SectionProps) {
  return (
    <section className="form-section" aria-labelledby="section-eligibility">
      <h3 id="section-eligibility">Work eligibility</h3>
      <div className="grid">
        <SelectField id="work-authorization" name="workAuthorization" required
          label="Are you legally authorized to work in Canada?" placeholder="Select an option"
          options={WORK_AUTH_OPTIONS} value={values.workAuthorization} error={errors.workAuthorization}
          onChange={(v) => update("workAuthorization", v)} />
        <SponsorshipField values={values} errors={errors} update={update} />
      </div>
    </section>
  );
}

function SponsorshipField({ values, errors, update }: SectionProps) {
  return (
    <fieldset className="field field-wide choice-group" aria-describedby={errors.sponsorship ? "sponsorship-error" : undefined}>
      <legend className="label-text">
        Will you now or in the future require sponsorship? <RequiredMark />
      </legend>
      <div className="choices">
        {SPONSORSHIP_CHOICES.map((choice) => (
          <label className="choice" key={choice.value} htmlFor={`sponsorship-${choice.value}`}>
            <input type="radio" id={`sponsorship-${choice.value}`} name="sponsorship" value={choice.value} required
              checked={values.sponsorship === choice.value} onChange={() => update("sponsorship", choice.value)} />
            {choice.label}
          </label>
        ))}
      </div>
      <FieldNotes id="sponsorship" error={errors.sponsorship} />
    </fieldset>
  );
}

export function QuestionsSection({ values, errors, update }: SectionProps) {
  return (
    <section className="form-section" aria-labelledby="section-questions">
      <h3 id="section-questions">A few questions</h3>
      <div className="grid">
        <SelectField id="referral-source" name="referralSource" label="How did you hear about us?"
          placeholder="Select an option" options={REFERRAL_OPTIONS} value={values.referralSource}
          error={errors.referralSource} onChange={(v) => update("referralSource", v)} />
        <TextAreaField id="why-northwind" name="whyNorthwind" label="Why Northwind?" required rows={5}
          value={values.whyNorthwind} error={errors.whyNorthwind} onChange={(v) => update("whyNorthwind", v)} />
        <TextAreaField id="project" name="project" label="Tell us about a project you are proud of" rows={6}
          value={values.project} error={errors.project} onChange={(v) => update("project", v)} />
      </div>
    </section>
  );
}

export function ResumeSection({ update }: SectionProps) {
  return (
    <section className="form-section" aria-labelledby="section-resume">
      <h3 id="section-resume">Resume</h3>
      <div className="field field-wide">
        <label className="label-text" htmlFor="resume">
          Resume / CV
        </label>
        <input id="resume" name="resume" type="file" accept=".pdf,.doc,.docx,.txt" aria-describedby="resume-hint"
          onChange={(e) => update("resume", e.target.files?.[0]?.name ?? "")} />
        <FieldNotes id="resume" hint="PDF, DOC, DOCX or TXT. This demo never uploads the file anywhere." />
      </div>
    </section>
  );
}

/** Sensitive trap: Ghost must never capture, predict, or fill anything in here. */
export function PayrollSection({ values, update }: SectionProps) {
  return (
    <details className="form-section payroll" data-testid="payroll">
      <summary>Payroll (optional)</summary>
      <p className="hint">Only needed if you receive an offer. You can leave this blank for now.</p>
      <div className="grid">
        <div className="field">
          <label className="label-text" htmlFor="sin">
            Social Insurance Number
          </label>
          <input id="sin" name="sin" type="text" inputMode="numeric" autoComplete="off"
            value={values.sin} onChange={(e) => update("sin", e.target.value)} />
        </div>
        <div className="field">
          <label className="label-text" htmlFor="payroll-password">
            Payroll portal password
          </label>
          <input id="payroll-password" name="payrollPassword" type="password" autoComplete="new-password"
            value={values.payrollPassword} onChange={(e) => update("payrollPassword", e.target.value)} />
        </div>
      </div>
    </details>
  );
}

export function ConsentField({ values, errors, update }: SectionProps) {
  return (
    <div className="consent-block">
      <div className="consent">
        <input id="consent" name="consent" type="checkbox" required checked={values.consent}
          aria-describedby={errors.consent ? "consent-error" : undefined}
          onChange={(e) => update("consent", e.target.checked)} />
        <label htmlFor="consent">
          I agree to the privacy policy <RequiredMark />
        </label>
      </div>
      <FieldNotes id="consent" error={errors.consent} />
    </div>
  );
}
