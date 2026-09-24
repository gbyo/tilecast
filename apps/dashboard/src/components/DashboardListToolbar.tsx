import { Search, X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "cn";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "./ui/input-group";

export function DashboardListToolbar({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("mb-4 flex w-full flex-wrap items-center gap-2", className)}
    >
      {children}
    </div>
  );
}

export function DashboardSearch({
  value,
  onValueChange,
  label,
  placeholder,
  clearLabel,
  autoFocus = false,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  placeholder: string;
  /** Localized clear-button name; falls back to Clear <label> when omitted. */
  clearLabel?: string;
  autoFocus?: boolean;
  className?: string;
}) {
  return (
    <InputGroup className={cn("w-full max-w-105 flex-1 basis-70", className)}>
      <InputGroupAddon>
        <Search aria-hidden="true" />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        autoFocus={autoFocus}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
      />
      {value && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            aria-label={clearLabel ?? `Clear ${label.toLowerCase()}`}
            onClick={() => onValueChange("")}
          >
            <X aria-hidden="true" />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}
