/**
 * A font field: an organization library family, or the Widget's own
 * Tilecast face (stored as ""). The shared FontPicker lists the library and
 * offers an administrator the same Add fonts shortcut as the Layout editor.
 */
import { useTranslation } from "react-i18next";
import { FieldDescription, FieldError } from "@/components/ui/field";
import { FontPicker } from "@/fonts/FontPicker";
import {
  controlAria,
  fieldText,
  type InspectorFieldProps,
} from "./fieldContext";

const TILECAST_FACE = "tilecast";

export function WidgetFontField({
  field,
  path,
  value,
  onChange,
  readOnly,
  errorFor,
}: InspectorFieldProps) {
  const { t } = useTranslation("content");
  const error = errorFor(path);
  const aria = controlAria(path, field, error);
  const fontId = fieldText(value);
  return (
    <div
      className="grid content-start gap-1"
      data-invalid={error ? true : undefined}
    >
      <FontPicker
        id={aria.id}
        label={field.label}
        value={
          fontId
            ? { kind: "library", id: fontId }
            : { kind: "builtIn", value: TILECAST_FACE }
        }
        onChange={(choice) =>
          onChange(choice.kind === "library" ? choice.id : "")
        }
        builtIn={[
          {
            value: TILECAST_FACE,
            label: t("widgets.editor.fields.tilecastFont"),
          },
        ]}
        disabled={readOnly}
        describedBy={aria["aria-describedby"]}
      />
      {field.description && (
        <FieldDescription id={`${aria.id}-description`}>
          {field.description}
        </FieldDescription>
      )}
      {error && <FieldError id={`${aria.id}-error`}>{error}</FieldError>}
    </div>
  );
}
