// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { DataSourceDefinition } from "../api/types";
import { DataSourceProviderGallery } from "./DataSourceCreateFlow";
import announcementsManifest from "../../../../data-sources/announcements/tilecast.datasource.json";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const announcements = announcementsManifest as unknown as DataSourceDefinition;

const intake: DataSourceDefinition = {
  id: "emergency_alerts_intake",
  version: 1,
  source: { kind: "plugin", pluginId: "emergency_alerts" },
  name: "Intake",
  description: "Collect intake rows.",
  category: "Essentials",
  icon: "layout",
  configurationSchema: { fields: [] },
  defaultConfiguration: {},
  outputSchema: {
    kind: "records",
    fields: [{ key: "title", label: "Title", type: "text" }],
  },
  adapterId: "manual_records",
  refreshBehavior: "manual",
};

function renderGalleryWithPluginSource(
  installed: boolean,
  onChoose: (provider: string) => void = vi.fn(),
) {
  vi.spyOn(api, "contentDefinitions").mockResolvedValue({
    revision: "1",
    compilerVersion: "1",
    fingerprint: "test",
    widgets: [],
    dataSources: [announcements, intake],
  });
  vi.spyOn(api, "plugins").mockResolvedValue({
    items: [
      {
        id: "emergency_alerts",
        name: "Emergency Alerts",
        installed,
      },
    ],
    unsupportedInstallations: [],
  } as never);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const editor: ReactNode = (
    <QueryClientProvider client={client}>
      <DataSourceProviderGallery onChoose={onChoose} onClose={vi.fn()} page />
    </QueryClientProvider>
  );
  return { editor, onChoose };
}

describe("Data Source gallery provenance", () => {
  it("shows the migrated core module without a plugin badge", async () => {
    const { editor } = renderGalleryWithPluginSource(true);
    render(editor);
    const card = await screen.findByRole("button", { name: /Announcements/ });
    expect(card).not.toBeDisabled();
    expect(within(card).queryByText("Plugin · Emergency Alerts")).toBeNull();
  });

  it("names the owning plugin for an installed plugin-owned provider", async () => {
    const onChoose = vi.fn();
    const { editor } = renderGalleryWithPluginSource(true, onChoose);
    render(editor);
    // The badge shows the plugin's name only after the plugin catalog
    // query resolves, so waiting for it waits for installation state too.
    await screen.findByText("Plugin · Emergency Alerts");
    const card = screen.getByRole("button", { name: /Intake/ });
    expect(card).not.toBeDisabled();
    expect(within(card).getByText("Plugin · Emergency Alerts")).toBeTruthy();
    expect(within(card).queryByText(/Requires/)).toBeNull();
    fireEvent.click(card);
    expect(onChoose).toHaveBeenCalledWith("emergency_alerts_intake");
  });

  it("disables a plugin-owned provider with its plugin named while uninstalled", async () => {
    const onChoose = vi.fn();
    const { editor } = renderGalleryWithPluginSource(false, onChoose);
    render(editor);
    await screen.findByText("Plugin · Emergency Alerts");
    const card = screen.getByRole("button", { name: /Intake/ });
    expect(card).toBeDisabled();
    expect(screen.getByText("Requires Emergency Alerts")).toBeTruthy();
    expect(onChoose).not.toHaveBeenCalled();
  });
});
