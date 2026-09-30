// The Widget live preview normally renders at the current instant, which is right for authoring but
// hides everything a Widget only does at another moment: a countdown near zero, a bell schedule's
// next period, a date format on a different weekday. These helpers back a "preview at" override the
// editors hand to `DeclarativePresentationPreview` as its `now`.

export type PreviewTimeMode = "live" | "fixed";

export type PreviewTime = {
  mode: PreviewTimeMode;
  // A `datetime-local` value ("YYYY-MM-DDTHH:mm"), read in the author's own time zone.
  value: string;
};

/** Formats an instant as the `datetime-local` value for the author's time zone. */
export function previewTimeInputValue(date: Date): string {
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Reads a `datetime-local` value as an instant in the author's time zone. Widgets still format in
 * whatever zone they are configured for, so the chosen wall-clock time is only the author's view of
 * the instant being previewed.
 */
export function parsePreviewTimeInput(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    value,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? 0),
  );
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * The `now` a preview should render at: `undefined` keeps the preview live, so the ticking clock in
 * `DeclarativePresentationPreview` stays in charge. An unparseable value also falls back to live
 * rather than freezing the preview on an invalid instant.
 */
export function resolvePreviewNow(time: PreviewTime): Date | undefined {
  if (time.mode !== "fixed") return undefined;
  return parsePreviewTimeInput(time.value) ?? undefined;
}

/** The local calendar date used to select records for a fixed preview instant. */
export function resolvePreviewDate(time: PreviewTime): string | undefined {
  const now = resolvePreviewNow(time);
  if (!now) return undefined;
  return previewTimeInputValue(now).slice(0, 10);
}

export function initialPreviewTime(now = new Date()): PreviewTime {
  return { mode: "live", value: previewTimeInputValue(now) };
}
