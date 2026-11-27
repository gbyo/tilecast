// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PluginManifestV3 } from "@tilecast/plugin-sdk/manifest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPluginRoute } from "../../testing";
import type { PluginWebhookState } from "./api";
import { HostedWebhooksPage } from "./HostedWebhooksPage";
import { hasWebhooksPage } from "./model";

const manifest = {
  apiVersion: 3,
  id: "planning_center",
  name: "Planning Center",
  studio: { route: "/plugins/planning-center" },
  services: [],
  instances: [],
  webhooks: [{ id: "changes", title: "Changes", authentication: "signature" }],
} as unknown as PluginManifestV3;

const signature: PluginWebhookState = {
  id: "changes",
  title: "Plan changes",
  authentication: "signature",
  scheme: "hmac-sha256",
  ackStatus: 200,
  endpointUrl: "https://signage.example/api/v1/hooks/planning_center/changes",
  reachability: "available",
  requiresPublicHttps: true,
  signingSecret: "not_set",
  signingSecretKey: "webhookSecret",
  acceptedCount: 3,
  duplicateCount: 1,
  pending: 0,
  lastAcceptedAt: "2026-11-23T09:00:00Z",
  lastRefusedAt: "2026-11-23T09:05:00Z",
  lastRefusal: "signature_invalid",
};

const token: PluginWebhookState = {
  id: "doors",
  title: "Doors",
  authentication: "token",
  ackStatus: 202,
  endpointUrl: "http://signage.lan/api/v1/hooks/planning_center/doors",
  reachability: "local_network",
  requiresPublicHttps: false,
  acceptedCount: 0,
  duplicateCount: 0,
  pending: 0,
  tokens: [
    {
      id: "8d1c1f0e-1c2b-4a5d-9e8f-7a6b5c4d3e2f",
      name: "Fire panel",
      publicId: "0123456789abcdef01234567",
      createdAt: "2026-11-20T09:00:00Z",
    },
  ],
};

function stub(list: PluginWebhookState[]) {
  const sent: { method: string; path: string; body?: string }[] = [];
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
      if (method !== "GET")
        sent.push({ method, path, body: init?.body as string | undefined });
      const data =
        method === "POST"
          ? {
              ...token.tokens![0],
              id: "9e2d2f1f-2d3c-4b6e-8f90-8b7c6d5e4f30",
              name: "Door controller",
              token: "tch_aaaaaaaaaaaaaaaaaaaaaaaa.only-once-secret",
            }
          : method === "DELETE"
            ? { ...token.tokens![0], revokedAt: "2026-11-23T10:00:00Z" }
            : path.endsWith("/webhooks")
              ? list
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

describe("webhooks page", () => {
  it("exists only for plugins that declare webhooks", () => {
    expect(hasWebhooksPage(manifest)).toBe(true);
    expect(hasWebhooksPage({ ...manifest, webhooks: [] })).toBe(false);
  });

  it("shows the exact endpoint, the missing secret, and the last refusal", async () => {
    stub([signature]);
    renderPluginRoute(
      <HostedWebhooksPage pluginId="planning_center" manifest={manifest} />,
      { path: "/plugins/planning-center/webhooks", role: "viewer" },
    );
    const card = await screen.findByRole("region", { name: /Plan changes/ });
    expect(
      within(card).getByRole("textbox", { name: "Endpoint address" }),
    ).toHaveValue(
      "https://signage.example/api/v1/hooks/planning_center/changes",
    );
    expect(within(card).getByText("Signed")).toBeInTheDocument();
    expect(within(card).getByText("HMAC-SHA256 signature")).toBeInTheDocument();
    expect(
      within(card).getByText("HTTP 200 after the request is stored"),
    ).toBeInTheDocument();
    expect(within(card).getByText("Not set")).toBeInTheDocument();
    expect(
      within(card).getByRole("link", { name: "Enter it in Settings" }),
    ).toHaveAttribute("href", "/plugins/planning-center/settings");
    expect(
      within(card).getByText(/Last refused: the signature did not match/),
    ).toBeInTheDocument();
    expect(
      within(card).getByText("1 repeated request ignored."),
    ).toBeInTheDocument();
  });

  it("explains a SaaS webhook without public HTTPS", async () => {
    stub([{ ...signature, reachability: "public_https_required" }]);
    renderPluginRoute(
      <HostedWebhooksPage pluginId="planning_center" manifest={manifest} />,
      { path: "/plugins/planning-center/webhooks", role: "viewer" },
    );
    expect(
      await screen.findByText(/needs a public HTTPS address/),
    ).toHaveTextContent("This webhook needs a public HTTPS address.");
  });

  it("shows a new token once and revokes after confirmation", async () => {
    const sent = stub([token]);
    const user = userEvent.setup();
    renderPluginRoute(
      <HostedWebhooksPage pluginId="planning_center" manifest={manifest} />,
      { path: "/plugins/planning-center/webhooks", role: "owner" },
    );
    const card = await screen.findByRole("region", { name: /Doors/ });
    expect(
      within(card).getByText("tch_0123456789abcdef01234567"),
    ).toBeInTheDocument();
    await user.type(
      within(card).getByLabelText("Token name"),
      "Door controller",
    );
    await user.click(
      within(card).getByRole("button", { name: "Create token" }),
    );
    const shown = await within(card).findByRole("textbox", {
      name: "New token",
    });
    expect(shown).toHaveValue("tch_aaaaaaaaaaaaaaaaaaaaaaaa.only-once-secret");
    expect(sent[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/plugins/planning_center/webhooks/doors/tokens",
      body: JSON.stringify({ name: "Door controller" }),
    });
    await user.click(within(card).getByRole("button", { name: "I copied it" }));
    expect(
      within(card).queryByRole("textbox", { name: "New token" }),
    ).toBeNull();

    await user.click(within(card).getByRole("button", { name: "Revoke" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Revoke",
      }),
    );
    await waitFor(() =>
      expect(sent[1]).toMatchObject({
        method: "DELETE",
        path: "/api/v1/plugins/planning_center/webhooks/doors/tokens/8d1c1f0e-1c2b-4a5d-9e8f-7a6b5c4d3e2f",
      }),
    );
  });

  it("does not offer token management to a viewer", async () => {
    stub([token]);
    renderPluginRoute(
      <HostedWebhooksPage pluginId="planning_center" manifest={manifest} />,
      { path: "/plugins/planning-center/webhooks", role: "viewer" },
    );
    const card = await screen.findByRole("region", { name: /Doors/ });
    expect(
      within(card).queryByRole("button", { name: "Create token" }),
    ).toBeNull();
    expect(within(card).queryByRole("button", { name: "Revoke" })).toBeNull();
    expect(
      within(card).getByText(
        "Only accounts that manage plugins can create or revoke tokens.",
      ),
    ).toBeInTheDocument();
  });
});
