import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { CircleAlert, CircleCheck, Clock } from "lucide-react";
import { listPackageJobs } from "../api/domains/fleet";
import type { PackageJob } from "../api/types";
import { Alert, AlertDescription } from "../components/ui/alert";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../components/ui/item";
import { Skeleton } from "../components/ui/skeleton";
import { DetailSection } from "./detail/DetailSections";
import { jobName } from "./detail/detailView";
import { formatCadence, formatRelativeTime } from "./detail/format";

const maxErrorChars = 160;

/**
 * The declared background jobs of one installed package with the
 * scheduler cursor: cadence, last outcome, and next run. Read-only;
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
    <DetailSection
      id="detail-jobs"
      title={t("packages.jobsTitle")}
      description={t("storeDetail.jobs.description")}
    >
      <ItemGroup render={<ul />} className="gap-2">
        {jobs.data.map((job) => (
          <JobRow key={job.jobId} job={job} />
        ))}
      </ItemGroup>
    </DetailSection>
  );
}

function JobRow({ job }: { job: PackageJob }) {
  const { t, i18n } = useTranslation("plugins");
  const failed = job.lastStatus === "error";
  const never = job.lastStatus === "never" || !job.lastRunAt;
  const lastRun = job.lastRunAt
    ? formatRelativeTime(job.lastRunAt, i18n.language)
    : "";
  const error =
    job.lastError.length > maxErrorChars
      ? `${job.lastError.slice(0, maxErrorChars)}…`
      : job.lastError;
  return (
    <Item
      variant="muted"
      size="sm"
      render={<li />}
      data-status={failed ? "failed" : undefined}
    >
      <ItemMedia variant="icon">
        <JobStatusIcon failed={failed} ok={job.lastStatus === "ok"} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{jobName(job.jobId)}</ItemTitle>
        <ItemDescription className="line-clamp-none">
          <span className="block">
            {formatCadence(job.intervalMinutes, i18n.language, t)}
          </span>
          {failed ? (
            <>
              <span className="block text-destructive">
                {t("storeDetail.jobs.lastFailed", { when: lastRun })}
              </span>
              {job.consecutiveFailures > 1 && (
                <span className="block text-destructive">
                  {t("packages.jobFailures", {
                    count: job.consecutiveFailures,
                  })}
                </span>
              )}
              {error !== "" && (
                <span className="block text-destructive">{error}</span>
              )}
            </>
          ) : (
            <span className="block">
              {never
                ? t("packages.jobNever")
                : t("storeDetail.jobs.lastRun", {
                    when: lastRun,
                    status: t("storeDetail.jobs.successful"),
                  })}
            </span>
          )}
          <span className="block">
            {t("storeDetail.jobs.nextRun", {
              when: formatRelativeTime(job.nextRunAt, i18n.language),
            })}
          </span>
        </ItemDescription>
      </ItemContent>
    </Item>
  );
}

function JobStatusIcon({ failed, ok }: { failed: boolean; ok: boolean }) {
  if (ok) return <CircleCheck aria-hidden="true" />;
  if (failed)
    return <CircleAlert className="text-destructive" aria-hidden="true" />;
  return <Clock aria-hidden="true" />;
}
