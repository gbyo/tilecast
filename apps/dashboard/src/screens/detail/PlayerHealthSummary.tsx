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
  const lastProgress = formatInstant(health.lastProgressAt, language);
  const lastRecovery = formatInstant(health.lastRecoveryAt, language);
  const rows: { title: string; body: React.ReactNode }[] = [
    {
      title: t("playerHealth.observed"),
      body: observed ?? t("shared.notReported"),
    },
  ];
  if (health.cause) {
    rows.push({
      title: t("playerHealth.cause"),
      body: t(`playerHealth.causes.${health.cause}`, {
        defaultValue: health.cause.replaceAll("_", " "),
      }),
    });
  }
  if (health.rendererState || lastProgress) {
    rows.push({
      title: t("playerHealth.renderer"),
      body: [
        health.rendererState
          ? t(`playerHealth.rendererStates.${health.rendererState}`, {
              defaultValue: health.rendererState.replaceAll("_", " "),
            })
          : null,
        lastProgress
          ? t("playerHealth.lastProgress", { at: lastProgress })
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }
  if (
    health.lastRecoveryReason ||
    lastRecovery ||
    health.recoveryLevel != null
  ) {
    rows.push({
      title: t("playerHealth.lastRecovery"),
      body: [
        health.lastRecoveryReason?.replaceAll("_", " "),
        lastRecovery,
        health.recoveryLevel != null
          ? t("playerHealth.recoveryLevel", { level: health.recoveryLevel })
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }
  if (reliability?.lastRendererFailure) {
    rows.push({
      title: t("playerHealth.lastFailure"),
      body: [
        reliability.lastRendererFailure.replaceAll("_", " "),
        reliability.rendererRestartCount != null
          ? t("playerHealth.restartCount", {
              count: reliability.rendererRestartCount,
            })
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }
  if (health.updateState || health.updateError) {
    rows.push({
      title: t("playerHealth.update"),
      body: [health.updateState?.replaceAll("_", " "), health.updateError]
        .filter(Boolean)
        .join(" · "),
    });
  }
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
        {rows.map((row) => (
          <div key={row.title}>
            <dt>{row.title}</dt>
            <dd>{row.body}</dd>
          </div>
        ))}
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
