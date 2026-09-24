import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "../api/client";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button, buttonVariants } from "./ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "./ui/empty";
import { Skeleton } from "./ui/skeleton";

export function SnapshotHistoryPanel({ screenId }: { screenId: string }) {
  const history = useQuery({
    queryKey: ["screen-snapshots", screenId],
    queryFn: () => api.screenSnapshots(screenId),
  });
  const [openId, setOpenId] = useState<string>();

  if (history.isLoading)
    return (
      <div className="space-y-2" aria-label="Snapshot history">
        <Skeleton className="aspect-video w-full max-w-sm" />
        <p className="text-sm text-muted-foreground">
          Loading snapshot history…
        </p>
      </div>
    );
  if (history.error)
    return (
      <Alert variant="destructive">
        <AlertTitle>Snapshot history failed to load</AlertTitle>
        <AlertDescription>{history.error.message}</AlertDescription>
      </Alert>
    );

  const data = history.data;
  if (!data?.enabled)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Snapshot history is off.</EmptyTitle>
          <EmptyDescription>
            Tilecast is not keeping images of what this screen showed. An Owner
            or Administrator can turn it on under{" "}
            <Link to="/settings/snapshots">Settings, Snapshot history</Link>.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  if (!data.items.length)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No snapshots yet</EmptyTitle>
          <EmptyDescription>
            Tilecast captures a frame on a schedule from screens that are
            reporting.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  return (
    <div className="space-y-3" aria-label="Snapshot history">
      <p className="text-sm text-muted-foreground">
        Retains up to {data.maxPerScreen} per screen for {data.retentionDays}{" "}
        days.
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {data.items.map((snapshot) => (
          <figure key={snapshot.id} className="min-w-0 space-y-1">
            <Button
              type="button"
              variant="ghost"
              className="block h-auto w-full overflow-hidden rounded-xl border border-border p-0"
              aria-label={`View the snapshot from ${new Date(snapshot.capturedAt).toLocaleString()}`}
              aria-expanded={openId === snapshot.id}
              onClick={() =>
                setOpenId(openId === snapshot.id ? undefined : snapshot.id)
              }
            >
              <img
                src={`/api/v1/screens/${screenId}/snapshots/${snapshot.id}/image`}
                alt={`Screen at ${new Date(snapshot.capturedAt).toLocaleString()}`}
                loading="lazy"
                className="aspect-video w-full object-cover"
              />
            </Button>
            <figcaption className="text-xs text-muted-foreground">
              {new Date(snapshot.capturedAt).toLocaleString()}
              {snapshot.trigger === "manual" ? " · manual" : ""}
            </figcaption>
            {openId === snapshot.id && (
              <EmptyContent className="items-start">
                <a
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                  href={`/api/v1/screens/${screenId}/snapshots/${snapshot.id}/image`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open full size
                </a>
              </EmptyContent>
            )}
          </figure>
        ))}
      </div>
    </div>
  );
}
