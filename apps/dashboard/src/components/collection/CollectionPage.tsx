import type { ReactNode } from "react";
import { cn } from "cn";
import { PageHeader } from "../PageHeader";

/**
 * Canonical resource-library page frame. Collection pages share one visible
 * hierarchy: title and description, optional metadata, then discovery controls
 * and results. Route breadcrumbs remain location context, not the only heading.
 */
export function CollectionPage({
  title,
  description,
  actions,
  meta,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      data-slot="studio-page"
      className={cn("w-full min-w-0 space-y-5", className)}
    >
      <PageHeader title={title} description={description} actions={actions} />
      {meta ? (
        <div className="-mt-2 text-sm text-muted-foreground tabular-nums">
          {meta}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/**
 * Marks a resource collection for the shared Compact-density contract.
 * Use this around cards, rows, or ItemGroup results instead of repeating the
 * data attribute at every domain surface.
 */
export function CollectionSurface({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div data-density-surface="collection" className={cn("min-w-0", className)}>
      {children}
    </div>
  );
}
