import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import { api, ApiError } from "../api/client";
import type { BackupArchive, BackupJob } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useConfirm } from "../components/ConfirmDialog";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button, buttonVariants } from "../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import { Spinner } from "../components/ui/spinner";
import { toast } from "../components/ui/toast";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../components/ui/item";

export function BackupPanel({ owner }: { owner: boolean }) {
  const auth = useAuth();
  const client = useQueryClient();
  const csrf = auth.status?.csrfToken ?? "";
  const query = useQuery({
    queryKey: ["backups"],
    queryFn: api.backups,
    enabled: owner,
    refetchInterval: (result) =>
      result.state.data?.currentJob ? 1_500 : 15_000,
  });
  const refresh = () => client.invalidateQueries({ queryKey: ["backups"] });
  const create = useMutation({
    mutationFn: () => api.createBackup(csrf),
    onSuccess: refresh,
  });
  const verify = useMutation({
    mutationFn: (id: string) => api.verifyBackup(id, csrf),
    onSuccess: refresh,
  });
  const { confirm, dialog: confirmDialog } = useConfirm();
  const restore = useMutation({
    mutationFn: async (archive: BackupArchive) => {
      const plan = await api.backupRestorePlan(archive.id);
      const identityWarning = plan.identityMismatch
        ? " WARNING: This backup belongs to a different installation. Enrolled players will need to be reset and paired again."
        : "";
      const ok = await confirm({
        title: `Restore ${archive.fileName}?`,
        body: `Tilecast will become temporarily unavailable and current database and media state will be replaced. A pre-restore backup will be created first.${identityWarning}`,
        action: "Restore",
        destructive: true,
      });
      if (!ok) throw new CancelledAction();
      return api.restoreBackup(archive.id, plan.identityMismatch, csrf);
    },
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: async (archive: BackupArchive) => {
      const ok = await confirm({
        title: `Delete ${archive.fileName}? This cannot be undone.`,
        action: "Delete",
        destructive: true,
      });
      if (!ok) throw new CancelledAction();
      try {
        return await api.deleteBackup(archive.id, false, csrf);
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.code === "last_backup_protected"
        ) {
          const force = await confirm({
            title: "This is the last complete backup. Delete it anyway?",
            body: "You will have no known-good backup to restore.",
            action: "Delete",
            destructive: true,
          });
          if (force) return api.deleteBackup(archive.id, true, csrf);
        }
        throw error;
      }
    },
    onSuccess: refresh,
  });
  if (!owner)
    return (
      <Alert role="status">
        <AlertDescription>Only the Owner may manage backups.</AlertDescription>
      </Alert>
    );
  if (query.isLoading)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner aria-hidden="true" />
        Loading backups…
      </p>
    );
  if (query.error)
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Backups could not be loaded. {query.error.message}
        </AlertDescription>
      </Alert>
    );
  const data = query.data;
  const busy = Boolean(data?.currentJob);
  const actionError = [
    create.error,
    verify.error,
    restore.error,
    remove.error,
  ].find((error) => error && !(error instanceof CancelledAction));
  return (
    <>
      {confirmDialog}
      <div className="grid gap-4">
        <section className="grid gap-3 rounded-xl border border-border p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="grid gap-1">
              <h3 className="text-base font-semibold">Installation backups</h3>
              <p className="text-sm text-muted-foreground">
                Full backups include the database, media files, thumbnails,
                variants, and cached player updates.
              </p>
            </div>
            <Button
              variant="default"
              disabled={busy || create.isPending}
              onClick={() => {
                void toast
                  .promise(create.mutateAsync(), {
                    loading: "Creating backup…",
                    success: "Backup queued.",
                    error: "Backup could not be created.",
                  })
                  .catch(() => {});
              }}
            >
              {create.isPending ? "Queuing…" : "Create backup"}
            </Button>
          </div>
          {data?.lastSuccessful && (
            <p className="text-sm text-muted-foreground">
              Last successful backup:{" "}
              {formatDate(data.lastSuccessful.createdAt)}
              {data.schedule.nextRunAt
                ? ` · Next scheduled: ${formatDate(data.schedule.nextRunAt)}`
                : ""}
            </p>
          )}
          {data?.currentJob && <JobProgress job={data.currentJob} />}
          {actionError && (
            <Alert variant="destructive">
              <AlertDescription>{actionError.message}</AlertDescription>
            </Alert>
          )}
        </section>
        <section className="grid gap-3 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">Available backups</h3>
            <p className="text-sm text-muted-foreground">
              Verify an archive before relying on it or starting a restore.
            </p>
          </header>
          {!data?.backups.length ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No backups</EmptyTitle>
                <EmptyDescription>
                  No backups have been created yet.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ItemGroup className="gap-2">
              {data.backups.map((archive) => (
                <Item key={archive.id} variant="outline">
                  <ItemMedia variant="icon">
                    <ShieldCheck aria-hidden="true" />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle className="break-all">
                      {archive.fileName}
                    </ItemTitle>
                    <ItemDescription>
                      {formatDate(archive.createdAt)} ·{" "}
                      {formatBytes(archive.sizeBytes)} · {archive.kind}
                    </ItemDescription>
                    <ItemDescription className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant={
                          archive.verification === "verified"
                            ? "default"
                            : "secondary"
                        }
                      >
                        {archive.verification === "verified"
                          ? "Verified"
                          : archive.verification}
                      </Badge>
                      {" · "}Tilecast {archive.tilecastVersion} · schema{" "}
                      {archive.schemaVersion}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions className="flex-wrap">
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => verify.mutate(archive.id)}
                    >
                      <ShieldCheck size={15} aria-hidden="true" /> Verify
                    </Button>
                    <a
                      className={buttonVariants({ variant: "ghost" })}
                      href={`/api/v1/system/backups/${archive.id}/download`}
                    >
                      <Download size={15} aria-hidden="true" /> Download
                    </a>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        void toast
                          .promise(restore.mutateAsync(archive), {
                            loading: "Restoring backup…",
                            success: "Backup restored. Tilecast is restarting.",
                            error: (error) =>
                              error instanceof CancelledAction
                                ? "Restore cancelled."
                                : "Backup could not be restored.",
                          })
                          .catch(() => {});
                      }}
                    >
                      <RotateCcw size={15} aria-hidden="true" /> Restore
                    </Button>
                    <Button
                      variant="destructive"
                      disabled={busy}
                      onClick={() => remove.mutate(archive)}
                      aria-label={`Delete ${archive.fileName}`}
                    >
                      <Trash2 size={15} aria-hidden="true" /> Delete
                    </Button>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          )}
        </section>
        {!!data?.recentJobs.length && (
          <section className="grid gap-3 rounded-xl border border-border p-4">
            <header>
              <h3 className="text-base font-semibold">
                Recent backup activity
              </h3>
            </header>
            <div className="grid gap-2">
              {data.recentJobs.slice(0, 5).map((job) => (
                <div
                  key={job.id}
                  className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border p-3"
                >
                  <span className="grid gap-0.5">
                    <strong className="text-sm font-semibold">
                      {title(job.kind)}
                    </strong>
                    <small className="text-xs text-muted-foreground">
                      {formatDate(job.createdAt)} · {job.trigger}
                    </small>
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {job.status}
                    {job.errorMessage ? ` — ${job.errorMessage}` : ""}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  );
}

function JobProgress({ job }: { job: BackupJob }) {
  return (
    <div
      className="grid gap-2 rounded-xl border border-border p-3"
      role="status"
    >
      <div className="grid gap-0.5">
        <strong className="text-sm font-semibold">
          {title(job.kind)} in progress
        </strong>
        <span className="text-sm text-muted-foreground">
          {job.phase || job.status} · {job.progressPercent}%
        </span>
      </div>
      <progress max={100} value={job.progressPercent} className="w-full" />
    </div>
  );
}
class CancelledAction extends Error {}
function title(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index++) {
    amount /= 1024;
    unit = units[index];
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${unit}`;
}
