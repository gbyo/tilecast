import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { AlertTriangle } from "lucide-react";
import { buildActivityLink } from "../pages/activityLinks";
import { ScreenTimeline } from "./ScreenTimeline";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "./ui/item";
import { Skeleton } from "./ui/skeleton";

type ScreenActivity = {
  screenId: string;
  currentPresentation?: Proof;
  recentProofOfPlay: Proof[];
  recentEvents: Event[];
  playbackGaps: number;
  lastHealthyPlayback?: string;
  lastSuccessfulManifestActivation?: string;
  currentIssue?: {
    kind: string;
    severity: string;
    description: string;
    occurredAt: string;
  };
};
type Proof = {
  id: string;
  startedAt: string;
  endedAt?: string;
  presentationName?: string;
  presentationId?: string;
  contentName?: string;
  contentId?: string;
  result: string;
  actualDurationMs?: number;
};
type Event = {
  id: string;
  timestamp: string;
  eventType: string;
  severity: string;
  description: string;
  result: string;
};

async function loadScreenActivity(id: string): Promise<ScreenActivity> {
  const response = await fetch(`/api/v1/activity/screens/${id}`, {
    credentials: "same-origin",
  });
  const body = (await response.json().catch(() => ({}))) as {
    data?: ScreenActivity;
    error?: { message?: string };
  };
  if (!response.ok || !body.data)
    throw new Error(
      body.error?.message ?? "Screen Activity could not be loaded.",
    );
  return body.data;
}

/** The screen-detail page owns the Activity tab; this renders its contents. */
export function ScreenActivityPanel({ screenId }: { screenId: string }) {
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
            Activity
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Recent Player-confirmed playback and technical screen events.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          render={
            <Link to={buildActivityLink("proof", { screen: screenId })} />
          }
        >
          Open filtered Activity
        </Button>
      </header>

      {query.isLoading && (
        <div className="space-y-2" aria-label="Loading screen Activity">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-36 w-full" />
        </div>
      )}
      {query.error && (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>Activity could not be loaded</AlertTitle>
          <AlertDescription>{query.error.message}</AlertDescription>
        </Alert>
      )}
      {data && (
        <>
          <dl className="grid gap-x-6 gap-y-4 border-y border-border py-4 sm:grid-cols-2 xl:grid-cols-4">
            <ActivityFact
              label="Current presentation"
              value={
                data.currentPresentation?.presentationName ||
                data.currentPresentation?.presentationId ||
                "Not reported"
              }
            />
            <ActivityFact
              label="Last healthy playback"
              value={formatDate(data.lastHealthyPlayback)}
            />
            <ActivityFact
              label="Last manifest activation"
              value={formatDate(data.lastSuccessfulManifestActivation)}
            />
            <ActivityFact label="Playback gaps" value={data.playbackGaps} />
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
                  Reported {formatDate(data.currentIssue.occurredAt)}
                </span>
              </AlertDescription>
            </Alert>
          )}

          <ScreenTimeline screenId={screenId} />

          <div className="grid min-w-0 gap-6 xl:grid-cols-2">
            <ActivityList
              title="Recent proof of play"
              empty="No proof of play has been reported."
              items={data.recentProofOfPlay.map((item) => ({
                id: item.id,
                label:
                  item.contentName ||
                  item.contentId ||
                  item.presentationName ||
                  item.presentationId ||
                  "Presentation",
                detail: formatDate(item.startedAt),
                status: item.result,
              }))}
            />
            <ActivityList
              title="Recent technical events"
              empty="No technical events have been reported."
              items={data.recentEvents.map((item) => ({
                id: item.id,
                label: humanize(item.eventType),
                detail: `${formatDate(item.timestamp)} · ${item.description}`,
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

function formatDate(value?: string) {
  return value
    ? new Date(value).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Not reported";
}

function humanize(value: string) {
  return value
    .replaceAll("_", " ")
    .replaceAll(".", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
