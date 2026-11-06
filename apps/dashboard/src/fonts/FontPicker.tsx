import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Button } from "../components/ui/button";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { useStudioSession } from "../plugin-host/session";
import { GoogleFontDialog } from "../settings/fonts/GoogleFontDialog";
import { useLibraryFonts } from "./libraryFonts";

/**
 * What a person picked: an organization library family, or one of the
 * built-in choices the caller offers (a bundled Layout font, or "the
 * Player's own face" for a plugin).
 */
export type FontChoice =
  { kind: "library"; id: string } | { kind: "builtIn"; value: string };

export interface FontPickerBuiltIn {
  value: string;
  label: string;
}

export interface FontPickerProps {
  /** Id of the trigger, for the caller's label and tests. */
  id: string;
  label: string;
  value: FontChoice;
  onChange: (choice: FontChoice) => void;
  /** Choices after the organization fonts. At least one is required. */
  builtIn: readonly FontPickerBuiltIn[];
  /** Heading of the built-in group. Defaults to "Built-in fonts". */
  builtInLabel?: string;
}

const LIBRARY_PREFIX = "library:";
const BUILT_IN_PREFIX = "builtin:";

const toValue = (choice: FontChoice) =>
  choice.kind === "library"
    ? LIBRARY_PREFIX + choice.id
    : BUILT_IN_PREFIX + choice.value;

function fromValue(value: string): FontChoice {
  return value.startsWith(LIBRARY_PREFIX)
    ? { kind: "library", id: value.slice(LIBRARY_PREFIX.length) }
    : { kind: "builtIn", value: value.slice(BUILT_IN_PREFIX.length) };
}

/**
 * The shared font choice for Studio and for plugins (`@tilecast/studio`):
 * the organization's library families first, then the caller's built-in
 * choices, with a shortcut for an administrator to add fonts in place.
 *
 * A chosen family that has since left the library stays visible and
 * selected as "removed", so the control never shows a different font than
 * the one stored.
 */
export function FontPicker({
  id,
  label,
  value,
  onChange,
  builtIn,
  builtInLabel,
}: FontPickerProps) {
  const { t } = useTranslation("settings");
  const session = useStudioSession();
  const library = useLibraryFonts();
  const [adding, setAdding] = useState(false);
  const selected = toValue(value);
  const libraryOptions = library.families.map((family) => ({
    value: LIBRARY_PREFIX + family.id,
    label: family.family,
  }));
  if (
    value.kind === "library" &&
    !libraryOptions.some((option) => option.value === selected)
  ) {
    libraryOptions.push({
      value: selected,
      label: library.isLoading
        ? t("fonts.picker.loadingFont")
        : t("fonts.picker.missing"),
    });
  }
  const builtInOptions = builtIn.map((option) => ({
    value: BUILT_IN_PREFIX + option.value,
    label: option.label,
  }));
  const canManage = session.can("settings.manage");
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        value={selected}
        onValueChange={(next) => onChange(fromValue(next ?? selected))}
        items={[...libraryOptions, ...builtInOptions]}
      >
        <SelectTrigger id={id} aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {libraryOptions.length > 0 && (
            <SelectGroup>
              <SelectLabel>{t("fonts.picker.libraryGroup")}</SelectLabel>
              {libraryOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          <SelectGroup>
            <SelectLabel>
              {builtInLabel ?? t("fonts.picker.builtInGroup")}
            </SelectLabel>
            {builtInOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {canManage ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setAdding(true)}
          >
            {t("fonts.picker.add")}
          </Button>
          <FieldDescription>
            <Link to="/settings/fonts">{t("fonts.picker.manage")}</Link>
          </FieldDescription>
        </div>
      ) : null}
      {adding ? (
        <GoogleFontDialog
          onClose={() => setAdding(false)}
          onAdded={(family) => {
            setAdding(false);
            // The new family is the choice right away.
            onChange({ kind: "library", id: family.id });
          }}
        />
      ) : null}
    </Field>
  );
}
