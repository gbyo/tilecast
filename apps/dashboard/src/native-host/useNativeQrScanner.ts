import { useCallback, useEffect, useRef } from "react";
import { useNativeHost } from "./NativeHostProvider";
import type { QrScanResultPayload } from "./protocol";

/**
 * True when a native host negotiated the generic QR scanner. It answers
 * synchronously so the caller can choose between scanning and manual entry
 * while it still has the gesture.
 */
export function useNativeQrScannerAvailable() {
  const host = useNativeHost();
  return host.status === "ready" && host.capabilities.systemQrScanner;
}

/**
 * Returns a function that asks a native host to scan one QR code. It
 * resolves with the scan result, or null when there is no scanner, the host
 * refused, another scan from this component is already active, or the
 * owning component disappeared first. Only the result matching this scan's
 * request id resolves it; stale results are ignored.
 */
export function useNativeQrScanner() {
  const host = useNativeHost();
  const pending = useRef<{
    requestId: string;
    resolve: (result: QrScanResultPayload | null) => void;
  } | null>(null);

  useEffect(
    () => () => {
      pending.current?.resolve(null);
      pending.current = null;
    },
    [],
  );

  return useCallback(async (): Promise<QrScanResultPayload | null> => {
    if (host.status !== "ready" || !host.capabilities.systemQrScanner) {
      return null;
    }
    if (pending.current) return null;
    // getRandomValues, unlike randomUUID, also works on a plain-HTTP local
    // network installation. Lowercase hex fits the bridge request-id shape.
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const requestId = `qr-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const reply = await host.send("system/scan-qr", { requestId });
    if (reply?.ok !== true) return null;
    return new Promise<QrScanResultPayload | null>((resolve) => {
      pending.current = { requestId, resolve };
      const unsubscribe = host.subscribe("system/qr-scan-result", (payload) => {
        if (payload.requestId !== requestId) return false;
        pending.current = null;
        unsubscribe();
        resolve(payload);
        return true;
      });
    });
  }, [host]);
}
