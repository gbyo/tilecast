import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MoreHorizontal, PackageMinus } from "lucide-react";
import { useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { Alert, AlertDescription } from "../components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Spinner } from "../components/ui/spinner";
import type { PluginInUseResource } from "../api/types";
import { apiErrorMessage } from "../i18n";
import {
  inUseResources,
  usePluginCatalog,
  usePluginLifecycle,
  type PluginsT,
} from "./pluginCatalog";
import { canManage } from "./shared";

/**
 * The overflow menu on an installed plugin's page. Remove is deliberately a
 * secondary action, and it never deletes plugin data: while the plugin still
 * owns resources the server refuses, and this explains what to delete first.
 */
export function PluginActionsMenu({ pluginId }: { pluginId: string }) {
  const { t } = useTranslation(["plugins", "common"]);
  const auth = useAuth();
  const navigate = useNavigate();
  const catalog = usePluginCatalog();
  const { remove } = usePluginLifecycle(auth.status?.csrfToken ?? "");
  const [open, setOpen] = useState(false);
  const plugin = catalog.data?.items.find((item) => item.id === pluginId);
  if (!plugin?.installed || !canManage(auth.status?.user?.role)) return null;

  const blockers = inUseResources(remove.error);
  const failure =
    remove.error && !blockers ? apiErrorMessage(remove.error) : undefined;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" size="icon" />}
          aria-label={t("actionsMenu.menuLabel", { name: plugin.name })}
        >
          <MoreHorizontal aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            variant="destructive"
            onClick={() => {
              remove.reset();
              setOpen(true);
            }}
          >
            <PackageMinus aria-hidden="true" /> {t("actionsMenu.remove")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          {blockers ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("actionsMenu.blockedTitle", { name: plugin.name })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {blockerSentence(t, blockers)}{" "}
                  {blockerInstruction(t, blockers)}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  {t("actionsMenu.viewLabel", {
                    label: blockers[0]?.label ?? plugin.instanceNounPlural,
                  })}
                </AlertDialogCancel>
              </AlertDialogFooter>
            </>
          ) : (
            <>
              <AlertDialogHeader>
                <AlertDialogMedia>
                  <PackageMinus aria-hidden="true" />
                </AlertDialogMedia>
                <AlertDialogTitle>
                  {t("actionsMenu.removeTitle", { name: plugin.name })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("actionsMenu.removeDescription", { name: plugin.name })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              {failure && (
                <Alert variant="destructive">
                  <AlertDescription>{failure}</AlertDescription>
                </Alert>
              )}
              <AlertDialogFooter>
                <AlertDialogCancel>
                  {t("common:actions.cancel")}
                </AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  disabled={remove.isPending}
                  onClick={() =>
                    remove.mutate(plugin.id, {
                      onSuccess: () => {
                        setOpen(false);
                        void navigate("/plugins");
                      },
                    })
                  }
                >
                  {remove.isPending && (
                    <Spinner data-icon="inline-start" aria-hidden="true" />
                  )}
                  {t("actionsMenu.remove")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function blockerSentence(t: PluginsT, resources: PluginInUseResource[]) {
  if (resources.length === 0) return t("actionsMenu.blockedEmpty");
  const parts = resources.map(
    (resource) => `${resource.count} ${resource.label}`,
  );
  const list =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  const total = resources.reduce((sum, resource) => sum + resource.count, 0);
  return t("actionsMenu.blockedSentence", { count: total, list });
}

/**
 * What to do about each blocker. The server says how each one resolves:
 * deleted through the plugin's page, switched off, or cleared by itself once
 * the others are gone.
 */
export function blockerInstruction(
  t: PluginsT,
  resources: PluginInUseResource[],
) {
  const labelsFor = (resolution: PluginInUseResource["resolution"]) =>
    resources
      .filter((resource) => resource.resolution === resolution)
      .map((resource) => resource.label)
      .join(" and ");
  const disable = labelsFor("disable");
  const labels = labelsFor("delete");
  if (!disable && !labels)
    return t("actionsMenu.blockedWait", { labels: labelsFor("wait") });
  if (disable && !labels) return t("actionsMenu.blockedDisable", { disable });
  if (!disable) return t("actionsMenu.blockedDelete", { labels });
  return t("actionsMenu.blockedDisableDelete", { disable, labels });
}
