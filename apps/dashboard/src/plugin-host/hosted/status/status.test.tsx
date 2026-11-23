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
  subscriptions: [],
  publishedEvents: [],
  webhooks: [],
  providers: { channels: [], checks: [] },
};

function stub(body: PluginStatus = status) {
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
            ? body
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
  it("exists for plugins with timers or events", () => {
    expect(hasStatusPage(manifest)).toBe(true);
    expect(hasStatusPage({ ...manifest, services: [] })).toBe(false);
    expect(hasStatusPage({ ...manifest, services: ["events.publish@1"] })).toBe(
      true,
    );
    expect(
      hasStatusPage({
        ...manifest,
        services: [],
        events: { subscribes: ["takeover.started@1"] },
      }),
    ).toBe(true);
    expect(
      hasStatusPage({
        ...manifest,
        services: [],
        events: { subscribes: [], publishes: [] },
      }),
    ).toBe(false);
  });

  it("explains inactive subscriptions and a changed event schema", async () => {
    stub({
      ...status,
      deliveries: {
        ...status.deliveries,
        parked: [],
        parkedCount: 0,
        expiredCount: 0,
      },
      subscriptions: [
        {
          event: "takeover.started@1",
          state: "active",
          publisher: "core",
        },
        {
          event: "plugin.bell_schedule.period_started@1",
          state: "inactive",
          reason: "publisher_not_installed",
          publisher: "bell_schedule",
          publisherName: "Bell Schedule",
        },
        {
          event: "plugin.gone.thing@1",
          state: "inactive",
          reason: "publisher_unknown",
          publisher: "gone",
        },
      ],
      publishedEvents: [
        {
          event: "plugin.room_sign.meeting_started@1",
          title: "Meeting started",
          subscribers: 2,
          schemaChanged: false,
        },
        {
          event: "plugin.room_sign.room_free@1",
          title: "Room free",
          subscribers: 0,
          schemaChanged: true,
        },
      ],
    });
    renderPluginRoute(
      <HostedStatusPage pluginId="room_sign" manifest={manifest} />,
      { path: "/plugins/room-sign/status", role: "administrator" },
    );
    expect(
      await screen.findByText("Events this plugin receives"),
    ).toBeInTheDocument();
    expect(screen.getByText("A Takeover starts")).toBeInTheDocument();
    expect(screen.getAllByText("Inactive")).toHaveLength(2);
    expect(
      screen.getByText(
        "Bell Schedule (bell_schedule) is not installed. Install it to receive this event.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The plugin that publishes this event is not part of this Tilecast release.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Published by Tilecast/)).toBeInTheDocument();
    expect(
      screen.getByText("Events this plugin publishes"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/2 installed plugins receive it/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No installed plugin receives it/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Not published: the payload changed"),
    ).toBeInTheDocument();
  });

  it("shows whether each webhook can work and links to the Webhooks page", async () => {
    stub({
      ...status,
      webhooks: [
        {
          id: "changes",
          title: "Plan changes",
          authentication: "signature",
          scheme: "hmac-sha256",
          ackStatus: 200,
          reachability: "public_https_required",
          requiresPublicHttps: true,
          signingSecret: "needs_value",
          acceptedCount: 0,
          duplicateCount: 0,
          pending: 0,
          lastRefusal: "signing_secret_unavailable",
        },
      ],
    });
    renderPluginRoute(
      <HostedStatusPage
        pluginId="room_sign"
        manifest={
          {
            ...manifest,
            webhooks: [
              { id: "changes", title: "Changes", authentication: "signature" },
            ],
          } as unknown as PluginManifestV3
        }
      />,
      { path: "/plugins/room-sign/status", role: "administrator" },
    );
    expect(await screen.findByText("Plan changes")).toBeInTheDocument();
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.getByText("Needs a new value")).toBeInTheDocument();
    expect(
      screen.getByText(/last refused: the signing secret is not set/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Webhooks" })).toHaveAttribute(
      "href",
      "/plugins/room-sign/webhooks",
    );
  });

  it("shows provider health for channels and checks", async () => {
    stub({
      ...status,
      providers: {
        channels: [
          {
            id: "push",
            title: "ntfy",
            ready: false,
            sent: 4,
            pending: 0,
            failed: 1,
          },
        ],
        checks: [
          {
            id: "lint",
            title: "Readability",
            kinds: ["playlist", "layout"],
            checkedItems: 12,
            failingItems: 2,
            openConditions: 3,
            lastFailure: "check_timeout",
          },
        ],
      },
    });
    renderPluginRoute(
      <HostedStatusPage pluginId="room_sign" manifest={manifest} />,
      { path: "/plugins/room-sign/status", role: "administrator" },
    );
    expect(
      await screen.findByText("Services this plugin provides"),
    ).toBeInTheDocument();
    expect(screen.getByText("Off")).toBeInTheDocument();
    expect(screen.getByText("4 sent, 0 waiting, 1 failed")).toBeInTheDocument();
    expect(screen.getByText("3 open conditions")).toBeInTheDocument();
    expect(
      screen.getByText("12 items checked: playlists, Layouts"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "2 items could not be checked: the check took longer than 10 seconds. Their earlier conditions stay open.",
      ),
    ).toBeInTheDocument();
  });

  it("shows no event sections without events", async () => {
    stub();
    renderPluginRoute(
      <HostedStatusPage pluginId="room_sign" manifest={manifest} />,
      { path: "/plugins/room-sign/status", role: "administrator" },
    );
    expect(await screen.findByText("Plugin work")).toBeInTheDocument();
    expect(screen.queryByText("Events this plugin receives")).toBeNull();
    expect(screen.queryByText("Events this plugin publishes")).toBeNull();
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
