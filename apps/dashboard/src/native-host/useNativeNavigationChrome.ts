import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useNativeHost } from "./NativeHostProvider";
import type { NavigationChromePayload } from "./protocol";

export type TrailItem = { label: string; to: string };

/**
 * Describes the current page to a native host as chrome, from the same
 * breadcrumb trail Studio's topbar shows: the last item is the title, and
 * the item before it is where back leads. Nothing is added to any page.
 * The host answers by showing a native navigation bar, and Studio then
 * leaves its own breadcrumbs out, so the trail is not drawn twice.
 *
 * The host sends navigation/back, and React Router navigates to the parent
 * item, so unsaved-change blockers apply and the host never learns a path.
 * A host that does not know the message refuses it, and Studio keeps its
 * breadcrumbs, as in a browser.
 *
 * Returns true when the host shows the trail natively.
 */
export function useNativeNavigationChrome(
  trail: readonly TrailItem[],
  enabled: boolean,
) {
  const host = useNativeHost();
  const navigate = useNavigate();
  const [accepted, setAccepted] = useState(false);
  const active = enabled && host.status === "ready";

  const current = trail.at(-1);
  const parent = trail.length > 1 ? trail.at(-2) : undefined;
  const chrome: NavigationChromePayload = {
    ...(current ? { title: current.label } : {}),
    ...(parent ? { back: { label: parent.label } } : {}),
  };
  const json = JSON.stringify(chrome);
  const parentTo = parent?.to;
  const latest = useRef({ parentTo, navigate });
  latest.current = { parentTo, navigate };

  useEffect(() => {
    if (!active) return;
    let stale = false;
    void host
      .send("navigation/chrome", JSON.parse(json) as NavigationChromePayload)
      .then((reply) => {
        if (!stale) setAccepted(reply?.ok === true);
      });
    return () => {
      stale = true;
    };
  }, [active, host, json]);

  useEffect(() => {
    if (!active) return;
    return host.subscribe("navigation/back", () => {
      const { parentTo, navigate } = latest.current;
      if (!parentTo) return false;
      void navigate(parentTo);
      return true;
    });
  }, [active, host]);

  return active && accepted && parent !== undefined;
}
