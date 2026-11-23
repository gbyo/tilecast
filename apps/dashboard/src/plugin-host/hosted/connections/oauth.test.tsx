// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PluginManifestV3 } from "@tilecast/plugin-sdk/manifest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n, renderPluginRoute } from "../../testing";
import { connectionReviewLines } from "../../../plugins/detail/ConnectionReviewSection";
import type { PluginConnection, PluginConnectionOAuth } from "./api";
import { HostedConnectionEditor } from "./HostedConnectionEditor";
import {
  oauthClientWrite,
  parseOAuthFragment,
  replacesConnectedClient,
} from "./model";

const manifest = {
  apiVersion: 3,
  id: "room_sign",
  studio: { route: "/plugins/room-sign" },
  api: { basePaths: ["/plugins/room-sign"] },
  instances: [],
  connections: [
    {
      id: "google",
      title: "Google Calendar",
      type: "oauth2",
      origins: ["https://www.googleapis.com"],
      oauth: {
        authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
        tokenEndpointAuthMethod: "client_secret_post",
      },
    },
  ],
} as unknown as PluginManifestV3;

const callbackUrl =
  "https://signs.example.org/api/v1/plugins/room_sign/connections/c1/callback";

function oauth(
  overrides: Partial<PluginConnectionOAuth> = {},
): PluginConnectionOAuth {
  return {
    status: "not_connected",
    clientId: "client-1",
    clientSecretRequired: true,
    clientSecret: "set",
    callbackUrl,
    connectAvailable: true,
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    ...overrides,
  };
}

function connection(
  overrides: Partial<PluginConnection> = {},
): PluginConnection {
  const none = { available: false, given: false };
  return {
    id: "c1",
    plugin: "room_sign",
    definition: "google",
    name: "Room calendars",
    origins: ["https://www.googleapis.com"],
    consents: { privateNetwork: none, plainHttp: none, plaintextSecret: none },
    status: "oauth_not_connected",
    reasons: ["oauth_not_connected"],
    notices: [],
    references: [],
    oauth: oauth(),
    revision: 2,
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

/** A fake API: GET answers the record; each write answers `replies[path]`. */
function stubApi(
  record: PluginConnection,
  replies: Record<string, () => Response> = {},
) {
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
        const suffix = Object.keys(replies).find((key) => path.endsWith(key));
        if (suffix) return Promise.resolve(replies[suffix]!());
        return reply({ ...record, revision: record.revision + 1 });
      }
      if (path.includes("/connections/")) return reply(record);
      if (path.endsWith("/connections"))
        return reply({ items: [record], total: 1 });
      return reply({ items: [] });
    }),
  );
  return sent;
}

function editor(path = "/plugins/room-sign/connections/c1", role = "owner") {
  return renderPluginRoute(
    <HostedConnectionEditor pluginId="room_sign" manifest={manifest} />,
    {
      path,
      role,
      patterns: ["/plugins/room-sign/connections/:connectionId"],
    },
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OAuth connection rules", () => {
  it("reads the provider answer only from the callback fragment", () => {
    const encoded = encodeURIComponent(
      new URLSearchParams({ state: "s1", code: "c 1" }).toString(),
    );
    expect(parseOAuthFragment(`#oauth=${encoded}`)).toEqual({
      state: "s1",
      code: "c 1",
    });
    expect(
      parseOAuthFragment(
        `#oauth=${encodeURIComponent("state=s2&error=access_denied")}`,
      ),
    ).toEqual({ state: "s2", error: "access_denied" });
    expect(parseOAuthFragment("#oauth=code%3Dx")).toBeNull();
    expect(parseOAuthFragment("#state=s1&code=x")).toBeNull();
    expect(parseOAuthFragment("")).toBeNull();
    expect(parseOAuthFragment("#oauth=%E0%A4%A")).toBeNull();
  });

  it("sends a client secret only when one was typed or cleared", () => {
    const record = connection();
    expect(
      oauthClientWrite(record, {
        clientId: " client-2 ",
        clientSecret: "",
        clearClientSecret: false,
      }),
    ).toEqual({
      name: "Room calendars",
      clientId: "client-2",
      expectedRevision: 2,
    });
    expect(
      oauthClientWrite(record, {
        clientId: "client-1",
        clientSecret: "new",
        clearClientSecret: false,
      }).clientSecret,
    ).toBe("new");
    expect(
      oauthClientWrite(record, {
        clientId: "client-1",
        clientSecret: "",
        clearClientSecret: true,
      }),
    ).toMatchObject({ clearClientSecret: true });
    const connected = connection({ oauth: oauth({ status: "connected" }) });
    const draft = {
      clientId: "client-1",
      clientSecret: "x",
      clearClientSecret: false,
    };
    expect(replacesConnectedClient(connected, draft)).toBe(false);
    expect(
      replacesConnectedClient(connected, { ...draft, clientId: "client-2" }),
    ).toBe(true);
    expect(
      replacesConnectedClient(record, { ...draft, clientId: "client-2" }),
    ).toBe(false);
  });

  it("names the provider endpoints and scopes in the install review", () => {
    const t = i18n.getFixedT("en", "plugins");
    const lines = connectionReviewLines(
      {
        id: "google",
        title: "Google Calendar",
        type: "oauth2",
        operatorOrigin: false,
        origins: ["https://www.googleapis.com"],
        privateNetwork: false,
        plainHttp: false,
        plaintextSecret: false,
        maxResponseBytes: 1 << 20,
        timeoutSeconds: 10,
        oauth: {
          authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenEndpoint: "https://oauth2.googleapis.com/token",
          revocationEndpoint: "https://oauth2.googleapis.com/revoke",
          scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
          tokenEndpointAuthMethod: "client_secret_post",
        },
      },
      t,
    );
    expect(lines.security).toEqual([
      "Sends requests to https://www.googleapis.com",
      "Sends you to https://accounts.google.com/o/oauth2/v2/auth to grant access",
      "Exchanges tokens with https://oauth2.googleapis.com/token",
      "Requests access: https://www.googleapis.com/auth/calendar.readonly",
      "Asks https://oauth2.googleapis.com/revoke to revoke access when you disconnect",
    ]);
  });
});

describe("OAuth connection page", () => {
  it("shows the exact redirect URI and sends the operator to the provider", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const sent = stubApi(connection(), {
      "/oauth/start": () =>
        new Response(
          JSON.stringify({
            data: {
              authorizationUrl:
                "https://accounts.google.com/o/oauth2/v2/auth?state=x",
            },
          }),
        ),
    });
    editor();
    expect(await screen.findByDisplayValue(callbackUrl)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy redirect URI" }),
    ).toBeInTheDocument();
    // The client secret is write-only: the field is empty and says "set".
    expect(screen.getByLabelText("Client secret")).toHaveValue("");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.path).toMatch(/\/connections\/c1\/oauth\/start$/);
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        "https://accounts.google.com/o/oauth2/v2/auth?state=x",
      ),
    );
  });

  it("explains why Connect is unavailable", async () => {
    stubApi(
      connection({
        oauth: oauth({
          callbackUrl: undefined,
          connectAvailable: false,
          connectUnavailableReason: "public_url_https_required",
        }),
      }),
    );
    editor();
    const reasons = await screen.findAllByText(
      /set TILECAST_PUBLIC_URL to an https address/,
    );
    expect(reasons.length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  });

  it("saves a new client and asks first when it replaces a connected one", async () => {
    const sent = stubApi(
      connection({
        oauth: oauth({ status: "connected" }),
        status: "ready",
        reasons: [],
      }),
    );
    editor();
    const clientId = await screen.findByLabelText("Client ID");
    fireEvent.change(clientId, { target: { value: "client-2" } });
    fireEvent.change(screen.getByLabelText("Client secret"), {
      target: { value: "secret-2" },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Save client" }));
    expect(
      await screen.findByText(/deletes this connection's tokens/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Change client ID" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body).toEqual({
      name: "Room calendars",
      clientId: "client-2",
      clientSecret: "secret-2",
      expectedRevision: 2,
    });
  });

  it("completes the sign-in from the fragment once and shows the result", async () => {
    const connected = connection({
      oauth: oauth({ status: "connected" }),
      status: "ready",
      reasons: [],
    });
    const sent = stubApi(connection(), {
      "/oauth/complete": () =>
        new Response(JSON.stringify({ data: connected })),
    });
    const fragment = encodeURIComponent("state=s1&code=abc");
    editor(`/plugins/room-sign/connections/c1#oauth=${fragment}`);
    expect(
      await screen.findByText("The connection is connected to the provider."),
    ).toBeInTheDocument();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.path).toMatch(/\/connections\/c1\/oauth\/complete$/);
    expect(sent[0]!.body).toEqual({ state: "s1", code: "abc" });
  });

  it("explains a failed sign-in with its reason", async () => {
    stubApi(connection(), {
      "/oauth/complete": () =>
        new Response(
          JSON.stringify({
            error: {
              code: "plugin_oauth_failed",
              message: "The provider did not connect this connection.",
              details: { reason: "invalid_state" },
            },
          }),
          { status: 400 },
        ),
    });
    editor(
      `/plugins/room-sign/connections/c1#oauth=${encodeURIComponent("state=old&code=x")}`,
    );
    expect(
      await screen.findByText(
        /was already used, or was started by someone else/,
      ),
    ).toBeInTheDocument();
  });

  it("disconnects after confirmation and says what the provider answered", async () => {
    const disconnected = connection({
      oauth: oauth({
        revocation: "failed",
        disconnectedAt: "2026-11-02T00:00:00Z",
      }),
    });
    const sent = stubApi(
      connection({
        oauth: oauth({ status: "connected" }),
        status: "ready",
        reasons: [],
      }),
      {
        "/oauth/disconnect": () =>
          new Response(JSON.stringify({ data: disconnected })),
      },
    );
    editor();
    const user = userEvent.setup();
    expect(
      await screen.findByRole("button", { name: "Delete connection" }),
    ).toBeDisabled();
    await user.click(await screen.findByRole("button", { name: "Disconnect" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Disconnect",
      }),
    );
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(
      await screen.findByText(
        /Tilecast deleted its tokens; the provider could not be asked to revoke access/,
      ),
    ).toBeInTheDocument();
  });

  it("lets a viewer read without changing anything", async () => {
    stubApi(connection());
    editor("/plugins/room-sign/connections/c1", "viewer");
    expect(await screen.findByDisplayValue(callbackUrl)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(screen.getByLabelText("Client ID")).toBeDisabled();
  });
});
