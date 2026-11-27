// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import type { PluginManifestV3 } from "@tilecast/plugin-sdk/manifest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPluginRoute } from "../testing";
import { HostedInstanceEditor } from "./HostedInstanceEditor";
import { HostedSettingsPage } from "./HostedSettingsPage";
import type { PluginSecretStatus } from "../../api/types";
import { hostedSettingsKey } from "./api";
import { SecretKeyNotice } from "./SecretKeyNotice";

const manifest = {
  apiVersion: 3,
  id: "room_sign",
  name: "Room Sign",
  api: { basePaths: ["/plugins/room-sign"] },
  studio: { route: "/plugins/room-sign" },
  settings: {
    organization: [
      {
        key: "apiToken",
        label: "API token",
        control: "secret",
        required: true,
        maxLength: 200,
      },
      {
        key: "refreshMinutes",
        label: "Refresh",
        control: "integer",
        default: 5,
        minimum: 1,
        maximum: 60,
      },
    ],
    screen: [],
  },
  instances: [
    {
      kind: "sign",
      noun: { singular: "sign", plural: "signs" },
      path: "signs",
      operations: { singular: "Sign", plural: "Signs" },
      targeting: "none",
      schedule: "none",
      fields: [
        { key: "title", label: "Title", control: "text", required: true },
        {
          key: "accessKey",
          label: "Access key",
          control: "secret",
          required: true,
        },
      ],
    },
  ],
} as unknown as PluginManifestV3;

const status = (
  overrides: Partial<PluginSecretStatus> = {},
): PluginSecretStatus => ({
  currentKekId: "kek-1",
  kekIds: ["kek-1"],
  exportAcknowledged: false,
  secrets: 2,
  pendingMigration: 0,
  unreadable: 0,
  ...overrides,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

function stub(answers: Record<string, unknown>, settingsConflict = false) {
  const recorded: Recorded[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      // The typed transport passes a Request; the plugin client passes init.
      const request = input instanceof Request ? input : null;
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const method = init?.method ?? request?.method ?? "GET";
      if (method !== "GET") {
        const text =
          typeof init?.body === "string"
            ? init.body
            : request
              ? await request.clone().text()
              : "";
        recorded.push({
          method,
          path: new URL(path, "http://localhost").pathname,
          body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
        });
      }
      const key = Object.keys(answers).find((candidate) =>
        path.endsWith(candidate),
      );
      if (settingsConflict && method === "PUT") {
        return new Response(
          JSON.stringify({
            error: {
              code: "plugin_settings_revision_conflict",
              message: "Newer settings exist.",
            },
          }),
          { status: 409 },
        );
      }
      return new Response(
        JSON.stringify({ data: key ? answers[key] : { items: [], total: 0 } }),
      );
    }),
  );
  return recorded;
}

describe("plugin secret key notice", () => {
  it("warns an Owner until the export is confirmed, then returns after the set changes", async () => {
    const recorded = stub({
      "/system/plugin-secrets/export-confirmations": status({
        exportAcknowledged: true,
      }),
      "/system/plugin-secrets": status(),
    });
    renderPluginRoute(<SecretKeyNotice />, { path: "/", role: "owner" });
    expect(
      await screen.findByText("Export your plugin secret keys"),
    ).toBeVisible();
    expect(
      screen.getByText(/tilecast-server secrets export-kek/),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "I exported and stored the keys" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByText("Export your plugin secret keys"),
      ).not.toBeInTheDocument(),
    );
    expect(recorded.map((call) => call.path)).toEqual([
      "/api/v1/system/plugin-secrets/export-confirmations",
    ]);
  });

  it("stays quiet for an account that cannot export keys, and when no secret is stored", async () => {
    stub({ "/system/plugin-secrets": status() });
    const view = renderPluginRoute(<SecretKeyNotice />, {
      path: "/",
      role: "viewer",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      screen.queryByText("Export your plugin secret keys"),
    ).not.toBeInTheDocument();
    view.unmount();
    stub({ "/system/plugin-secrets": status({ secrets: 0 }) });
    renderPluginRoute(<SecretKeyNotice />, { path: "/", role: "owner" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      screen.queryByText("Export your plugin secret keys"),
    ).not.toBeInTheDocument();
  });

  it("says when stored secrets cannot be read on this server", async () => {
    stub({
      "/system/plugin-secrets": status({
        exportAcknowledged: true,
        unreadable: 3,
      }),
    });
    renderPluginRoute(<SecretKeyNotice />, { path: "/", role: "owner" });
    expect(
      await screen.findByText("Some plugin secrets need a new value"),
    ).toBeVisible();
    expect(screen.getByText(/3 stored secret/)).toBeVisible();
  });
});

describe("secret fields", () => {
  it("keeps a draft and its revision through a refetch until the editor reloads", async () => {
    const path = "/plugins/room-sign/settings/organization";
    const answers = {
      [path]: {
        scope: "organization",
        values: { refreshMinutes: 5 },
        secrets: { apiToken: "set" },
        revision: 2,
      },
    };
    const recorded = stub(answers, true);
    const { queryClient } = renderPluginRoute(
      <HostedSettingsPage pluginId="room_sign" manifest={manifest} />,
      { path: "/plugins/room-sign/settings", role: "owner" },
    );
    const token = await screen.findByLabelText("API token");
    const refresh = screen.getByLabelText(/Refresh/);
    fireEvent.change(token, { target: { value: "draft-token" } });
    fireEvent.change(refresh, { target: { value: "10" } });
    answers[path] = {
      ...answers[path],
      values: { refreshMinutes: 30 },
      revision: 3,
    };
    await act(() =>
      queryClient.invalidateQueries({
        queryKey: hostedSettingsKey("room_sign"),
      }),
    );
    expect(refresh).toHaveValue(10);
    expect(token).toHaveValue("draft-token");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const reload = await screen.findByRole("button", {
      name: "Reload the latest version",
    });
    expect(recorded[0]?.body).toMatchObject({
      values: { refreshMinutes: 10 },
      secrets: { apiToken: "draft-token" },
      expectedRevision: 2,
    });
    fireEvent.click(reload);
    await waitFor(() =>
      expect(screen.getByLabelText(/Refresh/)).toHaveValue(30),
    );
    expect(screen.getByLabelText("API token")).toHaveValue("");
  });

  it("shows only whether a settings secret is set, and sends a new value or a clear", async () => {
    const recorded = stub({
      "/plugins/room-sign/settings/organization": {
        scope: "organization",
        values: { refreshMinutes: 5 },
        secrets: { apiToken: "set" },
        revision: 2,
      },
    });
    renderPluginRoute(
      <HostedSettingsPage pluginId="room_sign" manifest={manifest} />,
      {
        path: "/plugins/room-sign/settings",
        role: "owner",
      },
    );
    expect(await screen.findByText("Set")).toBeVisible();
    // The value is never in the page: the field is empty and a password input.
    const token = screen.getByLabelText("API token");
    expect(token).toHaveValue("");
    expect(token).toHaveAttribute("type", "password");
    fireEvent.change(token, { target: { value: "new-secret" } });
    fireEvent.change(screen.getByLabelText(/Refresh/), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(recorded).toHaveLength(1));
    expect(recorded[0]?.method).toBe("PUT");
    expect(recorded[0]?.body).toMatchObject({
      values: { refreshMinutes: 10 },
      secrets: { apiToken: "new-secret" },
      expectedRevision: 2,
    });
    expect(recorded[0]?.body).not.toHaveProperty("clearSecrets");
  });

  it("marks a secret the server cannot decrypt and refuses a save that leaves a required one empty", async () => {
    const recorded = stub({
      "/plugins/room-sign/signs/sign-1": {
        id: "sign-1",
        kind: "sign",
        name: "Lobby",
        enabled: true,
        revision: 1,
        title: "Welcome",
        secrets: { accessKey: "needs_value" },
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-01T00:00:00Z",
      },
    });
    renderPluginRoute(
      <HostedInstanceEditor pluginId="room_sign" manifest={manifest} />,
      {
        path: "/plugins/room-sign/sign-1",
        role: "owner",
        patterns: ["/plugins/room-sign/new", "/plugins/room-sign/:id"],
      },
    );
    expect(await screen.findByText("Needs a new value")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByLabelText("Name")).toHaveValue("Lobby"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Access key is required.")).toBeVisible();
    expect(recorded).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Access key"), {
      target: { value: "k-2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(recorded).toHaveLength(1));
    expect(recorded[0]?.body).toMatchObject({
      secrets: { accessKey: "k-2" },
      expectedRevision: 1,
      title: "Welcome",
    });
    expect(JSON.stringify(recorded[0]?.body)).not.toContain("needs_value");
  }, 15_000);
});
