import { toSubmission, type ApplyValues } from "./formState";

export function Confirmation({ values }: { values: ApplyValues }) {
  return (
    <section className="card confirmation" data-testid="submitted" role="status" aria-labelledby="submitted-title">
      <h2 id="submitted-title">Application submitted</h2>
      <p>
        Thanks{values.firstName ? `, ${values.firstName}` : ""}. This is a local demo, so nothing left your
        browser. Here is what the form would have sent:
      </p>
      <pre data-testid="submitted-json">{JSON.stringify(toSubmission(values), null, 2)}</pre>
      <p>
        <a href="/apply">Start another application</a>
      </p>
    </section>
  );
}
