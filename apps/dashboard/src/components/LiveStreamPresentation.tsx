import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import {
  useNativePresentation,
  usePresentationChrome,
} from "../native-presentation/presentationContext";
import { LiveStreamViewer } from "./LiveStreamDialog";
import { Button } from "./ui/button";

/**
 * A screen's live stream in a native presentation, at
 * /__native/modal/live-stream/:screenId. The native header shows its title;
 * the stream is the same viewer the browser dialog renders. Everything it
 * needs comes from the route and this page's own Studio session, never from
 * the bridge. Dismissing the sheet unmounts it, which ends the session.
 */
export function LiveStreamPresentation() {
  const { screenId = "" } = useParams();
  const auth = useAuth();
  const { t } = useTranslation(["alerts", "common", "screens"]);
  const presentation = useNativePresentation();
  const screen = useQuery({
    queryKey: ["screens", screenId],
    queryFn: () => api.screen(screenId),
    enabled: Boolean(screenId),
  });
  const screenName =
    screen.data?.name ?? t("screens:livePreview.unnamedScreen");
  usePresentationChrome({
    header: {
      title: t("liveStream.title", { name: screenName }),
      navigation: "close",
      navigationLabel: t("common:actions.close"),
    },
    size: "full",
  });
  const csrfToken = auth.status?.csrfToken;

  return (
    <div className="grid gap-4 p-4 text-sm">
      <p className="m-0 text-muted-foreground">{t("liveStream.description")}</p>
      {csrfToken && screenId ? (
        <LiveStreamViewer
          screenId={screenId}
          screenName={screenName}
          csrfToken={csrfToken}
        />
      ) : null}
      <Button onClick={() => presentation?.close()}>
        {t("liveStream.stopWatching")}
      </Button>
    </div>
  );
}
