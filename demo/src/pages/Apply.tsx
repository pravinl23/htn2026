import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Confirmation } from "./apply/Confirmation";
import { JobDescription } from "./apply/JobDescription";
import { EMPTY_VALUES, firstInvalidId, validate, type ApplyErrors, type ApplyValues } from "./apply/formState";
import {
  ConsentField, EducationSection, EligibilitySection, LinksSection, PayrollSection, PersonalSection,
  QuestionsSection, ResumeSection, type Update,
} from "./apply/sections";

function SiteHeader() {
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <a className="brand" href="/apply" aria-label="Northwind Robotics careers">
          <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
            <rect width="32" height="32" rx="8" fill="currentColor" />
            <path d="M9 23V9h3.2l7.6 9.2V9H23v14h-3.2l-7.6-9.2V23z" fill="#fff" />
          </svg>
          <span>Northwind Robotics</span>
        </a>
        <span className="site-header-tag">Careers</span>
      </div>
    </header>
  );
}

function ErrorSummary({ errors }: { errors: ApplyErrors }) {
  const count = Object.keys(errors).length;
  if (count === 0) return null;
  return (
    <div className="error-summary" role="alert" data-testid="form-errors">
      Please fix {count} {count === 1 ? "field" : "fields"} before submitting.
    </div>
  );
}

export function Apply() {
  const [values, setValues] = useState<ApplyValues>(EMPTY_VALUES);
  const [errors, setErrors] = useState<ApplyErrors>({});
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    window.__submitted = false;
  }, []);

  useEffect(() => {
    window.__formState = { ...values };
  }, [values]);

  const update = useCallback<Update>((key, value) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const { [key]: _cleared, ...rest } = prev;
      return rest;
    });
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found = validate(values);
    setErrors(found);
    const invalidId = firstInvalidId(found);
    if (invalidId) {
      document.getElementById(invalidId)?.focus();
      return;
    }
    window.__formState = { ...values };
    window.__submitted = true;
    setSubmitted(true);
  }

  const section = { values, errors, update };
  return (
    <div className="ats">
      <SiteHeader />
      <main className="page">
        <JobDescription />
        {submitted ? (
          <Confirmation values={values} />
        ) : (
          <form id="application-form" className="card" onSubmit={handleSubmit} noValidate aria-labelledby="apply-title">
            <h2 id="apply-title">Apply for this job</h2>
            <p className="required-note">
              <span className="req" aria-hidden="true">*</span> Required
            </p>
            <ErrorSummary errors={errors} />
            <PersonalSection {...section} />
            <LinksSection {...section} />
            <EducationSection {...section} />
            <EligibilitySection {...section} />
            <QuestionsSection {...section} />
            <ResumeSection {...section} />
            <PayrollSection {...section} />
            <ConsentField {...section} />
            <div className="actions">
              <button type="submit" className="submit" data-testid="submit">
                Submit application
              </button>
            </div>
          </form>
        )}
      </main>
      <footer className="site-footer">Northwind Robotics is a fictional company. This page is a local Ghost demo.</footer>
    </div>
  );
}
