import { useQuery } from "@tanstack/react-query";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Monitor,
  MonitorSpeaker,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { addWeeks, startOfWeek, type Day } from "date-fns";
import { api, ApiError } from "../../api/client";
import { scheduleQueries } from "../../data/schedules";
import { screenQueries } from "../../data/screens";
import { useNow } from "../overview/format";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { ButtonGroup } from "../ui/button-group";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
} from "../ui/combobox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  firstDayOfWeekForLocale,
  weekdays,
} from "../../settings/settingValues";
import { PlaybackWeekCalendar } from "./PlaybackWeekCalendar";
import { agendaDate } from "./playbackAgendaModel";

type ScreenOption = { id: string; name: string };
type Destination = { key: string; name: string; members: ScreenOption[] };
type DestinationGroup = { label: string; items: Destination[] };

const groupsQuery = {
  queryKey: ["screen-groups"],
  queryFn: () => api.screenGroups(),
} as const;

export function PlaybackAgenda() {
  const { t, i18n } = useTranslation("schedules");
  const locale = i18n.language || navigator.language;
  const now = useNow();
  const today = agendaDate(now);
  const weekStartsOn = weekdays.indexOf(
    firstDayOfWeekForLocale(navigator.language) ?? "monday",
  ) as Day;
  const thisWeek = startOfWeek(today, { weekStartsOn });
  const [weekOffset, setWeekOffset] = useState(0);
  const [chosenDay, setChosenDay] = useState<number | null>(null);
  const [targetKey, setTargetKey] = useState<string | null>(null);
  const [memberId, setMemberId] = useState<string | null>(null);
  const screens = useQuery(screenQueries.list());
  const groups = useQuery(groupsQuery);
  const available = screens.data?.items ?? [];
  const readable = new Set(available.map((screen) => screen.id));
  const catalog: DestinationGroup[] = [
    {
      label: t("agenda.groups"),
      items: (groups.data?.items ?? []).map((group) => ({
        key: `group:${group.id}`,
        name: group.name,
        members: group.screens.filter((screen) => readable.has(screen.id)),
      })),
    },
    {
      label: t("agenda.screens"),
      items: available.map((screen) => ({
        key: `screen:${screen.id}`,
        name: screen.name,
        members: [screen],
      })),
    },
  ];
  const target =
    catalog
      .flatMap((group) => group.items)
      .find((item) => item.key === targetKey) ?? null;
  const members = target?.members ?? [];
  const screen = members.find((member) => member.id === memberId) ?? members[0];
  const start = addWeeks(thisWeek, weekOffset);
  const end = addWeeks(start, 1);
  const dayIndex =
    chosenDay ??
    (weekOffset === 0 ? (today.getDay() - weekStartsOn + 7) % 7 : 0);
  const agenda = useQuery({
    ...scheduleQueries.agenda(
      screen?.id ?? "",
      start.toISOString(),
      end.toISOString(),
    ),
    enabled: Boolean(screen),
  });
  const weekLabel = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).formatRange(start, agendaDate(start, 6));

  function changeWeek(offset: number) {
    setWeekOffset(offset);
    setChosenDay(null);
  }

  return (
    <section className="@container/agenda min-w-0 space-y-3">
      <h1 className="sr-only">{t("agenda.title")}</h1>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <Button variant="outline" onClick={() => changeWeek(0)}>
            {t("agenda.today")}
          </Button>
          <ButtonGroup aria-label={t("agenda.weekNavigation")}>
            <Button
              size="icon"
              variant="outline"
              aria-label={t("agenda.previousWeek")}
              disabled={weekOffset === 0}
              onClick={() => changeWeek(weekOffset - 1)}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <Button
              size="icon"
              variant="outline"
              aria-label={t("agenda.nextWeek")}
              onClick={() => changeWeek(weekOffset + 1)}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </ButtonGroup>
          <h2 className="text-base font-semibold tracking-tight tabular-nums sm:text-lg">
            {weekLabel}
          </h2>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Combobox
            items={catalog}
            value={target}
            isItemEqualToValue={(a: Destination, b: Destination) =>
              a.key === b.key
            }
            itemToStringLabel={(option: Destination) => option.name}
            onValueChange={(next: Destination | null) => {
              setTargetKey(next?.key ?? null);
              setMemberId(null);
            }}
          >
            <ComboboxTrigger
              render={
                <Button
                  variant="outline"
                  aria-label={t("agenda.chooseTarget")}
                  className="min-w-0 max-w-full justify-between sm:max-w-56"
                />
              }
            >
              <span className="flex min-w-0 items-center gap-2">
                {target?.key.startsWith("group:") ? (
                  <MonitorSpeaker aria-hidden="true" />
                ) : (
                  <Monitor aria-hidden="true" />
                )}
                <span className="truncate">
                  {target?.name ?? t("agenda.chooseTarget")}
                </span>
              </span>
            </ComboboxTrigger>
            <ComboboxContent className="min-w-64">
              <ComboboxInput
                showTrigger={false}
                placeholder={t("targets.search")}
                aria-label={t("targets.search")}
              />
              {screens.isPending || groups.isPending ? (
                <p role="status" className="p-3 text-sm text-muted-foreground">
                  {t("targets.loading")}
                </p>
              ) : null}
              {screens.isError || groups.isError ? (
                <div className="grid gap-2 p-3">
                  <p role="alert" className="text-sm text-destructive">
                    {t("targets.loadError")}
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => {
                      void screens.refetch();
                      void groups.refetch();
                    }}
                  >
                    {t("targets.retry")}
                  </Button>
                </div>
              ) : null}
              {screens.isSuccess && groups.isSuccess ? (
                <ComboboxEmpty>{t("targets.empty")}</ComboboxEmpty>
              ) : null}
              <ComboboxList>
                {(group: DestinationGroup) => (
                  <ComboboxGroup key={group.label} items={group.items}>
                    <ComboboxLabel>{group.label}</ComboboxLabel>
                    <ComboboxCollection>
                      {(option: Destination) => (
                        <ComboboxItem key={option.key} value={option}>
                          {option.name}
                        </ComboboxItem>
                      )}
                    </ComboboxCollection>
                  </ComboboxGroup>
                )}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
          {target?.key.startsWith("group:") && screen ? (
            <Select
              items={members.map((member) => ({
                value: member.id,
                label: member.name,
              }))}
              value={screen.id}
              onValueChange={setMemberId}
            >
              <SelectTrigger
                aria-label={t("agenda.groupScreen")}
                className="min-w-0 max-w-full sm:max-w-56"
              >
                <Monitor aria-hidden="true" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                {members.map((member) => (
                  <SelectItem key={member.id} value={member.id}>
                    {member.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>
      </div>

      {!screen ? (
        <Empty className="min-h-64 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CalendarDays aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>
              {t(target ? "agenda.noMembers" : "agenda.emptyTitle")}
            </EmptyTitle>
            <EmptyDescription>
              {t(
                target
                  ? "agenda.noMembersDescription"
                  : "agenda.emptyDescription",
              )}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : agenda.isPending ? (
        <div
          role="status"
          aria-label={t("agenda.loading", { screen: screen.name })}
        >
          <Skeleton className="h-[min(66dvh,42rem)] min-h-64 w-full" />
        </div>
      ) : agenda.isError ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <p>
              {t(
                agenda.error instanceof ApiError && agenda.error.status === 422
                  ? "agenda.tooManyChanges"
                  : "agenda.loadError",
                { screen: screen.name },
              )}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void agenda.refetch()}
            >
              {t("targets.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <PlaybackWeekCalendar
          key={start.toISOString()}
          agenda={agenda.data}
          start={start}
          now={now}
          dayIndex={dayIndex}
          onDayChange={setChosenDay}
          locale={locale}
          screen={screen}
        />
      )}
    </section>
  );
}
