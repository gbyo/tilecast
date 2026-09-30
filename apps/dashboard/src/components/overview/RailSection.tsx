import type { ReactNode } from "react";
import { Link } from "react-router";
import { buttonVariants } from "../ui/button";

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
    <section aria-labelledby={id} className="grid gap-1.5 px-3 py-2.5">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h2 id={id} className="text-sm font-medium">
          {title}
        </h2>
        {action && (
          <Link
            className={buttonVariants({
              variant: "ghost",
              size: "xs",
              className: "-my-1 max-sm:h-9",
            })}
            to={action.to}
          >
            {action.label}
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}
