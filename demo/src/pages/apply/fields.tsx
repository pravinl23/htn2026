import type { HTMLInputTypeAttribute, ReactNode } from "react";

interface FieldShell {
  id: string;
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
}

interface ValueProps {
  name: string;
  value: string;
  onChange(value: string): void;
}

export function RequiredMark() {
  return (
    <span className="req" aria-hidden="true">
      *
    </span>
  );
}

export function FieldNotes({ id, hint, error }: Pick<FieldShell, "id" | "hint" | "error">) {
  return (
    <>
      {hint && (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </>
  );
}

export function describedBy({ id, hint, error }: Pick<FieldShell, "id" | "hint" | "error">): string | undefined {
  const ids = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

function Shell({ shell, wide, children }: { shell: FieldShell; wide?: boolean; children: ReactNode }) {
  return (
    <div className={wide ? "field field-wide" : "field"}>
      <label className="label-text" htmlFor={shell.id}>
        {shell.label} {shell.required && <RequiredMark />}
      </label>
      {children}
      <FieldNotes {...shell} />
    </div>
  );
}

type TextFieldProps = FieldShell & ValueProps & {
  type?: HTMLInputTypeAttribute;
  autoComplete?: string;
  wide?: boolean;
};

export function TextField({ type = "text", autoComplete, wide, name, value, onChange, ...shell }: TextFieldProps) {
  return (
    <Shell shell={shell} wide={wide}>
      <input
        id={shell.id}
        name={name}
        type={type}
        autoComplete={autoComplete}
        required={shell.required}
        aria-invalid={shell.error ? true : undefined}
        aria-describedby={describedBy(shell)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Shell>
  );
}

type SelectFieldProps = FieldShell & ValueProps & {
  placeholder: string;
  options: Array<{ value: string; label: string }>;
};

export function SelectField({ placeholder, options, name, value, onChange, ...shell }: SelectFieldProps) {
  return (
    <Shell shell={shell} wide>
      <select
        id={shell.id}
        name={name}
        required={shell.required}
        aria-invalid={shell.error ? true : undefined}
        aria-describedby={describedBy(shell)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Shell>
  );
}

type TextAreaFieldProps = FieldShell & ValueProps & { rows?: number };

export function TextAreaField({ rows = 5, name, value, onChange, ...shell }: TextAreaFieldProps) {
  return (
    <Shell shell={shell} wide>
      <textarea
        id={shell.id}
        name={name}
        rows={rows}
        required={shell.required}
        aria-invalid={shell.error ? true : undefined}
        aria-describedby={describedBy(shell)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Shell>
  );
}
