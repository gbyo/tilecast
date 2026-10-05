import { useId } from "react";

/**
 * A quiet trend line for a metric cell: no axes, labels, or tooltip, drawn in
 * `currentColor` with a soft vertical fade so it stays behind the figure it
 * supports. Values are percentages on a fixed 0–100 scale, so a flat line means a
 * steady share, never an exaggerated wobble. A null value (an hour with no
 * measurement) breaks the line instead of being drawn as zero.
 */
export function Sparkline({
  values,
  className = "",
}: {
  values: (number | null)[];
  className?: string;
}) {
  const gradientId = useId().replaceAll(":", "");
  if (values.filter((value) => value !== null).length < 2) return null;
  const step = 100 / (values.length - 1);
  const y = (value: number) =>
    30 - (Math.min(100, Math.max(0, value)) / 100) * 28;

  // One segment per unbroken run of measured hours.
  const runs: { x: number; y: number }[][] = [];
  let run: { x: number; y: number }[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (run.length) runs.push(run);
      run = [];
    } else {
      run.push({ x: index * step, y: y(value) });
    }
  });
  if (run.length) runs.push(run);

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      className={`pointer-events-none ${className}`}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity={0.18} />
          <stop offset="100%" stopColor="currentColor" stopOpacity={0.02} />
        </linearGradient>
      </defs>
      {runs
        .filter((points) => points.length > 1)
        .map((points) => {
          const line = points
            .map((point, index) => `${index ? "L" : "M"}${point.x},${point.y}`)
            .join(" ");
          const first = points[0]!;
          const last = points.at(-1)!;
          return (
            <g key={first.x}>
              <path
                d={`${line} L${last.x},30 L${first.x},30 Z`}
                fill={`url(#${gradientId})`}
              />
              <path
                d={line}
                fill="none"
                stroke="currentColor"
                strokeOpacity={0.6}
                strokeWidth={1.25}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        })}
    </svg>
  );
}
