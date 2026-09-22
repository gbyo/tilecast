import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import { api, ApiError } from "../api/client";
import type { BackupArchive, BackupJob } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useSpectrumDialogs } from "../dialogs/SpectrumDialogs";

export function BackupPanel({ owner }: { owner: boolean }) {
  const { confirm } = useSpectrumDialogs();
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
  const restore = useMutation({
    mutationFn: async (archive: BackupArchive) => {
      const plan = await api.backupRestorePlan(archive.id);
      const identityWarning = plan.identityMismatch
        ? "This backup belongs to a different installation. Enrolled players will need to be reset and paired again."
        : undefined;
      if (!(await confirm({
        title: `Restore ${archive.fileName}?`,
        description: [
          "Tilecast will become temporarily unavailable while current database and media state are replaced. A pre-restore backup will be created first.",
          identityWarning,
        ].filter(Boolean).join(" "),
        confirmLabel: "Restore backup",
        tone: "negative",
      })))
        throw new CancelledAction();
      return api.restoreBackup(archive.id, plan.identityMismatch, csrf);
    },
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: async (archive: BackupArchive) => {
      if (!(await confirm({
        title: `Delete ${archive.fileName}?`,
        description: "This cannot be undone.",
        confirmLabel: "Delete backup",
        tone: "negative",
      })))
        throw new CancelledAction();
      try {
        return await api.deleteBackup(archive.id, false, csrf);
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.code === "last_backup_protected" &&
          await confirm({
            title: "Delete the last complete backup?",
            description:
              "You will have no known-good backup to restore.",
            confirmLabel: "Delete last backup",
            tone: "negative",
          })
        )
          return api.deleteBackup(archive.id, true, csrf);
        throw error;
      }
    },
    onSuccess: refresh,
  });
  if (!owner)
    return <div className="notice">Only the Owner may manage backups.</div>;
  if (query.isLoading)
    return <div className="table-loading">Loading backups…</div>;
  if (query.error)
    return (
      <div className="notice notice--error" role="alert">
        Backups could not be loaded. {query.error.message}
      </div>
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
    <div className="settings-sections backup-settings">
      <section className="settings-subsection">
        <div className="settings-subsection__action">
          <div>
            <h3>Installation backups</h3>
            <p>
              Full backups include the database, media files, thumbnails,
              variants, and cached player updates.
            </p>
          </div>
          <button
            className="button button--primary"
            disabled={busy || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "Queuing…" : "Create backup"}
          </button>
        </div>
        {data?.lastSuccessful && (
          <p className="backup-summary">
            Last successful backup: {formatDate(data.lastSuccessful.createdAt)}
            {data.schedule.nextRunAt
              ? ` · Next scheduled: ${formatDate(data.schedule.nextRunAt)}`
              : ""}
          </p>
        )}
        {data?.currentJob && <JobProgress job={data.currentJob} />}
        {actionError && (
          <div className="notice notice--error" role="alert">
            {actionError.message}
          </div>
        )}
      </section>
      <section className="settings-subsection">
        <header>
          <h3>Available backups</h3>
          <p>Verify an archive before relying on it or starting a restore.</p>
        </header>
        {!data?.backups.length ? (
          <div className="empty-card">No backups have been created yet.</div>
        ) : (
          <div className="backup-list">
            {data.backups.map((archive) => (
              <article className="backup-row" key={archive.id}>
                <div className="backup-row__details">
                  <strong>{archive.fileName}</strong>
                  <span>
                    {formatDate(archive.createdAt)} ·{" "}
                    {formatBytes(archive.sizeBytes)} · {archive.kind}
                  </span>
                  <span>
                    <span
                      className={`status-badge status-badge--${archive.verification === "verified" ? "online" : "recent"}`}
                    >
                      {archive.verification === "verified"
                        ? "Verified"
                        : archive.verification}
                    </span>
                    {" · "}Tilecast {archive.tilecastVersion} · schema{" "}
                    {archive.schemaVersion}
                  </span>
                </div>
                <div className="backup-row__actions">
                  <button
                    className="button button--quiet"
                    disabled={busy}
                    onClick={() => verify.mutate(archive.id)}
                  >
                    <ShieldCheck size={15} /> Verify
                  </button>
                  <a
                    className="button button--quiet"
                    href={`/api/v1/system/backups/${archive.id}/download`}
                  >
                    <Download size={15} /> Download
                  </a>
                  <button
                    className="button button--quiet"
                    disabled={busy}
                    onClick={() => restore.mutate(archive)}
                  >
                    <RotateCcw size={15} /> Restore
                  </button>
                  <button
                    className="button button--danger"
                    disabled={busy}
                    onClick={() => remove.mutate(archive)}
                    aria-label={`Delete ${archive.fileName}`}
                  >
                    <Trash2 size={15} /> Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      {!!data?.recentJobs.length && (
        <section className="settings-subsection">
          <header>
            <h3>Recent backup activity</h3>
          </header>
          <div className="backup-job-list">
            {data.recentJobs.slice(0, 5).map((job) => (
              <div key={job.id}>
                <span>
                  <strong>{title(job.kind)}</strong>
                  <small>
                    {formatDate(job.createdAt)} · {job.trigger}
                  </small>
                </span>
                <span className="backup-job-status">
                  {job.status}
                  {job.errorMessage ? ` — ${job.errorMessage}` : ""}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function JobProgress({ job }: { job: BackupJob }) {
  return (
    <div className="backup-progress" role="status">
      <div>
        <strong>{title(job.kind)} in progress</strong>
        <span>
          {job.phase || job.status} · {job.progressPercent}%
        </span>
      </div>
      <progress max={100} value={job.progressPercent} />
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
