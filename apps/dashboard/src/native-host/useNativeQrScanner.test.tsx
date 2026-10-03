// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeHostProvider } from "./NativeHostProvider";
import {
  useNativeQrScanner,
  useNativeQrScannerAvailable,
} from "./useNativeQrScanner";

type Sent = { version: number; type: string; payload: Record<string, unknown> };

function installNativeHost({
  capabilities = {},
  replies = {},
}: {
  capabilities?: Record<string, boolean>;
  replies?: Record<string, () => unknown>;
} = {}) {
  const sent: Sent[] = [];
  const postMessage = vi.fn((message: Sent) => {
    sent.push(structuredClone(message));
    if (message.type === "config/get") {
      return Promise.resolve({
        version: 1,
        ok: true,
        payload: {
          protocolVersion: 1,
          context: "presentation",
          capabilities: { nativeNavigation: false, ...capabilities },
        },
      });
    }
    const reply = replies[message.type];
    return Promise.resolve(
      reply ? reply() : { version: 1, ok: true, payload: {} },
    );
  });
  window.webkit = { messageHandlers: { tilecastNative: { postMessage } } };
  return {
    sent,
    ofType: (type: string) =>
      sent.filter((message) => message.type === type).map((m) => m.payload),
    deliver(type: string, payload: Record<string, unknown>) {
      let accepted: boolean | undefined;
      act(() => {
        accepted = window.tilecastNativeReceiver?.({
          version: 1,
          type,
          payload,
        });
      });
      return accepted;
    },
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return <NativeHostProvider>{children}</NativeHostProvider>;
}

beforeEach(() => {
  vi.restoreAllMocks();
  // @ts-expect-error the harness replaces the native handler per test.
  delete window.webkit;
  // @ts-expect-error the harness replaces the native receiver per test.
  delete window.tilecastNativeReceiver;
});

afterEach(() => {
  cleanup();
});

describe("useNativeQrScannerAvailable", () => {
  it("is false in a browser", () => {
    const { result } = renderHook(() => useNativeQrScannerAvailable(), {
      wrapper,
    });
    expect(result.current).toBe(false);
  });

  it("follows the negotiated scanner capability", async () => {
    installNativeHost({ capabilities: { systemQrScanner: true } });
    const { result } = renderHook(() => useNativeQrScannerAvailable(), {
      wrapper,
    });
    await waitFor(() => expect(result.current).toBe(true));
  });
});

describe("useNativeQrScanner", () => {
  it("returns null in a browser", async () => {
    const { result } = renderHook(() => useNativeQrScanner(), { wrapper });
    await expect(result.current()).resolves.toBeNull();
  });

  it("resolves a scanned result and ignores stale ones", async () => {
    const host = installNativeHost({
      capabilities: { systemQrScanner: true },
    });
    const { result } = renderHook(() => useNativeQrScanner(), { wrapper });
    await waitFor(() =>
      expect(host.ofType("frontend/ready")).toHaveLength(1),
    );

    let scanned: unknown;
    await act(async () => {
      const pending = result.current().then((value) => {
        scanned = value;
      });
      await waitFor(() => expect(host.ofType("system/scan-qr")).toHaveLength(1));
      const requestId = host.ofType("system/scan-qr")[0]?.requestId as string;
      expect(requestId).toMatch(/^qr-[0-9a-f]{32}$/);
      // A stale result from an earlier scan must not resolve this one.
      host.deliver("system/qr-scan-result", {
        requestId: "qr-00000000000000000000000000000000",
        outcome: "scanned",
        value: "https://stale.example/screens/pair/AAAAAA",
      });
      host.deliver("system/qr-scan-result", {
        requestId,
        outcome: "scanned",
        value: "https://signage.example.org/screens/pair/K7Q2XD",
      });
      await pending;
    });

    expect(scanned).toMatchObject({ outcome: "scanned" });
  });

  it("resolves cancellation cleanly", async () => {
    const host = installNativeHost({
      capabilities: { systemQrScanner: true },
    });
    const { result } = renderHook(() => useNativeQrScanner(), { wrapper });
    await waitFor(() =>
      expect(host.ofType("frontend/ready")).toHaveLength(1),
    );

    let outcome: unknown;
    await act(async () => {
      const pending = result.current().then((value) => {
        outcome = value;
      });
      await waitFor(() => expect(host.ofType("system/scan-qr")).toHaveLength(1));
      const requestId = host.ofType("system/scan-qr")[0]?.requestId as string;
      host.deliver("system/qr-scan-result", {
        requestId,
        outcome: "cancelled",
      });
      await pending;
    });

    expect(outcome).toMatchObject({ outcome: "cancelled" });
  });

  it("returns null when the host refuses the scan", async () => {
    const host = installNativeHost({
      capabilities: { systemQrScanner: true },
      replies: {
        "system/scan-qr": () => ({
          version: 1,
          ok: false,
          error: { code: "unavailable" },
        }),
      },
    });
    const { result } = renderHook(() => useNativeQrScanner(), { wrapper });
    await waitFor(() =>
      expect(host.ofType("frontend/ready")).toHaveLength(1),
    );

    await expect(result.current()).resolves.toBeNull();
  });

  it("resolves null instead of hanging when unmounted mid-scan", async () => {
    const host = installNativeHost({
      capabilities: { systemQrScanner: true },
    });
    const { result, unmount } = renderHook(() => useNativeQrScanner(), {
      wrapper,
    });
    await waitFor(() =>
      expect(host.ofType("frontend/ready")).toHaveLength(1),
    );

    let settled = false;
    await act(async () => {
      const pending = result.current().then(() => {
        settled = true;
      });
      await waitFor(() => expect(host.ofType("system/scan-qr")).toHaveLength(1));
      unmount();
      await pending;
    });

    expect(settled).toBe(true);
  });
});
