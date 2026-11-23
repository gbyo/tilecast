// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PluginManifestV3 } from "@tilecast/plugin-sdk/manifest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n, renderPluginRoute } from "../../testing";
import type { PluginConnection } from "./api";
import { connectionReviewLines } from "../../../plugins/detail/ConnectionReviewSection";
import { HostedConnectionEditor } from "./HostedConnectionEditor";
import {
  acceptedConnections,
  consentEnabled,
  formatBytes,
  grantedConsents,
  toggleConsent,
  withValue,
} from "./model";

const manifest = {
  apiVersion: 3,
  id: "local_gateway",
  studio: { route: "/plugins/local-gateway" },
  api: { basePaths: ["/plugins/local-gateway"] },
  instances: [],
  connections: [
    {
      id: "cloud",
      title: "Cloud API",
      type: "http",
      origins: ["https://api.example.com"],
    },
    {
      id: "gateway",
      title: "Meter gateway",
      type: "http",
      origins: "operator",
      privateNetwork: "allowed",
      plainHttp: "allowed",
      allowPlaintextSecret: true,
    },
    {
      id: "strict",
      title: "Strict gateway",
      type: "http",
      origins: "operator",
      privateNetwork: "allowed",
      plainHttp: "allowed",
    },
  ],
} as unknown as PluginManifestV3;

const consent = (available: boolean, given = false) => ({ available, given });

function connection(
  overrides: Partial<PluginConnection> = {},
): PluginConnection {
  return {
    id: "c1",
    plugin: "local_gateway",
    definition: "gateway",
    name: "Gateway",
    origin: "http://gateway.lan:8080",
    origins: ["http://gateway.lan:8080"],
    consents: {
      privateNetwork: consent(true),
      plainHttp: consent(true),
      plaintextSecret: consent(true),
    },
    status: "private_network_consent_required",
    reasons: [
      "private_network_consent_required",
      "plain_http_consent_required",
    ],
    notices: [],
    references: [],
    revision: 3,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    ...overrides,
  };
}

interface Sent {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

function stubConnectionApi(record: PluginConnection) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const reply = (data: unknown) =>
        Promise.resolve(new Response(JSON.stringify({ data })));
      if (init?.method && init.method !== "GET") {
        const body = JSON.parse(
          typeof init.body === "string" ? init.body : "{}",
        ) as Record<string, unknown>;
        sent.push({ method: init.method, path, body });
        return reply({ ...record, revision: record.revision + 1 });
      }
      if (path.includes("/connections/")) return reply(record);
      if (path.endsWith("/connections"))
        return reply({ items: [record], total: 1 });
      if (path.includes("/plugins")) return reply({ items: [] });
      return reply({});
    }),
  );
  return sent;
}

function editor(role = "owner") {
  return renderPluginRoute(
    <HostedConnectionEditor pluginId="local_gateway" manifest={manifest} />,
    {
      path: "/plugins/local-gateway/connections/c1",
      role,
      patterns: ["/plugins/local-gateway/connections/:connectionId"],
    },
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("connection consent rules", () => {
  it("keeps the layers consistent", () => {
    const none = {
      privateNetwork: false,
      plainHttp: false,
      plaintextSecret: false,
    };
    expect(consentEnabled(none, "plainHttp")).toBe(false);
    expect(consentEnabled(none, "plaintextSecret")).toBe(false);
    const all = toggleConsent(
      toggleConsent(
        toggleConsent(none, "privateNetwork", true),
        "plainHttp",
        true,
      ),
      "plaintextSecret",
      true,
    );
    expect(all).toEqual({
      privateNetwork: true,
      plainHttp: true,
      plaintextSecret: true,
    });
    // Removing a lower layer removes what depends on it; nothing turns on
    // a lower layer by itself.
    expect(toggleConsent(all, "privateNetwork", false)).toEqual(none);
    expect(toggleConsent(none, "plaintextSecret", true).privateNetwork).toBe(
      false,
    );
    expect(grantedConsents(none, all)).toEqual([
      "privateNetwork",
      "plainHttp",
      "plaintextSecret",
    ]);
    expect(grantedConsents(all, none)).toEqual([]);
  });

  it("offers only connections of an accepted declaration", () => {
    const list = [connection(), connection({ id: "c2", definition: "cloud" })];
    expect(acceptedConnections(list, ["cloud"]).map((item) => item.id)).toEqual(
      ["c2"],
    );
    expect(acceptedConnections(list, undefined)).toEqual([]);
  });

  it("sets or removes one value and formats sizes", () => {
    expect(withValue({ a: 1 }, "b", "x")).toEqual({ a: 1, b: "x" });
    expect(withValue({ a: 1, b: "x" }, "b", undefined)).toEqual({ a: 1 });
    expect(formatBytes(16 << 20)).toBe("16 MiB");
    expect(formatBytes(1536)).toBe("2 KiB");
  });

  it("separates review security facts from limits", () => {
    const t = i18n.getFixedT("en", "plugins");
    const lines = connectionReviewLines(
      {
        id: "gateway",
        title: "Gateway",
        type: "http",
        operatorOrigin: true,
        origins: [],
        privateNetwork: true,
        plainHttp: true,
        plaintextSecret: true,
        maxResponseBytes: 16 << 20,
        timeoutSeconds: 60,
      },
      t,
    );
    expect(lines.security).toEqual([
      "Sends requests to an origin you choose",
      "Can reach your private network after you allow it",
      "Can use unencrypted HTTP on your local network after you allow it",
      "Can send a secret over unencrypted HTTP after you allow it",
    ]);
    expect(lines.limits).toEqual([
      "Accepts responses up to 16 MiB",
      "Waits up to 60 seconds for a response",
    ]);
    const plain = connectionReviewLines(
      {
        id: "cloud",
        title: "Cloud",
        type: "http",
        operatorOrigin: false,
        origins: ["https://api.example.com"],
        privateNetwork: false,
        plainHttp: false,
        plaintextSecret: false,
        maxResponseBytes: 1 << 20,
        timeoutSeconds: 10,
      },
      t,
    );
    expect(plain).toEqual({
      security: ["Sends requests to https://api.example.com"],
      limits: [],
    });
  });
});

describe("connection page", () => {
  it("shows three separate consents and saves them only through their own request", async () => {
    const sent = stubConnectionApi(connection());
    editor();
    const privateNetwork = await screen.findByRole("checkbox", {
      name: "Allow private network addresses",
    });
    const plainHttp = screen.getByRole("checkbox", {
      name: "Allow plain HTTP",
    });
    const plaintext = screen.getByRole("checkbox", {
      name: "Allow secrets over plain HTTP",
    });
    expect(plainHttp).toHaveAttribute("data-disabled");
    expect(plaintext).toHaveAttribute("data-disabled");

    // Saving the name never carries a consent.
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Gateway A" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.path).toMatch(/\/connections\/c1$/);
    expect(sent[0]!.body).toEqual({
      definition: "gateway",
      name: "Gateway A",
      origin: "http://gateway.lan:8080",
      expectedRevision: 3,
    });

    const user = userEvent.setup();
    await user.click(privateNetwork);
    await user.click(
      screen.getByRole("checkbox", { name: "Allow plain HTTP" }),
    );
    expect(
      screen.getByRole("checkbox", { name: "Allow secrets over plain HTTP" }),
    ).not.toHaveAttribute("data-disabled");
    await user.click(screen.getByRole("button", { name: "Save permissions" }));
    // Giving a permission asks first and names what is given.
    expect(
      await screen.findByText(
        /Allow private network addresses; Allow plain HTTP/,
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Give permissions" }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]!.path).toMatch(/\/connections\/c1\/consents$/);
    // The name save answered revision 4; the consents name it.
    expect(sent[1]!.body).toEqual({
      privateNetwork: true,
      plainHttp: true,
      plaintextSecret: false,
      expectedRevision: 4,
    });
  });

  it("shows no plaintext secret control when the declaration does not allow it", async () => {
    stubConnectionApi(
      connection({
        definition: "strict",
        consents: {
          privateNetwork: consent(true),
          plainHttp: consent(true),
          plaintextSecret: consent(false),
        },
      }),
    );
    editor();
    expect(
      await screen.findByRole("checkbox", { name: "Allow plain HTTP" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: "Allow secrets over plain HTTP" }),
    ).toBeNull();
  });

  it("shows a fixed HTTPS connection's origins and offers no consent", async () => {
    stubConnectionApi(
      connection({
        definition: "cloud",
        origin: undefined,
        origins: ["https://api.example.com"],
        status: "ready",
        reasons: [],
        consents: {
          privateNetwork: consent(false),
          plainHttp: consent(false),
          plaintextSecret: consent(false),
        },
      }),
    );
    editor();
    expect(
      await screen.findByText("This connection needs no network permission."),
    ).toBeInTheDocument();
    expect(screen.getByText("https://api.example.com")).toBeInTheDocument();
    expect(screen.queryByLabelText("Origin")).toBeNull();
  });

  it("lets a viewer read without changing anything", async () => {
    stubConnectionApi(
      connection({
        references: [
          {
            ownerType: "instance",
            ownerId: "i1",
            fieldKey: "gateway",
            label: "Lobby meter",
          },
        ],
      }),
    );
    editor("viewer");
    expect(
      await screen.findByRole("checkbox", {
        name: "Allow private network addresses",
      }),
    ).toHaveAttribute("data-disabled");
    expect(
      screen.queryByRole("button", { name: "Save permissions" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Delete connection" }),
    ).toBeNull();
    expect(screen.getByText("Lobby meter")).toBeInTheDocument();
  });
});
