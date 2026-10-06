import { CalendarDays, Check, ChevronRight, Clock3 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useFormatLocale } from "../i18n";
import { DateInput, DateTimeInput } from "../components/date-picker";
import { Button } from "../components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../components/ui/field";
import { Input } from "../components/ui/input";
import { RadioGroup } from "../components/ui/radio-group";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import {
  describeScheduleTiming,
  oneTimeDuration,
  scheduleWeekdayLabels,
  scheduleWeekdays,
} from "./scheduleBuilderModel";
import {
  instantToWall,
  problemMessage,
  wallToInstant,
  withScheduleType,
  withTimezone,
  type ScheduleDraft,
} from "./scheduleEditorModel";
import { ChoiceCard, EditorSection } from "./scheduleEditorParts";
import { ScheduleTimezoneField } from "./ScheduleTimezoneField";
import type { ScheduleEditorSession } from "./useScheduleEditorSession";

/** When the schedule runs: weekly or once, in its own timezone. */
export function ScheduleTimingSection({
  session,
  dateRangeOpen,
  onDateRangeOpenChange,
}: {
  session: ScheduleEditorSession;
  dateRangeOpen: boolean;
  onDateRangeOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("schedules");
  const formatLocale = useFormatLocale();
  const { draft, edit, errors, readOnly } = session;
  const message = (field: keyof typeof errors) =>
    errors[field] ? problemMessage(errors[field], t) : null;
  return (
    <EditorSection
      id="schedule-timing"
      title={t("timing.title")}
      description={t("timing.description")}
    >
      <RadioGroup
        aria-label={t("timing.typeLabel")}
        value={draft.type}
        disabled={readOnly}
        onValueChange={(type) =>
          edit((current) =>
            withScheduleType(current, type as ScheduleDraft["type"]),
          )
        }
      >
        <ChoiceCard
          id="schedule-type-weekly"
          value="weekly"
          title={t("timing.typeWeekly")}
          description={t("timing.typeWeeklyHint")}
          disabled={readOnly}
        />
        <ChoiceCard
          id="schedule-type-one-time"
          value="one_time"
          title={t("timing.typeOneTime")}
          description={t("timing.typeOneTimeHint")}
          disabled={readOnly}
        />
      </RadioGroup>
      {draft.type === "weekly" ? (
        <WeeklyFields
          session={session}
          dateRangeOpen={dateRangeOpen}
          onDateRangeOpenChange={onDateRangeOpenChange}
          messages={{
            days: message("days"),
            time: message("time"),
            dateRange: message("dateRange"),
          }}
        />
      ) : (
        <OneTimeFields session={session} message={message("oneTime")} />
      )}
      <ScheduleTimezoneField
        value={draft.timezone}
        disabled={readOnly}
        error={message("timezone")}
        onChange={(timezone) =>
          edit((current) => withTimezone(current, timezone))
        }
      />
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <CalendarDays className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>{describeScheduleTiming(draft, t, formatLocale)}</span>
      </p>
    </EditorSection>
  );
}

function WeeklyFields({
  session,
  dateRangeOpen,
  onDateRangeOpenChange,
  messages,
}: {
  session: ScheduleEditorSession;
  dateRangeOpen: boolean;
  onDateRangeOpenChange: (open: boolean) => void;
  messages: {
    days: string | null;
    time: string | null;
    dateRange: string | null;
  };
}) {
  const { t } = useTranslation("schedules");
  const { draft, update, readOnly } = session;
  const overnight = draft.dailyEnd <= draft.dailyStart;
  return (
    <div className="grid gap-4">
      <Field data-invalid={messages.days ? true : undefined}>
        <FieldLabel id="schedule-days-label">
          {t("timing.weekdaysLabel")}
        </FieldLabel>
        <ToggleGroup
          variant="outline"
          spacing={1}
          multiple
          aria-labelledby="schedule-days-label"
          aria-describedby={messages.days ? "schedule-days-error" : undefined}
          className="grid w-full max-w-md grid-cols-7"
          value={draft.daysOfWeek.map(String)}
          disabled={readOnly}
          onValueChange={(next) =>
            update({ daysOfWeek: next.map(Number).sort((a, b) => a - b) })
          }
        >
          {scheduleWeekdays.map((day) => {
            const labels = scheduleWeekdayLabels(day.value, t);
            return (
              <ToggleGroupItem
                key={day.value}
                id={`schedule-day-${day.value}`}
                value={String(day.value)}
                aria-label={labels.long}
                className="h-11 min-w-0 flex-col gap-0.5 px-1 data-pressed:border-primary"
              >
                <span>{labels.short}</span>
                <Check
                  aria-hidden="true"
                  className="hidden size-3 in-data-pressed:block"
                />
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
        {messages.days && (
          <FieldError id="schedule-days-error">{messages.days}</FieldError>
        )}
      </Field>
      <div className="grid max-w-md gap-4 sm:grid-cols-2">
        <Field data-invalid={messages.time ? true : undefined}>
          <FieldLabel htmlFor="schedule-daily-start">
            {t("timing.starts")}
          </FieldLabel>
          <Input
            id="schedule-daily-start"
            type="time"
            value={draft.dailyStart}
            required
            readOnly={readOnly}
            aria-invalid={messages.time ? true : undefined}
            aria-describedby={messages.time ? "schedule-time-error" : undefined}
            onChange={(event) => update({ dailyStart: event.target.value })}
          />
        </Field>
        <Field data-invalid={messages.time ? true : undefined}>
          <FieldLabel htmlFor="schedule-daily-end">
            {t("timing.ends")}
          </FieldLabel>
          <Input
            id="schedule-daily-end"
            type="time"
            value={draft.dailyEnd}
            required
            readOnly={readOnly}
            aria-invalid={messages.time ? true : undefined}
            aria-describedby={messages.time ? "schedule-time-error" : undefined}
            onChange={(event) => update({ dailyEnd: event.target.value })}
          />
        </Field>
      </div>
      {messages.time && (
        <FieldError id="schedule-time-error">{messages.time}</FieldError>
      )}
      {overnight && draft.dailyStart && draft.dailyEnd && (
        <FieldDescription>
          {draft.dailyEnd === draft.dailyStart
            ? t("timing.fullDayNote")
            : t("timing.overnightNote")}
        </FieldDescription>
      )}
      <Collapsible open={dateRangeOpen} onOpenChange={onDateRangeOpenChange}>
        <CollapsibleTrigger
          render={
            <Button type="button" variant="ghost" size="sm" className="-ms-2" />
          }
        >
          <ChevronRight
            aria-hidden="true"
            className="transition-transform in-data-panel-open:rotate-90"
          />
          {t("timing.limitDateRange")}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="grid gap-3 pt-3">
            <div className="grid gap-4 sm:grid-cols-2 sm:max-w-md">
              <Field data-invalid={messages.dateRange ? true : undefined}>
                <FieldLabel htmlFor="schedule-start-date">
                  {t("timing.startsOn")}
                </FieldLabel>
                <DateInput
                  id="schedule-start-date"
                  value={draft.startDate}
                  max={draft.endDate || undefined}
                  disabled={readOnly}
                  aria-invalid={messages.dateRange ? true : undefined}
                  aria-describedby={
                    messages.dateRange ? "schedule-date-range-error" : undefined
                  }
                  onChange={(startDate) => update({ startDate })}
                />
              </Field>
              <Field data-invalid={messages.dateRange ? true : undefined}>
                <FieldLabel htmlFor="schedule-end-date">
                  {t("timing.endsOn")}
                </FieldLabel>
                <DateInput
                  id="schedule-end-date"
                  value={draft.endDate}
                  min={draft.startDate || undefined}
                  disabled={readOnly}
                  aria-invalid={messages.dateRange ? true : undefined}
                  aria-describedby={
                    messages.dateRange ? "schedule-date-range-error" : undefined
                  }
                  onChange={(endDate) => update({ endDate })}
                />
              </Field>
            </div>
            {messages.dateRange && (
              <FieldError id="schedule-date-range-error">
                {messages.dateRange}
              </FieldError>
            )}
            {!readOnly && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => {
                  update({ startDate: "", endDate: "" });
                  onDateRangeOpenChange(false);
                }}
              >
                {t("timing.removeDateRange")}
              </Button>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function OneTimeFields({
  session,
  message,
}: {
  session: ScheduleEditorSession;
  message: string | null;
}) {
  const { t } = useTranslation("schedules");
  const { draft, update, readOnly } = session;
  const startWall = instantToWall(draft.oneTimeStart, draft.timezone);
  const endWall = instantToWall(draft.oneTimeEnd, draft.timezone);
  const duration = !message && draft.oneTimeStart && draft.oneTimeEnd;
  return (
    <div className="grid gap-3">
      <div className="grid gap-4 sm:grid-cols-2 sm:max-w-xl">
        <Field data-invalid={message ? true : undefined}>
          <FieldLabel htmlFor="schedule-onetime-start">
            {t("timing.starts")}
          </FieldLabel>
          <DateTimeInput
            id="schedule-onetime-start"
            timeLabel={t("timing.startsTimeLabel")}
            value={startWall}
            disabled={readOnly}
            aria-invalid={message ? true : undefined}
            aria-describedby={message ? "schedule-onetime-error" : undefined}
            onChange={(wall) =>
              update({ oneTimeStart: wallToInstant(wall, draft.timezone) })
            }
          />
        </Field>
        <Field data-invalid={message ? true : undefined}>
          <FieldLabel htmlFor="schedule-onetime-end">
            {t("timing.ends")}
          </FieldLabel>
          <DateTimeInput
            id="schedule-onetime-end"
            timeLabel={t("timing.endsTimeLabel")}
            value={endWall}
            min={startWall}
            disabled={readOnly}
            aria-invalid={message ? true : undefined}
            aria-describedby={message ? "schedule-onetime-error" : undefined}
            onChange={(wall) =>
              update({ oneTimeEnd: wallToInstant(wall, draft.timezone) })
            }
          />
        </Field>
      </div>
      {message && (
        <FieldError id="schedule-onetime-error">{message}</FieldError>
      )}
      {duration && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Clock3 className="size-4 shrink-0" aria-hidden="true" />
          <span>{oneTimeDuration(draft, t)}</span>
        </p>
      )}
    </div>
  );
}
