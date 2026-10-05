import type { ReactNode } from "react";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";

/** A ToggleGroup that always holds exactly one selected value. */
export function SingleToggleGroup<Value extends string>({
  label,
  value,
  onChange,
  options,
  variant,
  spacing,
}: {
  label: string;
  value: Value;
  onChange: (value: Value) => void;
  options: readonly { value: Value; label: ReactNode; text: string }[];
  variant?: "default" | "outline";
  spacing?: number;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      variant={variant}
      spacing={spacing}
      multiple={false}
      value={[value]}
      onValueChange={(next) => {
        const first = next[0];
        if (first !== undefined) onChange(first as Value);
      }}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          aria-label={option.text}
          title={option.text}
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
