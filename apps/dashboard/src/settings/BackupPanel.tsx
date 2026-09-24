import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Download, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import { api, ApiError } from "../api/client";
import { useFormatLocale } from "../i18n";
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
          {t("backups.loadError")} {query.error.message}
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
              {formatDate(data.lastSuccessful.createdAt, locale)}
              {data.schedule.nextRunAt
                ? t("backups.nextScheduled", {
                    date: formatDate(data.schedule.nextRunAt, locale),
                  })
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
                      {formatDate(archive.createdAt, locale)} ·{" "}
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
                          ? t("backups.verified")
                          : archive.verification}
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
                      {title(job.kind)}
                    </strong>
                    <small className="text-xs text-muted-foreground">
                      {formatDate(job.createdAt, locale)} · {job.trigger}
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
  const { t } = useTranslation(["settings", "common"]);
  return (
    <div
      className="grid gap-2 rounded-xl border border-border p-3"
      role="status"
    >
      <div className="grid gap-0.5">
        <strong className="text-sm font-semibold">
          {t("backups.jobInProgress", { kind: title(job.kind) })}
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
function formatDate(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
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
