import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { PlayerHealth, ReliabilityStatus } from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { screenActivityLink } from "../../pages/activityLinks";

const FAILURE_STATES = new Set([
  "disconnected",
  "renderer_unavailable",
  "presentation_failed",
  "needs_intervention",
]);

function formatInstant(
  value: string | undefined,
  language: string,
): string | null {
  if (!value) return null;
  const millis = new Date(value).getTime();
  if (!Number.isFinite(millis)) return null;
  return new Date(millis).toLocaleString(language, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function HealthDetail({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt>{title}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function RendererDetail({ health }: { health: PlayerHealth }) {
  const { t, i18n } = useTranslation("screens");
  const lastProgress = formatInstant(
    health.lastProgressAt,
    i18n.language || "en",
  );
  if (!health.rendererState && !lastProgress) return null;
  const renderer = health.rendererState
    ? t(`playerHealth.rendererStates.${health.rendererState}`, {
        defaultValue: health.rendererState.replaceAll("_", " "),
      })
    : null;
  const progress = lastProgress
    ? t("playerHealth.lastProgress", { at: lastProgress })
    : null;
  return (
    <HealthDetail title={t("playerHealth.renderer")}>
      {[renderer, progress].filter(Boolean).join(" · ")}
    </HealthDetail>
  );
}

function RecoveryDetail({ health }: { health: PlayerHealth }) {
  const { t, i18n } = useTranslation("screens");
  const lastRecovery = formatInstant(
    health.lastRecoveryAt,
    i18n.language || "en",
  );
  if (
    !health.lastRecoveryReason &&
    !lastRecovery &&
    health.recoveryLevel == null
  )
    return null;
  const level =
    health.recoveryLevel != null
      ? t("playerHealth.recoveryLevel", { level: health.recoveryLevel })
      : null;
  return (
    <HealthDetail title={t("playerHealth.lastRecovery")}>
      {[health.lastRecoveryReason?.replaceAll("_", " "), lastRecovery, level]
        .filter(Boolean)
        .join(" · ")}
    </HealthDetail>
  );
}

function FailureDetail({ reliability }: { reliability?: ReliabilityStatus }) {
  const { t } = useTranslation("screens");
  if (!reliability?.lastRendererFailure) return null;
  const restarts =
    reliability.rendererRestartCount != null
      ? t("playerHealth.restartCount", {
          count: reliability.rendererRestartCount,
        })
      : null;
  return (
    <HealthDetail title={t("playerHealth.lastFailure")}>
      {[reliability.lastRendererFailure.replaceAll("_", " "), restarts]
        .filter(Boolean)
        .join(" · ")}
    </HealthDetail>
  );
}

function UpdateDetail({ health }: { health: PlayerHealth }) {
  const { t } = useTranslation("screens");
  if (!health.updateState && !health.updateError) return null;
  return (
    <HealthDetail title={t("playerHealth.update")}>
      {[health.updateState?.replaceAll("_", " "), health.updateError]
        .filter(Boolean)
        .join(" · ")}
    </HealthDetail>
  );
}

/**
 * One derived presentation of the player's condition, from the server's
 * `playerHealth` object. Intentional sleep, disabled playback, and healthy
 * idle stay quiet; only failures take the destructive treatment.
 */
export function PlayerHealthSummary({
  health,
  reliability,
  screenId,
  loading,
}: {
  health?: PlayerHealth;
  reliability?: ReliabilityStatus;
  screenId: string;
  loading: boolean;
}) {
  const { t, i18n } = useTranslation("screens");
  if (loading && !health) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t("playerHealth.loading")}
      </p>
    );
  }
  if (!health) return null;
  const language = i18n.language || "en";
  const observed = formatInstant(health.observedAt, language);
  return (
    <section
      aria-labelledby="player-health-heading"
      className="min-w-0 space-y-3 rounded-xl border border-border bg-muted/20 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 id="player-health-heading" className="text-sm font-semibold">
          {t("playerHealth.title")}
        </h4>
        <Badge
          variant={FAILURE_STATES.has(health.state) ? "destructive" : "outline"}
        >
          {t(`playerHealth.states.${health.state}`, {
            defaultValue: health.state.replaceAll("_", " "),
          })}
        </Badge>
      </div>
      <dl className="grid gap-3 sm:grid-cols-2 [&_dd]:mt-1 [&_dd]:break-words [&_dd]:text-sm [&_dt]:text-xs [&_dt]:text-muted-foreground">
        <HealthDetail title={t("playerHealth.observed")}>
          {observed ?? t("shared.notReported")}
        </HealthDetail>
        {health.cause && (
          <HealthDetail title={t("playerHealth.cause")}>
            {t(`playerHealth.causes.${health.cause}`, {
              defaultValue: health.cause.replaceAll("_", " "),
            })}
          </HealthDetail>
        )}
        <RendererDetail health={health} />
        <RecoveryDetail health={health} />
        <FailureDetail reliability={reliability} />
        <UpdateDetail health={health} />
      </dl>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <Link
          to={screenActivityLink(screenId)}
          className="text-primary underline-offset-4 hover:underline"
        >
          {t("playerHealth.links.activity")}
        </Link>
        <Link
          to={`/screens/${screenId}?tab=commands`}
          className="text-primary underline-offset-4 hover:underline"
        >
          {t("playerHealth.links.commands")}
        </Link>
        <Link
          to="/settings/player/updates"
          className="text-primary underline-offset-4 hover:underline"
        >
          {t("playerHealth.links.updates")}
        </Link>
      </p>
    </section>
  );
}
