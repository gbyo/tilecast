import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { canManageScreens } from "../data/screens";
import {
  useNativePresentation,
  usePresentationChrome,
} from "../native-presentation/presentationContext";
import { PairScreenFlow } from "./PairScreenFlow";

/**
 * Pair Screen in a native presentation, at /__native/modal/pair-screen and
 * /__native/modal/pair-screen/:requestId. It renders the same React pairing
 * flow as the browser dialog; the native sheet owns only the chrome, and
 * the native scanner returns scanned text to the flow through the bridge.
 * Opening a paired screen dismisses the sheet and navigates main Studio.
 */
export function PairScreenPresentation() {
  const { requestId } = useParams();
  const { t } = useTranslation(["screens", "common"]);
  const auth = useAuth();
  const presentation = useNativePresentation();
  usePresentationChrome({
    header: {
      title: t("pair.title"),
      navigation: "close",
      navigationLabel: t("common:actions.close"),
    },
    size: "full",
    dismissible: true,
  });

  return (
    <div className="mx-auto w-full max-w-2xl p-4">
      <PairScreenFlow
        requestId={requestId}
        canManage={canManageScreens(auth.status?.user)}
        onClose={() => presentation?.close()}
        onOpenScreen={(screenId) =>
          presentation?.navigate(`/screens/${screenId}`)
        }
      />
    </div>
  );
}
