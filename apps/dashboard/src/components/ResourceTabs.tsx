import { Link, useLocation } from "react-router";

/**
 * Route navigation rendered as real links, so destinations can be opened in
 * a new tab like any other destination. Same-page state selection belongs in
 * actual Tabs or filter controls, rather than a link to the current route.
 */
export function ResourceTabs({
  label,
  tabs,
  className = "",
}: {
  label: string;
  tabs: readonly { label: string; to: string }[];
  className?: string;
}) {
  const location = useLocation();
  return (
    <nav aria-label={label} className={className}>
      <div className="flex w-fit flex-wrap items-center gap-4 border-b border-border">
        {tabs.map((tab) => {
          const current = location.pathname === tab.to;
          return (
            <span key={tab.to} className="flex-none px-2">
              <Link
                to={tab.to}
                aria-current={current ? "page" : undefined}
                data-state={current ? "current" : "other"}
                className="inline-flex items-center rounded-none border-b-2 border-transparent px-0 py-2 text-sm text-muted-foreground hover:text-foreground data-[state=current]:border-primary data-[state=current]:font-semibold data-[state=current]:text-foreground"
              >
                {tab.label}
              </Link>
            </span>
          );
        })}
      </div>
    </nav>
  );
}
