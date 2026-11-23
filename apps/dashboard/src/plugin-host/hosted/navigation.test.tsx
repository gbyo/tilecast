// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PluginManifestV3 } from "@tilecast/plugin-sdk/manifest";
import { act } from "react";
import { RouterProvider, createMemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import "../../i18n";
import countdown from "../../../../../plugins/countdown-bar/tilecast.plugin.json";
import type { DiscoveredStudioPlugin } from "../discovery";
import { HostedConnectionsPage } from "./connections/HostedConnectionsPage";
import { HostedFeedsPage } from "./feeds/HostedFeedsPage";
import { HostedInstancesPage } from "./HostedInstancesPage";
import { HostedKindNavigator } from "./HostedKindNavigator";
import { HostedSettingsPage } from "./HostedSettingsPage";
import { hostedLandingPage } from "./landing";
import { hostedRouteObjects } from "./routes";
import { HostedStatusPage } from "./status/HostedStatusPage";
import { HostedWebhooksPage } from "./webhooks/HostedWebhooksPage";

afterEach(cleanup);

const base = countdown as unknown as PluginManifestV3;
const route = "/plugins/countdown-bar";

/** Countdown Bar's manifest with `count` copies of its instance kind. */
function withKinds(count: number): PluginManifestV3 {
  const template = base.instances[0]!;
  return {
    ...base,
    instances: Array.from({ length: count }, (_, index) => ({
      ...template,
      kind: `k${index}`,
      path: `k${index}`,
      noun: { singular: `kind ${index}`, plural: `Kind ${index}` },
      operations: { singular: `K${index}`, plural: `K${index}s` },
    })),
  };
}

/** Countdown Bar without instances, with only the members a test names. */
function zeroInstances(members: Partial<PluginManifestV3>): PluginManifestV3 {
  return {
    ...base,
    instances: [],
    settings: undefined,
    connections: undefined,
    feeds: undefined,
    webhooks: undefined,
    events: undefined,
    providers: undefined,
    services: [],
    ...members,
  } as PluginManifestV3;
}

function Where() {
  const location = useLocation();
  return <output aria-label="location">{location.pathname}</output>;
}

function renderNavigator(manifest: PluginManifestV3, start: string) {
  const routes = manifest.instances.map((kind) => ({
    path: `${route}/${kind.path}`,
    element: (
      <>
        <HostedKindNavigator manifest={manifest} current={kind.path} />
        <Where />
      </>
    ),
  }));
  const router = createMemoryRouter(routes, { initialEntries: [start] });
  render(<RouterProvider router={router} />);
  return router;
}

describe("instance kind navigation", () => {
  it("shows no navigator for one kind", () => {
    renderNavigator(withKinds(1), `${route}/k0`);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("shows tabs that link to each kind's route for two to four kinds", () => {
    for (const count of [2, 4]) {
      renderNavigator(withKinds(count), `${route}/k1`);
      const tabs = screen.getAllByRole("tab");
      expect(tabs).toHaveLength(count);
      expect(tabs[0]).toHaveAttribute("href", `${route}/k0`);
      expect(screen.getByRole("tab", { name: "Kind 1" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
      cleanup();
    }
  });

  it("shows a labelled selector for five to sixteen kinds that follows the URL", async () => {
    const router = renderNavigator(withKinds(16), `${route}/k2`);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    const selector = screen.getByRole("combobox", { name: "Type" });
    expect(selector).toHaveTextContent("Kind 2");

    const user = userEvent.setup();
    await user.click(selector);
    await user.click(await screen.findByRole("option", { name: "Kind 9" }));
    await waitFor(() =>
      expect(screen.getByLabelText("location")).toHaveTextContent(
        `${route}/k9`,
      ),
    );
    expect(screen.getByRole("combobox", { name: "Type" })).toHaveTextContent(
      "Kind 9",
    );

    // Browser back returns to the previous kind; the URL is the only state.
    await act(() => router.navigate(-1));
    expect(screen.getByLabelText("location")).toHaveTextContent(`${route}/k2`);
    expect(screen.getByRole("combobox", { name: "Type" })).toHaveTextContent(
      "Kind 2",
    );
    await act(() => router.navigate(1));
    expect(screen.getByLabelText("location")).toHaveTextContent(`${route}/k9`);
  });

  it("works from the keyboard", async () => {
    renderNavigator(withKinds(5), `${route}/k0`);
    const user = userEvent.setup();
    screen.getByRole("combobox", { name: "Type" }).focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("option", { name: "Kind 3" });
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    await waitFor(() =>
      expect(screen.getByLabelText("location")).not.toHaveTextContent(
        `${route}/k0`,
      ),
    );
  });

  it("fills a phone-width row and stays compact on wider screens", () => {
    renderNavigator(withKinds(6), `${route}/k0`);
    const selector = screen.getByRole("combobox", { name: "Type" });
    expect(selector.className).toMatch(/\bw-full\b/);
    expect(selector.className).toMatch(/\bsm:w-64\b/);
  });
});

function plugin(
  manifest: PluginManifestV3,
  routes: DiscoveredStudioPlugin["definition"]["routes"] = [],
): DiscoveredStudioPlugin {
  return {
    id: "countdown_bar",
    dir: "countdown-bar",
    name: "Countdown Bar",
    route,
    additionalRoutes: [],
    manifest,
    definition: { routes } as DiscoveredStudioPlugin["definition"],
  };
}

function indexPage(manifest: PluginManifestV3, routes?: []) {
  const index = hostedRouteObjects(plugin(manifest, routes)).filter(
    (item) => item.index,
  );
  expect(index.length).toBeLessThanOrEqual(1);
  return (index[0]?.element as { type?: unknown } | undefined)?.type;
}

const organizationSettings = {
  organization: [
    { key: "label", label: "Label", control: "text", maxLength: 40 },
  ],
} as unknown as PluginManifestV3["settings"];
const connection = [
  { id: "api", title: "API", type: "http" },
] as unknown as PluginManifestV3["connections"];
const feed = [{ id: "items" }] as unknown as PluginManifestV3["feeds"];
const webhook = [
  { id: "inbox", title: "Inbox" },
] as unknown as PluginManifestV3["webhooks"];

describe("zero-instance landing page", () => {
  it("lands on instances when the plugin has kinds", () => {
    expect(hostedLandingPage(withKinds(2))).toBe("instances");
    expect(indexPage(withKinds(2))).toBe(HostedInstancesPage);
  });

  it("lands on organization settings first", () => {
    const manifest = zeroInstances({
      settings: organizationSettings,
      connections: connection,
      feeds: feed,
    });
    expect(hostedLandingPage(manifest)).toBe("settings");
    expect(indexPage(manifest)).toBe(HostedSettingsPage);
    // The settings link of the page header resolves too.
    expect(
      hostedRouteObjects(plugin(manifest)).some(
        (item) => item.path === "settings",
      ),
    ).toBe(true);
  });

  it("lands on connections without settings", () => {
    const manifest = zeroInstances({ connections: connection, feeds: feed });
    expect(hostedLandingPage(manifest)).toBe("connections");
    expect(indexPage(manifest)).toBe(HostedConnectionsPage);
  });

  it("lands on feeds without settings or connections", () => {
    const manifest = zeroInstances({ feeds: feed, webhooks: webhook });
    expect(hostedLandingPage(manifest)).toBe("feeds");
    expect(indexPage(manifest)).toBe(HostedFeedsPage);
  });

  it("lands on webhooks before status", () => {
    const manifest = zeroInstances({ webhooks: webhook });
    expect(hostedLandingPage(manifest)).toBe("webhooks");
    expect(indexPage(manifest)).toBe(HostedWebhooksPage);
  });

  it("lands on status when status is the only generated page", () => {
    const manifest = zeroInstances({ services: ["events.publish@1"] });
    expect(hostedLandingPage(manifest)).toBe("status");
    expect(indexPage(manifest)).toBe(HostedStatusPage);
  });

  it("generates no landing page when there is nothing to show", () => {
    const manifest = zeroInstances({});
    expect(hostedLandingPage(manifest)).toBeNull();
    expect(indexPage(manifest)).toBeUndefined();
  });

  it("keeps a plugin's own index page", () => {
    const manifest = zeroInstances({ settings: organizationSettings });
    const routes = hostedRouteObjects(
      plugin(manifest, [{ index: true, element: <p>Custom</p> }]),
    );
    expect(routes.some((item) => item.index)).toBe(false);
    expect(routes.some((item) => item.path === "settings")).toBe(true);
  });
});
