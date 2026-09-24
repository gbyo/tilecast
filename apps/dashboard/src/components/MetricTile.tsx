import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

/** Whether a rising number is good news, so the delta can be toned honestly. */
export type MetricDirection = "up-is-good" | "up-is-bad" | "neutral";

export type MetricDelta = {
  /** Signed change against the comparison period, in the metric's own unit. */
  change: number;
  /**
   * What the change is measured against, such as "previous 24 hours". A delta
   * without a stated comparison period is not interpretable, so it is required.
   */
  comparisonLabel: string;
  direction?: MetricDirection;
  /** Formats the absolute change. Defaults to a plain integer. */
  format?: (change: number) => string;
};

export function MetricTile({
  label,
  value,
  icon: Icon,
  delta,
  hint,
  to,
  className = "",
}: {
  label: string;
  value: ReactNode;
  icon?: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  delta?: MetricDelta;
  /** Supporting context shown under the label, such as the measured population. */
  hint?: string;
  /** Makes the whole tile a link to the records behind the number. */
  to?: string;
  className?: string;
}) {
  const body = (
    <>
      <span className="flex items-center gap-2">
        {Icon && (
          <span className="shrink-0 text-muted-foreground">
            <Icon size={18} aria-hidden={true} />
          </span>
        )}
        <strong className="text-2xl font-semibold tracking-tight tabular-nums">
          {value}
        </strong>
      </span>
      <span className="text-sm font-medium">{label}</span>
      {hint && <small className="text-xs text-muted-foreground">{hint}</small>}
      {delta && <MetricDeltaLabel delta={delta} />}
    </>
  );
  const classes =
    `grid gap-1 rounded-xl border border-border p-4 ${to ? "hover:bg-muted" : ""} ${className}`.trim();
  return to ? (
    <Link className={classes} to={to}>
      {body}
    </Link>
  ) : (
    <article className={classes}>{body}</article>
  );
}

function MetricDeltaLabel({ delta }: { delta: MetricDelta }) {
  const { t } = useTranslation("activity");
  const { change, comparisonLabel, direction = "neutral" } = delta;
  const format = delta.format ?? ((input: number) => String(Math.abs(input)));
  if (change === 0) {
    return (
      <span
        data-tone="flat"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground"
      >
        <Minus size={14} aria-hidden={true} />
        {t("metricTile.unchangedFrom", { comparison: comparisonLabel })}
      </span>
    );
  }
  const rising = change > 0;
  const Icon = rising ? TrendingUp : TrendingDown;
  // "neutral" means the metric has no better or worse direction, so movement is
  // reported without a success or danger tone.
  const tone =
    direction === "neutral"
      ? "flat"
      : (direction === "up-is-good") === rising
        ? "good"
        : "bad";
  return (
    <span
      data-tone={tone}
      className={`inline-flex items-center gap-1 text-xs ${
        tone === "good"
          ? "text-emerald-600 dark:text-emerald-400"
          : tone === "bad"
            ? "text-destructive"
            : "text-muted-foreground"
      }`}
    >
      <Icon size={14} aria-hidden={true} />
      {rising
        ? t("metricTile.deltaUp", {
            change: format(change),
            comparison: comparisonLabel,
          })
        : t("metricTile.deltaDown", {
            change: format(change),
            comparison: comparisonLabel,
          })}
    </span>
  );
}
