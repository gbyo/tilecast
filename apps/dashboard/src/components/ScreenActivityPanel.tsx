import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { apiErrorMessage, translateKnown } from "../i18n";
import { ApiError } from "../api/errors";
import { getScreenActivity } from "../api/domains/activity";
import { AlertTriangle } from "lucide-react";
import { buildActivityLink } from "../pages/activityLinks";
import { ScreenTimeline } from "./ScreenTimeline";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "./ui/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "./ui/item";
import { Skeleton } from "./ui/skeleton";

type WireScreenActivity = Awaited<ReturnType<typeof getScreenActivity>>;
type WireProof = WireScreenActivity["recentProofOfPlay"][number];

// The view the panel renders. The Server reports the current presentation as
// its Player-confirmed proof record; the panel shows that record's name.
type ScreenActivity = {
  screenId: string;
  currentPresentation?: string;
  recentProof: WireProof[];
  recentEvents: WireScreenActivity["recentEvents"];
  playbackGaps: number;
  lastHealthyPlayback?: string;
  lastSuccessfulActivation?: string;
  currentIssue?: WireScreenActivity["currentIssue"];
};

export function presentationLabel(record?: WireProof): string | undefined {
  return record?.presentationName || record?.contentName || undefined;
}

export function toScreenActivity(wire: WireScreenActivity): ScreenActivity {
  return {
    screenId: wire.screenId,
    currentPresentation: presentationLabel(wire.currentPresentation),
    recentProof: wire.recentProofOfPlay,
    recentEvents: wire.recentEvents,
    playbackGaps: wire.playbackGaps,
    lastHealthyPlayback: wire.lastHealthyPlayback,
    lastSuccessfulActivation: wire.lastSuccessfulManifestActivation,
    currentIssue: wire.currentIssue,
  };
}

async function loadScreenActivity(id: string): Promise<ScreenActivity> {
  try {
    return toScreenActivity(await getScreenActivity(id));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error(
      translateKnown(
        "activity:screenActivity.loadFailed",
        "Screen Activity could not be loaded.",
      ),
      { cause: error },
    );
  }
}

export function ScreenActivitySummary({
  screenId,
  onOpen,
}: {
  screenId: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation("activity");
  const notReported = t("screenActivity.notReported");
  const query = useQuery({
    queryKey: ["activity", "screen", screenId],
    queryFn: () => loadScreenActivity(screenId),
    refetchInterval: 20_000,
  });
  const data = query.data;

  return (
    <Card size="sm" className="min-w-0">
      <CardHeader>
        <CardTitle>{t("screenActivity.lists.eventsTitle")}</CardTitle>
        <CardAction>
          <Button variant="ghost" size="sm" onClick={onOpen}>
            {t("screenActivity.title")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="min-w-0">
        {query.isLoading ? (
          <div className="space-y-2" aria-label={t("screenActivity.loading")}>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : query.error ? (
          <p className="text-sm text-destructive">
            {t("screenActivity.loadErrorTitle")}
          </p>
        ) : data ? (
          <ItemGroup className="gap-0 divide-y divide-border">
            {data.currentIssue && (
              <Item size="xs" className="rounded-none px-0">
                <ItemContent className="min-w-0">
                  <ItemTitle>{humanize(data.currentIssue.kind)}</ItemTitle>
                  <ItemDescription className="line-clamp-2">
                    {data.currentIssue.description}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Badge
                    variant={
                      data.currentIssue.severity === "critical"
                        ? "destructive"
                        : "secondary"
                    }
                  >
                    {humanize(data.currentIssue.severity)}
                  </Badge>
                </ItemActions>
              </Item>
            )}
            {data.recentEvents.slice(0, 3).map((item) => (
              <Item key={item.id} size="xs" className="rounded-none px-0">
                <ItemContent className="min-w-0">
                  <ItemTitle>{humanize(item.eventType)}</ItemTitle>
                  <ItemDescription>
                    {formatDate(item.timestamp, notReported)}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Badge
                    variant={
                      item.severity === "failed" || item.severity === "critical"
                        ? "destructive"
                        : "secondary"
                    }
                  >
                    {humanize(item.severity)}
                  </Badge>
                </ItemActions>
              </Item>
            ))}
            {!data.currentIssue && !data.recentEvents.length && (
              <p className="py-2 text-sm text-muted-foreground">
                {t("screenActivity.lists.eventsEmpty")}
              </p>
            )}
          </ItemGroup>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The screen-detail page owns the Activity tab; this renders its contents. */
export function ScreenActivityPanel({ screenId }: { screenId: string }) {
  const { t } = useTranslation("activity");
  const notReported = t("screenActivity.notReported");
  const query = useQuery({
    queryKey: ["activity", "screen", screenId],
    queryFn: () => loadScreenActivity(screenId),
    refetchInterval: 20_000,
  });
  const data = query.data;

  return (
    <section
      className="min-w-0 space-y-5"
      aria-labelledby="screen-activity-title"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="screen-activity-title" className="text-base font-semibold">
            {t("screenActivity.title")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("screenActivity.subtitle")}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          render={
            <Link to={buildActivityLink("proof", { screen: screenId })} />
          }
        >
          {t("screenActivity.openFiltered")}
        </Button>
      </header>

      {query.isLoading && (
        <div className="space-y-2" aria-label={t("screenActivity.loading")}>
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-36 w-full" />
        </div>
      )}
      {query.error && (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>{t("screenActivity.loadErrorTitle")}</AlertTitle>
          <AlertDescription>{apiErrorMessage(query.error)}</AlertDescription>
        </Alert>
      )}
      {data && (
        <>
          <dl className="grid gap-x-6 gap-y-4 border-y border-border py-4 sm:grid-cols-2 xl:grid-cols-4">
            <ActivityFact
              label={t("screenActivity.facts.presentation")}
              value={data.currentPresentation || notReported}
            />
            <ActivityFact
              label={t("screenActivity.facts.lastPlayback")}
              value={formatDate(data.lastHealthyPlayback, notReported)}
            />
            <ActivityFact
              label={t("screenActivity.facts.lastActivation")}
              value={formatDate(data.lastSuccessfulActivation, notReported)}
            />
            <ActivityFact
              label={t("screenActivity.facts.gaps")}
              value={data.playbackGaps}
            />
          </dl>

          {data.currentIssue && (
            <Alert
              variant={
                data.currentIssue.severity === "critical"
                  ? "destructive"
                  : "default"
              }
            >
              <AlertTriangle aria-hidden="true" />
              <AlertTitle>{humanize(data.currentIssue.kind)}</AlertTitle>
              <AlertDescription>
                {data.currentIssue.description}
                <span className="mt-1 block text-xs text-muted-foreground">
                  {t("screenActivity.reportedAt", {
                    when: formatDate(data.currentIssue.occurredAt, notReported),
                  })}
                </span>
              </AlertDescription>
            </Alert>
          )}

          <ScreenTimeline screenId={screenId} />

          <div className="grid min-w-0 gap-6 xl:grid-cols-2">
            <ActivityList
              title={t("screenActivity.lists.proofTitle")}
              empty={t("screenActivity.lists.proofEmpty")}
              items={data.recentProof.map((item) => ({
                id: item.id,
                label:
                  item.contentName ||
                  item.contentId ||
                  item.presentationName ||
                  item.presentationId ||
                  t("shared.unnamedPresentation"),
                detail: formatDate(item.startedAt, notReported),
                status: item.result,
              }))}
            />
            <ActivityList
              title={t("screenActivity.lists.eventsTitle")}
              empty={t("screenActivity.lists.eventsEmpty")}
              items={data.recentEvents.map((item) => ({
                id: item.id,
                label: humanize(item.eventType),
                detail: `${formatDate(item.timestamp, notReported)} · ${item.description}`,
                status: item.severity,
              }))}
            />
          </div>
        </>
      )}
    </section>
  );
}

function ActivityFact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm font-medium">{value}</dd>
    </div>
  );
}

function ActivityList({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: { id: string; label: string; detail: string; status: string }[];
}) {
  return (
    <section className="min-w-0 space-y-2" aria-label={title}>
      <h3 className="text-sm font-semibold">{title}</h3>
      {items.length ? (
        <ItemGroup className="gap-0 divide-y divide-border border-y border-border">
          {items.map((item) => (
            <Item
              key={item.id}
              size="xs"
              render={<div role="listitem" />}
              className="rounded-none px-0"
            >
              <ItemContent className="min-w-0">
                <ItemTitle>{item.label}</ItemTitle>
                <ItemDescription className="line-clamp-2">
                  {item.detail}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Badge
                  variant={
                    item.status === "failed" || item.status === "critical"
                      ? "destructive"
                      : "secondary"
                  }
                >
                  {humanize(item.status)}
                </Badge>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      ) : (
        <p className="border-y border-border py-3 text-sm text-muted-foreground">
          {empty}
        </p>
      )}
    </section>
  );
}

function formatDate(value: string | undefined, notReported: string) {
  return value
    ? new Date(value).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : notReported;
}

function humanize(value: string) {
  return value
    .replaceAll("_", " ")
    .replaceAll(".", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
