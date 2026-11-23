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
import { renderPluginRoute } from "../../testing";
import type { PluginFeedField, PluginFeedRecords } from "./api";
import { HostedFeedRecordsPage } from "./HostedFeedRecordsPage";
import { HostedFeedsPage } from "./HostedFeedsPage";
import { cellText, overridable, overrideValue } from "./model";

const manifest = {
  apiVersion: 3,
  id: "menu_board",
  name: "Menu Board",
  studio: { route: "/plugins/menu-board" },
  api: { basePaths: ["/plugins/menu-board"] },
  instances: [],
  feeds: [],
} as unknown as PluginManifestV3;

const field = (overrides: Partial<PluginFeedField>): PluginFeedField => ({
  key: "name",
  label: "Name",
  control: "text",
  type: "text",
  override: "upstream",
  personal: false,
  image: false,
  required: false,
  ...overrides,
});

const dataset = {
  id: "d1",
  feed: "items",
  feedVersion: 1,
  title: "Menu items",
  provider: "menu_board.items",
  name: "Lunch: Menu items",
  revision: 4,
  records: 1,
  publishedAt: "2026-11-23T09:00:00Z",
  stale: false,
  imageIssues: 1,
  overrides: 1,
  widgetsUsing: 2,
};

const page: PluginFeedRecords = {
  dataset,
  fields: [
    field({ key: "name", label: "Name", override: "local_until_changed" }),
    field({ key: "price", label: "Price", control: "number", type: "number" }),
    field({
      key: "photo",
      label: "Photo",
      control: "url",
      type: "asset",
      image: true,
    }),
  ],
  items: [
    {
      id: "item-1",
      upstream: { name: "Tea", price: 3 },
      overrides: {},
      effective: { name: "Tea", price: "3", photo: "" },
      removedOverrides: {
        name: { reason: "upstream_changed", removedAt: "2026-11-23T08:00:00Z" },
      },
      imageFailures: { photo: "invalid_image" },
    },
  ],
  total: 1,
};

function stub() {
  const sent: { method: string; path: string; body: unknown }[] = [];
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
      if (init?.method === "PUT") {
        sent.push({
          method: "PUT",
          path,
          body: JSON.parse(
            typeof init.body === "string" ? init.body : "{}",
          ) as unknown,
        });
        return reply(page.items[0]);
      }
      if (path.includes("/records")) return reply(page);
      if (path.endsWith("/feeds")) return reply({ items: [dataset], total: 1 });
      return reply({ items: [] });
    }),
  );
  return sent;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("feed rules", () => {
  it("allows overrides only for local fields and types the value", () => {
    expect(overridable(field({ override: "upstream" }))).toBe(false);
    expect(overridable(field({ override: "local", image: true }))).toBe(false);
    expect(overridable(field({ override: "local_until_changed" }))).toBe(true);
    expect(overrideValue(field({ control: "number" }), " 2.5 ")).toBe(2.5);
    expect(overrideValue(field({ control: "boolean" }), "true")).toBe(true);
    expect(overrideValue(field({}), "  ")).toBeNull();
    expect(cellText(page.items[0]!, page.fields[2]!)).toBe("");
  });
});

describe("feed pages", () => {
  it("lists datasets with their state", async () => {
    stub();
    renderPluginRoute(
      <HostedFeedsPage pluginId="menu_board" manifest={manifest} />,
      {
        path: "/plugins/menu-board/feeds",
      },
    );
    expect(await screen.findByText("Lunch: Menu items")).toBeInTheDocument();
    expect(screen.getByText("Up to date")).toBeInTheDocument();
    expect(screen.getByText("1 image problem")).toBeInTheDocument();
    expect(screen.getByText(/Used by 2 Widgets/)).toBeInTheDocument();
  });

  it("shows upstream and effective values and saves an override", async () => {
    const sent = stub();
    renderPluginRoute(
      <HostedFeedRecordsPage pluginId="menu_board" manifest={manifest} />,
      {
        path: "/plugins/menu-board/feeds/d1",
        patterns: ["/plugins/menu-board/feeds/:datasetId"],
      },
    );
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "View record item-1" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/because the provider changed this field/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("The file is not a supported image."),
    ).toBeInTheDocument();
    // Price is upstream only: no input.
    expect(within(dialog).getAllByLabelText("Your value")).toHaveLength(1);
    fireEvent.change(within(dialog).getByLabelText("Your value"), {
      target: { value: "Green tea" },
    });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.path).toMatch(
      /\/plugins\/menu_board\/feeds\/d1\/overrides$/,
    );
    expect(sent[0]!.body).toEqual({
      recordId: "item-1",
      field: "name",
      value: "Green tea",
    });
  });

  it("lets a viewer read without editing", async () => {
    stub();
    renderPluginRoute(
      <HostedFeedRecordsPage pluginId="menu_board" manifest={manifest} />,
      {
        path: "/plugins/menu-board/feeds/d1",
        patterns: ["/plugins/menu-board/feeds/:datasetId"],
        role: "viewer",
      },
    );
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "View record item-1" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Your value")).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: "Save" })).toBeNull();
  });
});
