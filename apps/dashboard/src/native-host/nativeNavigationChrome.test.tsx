// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeHostProvider } from "./NativeHostProvider";
import {
  useNativeNavigationChrome,
  type TrailItem,
} from "./useNativeNavigationChrome";

type Sent = { type: string; payload: Record<string, unknown> };

function installNativeHost({
  chromeReply = "ok",
}: { chromeReply?: "ok" | "unknown_type" } = {}) {
  const sent: Sent[] = [];
  const postMessage = vi.fn((message: Sent) => {
    sent.push(structuredClone(message));
    if (message.type === "config/get") {
      return Promise.resolve({
        version: 1,
        ok: true,
        payload: {
          protocolVersion: 1,
          context: "main",
          capabilities: { nativeNavigation: true },
        },
      });
    }
    if (message.type === "navigation/chrome" && chromeReply !== "ok") {
      return Promise.resolve({
        version: 1,
        ok: false,
        error: { code: chromeReply },
      });
    }
    return Promise.resolve({ version: 1, ok: true, payload: {} });
  });
  window.webkit = { messageHandlers: { tilecastNative: { postMessage } } };
  return {
    ofType: (type: string) =>
      sent.filter((message) => message.type === type).map((m) => m.payload),
    deliver(type: string) {
      let accepted: boolean | undefined;
      act(() => {
        accepted = window.tilecastNativeReceiver?.({
          version: 1,
          type,
          payload: {},
        });
      });
      return accepted;
    },
  };
}

function Page({ trail }: { trail: TrailItem[] }) {
  const native = useNativeNavigationChrome(trail, true);
  const location = useLocation();
  return (
    <>
      <p data-testid="breadcrumbs">{native ? "hidden" : "shown"}</p>
      <p data-testid="location">{location.pathname}</p>
    </>
  );
}

const drillIn: TrailItem[] = [
  { label: "Fleet", to: "/screens" },
  { label: "Lobby north", to: "/screens/screen-1" },
];

function renderPage(trail: TrailItem[]) {
  return render(
    <NativeHostProvider>
      <MemoryRouter initialEntries={["/screens/screen-1"]}>
        <Page trail={trail} />
      </MemoryRouter>
    </NativeHostProvider>,
  );
}

afterEach(() => {
  cleanup();
  delete window.webkit;
  delete window.tilecastNativeReceiver;
  vi.restoreAllMocks();
});

describe("native navigation chrome", () => {
  it("describes a drill-in page and hides Studio's breadcrumbs once accepted", async () => {
    const host = installNativeHost();
    renderPage(drillIn);
    await waitFor(() =>
      expect(host.ofType("navigation/chrome")).toEqual([
        { title: "Lobby north", back: { label: "Fleet" } },
      ]),
    );
    await waitFor(() =>
      expect(screen.getByTestId("breadcrumbs")).toHaveTextContent("hidden"),
    );
  });

  it("keeps Studio's breadcrumbs when the host refuses the message", async () => {
    const host = installNativeHost({ chromeReply: "unknown_type" });
    renderPage(drillIn);
    await waitFor(() =>
      expect(host.ofType("navigation/chrome")).toHaveLength(1),
    );
    expect(screen.getByTestId("breadcrumbs")).toHaveTextContent("shown");
  });

  it("sends no back for a top-level page, and keeps its breadcrumb", async () => {
    const host = installNativeHost();
    renderPage([{ label: "Fleet", to: "/screens" }]);
    await waitFor(() =>
      expect(host.ofType("navigation/chrome")).toEqual([{ title: "Fleet" }]),
    );
    expect(screen.getByTestId("breadcrumbs")).toHaveTextContent("shown");
  });

  it("navigates to the previous item on back, and sends no path", async () => {
    const host = installNativeHost();
    renderPage(drillIn);
    await waitFor(() =>
      expect(host.ofType("navigation/chrome")).toHaveLength(1),
    );
    expect(host.deliver("navigation/back")).toBe(true);
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(/^\/screens$/),
    );
  });

  it("does not handle back on a page with nowhere to go", async () => {
    const host = installNativeHost();
    renderPage([{ label: "Fleet", to: "/screens" }]);
    await waitFor(() =>
      expect(host.ofType("navigation/chrome")).toHaveLength(1),
    );
    expect(host.deliver("navigation/back")).toBe(false);
  });

  it("sends nothing in a browser", () => {
    renderPage(drillIn);
    expect(screen.getByTestId("breadcrumbs")).toHaveTextContent("shown");
  });
});
