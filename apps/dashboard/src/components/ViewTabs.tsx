import type { ReactNode } from "react";
import { Button } from "./ui/button";

export type ViewTab<Value extends string> = {
  value: Value;
  label: ReactNode;
  marker?: ReactNode;
  disabled?: boolean;
};

/**
 * Section switcher rendered as real buttons in a navigation landmark, so
 * the accessible output stays "navigation with buttons" rather than a
 * tablist. Arrow-key movement mirrors the retired legacy control.
 */
export function ViewTabs<Value extends string>({
  label,
  value,
  items,
  onValueChange,
  className = "",
}: {
  label: string;
  value: Value;
  items: readonly ViewTab<Value>[];
  onValueChange: (value: Value) => void;
  className?: string;
}) {
  const enabled = items.filter((item) => !item.disabled);
  const move = (current: Value, delta: 1 | -1) => {
    const at = enabled.findIndex((item) => item.value === current);
    const next = enabled[(at + delta + enabled.length) % enabled.length];
    if (next) onValueChange(next.value);
  };
  return (
    <nav aria-label={label} className={className}>
      <div className="flex w-fit flex-wrap items-center gap-4 border-b border-border">
        {items.map((item) => {
          const selected = item.value === value;
          return (
            <span key={item.value} className="flex-none px-2">
              <Button
                variant="ghost"
                aria-current={selected ? "page" : undefined}
                data-state={selected ? "current" : "other"}
                disabled={item.disabled}
                onClick={() => onValueChange(item.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowRight") move(item.value, 1);
                  else if (event.key === "ArrowLeft") move(item.value, -1);
                }}
                className="rounded-none border-b-2 border-transparent px-0 text-muted-foreground hover:text-foreground data-[state=current]:border-b-primary data-[state=current]:font-semibold data-[state=current]:text-foreground"
              >
                <span>{item.label}</span>
                {item.marker && <small>{item.marker}</small>}
              </Button>
            </span>
          );
        })}
      </div>
    </nav>
  );
}
