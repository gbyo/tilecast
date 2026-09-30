import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { useNativeHost } from "@/native-host/NativeHostProvider";
import { isStudioPath } from "@/native-host/protocol";

/**
 * In the main Studio page, carries out navigation that a native
 * presentation asked for. The host dismissed the presentation and relays
 * the path; React Router navigates, so unsaved-change blockers, loaders,
 * and redirects apply, and native selection follows the next
 * navigation/state. It also refetches active queries when a presentation
 * ends: the presentation is a separate document with its own query cache, so
 * whatever it saved is stale here. Inert in a browser and in a presentation
 * page.
 */
export function NativePresentationNavigation() {
  const host = useNativeHost();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
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

  useEffect(() => {
    if (!enabled) return;
    return host.subscribe("presentation/ended", () => {
      void queryClient.invalidateQueries({ type: "active" });
      return true;
    });
  }, [enabled, host, queryClient]);

  return null;
}
