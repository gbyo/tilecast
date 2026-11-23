import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { apiErrorMessage } from "@/i18n";
import { useStudioSession } from "../../session";
import {
  connectionsClient,
  connectionsKey,
  type PluginConnection,
} from "./api";

/**
 * Deletes a connection record. A record in use, or an OAuth connection that
 * is still connected, cannot be deleted: disconnecting first lets the
 * provider revoke Tilecast's access.
 */
export function ConnectionDelete({
  pluginId,
  connection,
  afterDelete,
}: {
  pluginId: string;
  connection: PluginConnection;
  afterDelete: string;
}) {
  const { t } = useTranslation(["plugins", "common"]);
  const session = useStudioSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const remove = useMutation({
    mutationFn: () =>
      connectionsClient(pluginId).remove(connection.id, session.csrfToken),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: connectionsKey(pluginId),
      });
      toast.add({
        title: t("hosted.connections.deletedToast"),
        type: "success",
      });
      void navigate(afterDelete);
    },
  });
  if (!session.canManage) return null;
  const connected = connection.oauth?.status === "connected";
  const submit = async () => {
    const ok = await confirm({
      title: t("hosted.connections.deleteTitle", { name: connection.name }),
      body: t("hosted.connections.deleteBody"),
      action: t("common:actions.delete"),
      destructive: true,
    });
    if (ok) remove.mutate();
  };
  return (
    <>
      {dialog}
      {remove.isError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{apiErrorMessage(remove.error)}</AlertDescription>
        </Alert>
      )}
      <div>
        <Button
          type="button"
          variant="destructive"
          disabled={
            remove.isPending || connection.references.length > 0 || connected
          }
          onClick={() => void submit()}
        >
          {t("hosted.connections.delete")}
        </Button>
        {connected && (
          <p className="mt-2 text-sm text-muted-foreground">
            {t("hosted.connections.oauth.disconnectBeforeDelete")}
          </p>
        )}
      </div>
    </>
  );
}
