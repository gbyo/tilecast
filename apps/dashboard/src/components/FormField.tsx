import type { InputHTMLAttributes } from "react";
import { Field, FieldDescription, FieldError, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";

type Props = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
  hint?: string;
};

export function FormField({
  label,
  error,
  hint,
  id,
  "aria-describedby": describedBy,
  ...input
}: Props) {
  const messageId = `${id}-message`;
  const ariaDescribedBy = [describedBy, error || hint ? messageId : undefined]
    .filter(Boolean)
    .join(" ") || undefined;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        aria-invalid={Boolean(error)}
        aria-describedby={ariaDescribedBy}
        {...input}
      />
      {error ? (
        <FieldError id={messageId}>{error}</FieldError>
      ) : hint ? (
        <FieldDescription id={messageId}>{hint}</FieldDescription>
      ) : null}
    </Field>
  );
}
