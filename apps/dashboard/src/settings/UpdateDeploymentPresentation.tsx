import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { usePresentationChrome } from "../native-presentation/presentationContext";
import {
  deploymentDescription,
  useUpdateDeployment,
} from "./UpdateDeploymentDrawer";

/**
 * An update deployment's per-screen status in a native presentation, at
 * /__native/modal/update-deployment/:id. It loads the deployment by id and
 * polls it, as the web Sheet and Drawer do, and renders the same summary,
 * screen list, and cancel and retry actions. The fleet list comes from this
 * page's own Studio session.
 */
export function UpdateDeploymentPresentation() {
  const { id = "" } = useParams();
  const auth = useAuth();
  const screens = useQuery({ queryKey: ["screens"], queryFn: api.screens });
  const manageable = ["owner", "administrator"].includes(
    auth.status?.user?.role ?? "",
  );
  return (
    <UpdateDeploymentBody
      deploymentId={id}
      screens={screens.data?.items ?? []}
      manageable={manageable}
    />
  );
}

function UpdateDeploymentBody(
  props: Parameters<typeof useUpdateDeployment>[0],
) {
  const { t } = useTranslation(["settings", "common"]);
  const { deployment, body, footer } = useUpdateDeployment(props);
  usePresentationChrome({
    header: {
      title: deployment?.name ?? t("updates.deploymentTitle"),
      subtitle: deploymentDescription(deployment, t),
      navigation: "close",
      navigationLabel: t("common:actions.close"),
    },
    size: "full",
  });
  return (
    <div className="flex min-h-full flex-col">
      <div className="grid flex-1 gap-4 p-4">{body}</div>
      {footer && (
        <div className="sticky bottom-0 border-t border-border bg-background p-4">
          {footer}
        </div>
      )}
    </div>
  );
}
