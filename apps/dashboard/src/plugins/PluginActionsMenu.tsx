import { useState } from "react";
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
import {
  inUseResources,
  usePluginCatalog,
  usePluginLifecycle,
} from "./pluginCatalog";
import { canManage } from "./shared";

/**
 * The overflow menu on an installed plugin's page. Remove is deliberately a
 * secondary action, and it never deletes plugin data: while the plugin still
 * owns resources the server refuses, and this explains what to delete first.
 */
export function PluginActionsMenu({ pluginId }: { pluginId: string }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const catalog = usePluginCatalog();
  const { remove } = usePluginLifecycle(auth.status?.csrfToken ?? "");
  const [open, setOpen] = useState(false);
  const plugin = catalog.data?.items.find((item) => item.id === pluginId);
  if (!plugin?.installed || !canManage(auth.status?.user?.role)) return null;

  const blockers = inUseResources(remove.error);
  const failure = remove.error && !blockers ? remove.error.message : undefined;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" size="icon" />}
          aria-label={`${plugin.name} plugin actions`}
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
            <PackageMinus aria-hidden="true" /> Remove plugin
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          {blockers ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {plugin.name} can&apos;t be removed
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {blockerSentence(blockers)} {blockerInstruction(blockers)}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  View {blockers[0]?.label ?? plugin.instanceNounPlural}
                </AlertDialogCancel>
              </AlertDialogFooter>
            </>
          ) : (
            <>
              <AlertDialogHeader>
                <AlertDialogMedia>
                  <PackageMinus aria-hidden="true" />
                </AlertDialogMedia>
                <AlertDialogTitle>Remove {plugin.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  {plugin.name} leaves this installation&apos;s Plugins list and
                  stops affecting screens. You can add it again at any time.
                </AlertDialogDescription>
              </AlertDialogHeader>
              {failure && (
                <Alert variant="destructive">
                  <AlertDescription>{failure}</AlertDescription>
                </Alert>
              )}
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
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
                  Remove plugin
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function blockerSentence(resources: PluginInUseResource[]) {
  if (resources.length === 0) return "This plugin is still in use.";
  const parts = resources.map(
    (resource) => `${resource.count} ${resource.label}`,
  );
  const list =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  const total = resources.reduce((sum, resource) => sum + resource.count, 0);
  return `${list} still ${total === 1 ? "uses" : "use"} this plugin.`;
}

/**
 * What to do about each blocker. Monitoring is switched off rather than
 * deleted, and live alerts clear themselves once their rules are gone.
 */
export function blockerInstruction(resources: PluginInUseResource[]) {
  const steps: string[] = [];
  if (resources.some((resource) => resource.kind === "alert_monitor"))
    steps.push("turn monitoring off");
  const deletable = resources.filter(
    (resource) =>
      resource.kind !== "alert_monitor" && resource.kind !== "alert_activation",
  );
  if (deletable.length > 0)
    steps.push(
      `delete the remaining ${deletable.map((resource) => resource.label).join(" and ")}`,
    );
  if (steps.length === 0)
    return "Wait for active alerts to clear, then remove the plugin.";
  const joined = steps.join(" and ");
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)} on this page, then remove the plugin.`;
}
