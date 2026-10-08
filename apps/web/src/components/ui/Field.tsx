import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

const CONTROL =
  "w-full rounded-field border border-line bg-sunken px-3 text-sm text-ink placeholder:text-faint transition-colors duration-[var(--duration-fast)] hover:border-line-strong focus:border-honey/70 focus:outline-none";

interface FieldProps {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}

// The hint sits outside the <label> so it is not folded into the control's accessible name.
export function Field({ label, hint, children }: FieldProps) {
  return (
    <div className="space-y-1.5">
      <label className="block space-y-1.5">
        <span className="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-muted">{label}</span>
        {children}
      </label>
      {hint ? <p className="text-xs text-faint">{hint}</p> : null}
    </div>
  );
}

export function TextInput({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${CONTROL} h-10 ${className}`} {...rest} />;
}

export function TextArea({ className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${CONTROL} py-2.5 leading-relaxed ${className}`} {...rest} />;
}

export function Select({ className = "", children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`${CONTROL} h-10 appearance-none bg-[length:12px] bg-[right_0.9rem_center] bg-no-repeat pr-9 ${className}`} style={{ backgroundImage: CHEVRON }} {...rest}>
      {children}
    </select>
  );
}

const CHEVRON = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2 4l4 4 4-4' fill='none' stroke='%23a59c8f' stroke-width='1.5'/%3E%3C/svg%3E")`;

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : "Something went wrong";
  return <p role="alert" className="rounded-field border border-err/30 bg-err/10 px-3 py-2 text-sm text-err">{message}</p>;
}
