import type { ReactNode } from "react";
import { cn } from "cn";

/**
 * Canonical discovery row for Studio resource libraries. Domains still own
 * their filter semantics, but search/filter/organization/view controls no
 * longer invent a different wrapping model on every page.
 */
export function CollectionToolbar({
  label,
  search,
  filters,
  organize,
  view,
  actions,
  below,
  className,
}: {
  label: string;
  search?: ReactNode;
  filters?: ReactNode;
  organize?: ReactNode;
  view?: ReactNode;
  actions?: ReactNode;
  below?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-2", className)}>
      <div
        role="group"
        aria-label={label}
        className="flex min-w-0 flex-wrap items-center gap-2"
      >
        {search ? (
          <div className="min-w-56 flex-1 basis-64 max-sm:basis-full">
            {search}
          </div>
        ) : null}
        {filters}
        {(organize || view || actions) && (
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 max-sm:ml-0 max-sm:flex-1">
            {organize}
            {view}
            {actions}
          </div>
        )}
      </div>
      {below}
    </div>
  );
}
