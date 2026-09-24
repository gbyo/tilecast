import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { useFormatLocale } from "../i18n";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { Skeleton } from "./ui/skeleton";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "./ui/item";
import { toast } from "./ui/toast";

const initialRevisionCount = 5;
const revisionPageSize = 10;

// A restore is a new edit, not a rewind: it produces a new revision, so the
// state it replaced stays in the history and the restore can itself be undone.
export function PlaylistRevisionsPanel({
  playlistId,
  canRestore,
  embedded = false,
}: {
  playlistId: string;
  canRestore: boolean;
  /** Render inside the shared history Drawer without repeating its title. */
  embedded?: boolean;
}) {
  const { t } = useTranslation("playlists");
  const formatLocale = useFormatLocale();
  const auth = useAuth();
  const client = useQueryClient();
  const csrf = auth.status?.csrfToken ?? "";
  const [result, setResult] = useState<string>();
  const [visibleRevisionCount, setVisibleRevisionCount] =
    useState(initialRevisionCount);

  const revisions = useQuery({
    queryKey: ["playlist-revisions", playlistId],
    queryFn: () => api.playlistRevisions(playlistId),
  });

  const restore = useMutation({
    mutationFn: (revision: number) =>
      api.restorePlaylistRevision(playlistId, revision, csrf),
    onSuccess: (data) => {
      toast.add({ title: t("history.restoredToast"), type: "success" });
      setResult(
        data.skippedItems > 0
          ? t("history.restoredWithSkipped", {
              from: data.restoredFrom,
              to: data.newRevision,
              count: data.skippedItems,
            })
          : t("history.restored", {
              from: data.restoredFrom,
              to: data.newRevision,
            }),
      );
      void client.invalidateQueries({ queryKey: ["playlist-revisions"] });
      // The editor caches under ["playlists", id]; invalidating ["playlist"]
      // left the revision badge and timeline stale after a restore.
      void client.invalidateQueries({ queryKey: ["playlists", playlistId] });
    },
  });

  if (revisions.isLoading)
    return (
      <div
        className="grid gap-2"
        aria-busy="true"
        aria-label={t("history.loadingLabel")}
      >
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
      </div>
    );
  if (revisions.error)
    return (
      <Alert variant="destructive">
        <AlertDescription>{revisions.error.message}</AlertDescription>
      </Alert>
    );

  const revisionItems = revisions.data?.items ?? [];
  const visibleRevisions = revisionItems.slice(0, visibleRevisionCount);
  const hiddenRevisionCount = revisionItems.length - visibleRevisions.length;

  return (
    <section
      className="grid gap-4"
      aria-label={embedded ? t("history.panelLabel") : undefined}
    >
      {embedded ? (
        <p className="text-sm text-muted-foreground">
          {t("history.intro", { kept: revisions.data?.kept ?? 0 })}
        </p>
      ) : (
        <header className="grid gap-1">
          <h3 className="text-sm font-medium">{t("history.title")}</h3>
          <p className="text-sm text-muted-foreground">
            {t("history.intro", { kept: revisions.data?.kept ?? 0 })}
          </p>
        </header>
      )}

      {result && (
        <Alert role="status">
          <AlertDescription>{result}</AlertDescription>
        </Alert>
      )}
      {restore.error && (
        <Alert variant="destructive">
          <AlertDescription>{restore.error.message}</AlertDescription>
        </Alert>
      )}

      {revisionItems.length === 0 ? (
        <Empty className="border-0 py-6">
          <EmptyHeader>
            <EmptyTitle>{t("history.noRevisions")}</EmptyTitle>
            <EmptyDescription>{t("history.noRevisionsHint")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup className="gap-0 divide-y divide-border border-y border-border">
          {visibleRevisions.map((revision) => (
            <Item
              key={revision.revision}
              size="sm"
              className="rounded-none px-0"
            >
              <ItemContent>
                <ItemTitle>
                  {revision.isCurrent
                    ? t("history.revisionCurrent", {
                        revision: revision.revision,
                      })
                    : t("history.revision", { revision: revision.revision })}
                </ItemTitle>
                <ItemDescription>
                  {t("history.revisionMeta", {
                    date: new Date(revision.createdAt).toLocaleString(
                      formatLocale,
                    ),
                    items: t("count.items", { count: revision.itemCount }),
                  })}
                  {revision.authorName ? ` · ${revision.authorName}` : ""}
                  {revision.missingReferences > 0
                    ? ` · ${t("history.deletedSince", {
                        count: revision.missingReferences,
                      })}`
                    : ""}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                {canRestore && revision.restorable ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={restore.isPending}
                    onClick={() => {
                      setResult(undefined);
                      restore.mutate(revision.revision);
                    }}
                  >
                    <History aria-hidden="true" /> {t("history.restore")}
                  </Button>
                ) : revision.isCurrent ? (
                  t("history.currentBadge")
                ) : (
                  t("history.nothingToRestore")
                )}
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}

      {(hiddenRevisionCount > 0 ||
        visibleRevisionCount > initialRevisionCount) && (
        <div className="flex flex-wrap items-center gap-2">
          {hiddenRevisionCount > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                setVisibleRevisionCount((current) =>
                  Math.min(current + revisionPageSize, revisionItems.length),
                )
              }
            >
              {t("history.showOlder", {
                count: Math.min(revisionPageSize, hiddenRevisionCount),
              })}
            </Button>
          )}
          {visibleRevisionCount > initialRevisionCount && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setVisibleRevisionCount(initialRevisionCount)}
            >
              {t("history.showRecent")}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
