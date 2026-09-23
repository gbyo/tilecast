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
  autoFocus = false,
}: {
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  placeholder: string;
  autoFocus?: boolean;
}) {
  return (
    <InputGroup className="w-full max-w-105 flex-1 basis-70">
      <InputGroupAddon>
        <Search size={16} aria-hidden="true" />
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
        <InputGroupButton
          aria-label={`Clear ${label.toLowerCase()}`}
          onClick={() => onValueChange("")}
        >
          <X size={14} aria-hidden="true" />
        </InputGroupButton>
      )}
    </InputGroup>
  );
}
