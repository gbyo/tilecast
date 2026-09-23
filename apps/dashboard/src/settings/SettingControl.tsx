import { Select } from "../components/legacy-ui";
import { useId, useMemo, useState } from "react";
import { signalColors } from "@tilecast/design-tokens/values";
import type { SettingDefinition } from "../api/types";
import { enumLabel } from "./settingDisplay";
import {
  normalizeLocalTime,
  normalizeTimezone,
  timezoneLabel,
  timezoneOptions,
} from "./settingValues";

const weekdays = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [7, "Sun"],
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
  const id = useId();
  if (definition.type === "bool")
    return (
      <Switch
        id={id}
        label={definition.title}
        checked={Boolean(value)}
        disabled={disabled}
        onChange={onChange}
      />
    );
  if (definition.type === "timezone") {
    const timezone = normalizeTimezone(value);
    return (
      <Select
        id={id}
        aria-label={definition.title}
        value={timezone}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {timezoneOptions(timezone).map((option) => (
          <option key={option} value={option}>
            {timezoneLabel(option)}
          </option>
        ))}
      </Select>
    );
  }
  if (definition.type === "enum")
    return (
      <Select
        id={id}
        aria-label={definition.title}
        value={String(value)}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {definition.allowed?.map((option) => (
          <option key={option} value={option}>
            {enumLabel(option)}
          </option>
        ))}
      </Select>
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
        unit={duration.label}
        multiplier={duration.multiplier}
        disabled={disabled}
        onChange={onChange}
      />
    );
  if (definition.type === "local_time")
    return (
      <input
        id={id}
        aria-label={definition.title}
        type="time"
        value={normalizeLocalTime(value)}
        step={60}
        disabled={disabled}
        onChange={(event) => onChange(normalizeLocalTime(event.target.value))}
      />
    );
  const numeric = ["int", "int64", "float"].includes(definition.type);
  return (
    <input
      id={id}
      aria-label={definition.title}
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

function Switch({
  id,
  label,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      id={id}
      aria-label={label}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className="setting-switch"
      onClick={() => onChange(!checked)}
    >
      <span aria-hidden="true" />
      <strong>{checked ? "On" : "Off"}</strong>
    </button>
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
  const selected = new Set(Array.isArray(value) ? value.map(Number) : []);
  return (
    <div className="weekday-picker" aria-label="Active days">
      {weekdays.map(([day, label]) => (
        <button
          key={day}
          type="button"
          aria-pressed={selected.has(day)}
          disabled={disabled}
          onClick={() => {
            const next = new Set(selected);
            if (next.has(day) && next.size > 1) next.delete(day);
            else next.add(day);
            onChange([...next].sort());
          }}
        >
          {label}
        </button>
      ))}
    </div>
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
  const values = Array.isArray(value) ? value.map(String) : [];
  const [entry, setEntry] = useState("");
  const invalid = entry.length > 0 && !packagePattern.test(entry.trim());
  return (
    <div className="package-editor">
      <div>
        <input
          aria-label="Android package name"
          value={entry}
          disabled={disabled}
          placeholder="com.android.settings"
          onChange={(event) => setEntry(event.target.value)}
        />
        <button
          type="button"
          className="button button--quiet"
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
          Add
        </button>
      </div>
      {invalid && (
        <small className="field-error">
          Enter an Android package name such as com.android.settings.
        </small>
      )}
      <ul>
        {values.map((item) => (
          <li key={item}>
            <code>{item}</code>
            <button
              type="button"
              aria-label={`Remove ${item}`}
              disabled={disabled}
              onClick={() => onChange(values.filter((value) => value !== item))}
            >
              Remove
            </button>
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
  const initial = useMemo(
    () => (value >= byteUnits.TB ? "TB" : value >= byteUnits.GB ? "GB" : "MB"),
    [value],
  );
  const [unit, setUnit] = useState<keyof typeof byteUnits>(initial);
  return (
    <div className="unit-input">
      <input
        aria-label={definition.title}
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
      <Select
        aria-label={`${definition.title} unit`}
        value={unit}
        disabled={disabled}
        onChange={(event) =>
          setUnit(event.target.value as keyof typeof byteUnits)
        }
      >
        {Object.keys(byteUnits).map((item) => (
          <option key={item}>{item}</option>
        ))}
      </Select>
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
  return (
    <div className="unit-input">
      <input
        aria-label={definition.title}
        type="number"
        min={definition.min ? definition.min / multiplier : undefined}
        max={definition.max ? definition.max / multiplier : undefined}
        value={value / multiplier}
        disabled={disabled}
        onChange={(event) =>
          onChange(Math.round(Number(event.target.value) * multiplier))
        }
      />
      <span>{unit}</span>
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
    <div className="unit-input">
      <input
        aria-label={definition.title}
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
      <Select
        aria-label={`${definition.title} unit`}
        value={unit}
        disabled={disabled}
        onChange={(event) => setUnit(event.target.value as keyof typeof units)}
      >
        {Object.keys(units).map((option) => (
          <option key={option}>{option}</option>
        ))}
      </Select>
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
  const valid = /^#[0-9A-Fa-f]{6}$/.test(value);
  return (
    <div className="color-control">
      <input
        aria-label="Color picker"
        type="color"
        value={valid ? value : signalColors.colorInputFallback}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value.toUpperCase())}
      />
      <input
        id={id}
        aria-label="Hex color"
        value={value}
        disabled={disabled}
        aria-invalid={!valid}
        onChange={(event) => onChange(event.target.value.toUpperCase())}
      />
      {!valid && (
        <small className="field-error">Use a six-digit hex color.</small>
      )}
    </div>
  );
}
function unitFor(definition: SettingDefinition) {
  if (definition.key.endsWith("_minutes"))
    return { label: "minutes", multiplier: 1 };
  if (definition.key.endsWith("_hours"))
    return { label: "hours", multiplier: 1 };
  if (definition.key.endsWith("_days")) return { label: "days", multiplier: 1 };
  return undefined;
}
