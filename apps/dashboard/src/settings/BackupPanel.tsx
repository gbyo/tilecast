import { formatBytes } from "../lib/formatBytes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDateTime } from "../lib/dateTime";
import { useTranslation } from "react-i18next";
import { Download, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import { api, ApiError } from "../api/client";
import { apiErrorMessage, translateKnown, useFormatLocale } from "../i18n";
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
  const { t } = useTranslation(["settings", "common"]);
  const locale = useFormatLocale();
  const auth = useAuth();
  const client = useQueryClient();
  const csrf = auth.status?.csrfToken ?? "";
  // Backend values stay API tokens; the labels follow the interface language.
  const kindLabel = (kind: string) => {
    switch (kind) {
      case "manual":
        return t("backups.kinds.manual");
      case "scheduled":
        return t("backups.kinds.scheduled");
      case "pre_restore":
        return t("backups.kinds.preRestore");
      case "imported":
        return t("backups.kinds.imported");
      default:
        return kind;
    }
  };
  const verificationLabel = (state: string) => {
    switch (state) {
      case "verified":
        return t("backups.verified");
      case "unverified":
        return t("backups.verification.unverified");
      case "failed":
        return t("backups.verification.failed");
      default:
        return state;
    }
  };
  const jobKindLabel = (kind: string) => {
    switch (kind) {
      case "backup":
        return t("backups.jobKinds.backup");
      case "verify":
        return t("backups.jobKinds.verify");
      case "restore":
        return t("backups.jobKinds.restore");
      default:
        return kind;
    }
  };
  const jobStatusLabel = (status: string) => {
    switch (status) {
      case "queued":
        return t("backups.jobStatuses.queued");
      case "running":
        return t("backups.jobStatuses.running");
      case "succeeded":
        return t("backups.jobStatuses.succeeded");
      case "failed":
        return t("backups.jobStatuses.failed");
      case "cancelled":
        return t("backups.jobStatuses.cancelled");
      default:
        return status;
    }
  };
  const triggerLabel = (trigger: string) => {
    switch (trigger) {
      case "manual":
        return t("backups.triggers.manual");
      case "scheduled":
        return t("backups.triggers.scheduled");
      case "pre_restore":
        return t("backups.triggers.preRestore");
      default:
        return trigger;
    }
  };
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
      const ok = await confirm({
        title: t("backups.restoreTitle", { fileName: archive.fileName }),
        body: plan.identityMismatch
          ? t("backups.restoreBodyMismatch")
          : t("backups.restoreBody"),
        action: t("backups.restoreAction"),
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
        title: t("backups.deleteTitle", { fileName: archive.fileName }),
        action: t("common:actions.delete"),
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
            title: t("backups.deleteLastTitle"),
            body: t("backups.deleteLastBody"),
            action: t("common:actions.delete"),
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
        <AlertDescription>{t("backups.ownerOnly")}</AlertDescription>
      </Alert>
    );
  if (query.isLoading)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner aria-hidden="true" />
        {t("backups.loading")}
      </p>
    );
  if (query.error)
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {t("backups.loadError")} {apiErrorMessage(query.error)}
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
              <h3 className="text-base font-semibold">{t("backups.title")}</h3>
              <p className="text-sm text-muted-foreground">
                {t("backups.description")}
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
              {create.isPending ? t("backups.queuing") : t("backups.create")}
            </Button>
          </div>
          {data?.lastSuccessful && (
            <p className="text-sm text-muted-foreground">
              {t("backups.lastSuccessful")}{" "}
              {formatDateTime(data.lastSuccessful.createdAt, locale)}
              {data.schedule.nextRunAt
                ? t("backups.nextScheduled", {
                    date: formatDateTime(data.schedule.nextRunAt, locale),
                  })
                : ""}
            </p>
          )}
          {data?.currentJob && (
            <JobProgress
              job={data.currentJob}
              kindLabel={jobKindLabel(data.currentJob.kind)}
              statusLabel={jobStatusLabel(data.currentJob.status)}
            />
          )}
          {actionError && (
            <Alert variant="destructive">
              <AlertDescription>{actionError.message}</AlertDescription>
            </Alert>
          )}
        </section>
        <section className="grid gap-3 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">
              {t("backups.available")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("backups.availableHint")}
            </p>
          </header>
          {!data?.backups.length ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{t("backups.empty")}</EmptyTitle>
                <EmptyDescription>{t("backups.emptyHint")}</EmptyDescription>
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
                      {formatDateTime(archive.createdAt, locale)} ·{" "}
                      {formatBytes(archive.sizeBytes, locale)} ·{" "}
                      {kindLabel(archive.kind)}
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
                          ? t("backups.verified")
                          : verificationLabel(archive.verification)}
                      </Badge>
                      {t("backups.versionMeta", {
                        tilecastVersion: archive.tilecastVersion,
                        schemaVersion: archive.schemaVersion,
                      })}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions className="flex-wrap">
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => verify.mutate(archive.id)}
                    >
                      <ShieldCheck size={15} aria-hidden="true" />{" "}
                      {t("backups.verify")}
                    </Button>
                    <a
                      className={buttonVariants({ variant: "ghost" })}
                      href={`/api/v1/system/backups/${archive.id}/download`}
                    >
                      <Download size={15} aria-hidden="true" />{" "}
                      {t("backups.download")}
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
                      <RotateCcw size={15} aria-hidden="true" />{" "}
                      {t("backups.restore")}
                    </Button>
                    <Button
                      variant="destructive"
                      disabled={busy}
                      onClick={() => remove.mutate(archive)}
                      aria-label={t("backups.deleteArchive", {
                        fileName: archive.fileName,
                      })}
                    >
                      <Trash2 size={15} aria-hidden="true" />{" "}
                      {t("common:actions.delete")}
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
              <h3 className="text-base font-semibold">{t("backups.recent")}</h3>
            </header>
            <div className="grid gap-2">
              {data.recentJobs.slice(0, 5).map((job) => (
                <div
                  key={job.id}
                  className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border p-3"
                >
                  <span className="grid gap-0.5">
                    <strong className="text-sm font-semibold">
                      {jobKindLabel(job.kind)}
                    </strong>
                    <small className="text-xs text-muted-foreground">
                      {formatDateTime(job.createdAt, locale)} ·{" "}
                      {triggerLabel(job.trigger)}
                    </small>
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {jobStatusLabel(job.status)}
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

// Phases the server names with a fixed token. Per-table and per-component
// phases carry a dynamic suffix, so they, and any token this list lacks, show
// their raw value.
const fixedBackupPhases = new Set([
  "checking_disk_space",
  "database_snapshot",
  "pre_restore_backup",
  "finalizing_archive",
  "verifying",
  "verifying_archive",
  "staging_files",
  "restoring_database",
  "activating_files",
  "validating",
  "finalizing",
  "complete",
]);

function backupPhaseLabel(phase: string): string {
  return fixedBackupPhases.has(phase)
    ? translateKnown(`settings:backups.phases.${phase}`, phase)
    : phase;
}

function JobProgress({
  job,
  kindLabel,
  statusLabel,
}: {
  job: BackupJob;
  kindLabel: string;
  statusLabel: string;
}) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <div
      className="grid gap-2 rounded-xl border border-border p-3"
      role="status"
    >
      <div className="grid gap-0.5">
        <strong className="text-sm font-semibold">
          {t("backups.jobInProgress", { kind: kindLabel })}
        </strong>
        <span className="text-sm text-muted-foreground">
          {job.phase ? backupPhaseLabel(job.phase) : statusLabel} ·{" "}
          {job.progressPercent}%
        </span>
      </div>
      <progress max={100} value={job.progressPercent} className="w-full" />
    </div>
  );
}
class CancelledAction extends Error {}
