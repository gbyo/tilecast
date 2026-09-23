import { Link, useLocation } from "react-router";
import { tabMatchesPath, type WorkspaceTab } from "@/navigation/WorkspaceTabs";

export function WorkspaceNav({
  label,
  tabs,
  className = "",
}: {
  label: string;
  tabs: readonly WorkspaceTab[];
  className?: string;
}) {
  const { pathname } = useLocation();
  const activePath = tabs
    .filter((tab) => tabMatchesPath(tab.to, pathname))
    .sort((left, right) => right.to.length - left.to.length)[0]?.to;

  return (
    <nav
      aria-label={`${label} workspace`}
      className={`flex min-h-10 items-end gap-5 overflow-x-auto border-b border-border ${className}`.trim()}
    >
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const active = tab.to === activePath;
        return (
          <Link
            key={tab.to}
            to={tab.to}
            aria-current={active ? "page" : undefined}
            className={`relative inline-flex h-10 shrink-0 items-center gap-2 border-b-2 px-0.5 text-sm transition-colors ${
              active
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="size-4" aria-hidden="true" />
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
