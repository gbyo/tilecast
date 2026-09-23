import { Link } from "react-router";
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
      {Icon && (
        <span className="metric-tile__icon">
          <Icon size={18} aria-hidden={true} />
        </span>
      )}
      <strong className="metric-tile__value">{value}</strong>
      <span className="metric-tile__label">{label}</span>
      {hint && <small className="metric-tile__hint">{hint}</small>}
      {delta && <MetricDeltaLabel delta={delta} />}
    </>
  );
  const classes = [
    "metric-tile",
    to ? "metric-tile--link" : "",
    Icon ? "metric-tile--with-icon" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return to ? (
    <Link className={classes} to={to}>
      {body}
    </Link>
  ) : (
    <article className={classes}>{body}</article>
  );
}

function MetricDeltaLabel({ delta }: { delta: MetricDelta }) {
  const { change, comparisonLabel, direction = "neutral" } = delta;
  const format = delta.format ?? ((input: number) => String(Math.abs(input)));
  if (change === 0) {
    return (
      <span className="metric-tile__delta metric-tile__delta--flat">
        <Minus size={14} aria-hidden={true} />
        Unchanged from {comparisonLabel}
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
    <span className={`metric-tile__delta metric-tile__delta--${tone}`}>
      <Icon size={14} aria-hidden={true} />
      {rising ? "Up" : "Down"} {format(change)} from {comparisonLabel}
    </span>
  );
}
