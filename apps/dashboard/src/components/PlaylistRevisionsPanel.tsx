import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { useFormatLocale } from "../i18n";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";

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
    return <div className="table-loading">{t("history.loading")}</div>;
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
      className={`settings-subsection${embedded ? " playlist-history-panel" : ""}`}
      aria-label={embedded ? t("history.panelLabel") : undefined}
    >
      {embedded ? (
        <p className="playlist-history-panel__intro">
          {t("history.intro", { kept: revisions.data?.kept ?? 0 })}
        </p>
      ) : (
        <header>
          <h3>{t("history.title")}</h3>
          <p>{t("history.intro", { kept: revisions.data?.kept ?? 0 })}</p>
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

      <div className="backup-job-list">
        {visibleRevisions.map((revision) => (
          <div key={revision.revision}>
            <span>
              <strong>
                {revision.isCurrent
                  ? t("history.revisionCurrent", {
                      revision: revision.revision,
                    })
                  : t("history.revision", { revision: revision.revision })}
              </strong>
              <small>
                {t("history.revisionMeta", {
                  date: new Date(revision.createdAt).toLocaleString(
                    formatLocale,
                  ),
                  items: t("count.items", { count: revision.itemCount }),
                })}
                {revision.authorName ? <> · {revision.authorName}</> : ""}
                {revision.missingReferences > 0 ? (
                  <>
                    {" "}
                    ·{" "}
                    {t("history.deletedSince", {
                      count: revision.missingReferences,
                    })}
                  </>
                ) : (
                  ""
                )}
              </small>
            </span>
            <span className="backup-job-status">
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
                  <History size={14} /> {t("history.restore")}
                </Button>
              ) : revision.isCurrent ? (
                t("history.currentBadge")
              ) : (
                t("history.nothingToRestore")
              )}
            </span>
          </div>
        ))}
      </div>

      {(hiddenRevisionCount > 0 ||
        visibleRevisionCount > initialRevisionCount) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
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
