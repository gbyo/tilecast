import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import {
  presentationPath,
  useOpenNativePresentation,
  useNativePresentationAvailable,
} from "../native-presentation/openNativePresentation";

/**
 * Opens pairing in a native presentation when one is available, and lets the
 * calling link navigate to the browser route otherwise. Native presentation
 * hosts know only the reserved root; Studio owns the pair-screen child.
 */
export function useNativePairScreen() {
  const { t } = useTranslation("screens");
  const navigate = useNavigate();
  const available = useNativePresentationAvailable();
  const openNativePresentation = useOpenNativePresentation();

  return async (
    event: React.MouseEvent,
    segments: string[],
    fallback: string,
  ) => {
    if (!available) return;
    event.preventDefault();
    const accepted = await openNativePresentation({
      path: presentationPath(...segments),
      title: t("pair.title"),
      size: "full",
      dismissible: true,
    });
    if (!accepted) navigate(fallback);
  };
}
