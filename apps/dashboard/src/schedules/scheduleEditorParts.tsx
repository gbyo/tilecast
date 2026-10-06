/**
 * Small pieces every section of the Schedule editor shares. A section is a
 * heading, an optional sentence, and fields: no surface of its own, so the
 * whole rule reads as one continuous document separated by rules.
 */
import type { ReactNode } from "react";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "../components/ui/field";
import { RadioGroupItem } from "../components/ui/radio-group";

/**
 * The editor fills the viewport below the Studio editor header (3.25 rem), so
 * the form and the outcome pane scroll on their own and the page never does.
 * The shell gives an editor route a minimum height, not a fixed one, so a tall
 * form would otherwise stretch the whole page. Keep in step with the header.
 */
export const EDITOR_VIEWPORT_HEIGHT = "h-[calc(100svh-3.25rem)]";

export function EditorSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-heading`} className="grid gap-4">
      <div className="grid gap-1">
        <h2 id={`${id}-heading`} className="text-base font-semibold">
          {title}
        </h2>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

/**
 * One option of a RadioGroup, as a titled, described card. The whole card is
 * the label, so clicking anywhere chooses it.
 */
export function ChoiceCard({
  id,
  value,
  title,
  description,
  disabled,
}: {
  id: string;
  value: string;
  title: string;
  description: string;
  disabled?: boolean;
}) {
  return (
    <FieldLabel htmlFor={id}>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldTitle>{title}</FieldTitle>
          <FieldDescription>{description}</FieldDescription>
        </FieldContent>
        <RadioGroupItem id={id} value={value} disabled={disabled} />
      </Field>
    </FieldLabel>
  );
}
