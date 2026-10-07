import { useTranslation } from "react-i18next";
import { Link, Outlet, useLocation } from "react-router";

/**
 * The Plugins workspace. Installed and Explore are routes, like the Screens
 * fleet and archive views, so refresh, browser navigation, and ordinary link
 * behavior all keep working. The detail page belongs to Explore.
 */
export function PluginsLayout() {
  const { t } = useTranslation("plugins");
  const location = useLocation();
  const explore =
    location.pathname === "/plugins/store" ||
    location.pathname.startsWith("/plugins/store/");

  const linkClass = (active: boolean) =>
    [
      "relative inline-flex h-9 items-center justify-center rounded-md border border-transparent px-2 py-1",
      "text-sm font-medium whitespace-nowrap transition-all hover:text-foreground",
      "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring",
      "after:absolute after:inset-x-0 after:-bottom-1 after:h-0.5 after:bg-foreground after:transition-opacity",
      active
        ? "text-foreground after:opacity-100"
        : "text-foreground/60 after:opacity-0 dark:text-muted-foreground",
    ].join(" ");

  return (
    <div className="grid gap-4">
      <nav
        aria-label={t("tabs.viewsLabel")}
        className="inline-flex h-9 w-fit items-center gap-1 text-muted-foreground"
      >
        <Link
          to="/plugins"
          aria-current={!explore ? "page" : undefined}
          className={linkClass(!explore)}
        >
          {t("tabs.installed")}
        </Link>
        <Link
          to="/plugins/store"
          aria-current={explore ? "page" : undefined}
          className={linkClass(explore)}
        >
          {t("tabs.explore")}
        </Link>
      </nav>
      <Outlet />
    </div>
  );
}
