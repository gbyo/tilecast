// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenDetailWithPreviewPage } from "./ScreenDetailWithPreviewPage";
import { api } from "../api/client";

const authStatus = {
  authenticated: true,
  csrfToken: "token",
  user: { id: "user-1", name: "Owner", role: "owner" },
};

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ status: authStatus }),
}));
vi.mock("../hooks/use-desktop-layout", () => ({
  useDesktopLayout: () => true,
}));

// The preview and Fire TV panels open sockets and have their own coverage.
vi.mock("../components/LivePreviewPanel", () => ({
  LivePreviewPanel: () => <div data-testid="preview" />,
}));
vi.mock("../components/FireTvAccessibilityAdbPanel", () => ({
  FireTvAccessibilityAdbPanel: () => <div data-testid="firetv" />,
}));
vi.mock("../settings/PlayerPolicyEditor", () => ({
  PlayerPolicyEditor: () => <div data-testid="screen-behavior" />,
}));

const screenRecord = {
  id: "screen-1",
  name: "Lobby north",
  description: "",
  status: "online",
  platform: "android",
  enabled: true,
  playerVersion: "1.0.0",
  deviceModel: "Shield",
  deviceManufacturer: "NVIDIA",
  pairedAt: "2026-07-01T00:00:00.000Z",
};

function renderDetail(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/screens/:id"
            element={
              <>
                <ScreenDetailWithPreviewPage />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function LocationProbe() {
  const location = useLocation();
  return <output>{location.search}</output>;
}

function stubApi() {
  const empty = { items: [] } as never;
  vi.spyOn(api, "locations").mockResolvedValue(empty);
  vi.spyOn(api, "playlists").mockResolvedValue(empty);
  vi.spyOn(api, "layouts").mockResolvedValue(empty);
  vi.spyOn(api, "screenCommands").mockResolvedValue(empty);
  vi.spyOn(api, "screenReliability").mockResolvedValue(empty);
  vi.spyOn(api, "screenPolicy").mockResolvedValue(empty);
  vi.spyOn(api, "screenSnapshots").mockResolvedValue({
    items: [],
    enabled: true,
    retentionDays: 7,
    maxPerScreen: 48,
    proofNote: "Captured from Tilecast Player.",
  });
  vi.spyOn(api, "playlistAssignment").mockResolvedValue(empty);
  vi.spyOn(api, "screen").mockResolvedValue(screenRecord as never);
  vi.spyOn(api, "screens").mockResolvedValue({ items: [screenRecord] } as never);
}

beforeEach(() => {
  stubApi();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      const data = url.includes("/timeline")
        ? {
            range: { from: "", to: "" },
            status: { health: "healthy", healthReason: "playing" },
            entries: [],
          }
        : {
            screenId: "screen-1",
            recentProofOfPlay: [],
            recentEvents: [],
            playbackGaps: 0,
          };
      return Promise.resolve(
        new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function primaryTabs() {
  return await screen.findByRole("tablist", { name: "Screen details" });
}

describe("screen detail navigation", () => {
  it("maps legacy reliability links to Overview and opens Health diagnostics", async () => {
    renderDetail("/screens/screen-1?tab=reliability");

    const tabs = await primaryTabs();
    expect(
      within(tabs).getByRole("tab", { name: "Overview" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(within(tabs).queryByRole("tab", { name: "Device" })).toBeNull();

    const diagnostics = await screen.findByRole("tablist", {
      name: "Device sections",
    });
    expect(
      within(diagnostics).getByRole("tab", { name: "Health" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      await screen.findByRole("heading", { name: "Health & recovery" }),
    ).toBeTruthy();
  });

  it("shows only the selected primary workspace", async () => {
    const user = userEvent.setup();
    renderDetail("/screens/screen-1");

    const tabs = await primaryTabs();
    await user.click(within(tabs).getByRole("tab", { name: "Settings" }));

    expect(await screen.findByTestId("screen-behavior")).toBeTruthy();
    expect(screen.queryByTestId("preview")).toBeNull();
    expect(screen.getByText("?tab=settings")).toBeTruthy();
  });

  it("keeps snapshot history closed during ordinary Overview use", async () => {
    renderDetail("/screens/screen-1");

    expect(await screen.findByTestId("preview")).toBeTruthy();
    expect(screen.queryByText("Snapshot history")).toBeNull();
  });

  it("keeps the legacy snapshot URL on Overview and opens history", async () => {
    renderDetail("/screens/screen-1?tab=snapshots");

    expect(await screen.findByTestId("preview")).toBeTruthy();
    expect(await screen.findByText("Snapshot history")).toBeTruthy();
    const tabs = await primaryTabs();
    expect(
      within(tabs).getByRole("tab", { name: "Overview" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("renders exactly one Activity tab in the primary strip", async () => {
    renderDetail("/screens/screen-1?tab=activity");

    const tabs = await primaryTabs();
    expect(within(tabs).getAllByRole("tab", { name: "Activity" })).toHaveLength(1);
    expect(screen.getAllByRole("tab", { name: "Activity" })).toHaveLength(1);
  });

  it("shows Activity without Overview content beneath it", async () => {
    renderDetail("/screens/screen-1?tab=activity");

    expect(await screen.findByRole("heading", { name: "Activity", level: 2 })).toBeTruthy();
    expect(screen.queryByTestId("preview")).toBeNull();
  });

  it("selects Activity through the primary strip", async () => {
    const user = userEvent.setup();
    renderDetail("/screens/screen-1");

    const tabs = await primaryTabs();
    await user.click(within(tabs).getByRole("tab", { name: "Activity" }));

    await waitFor(() => expect(screen.getByText("?tab=activity")).toBeTruthy());
    expect(await screen.findByRole("heading", { name: "Activity", level: 2 })).toBeTruthy();
  });

  it("moves focus across the three primary tabs with arrow keys", async () => {
    const user = userEvent.setup();
    renderDetail("/screens/screen-1?tab=activity");

    const tabs = await primaryTabs();
    const activity = within(tabs).getByRole("tab", { name: "Activity" });
    activity.focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement?.textContent).toContain("Settings");
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(document.activeElement?.textContent).toContain("Overview");
    await user.keyboard("{End}");
    expect(document.activeElement?.textContent).toContain("Settings");
  });

  it("falls back to Overview for an unknown tab", async () => {
    renderDetail("/screens/screen-1?tab=bogus");

    expect(await screen.findByTestId("preview")).toBeTruthy();
    const tabs = await primaryTabs();
    expect(
      within(tabs).getByRole("tab", { name: "Overview" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("keeps legacy device links working inside diagnostics", async () => {
    vi.spyOn(api, "screen").mockResolvedValue({
      ...screenRecord,
      platform: "android-tv",
      androidSdk: 33,
      installerSource: "sideload",
    } as never);
    renderDetail("/screens/screen-1?tab=manage&section=device");

    expect(await screen.findByText("Android SDK")).toBeTruthy();
    expect(screen.getByText("Installer source")).toBeTruthy();
  });

  it("keeps viewer maintenance history accessible through diagnostics", async () => {
    authStatus.user = { id: "user-2", name: "Viewer", role: "viewer" };
    try {
      renderDetail("/screens/screen-1?tab=manage&section=maintenance");
      expect(await screen.findByText("Recent operations")).toBeTruthy();
      expect(screen.getByText(/No maintenance commands have been sent/)).toBeTruthy();
    } finally {
      authStatus.user = { id: "user-1", name: "Owner", role: "owner" };
    }
  });
});
