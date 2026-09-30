import type { ReactNode } from "react";
import { HeaderLink } from "./HeaderLink";
import { titleRow } from "./layout";

/**
 * One titled section of the supporting rail. Sections share a single Card and
 * are divided by rules, so the rail is one grouped surface rather than a stack
 * of boxes.
 */
export function RailSection({
  id,
  title,
  action,
  children,
}: {
  id: string;
  title: string;
  action?: { label: string; to: string };
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="grid gap-2 px-(--card-spacing) pt-(--card-spacing) pb-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id={id} className={titleRow}>
          {title}
        </h2>
        {action && <HeaderLink to={action.to} label={action.label} />}
      </div>
      {children}
    </section>
  );
}
