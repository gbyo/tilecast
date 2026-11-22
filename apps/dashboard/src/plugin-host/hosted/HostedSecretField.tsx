import { useTranslation } from "react-i18next";
import type { ConfigField } from "@tilecast/config-schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { SecretState } from "./model";

/**
 * A write-only secret. Studio never receives the value: it shows whether one
 * is set, takes a new value, and can clear the stored one. A secret the
 * server cannot decrypt after a restore reads "needs a new value".
 */
export function HostedSecretField({
  field,
  label,
  description,
  state,
  value,
  cleared,
  readOnly,
  error,
  onValue,
  onClear,
}: {
  field: ConfigField;
  label: string;
  description?: string;
  state: SecretState;
  value: string;
  cleared: boolean;
  readOnly: boolean;
  error?: string;
  onValue: (value: string) => void;
  onClear: (cleared: boolean) => void;
}) {
  const { t } = useTranslation("plugins");
  const id = `secret-${field.key}`;
  const effective: SecretState = cleared ? "not_set" : state;
  return (
    <Field data-invalid={error ? true : undefined}>
      <div className="flex flex-wrap items-center gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Badge
          variant={
            effective === "set"
              ? "default"
              : effective === "needs_value"
                ? "destructive"
                : "secondary"
          }
        >
          {t(`secrets.state.${effective}`)}
        </Badge>
      </div>
      {description && (
        <FieldDescription id={`${id}-description`}>{description}</FieldDescription>
      )}
      <div className="flex gap-2">
        <Input
          id={id}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={value}
          disabled={readOnly}
          maxLength={field.maxLength}
          placeholder={
            effective === "set" ? t("secrets.replacePlaceholder") : t("secrets.enterPlaceholder")
          }
          aria-describedby={description ? `${id}-description` : undefined}
          aria-invalid={error ? true : undefined}
          onChange={(event) => onValue(event.target.value)}
        />
        {state !== "not_set" && !readOnly && (
          <Button
            type="button"
            variant="outline"
            onClick={() => onClear(!cleared)}
          >
            {cleared ? t("secrets.keep") : t("secrets.clear")}
          </Button>
        )}
      </div>
      {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </Field>
  );
}
