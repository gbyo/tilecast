import { useTranslation } from "react-i18next";
import { Field, FieldError, FieldLabel } from "../components/ui/field";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "../components/ui/input-otp";
import { PAIRING_CODE_ALPHABET } from "./pairingQr";

/**
 * Normalizes raw code entry the way the server does: uppercase with spaces
 * and hyphens removed, then drops anything outside the pairing alphabet —
 * including the ambiguous characters the server intentionally excludes.
 */
export function filterPairingCodeInput(value: string): string {
  let filtered = "";
  for (const character of value.toUpperCase()) {
    if (PAIRING_CODE_ALPHABET.includes(character)) filtered += character;
  }
  return filtered.slice(0, 6);
}

/**
 * The six-slot pairing code entry, grouped 3 + 3. The value stays one
 * string; the slots are presentation owned by the shared InputOTP primitive.
 */
export function PairingCodeInput({
  id = "pairing-code",
  value,
  onChange,
  error,
  autoFocus,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation("screens");
  const errorId = `${id}-error`;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{t("pair.codeLabel")}</FieldLabel>
      <InputOTP
        id={id}
        maxLength={6}
        value={value}
        onChange={(next) => onChange(filterPairingCodeInput(next))}
        pasteTransformer={filterPairingCodeInput}
        pushPasswordManagerStrategy="none"
        autoFocus={autoFocus}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
      >
        <InputOTPGroup>
          <InputOTPSlot index={0} className="size-11 font-mono text-base" />
          <InputOTPSlot index={1} className="size-11 font-mono text-base" />
          <InputOTPSlot index={2} className="size-11 font-mono text-base" />
        </InputOTPGroup>
        <InputOTPSeparator />
        <InputOTPGroup>
          <InputOTPSlot index={3} className="size-11 font-mono text-base" />
          <InputOTPSlot index={4} className="size-11 font-mono text-base" />
          <InputOTPSlot index={5} className="size-11 font-mono text-base" />
        </InputOTPGroup>
      </InputOTP>
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </Field>
  );
}
