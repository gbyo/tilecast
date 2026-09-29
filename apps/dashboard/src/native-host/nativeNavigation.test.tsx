// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryRouter,
  RouterProvider,
  useBlocker,
  useRoutes,
  type RouteObject,
} from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { i18n } from "@/i18n";
import type { StudioNavigationMetadata } from "@/navigation/studioNavigation";
import { StudioRoutesProvider } from "@/navigation/studioRoutes";
import { DashboardShell } from "@/pages/Dashboard";
import { useNavigationWarning } from "@/settings/useNavigationWarning";
import { NativeHostProvider } from "./NativeHostProvider";

const auth = vi.hoisted(() => ({
  logout: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({
    isLoading: false,
    isSubmitting: false,
    logout: auth.logout,
    status: {
      authenticated: true,
      setupRequired: false,
      csrfToken: "csrf",
      demoMode: false,
      user: {
        id: "user-1",
        name: "Tilecast User",
        username: "tilecast",
        role: "owner",
        active: true,
        createdAt: "",
      },
    },
  }),
}));

type Sent = { version: number; type: string; payload: Record<string, never> };
type Catalog = {
  groups: {
    id: string;
    title?: string;
    items: {
      id: string;
      title: string;
      icon: string;
      mobilePlacement: string;
    }[];
  }[];
};
type State = { activeDestinationId: string | null; path: string };

/**
 * A fake Tilecast native host: the exact message handler the iOS app
 * registers, recording every message and answering like the app does.
 */
function installNativeHost({
  nativeNavigation = true,
  configFails = false,
  refuseCatalog = false,
} = {}) {
  const sent: Sent[] = [];
  const postMessage = vi.fn((message: Sent) => {
    sent.push(structuredClone(message));
    if (message.type === "config/get") {
      if (configFails) return Promise.reject(new Error("host went away"));
      return Promise.resolve({
        version: 1,
        ok: true,
        payload: { protocolVersion: 1, capabilities: { nativeNavigation } },
      });
    }
    if (message.type === "navigation/catalog" && refuseCatalog) {
      return Promise.resolve({
        version: 1,
        ok: false,
        error: { code: "malformed" },
      });
    }
    return Promise.resolve({ version: 1, ok: true, payload: {} });
  });
  window.webkit = { messageHandlers: { tilecastNative: { postMessage } } };
  const ofType = <T,>(type: string) =>
    sent
      .filter((message) => message.type === type)
      .map((message) => message.payload as unknown as T);
  return {
    sent,
    catalogs: () => ofType<Catalog>("navigation/catalog"),
    states: () => ofType<State>("navigation/state"),
    lastState: () => ofType<State>("navigation/state").at(-1),
    request(destinationId: string) {
      let accepted: boolean | undefined;
      act(() => {
        accepted = window.tilecastNativeReceiver?.({
          version: 1,
          type: "navigation/request",
          payload: { destinationId },
        });
      });
      return accepted;
    },
  };
}

function stubFetch(forms: { grantedCapabilities: string[] }[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string) => {
      const url = input;
      const data = url.includes("/api/v1/forms")
        ? { items: forms }
        : { items: [], values: {} };
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data }),
      });
    }),
  );
}

const destination = (metadata: StudioNavigationMetadata) => metadata;

/** An editor with unsaved changes that guards them with useBlocker. */
function UnsavedEditor() {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      currentLocation.pathname !== nextLocation.pathname,
  );
  return (
    <section>
      <h1>Unsaved layout</h1>
      <label>
        Layout name
        <input defaultValue="" />
      </label>
      {blocker.state === "blocked" ? (
        <div role="alertdialog" aria-label="Leave the editor?">
          <button type="button" onClick={() => blocker.reset?.()}>
            Stay
          </button>
          <button type="button" onClick={() => blocker.proceed?.()}>
            Leave
          </button>
        </div>
      ) : null}
    </section>
  );
}

function UnsavedSettings() {
  const dialog = useNavigationWarning(
    true,
    "/settings",
    "Leave with unsaved changes?",
  );
  return (
    <>
      <h1>Settings form</h1>
      {dialog}
    </>
  );
}

const routes: RouteObject[] = [
  {
    path: "/",
    element: <DashboardShell />,
    children: [
      {
        index: true,
        element: <h1>Overview page</h1>,
        handle: {
          breadcrumb: "Overview",
          navigation: destination({
            id: "overview",
            group: "home",
            labelKey: "overview",
            icon: "home",
            order: 0,
            mobilePlacement: "primary",
            end: true,
          }),
        },
      },
      {
        path: "screens",
        handle: {
          breadcrumb: "Screens",
          navigation: destination({
            id: "screens",
            group: "screens",
            labelKey: "items.fleet",
            icon: "screens",
            order: 10,
            mobilePlacement: "primary",
            excludeActiveOn: ["/screens/archive"],
          }),
        },
        children: [
          { index: true, element: <h1>Fleet page</h1> },
          { path: "archive", element: <h1>Archive page</h1> },
          { path: ":id", element: <h1>Screen detail</h1> },
        ],
      },
      {
        path: "layouts",
        handle: {
          breadcrumb: "Layouts",
          navigation: destination({
            id: "layouts",
            group: "presentations",
            labelKey: "items.layouts",
            icon: "layouts",
            order: 20,
          }),
        },
        children: [
          { index: true, element: <h1>Layouts page</h1> },
          { path: ":id", element: <UnsavedEditor /> },
        ],
      },
      {
        path: "settings",
        handle: {
          breadcrumb: "Settings",
          navigation: destination({
            id: "settings",
            group: "secondary",
            labelKey: "items.settings",
            icon: "settings",
            order: 900,
          }),
        },
        children: [{ path: "general", element: <UnsavedSettings /> }],
      },
      {
        path: "account",
        element: <h1>Account page</h1>,
        handle: { breadcrumb: "My Account" },
      },
    ],
  },
];

function Routed() {
  return useRoutes(routes);
}

function renderStudio(path = "/") {
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <NativeHostProvider>
            <StudioRoutesProvider routes={routes}>
              <Routed />
            </StudioRoutesProvider>
          </NativeHostProvider>
        ),
      },
    ],
    { initialEntries: [path] },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
  return { router, ...view };
}

const header = () => screen.getByRole("banner");

beforeEach(() => {
  stubFetch();
});

afterEach(async () => {
  cleanup();
  delete window.webkit;
  delete window.tilecastNativeReceiver;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  auth.logout.mockClear();
  await i18n.changeLanguage("en");
});

describe("Studio in an ordinary browser", () => {
  it("keeps the sidebar and its trigger, and sends nothing", async () => {
    renderStudio("/");
    expect(
      await screen.findByRole("link", { name: "Fleet" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Toggle navigation" }),
    ).toBeInTheDocument();
    // The account menu stays in the sidebar footer, not the topbar.
    expect(
      within(header()).queryByRole("button", { name: /Open account menu/ }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: /Open account menu/ }),
    ).toBeInTheDocument();
    expect(window.tilecastNativeReceiver).toBeUndefined();
  });

  it("ignores WebKit hosts that are not Tilecast", async () => {
    const postMessage = vi.fn();
    window.webkit = { messageHandlers: { somethingElse: { postMessage } } };
    renderStudio("/");
    expect(
      await screen.findByRole("link", { name: "Fleet" }),
    ).toBeInTheDocument();
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe("Studio hosted by the native app", () => {
  it("negotiates, then replaces only the sidebar", async () => {
    const host = installNativeHost();
    renderStudio("/");

    await waitFor(() => expect(host.catalogs().length).toBeGreaterThan(0));
    expect(host.sent[0]?.type).toBe("config/get");
    expect(host.sent.map((message) => message.type)).toContain(
      "frontend/ready",
    );
    expect(await screen.findByText("Overview page")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Fleet" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Toggle navigation" }),
    ).toBeNull();
    // The Studio topbar stays: breadcrumbs, search, notifications.
    expect(
      within(header()).getByRole("navigation", { name: "breadcrumb" }),
    ).toBeInTheDocument();
    expect(
      within(header()).getByRole("button", { name: /Search Tilecast/ }),
    ).toBeInTheDocument();
    expect(
      within(header()).getByRole("button", { name: /Notifications/ }),
    ).toBeInTheDocument();
  });

  it("moves account access and sign out into the topbar", async () => {
    installNativeHost();
    renderStudio("/");
    const user = userEvent.setup();

    await user.click(
      await within(header()).findByRole("button", {
        name: "Open account menu for Tilecast User",
      }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "My Account" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(auth.logout).toHaveBeenCalledTimes(1);
  });

  it("falls back to the sidebar when negotiation fails", async () => {
    installNativeHost({ configFails: true });
    renderStudio("/");
    expect(
      await screen.findByRole("link", { name: "Fleet" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Toggle navigation" }),
    ).toBeInTheDocument();
  });

  it("falls back to the sidebar when the host lacks native navigation", async () => {
    const host = installNativeHost({ nativeNavigation: false });
    renderStudio("/");
    expect(
      await screen.findByRole("link", { name: "Fleet" }),
    ).toBeInTheDocument();
    expect(host.catalogs()).toEqual([]);
  });

  it("falls back to the sidebar when the host refuses the catalog", async () => {
    const host = installNativeHost({ refuseCatalog: true });
    renderStudio("/");
    expect(
      await screen.findByRole("link", { name: "Fleet" }),
    ).toBeInTheDocument();
    expect(host.catalogs().length).toBeGreaterThan(0);
  });

  it("sends a localized catalog with opaque ids and no paths", async () => {
    const host = installNativeHost();
    renderStudio("/");
    await waitFor(() => expect(host.catalogs().length).toBeGreaterThan(0));

    expect(host.catalogs().at(-1)).toEqual({
      groups: [
        {
          id: "home",
          items: [
            {
              id: "overview",
              title: "Overview",
              icon: "home",
              mobilePlacement: "primary",
            },
          ],
        },
        {
          id: "screens",
          title: "Screens",
          items: [
            {
              id: "screens",
              title: "Fleet",
              icon: "screens",
              mobilePlacement: "primary",
            },
          ],
        },
        {
          id: "presentations",
          title: "Presentations",
          items: [
            {
              id: "layouts",
              title: "Layouts",
              icon: "layouts",
              mobilePlacement: "more",
            },
          ],
        },
        {
          id: "secondary",
          items: [
            {
              id: "settings",
              title: "Settings",
              icon: "settings",
              mobilePlacement: "more",
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(host.catalogs())).not.toContain('"/');
  });

  it("adds a plugin's secondary navigation once its visibility allows it", async () => {
    stubFetch([{ grantedCapabilities: ["review"] }]);
    const host = installNativeHost();
    renderStudio("/");

    await waitFor(() =>
      expect(
        host
          .catalogs()
          .at(-1)
          ?.groups.find((group) => group.id === "secondary")
          ?.items.map((item) => item.id),
      ).toEqual(["plugin:forms:approvals", "settings"]),
    );
    const approvals = host.catalogs().at(-1)?.groups.at(-1)?.items[0];
    // The Forms plugin names no native icon, so hosts show a plugin icon.
    expect(approvals).toMatchObject({ title: "Approvals", icon: "plugin" });
  });

  it("keeps a plugin's hidden secondary navigation out of the catalog", async () => {
    stubFetch([{ grantedCapabilities: ["submit"] }]);
    const host = installNativeHost();
    renderStudio("/");
    await waitFor(() => expect(host.catalogs().length).toBeGreaterThan(0));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(JSON.stringify(host.catalogs())).not.toContain("approvals");
  });

  it("resends a localized catalog when the language changes", async () => {
    const host = installNativeHost();
    renderStudio("/");
    await waitFor(() => expect(host.catalogs().length).toBeGreaterThan(0));

    await act(() => i18n.changeLanguage("es"));
    await waitFor(() =>
      expect(host.catalogs().at(-1)?.groups[1]).toMatchObject({
        title: "Pantallas",
        items: [{ id: "screens", title: "Flota" }],
      }),
    );
  });

  it.each([
    ["/", "overview"],
    ["/screens", "screens"],
    ["/screens/player-1", "screens"],
    ["/layouts/abc123", "layouts"],
    ["/screens/archive", null],
    ["/account", null],
  ])("resolves %s to the active destination %s", async (path, expected) => {
    const host = installNativeHost();
    renderStudio(path);
    await waitFor(() => expect(host.lastState()?.path).toBe(path));
    expect(host.lastState()?.activeDestinationId).toBe(expected);
  });

  it("carries out a navigation request with React Router", async () => {
    const host = installNativeHost();
    const { router } = renderStudio("/");
    await waitFor(() => expect(host.catalogs().length).toBeGreaterThan(0));

    expect(host.request("layouts")).toBe(true);
    expect(await screen.findByText("Layouts page")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/layouts");
    await waitFor(() =>
      expect(host.lastState()).toEqual({
        activeDestinationId: "layouts",
        path: "/layouts",
      }),
    );
  });

  it("refuses a stale destination and resends the model", async () => {
    const host = installNativeHost();
    const { router } = renderStudio("/screens/player-1");
    await waitFor(() => expect(host.catalogs().length).toBeGreaterThan(0));
    const catalogs = host.catalogs().length;

    expect(host.request("room-bookings")).toBe(false);
    await waitFor(() =>
      expect(host.catalogs().length).toBeGreaterThan(catalogs),
    );
    expect(router.state.location.pathname).toBe("/screens/player-1");
    expect(host.lastState()?.activeDestinationId).toBe("screens");
  });

  it("acknowledges a request for the current location without navigating", async () => {
    const host = installNativeHost();
    const { router } = renderStudio("/layouts");
    await waitFor(() => expect(host.lastState()?.path).toBe("/layouts"));
    const states = host.states().length;
    const entries = router.state.historyAction;

    expect(host.request("layouts")).toBe(true);
    await waitFor(() => expect(host.states().length).toBeGreaterThan(states));
    expect(router.state.historyAction).toBe(entries);
    expect(host.lastState()?.activeDestinationId).toBe("layouts");
  });
});

describe("unsaved changes under native navigation", () => {
  it("keeps the editor when the user cancels, and leaves when confirmed", async () => {
    const host = installNativeHost();
    const { router } = renderStudio("/layouts/abc123");
    const user = userEvent.setup();
    await waitFor(() => expect(host.lastState()?.path).toBe("/layouts/abc123"));
    await user.type(screen.getByLabelText("Layout name"), "Lobby");

    const states = host.states().length;
    expect(host.request("screens")).toBe(true);
    const prompt = await screen.findByRole("alertdialog", {
      name: "Leave the editor?",
    });
    // Studio acknowledges the blocked request with the unchanged state, so
    // the host keeps Layouts selected.
    await waitFor(() => expect(host.states().length).toBeGreaterThan(states));
    expect(host.lastState()?.activeDestinationId).toBe("layouts");
    expect(router.state.location.pathname).toBe("/layouts/abc123");

    await user.click(within(prompt).getByRole("button", { name: "Stay" }));
    expect(router.state.location.pathname).toBe("/layouts/abc123");
    expect(screen.getByLabelText("Layout name")).toHaveValue("Lobby");
    expect(host.lastState()?.activeDestinationId).toBe("layouts");
    expect(
      host.states().some((state) => state.activeDestinationId === "screens"),
    ).toBe(false);

    host.request("screens");
    await user.click(
      within(
        await screen.findByRole("alertdialog", { name: "Leave the editor?" }),
      ).getByRole("button", { name: "Leave" }),
    );
    expect(await screen.findByText("Fleet page")).toBeInTheDocument();
    await waitFor(() =>
      expect(host.lastState()?.activeDestinationId).toBe("screens"),
    );
  });

  it("asks before a native request discards unsaved settings", async () => {
    const host = installNativeHost();
    const { router } = renderStudio("/settings/general");
    const user = userEvent.setup();
    await waitFor(() =>
      expect(host.lastState()?.activeDestinationId).toBe("settings"),
    );

    host.request("overview");
    const dialog = await screen.findByRole("alertdialog", {
      name: "Leave with unsaved changes?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(router.state.location.pathname).toBe("/settings/general");
    expect(host.lastState()?.activeDestinationId).toBe("settings");

    host.request("overview");
    await user.click(
      within(
        await screen.findByRole("alertdialog", {
          name: "Leave with unsaved changes?",
        }),
      ).getByRole("button", { name: "Discard changes" }),
    );
    expect(await screen.findByText("Overview page")).toBeInTheDocument();
    await waitFor(() =>
      expect(host.lastState()?.activeDestinationId).toBe("overview"),
    );
  });
});

describe("leaving the authenticated chrome", () => {
  it("withdraws native navigation with an empty catalog", async () => {
    const host = installNativeHost();
    const { unmount } = renderStudio("/");
    await waitFor(() => expect(host.catalogs().length).toBeGreaterThan(0));
    expect(host.catalogs().at(-1)?.groups.length).toBeGreaterThan(0);

    unmount();
    await waitFor(() => expect(host.catalogs().at(-1)).toEqual({ groups: [] }));
  });
});
