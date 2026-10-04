import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  matchRoutes,
  Navigate,
  Outlet,
  useNavigate,
  type RouteObject,
} from "react-router";
import { accountQueries } from "@/data/account";
import { useAuth } from "@/auth/AuthProvider";
import { RouteErrorBoundary } from "@/components/RouteErrorBoundary";
import { ThemeProvider } from "@/components/studio/ThemeProvider";
import { useNativeHost } from "@/native-host/NativeHostProvider";
import {
  isStudioPath,
  PRESENTATION_ROOT,
  type PresentationUpdatePayload,
} from "@/native-host/protocol";
import { studioTheme } from "@/pages/Dashboard";
import {
  NativePresentationContext,
  type NativePresentation,
} from "./presentationContext";

/**
 * The shell-less Studio frontend that a native host keeps in its
 * presentation page. It is the element of the reserved /__native/modal
 * route, outside DashboardShell: no sidebar, topbar, breadcrumbs, or
 * navigation catalog, but the normal providers and the same signed-in
 * session.
 *
 * The host boots it once at the empty root. For each presentation it sends
 * presentation/show, and this component routes to the child with React
 * Router, keyed by the presentation id so that nothing from the previous
 * presentation survives. presentation/dismissed returns to the empty root,
 * which unmounts the child and ends its transient work.
 *
 * In a browser, or in any page that is not a native presentation page,
 * the route redirects to Studio's start page.
 */
export function NativePresentationHost({ routes }: { routes: RouteObject[] }) {
  const host = useNativeHost();
  const auth = useAuth();
  const navigate = useNavigate();
  const [active, setActive] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  const actionHandlers = useRef(new Set<(actionId: string) => void>());
  // A dialog inside the presentation grew the sheet. It stays full until
  // the presentation ends: shrinking a sheet in use is never clearly safe.
  const grown = useRef(false);
  const tree = useMemo(
    () => [{ path: PRESENTATION_ROOT, children: routes }],
    [routes],
  );

  const isPresentationPage =
    host.status === "ready" &&
    host.context === "presentation" &&
    host.capabilities.nativePresentations;
  const signedIn = Boolean(auth.status?.authenticated);
  const enabled = isPresentationPage && signedIn;

  const preferences = useQuery({
    ...accountQueries.preferences(),
    enabled,
  });

  useEffect(() => {
    if (!enabled) return;
    const unsubscribers = [
      host.subscribe("presentation/show", ({ presentationId, path }) => {
        // Only Studio's own presentation routes; a host never picks one.
        if (!matchRoutes(tree, path.split(/[?#]/, 1)[0] ?? "")) return false;
        activeRef.current = presentationId;
        grown.current = false;
        setActive(presentationId);
        void navigate(path, { replace: true });
        return true;
      }),
      host.subscribe("presentation/action", ({ presentationId, actionId }) => {
        if (presentationId !== activeRef.current) return false;
        for (const handler of actionHandlers.current) handler(actionId);
        return true;
      }),
      host.subscribe("presentation/dismissed", ({ presentationId }) => {
        if (presentationId !== activeRef.current) return false;
        activeRef.current = null;
        setActive(null);
        void navigate(PRESENTATION_ROOT, { replace: true });
        return true;
      }),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [enabled, host, navigate, tree]);

  // After the subscriptions above: the host may send presentation/show as
  // soon as it hears this.
  useEffect(() => {
    if (enabled) void host.send("presentation/ready", {});
  }, [enabled, host]);

  const presentation = useMemo<NativePresentation | null>(() => {
    if (!active) return null;
    const update = (
      payload: Omit<PresentationUpdatePayload, "presentationId">,
    ) =>
      void host.send("presentation/update", {
        presentationId: active,
        ...payload,
      });
    return {
      presentationId: active,
      update: (chrome) =>
        update(
          grown.current && chrome.size ? { ...chrome, size: "full" } : chrome,
        ),
      close: () =>
        void host.send("presentation/close", { presentationId: active }),
      navigate: (path) => {
        if (isStudioPath(path)) {
          void host.send("presentation/navigate", {
            presentationId: active,
            path,
          });
        }
      },
      onAction: (handler) => {
        actionHandlers.current.add(handler);
        return () => {
          actionHandlers.current.delete(handler);
        };
      },
      requestFullSize: () => {
        if (grown.current) return;
        grown.current = true;
        update({ size: "full" });
      },
    };
  }, [active, host]);

  if (host.status === "negotiating" || auth.isLoading) return null;
  if (!isPresentationPage) return <Navigate to="/" replace />;
  // The host reports a missing session itself when this never gets ready.
  if (!signedIn) return null;

  return (
    <ThemeProvider {...studioTheme(preferences.data?.values)}>
      <NativePresentationContext.Provider value={presentation}>
        <main className="min-h-svh bg-background text-foreground">
          {presentation ? (
            <RouteErrorBoundary key={presentation.presentationId}>
              <Outlet />
            </RouteErrorBoundary>
          ) : null}
        </main>
      </NativePresentationContext.Provider>
    </ThemeProvider>
  );
}
