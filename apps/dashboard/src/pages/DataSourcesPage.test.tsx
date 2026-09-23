// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type {
  DataSource,
  DataSourceDefinition,
  DataSourceDetail,
} from "../api/types";
import {
  iconForIdentifier,
  resolveSetup,
  sourceIcon,
} from "../content/dataSourceProviderMeta";
import { DataSourcesPage } from "./DataSourcesPage";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: {
      csrfToken: "csrf-token",
      user: { id: "user-1", role: "administrator" },
    },
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// A release-defined Data Source whose provider ID is NOT present in any TypeScript union,
// hardcoded copy map, or icon switch. The open `DataSourceProvider` contract accepts it,
// and Studio must render it entirely from catalog metadata.
// The plain string ID assigns directly to DataSourceProvider, proving the union is open.
const fakeDefinition: DataSourceDefinition = {
  id: "campus-alert",
  version: 1,
  name: "Campus Alert",
  description: "Publish a campus-wide alert as a typed object.",
  category: "Information",
  icon: "beacon", // an icon identifier the Studio does not know
  configurationSchema: { fields: [] },
  defaultConfiguration: {},
  outputSchema: {
    kind: "object",
    fields: [{ key: "headline", label: "Headline", type: "text" }],
  },
  adapterId: "manual_object",
  refreshBehavior: "manual",
  requiresManifestV13: true,
  setup: {
    eyebrow: "Release-defined information",
    tip: "Keep alerts short and actionable.",
    steps: ["Enter the alert.", "Save and connect a Widget."],
  },
};

describe("release-defined Data Source Studio metadata", () => {
  it("resolves setup copy from catalog metadata for an ID not hardcoded in TypeScript", () => {
    const copy = resolveSetup(fakeDefinition.id, fakeDefinition);
    expect(copy.eyebrow).toBe("Release-defined information");
    expect(copy.description).toBe(
      "Publish a campus-wide alert as a typed object.",
    );
    expect(copy.tip).toBe("Keep alerts short and actionable.");
    expect(copy.steps).toHaveLength(2);
  });

  it("keeps hardcoded copy for legacy providers", () => {
    const legacy: DataSourceDefinition = {
      ...fakeDefinition,
      id: "calendar",
      legacyEditor: true,
    };
    const copy = resolveSetup("calendar", legacy);
    expect(copy.eyebrow).toBe("iCalendar feed");
  });

  it("falls back to a safe icon for an unknown icon identifier", () => {
    const { container } = render(iconForIdentifier("beacon"));
    // The default icon renders rather than crashing the gallery.
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("uses the definition icon for a release-defined source", () => {
    const { container } = render(sourceIcon(fakeDefinition.id, fakeDefinition));
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});

describe("Data Source card actions", () => {
  const source = {
    id: "source-1",
    provider: "rss",
    name: "District news",
    description: "",
    configuration: {},
    createdAt: "2026-07-21T12:00:00Z",
    updatedAt: "2026-07-21T12:00:00Z",
    status: "ready",
    diagnostics: {},
    fields: [],
    cachedRecordCount: 4,
    widgetUsage: [],
    bindingUsage: [],
  } as unknown as DataSource;
  const formSource = {
    ...source,
    id: "form-1",
    provider: "form",
    name: "Staff announcements",
  } as DataSource;

  function renderPage() {
    vi.spyOn(api, "listDataSources").mockResolvedValue({
      items: [source, formSource],
      total: 2,
      page: 1,
      pageSize: 100,
    });
    vi.spyOn(api, "contentDefinitions").mockResolvedValue({
      revision: "1",
      compilerVersion: "1",
      fingerprint: "test",
      widgets: [],
      dataSources: [],
    });
    return render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter>
          <DataSourcesPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("duplicates a Data Source from its right-click menu", async () => {
    const duplicate = vi
      .spyOn(api, "duplicateDataSource")
      .mockResolvedValue({ ...source, id: "source-2" } as DataSourceDetail);
    renderPage();
    fireEvent.contextMenu(await screen.findByText("District news"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    await waitFor(() =>
      expect(duplicate).toHaveBeenCalledWith("source-1", "csrf-token"),
    );
  });

  it("keeps Forms out of the Data Source library", async () => {
    renderPage();
    expect(await screen.findByText("District news")).toBeInTheDocument();
    expect(screen.queryByText("Staff announcements")).toBeNull();
  });

  it("confirms in a dialog before deleting a Data Source", async () => {
    const remove = vi
      .spyOn(api, "deleteDataSource")
      .mockResolvedValue(undefined);
    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "Actions for District news" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(
      screen.getByRole("alertdialog", { name: "Delete District news?" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for District news" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(remove).toHaveBeenCalledWith("source-1", "csrf-token"),
    );
  });
});
