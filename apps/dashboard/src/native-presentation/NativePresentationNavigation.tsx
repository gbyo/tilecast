import { useEffect } from "react";
import { useNavigate } from "react-router";
import { useNativeHost } from "@/native-host/NativeHostProvider";
import { isStudioPath } from "@/native-host/protocol";

/**
 * In the main Studio page, carries out navigation that a native
 * presentation asked for. The host dismissed the presentation and relays
 * the path; React Router navigates, so unsaved-change blockers, loaders,
 * and redirects apply, and native selection follows the next
 * navigation/state. Inert in a browser and in a presentation page.
 */
export function NativePresentationNavigation() {
  const host = useNativeHost();
  const navigate = useNavigate();
  const enabled =
    host.status === "ready" &&
    host.context === "main" &&
    host.capabilities.nativePresentations;

  useEffect(() => {
    if (!enabled) return;
    return host.subscribe("navigation/open-path", ({ path }) => {
      if (!isStudioPath(path)) return false;
      void navigate(path);
      return true;
    });
  }, [enabled, host, navigate]);

  return null;
}
