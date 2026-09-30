import { useCallback, useEffect, useRef } from "react";
import { useNativeHost } from "./NativeHostProvider";
import type { AlertPresentPayload } from "./protocol";

export type NativeAlertRequest = Omit<AlertPresentPayload, "alertId">;

/** What present resolves with when the alert's owner went away unanswered. */
export const NATIVE_ALERT_ABANDONED = "";

/** A fresh opaque alert id. getRandomValues also works on plain HTTP. */
function newAlertId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `a-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Shows a native alert when the host offers one. present resolves with the
 * id of the button the user chose, or with null when there is no native
 * alert to show: in a browser, in an older app, or when the host refused,
 * for example because another alert is showing. The caller then shows its
 * own dialog, which stays the permanent browser path:
 *
 *   const chosen = await present(request);
 *   if (chosen === null) return showWebDialog();
 *
 * If the component unmounts first, the alert is withdrawn and present
 * resolves with NATIVE_ALERT_ABANDONED.
 */
export function useNativeAlert() {
  const host = useNativeHost();
  const hostRef = useRef(host);
  hostRef.current = host;
  const pending = useRef(new Map<string, (actionId: string) => void>());
  const available = host.status === "ready" && host.capabilities.nativeAlerts;

  useEffect(() => {
    if (!available) return;
    return host.subscribe("alert/action", ({ alertId, actionId }) => {
      const resolve = pending.current.get(alertId);
      if (!resolve) return false;
      pending.current.delete(alertId);
      resolve(actionId);
      return true;
    });
  }, [available, host]);

  useEffect(() => {
    const alerts = pending.current;
    return () => {
      for (const [alertId, resolve] of alerts) {
        void hostRef.current.send("alert/cancel", { alertId });
        resolve(NATIVE_ALERT_ABANDONED);
      }
      alerts.clear();
    };
  }, []);

  const present = useCallback(
    async (request: NativeAlertRequest): Promise<string | null> => {
      const current = hostRef.current;
      if (current.status !== "ready" || !current.capabilities.nativeAlerts) {
        return null;
      }
      const alertId = newAlertId();
      const chosen = new Promise<string>((resolve) => {
        pending.current.set(alertId, resolve);
      });
      const reply = await current.send("alert/present", {
        alertId,
        ...request,
      });
      if (reply?.ok !== true) {
        pending.current.delete(alertId);
        return null;
      }
      return chosen;
    },
    [],
  );

  return present;
}
