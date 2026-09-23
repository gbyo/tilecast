import { useState } from "react";
import { CalendarDays, X } from "lucide-react";
import { cn } from "cn";
import { Button, buttonVariants } from "./ui/button";
import { Calendar } from "./ui/calendar";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

function parseDatePart(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function formatDatePart(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function displayDate(value: string): string {
  const date = parseDatePart(value);
  return date ? date.toLocaleDateString() : "Pick a date";
}

/**
 * Date-only picker (Popover + Calendar) for `YYYY-MM-DD` values.
 *
 * The string contract matches a native `type="date"` input exactly, so
 * callers keep the same backend values and range validation.
 */
export function DateInput({
  id,
  value,
  onChange,
  min,
  max,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const minDate = min ? parseDatePart(min) : undefined;
  const maxDate = max ? parseDatePart(max) : undefined;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              id={id}
              type="button"
              disabled={disabled}
              className={cn(
                buttonVariants({ variant: "outline" }),
                "min-w-36 justify-start font-normal",
              )}
            />
          }
        >
          <CalendarDays
            size={15}
            aria-hidden="true"
            className="shrink-0 text-muted-foreground"
          />
          <span className={value ? "" : "text-muted-foreground"}>
            {displayDate(value)}
          </span>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-0">
          <Calendar
            mode="single"
            captionLayout="dropdown"
            selected={parseDatePart(value)}
            defaultMonth={
              parseDatePart(value) ??
              (max ? parseDatePart(max) : undefined) ??
              new Date()
            }
            disabled={[
              ...(minDate ? [{ before: minDate }] : []),
              ...(maxDate ? [{ after: maxDate }] : []),
            ]}
            onSelect={(date) => {
              if (date) {
                onChange(formatDatePart(date));
                setOpen(false);
              }
            }}
          />
        </PopoverContent>
      </Popover>
      {value && !disabled && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Clear date"
          onClick={() => onChange("")}
        >
          <X size={15} aria-hidden="true" />
        </Button>
      )}
    </span>
  );
}

/**
 * Date-and-time picker for `datetime-local` strings (`YYYY-MM-DDTHH:mm`).
 *
 * The date half uses the Popover + Calendar composition; time of day keeps
 * the native time input. The string contract matches a native
 * `type="datetime-local"` input exactly, so callers keep the same backend
 * values and validation.
 */
export function DateTimeInput({
  id,
  value,
  onChange,
  min,
  max,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  disabled?: boolean;
}) {
  const [datePart, rawTimePart] = value.split("T");
  // Accept full ISO instants as well as datetime-local strings: only the
  // leading HH:mm is editable, and it names the same instant.
  const timePart = /^\d{2}:\d{2}/.test(rawTimePart ?? "")
    ? rawTimePart!.slice(0, 5)
    : "";
  // A half-filled value has no valid instant: the missing half falls back to
  // midnight, and clearing the date clears the whole value, mirroring how a
  // native datetime-local never yields a partial string.
  const setDate = (nextDate: string) => {
    if (!nextDate) {
      onChange("");
      return;
    }
    onChange(`${nextDate}T${timePart || "00:00"}`);
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <DateInput
        id={`${id}-date`}
        value={datePart ?? ""}
        min={min?.split("T")[0]}
        max={max?.split("T")[0]}
        disabled={disabled}
        onChange={setDate}
      />
      <Input
        id={`${id}-time`}
        type="time"
        aria-label="Time"
        value={timePart ?? ""}
        disabled={disabled || !datePart}
        onChange={(event) =>
          onChange(
            datePart ? `${datePart}T${event.target.value || "00:00"}` : "",
          )
        }
        className="w-28"
      />
    </span>
  );
}
