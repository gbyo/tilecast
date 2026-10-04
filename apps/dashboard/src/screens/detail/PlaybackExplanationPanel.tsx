import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { PresentationContentChain } from "../../content/ScreenContentChain";
import { screenQueries } from "../../data/screens";
import { apiErrorMessage, useFormatLocale } from "../../i18n";
import { formatDateTime, localDateTimeToRfc3339 } from "../../lib/dateTime";
import { DateTimeInput } from "../../components/date-picker";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "../../components/ui/accordion";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Field, FieldError, FieldLabel } from "../../components/ui/field";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../../components/ui/item";
import { Skeleton } from "../../components/ui/skeleton";
import {
  defaultContent,
  orderedCandidates,
  type PlaybackPlanCandidate,
} from "./screenPlaybackModel";
import type { PlaylistAssignment } from "../../api/types";

function candidateTitle(
  candidate: PlaybackPlanCandidate,
  sourceLabel: (source: PlaybackPlanCandidate["source"]) => string,
  defaultName?: string,
): string {
  if (candidate.name) return candidate.name;
  if (candidate.source === "assignment" && defaultName) return defaultName;
  return sourceLabel(candidate.source);
}

function CandidateRow({
  candidate,
  defaultName,
}: {
  candidate: PlaybackPlanCandidate;
  defaultName?: string;
}) {
  const { t } = useTranslation(["screens", "common"]);
  const locale = useFormatLocale();
  const schedule = candidate.schedule;
  return (
    <Item size="sm" variant="outline">
      <ItemContent>
        <ItemTitle className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 break-words">
            {candidateTitle(
              candidate,
              (source) => t(`playback.sources.${source}`),
              defaultName,
            )}
          </span>
          <Badge
            variant={candidate.status === "selected" ? "default" : "outline"}
          >
            {t(`playbackPlan.status.${candidate.status}`)}
          </Badge>
        </ItemTitle>
        <ItemDescription>
          {t(`playbackPlan.reasons.${candidate.reason}`)}
        </ItemDescription>
        {schedule && (
          <ItemDescription>
            {t("playbackPlan.precedence", {
              priority: schedule.priority,
              specificity: schedule.specificity,
            })}
            {schedule.reason !== candidate.reason &&
              ` · ${t(`playbackPlan.reasons.${schedule.reason}`)}`}
          </ItemDescription>
        )}
        {schedule?.start && (
          <ItemDescription>
            {formatDateTime(schedule.start, locale)} –{" "}
            {formatDateTime(schedule.end, locale)}
          </ItemDescription>
        )}
      </ItemContent>
    </Item>
  );
}

/**
 * "Why this content?" body for the responsive Screen detail panel. Explains
 * selection precedence from the playback-plan authority; technical playback
 * evidence lives in Diagnostics instead.
 */
export function PlaybackExplanationPanel({
  screenId,
  assignment,
}: {
  screenId: string;
  assignment?: PlaylistAssignment;
}) {
  const { t } = useTranslation(["screens", "common"]);
  const locale = useFormatLocale();
  const id = useId();
  const [at, setAt] = useState<string>();
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);
  const query = useQuery({
    ...screenQueries.playbackPlan(screenId, at),
    // TanStack Query already permits it: keep the last visible answer while a
    // background refresh or a new inspection resolves.
    placeholderData: (previous) => previous,
  });
  const plan = query.data;
  const current = plan?.current;
  const expectation = plan?.historical?.expectation;
  const defaults = defaultContent(assignment);
  const defaultName = defaults.state === "assigned" ? defaults.name : undefined;
  const time = (instant?: string) =>
    formatDateTime(instant, locale, t("playbackPlan.noBoundary"));
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const selected = current?.selected;
  const chainPresentation =
    selected &&
    (selected.contentType === "playlist" || selected.contentType === "layout")
      ? {
          type: selected.contentType,
          id: selected.contentId,
          name: selected.name,
        }
      : null;

  return (
    <div className="min-w-0 space-y-5 pt-4">
      {query.isPending && !plan ? (
        <div
          role="status"
          aria-label={t("playbackPlan.loading")}
          className="space-y-2"
        >
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : query.isError && !plan ? (
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
              <>
                <section
                  aria-labelledby={`${id}-precedence`}
                  className="min-w-0"
                >
                  <h3 id={`${id}-precedence`} className="text-sm font-semibold">
                    {t("playback.precedenceTitle")}
                  </h3>
                  <ItemGroup className="mt-2 gap-2">
                    {orderedCandidates(current.candidates).map(
                      (candidate, index) => (
                        <CandidateRow
                          key={`${candidate.source}:${candidate.id ?? index}`}
                          candidate={candidate}
                          defaultName={
                            candidate.source === "assignment"
                              ? defaultName
                              : undefined
                          }
                        />
                      ),
                    )}
                  </ItemGroup>
                </section>
                {chainPresentation && (
                  <section
                    aria-labelledby={`${id}-content-path`}
                    className="min-w-0"
                  >
                    <h3
                      id={`${id}-content-path`}
                      className="text-sm font-semibold"
                    >
                      {t("playback.contentPathTitle")}
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t("playback.contentPathBody", {
                        name: selected?.name ?? t("playback.missingContent"),
                      })}
                    </p>
                    <div className="mt-2">
                      <PresentationContentChain
                        presentation={chainPresentation}
                      />
                    </div>
                  </section>
                )}
                <p className="text-xs text-muted-foreground">
                  {t("playbackPlan.boundaryLimit")}
                </p>
              </>
            ) : expectation ? (
              <dl className="grid gap-3 sm:grid-cols-2">
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">
                    {t("playbackPlan.recordedPresentation")}
                  </dt>
                  <dd className="mt-1 break-words text-sm font-medium">
                    {t("playbackPlan.recordedRevision", {
                      type: t(
                        expectation.presentationType === "playlist"
                          ? "playbackPlan.types.playlist"
                          : expectation.presentationType === "layout"
                            ? "playbackPlan.types.layout"
                            : "playbackPlan.types.presentation",
                      ),
                      revision: expectation.presentationRevision,
                    })}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">
                    {t("playbackPlan.recordedInterval")}
                  </dt>
                  <dd className="mt-1 break-words text-sm font-medium">
                    {time(expectation.start)}
                    {expectation.end
                      ? ` – ${time(expectation.end)}`
                      : ` · ${t("playbackPlan.openWindow")}`}
                  </dd>
                </div>
              </dl>
            ) : (
              <Alert>
                <AlertDescription>
                  {t("playbackPlan.historyGap")}
                </AlertDescription>
              </Alert>
            )}
            <p className="text-xs text-muted-foreground">
              {t("playbackPlan.inspectedTime", {
                at: time(plan.at),
                evaluatedAt: time(plan.evaluatedAt),
              })}
            </p>
          </>
        )
      )}

      <Accordion>
        <AccordionItem value="inspect">
          <AccordionTrigger>
            {t("playback.inspectAnotherTime")}
          </AccordionTrigger>
          <AccordionContent>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                const instant = localDateTimeToRfc3339(draft);
                setInvalid(!instant);
                if (instant) setAt(instant);
              }}
            >
              <Field data-invalid={invalid || undefined}>
                <FieldLabel htmlFor={`${id}-instant`}>
                  {t("playbackPlan.inspectAt")}
                </FieldLabel>
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
                {invalid && (
                  <FieldError>{t("playbackPlan.invalidInstant")}</FieldError>
                )}
              </Field>
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
                    setDraft("");
                    setInvalid(false);
                  }}
                >
                  {t("playbackPlan.useNow")}
                </Button>
              </div>
              <p
                id={`${id}-timezone`}
                className="text-xs text-muted-foreground"
              >
                {t("playbackPlan.timezone", { timezone })}
              </p>
            </form>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <p className="text-xs text-muted-foreground">
        {t("playbackPlan.observationLimit")}{" "}
        <Link className="underline underline-offset-4" to="?tab=activity">
          {t("playbackPlan.viewActivity")}
        </Link>
      </p>
    </div>
  );
}
