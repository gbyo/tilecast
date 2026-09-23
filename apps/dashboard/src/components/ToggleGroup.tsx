import type { ReactNode } from "react";

/** Single-select segmented control with pressed-state buttons. */
export function ToggleGroup<Value extends string>({
  label,
  value,
  items,
  onValueChange,
  className = "",
}: {
  label: string;
  value: Value;
  items: readonly { value: Value; label: ReactNode; disabled?: boolean }[];
  onValueChange: (value: Value) => void;
  className?: string;
}) {
  return (
    <div
      className={`inline-flex flex-wrap items-center gap-0.5 rounded-2xl border border-border bg-muted p-0.5 ${className}`.trim()}
      role="group"
      aria-label={label}
    >
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={value === item.value}
          disabled={item.disabled}
          onClick={() => onValueChange(item.value)}
          className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-sm font-medium transition-colors ${
            value === item.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          } disabled:pointer-events-none disabled:opacity-50`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
