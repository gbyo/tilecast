import { useTranslation } from "react-i18next";
import { DateTimeInput } from "./date-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

export type TimeRangePreset = "24h" | "7d" | "30d" | "custom";

export type ResolvedTimeRange = {
  from: string;
  to: string;
  /** How the range reads in prose, such as "last 24 hours". */
  label: string;
  /**
   * The equally long window immediately before this one, so a metric can be
   * compared against a like-for-like period. Absent for a custom range with
   * only one bound supplied, where the comparison would be arbitrary.
   */
  previous?: { from: string; to: string; label: string };
};

const presetDays: Record<Exclude<TimeRangePreset, "custom">, number> = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
};

// Prose labels for activity sentences ("Measured over last 24 hours").
// They stay English until the activity namespace converts and translates
// those sentences with their full context.
const presetLabels: Record<TimeRangePreset, string> = {
  "24h": "last 24 hours",
  "7d": "last 7 days",
  "30d": "last 30 days",
  custom: "the selected range",
};

/** A bound is usable only if it is present and parses to a real instant. */
function parseBound(value: string) {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Turns the picker's state into absolute bounds plus the preceding window of
 * the same length. Accepts `now` so callers and tests can pin the clock.
 */
export function resolveTimeRange(
  preset: TimeRangePreset,
  customFrom = "",
  customTo = "",
  now: Date = new Date(),
): ResolvedTimeRange {
  const custom = preset === "custom";
  // Bounds arrive from the URL, so they can be absent, unparseable, or
  // reversed. An unusable bound falls back to the preset behaviour rather than
  // producing an Invalid Date, whose toISOString() would throw and blank the
  // page.
  let parsedFrom = custom ? parseBound(customFrom) : undefined;
  let parsedTo = custom ? parseBound(customTo) : undefined;
  // Both bounds are real but the wrong way round: honour the pair a person
  // supplied rather than reporting on a negative span.
  if (parsedFrom && parsedTo && parsedFrom > parsedTo)
    [parsedFrom, parsedTo] = [parsedTo, parsedFrom];
  const to = parsedTo ?? now;
  const from =
    parsedFrom ??
    new Date(to.getTime() - presetDays[custom ? "24h" : preset] * 86_400_000);
  const span = to.getTime() - from.getTime();
  const range: ResolvedTimeRange = {
    from: from.toISOString(),
    to: to.toISOString(),
    label: presetLabels[preset],
  };
  // A custom range missing a bound has no defensible length to step back by,
  // and a reversed one would place the comparison window after the range.
  if (custom && (!parsedFrom || !parsedTo || span <= 0)) return range;
  return {
    ...range,
    previous: {
      from: new Date(from.getTime() - span).toISOString(),
      to: range.from,
      label: custom
        ? "the preceding period"
        : `previous ${presetLabels[preset].replace("last ", "")}`,
    },
  };
}

const timeRangeItems: {
  value: TimeRangePreset;
  labelKey:
    | "range.presets.day"
    | "range.presets.week"
    | "range.presets.month"
    | "range.presets.custom";
}[] = [
  { value: "24h", labelKey: "range.presets.day" },
  { value: "7d", labelKey: "range.presets.week" },
  { value: "30d", labelKey: "range.presets.month" },
  { value: "custom", labelKey: "range.presets.custom" },
];

export function TimeRangePicker({
  preset,
  onPresetChange,
  customFrom,
  customTo,
  onCustomFromChange,
  onCustomToChange,
  className = "",
}: {
  preset: TimeRangePreset;
  onPresetChange: (preset: TimeRangePreset) => void;
  customFrom: string;
  customTo: string;
  onCustomFromChange: (value: string) => void;
  onCustomToChange: (value: string) => void;
  className?: string;
}) {
  const { t } = useTranslation("schedules");
  const items = timeRangeItems.map((item) => ({
    value: item.value,
    label: t(item.labelKey),
  }));
  return (
    <div
      className={`flex flex-wrap items-end gap-2 ${className}`.trim()}
      role="group"
      aria-label={t("range.label")}
    >
      <span className="grid gap-1 text-xs font-medium">
        <span>{t("range.label")}</span>
        <Select
          items={items}
          value={preset}
          onValueChange={(next) => {
            if (next) onPresetChange(next);
          }}
        >
          <SelectTrigger className="w-40" aria-label={t("range.label")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </span>
      {preset === "custom" && (
        <>
          <label className="grid gap-1 text-xs font-medium">
            <span>{t("range.from")}</span>
            <DateTimeInput
              id="time-range-from"
              aria-label="From"
              value={customFrom}
              max={customTo || undefined}
              onChange={onCustomFromChange}
            />
          </label>
          <label className="grid gap-1 text-xs font-medium">
            <span>{t("range.to")}</span>
            <DateTimeInput
              id="time-range-to"
              aria-label="To"
              value={customTo}
              min={customFrom || undefined}
              onChange={onCustomToChange}
            />
          </label>
        </>
      )}
    </div>
  );
}
