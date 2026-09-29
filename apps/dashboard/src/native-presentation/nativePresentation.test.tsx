// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createMemoryRouter,
  Outlet,
  RouterProvider,
  useBlocker,
  useLocation,
  useParams,
  type RouteObject,
} from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LivePreviewPanel } from "@/components/LivePreviewPanel";
import { LiveStreamPresentation } from "@/components/LiveStreamPresentation";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { NativeHostProvider } from "@/native-host/NativeHostProvider";
import { NativePresentationHost } from "./NativePresentationHost";
import { NativePresentationNavigation } from "./NativePresentationNavigation";
import {
  useNativePresentation,
  usePresentationChrome,
} from "./presentationContext";

const mocks = vi.hoisted(() => ({
  api: {
    screen: vi.fn(),
    screenPreview: vi.fn(),
    renewScreenPreview: vi.fn(),
    screenPreviewImageUrl: () => "/preview.jpg",
    preferences: vi.fn(),
    startLiveStream: vi.fn(),
    renewLiveStream: vi.fn(),
    screenLiveStreamUrl: (screenId: string, sessionId: string) =>
      `/api/v1/screens/${screenId}/live-stream/${sessionId}/mjpeg`,
  },
}));

vi.mock("@/api/client", () => ({ api: mocks.api }));

vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({
    isLoading: false,
    status: { authenticated: true, csrfToken: "csrf" },
  }),
}));

// The browser dialog itself is covered by LiveStreamDialog.test.tsx; here
// only whether Studio opened it matters. The viewer stays real.
vi.mock("@/components/LiveStreamDialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/LiveStreamDialog")>()),
  LiveStreamDialog: ({ open }: { open: boolean }) =>
    open ? <p>Web live stream dialog</p> : null,
}));

type Sent = { version: number; type: string; payload: Record<string, unknown> };

/**
 * The iOS app's handler for one page: main or presentation. It answers like
 * the app and records what Studio sends.
 */
function installNativeHost({
  context = "main",
  nativePresentations = true,
  openReply = "ok",
}: {
  context?: "main" | "presentation";
  nativePresentations?: boolean;
  openReply?: "ok" | "unavailable";
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
          context,
          capabilities: {
            nativeNavigation: context === "main",
            authLifecycle: false,
            nativePresentations,
          },
        },
      });
    }
    if (message.type === "presentation/open" && openReply !== "ok") {
      return Promise.resolve({
        version: 1,
        ok: false,
        error: { code: openReply },
      });
    }
    return Promise.resolve({ version: 1, ok: true, payload: {} });
  });
  window.webkit = { messageHandlers: { tilecastNative: { postMessage } } };
  return {
    sent,
    ofType: (type: string) =>
      sent.filter((message) => message.type === type).map((m) => m.payload),
    types: () => sent.map((message) => message.type),
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

function renderRoutes(routes: RouteObject[], initialPath: string) {
  const router = createMemoryRouter(
    [
      {
        element: (
          <NativeHostProvider>
            <NativePresentationNavigation />
            <Outlet />
          </NativeHostProvider>
        ),
        children: routes,
      },
    ],
    { initialEntries: [initialPath] },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

function Location() {
  const location = useLocation();
  return <p data-testid="location">{location.pathname}</p>;
}

beforeEach(() => {
  mocks.api.screen.mockResolvedValue({
    id: "screen-1",
    name: "Lobby",
    status: "online",
  });
  mocks.api.screenPreview.mockResolvedValue({
    screenId: "screen-1",
    status: "unavailable",
    imageAvailable: false,
  });
  mocks.api.renewScreenPreview.mockResolvedValue({ active: true });
  mocks.api.preferences.mockResolvedValue({ values: {} });
  mocks.api.startLiveStream.mockResolvedValue({
    id: "session-1",
    screenId: "screen-1",
    active: true,
    expiresAt: "2026-09-30T12:00:15Z",
    frameIntervalMillis: 125,
    maxWidth: 640,
    maxHeight: 360,
    maxFrameBytes: 102400,
  });
  mocks.api.renewLiveStream.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  delete window.webkit;
  delete window.tilecastNativeReceiver;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("opening a native presentation from the main page", () => {
  const routes: RouteObject[] = [
    { path: "/", element: <LivePreviewPanel screenId="screen-1" /> },
  ];

  async function watchLive() {
    const button = await screen.findByRole("button", { name: "Watch live" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
  }

  it("opens the web dialog in a browser and sends nothing", async () => {
    renderRoutes(routes, "/");
    await watchLive();
    expect(await screen.findByText("Web live stream dialog")).toBeVisible();
    expect(window.webkit).toBeUndefined();
  });

  it("opens the web dialog when the host offers no presentations", async () => {
    const host = installNativeHost({ nativePresentations: false });
    renderRoutes(routes, "/");
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));
    await watchLive();
    expect(await screen.findByText("Web live stream dialog")).toBeVisible();
    expect(host.types()).not.toContain("presentation/open");
  });

  it("opens the web dialog when the host refuses", async () => {
    const host = installNativeHost({ openReply: "unavailable" });
    renderRoutes(routes, "/");
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));
    await watchLive();
    expect(await screen.findByText("Web live stream dialog")).toBeVisible();
    expect(host.types()).toContain("presentation/open");
  });

  it("does not open the web dialog when the host presents natively", async () => {
    const host = installNativeHost();
    renderRoutes(routes, "/");
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));
    await watchLive();
    await waitFor(() =>
      expect(host.ofType("presentation/open")).toHaveLength(1),
    );
    const [open] = host.ofType("presentation/open");
    expect(open?.presentationId).toMatch(/^p-[0-9a-f]{32}$/);
    expect(open).toEqual({
      presentationId: open?.presentationId,
      path: "/__native/modal/live-stream/screen-1",
      title: "Live stream · Lobby",
      size: "full",
    });
    // Nothing that could authenticate crosses the bridge.
    expect(JSON.stringify(host.sent)).not.toMatch(/csrf|cookie|token/i);
    expect(screen.queryByText("Web live stream dialog")).toBeNull();
  });

  it("gives each presentation a new id", async () => {
    const host = installNativeHost();
    renderRoutes(routes, "/");
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));
    await watchLive();
    await watchLive();
    await waitFor(() =>
      expect(host.ofType("presentation/open")).toHaveLength(2),
    );
    const [first, second] = host.ofType("presentation/open");
    expect(first?.presentationId).not.toBe(second?.presentationId);
  });

  it("does not stack a presentation from inside a presentation page", async () => {
    const host = installNativeHost({ context: "presentation" });
    renderRoutes(routes, "/");
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));
    await watchLive();
    expect(await screen.findByText("Web live stream dialog")).toBeVisible();
    expect(host.types()).not.toContain("presentation/open");
  });
});

describe("navigation a presentation relays to the main page", () => {
  function Screen() {
    return <p>Screen {useParams().id}</p>;
  }

  it("navigates with React Router", async () => {
    const host = installNativeHost();
    const router = renderRoutes(
      [
        { path: "/", element: <Location /> },
        { path: "/screens/:id", element: <Screen /> },
      ],
      "/",
    );
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));
    expect(
      host.deliver("navigation/open-path", { path: "/screens/abc?tab=x" }),
    ).toBe(true);
    expect(await screen.findByText("Screen abc")).toBeInTheDocument();
    expect(router.state.location.search).toBe("?tab=x");
  });

  it("keeps unsaved-change blockers in force", async () => {
    function Editor() {
      const blocker = useBlocker(true);
      return <p>{blocker.state === "blocked" ? "Leave editor?" : "Editor"}</p>;
    }
    const host = installNativeHost();
    const router = renderRoutes(
      [
        { path: "/", element: <Editor /> },
        { path: "/screens/:id", element: <Screen /> },
      ],
      "/",
    );
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));
    host.deliver("navigation/open-path", { path: "/screens/abc" });
    expect(await screen.findByText("Leave editor?")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
  });

  it("refuses unsafe paths, and any path in a presentation page", async () => {
    const host = installNativeHost();
    renderRoutes([{ path: "*", element: <Location /> }], "/");
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));
    for (const path of [
      "//evil.example",
      "https://evil.example/",
      "/__native/modal",
    ]) {
      expect(host.deliver("navigation/open-path", { path }), path).toBe(false);
    }
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/);
  });

  it("is inert in a presentation page", async () => {
    const host = installNativeHost({ context: "presentation" });
    renderRoutes([{ path: "*", element: <Location /> }], "/");
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));
    expect(host.deliver("navigation/open-path", { path: "/screens" })).toBe(
      false,
    );
  });
});

/** A made-up presentation route, as a future Studio feature would add. */
function FixturePresentation() {
  const { name } = useParams();
  const presentation = useNativePresentation();
  const [count, setCount] = useState(0);
  const [action, setAction] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);
  usePresentationChrome(
    {
      header: {
        title: `Fixture ${name}`,
        actions: [{ id: "refresh", label: "Refresh", icon: "activity" }],
      },
      size: "compact",
    },
    setAction,
  );
  return (
    <section>
      <h1>Fixture {name}</h1>
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        Count {count}
      </button>
      {action ? <p>Action {action}</p> : null}
      <button type="button" onClick={() => presentation?.close()}>
        Close fixture
      </button>
      <button
        type="button"
        onClick={() => presentation?.navigate("/screens/abc")}
      >
        Open screen
      </button>
      <button type="button" onClick={() => setDialog(true)}>
        Open dialog
      </button>
      <Dialog open={dialog} onOpenChange={setDialog}>
        <DialogContent>
          <DialogTitle>Nested dialog</DialogTitle>
        </DialogContent>
      </Dialog>
    </section>
  );
}

describe("the presentation page", () => {
  const children: RouteObject[] = [
    { path: "fixture/:name", element: <FixturePresentation /> },
    { path: "live-stream/:screenId", element: <LiveStreamPresentation /> },
  ];
  const routes: RouteObject[] = [
    {
      path: "/__native/modal",
      element: <NativePresentationHost routes={children} />,
      children,
    },
    { path: "/", element: <p>Start page</p> },
    { path: "/screens/*", element: <p>Screens page</p> },
  ];

  async function bootPresentationPage() {
    const host = installNativeHost({ context: "presentation" });
    const router = renderRoutes(routes, "/__native/modal");
    await waitFor(() => expect(host.types()).toContain("presentation/ready"));
    return { host, router };
  }

  it("redirects direct browser navigation to the start page", async () => {
    renderRoutes(routes, "/__native/modal/fixture/a");
    expect(await screen.findByText("Start page")).toBeInTheDocument();
  });

  it("redirects in the main Studio page", async () => {
    const host = installNativeHost();
    renderRoutes(routes, "/__native/modal");
    expect(await screen.findByText("Start page")).toBeInTheDocument();
    expect(host.types()).not.toContain("presentation/ready");
  });

  it("boots without Studio's shell and reports ready once", async () => {
    const { host } = await bootPresentationPage();
    expect(host.types()).toEqual([
      "config/get",
      "frontend/ready",
      "presentation/ready",
    ]);
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.getByRole("main")).toBeEmptyDOMElement();
  });

  it("shows each presentation by routing, without a reload", async () => {
    const { host, router } = await bootPresentationPage();
    expect(
      host.deliver("presentation/show", {
        presentationId: "p-1",
        path: "/__native/modal/fixture/a",
      }),
    ).toBe(true);
    expect(
      await screen.findByRole("heading", { name: "Fixture a" }),
    ).toBeVisible();
    host.deliver("presentation/dismissed", { presentationId: "p-1" });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/__native/modal"),
    );
    host.deliver("presentation/show", {
      presentationId: "p-2",
      path: "/__native/modal/fixture/b",
    });
    expect(
      await screen.findByRole("heading", { name: "Fixture b" }),
    ).toBeVisible();
    expect(host.ofType("config/get")).toHaveLength(1);
  });

  it("gives each presentation id fresh content", async () => {
    const { host } = await bootPresentationPage();
    host.deliver("presentation/show", {
      presentationId: "p-1",
      path: "/__native/modal/fixture/a",
    });
    await userEvent.click(
      await screen.findByRole("button", { name: "Count 0" }),
    );
    expect(screen.getByRole("button", { name: "Count 1" })).toBeVisible();
    host.deliver("presentation/show", {
      presentationId: "p-2",
      path: "/__native/modal/fixture/a",
    });
    expect(
      await screen.findByRole("button", { name: "Count 0" }),
    ).toBeVisible();
  });

  it("refuses routes Studio does not have and paths outside the tree", async () => {
    const { host } = await bootPresentationPage();
    expect(
      host.deliver("presentation/show", {
        presentationId: "p-1",
        path: "/__native/modal/nothing-here",
      }),
    ).toBe(false);
    expect(
      host.deliver("presentation/show", {
        presentationId: "p-1",
        path: "/screens/abc",
      }),
    ).toBe(false);
    expect(screen.getByRole("main")).toBeEmptyDOMElement();
  });

  it("describes its chrome with complete header snapshots", async () => {
    const { host } = await bootPresentationPage();
    host.deliver("presentation/show", {
      presentationId: "p-1",
      path: "/__native/modal/fixture/a",
    });
    await waitFor(() =>
      expect(host.ofType("presentation/update")).toContainEqual({
        presentationId: "p-1",
        header: {
          title: "Fixture a",
          actions: [{ id: "refresh", label: "Refresh", icon: "activity" }],
        },
        size: "compact",
      }),
    );
  });

  it("hands native actions to the active presentation only", async () => {
    const { host } = await bootPresentationPage();
    host.deliver("presentation/show", {
      presentationId: "p-1",
      path: "/__native/modal/fixture/a",
    });
    await screen.findByRole("heading", { name: "Fixture a" });
    expect(
      host.deliver("presentation/action", {
        presentationId: "p-0",
        actionId: "refresh",
      }),
    ).toBe(false);
    expect(
      host.deliver("presentation/action", {
        presentationId: "p-1",
        actionId: "refresh",
      }),
    ).toBe(true);
    expect(await screen.findByText("Action refresh")).toBeVisible();
  });

  it("asks the host to close, or to navigate the main page", async () => {
    const { host } = await bootPresentationPage();
    host.deliver("presentation/show", {
      presentationId: "p-1",
      path: "/__native/modal/fixture/a",
    });
    await userEvent.click(
      await screen.findByRole("button", { name: "Close fixture" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Open screen" }));
    await waitFor(() =>
      expect(host.ofType("presentation/navigate")).toEqual([
        { presentationId: "p-1", path: "/screens/abc" },
      ]),
    );
    expect(host.ofType("presentation/close")).toEqual([
      { presentationId: "p-1" },
    ]);
    // The main page navigates; this page never leaves the tree.
    expect(screen.queryByText("Screens page")).toBeNull();
  });

  it("grows the sheet for a dialog inside the presentation", async () => {
    const { host } = await bootPresentationPage();
    host.deliver("presentation/show", {
      presentationId: "p-1",
      path: "/__native/modal/fixture/a",
    });
    await userEvent.click(
      await screen.findByRole("button", { name: "Open dialog" }),
    );
    expect(await screen.findByText("Nested dialog")).toBeVisible();
    await waitFor(() =>
      expect(host.ofType("presentation/update")).toContainEqual({
        presentationId: "p-1",
        size: "full",
      }),
    );
  });

  it("ends the live stream lease when the native sheet goes away", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    const { host } = await bootPresentationPage();
    host.deliver("presentation/show", {
      presentationId: "p-1",
      path: "/__native/modal/live-stream/screen-1",
    });
    expect(
      await screen.findByAltText("Live Tilecast output from Lobby"),
    ).toBeInTheDocument();
    expect(mocks.api.startLiveStream).toHaveBeenCalledWith("screen-1", "csrf");
    await waitFor(() =>
      expect(host.ofType("presentation/update")).toContainEqual({
        presentationId: "p-1",
        header: {
          title: "Live stream · Lobby",
          navigation: "close",
          navigationLabel: "Close",
        },
        size: "full",
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();

    host.deliver("presentation/dismissed", { presentationId: "p-1" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/v1/screens/screen-1/live-stream/session-1",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ method: "DELETE", keepalive: true }),
    );
    expect(screen.queryByAltText("Live Tilecast output from Lobby")).toBeNull();
  });
});
