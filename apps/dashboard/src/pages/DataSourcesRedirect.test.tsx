// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { DataSource, DataSourceDetail } from "../api/types";
import { DataSourceEditorPage, DataSourcesPage } from "./DataSourcesPage";

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

// A plugin contribution that authors its provider through a canonical Studio
// surface. The generic Data Source UI redirects to those routes without
// naming the provider.
function stubContributionCatalog() {
  vi.spyOn(api, "providerCatalog").mockResolvedValue({
    revision: 1,
    providers: [
      {
        id: "form",
        role: "data_source",
        label: "Form",
        group: "Interactive",
        description: "Collect submissions.",
        capabilities: {},
        uiHints: {
          canonicalEditor: "/plugins/forms/:id",
          canonicalCreator: "/plugins/forms/new",
          gallery: "hidden",
        },
      },
    ],
  });
}

function renderEditor(path: string) {
  stubContributionCatalog();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/data-sources/new" element={<DataSourceEditorPage />} />
          <Route
            path="/data-sources/new/:provider"
            element={<DataSourceEditorPage />}
          />
          <Route path="/data-sources/:id" element={<DataSourceEditorPage />} />
          <Route
            path="/plugins/forms/new"
            element={<div>Canonical creator</div>}
          />
          <Route
            path="/plugins/forms/:id"
            element={<div>Canonical editor</div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Data Source canonical plugin surfaces", () => {
  it("sends the provider creator to the canonical route", async () => {
    renderEditor("/data-sources/new/form");
    expect(await screen.findByText("Canonical creator")).toBeInTheDocument();
  });

  it("sends a managed instance to its canonical editor preserving search", async () => {
    vi.spyOn(api, "getDataSource").mockResolvedValue({
      id: "form-1",
      provider: "form",
      name: "Staff announcements",
    } as unknown as DataSourceDetail);
    renderEditor("/data-sources/form-1?tab=responses&record=r1");
    expect(await screen.findByText("Canonical editor")).toBeInTheDocument();
  });

  it("keeps gallery-hidden providers out of the creation gallery", async () => {
    stubContributionCatalog();
    vi.spyOn(api, "contentDefinitions").mockResolvedValue({
      revision: "1",
      compilerVersion: "1",
      fingerprint: "test",
      widgets: [],
      dataSources: [
        {
          id: "form",
          name: "Form",
          description: "Collect submissions.",
        },
      ],
    } as never);
    vi.spyOn(api, "listDataSources").mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 100,
    });
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter initialEntries={["/data-sources/new"]}>
          <Routes>
            <Route
              path="/data-sources/new"
              element={<DataSourceEditorPage />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: "Create Data Source" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Form/ })).toBeNull();
  });

  it("keeps gallery-hidden providers out of the library list", async () => {
    stubContributionCatalog();
    vi.spyOn(api, "listDataSources").mockResolvedValue({
      items: [
        {
          id: "form-1",
          provider: "form",
          name: "Staff announcements",
        } as unknown as DataSource,
      ],
      total: 1,
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
    render(
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
    expect(await screen.findByText("Data Sources")).toBeInTheDocument();
    expect(screen.queryByText("Staff announcements")).toBeNull();
  });
});
