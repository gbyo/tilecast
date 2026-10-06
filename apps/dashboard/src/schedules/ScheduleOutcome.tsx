/**
 * What the draft will do, in plain terms: what it shows, when, where, and
 * whether it wins there. One component serves the desktop pane, the tablet
 * Sheet, and the phone Drawer, so the answer never differs between them.
 *
 * The first half is the draft read back. The second is the server's own
 * next-occurrence check; the editor never works out precedence itself.
 */
import { CircleCheck, CircleX, Info, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  SchedulePreflight,
  SchedulePreflightCompetitor,
} from "../api/types";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../components/ui/item";
import { Separator } from "../components/ui/separator";
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";
import { apiErrorMessage, useFormatLocale } from "../i18n";
import {
  describeScheduleWhen,
  displayActionLabel,
  formatInTimezone,
  priorityLabel,
  type SchedulesT,
} from "./scheduleBuilderModel";
import {
  firstProblem,
  scheduleProblems,
  type ScheduleDraft,
} from "./scheduleEditorModel";
import type { ScheduleEditorSession } from "./useScheduleEditorSession";

export function ScheduleOutcomeContent({
  session,
}: {
  session: ScheduleEditorSession;
}) {
  const { t } = useTranslation("schedules");
  const { draft, preflight } = session;
  const result =
    preflight.status === "incomplete" ? undefined : preflight.result;
  const targetCount = result?.targetScreenCount;
  return (
    <div className="grid gap-5">
      <div className="flex items-center justify-between gap-3">
        <Badge variant={draft.enabled ? "secondary" : "outline"}>
          {draft.enabled ? t("outcome.enabled") : t("outcome.disabled")}
        </Badge>
        {session.readOnly && (
          <span className="text-xs text-muted-foreground">
            {t("outcome.viewOnly")}
          </span>
        )}
      </div>
      <dl className="grid gap-4">
        <OutcomeRow label={t("outcome.what")}>
          <WhatValue draft={draft} />
        </OutcomeRow>
        <OutcomeRow label={t("outcome.when")}>
          <WhenValue draft={draft} />
        </OutcomeRow>
        <OutcomeRow label={t("outcome.where")}>
          <WhereValue draft={draft} screenCount={targetCount} />
        </OutcomeRow>
        <OutcomeRow label={t("outcome.priority")}>
          {Number.isFinite(draft.priority)
            ? `${priorityLabel(draft.priority, t)} · ${draft.priority}`
            : t("outcome.priorityInvalid")}
        </OutcomeRow>
      </dl>
      <Separator />
      <NextRunCheck session={session} />
    </div>
  );
}

function OutcomeRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function Unset({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

function WhatValue({ draft }: { draft: ScheduleDraft }) {
  const { t } = useTranslation("schedules");
  if (draft.presentationMode === "display_control")
    return <>{displayActionLabel(draft.displayAction, t)}</>;
  if (!draft.content) return <Unset>{t("outcome.noPresentation")}</Unset>;
  return (
    <>
      <span className="font-medium">{draft.content.name}</span>
      <span className="block text-muted-foreground">
        {draft.content.kind === "layout"
          ? t("editor.presentation.layoutKind")
          : t("editor.presentation.playlistKind")}
      </span>
    </>
  );
}

function WhenValue({ draft }: { draft: ScheduleDraft }) {
  const { t } = useTranslation("schedules");
  const formatLocale = useFormatLocale();
  const { lines, timezone } = describeScheduleWhen(draft, t, formatLocale);
  return (
    <>
      {lines.map((line, index) => (
        <span key={index} className="block">
          {line}
        </span>
      ))}
      {timezone && (
        <span className="block text-muted-foreground">{timezone}</span>
      )}
    </>
  );
}

function WhereValue({
  draft,
  screenCount,
}: {
  draft: ScheduleDraft;
  screenCount: number | undefined;
}) {
  const { t } = useTranslation("schedules");
  const targets = draft.targets.length;
  if (!targets) return <Unset>{t("outcome.noTargets")}</Unset>;
  // Only the server knows how many screens a Display Group reaches.
  if (screenCount === undefined)
    return <>{t("outcome.targetCount", { count: targets })}</>;
  return (
    <>
      <span className="block">
        {t("outcome.screenCount", { count: screenCount })}
      </span>
      <span className="block text-muted-foreground">
        {t("outcome.viaTargets", { count: targets })}
      </span>
    </>
  );
}

function NextRunCheck({ session }: { session: ScheduleEditorSession }) {
  const { t } = useTranslation("schedules");
  const { preflight, draft } = session;
  const checking = preflight.status === "checking";
  return (
    <section aria-labelledby="schedule-check-heading" className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 id="schedule-check-heading" className="text-sm font-semibold">
          {t("outcome.checkTitle")}
        </h3>
        {checking && (
          <span
            role="status"
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            <Spinner aria-hidden="true" />
            {t("outcome.checking")}
          </span>
        )}
      </div>
      {preflight.status === "incomplete" ? (
        <p className="text-sm text-muted-foreground">
          {incompleteMessage(draft, t)}
        </p>
      ) : preflight.status === "error" ? (
        <Alert variant="destructive">
          <AlertTitle>{t("outcome.checkFailed")}</AlertTitle>
          <AlertDescription className="grid gap-2">
            <span>
              {preflight.error ? apiErrorMessage(preflight.error) : ""}
            </span>
            <span>{t("outcome.checkFailedSave")}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={preflight.retry}
            >
              {t("outcome.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : !preflight.result ? (
        <div className="grid gap-2" aria-label={t("outcome.checking")}>
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : (
        <PreflightResult
          result={preflight.result}
          draft={draft}
          stale={!preflight.current}
        />
      )}
    </section>
  );
}

/** What is still missing, as one sentence the reader can act on. */
function incompleteMessage(draft: ScheduleDraft, t: SchedulesT) {
  const problems = scheduleProblems(draft);
  delete problems.name;
  const needsPresentation = Boolean(
    problems.presentation || problems.displayAction,
  );
  const needsTargets = Boolean(problems.targets);
  if (needsPresentation && needsTargets) return t("outcome.incompleteBoth");
  if (needsPresentation) return t("outcome.incompletePresentation");
  if (needsTargets) return t("outcome.incompleteTargets");
  return firstProblem(problems)
    ? t("outcome.incompleteTiming")
    : t("outcome.incompleteBoth");
}

function PreflightResult({
  result,
  draft,
  stale,
}: {
  result: SchedulePreflight;
  draft: ScheduleDraft;
  stale: boolean;
}) {
  const { t } = useTranslation("schedules");
  const formatLocale = useFormatLocale();
  const blocking = result.issues.find(
    (i) => i.code === "display_control_unsupported",
  );
  const noRun = result.issues.some((i) => i.code === "no_upcoming_run");
  const checked = result.checkedAt
    ? formatInTimezone(result.checkedAt, draft.timezone, formatLocale, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      })
    : "";
  const evaluated = result.winningScreenCount + result.losingScreenCount;
  return (
    <div
      className={stale ? "grid gap-3 opacity-60" : "grid gap-3"}
      aria-busy={stale || undefined}
    >
      {!result.draftEnabled && (
        <Alert>
          <Info aria-hidden="true" />
          <AlertTitle>{t("outcome.disabled")}</AlertTitle>
          <AlertDescription>{t("outcome.simulatedEnabled")}</AlertDescription>
        </Alert>
      )}
      {blocking && (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>
            {t("outcome.unsupportedTitle", {
              count: blocking.screenCount ?? 0,
            })}
          </AlertTitle>
          <AlertDescription>{t("outcome.unsupportedBody")}</AlertDescription>
        </Alert>
      )}
      {noRun ? (
        <Alert>
          <Info aria-hidden="true" />
          <AlertTitle>{t("outcome.noRunTitle")}</AlertTitle>
          <AlertDescription>{t("outcome.noRunBody")}</AlertDescription>
        </Alert>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {result.running
              ? t("outcome.checkedNow", { when: checked })
              : t("outcome.checkedAt", { when: checked })}
          </p>
          {evaluated > 0 && <Verdict result={result} evaluated={evaluated} />}
          {result.competitors.length > 0 && (
            <ItemGroup className="gap-2" aria-label={t("outcome.competitors")}>
              {result.competitors.map((competitor) => (
                <Item
                  key={competitor.scheduleId}
                  role="listitem"
                  variant="outline"
                  size="sm"
                >
                  <ItemContent>
                    <ItemTitle>{competitor.name}</ItemTitle>
                    <ItemDescription>
                      {competitorLine(competitor, t)}
                    </ItemDescription>
                  </ItemContent>
                </Item>
              ))}
            </ItemGroup>
          )}
          {result.competitorsTruncated && (
            <p className="text-xs text-muted-foreground">
              {t("outcome.moreCompetitors")}
            </p>
          )}
          <LosingScreens result={result} />
        </>
      )}
      <p className="text-xs text-muted-foreground">{t("outcome.scopeNote")}</p>
    </div>
  );
}

function Verdict({
  result,
  evaluated,
}: {
  result: SchedulePreflight;
  evaluated: number;
}) {
  const { t } = useTranslation("schedules");
  const wins = result.winningScreenCount;
  const all = wins === evaluated;
  const none = wins === 0;
  const Icon = all ? CircleCheck : none ? CircleX : TriangleAlert;
  return (
    <p role="status" className="flex items-start gap-2 text-sm font-medium">
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>
        {all
          ? t(
              result.unsupportedScreenCount > 0
                ? "outcome.winsAllRunnable"
                : "outcome.winsAll",
              { count: evaluated },
            )
          : none
            ? t("outcome.winsNone", { count: evaluated })
            : t("outcome.winsSome", { wins, count: evaluated })}
      </span>
    </p>
  );
}

const SHOWN_SCREENS = 5;

function LosingScreens({ result }: { result: SchedulePreflight }) {
  const { t } = useTranslation("schedules");
  const losing = result.screens.filter((s) => s.outcome === "superseded");
  if (!losing.length) return null;
  const hidden =
    result.losingScreenCount - Math.min(losing.length, SHOWN_SCREENS);
  return (
    <div className="grid gap-1.5">
      <h4 className="text-xs font-medium text-muted-foreground">
        {t("outcome.otherScreens")}
      </h4>
      <ul className="grid gap-1 text-sm">
        {losing.slice(0, SHOWN_SCREENS).map((screen) => (
          <li key={screen.screenId} className="grid">
            <span className="truncate">{screen.name}</span>
            {screen.winnerName && (
              <span className="truncate text-xs text-muted-foreground">
                {t("outcome.showsInstead", { name: screen.winnerName })}
              </span>
            )}
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("outcome.andMore", { count: hidden })}
        </p>
      )}
    </div>
  );
}

function competitorLine(
  competitor: SchedulePreflightCompetitor,
  t: SchedulesT,
) {
  const { affectedScreenCount: count, outranksDraftScreenCount: outranks } =
    competitor;
  if (outranks > 0 && outranks < count)
    return t("outcome.competitor.mixed", { outranks, count });
  const side = outranks === 0 ? "yields" : "outranks";
  switch (competitor.reason) {
    case "schedule_lower_priority":
      return t(`outcome.competitor.${side}.priority`, { count });
    case "schedule_less_specific":
      return t(`outcome.competitor.${side}.specific`, { count });
    case "schedule_earlier_start":
      return t(`outcome.competitor.${side}.start`, { count });
    default:
      return t(`outcome.competitor.${side}.tie`, { count });
  }
}
