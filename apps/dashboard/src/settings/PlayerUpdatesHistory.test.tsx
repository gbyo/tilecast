// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import { PlayerUpdatesPanel } from "./SettingsOperations";
import { api } from "../api/client";
import type {
  PlayerRelease,
  UpdateDeployment,
  UpdateDeploymentDetail,
} from "../api/types";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ status: { csrfToken: "csrf", user: { role: "owner" } } }),
}));

const deployment: UpdateDeployment = {
  id: "d1",
  name: "Tilecast Player 1.4.0",
  mode: "install_now",
  status: "active",
  createdAt: "2026-07-30T11:00:00Z",
  platform: "android",
  versionCode: 42,
  versionName: "1.4.0",
  targetCount: 6,
  succeededCount: 3,
  failedCount: 1,
  waitingForUserCount: 2,
  rolloutMode: "full",
  rolloutPhase: "full",
};

const detail: UpdateDeploymentDetail = {
  ...deployment,
  artifactSizeBytes: 1024,
  rolloutMode: "full",
  rolloutPhase: "full",
  canarySize: 0,
  screens: [
    {
      screenId: "s1",
      screenName: "Gym",
      previousVersionCode: 41,
      expectedVersionCode: 42,
      downloadedBytes: 0,
      state: "waiting_for_user",
      updatedAt: "2026-07-30T11:40:00Z",
      isCanary: false,
    },
  ],
};

function widen<T>(value: unknown) {
  return value as T;
}

// The panel keeps the chosen platform in the URL; this reports what it wrote.
function SearchProbe() {
  return <span data-testid="search">{useLocation().search}</span>;
}

describe("Player update deployment history", () => {
  beforeEach(() => {
    vi.spyOn(api, "playerReleases").mockResolvedValue(
      widen<Awaited<ReturnType<typeof api.playerReleases>>>({
        repository: "Gibsonmb71/tilecast",
        manifestKeyConfigured: true,
        githubAuth: {
          available: false,
          connected: false,
          source: "anonymous",
          canDisconnect: false,
        },
        items: [],
      }),
    );
    vi.spyOn(api, "updateDeployments").mockResolvedValue({
      items: [deployment],
    });
    vi.spyOn(api, "updateDeployment").mockResolvedValue(detail);
    vi.spyOn(api, "screens").mockResolvedValue(
      widen<Awaited<ReturnType<typeof api.screens>>>({ items: [], total: 0 }),
    );
    vi.spyOn(api, "screenGroups").mockResolvedValue(
      widen<Awaited<ReturnType<typeof api.screenGroups>>>({
        items: [],
        total: 0,
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function renderPanel(entry = "/settings/player/updates") {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <MemoryRouter initialEntries={[entry]}>
        <QueryClientProvider client={client}>
          <PlayerUpdatesPanel owner manageable />
          <SearchProbe />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  }

  it("says what the deployment needs rather than only counting", async () => {
    renderPanel();
    expect(await screen.findByText(/1 screen needs a retry/)).toBeTruthy();
    expect(screen.getByText("3 of 6 updated")).toBeTruthy();
    // The meter repeats itself as text so the segments are never colour alone.
    expect(
      screen.getByRole("img", {
        name: "3 Updated, 2 Waiting on someone, 1 Failed",
      }),
    ).toBeTruthy();
  });

  it("reads the platform from the URL so a reload stays on Linux", async () => {
    renderPanel("/settings/player/updates?platform=linux");
    expect(await screen.findByText("Available Linux releases")).toBeTruthy();
    // The Android-only deployment is not the Linux fleet's history.
    expect(screen.queryByText(/1 screen needs a retry/)).toBeNull();
  });

  it("shows live cache progress in megabytes", async () => {
    const release: PlayerRelease = {
      id: "r1",
      tag: "player-v1.4.0",
      platform: "android",
      source: "github",
      channel: "stable",
      versionCode: 42,
      versionName: "1.4.0",
      minimumSdk: 23,
      releaseNotes: "",
      publishedAt: "2026-07-30T11:00:00Z",
      apkSizeBytes: 50 * 1024 * 1024,
      downloadedBytes: 20 * 1024 * 1024,
      apkSha256: "a".repeat(64),
      signingCertificateSha256: "b".repeat(64),
      manifestSignature: "signature",
      cacheStatus: "downloading",
      verificationStatus: "verified_manifest",
      deploymentCount: 0,
      activeDeploymentCount: 0,
    };
    vi.mocked(api.playerReleases).mockResolvedValue({
      repository: "Gibsonmb71/tilecast",
      manifestKeyConfigured: true,
      githubAuth: {
        available: false,
        connected: false,
        source: "anonymous",
        canDisconnect: false,
      },
      items: [release],
    });
    renderPanel();
    expect(await screen.findByText("20.0 MB of 50.0 MB")).toBeTruthy();
    expect(
      document.querySelector(".player-release-cache-progress progress"),
    ).toHaveProperty("value", 20 * 1024 * 1024);
  });

  it("records a platform switch in the URL", async () => {
    renderPanel();
    expect(await screen.findByText("Available Android releases")).toBeTruthy();
    const platforms = screen.getByRole("tablist", { name: "Player platform" });
    expect(
      within(platforms)
        .getByRole("tab", { name: "Android" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    await userEvent.click(screen.getByRole("tab", { name: "Linux" }));
    expect(await screen.findByText("Available Linux releases")).toBeTruthy();
    expect(screen.queryByText("Available Android releases")).toBeNull();
    expect(
      screen.getByRole("tab", { name: "Linux" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("tabpanel")).toBeTruthy();
    expect(screen.getByTestId("search").textContent).toBe("?platform=linux");
    // Android is the default, so it leaves no parameter behind.
    await userEvent.click(screen.getByRole("tab", { name: "Android" }));
    expect(await screen.findByText("Available Android releases")).toBeTruthy();
    expect(screen.getByTestId("search").textContent).toBe("");
  });

  it("opens the per-screen drawer from the history row", async () => {
    renderPanel();
    await userEvent.click(
      await screen.findByRole("button", { name: /6 screens/ }),
    );
    expect(
      await screen.findByRole("dialog", { name: /Tilecast Player 1.4.0/ }),
    ).toBeTruthy();
    expect(screen.getByText("Needs approval on the TV")).toBeTruthy();
  });

  it("keeps Tilecast Edge releases and screens apart from the Electron player", async () => {
    const base = {
      source: "upload",
      channel: "stable",
      minimumSdk: null,
      releaseNotes: "",
      publishedAt: "2026-09-25T11:00:00Z",
      apkSizeBytes: 1024,
      downloadedBytes: 1024,
      apkSha256: "a".repeat(64),
      signingCertificateSha256: "",
      manifestSignature: "signature",
      cacheStatus: "cached",
      verificationStatus: "verified",
      deploymentCount: 0,
      activeDeploymentCount: 0,
    } as const;
    const edgeRelease: PlayerRelease = {
      ...base,
      id: "edge",
      tag: "",
      platform: "linux",
      playerFamily: "edge",
      architecture: "x86_64",
      versionCode: 2000,
      versionName: "0.2.0",
    };
    const appImage: PlayerRelease = {
      ...base,
      id: "electron",
      tag: "",
      platform: "linux",
      playerFamily: "electron-linux",
      architecture: "",
      versionCode: 9000,
      versionName: "0.9.0",
    };
    vi.mocked(api.playerReleases).mockResolvedValue({
      repository: "Gibsonmb71/tilecast",
      manifestKeyConfigured: true,
      githubAuth: {
        available: false,
        connected: false,
        source: "anonymous",
        canDisconnect: false,
      },
      items: [edgeRelease, appImage],
    });
    const screenBase = {
      description: "",
      location: "",
      roomName: "",
      roomNumber: "",
      deviceManufacturer: "",
      deviceModel: "",
      androidVersion: "",
      playerVersion: "0.1.0",
      screenWidth: 1920,
      screenHeight: 1080,
      density: 1,
      locale: "en-US",
      timezone: "UTC",
      enabled: true,
      pairedAt: "2026-09-01T00:00:00Z",
      status: "online",
      hasActiveCredential: true,
    };
    vi.mocked(api.screens).mockResolvedValue(
      widen<Awaited<ReturnType<typeof api.screens>>>({
        items: [
          {
            ...screenBase,
            id: "e1",
            name: "Edge Lobby",
            platform: "linux",
            playerFamily: "edge",
            playerArchitecture: "x86_64",
          },
          {
            ...screenBase,
            id: "l1",
            name: "Electron Lobby",
            platform: "linux",
          },
        ],
        total: 2,
      }),
    );
    renderPanel("/settings/player/updates?platform=edge");
    expect(
      await screen.findByText("Available Tilecast Edge releases"),
    ).toBeTruthy();
    expect(await screen.findByText("0.2.0")).toBeTruthy();
    expect(screen.getByText("x86_64")).toBeTruthy();
    expect(screen.queryByText("0.9.0")).toBeNull();
    expect(await screen.findByText("Edge Lobby")).toBeTruthy();
    expect(screen.queryByText("Electron Lobby")).toBeNull();

    await userEvent.click(screen.getByRole("tab", { name: "Linux" }));
    expect(await screen.findByText("0.9.0")).toBeTruthy();
    expect(screen.queryByText("0.2.0")).toBeNull();
    expect(await screen.findByText("Electron Lobby")).toBeTruthy();
    expect(screen.queryByText("Edge Lobby")).toBeNull();
  });
});
