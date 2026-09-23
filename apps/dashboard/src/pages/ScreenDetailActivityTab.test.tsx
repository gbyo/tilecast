// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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

/** Stubs the reads the detail page makes; the tabs are the subject here. */
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
  vi.spyOn(api, "screens").mockResolvedValue({
    items: [screenRecord],
  } as never);
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

async function tabList() {
  return await screen.findByRole("tablist", { name: "Screen details" });
}

describe("screen detail tabs", () => {
  it("maps legacy reliability links to the Device health section", async () => {
    renderDetail("/screens/screen-1?tab=reliability");

    const tabs = await tabList();
    expect(
      within(tabs)
        .getByRole("tab", { name: "Device" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(within(tabs).queryByRole("tab", { name: "Reliability" })).toBeNull();
    const deviceTabs = await screen.findByRole("navigation", {
      name: "Device sections",
    });
    expect(
      within(deviceTabs)
        .getByRole("link", { name: "Health" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      await screen.findByRole("heading", { name: "Health & recovery" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("screen-behavior")).toBeNull();
  });

  it("shows only the selected detail workspace", async () => {
    const user = userEvent.setup();
    renderDetail("/screens/screen-1?tab=reliability");

    const tabs = await tabList();
    await user.click(within(tabs).getByRole("tab", { name: "Settings" }));

    expect(await screen.findByTestId("screen-behavior")).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Health & recovery" }),
    ).toBeNull();
    expect(screen.getByText("?tab=settings")).toBeTruthy();
  });

  it("does not append snapshot history to the Overview sidebar", async () => {
    renderDetail("/screens/screen-1");

    expect(await screen.findByTestId("preview")).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Snapshot history" }),
    ).toBeNull();
  });

  it("keeps the legacy snapshot URL on Overview and opens its history", async () => {
    renderDetail("/screens/screen-1?tab=snapshots");

    expect(await screen.findByTestId("preview")).toBeTruthy();
    expect(
      screen.getByText("Snapshot history", { selector: "summary" }),
    ).toBeTruthy();
    expect(
      await screen.findByRole("heading", { name: "Overview", level: 2 }),
    ).toBeTruthy();
  });

  it("renders exactly one Activity tab, owned by the shared tab strip", async () => {
    renderDetail("/screens/screen-1?tab=activity");

    const tabs = await tabList();
    expect(within(tabs).getAllByRole("tab", { name: "Activity" })).toHaveLength(
      1,
    );
    // Nothing outside the tab strip may inject a second control.
    expect(screen.getAllByRole("tab", { name: "Activity" })).toHaveLength(1);
  });

  it("marks the Activity tab as the selected one and nothing else", async () => {
    renderDetail("/screens/screen-1?tab=activity");

    const tabs = await tabList();
    const current = within(tabs)
      .getAllByRole("tab")
      .filter((tab) => tab.getAttribute("aria-selected") === "true");
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain("Activity");
  });

  it("shows the Activity panel without Overview content beneath it", async () => {
    renderDetail("/screens/screen-1?tab=activity");

    expect(
      await screen.findByRole("heading", { name: "Activity", level: 2 }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Screen overview" }),
    ).toBeNull();
    // The old workaround hid Overview with CSS, so the nodes were still in the
    // accessibility tree; assert on the content itself, not on visibility.
    expect(screen.queryByText("Online status")).toBeNull();
  });

  it("keeps the Activity panel heading and its filtered Activity link", async () => {
    renderDetail("/screens/screen-1?tab=activity");

    const link = await screen.findByRole("link", {
      name: "Open filtered Activity",
    });
    expect(link.getAttribute("href")).toBe(
      "/activity?tab=proof&screen=screen-1",
    );
  });

  it("selects the Activity tab through the shared tab strip", async () => {
    const user = userEvent.setup();
    renderDetail("/screens/screen-1");

    const tabs = await tabList();
    await user.click(within(tabs).getByRole("tab", { name: "Activity" }));

    await waitFor(() => expect(screen.getByText("?tab=activity")).toBeTruthy());
    expect(
      await screen.findByRole("heading", { name: "Activity", level: 2 }),
    ).toBeTruthy();
  });

  it("moves focus across tabs with the arrow keys", async () => {
    const user = userEvent.setup();
    renderDetail("/screens/screen-1?tab=activity");

    const tabs = await tabList();
    const activity = within(tabs).getByRole("tab", { name: "Activity" });
    activity.focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement?.textContent).toContain("Device");
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(document.activeElement?.textContent).toContain("Content");
    await user.keyboard("{Home}");
    expect(document.activeElement?.textContent).toContain("Overview");
    await user.keyboard("{End}");
    expect(document.activeElement?.textContent).toContain("Settings");
  });

  it("falls back to Overview when the tab in the URL is not a real tab", async () => {
    renderDetail("/screens/screen-1?tab=bogus");

    // Both the wrapper and the detail page must agree that this is Overview,
    // or the preview panel silently disappears.
    expect(await screen.findByTestId("preview")).toBeTruthy();
    expect(
      await screen.findByRole("heading", { name: "Overview", level: 2 }),
    ).toBeTruthy();
  });

  it("shows Android device fields for a screen reporting android-tv", async () => {
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

  it("explains an empty Maintenance workspace to a Viewer", async () => {
    authStatus.user = { id: "user-2", name: "Viewer", role: "viewer" };
    try {
      renderDetail("/screens/screen-1?tab=manage&section=maintenance");

      expect(
        await screen.findByRole("heading", {
          name: "Recent operations",
          level: 3,
        }),
      ).toBeTruthy();
      expect(
        screen.getByText(/No maintenance commands have been sent/),
      ).toBeTruthy();
    } finally {
      authStatus.user = { id: "user-1", name: "Owner", role: "owner" };
    }
  });

  it("does not reach outside its own subtree to place a tab", async () => {
    renderDetail("/screens/screen-1?tab=activity");
    await screen.findByRole("heading", { name: "Activity", level: 2 });

    // A stray strip added after mount must not attract a portalled button.
    const stray = document.createElement("nav");
    stray.className = "screen-detail-tabs";
    document.body.append(stray);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stray.childElementCount).toBe(0);
    stray.remove();
  });
});
