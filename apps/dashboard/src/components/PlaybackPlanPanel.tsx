import { useId, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { components } from "@tilecast/api-schema/generated/openapi";
import { screenQueries } from "../data/screens";
import { apiErrorMessage, useFormatLocale } from "../i18n";
import { formatDateTime, localDateTimeToRfc3339 } from "../lib/dateTime";
import { DateTimeInput } from "./date-picker";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Skeleton } from "./ui/skeleton";
import {
  Collapsible,
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./studio/StudioCollapsible";

type Requirements =
  components["schemas"]["PlaybackPlanPresentationRequirements"];
type CapabilityEvidence =
  components["schemas"]["PlaybackPlanCapabilityEvidence"];

function recordedTypeKey(type: string) {
  switch (type) {
    case "playlist":
      return "playbackPlan.types.playlist" as const;
    case "layout":
      return "playbackPlan.types.layout" as const;
    case "asset":
      return "playbackPlan.types.asset" as const;
    default:
      return "playbackPlan.types.presentation" as const;
  }
}

function recordedSourceKey(source: string) {
  switch (source) {
    case "takeover":
      return "playbackPlan.sources.takeover" as const;
    case "quick_present":
      return "playbackPlan.sources.quick_present" as const;
    case "schedule":
      return "playbackPlan.sources.schedule" as const;
    case "assignment":
      return "playbackPlan.sources.assignment" as const;
    default:
      return "playbackPlan.otherRecordedSource" as const;
  }
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words text-sm font-medium">{children}</dd>
    </div>
  );
}

function Requirement({
  requirement,
  label,
  evidence,
}: {
  requirement: Requirements;
  label: string;
  evidence: CapabilityEvidence;
}) {
  const { t } = useTranslation("screens");
  const status =
    requirement.supported === null
      ? "unknown"
      : requirement.supported
        ? "supported"
        : "blocked";
  return (
    <div className="min-w-0 space-y-1 text-xs">
      <p className="flex flex-wrap items-center gap-2">
        <span>{label}</span>
        <Badge variant="outline">{t(`playbackPlan.status.${status}`)}</Badge>
      </p>
      <p>
        {t("playbackPlan.requiredSchema", {
          version: requirement.schemaVersion,
        })}
      </p>
      <ul className="space-y-1">
        {Object.entries(requirement.capabilities)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, version]) => (
            <li key={name} className="break-words">
              {t("playbackPlan.requiredCapability", {
                name,
                version,
                reported: evidence.reported
                  ? ((name === "web.remote"
                      ? evidence.webRuntimeVersion
                      : evidence.nativeCapabilities[name]) ??
                    t("playbackPlan.noneReported"))
                  : t("playbackPlan.noneReported"),
              })}
            </li>
          ))}
      </ul>
      <p className="text-muted-foreground">
        {t("playbackPlan.reportedSchemas", {
          versions:
            evidence.schemaVersions.join(", ") ||
            t("playbackPlan.noneReported"),
        })}
      </p>
    </div>
  );
}

export function PlaybackPlanPanel({ screenId }: { screenId: string }) {
  const { t } = useTranslation(["screens", "common"]);
  const locale = useFormatLocale();
  const id = useId();
  const [at, setAt] = useState<string>();
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);
  const query = useQuery(screenQueries.playbackPlan(screenId, at));
  const plan = query.data;
  const current = plan?.current;
  const expectation = plan?.historical?.expectation;
  const time = (instant?: string) =>
    formatDateTime(instant, locale, t("playbackPlan.noBoundary"));
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="min-w-0 space-y-3 rounded-md border border-border p-4"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${id}-title`} className="text-sm font-semibold">
          {t("playbackPlan.title")}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          {t("common:actions.refresh")}
        </Button>
      </header>
      {query.isPending ? (
        <div
          role="status"
          aria-label={t("playbackPlan.loading")}
          className="space-y-2"
        >
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : query.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{apiErrorMessage(query.error)}</AlertDescription>
        </Alert>
      ) : (
        plan && (
          <>
            <p className="text-xs text-muted-foreground">
              {t(`playbackPlan.basis.${plan.basis}`)}
            </p>
            {current ? (
              <dl className="grid gap-3 sm:grid-cols-3">
                <Fact label={t("playbackPlan.content")}>
                  {current.selected
                    ? current.selected.name || t("playbackPlan.missingContent")
                    : t("playbackPlan.noContent")}
                </Fact>
                <Fact label={t("playbackPlan.selectedBy")}>
                  {current.selected?.scheduleName ||
                    (current.selected
                      ? t(`playbackPlan.sources.${current.selected.source}`)
                      : t("playbackPlan.noSelection"))}
                </Fact>
                <Fact label={t("playbackPlan.nextEvaluation")}>
                  {time(current.nextEvaluationAt)}
                </Fact>
              </dl>
            ) : expectation ? (
              <dl className="grid gap-3 sm:grid-cols-2">
                <Fact label={t("playbackPlan.recordedPresentation")}>
                  {t("playbackPlan.recordedRevision", {
                    type: t(recordedTypeKey(expectation.presentationType)),
                    revision: expectation.presentationRevision,
                  })}
                </Fact>
                <Fact label={t("playbackPlan.recordedInterval")}>
                  {time(expectation.start)}
                  {expectation.end
                    ? ` – ${time(expectation.end)}`
                    : ` · ${t("playbackPlan.openWindow")}`}
                </Fact>
              </dl>
            ) : (
              <Alert>
                <AlertDescription>
                  {t("playbackPlan.historyGap")}
                </AlertDescription>
              </Alert>
            )}
          </>
        )
      )}
      <Collapsible>
        <CollapsibleTrigger className="flex min-h-10 w-full items-center justify-between gap-2 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {t("playbackPlan.why")}
          <CollapsibleChevron size={16} />
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 pt-3">
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              const instant = localDateTimeToRfc3339(draft);
              setInvalid(!instant);
              if (instant) setAt(instant);
            }}
          >
            <Label htmlFor={`${id}-instant`}>
              {t("playbackPlan.inspectAt")}
            </Label>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <DateTimeInput
                id={`${id}-instant`}
                value={draft}
                onChange={(value) => {
                  setDraft(value);
                  setInvalid(false);
                }}
                aria-label={t("playbackPlan.inspectAt")}
                aria-describedby={`${id}-timezone`}
                aria-invalid={invalid}
              />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="outline" size="sm">
                  {t("playbackPlan.inspect")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setAt(undefined);
                    setInvalid(false);
                  }}
                >
                  {t("playbackPlan.useNow")}
                </Button>
              </div>
            </div>
            <p id={`${id}-timezone`} className="text-xs text-muted-foreground">
              {t("playbackPlan.timezone", { timezone })}
            </p>
            {invalid && (
              <p role="alert" className="text-xs text-destructive">
                {t("playbackPlan.invalidInstant")}
              </p>
            )}
          </form>
          {!query.isError && plan && (
            <>
              <p className="text-xs text-muted-foreground">
                {t("playbackPlan.inspectedTime", {
                  at: time(plan.at),
                  evaluatedAt: time(plan.evaluatedAt),
                })}
              </p>
              {current && (
                <>
                  {current.selected && (
                    <dl className="grid gap-3 sm:grid-cols-2">
                      <Fact label={t("playbackPlan.presentationId")}>
                        {current.selected.contentId}
                      </Fact>
                      {current.selected.revision != null && (
                        <Fact label={t("playbackPlan.revision")}>
                          {current.selected.revision}
                        </Fact>
                      )}
                    </dl>
                  )}
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium">
                      {t("playbackPlan.selection")}
                    </h4>
                    <ol className="space-y-2">
                      {current.candidates.map((candidate, index) => (
                        <li
                          key={`${candidate.source}:${candidate.id ?? index}`}
                          className="min-w-0 rounded-md border border-border p-3"
                        >
                          <p className="flex flex-wrap items-center gap-2 text-sm">
                            <span className="min-w-0 break-words font-medium">
                              {candidate.name ||
                                t(`playbackPlan.sources.${candidate.source}`)}
                            </span>
                            <Badge variant="outline">
                              {t(`playbackPlan.status.${candidate.status}`)}
                            </Badge>
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {t(`playbackPlan.reasons.${candidate.reason}`)}
                          </p>
                          {candidate.schedule && (
                            <div className="mt-1 space-y-1 text-xs text-muted-foreground">
                              {candidate.schedule.reason !==
                                candidate.reason && (
                                <p>
                                  {t(
                                    `playbackPlan.reasons.${candidate.schedule.reason}`,
                                  )}
                                </p>
                              )}
                              <p>
                                {t("playbackPlan.precedence", {
                                  priority: candidate.schedule.priority,
                                  specificity: candidate.schedule.specificity,
                                })}
                              </p>
                              {candidate.schedule.start && (
                                <p>
                                  {time(candidate.schedule.start)} –{" "}
                                  {time(candidate.schedule.end)}
                                </p>
                              )}
                            </div>
                          )}
                        </li>
                      ))}
                    </ol>
                  </div>
                  <dl>
                    <Fact label={t("playbackPlan.synchronization")}>
                      {t(
                        `playbackPlan.synchronizationStatus.${current.synchronization.status}`,
                      )}
                    </Fact>
                  </dl>
                  <p className="text-xs text-muted-foreground">
                    {t("playbackPlan.synchronizationLimit")}
                  </p>
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium">
                      {t("playbackPlan.capabilities")}
                    </h4>
                    <Badge variant="outline">
                      {t(`playbackPlan.status.${current.capabilities.status}`)}
                    </Badge>
                    <p className="text-xs text-muted-foreground">
                      {t(
                        `playbackPlan.capabilityReasons.${current.capabilities.reason}`,
                      )}
                    </p>
                    {current.capabilities.evidence?.widgets.map((widget) => (
                      <div
                        key={widget.assetId}
                        className="min-w-0 space-y-2 rounded-md border border-border p-3"
                      >
                        <p className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="break-words font-medium">
                            {widget.name}
                          </span>
                          <Badge variant="outline">
                            {t(`playbackPlan.status.${widget.status}`)}
                          </Badge>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t(`playbackPlan.widgetReasons.${widget.reason}`)}
                        </p>
                        {widget.selectedRenderer && (
                          <p className="text-xs">
                            {t("playbackPlan.renderer", {
                              renderer: t(
                                `playbackPlan.renderers.${widget.selectedRenderer}`,
                              ),
                            })}
                          </p>
                        )}
                        <div className="grid gap-3 sm:grid-cols-2">
                          {widget.component && (
                            <Requirement
                              requirement={widget.component}
                              label={t("playbackPlan.renderers.component")}
                              evidence={current.capabilities.evidence!}
                            />
                          )}
                          {widget.compatibility && (
                            <Requirement
                              requirement={widget.compatibility}
                              label={t("playbackPlan.renderers.compatibility")}
                              evidence={current.capabilities.evidence!}
                            />
                          )}
                        </div>
                      </div>
                    ))}
                    <p className="text-xs text-muted-foreground">
                      {t("playbackPlan.capabilityLimit")}
                    </p>
                  </div>
                </>
              )}
              {expectation && (
                <dl className="grid gap-3 sm:grid-cols-2">
                  <Fact label={t("playbackPlan.presentationId")}>
                    {expectation.presentationId}
                  </Fact>
                  <Fact label={t("playbackPlan.recordedSource")}>
                    {t(recordedSourceKey(expectation.source), {
                      source: expectation.source,
                    })}
                  </Fact>
                </dl>
              )}
              {current && (
                <p className="text-xs text-muted-foreground">
                  {t("playbackPlan.boundaryLimit")}
                </p>
              )}
            </>
          )}
          <p className="text-xs text-muted-foreground">
            {t("playbackPlan.observationLimit")}{" "}
            <Link className="underline underline-offset-4" to="?tab=activity">
              {t("playbackPlan.viewActivity")}
            </Link>
          </p>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
