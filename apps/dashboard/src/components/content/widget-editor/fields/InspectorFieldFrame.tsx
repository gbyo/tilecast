import type { ReactNode } from "react";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { fieldDomId, type InspectorFieldProps } from "./fieldContext";

/** Label, control, description, and error in the standard vertical layout. */
export function InspectorFieldFrame({
  path,
  field,
  error,
  labelFor,
  children,
}: {
  path: string;
  field: InspectorFieldProps["field"];
  error: string | undefined;
  /** The control the label names; omitted for grouped controls. */
  labelFor?: string;
  children: ReactNode;
}) {
  const id = fieldDomId(path);
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel id={`${id}-label`} htmlFor={labelFor ?? id}>
        {field.label}
        {field.required && (
          <span aria-hidden="true" className="text-muted-foreground">
            *
          </span>
        )}
      </FieldLabel>
      {children}
      {field.description && (
        <FieldDescription id={`${id}-description`}>
          {field.description}
        </FieldDescription>
      )}
      {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </Field>
  );
}
