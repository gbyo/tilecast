// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UpdateDeploymentDrawer } from "./UpdateDeploymentDrawer";
import { api } from "../api/client";
import type { Screen, UpdateDeploymentDetail } from "../api/types";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ status: { csrfToken: "csrf", user: { role: "owner" } } }),
}));

const detail: UpdateDeploymentDetail = {
  id: "d1",
  name: "Tilecast Player 1.4.0",
  mode: "install_now",
  status: "active",
  createdAt: "2026-07-30T11:00:00Z",
  platform: "android",
  versionCode: 42,
  versionName: "1.4.0",
  artifactSizeBytes: 40 * 1024 * 1024,
  rolloutMode: "canary",
  rolloutPhase: "canary",
  canarySize: 2,
  screens: [
    {
      screenId: "s1",
      screenName: "Atrium",
      previousVersionCode: 41,
      expectedVersionCode: 42,
      downloadedBytes: 40 * 1024 * 1024,
      state: "succeeded",
      updatedAt: "2026-07-30T11:30:00Z",
      isCanary: true,
    },
    {
      screenId: "s2",
      screenName: "Cafeteria",
      previousVersionCode: 41,
      expectedVersionCode: 42,
      downloadedBytes: 20 * 1024 * 1024,
      state: "downloading",
      updatedAt: "2026-07-30T11:40:00Z",
      isCanary: false,
    },
    {
      screenId: "s3",
      screenName: "Gym",
      previousVersionCode: 41,
      expectedVersionCode: 42,
      downloadedBytes: 0,
      state: "failed",
      safeError: "Not enough storage on the device.",
      updatedAt: "2026-07-30T11:45:00Z",
      isCanary: false,
    },
  ],
};

const fleet = [
  { id: "s3", name: "Gym", status: "offline" } as Screen,
] as Screen[];

function renderDrawer(manageable = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <UpdateDeploymentDrawer
        deploymentId="d1"
        screens={fleet}
        manageable={manageable}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe("Update deployment drawer", () => {
  beforeEach(() => {
    vi.spyOn(api, "updateDeployment").mockResolvedValue(detail);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("states each screen's status in words, not only colour", async () => {
    renderDrawer();
    expect(await screen.findByText("Atrium")).toBeTruthy();
    const statuses = document.querySelectorAll(".deployment-screen__status");
    const labels = Array.from(statuses).map(
      (node) => node.textContent?.match(/Failed|Downloading|Updated/)?.[0],
    );
    expect(labels).toEqual(["Failed", "Downloading", "Updated"]);
    // The player's own error explains the failure rather than a generic line.
    expect(screen.getByText("Not enough storage on the device.")).toBeTruthy();
  });

  it("shows real download progress and no invented percentage elsewhere", async () => {
    renderDrawer();
    expect(await screen.findByText(/50% of 40.0 MB/)).toBeTruthy();
    expect(document.querySelectorAll("progress")).toHaveLength(1);
  });

  it("puts the actionable screen first and can filter to it", async () => {
    renderDrawer();
    await screen.findByText("Atrium");
    const names = Array.from(
      document.querySelectorAll(".deployment-screen__identity strong"),
    ).map((node) => node.textContent);
    expect(names).toEqual(["Gym", "Cafeteria", "Atrium"]);
    await userEvent.click(
      screen.getByRole("button", { name: /Needs attention/ }),
    );
    expect(
      Array.from(
        document.querySelectorAll(".deployment-screen__identity strong"),
      ).map((node) => node.textContent),
    ).toEqual(["Gym"]);
  });

  it("offers a retry only for the failed screen", async () => {
    renderDrawer();
    await screen.findByText("Atrium");
    expect(screen.getAllByRole("button", { name: /Retry/ })).toHaveLength(1);
    vi.spyOn(api, "retryUpdateScreen").mockResolvedValue({ state: "pending" });
    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));
    await waitFor(() =>
      expect(api.retryUpdateScreen).toHaveBeenCalledWith("d1", "s3", "csrf"),
    );
  });

  it("keeps cancelling to accounts that may deploy", async () => {
    renderDrawer(false);
    await screen.findByText("Atrium");
    expect(
      screen.queryByRole("button", { name: /Cancel deployment/ }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it("carries fleet reachability into the row so an offline screen is explained", async () => {
    renderDrawer();
    await screen.findByText("Atrium");
    expect(screen.getByText(/41 → 42 · Offline/)).toBeTruthy();
  });
});
