import { useTranslation } from "react-i18next";
import { Outlet, useLocation, useNavigate } from "react-router";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/tabs";

/**
 * The Plugins workspace. Installed and Explore are routes, like the Screens
 * fleet and archive views, so refresh and back navigation keep working. The
 * detail page belongs to Explore.
 */
export function PluginsLayout() {
  const { t } = useTranslation("plugins");
  const location = useLocation();
  const navigate = useNavigate();
  const explore =
    location.pathname === "/plugins/store" ||
    location.pathname.startsWith("/plugins/store/");
  const activeTab = explore ? "explore" : "installed";
  return (
    <div className="grid gap-4">
      <Tabs
        value={activeTab}
        onValueChange={(value) =>
          void navigate(value === "explore" ? "/plugins/store" : "/plugins")
        }
      >
        <TabsList variant="line" aria-label={t("tabs.viewsLabel")}>
          <TabsTrigger value="installed">{t("tabs.installed")}</TabsTrigger>
          <TabsTrigger value="explore">{t("tabs.explore")}</TabsTrigger>
        </TabsList>
        <TabsContent value={activeTab} className="outline-none">
          <Outlet />
        </TabsContent>
      </Tabs>
    </div>
  );
}
