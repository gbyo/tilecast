const toneText: Record<string, string> = {
  success: "text-[var(--tc-status-success)]",
  info: "text-[var(--tc-status-info)]",
  warning: "text-[var(--tc-status-warning)]",
  danger: "text-[var(--tc-status-danger)]",
  neutral: "text-[var(--tc-status-neutral)]",
};

/** Label with a tone-colored dot, for inline status that is not a badge. */
export function StatusDot({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "success" | "info" | "warning" | "danger" | "neutral";
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-sm ${toneText[tone] ?? toneText.neutral}`}
    >
      <span aria-hidden="true" className="size-2 rounded-full bg-current" />
      {label}
    </span>
  );
}
