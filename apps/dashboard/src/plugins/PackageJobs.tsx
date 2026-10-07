import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { CircleAlert, CircleCheck, Clock } from "lucide-react";
import { listPackageJobs } from "../api/domains/fleet";
import type { PackageJob } from "../api/types";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Skeleton } from "../components/ui/skeleton";

/**
 * The declared background jobs of one installed package with the
 * scheduler cursor: cadence, next run, and last outcome. Read-only;
 * the server scheduler owns execution.
 */
export function PackageJobs({ packageId }: { packageId: string }) {
  const { t } = useTranslation("plugins");
  const jobs = useQuery({
    queryKey: ["package-jobs", packageId],
    queryFn: () => listPackageJobs(packageId),
  });

  if (jobs.isLoading) {
    return <Skeleton className="h-24 rounded-xl" />;
  }
  if (jobs.isError || !jobs.data) {
    return (
      <Alert variant="destructive">
        <CircleAlert aria-hidden="true" />
        <AlertDescription>{t("packages.jobsLoadError")}</AlertDescription>
      </Alert>
    );
  }
  return (
    <section aria-label={t("packages.jobsTitle")} className="grid gap-3">
      <h3 className="text-sm font-semibold">{t("packages.jobsTitle")}</h3>
      <ul className="grid gap-3">
        {jobs.data.map((job) => (
          <JobRow key={job.jobId} job={job} />
        ))}
      </ul>
    </section>
  );
}

function JobRow({ job }: { job: PackageJob }) {
  const { t } = useTranslation("plugins");
  return (
    <li className="grid gap-1 rounded-xl border p-4 text-sm">
      <p className="font-medium">
        <span className="font-mono text-xs">{job.jobId}</span>
        <span className="font-normal text-muted-foreground">
          {" · "}
          {t("packages.jobEvery", { minutes: job.intervalMinutes })}
        </span>
      </p>
      <p className="text-muted-foreground">
        {t("packages.jobNext")}: {new Date(job.nextRunAt).toLocaleString()}
      </p>
      <p className="inline-flex items-center gap-1.5 text-muted-foreground">
        <JobStatusIcon status={job.lastStatus} />
        <JobOutcome job={job} />
      </p>
    </li>
  );
}

function JobStatusIcon({ status }: { status: string }) {
  if (status === "ok") {
    return <CircleCheck className="size-4 text-green-700" aria-hidden="true" />;
  }
  if (status === "error") {
    return <CircleAlert className="size-4" aria-hidden="true" />;
  }
  return <Clock className="size-4" aria-hidden="true" />;
}

function JobOutcome({ job }: { job: PackageJob }) {
  const { t } = useTranslation("plugins");
  if (job.lastStatus === "never" || !job.lastRunAt) {
    return <span>{t("packages.jobNever")}</span>;
  }
  const at = new Date(job.lastRunAt).toLocaleString();
  if (job.lastStatus === "ok") {
    return (
      <span>
        {t("packages.jobOk")} · {at}
      </span>
    );
  }
  return (
    <span>
      {t("packages.jobFailed")} · {at}
      {job.consecutiveFailures > 1 &&
        ` · ${t("packages.jobFailures", { count: job.consecutiveFailures })}`}
      {job.lastError !== "" && `: ${job.lastError}`}
    </span>
  );
}
