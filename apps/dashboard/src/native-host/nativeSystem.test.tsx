// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import {
  createMemoryRouter,
  Outlet,
  RouterProvider,
  useBlocker,
  useLocation,
} from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaUploadPanel } from "@/components/content-picker/MediaUploadPanel";
import { NativePresentationNavigation } from "@/native-presentation/NativePresentationNavigation";
import { NativeHostProvider } from "./NativeHostProvider";
import { NativeMediaIntakeRefresh } from "./NativeMediaIntakeRefresh";
import { useNativeHaptic, useNativeShare } from "./useNativeSystem";
import { useNativeMediaIntake } from "./useNativeMediaIntake";

type Sent = { version: number; type: string; payload: Record<string, unknown> };

type HostOptions = {
  context?: "main" | "presentation";
  capabilities?: Record<string, boolean>;
  /** Replies by message type; the default is an empty success. */
  replies?: Record<string, () => unknown>;
};

/** The app's handler, answering like the iOS host and recording what it gets. */
function installNativeHost({
  context = "main",
  capabilities = {},
  replies = {},
}: HostOptions = {}) {
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

const failure = (code: string) => () => ({
  version: 1,
  ok: false,
  error: { code },
});

function wrapper(client = new QueryClient()) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <NativeHostProvider>{children}</NativeHostProvider>
      </QueryClientProvider>
    );
  };
}

beforeEach(() => {
  window.webkit = undefined;
});

afterEach(() => {
  cleanup();
  window.webkit = undefined;
  delete window.tilecastNativeReceiver;
  vi.restoreAllMocks();
});

describe("haptics", () => {
  it("asks the host for a semantic feedback type", async () => {
    const host = installNativeHost({ capabilities: { systemHaptics: true } });
    const { result } = renderHook(() => useNativeHaptic(), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));
    act(() => result.current("success"));
    await waitFor(() =>
      expect(host.ofType("system/haptic")).toEqual([{ feedback: "success" }]),
    );
  });

  it("sends nothing to a host that did not offer the capability", async () => {
    const host = installNativeHost();
    const { result } = renderHook(() => useNativeHaptic(), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));
    act(() => result.current("error"));
    expect(host.types()).not.toContain("system/haptic");
  });

  it("does nothing in a browser", () => {
    const { result } = renderHook(() => useNativeHaptic(), {
      wrapper: wrapper(),
    });
    expect(() => result.current("success")).not.toThrow();
  });

  it("works in a presentation page too", async () => {
    const host = installNativeHost({
      context: "presentation",
      capabilities: { systemHaptics: true },
    });
    const { result } = renderHook(() => useNativeHaptic(), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));
    act(() => result.current("selection"));
    await waitFor(() => expect(host.types()).toContain("system/haptic"));
  });
});

describe("share", () => {
  const content = {
    title: "Lobby display",
    url: "https://signage.example.org/preview/lobby",
  };

  it("resolves true when the host presented the share sheet", async () => {
    const host = installNativeHost({ capabilities: { systemShare: true } });
    const { result } = renderHook(() => useNativeShare(), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));
    let shared: boolean | undefined;
    await act(async () => {
      shared = await result.current(content);
    });
    expect(shared).toBe(true);
    expect(host.ofType("system/share")).toEqual([content]);
  });

  it("resolves false so the caller keeps its web behavior when the host cannot", async () => {
    const host = installNativeHost({
      capabilities: { systemShare: true },
      replies: { "system/share": failure("unavailable") },
    });
    const { result } = renderHook(() => useNativeShare(), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));
    await act(async () => {
      expect(await result.current(content)).toBe(false);
    });
  });

  it("never sends an unsafe request", async () => {
    const host = installNativeHost({ capabilities: { systemShare: true } });
    const { result } = renderHook(() => useNativeShare(), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));
    for (const unsafe of [
      { url: "javascript:alert(1)" },
      { url: "file:///etc/passwd" },
      { url: "https://signage.example.org/cb?access_token=abc" },
      { text: "tca_0123456789" },
      { title: "Only a title" },
    ]) {
      await act(async () => {
        expect(await result.current(unsafe)).toBe(false);
      });
    }
    expect(host.types()).not.toContain("system/share");
  });

  it("resolves false in a browser", async () => {
    const { result } = renderHook(() => useNativeShare(), {
      wrapper: wrapper(),
    });
    expect(await result.current(content)).toBe(false);
  });
});

describe("native media intake", () => {
  const status = (available: boolean) => () => ({
    version: 1,
    ok: true,
    payload: { available },
  });

  it("is available only when the host reports it can begin", async () => {
    const host = installNativeHost({
      capabilities: { nativeMediaIntake: true },
      replies: { "system/media-intake-status": status(true) },
    });
    const { result } = renderHook(() => useNativeMediaIntake(), {
      wrapper: wrapper(),
    });
    expect(result.current.available).toBe(false);
    await waitFor(() => expect(result.current.available).toBe(true));
    expect(host.ofType("system/media-intake-status")).toHaveLength(1);
  });

  it("stays unavailable without a native credential, so Studio keeps its uploader", async () => {
    const host = installNativeHost({
      capabilities: { nativeMediaIntake: true },
      replies: { "system/media-intake-status": status(false) },
    });
    const { result } = renderHook(() => useNativeMediaIntake(), {
      wrapper: wrapper(),
    });
    await waitFor(() =>
      expect(host.types()).toContain("system/media-intake-status"),
    );
    expect(result.current.available).toBe(false);
    await act(async () => {
      expect(await result.current.request()).toBe(false);
    });
    expect(host.types()).not.toContain("system/media-intake");
  });

  it("asks nothing of a browser or a host without the capability", async () => {
    const host = installNativeHost();
    const { result } = renderHook(() => useNativeMediaIntake(), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));
    expect(result.current.available).toBe(false);
    expect(host.types()).not.toContain("system/media-intake-status");
  });

  it("is main-page only", async () => {
    const host = installNativeHost({
      context: "presentation",
      capabilities: { nativeMediaIntake: true },
      replies: { "system/media-intake-status": status(true) },
    });
    const { result } = renderHook(() => useNativeMediaIntake(), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));
    expect(result.current.available).toBe(false);
    expect(host.types()).not.toContain("system/media-intake-status");
  });

  it("requests intake with an opaque id and no data, and hears how it ended", async () => {
    const host = installNativeHost({
      capabilities: { nativeMediaIntake: true },
      replies: { "system/media-intake-status": status(true) },
    });
    const completed = vi.fn();
    const { result } = renderHook(() => useNativeMediaIntake(completed), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.available).toBe(true));
    let started: boolean | undefined;
    await act(async () => {
      started = await result.current.request({
        accept: ["image", "video"],
        multiple: true,
      });
    });
    expect(started).toBe(true);
    const [request] = host.ofType("system/media-intake");
    expect(Object.keys(request!).sort()).toEqual([
      "accept",
      "multiple",
      "requestId",
    ]);
    expect(request!.requestId).toMatch(/^mi-[0-9a-f]{32}$/);
    const serialized = JSON.stringify(host.sent);
    for (const forbidden of ["csrf", "token", "cookie", "password"]) {
      expect(serialized.toLowerCase(), forbidden).not.toContain(forbidden);
    }

    // A result for another request is not this request's.
    expect(
      host.deliver("system/media-intake-completed", {
        requestId: "mi-other",
        outcome: "completed",
        uploadedCount: 1,
      }),
    ).toBe(false);
    expect(completed).not.toHaveBeenCalled();
    expect(
      host.deliver("system/media-intake-completed", {
        requestId: request!.requestId,
        outcome: "partial",
        uploadedCount: 1,
      }),
    ).toBe(true);
    expect(completed).toHaveBeenCalledWith({
      requestId: request!.requestId,
      outcome: "partial",
      uploadedCount: 1,
    });
  });

  it("falls back at once when the host cannot begin", async () => {
    installNativeHost({
      capabilities: { nativeMediaIntake: true },
      replies: {
        "system/media-intake-status": status(true),
        "system/media-intake": failure("unavailable"),
      },
    });
    const { result } = renderHook(() => useNativeMediaIntake(), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.available).toBe(true));
    await act(async () => {
      expect(await result.current.request()).toBe(false);
    });
    await waitFor(() => expect(result.current.available).toBe(false));
  });

  it("refetches the media queries when intake uploaded something", async () => {
    const host = installNativeHost({
      capabilities: { nativeMediaIntake: true },
    });
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    render(
      <QueryClientProvider client={client}>
        <NativeHostProvider>
          <NativeMediaIntakeRefresh />
        </NativeHostProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));
    // Even a request that began on a page that no longer exists refreshes.
    host.deliver("system/media-intake-completed", {
      requestId: "mi-1",
      outcome: "completed",
      uploadedCount: 2,
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["assets"] });
    invalidate.mockClear();
    host.deliver("system/media-intake-completed", {
      requestId: "mi-1",
      outcome: "cancelled",
      uploadedCount: 0,
    });
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("the upload panel's Choose files control", () => {
  const status = (available: boolean) => () => ({
    version: 1,
    ok: true,
    payload: { available },
  });
  const chooseFiles = () =>
    fireEvent.click(screen.getByRole("button", { name: "Choose files" }));

  function renderPanel() {
    return render(<MediaUploadPanel csrf="csrf" />, { wrapper: wrapper() });
  }

  it("opens the browser file input in a browser", () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click");
    renderPanel();
    chooseFiles();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("opens the native pickers when the host can, and not the file input", async () => {
    const host = installNativeHost({
      capabilities: { nativeMediaIntake: true, systemHaptics: true },
      replies: { "system/media-intake-status": status(true) },
    });
    const click = vi.spyOn(HTMLInputElement.prototype, "click");
    renderPanel();
    await waitFor(() =>
      expect(host.types()).toContain("system/media-intake-status"),
    );
    // Wait for the answer to land, so the click decides synchronously.
    await act(async () => {
      await Promise.resolve();
    });
    await waitFor(() => {
      chooseFiles();
      expect(host.types()).toContain("system/media-intake");
    });
    expect(click).not.toHaveBeenCalled();
    const [request] = host.ofType("system/media-intake");
    expect(request!.accept).toEqual(["image", "video"]);

    host.deliver("system/media-intake-completed", {
      requestId: request!.requestId,
      outcome: "completed",
      uploadedCount: 2,
    });
    expect(
      await screen.findByText(/Uploaded from this device/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(host.ofType("system/haptic")).toContainEqual({
        feedback: "success",
      }),
    );
  });

  it("uses the browser file input when the host has no native credential", async () => {
    const host = installNativeHost({
      capabilities: { nativeMediaIntake: true },
      replies: { "system/media-intake-status": status(false) },
    });
    const click = vi.spyOn(HTMLInputElement.prototype, "click");
    renderPanel();
    await waitFor(() =>
      expect(host.types()).toContain("system/media-intake-status"),
    );
    chooseFiles();
    expect(click).toHaveBeenCalledTimes(1);
    expect(host.types()).not.toContain("system/media-intake");
  });

  it("says so when the upload failed, and offers the picker again", async () => {
    const host = installNativeHost({
      capabilities: { nativeMediaIntake: true },
      replies: { "system/media-intake-status": status(true) },
    });
    renderPanel();
    await waitFor(() => {
      chooseFiles();
      expect(host.types()).toContain("system/media-intake");
    });
    const [request] = host.ofType("system/media-intake");
    host.deliver("system/media-intake-completed", {
      requestId: request!.requestId,
      outcome: "failed",
      uploadedCount: 0,
    });
    expect(await screen.findByText(/could not be uploaded/)).toBeVisible();
  });
});

describe("deep links", () => {
  function Location() {
    const location = useLocation();
    return <p data-testid="location">{location.pathname}</p>;
  }

  function renderRoutes(
    capabilities: Record<string, boolean>,
    routes: { path: string; element: ReactNode }[],
  ) {
    const host = installNativeHost({ capabilities });
    const router = createMemoryRouter(
      [
        {
          element: (
            <QueryClientProvider client={new QueryClient()}>
              <NativeHostProvider>
                <NativePresentationNavigation />
                <Outlet />
              </NativeHostProvider>
            </QueryClientProvider>
          ),
          children: routes,
        },
      ],
      { initialEntries: ["/"] },
    );
    render(<RouterProvider router={router} />);
    return { host, router };
  }

  it("reaches React Router through the same open-path message", async () => {
    const { host, router } = renderRoutes({ deepLinks: true }, [
      { path: "/", element: <Location /> },
      { path: "/screens/:id", element: <Location /> },
    ]);
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));
    expect(host.ofType("frontend/ready")[0]!.capabilities).toMatchObject({
      deepLinks: true,
      nativeMediaIntake: true,
    });
    expect(
      host.deliver("navigation/open-path", { path: "/screens/abc?tab=x" }),
    ).toBe(true);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/screens/abc"),
    );
    expect(router.state.location.search).toBe("?tab=x");
  });

  it("does not open a deep link for a host that did not offer the capability", async () => {
    const { host, router } = renderRoutes({}, [
      { path: "*", element: <Location /> },
    ]);
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));
    expect(host.deliver("navigation/open-path", { path: "/screens" })).toBe(
      false,
    );
    expect(router.state.location.pathname).toBe("/");
  });

  it.each([
    "/login",
    "/login?next=/",
    "/setup",
    "/oauth/approve",
    "/oauth/approve?client_id=x",
    "/__native/modal",
    "//evil.example",
    "https://evil.example/",
    "/screens/../login",
    "/screens/%2e%2e/login",
  ])("never opens %s", async (path) => {
    const { host, router } = renderRoutes({ deepLinks: true }, [
      { path: "*", element: <Location /> },
    ]);
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));
    expect(host.deliver("navigation/open-path", { path })).toBe(false);
    expect(router.state.location.pathname).toBe("/");
  });

  it("keeps unsaved-change blockers in force", async () => {
    function Editor() {
      const blocker = useBlocker(true);
      return <p>{blocker.state === "blocked" ? "Leave editor?" : "Editor"}</p>;
    }
    const { host, router } = renderRoutes({ deepLinks: true }, [
      { path: "/", element: <Editor /> },
      { path: "/screens/:id", element: <Location /> },
    ]);
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));
    host.deliver("navigation/open-path", { path: "/screens/abc" });
    expect(await screen.findByText("Leave editor?")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
  });
});
