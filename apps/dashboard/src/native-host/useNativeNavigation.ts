import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  resolveActiveDestination,
  type ResolvedStudioNavigation,
} from "@/navigation/studioNavigation";
import { useNativeHost } from "./NativeHostProvider";
import type {
  NavigationCatalogPayload,
  NavigationStatePayload,
} from "./protocol";

/**
 * browser: Studio shows its own sidebar.
 * pending: a native host may take over navigation; the sidebar stays hidden
 *   briefly so it does not flash in the app.
 * native: the host accepted the catalog and shows native navigation.
 */
export type NativeNavigationMode = "browser" | "pending" | "native";

/** The catalog snapshot a native host receives. Labels are localized. */
export function buildNavigationCatalog(
  navigation: ResolvedStudioNavigation,
): NavigationCatalogPayload {
  return {
    groups: navigation.groups.map((group) => ({
      id: group.id,
      ...(group.title ? { title: group.title } : {}),
      items: group.items.map((item) => ({
        id: item.id,
        title: item.title,
        icon: item.icon,
        mobilePlacement: item.mobilePlacement,
      })),
    })),
  };
}

/**
 * The path is for the host's diagnostics only, so it carries no query
 * string: a query can hold values, such as OAuth approval parameters, that
 * the host has no reason to see.
 */
export function navigationState(
  navigation: ResolvedStudioNavigation,
  location: { pathname: string },
): NavigationStatePayload {
  return {
    activeDestinationId:
      resolveActiveDestination(location.pathname, navigation.destinations)
        ?.id ?? null,
    path: location.pathname,
  };
}

/**
 * Publishes Studio's navigation model to a native host that negotiated the
 * nativeNavigation capability, and carries out its navigation requests with
 * React Router. The host sends only opaque destination ids; Studio resolves
 * them against the same model the browser sidebar renders, and React Router
 * (with any unsaved-changes blocker) decides whether navigation happens. The
 * host learns the outcome from the next navigation/state message.
 */
export function useNativeNavigation(
  navigation: ResolvedStudioNavigation,
): NativeNavigationMode {
  const host = useNativeHost();
  const location = useLocation();
  const navigate = useNavigate();
  const [catalogReply, setCatalogReply] = useState<
    "waiting" | "accepted" | "refused"
  >("waiting");
  // Bumped to resend the catalog or the state unchanged.
  const [catalogNonce, setCatalogNonce] = useState(0);
  const [stateNonce, setStateNonce] = useState(0);

  const enabled =
    host.status === "ready" &&
    host.capabilities.nativeNavigation &&
    catalogReply !== "refused";
  const catalogJson = useMemo(
    () => JSON.stringify(buildNavigationCatalog(navigation)),
    [navigation],
  );
  const stateJson = JSON.stringify(navigationState(navigation, location));

  const latest = useRef({ navigation, location, navigate });
  latest.current = { navigation, location, navigate };

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void host
      .send(
        "navigation/catalog",
        JSON.parse(catalogJson) as NavigationCatalogPayload,
      )
      .then((reply) => {
        if (current) setCatalogReply(reply?.ok ? "accepted" : "refused");
      });
    return () => {
      current = false;
    };
  }, [enabled, host, catalogJson, catalogNonce]);

  // Leaving the authenticated chrome (signing out, for example) withdraws
  // native navigation with an empty catalog.
  useEffect(() => {
    if (!enabled) return;
    return () => {
      void host.send("navigation/catalog", { groups: [] });
    };
  }, [enabled, host]);

  useEffect(() => {
    if (!enabled) return;
    void host.send(
      "navigation/state",
      JSON.parse(stateJson) as NavigationStatePayload,
    );
  }, [enabled, host, stateJson, stateNonce]);

  useEffect(() => {
    if (!enabled) return;
    return host.subscribe("navigation/request", ({ destinationId }) => {
      const { navigation, location, navigate } = latest.current;
      const destination = navigation.destinations.find(
        (candidate) => candidate.id === destinationId,
      );
      if (!destination) {
        // The host's catalog is stale: send the current model again.
        setCatalogNonce((nonce) => nonce + 1);
        setStateNonce((nonce) => nonce + 1);
        return false;
      }
      const acknowledge = () =>
        // In a transition, so the acknowledgement renders together with the
        // router's own location update rather than before it.
        startTransition(() => setStateNonce((nonce) => nonce + 1));
      if (`${location.pathname}${location.search}` === destination.to) {
        acknowledge();
      } else {
        void Promise.resolve(navigate(destination.to)).finally(acknowledge);
      }
      return true;
    });
  }, [enabled, host]);

  if (host.status === "unavailable") return "browser";
  if (host.status === "negotiating") return "pending";
  if (!enabled) return "browser";
  return catalogReply === "accepted" ? "native" : "pending";
}
