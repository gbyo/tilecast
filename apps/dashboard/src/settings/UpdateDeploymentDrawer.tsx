import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Search, XCircle } from "lucide-react";
import {
  Button,
  Drawer,
  Notice,
  Spinner,
  StatusBadge,
  StatusDot,
  ViewTabs,
} from "../components/legacy-ui";
import { api } from "../api/client";
import type { Screen, UpdateDeploymentScreen } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import {
  bucketCounts,
  deploymentPollInterval,
  deploymentSegments,
  filterDeploymentScreens,
  screenDownloadPercent,
  screenUpdateDetail,
  screenStateCounts,
  screenUpdateMeaning,
  screenUpdateStages,
  type ScreenFilter,
} from "./playerUpdateStates";

export function UpdateDeploymentDrawer({
  deploymentId,
  screens,
  manageable,
  onClose,
}: {
  deploymentId: string;
  /** The fleet list the panel already holds, for live reachability per target. */
  screens: Screen[];
  manageable: boolean;
  onClose: () => void;
}) {
  const auth = useAuth();
  const client = useQueryClient();
  const [filter, setFilter] = useState<ScreenFilter>("all");
  const [search, setSearch] = useState("");
  const [actionError, setActionError] = useState("");
  const detail = useQuery({
    queryKey: ["update-deployment", deploymentId],
    queryFn: () => api.updateDeployment(deploymentId),
    refetchInterval: (query) => deploymentPollInterval(query.state.data),
    // Ten seconds of an unchanged panel reads as a panel that is not working, so
    // the drawer keeps polling while it is open even if the tab loses focus.
    refetchIntervalInBackground: true,
  });
  const invalidate = async () => {
    await Promise.all([
      client.invalidateQueries({
        queryKey: ["update-deployment", deploymentId],
      }),
      client.invalidateQueries({ queryKey: ["update-deployments"] }),
    ]);
  };
  const retry = useMutation({
    mutationFn: (screenId: string) =>
      api.retryUpdateScreen(
        deploymentId,
        screenId,
        auth.status?.csrfToken ?? "",
      ),
    onMutate: () => setActionError(""),
    onSuccess: invalidate,
    onError: (error: unknown) => setActionError(errorMessage(error)),
  });
  const cancel = useMutation({
    mutationFn: () =>
      api.cancelUpdateDeployment(deploymentId, auth.status?.csrfToken ?? ""),
    onMutate: () => setActionError(""),
    onSuccess: invalidate,
    onError: (error: unknown) => setActionError(errorMessage(error)),
  });

  const deployment = detail.data;
  const allScreens = deployment?.screens ?? [];
  const counts = bucketCounts(allScreens);
  const query = search.trim().toLowerCase();
  const visible = filterDeploymentScreens(allScreens, filter).filter((item) =>
    item.screenName.toLowerCase().includes(query),
  );
  const reachability = new Map(screens.map((item) => [item.id, item.status]));
  const active =
    deployment?.status === "active" || deployment?.status === "paused";

  return (
    <Drawer
      className="deployment-drawer"
      eyebrow={
        deployment
          ? `${deployment.platform === "linux" ? "Linux" : "Android"} · ${deployment.versionName} (${deployment.versionCode})`
          : "Player deployment"
      }
      title={deployment?.name ?? "Deployment"}
      onClose={onClose}
      footer={
        manageable && active ? (
          <div className="deployment-drawer__footer">
            <span>
              Cancelling stops every screen that has not finished. Screens
              already updated stay on the new release.
            </span>
            <Button
              variant="danger"
              loading={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              {!cancel.isPending && <XCircle size={16} aria-hidden="true" />}
              Cancel deployment
            </Button>
          </div>
        ) : undefined
      }
    >
      {detail.isLoading && <Spinner label="Loading screen statuses" />}
      {detail.error && (
        <Notice variant="danger" title="Screen statuses could not be loaded.">
          {errorMessage(detail.error)}
        </Notice>
      )}
      {actionError && <Notice variant="danger">{actionError}</Notice>}
      {deployment && (
        <>
          <dl className="deployment-drawer__facts">
            <div>
              <dt>Status</dt>
              <dd>
                <StatusDot
                  tone={
                    deployment.status === "completed"
                      ? "success"
                      : deployment.status === "cancelled"
                        ? "neutral"
                        : deployment.status === "paused"
                          ? "warning"
                          : "info"
                  }
                  label={humanize(deployment.status)}
                />
              </dd>
            </div>
            <div>
              <dt>Mode</dt>
              <dd>{humanize(deployment.mode)}</dd>
            </div>
            <div>
              <dt>Rollout</dt>
              <dd>
                {deployment.rolloutMode === "canary"
                  ? `${deployment.canarySize} canary first · ${humanize(deployment.rolloutPhase)}`
                  : "All screens at once"}
              </dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>{new Date(deployment.createdAt).toLocaleString()}</dd>
            </div>
          </dl>
          {deployment.pauseReason && (
            <Notice variant="warning" title="Rollout paused">
              {deployment.pauseReason} Remaining screens stay on their current
              version until the deployment is cancelled and re-created.
            </Notice>
          )}
          <DeploymentMeter {...screenStateCounts(allScreens)} />
          <div className="deployment-drawer__controls">
            <ViewTabs
              label="Screen status filter"
              value={filter}
              items={[
                { value: "all", label: `All ${allScreens.length}` },
                {
                  value: "attention",
                  label: `Needs attention ${counts.attention}`,
                },
                { value: "progress", label: `In progress ${counts.progress}` },
                { value: "done", label: `Finished ${counts.done}` },
              ]}
              onValueChange={(value) => setFilter(value)}
            />
            <label className="deployment-drawer__search">
              <span className="visually-hidden">Search screens</span>
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                value={search}
                placeholder="Search screens"
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          </div>
          <ul className="deployment-screen-list">
            {visible.map((item) => (
              <DeploymentScreenRow
                key={item.screenId}
                screen={item}
                artifactSizeBytes={deployment.artifactSizeBytes}
                reachability={reachability.get(item.screenId)}
                manageable={manageable}
                retrying={retry.isPending && retry.variables === item.screenId}
                onRetry={() => retry.mutate(item.screenId)}
              />
            ))}
          </ul>
          {!visible.length && (
            <p className="deployment-drawer__empty">
              {allScreens.length
                ? "No screen matches this filter."
                : "This deployment reaches no screens you can see."}
            </p>
          )}
        </>
      )}
    </Drawer>
  );
}

function DeploymentScreenRow({
  screen,
  artifactSizeBytes,
  reachability,
  manageable,
  retrying,
  onRetry,
}: {
  screen: UpdateDeploymentScreen;
  artifactSizeBytes: number;
  reachability?: string;
  manageable: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  const meaning = screenUpdateMeaning(screen.state);
  const detail = screenUpdateDetail(screen);
  const percent = screenDownloadPercent(screen, artifactSizeBytes);
  return (
    <li className={`deployment-screen deployment-screen--${meaning.bucket}`}>
      <div className="deployment-screen__identity">
        <strong>{screen.screenName}</strong>
        <small>
          {screen.previousVersionCode
            ? `${screen.previousVersionCode} → ${screen.expectedVersionCode}`
            : `First install · ${screen.expectedVersionCode}`}
          {reachability && ` · ${humanize(reachability)}`}
        </small>
      </div>
      <div className="deployment-screen__status">
        <StatusDot tone={meaning.tone} label={meaning.label} />
        {screen.isCanary && <StatusBadge tone="info" label="Canary" />}
        {detail && <small>{detail}</small>}
        {percent !== null && (
          <span className="deployment-screen__download">
            <progress value={percent} max={100} />
            <small>
              {percent}% of {formatBytes(artifactSizeBytes)}
            </small>
          </span>
        )}
        {/* A finished screen needs no trail: every step is behind it, and drawing
            four dots under "Updated" only adds noise to the healthy rows. */}
        {meaning.stage >= 0 && meaning.bucket !== "done" && (
          <StageTrail stage={meaning.stage} />
        )}
      </div>
      <div className="deployment-screen__actions">
        <time
          dateTime={screen.updatedAt}
          title={new Date(screen.updatedAt).toLocaleString()}
        >
          {formatRelative(screen.updatedAt)}
        </time>
        {manageable && screen.state === "failed" && (
          <Button
            variant="secondary"
            compact
            loading={retrying}
            onClick={onRetry}
          >
            {!retrying && <RefreshCw size={14} aria-hidden="true" />}
            Retry
          </Button>
        )}
      </div>
    </li>
  );
}

// The trail names the step rather than drawing a bar, because only the download
// step knows a real percentage.
function StageTrail({ stage }: { stage: number }) {
  return (
    <ol className="deployment-stage-trail" aria-label="Update progress">
      {screenUpdateStages.map((label, index) => (
        <li
          key={label}
          className={
            index < stage
              ? "is-complete"
              : index === stage
                ? "is-current"
                : "is-pending"
          }
          aria-current={index === stage ? "step" : undefined}
        >
          <span aria-hidden="true" />
          {label}
        </li>
      ))}
    </ol>
  );
}

export function DeploymentMeter({
  targetCount,
  succeededCount,
  failedCount,
  waitingForUserCount,
  compact = false,
}: {
  targetCount: number;
  succeededCount: number;
  failedCount: number;
  waitingForUserCount: number;
  compact?: boolean;
}) {
  const segments = deploymentSegments({
    targetCount,
    succeededCount,
    failedCount,
    waitingForUserCount,
  }).filter((segment) => segment.count > 0);
  const total = Math.max(1, targetCount);
  return (
    <div
      className={`deployment-meter${compact ? " deployment-meter--compact" : ""}`}
    >
      <div
        className="deployment-meter__track"
        role="img"
        aria-label={
          targetCount
            ? segments
                .map((segment) => `${segment.count} ${segment.label}`)
                .join(", ")
            : "No screens"
        }
      >
        {segments.map((segment) => (
          <span
            key={segment.key}
            className={`deployment-meter__fill deployment-meter__fill--${segment.tone}`}
            style={{ width: `${(segment.count / total) * 100}%` }}
          />
        ))}
      </div>
      <ul className="deployment-meter__legend">
        {segments.map((segment) => (
          <li key={segment.key}>
            <StatusDot tone={segment.tone} label={`${segment.count}`} />
            {segment.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The request failed.";
}

function humanize(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function formatBytes(value: number) {
  return value >= 1024 ** 3
    ? `${(value / 1024 ** 3).toFixed(1)} GB`
    : `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function formatRelative(value: string) {
  const seconds = Math.max(
    0,
    Math.round((Date.now() - new Date(value).getTime()) / 1000),
  );
  if (seconds < 60) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
