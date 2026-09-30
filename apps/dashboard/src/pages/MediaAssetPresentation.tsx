import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Skeleton } from "../components/ui/skeleton";
import { apiErrorMessage } from "../i18n";
import {
  useNativePresentation,
  usePresentationChrome,
} from "../native-presentation/presentationContext";
import { canManageContent, useMediaAssetDetails } from "./ContentPage";

/**
 * A media asset's details in a native presentation, at
 * /__native/modal/asset/:id. It loads the asset by id with this page's own
 * Studio session and renders the same fields, actions, and archive
 * confirmation as the web Sheet and Drawer. The native header carries the
 * name and Close. When the sheet ends, the host tells the main page to
 * refetch, so a saved change shows in the library.
 */
export function MediaAssetPresentation() {
  const { id = "" } = useParams();
  const { t } = useTranslation(["content", "common"]);
  const auth = useAuth();
  const queryClient = useQueryClient();
  const presentation = useNativePresentation();
  const asset = useQuery({
    queryKey: ["assets", id],
    queryFn: () => api.asset(id),
    enabled: Boolean(id),
  });
  usePresentationChrome({
    header: asset.data
      ? {
          title: asset.data.name,
          subtitle: t("media.details.eyebrow"),
          navigation: "close",
          navigationLabel: t("common:actions.close"),
        }
      : undefined,
    size: "compact",
  });

  if (asset.isError) {
    return (
      <div className="p-4">
        <Alert variant="destructive">
          <AlertDescription>{apiErrorMessage(asset.error)}</AlertDescription>
        </Alert>
      </div>
    );
  }
  if (!asset.data) {
    return (
      <div className="space-y-2 p-4">
        <Skeleton className="h-4 w-48" />
        <p className="text-sm text-muted-foreground">
          {t("media.library.loading")}
        </p>
      </div>
    );
  }
  return (
    <MediaAssetPresentationBody
      key={asset.data.id}
      asset={asset.data}
      canManage={canManageContent(auth.status?.user)}
      csrf={auth.status?.csrfToken ?? ""}
      onChanged={(saved) => queryClient.setQueryData(["assets", id], saved)}
      onRequestClose={() => presentation?.close()}
    />
  );
}

function MediaAssetPresentationBody(
  props: Parameters<typeof useMediaAssetDetails>[0],
) {
  const { details, actions, archiveConfirmation } = useMediaAssetDetails(props);
  return (
    <div className="flex min-h-full flex-col">
      <div className="grid flex-1 gap-4 p-4">{details}</div>
      {actions && (
        <div className="sticky bottom-0 grid gap-2 border-t border-border bg-background p-4">
          {actions}
        </div>
      )}
      {archiveConfirmation}
    </div>
  );
}
