import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { signalColors } from "@tilecast/design-tokens/values";
import type { SettingDefinition } from "../api/types";
import { enumLabel, titleFor } from "./settingDisplay";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "../components/ui/combobox";
import {
  normalizeLocalTime,
  normalizeTimezone,
  canonicalizeLocale,
  isTimezoneIdentifier,
  localeSuggestions,
  timezoneLabel,
  timezoneOptions,
} from "./settingValues";
import { Button } from "../components/ui/button";
import { FieldDescription, FieldError } from "../components/ui/field";
import { Input } from "../components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "../components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";

const weekdays = [
  [1, "monday"],
  [2, "tuesday"],
  [3, "wednesday"],
  [4, "thursday"],
  [5, "friday"],
  [6, "saturday"],
  [7, "sunday"],
] as const;
const packagePattern = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const byteUnits = { MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 } as const;

export function SettingControl({
  definition,
  value,
  disabled,
  onChange,
}: {
  definition: SettingDefinition;
  value: unknown;
  disabled?: boolean;
  onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const id = useId();
  const title = titleFor(definition);
  if (definition.type === "bool") {
    const checked = Boolean(value);
    return (
      <span className="inline-flex items-center gap-2">
        <Switch
          id={id}
          aria-label={title}
          checked={checked}
          disabled={disabled}
          onCheckedChange={(next) => onChange(next)}
        />
        <span aria-hidden="true" className="text-sm text-muted-foreground">
          {checked ? t("controls.bool.on") : t("controls.bool.off")}
        </span>
      </span>
    );
  }
  if (definition.type === "timezone") {
    return (
      <TimezonePicker
        label={title}
        value={normalizeTimezone(value)}
        disabled={disabled}
        onChange={onChange}
      />
    );
  }
  if (definition.type === "locale")
    return (
      <LocalePicker
        id={id}
        label={title}
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        onChange={onChange}
      />
    );
  if (definition.type === "enum")
    return (
      <SettingSelect
        label={title}
        value={String(value)}
        disabled={disabled}
        onChange={(next) => onChange(next)}
        options={(definition.allowed ?? []).map((option) => ({
          value: option,
          label: enumLabel(option),
        }))}
      />
    );
  if (definition.type === "weekday_list")
    return (
      <WeekdayPicker value={value} disabled={disabled} onChange={onChange} />
    );
  if (definition.type === "package_list")
    return (
      <PackageList value={value} disabled={disabled} onChange={onChange} />
    );
  if (definition.key === "player.playback.default_volume")
    return (
      <UnitInput
        definition={definition}
        value={Number(value)}
        unit="%"
        multiplier={0.01}
        disabled={disabled}
        onChange={onChange}
      />
    );
  if (definition.type === "int64" && definition.key.includes("bytes"))
    return (
      <ByteInput
        definition={definition}
        value={Number(value)}
        disabled={disabled}
        onChange={onChange}
      />
    );
  if (definition.type === "color")
    return (
      <ColorInput
        id={id}
        value={String(value)}
        disabled={disabled}
        onChange={onChange}
      />
    );
  if (definition.key.endsWith("_seconds"))
    return (
      <DurationInput
        definition={definition}
        value={Number(value)}
        disabled={disabled}
        onChange={onChange}
      />
    );
  const duration = unitFor(definition);
  if (duration)
    return (
      <UnitInput
        definition={definition}
        value={Number(value)}
        unit={t(duration.labelKey)}
        multiplier={duration.multiplier}
        disabled={disabled}
        onChange={onChange}
      />
    );
  if (definition.type === "local_time")
    return (
      <Input
        id={id}
        aria-label={title}
        type="time"
        value={normalizeLocalTime(value)}
        step={60}
        disabled={disabled}
        onChange={(event) => onChange(normalizeLocalTime(event.target.value))}
      />
    );
  const numeric = ["int", "int64", "float"].includes(definition.type);
  return (
    <Input
      id={id}
      aria-label={title}
      type={
        numeric
          ? "number"
          : definition.type === "email"
            ? "email"
            : definition.type === "local_time"
              ? "time"
              : "text"
      }
      value={
        typeof value === "string" || typeof value === "number"
          ? String(value)
          : ""
      }
      min={definition.min}
      max={definition.max}
      step={definition.type === "float" ? "0.01" : "1"}
      disabled={disabled}
      onChange={(event) =>
        onChange(numeric ? Number(event.target.value) : event.target.value)
      }
    />
  );
}

function SettingSelect({
  label,
  value,
  disabled,
  onChange,
  options,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <Select
      items={options}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next);
      }}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function TimezonePicker({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation("settings");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const zones = useMemo(() => timezoneOptions(value), [value]);
  const candidate = normalizeTimezone(search);
  const options = useMemo(
    () =>
      isTimezoneIdentifier(candidate) && !zones.includes(candidate)
        ? [...zones, candidate]
        : zones,
    [candidate, zones],
  );
  const filtered = options.filter((zone) =>
    timezoneLabel(zone).toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <Combobox
      items={options}
      filteredItems={filtered}
      value={value}
      open={open}
      inputValue={open ? search : timezoneLabel(value)}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setSearch("");
      }}
      disabled={disabled}
      onValueChange={(next) => {
        if (typeof next === "string" && isTimezoneIdentifier(next))
          onChange(next);
      }}
      itemToStringLabel={timezoneLabel}
      onInputValueChange={setSearch}
    >
      <ComboboxInput
        aria-label={label}
        placeholder={t("controls.timezone.search")}
      />
      <ComboboxContent>
        <ComboboxEmpty>{t("controls.timezone.empty")}</ComboboxEmpty>
        <ComboboxList>
          {(zone: string) => (
            <ComboboxItem key={zone} value={zone}>
              {timezoneLabel(zone)}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function LocalePicker({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation("settings");
  const listId = `${id}-common-locales`;
  const invalid = value.trim().length > 0 && canonicalizeLocale(value) === null;
  return (
    <div className="grid gap-1.5">
      <Input
        id={id}
        aria-label={label}
        aria-invalid={invalid}
        list={listId}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => {
          const canonical = canonicalizeLocale(value);
          if (canonical) onChange(canonical);
        }}
      />
      <datalist id={listId}>
        {localeSuggestions().map((tag) => (
          <option key={tag} value={tag} />
        ))}
      </datalist>
      <FieldDescription>{t("controls.locale.hint")}</FieldDescription>
      {invalid && <FieldError>{t("controls.locale.invalid")}</FieldError>}
    </div>
  );
}

function WeekdayPicker({
  value,
  disabled,
  onChange,
}: {
  value: unknown;
  disabled?: boolean;
  onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const selected = Array.isArray(value) ? value.map((day) => String(day)) : [];
  return (
    <ToggleGroup
      multiple
      aria-label={t("controls.weekdays.label")}
      value={selected}
      disabled={disabled}
      onValueChange={(next) => {
        const days = next.map(Number).sort((a, b) => a - b);
        if (days.length > 0) onChange(days);
      }}
    >
      {weekdays.map(([day, dayKey]) => (
        <ToggleGroupItem
          key={day}
          value={String(day)}
          aria-label={t(`controls.weekdays.${dayKey}`)}
        >
          {t(`controls.weekdays.${dayKey}`)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
function PackageList({
  value,
  disabled,
  onChange,
}: {
  value: unknown;
  disabled?: boolean;
  onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const values = Array.isArray(value) ? value.map(String) : [];
  const [entry, setEntry] = useState("");
  const invalid = entry.length > 0 && !packagePattern.test(entry.trim());
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label={t("controls.packageList.label")}
          value={entry}
          disabled={disabled}
          // i18n-ignore: example package name, not language text
          placeholder="com.android.settings"
          onChange={(event) => setEntry(event.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={
            disabled ||
            invalid ||
            !entry.trim() ||
            values.includes(entry.trim())
          }
          onClick={() => {
            onChange([...values, entry.trim()]);
            setEntry("");
          }}
        >
          {t("controls.packageList.add")}
        </Button>
      </div>
      {invalid && <FieldError>{t("controls.packageList.invalid")}</FieldError>}
      <ul className="grid gap-1">
        {values.map((item) => (
          <li key={item} className="flex flex-wrap items-center gap-2 text-sm">
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
              {item}
            </code>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={t("controls.packageList.removeItem", { item })}
              disabled={disabled}
              onClick={() => onChange(values.filter((value) => value !== item))}
            >
              {t("controls.packageList.remove")}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
function ByteInput({
  definition,
  value,
  disabled,
  onChange,
}: {
  definition: SettingDefinition;
  value: number;
  disabled?: boolean;
  onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const title = titleFor(definition);
  const initial = useMemo(
    () => (value >= byteUnits.TB ? "TB" : value >= byteUnits.GB ? "GB" : "MB"),
    [value],
  );
  const [unit, setUnit] = useState<keyof typeof byteUnits>(initial);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        aria-label={title}
        type="number"
        min={definition.min ? definition.min / byteUnits[unit] : undefined}
        max={definition.max ? definition.max / byteUnits[unit] : undefined}
        step="0.25"
        value={Number((value / byteUnits[unit]).toFixed(3))}
        disabled={disabled}
        onChange={(event) =>
          onChange(Math.round(Number(event.target.value) * byteUnits[unit]))
        }
      />
      <SettingSelect
        label={t("controls.unitLabel", { title })}
        value={unit}
        disabled={disabled}
        onChange={(next) => setUnit(next as keyof typeof byteUnits)}
        options={Object.keys(byteUnits).map((item) => ({
          value: item,
          label: item,
        }))}
      />
    </div>
  );
}
function UnitInput({
  definition,
  value,
  unit,
  multiplier,
  disabled,
  onChange,
}: {
  definition: SettingDefinition;
  value: number;
  unit: string;
  multiplier: number;
  disabled?: boolean;
  onChange: (value: unknown) => void;
}) {
  const title = titleFor(definition);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <InputGroup className="w-40">
        <InputGroupInput
          aria-label={title}
          type="number"
          min={definition.min ? definition.min / multiplier : undefined}
          max={definition.max ? definition.max / multiplier : undefined}
          value={value / multiplier}
          disabled={disabled}
          onChange={(event) =>
            onChange(Math.round(Number(event.target.value) * multiplier))
          }
        />
        <InputGroupAddon align="inline-end">{unit}</InputGroupAddon>
      </InputGroup>
    </div>
  );
}
function DurationInput({
  definition,
  value,
  disabled,
  onChange,
}: {
  definition: SettingDefinition;
  value: number;
  disabled?: boolean;
  onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const title = titleFor(definition);
  const units = { seconds: 1, minutes: 60, hours: 3600 } as const;
  const initial =
    value >= 3600 && value % 3600 === 0
      ? "hours"
      : value >= 60 && value % 60 === 0
        ? "minutes"
        : "seconds";
  const [unit, setUnit] = useState<keyof typeof units>(initial);
  const multiplier = units[unit];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        aria-label={title}
        type="number"
        min={definition.min != null ? definition.min / multiplier : undefined}
        max={definition.max != null ? definition.max / multiplier : undefined}
        step={unit === "seconds" ? 1 : 0.5}
        value={Number((value / multiplier).toFixed(2))}
        disabled={disabled}
        onChange={(event) =>
          onChange(Math.round(Number(event.target.value) * multiplier))
        }
      />
      <SettingSelect
        label={t("controls.unitLabel", { title })}
        value={unit}
        disabled={disabled}
        onChange={(next) => setUnit(next as keyof typeof units)}
        options={(Object.keys(units) as (keyof typeof units)[]).map(
          (option) => ({
            value: option,
            label: t(`controls.durationUnits.${option}`),
          }),
        )}
      />
    </div>
  );
}
function ColorInput({
  id,
  value,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  disabled?: boolean;
  onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const valid = /^#[0-9A-Fa-f]{6}$/.test(value);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        aria-label={t("controls.color.picker")}
        type="color"
        className="h-8 w-10 cursor-pointer rounded-md border border-border bg-background p-0.5 disabled:cursor-not-allowed disabled:opacity-50"
        value={valid ? value : signalColors.colorInputFallback}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value.toUpperCase())}
      />
      <Input
        id={id}
        aria-label={t("controls.color.hex")}
        value={value}
        disabled={disabled}
        aria-invalid={!valid}
        onChange={(event) => onChange(event.target.value.toUpperCase())}
      />
      {!valid && <FieldError>{t("controls.color.hint")}</FieldError>}
    </div>
  );
}
function unitFor(definition: SettingDefinition): {
  labelKey:
    | "controls.timeUnits.minutes"
    | "controls.timeUnits.hours"
    | "controls.timeUnits.days";
  multiplier: number;
} | null {
  if (definition.key.endsWith("_minutes"))
    return { labelKey: "controls.timeUnits.minutes", multiplier: 1 };
  if (definition.key.endsWith("_hours"))
    return { labelKey: "controls.timeUnits.hours", multiplier: 1 };
  if (definition.key.endsWith("_days"))
    return { labelKey: "controls.timeUnits.days", multiplier: 1 };
  return null;
}
