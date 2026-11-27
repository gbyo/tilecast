// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PluginManifestV3 } from "@tilecast/plugin-sdk/manifest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPluginRoute } from "../../testing";
import type { PluginStatus } from "./api";
import { HostedStatusPage } from "./HostedStatusPage";
import { hasStatusPage } from "./model";

const manifest = {
  apiVersion: 3,
  id: "room_sign",
  name: "Room Sign",
  studio: { route: "/plugins/room-sign" },
  services: ["timers.schedule@1"],
  instances: [],
} as unknown as PluginManifestV3;

const status: PluginStatus = {
  pluginId: "room_sign",
  installed: true,
  deliveries: {
    pending: 3,
    running: 1,
    parkedCount: 1,
    parked: [
      {
        id: "7f8e1c4a-6a59-4b6f-9d0a-1f2e3d4c5b6a",
        kind: "timer",
        source: "sync:room-1",
        subject: "sync:room-1",
        attempts: 8,
        lastError: "handler_timeout",
        dueAt: "2026-11-23T09:00:00Z",
        parkedAt: "2026-11-23T09:30:00Z",
        expiresAt: "2026-12-07T09:30:00Z",
      },
    ],
    expiredCount: 2,
    lastExpiredAt: "2026-11-22T09:00:00Z",
    lastFailure: {
      code: "handler_timeout",
      kind: "timer",
      at: "2026-11-23T09:30:00Z",
    },
  },
};

function stub() {
  const sent: { method: string; path: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const method = init?.method ?? "GET";
      if (method !== "GET") sent.push({ method, path });
      const data =
        method !== "GET"
          ? status.deliveries.parked[0]
          : path.endsWith("/status")
            ? status
            : { items: [] };
      return Promise.resolve(new Response(JSON.stringify({ data })));
    }),
  );
  return sent;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("status page", () => {
  it("exists only for plugins with queued work", () => {
    expect(hasStatusPage(manifest)).toBe(true);
    expect(hasStatusPage({ ...manifest, services: [] })).toBe(false);
  });

  it("explains parked and expired work and lets an Owner retry and discard", async () => {
    const sent = stub();
    renderPluginRoute(
      <HostedStatusPage pluginId="room_sign" manifest={manifest} />,
      { path: "/plugins/room-sign/status", role: "owner" },
    );
    expect(await screen.findByText("1 needs attention")).toBeInTheDocument();
    expect(screen.getByText("3 waiting · 1 running")).toBeInTheDocument();
    expect(screen.getByText("2 items expired")).toBeInTheDocument();
    expect(screen.getByText("Timer: sync:room-1")).toBeInTheDocument();
    expect(
      screen.getAllByText(/The plugin did not finish within 30 seconds/),
    ).toHaveLength(2);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "POST",
        path: "/api/v1/plugins/room_sign/deliveries/7f8e1c4a-6a59-4b6f-9d0a-1f2e3d4c5b6a/retry",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Discard" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Discard" }));
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "DELETE",
        path: "/api/v1/plugins/room_sign/deliveries/7f8e1c4a-6a59-4b6f-9d0a-1f2e3d4c5b6a",
      }),
    );
  });

  it("shows parked work without actions to an Administrator", async () => {
    stub();
    renderPluginRoute(
      <HostedStatusPage pluginId="room_sign" manifest={manifest} />,
      { path: "/plugins/room-sign/status", role: "administrator" },
    );
    expect(await screen.findByText("Timer: sync:room-1")).toBeInTheDocument();
    expect(
      screen.getByText("Only an Owner can retry or discard these items."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
