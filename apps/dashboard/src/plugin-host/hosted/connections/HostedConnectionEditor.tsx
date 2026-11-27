import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { apiErrorMessage } from "@/i18n";
import { PluginPage } from "../../PluginPage";
import { useStudioSession } from "../../session";
import {
  connectionKey,
  connectionsClient,
  connectionsKey,
  type PluginConnection,
} from "./api";
import { ConnectionConsents } from "./ConnectionConsents";
import {
  ConnectionGeneralForm,
  generalWrite,
  type GeneralValues,
} from "./ConnectionGeneralForm";
import { ConnectionReferences } from "./ConnectionReferences";
import { ConnectionStatusBadge } from "./ConnectionStatusBadge";
import {
  connectionsRoute,
  type HostedConnectionsProps,
} from "./HostedConnectionsPage";

/**
 * The generated page of one connection: its name and origin, its network
 * permissions, and what uses it. A new connection shows the general form
 * only; permissions follow once the record exists.
 */
export function HostedConnectionEditor({
  pluginId,
  manifest,
}: HostedConnectionsProps) {
  const { connectionId } = useParams();
  const creating = connectionId === undefined;
  const { t } = useTranslation(["plugins", "common"]);
  const session = useStudioSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const client = connectionsClient(pluginId);
  const loaded = useQuery({
    queryKey: connectionKey(pluginId, connectionId ?? ""),
    queryFn: () => client.get(connectionId!),
    enabled: !creating,
  });
  const connection = loaded.data;
  const refresh = (next: PluginConnection) => {
    queryClient.setQueryData(connectionKey(pluginId, next.id), next);
    void queryClient.invalidateQueries({ queryKey: connectionsKey(pluginId) });
  };
  const save = useMutation({
    mutationFn: (values: GeneralValues) => {
      const declaration = (manifest.connections ?? []).find(
        (item) => item.id === values.definition,
      );
      return creating
        ? client.create(generalWrite(values, declaration), session.csrfToken)
        : client.update(
            connectionId,
            generalWrite(values, declaration, connection!.revision),
            session.csrfToken,
          );
    },
    onSuccess: (next) => {
      refresh(next);
      toast.add({
        title: t(
          creating
            ? "hosted.connections.createdToast"
            : "hosted.connections.savedToast",
        ),
        type: "success",
      });
      if (creating)
        void navigate(`${connectionsRoute(manifest)}/${next.id}`, {
          replace: true,
        });
    },
  });
  const remove = useMutation({
    mutationFn: () => client.remove(connectionId!, session.csrfToken),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: connectionsKey(pluginId),
      });
      toast.add({
        title: t("hosted.connections.deletedToast"),
        type: "success",
      });
      void navigate(connectionsRoute(manifest));
    },
  });
  const readOnly = !session.canManage;
  const title = creating
    ? t("hosted.connections.createTitle")
    : (connection?.name ?? t("hosted.connections.manageTitle"));
  return (
    <>
      {dialog}
      <PluginPage pluginId={pluginId} title={title}>
        {loaded.isError && (
          <Alert variant="destructive">
            <AlertDescription>{apiErrorMessage(loaded.error)}</AlertDescription>
          </Alert>
        )}
        {connection && (
          <div className="flex flex-wrap items-center gap-2">
            <ConnectionStatusBadge connection={connection} />
            {connection.notices.map((notice) => (
              <span key={notice} className="text-sm text-muted-foreground">
                {t(`hosted.connections.notices.${notice}`, {
                  defaultValue: notice,
                })}
              </span>
            ))}
          </div>
        )}
        {save.isError && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{apiErrorMessage(save.error)}</AlertDescription>
          </Alert>
        )}
        {(creating || connection) && (
          <ConnectionGeneralForm
            declarations={manifest.connections ?? []}
            connection={connection}
            readOnly={readOnly}
            pending={save.isPending}
            onSubmit={(values) => save.mutate(values)}
          />
        )}
        {connection && (
          <>
            <Separator />
            <ConnectionConsents pluginId={pluginId} connection={connection} />
            <Separator />
            <ConnectionReferences connection={connection} />
            {remove.isError && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>
                  {apiErrorMessage(remove.error)}
                </AlertDescription>
              </Alert>
            )}
            {!readOnly && (
              <div>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={
                    remove.isPending || connection.references.length > 0
                  }
                  onClick={() =>
                    void confirm({
                      title: t("hosted.connections.deleteTitle", {
                        name: connection.name,
                      }),
                      body: t("hosted.connections.deleteBody"),
                      action: t("common:actions.delete"),
                      destructive: true,
                    }).then((ok) => {
                      if (ok) remove.mutate();
                    })
                  }
                >
                  {t("hosted.connections.delete")}
                </Button>
              </div>
            )}
          </>
        )}
      </PluginPage>
    </>
  );
}
