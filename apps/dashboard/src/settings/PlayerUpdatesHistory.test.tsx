// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
    await userEvent.click(screen.getByRole("button", { name: "Linux" }));
    expect(await screen.findByText("Available Linux releases")).toBeTruthy();
    expect(screen.getByTestId("search").textContent).toBe("?platform=linux");
    // Android is the default, so it leaves no parameter behind.
    await userEvent.click(screen.getByRole("button", { name: "Android" }));
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
});
