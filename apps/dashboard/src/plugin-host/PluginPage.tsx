import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import { Link } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { Alert, AlertDescription } from "../components/ui/alert";
import { PluginActionsMenu } from "../plugins/PluginActionsMenu";
import { usePluginCatalog } from "../plugins/pluginCatalog";
import { canManage } from "../plugins/shared";

/**
 * The page chrome every plugin shares: the way back to Plugins, the title
 * and description, the plugin's own actions, the Remove menu, and the note a
 * read-only user sees. Title and description default to the catalog's, so a
 * plugin that needs nothing custom writes none of this.
 */
export function PluginPage({
  pluginId,
  title,
  description,
  actions,
  children,
}: {
  pluginId: string;
  title?: ReactNode;
  description?: ReactNode;
  /** Primary actions, shown before the overflow menu (for example "New"). */
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const { t } = useTranslation("plugins");
  const auth = useAuth();
  const catalog = usePluginCatalog();
  const plugin = catalog.data?.items.find((item) => item.id === pluginId);
  return (
    <main className="grid gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <Link
            className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
            to="/plugins"
          >
            <ArrowLeft size={15} aria-hidden="true" />{" "}
            {t("shared.backToPlugins")}
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">
            {title ?? plugin?.name}
          </h1>
          <p className="text-sm text-muted-foreground">
            {description ?? plugin?.description}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          <PluginActionsMenu pluginId={pluginId} />
        </div>
      </header>
      {!canManage(auth.status?.user?.role) && (
        <Alert>
          <AlertDescription>{t("shared.manageNote")}</AlertDescription>
        </Alert>
      )}
      {children}
    </main>
  );
}
