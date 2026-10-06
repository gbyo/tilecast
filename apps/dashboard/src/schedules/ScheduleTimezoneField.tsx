import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "../components/ui/badge";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "../components/ui/combobox";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../components/ui/field";
import { scheduleQueries } from "../data/schedules";
import {
  isTimezoneIdentifier,
  normalizeTimezone,
  timezoneLabel,
  timezoneOptions,
} from "../settings/settingValues";

/**
 * The schedule's own timezone, chosen from the full IANA list. It is part of
 * the rule: the browser's timezone never stands in for it, and editing from
 * another timezone never converts it.
 */
export function ScheduleTimezoneField({
  value,
  onChange,
  error,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  disabled?: boolean;
}) {
  const { t } = useTranslation("schedules");
  const defaults = useQuery(scheduleQueries.defaults());
  const organizationDefault = defaults.data?.defaultTimezone;
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
  const isDefault = Boolean(value) && value === organizationDefault;
  return (
    <Field data-invalid={error ? true : undefined}>
      <div className="flex flex-wrap items-center gap-2">
        <FieldLabel htmlFor="schedule-timezone">
          {t("timing.timezoneLabel")}
        </FieldLabel>
        {isDefault && (
          <Badge variant="secondary">{t("timing.organizationDefault")}</Badge>
        )}
      </div>
      <Combobox
        items={options}
        filteredItems={filtered}
        value={value}
        open={open}
        disabled={disabled}
        inputValue={open ? search : value ? timezoneLabel(value) : ""}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setSearch("");
        }}
        onValueChange={(next) => {
          if (typeof next === "string" && isTimezoneIdentifier(next))
            onChange(normalizeTimezone(next));
        }}
        itemToStringLabel={timezoneLabel}
        onInputValueChange={setSearch}
      >
        <ComboboxInput
          id="schedule-timezone"
          className="sm:max-w-md"
          placeholder={t("timing.timezoneSearch")}
          aria-invalid={error ? true : undefined}
          aria-describedby={
            error
              ? "schedule-timezone-hint schedule-timezone-error"
              : "schedule-timezone-hint"
          }
        />
        <ComboboxContent>
          <ComboboxEmpty>{t("timing.timezoneEmpty")}</ComboboxEmpty>
          <ComboboxList>
            {(zone: string) => (
              <ComboboxItem key={zone} value={zone}>
                {timezoneLabel(zone)}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      <FieldDescription id="schedule-timezone-hint">
        {!isDefault && organizationDefault
          ? t("timing.timezoneHintOther", { timezone: organizationDefault })
          : t("timing.timezoneHint")}
      </FieldDescription>
      {error && <FieldError id="schedule-timezone-error">{error}</FieldError>}
    </Field>
  );
}
