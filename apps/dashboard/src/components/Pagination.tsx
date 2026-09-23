import type { ReactNode } from "react";
import { Button } from "./ui/button";

/** Previous/next pager with a text status. */
export function Pagination({
  label,
  previous,
  next,
  previousDisabled,
  nextDisabled,
  status,
  className = "",
}: {
  label: string;
  previous: () => void;
  next: () => void;
  previousDisabled?: boolean;
  nextDisabled?: boolean;
  status?: ReactNode;
  className?: string;
}) {
  return (
    <nav
      className={`flex flex-wrap items-center gap-2 ${className}`.trim()}
      aria-label={label}
    >
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={previousDisabled}
        onClick={previous}
      >
        Previous
      </Button>
      {status && (
        <span className="text-sm text-muted-foreground">{status}</span>
      )}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={nextDisabled}
        onClick={next}
      >
        Next
      </Button>
    </nav>
  );
}
