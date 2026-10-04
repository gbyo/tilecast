import { useTranslation } from "react-i18next";
import type { components } from "@tilecast/api-schema/generated/openapi";
import type { PlaylistAssignment } from "../../api/types";
import { Badge } from "../../components/ui/badge";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../../components/ui/item";
import { Progress } from "../../components/ui/progress";
import { Skeleton } from "../../components/ui/skeleton";
import type { PlaybackPlan } from "./screenPlaybackModel";

type Requirements =
  components["schemas"]["PlaybackPlanPresentationRequirements"];
type CapabilityEvidence =
  components["schemas"]["PlaybackPlanCapabilityEvidence"];

function StateRow({
  title,
  children,
  description,
}: {
  title: string;
  children?: React.ReactNode;
  description?: React.ReactNode;
}) {
  return (
    <Item size="sm" className="px-0">
      <ItemContent>
        <ItemTitle className="text-sm font-normal text-muted-foreground">
          {title}
        </ItemTitle>
        {children != null && (
          <ItemDescription className="text-sm font-medium text-foreground">
            {children}
          </ItemDescription>
        )}
        {description}
      </ItemContent>
    </Item>
  );
}

function Requirement({
  requirement,
  label,
  evidence,
}: {
  requirement: Requirements;
  label: string;
  evidence: CapabilityEvidence;
}) {
  const { t } = useTranslation("screens");
  const status =
    requirement.supported === null
      ? "unknown"
      : requirement.supported
        ? "supported"
        : "blocked";
  return (
    <div className="min-w-0 space-y-1 text-xs">
      <p className="flex flex-wrap items-center gap-2">
        <span>{label}</span>
        <Badge variant="outline">{t(`playbackPlan.status.${status}`)}</Badge>
      </p>
      <p>
        {t("playbackPlan.requiredSchema", {
          version: requirement.schemaVersion,
        })}
      </p>
      <ul className="space-y-1">
        {Object.entries(requirement.capabilities)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, version]) => (
            <li key={name} className="break-words">
              {t("playbackPlan.requiredCapability", {
                name,
                version,
                reported: evidence.reported
                  ? ((name === "web.remote"
                      ? evidence.webRuntimeVersion
                      : evidence.nativeCapabilities[name]) ??
                    t("playbackPlan.noneReported"))
                  : t("playbackPlan.noneReported"),
              })}
            </li>
          ))}
      </ul>
      <p className="text-muted-foreground">
        {t("playbackPlan.reportedSchemas", {
          versions:
            evidence.schemaVersions.join(", ") ||
            t("playbackPlan.noneReported"),
        })}
      </p>
    </div>
  );
}

/**
 * Playback tab of the Screen Diagnostics panel. Implementation evidence that
 * explains synchronization, downloads, rendering support, and reported
 * faults; selection itself is explained by "Why this content?".
 */
export function ScreenPlaybackDiagnostics({
  assignment,
  plan,
  loading,
}: {
  assignment?: PlaylistAssignment;
  plan?: PlaybackPlan;
  loading: boolean;
}) {
  const { t } = useTranslation("screens");
  if (loading && !assignment && !plan) {
    return (
      <div
        role="status"
        aria-label={t("diagnostics.playbackLoading")}
        className="space-y-2"
      >
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }
  const current = plan?.current;
  const required = assignment?.requiredBytes ?? 0;
  const downloaded = assignment?.downloadedBytes ?? 0;
  const progress =
    required > 0 ? Math.min(100, Math.round((downloaded / required) * 100)) : 0;
  const takeoverProgress = assignment?.takeoverPreparationProgress ?? 0;

  return (
    <div className="min-w-0 space-y-5">
      <section aria-labelledby="playback-diagnostics-sync" className="min-w-0">
        <h3 id="playback-diagnostics-sync" className="text-sm font-semibold">
          {t("diagnostics.syncTitle")}
        </h3>
        <ItemGroup className="mt-1 gap-0 divide-y divide-border">
          <StateRow title={t("detail.factServerManifest")}>
            {t("detail.manifestVersion", {
              version: assignment?.manifestVersion ?? 1,
            })}
          </StateRow>
          <StateRow title={t("detail.factPlayerManifest")}>
            {assignment?.playerActiveManifestVersion != null
              ? t("detail.manifestVersion", {
                  version: assignment.playerActiveManifestVersion,
                }) +
                (assignment.playerPendingManifestVersion != null
                  ? ` · ${t("diagnostics.pendingManifest", {
                      version: assignment.playerPendingManifestVersion,
                    })}`
                  : "")
              : t("shared.notReported")}
          </StateRow>
          <StateRow title={t("detail.factSynchronization")}>
            {assignment?.synchronizationStatus
              ? t(
                  `playbackPlan.synchronizationStatus.${assignment.synchronizationStatus}`,
                )
              : t("shared.notReported")}
          </StateRow>
          {assignment?.downloadQueueCount != null && (
            <StateRow
              title={t("detail.factDownloads")}
              description={
                required > 0 ? (
                  <Progress
                    value={progress}
                    aria-label={t("detail.downloads", {
                      queued: assignment.downloadQueueCount,
                      downloaded,
                      required,
                    })}
                    className="mt-2"
                  />
                ) : undefined
              }
            >
              {t("detail.downloads", {
                queued: assignment.downloadQueueCount,
                downloaded,
                required,
              })}
            </StateRow>
          )}
          {assignment?.cacheUsedBytes != null && (
            <StateRow title={t("detail.factCache")}>
              {t("detail.cacheUsage", {
                used: assignment.cacheUsedBytes,
                limit: assignment.cacheLimitBytes ?? 0,
              })}
            </StateRow>
          )}
          <StateRow title={t("detail.factClockDifference")}>
            {assignment?.deviceClockOffsetSeconds != null
              ? t("detail.clockOffset", {
                  count: Math.abs(assignment.deviceClockOffsetSeconds),
                })
              : t("shared.notReported")}
          </StateRow>
          <StateRow title={t("detail.factPlayback")}>
            {assignment?.playbackState ?? t("shared.notReported")}
          </StateRow>
          <StateRow title={t("detail.factPlayerConfig")}>
            {assignment?.activeConfigRevision != null
              ? t("detail.configRevision", {
                  revision: assignment.activeConfigRevision,
                })
              : t("shared.notReported")}
          </StateRow>
          {assignment?.activeTakeoverId && (
            <StateRow
              title={t("takeover.title")}
              description={
                <Progress
                  value={takeoverProgress}
                  aria-label={t("detail.takeoverProgress", {
                    state: assignment.takeoverState ?? "pending",
                    progress: takeoverProgress,
                  })}
                  className="mt-2"
                />
              }
            >
              {t("detail.takeoverProgress", {
                state: assignment.takeoverState ?? "pending",
                progress: takeoverProgress,
              })}
            </StateRow>
          )}
        </ItemGroup>
        <p className="mt-2 text-xs text-muted-foreground">
          {t("playbackPlan.synchronizationLimit")}
        </p>
      </section>

      <section
        aria-labelledby="playback-diagnostics-website"
        className="min-w-0"
      >
        <h3 id="playback-diagnostics-website" className="text-sm font-semibold">
          {t("diagnostics.websiteTitle")}
        </h3>
        <ItemGroup className="mt-1 gap-0 divide-y divide-border">
          <StateRow title={t("detail.factWebsite")}>
            {assignment?.websiteState
              ? [
                  assignment.websiteState.replaceAll("_", " "),
                  assignment.websiteCurrentHost,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : t("detail.websiteInactive")}
          </StateRow>
          <StateRow title={t("detail.factBlockedNavigation")}>
            {assignment?.websiteBlockedNavigationCount ??
              t("shared.notReported")}
          </StateRow>
          {assignment?.websiteFailureCategory && (
            <StateRow title={t("detail.websiteTitle")}>
              {assignment.websiteFailureCategory.replaceAll("_", " ")}
            </StateRow>
          )}
        </ItemGroup>
      </section>

      {(assignment?.lastSynchronizationError ||
        assignment?.lastPlaybackError ||
        assignment?.configurationError ||
        assignment?.scheduleEvaluationError) && (
        <section aria-labelledby="playback-diagnostics-errors">
          <h3
            id="playback-diagnostics-errors"
            className="text-sm font-semibold"
          >
            {t("diagnostics.errorsTitle")}
          </h3>
          <ItemGroup className="mt-1 gap-0 divide-y divide-border">
            {assignment.lastSynchronizationError && (
              <StateRow
                title={t("detail.categorizedError", {
                  kind: t("detail.errorKind.sync"),
                })}
              >
                {assignment.lastSynchronizationError}
              </StateRow>
            )}
            {assignment.lastPlaybackError && (
              <StateRow
                title={t("detail.categorizedError", {
                  kind: t("detail.errorKind.playback"),
                })}
              >
                {assignment.lastPlaybackError}
              </StateRow>
            )}
            {assignment.configurationError && (
              <StateRow
                title={t("detail.categorizedError", {
                  kind: t("detail.errorKind.config"),
                })}
              >
                {assignment.configurationError}
              </StateRow>
            )}
            {assignment.scheduleEvaluationError && (
              <StateRow title={t("detail.scheduleEvalTitle")}>
                {assignment.scheduleEvaluationError}
              </StateRow>
            )}
          </ItemGroup>
        </section>
      )}

      {current && (
        <section
          aria-labelledby="playback-diagnostics-capabilities"
          className="min-w-0"
        >
          <h3
            id="playback-diagnostics-capabilities"
            className="text-sm font-semibold"
          >
            {t("playbackPlan.capabilities")}
          </h3>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="outline">
              {t(`playbackPlan.status.${current.capabilities.status}`)}
            </Badge>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t(`playbackPlan.capabilityReasons.${current.capabilities.reason}`)}
          </p>
          <div className="mt-2 space-y-2">
            {current.capabilities.evidence?.widgets.map((widget) => (
              <div
                key={widget.assetId}
                className="min-w-0 space-y-2 rounded-md border border-border p-3"
              >
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="break-words font-medium">{widget.name}</span>
                  <Badge variant="outline">
                    {t(`playbackPlan.status.${widget.status}`)}
                  </Badge>
                </p>
                <p className="text-xs text-muted-foreground">
                  {t(`playbackPlan.widgetReasons.${widget.reason}`)}
                </p>
                {widget.selectedRenderer && (
                  <p className="text-xs">
                    {t("playbackPlan.renderer", {
                      renderer: t(
                        `playbackPlan.renderers.${widget.selectedRenderer}`,
                      ),
                    })}
                  </p>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  {widget.component && (
                    <Requirement
                      requirement={widget.component}
                      label={t("playbackPlan.renderers.component")}
                      evidence={current.capabilities.evidence!}
                    />
                  )}
                  {widget.compatibility && (
                    <Requirement
                      requirement={widget.compatibility}
                      label={t("playbackPlan.renderers.compatibility")}
                      evidence={current.capabilities.evidence!}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("playbackPlan.capabilityLimit")}
          </p>
        </section>
      )}
    </div>
  );
}
