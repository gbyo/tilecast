// @vitest-environment jsdom
// Editing a shared Widget from inside a Layout used to ask for confirmation and then navigate to
// the Widget *list*, abandoning the Layout the author was building. The Widget editor now honors a
// returnTo path so closing lands back where the author came from.
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Outlet,
  RouterProvider,
  createMemoryRouter,
  useLocation,
} from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { Asset, ContentDefinitionCatalog } from "../api/types";
import { AuthProvider } from "../auth/AuthProvider";
import { WidgetEditorPage } from "./WidgetsPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function CurrentPath() {
  const location = useLocation();
  return (
    <div data-testid="path">{`${location.pathname}${location.search}`}</div>
  );
}

const widget = {
  id: "widget-1",
  name: "Today's Lunch",
  description: "",
  type: "widget",
  originalFilename: "",
  declaredMimeType: "application/json",
  detectedMimeType: "application/json",
  sha256: "aabb",
  originalSize: 0,
  metadata: {},
  processingStatus: "ready",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  variants: [],
  playlistUsage: 1,
  playlistsUsing: [{ id: "playlist-1", name: "Cafeteria loop" }],
  layoutUsage: [{ id: "layout-1", name: "Cafeteria Layout", published: true }],
  widget: {
    provider: "website",
    configVersion: 1,
    configuration: {} as never,
  },
} as unknown as Asset;

function editorAt(url: string) {
  vi.spyOn(api, "asset").mockResolvedValue(widget);
  vi.spyOn(api, "contentDefinitions").mockResolvedValue({
    revision: "1",
    compilerVersion: "1",
    fingerprint: "abc",
    widgets: [
      {
        id: "website",
        version: 1,
        name: "Website",
        description: "Show a website.",
        category: "Web",
        icon: "globe",
        runtime: "web",
        configurationSchema: { fields: [] },
        defaultConfiguration: {},
        presentationSchemaVersion: 13,
        requiredCapabilities: {},
        legacyEditor: true,
      },
    ],
    dataSources: [],
  } as unknown as ContentDefinitionCatalog);
  vi.spyOn(api, "authStatus").mockResolvedValue({
    setupRequired: false,
    authenticated: true,
    csrfToken: "csrf",
    user: {
      id: "u1",
      name: "Owner",
      username: "owner",
      role: "owner",
      active: true,
      createdAt: "2026-01-01T00:00:00Z",
    },
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // A data router like production Studio, so the editor's navigation
  // blocking sees the router it ships with.
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: (
          <>
            <CurrentPath />
            <Outlet />
          </>
        ),
        children: [
          { path: "widgets/:id", element: <WidgetEditorPage /> },
          { path: "widgets", element: <div>Widget list</div> },
          { path: "layouts/:id", element: <div>Layout editor</div> },
          { path: "playlists/:id", element: <div>Playlist editor</div> },
        ],
      },
    ],
    { initialEntries: [url] },
  );
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("Widget editor returnTo", () => {
  it("returns to the Layout that opened the Widget", async () => {
    editorAt("/widgets/widget-1?returnTo=%2Flayouts%2Flayout-1");

    // The editor frame renders a header close control and a footer cancel; either exits.
    const [close] = await screen.findAllByRole("button", { name: /^Close$/ });
    await userEvent.click(close!);

    await waitFor(() =>
      expect(screen.getByTestId("path")).toHaveTextContent("/layouts/layout-1"),
    );
  });

  it("falls back to the Widget list when no return path is given", async () => {
    editorAt("/widgets/widget-1");

    // The editor frame renders a header close control and a footer cancel; either exits.
    const [close] = await screen.findAllByRole("button", { name: /^Close$/ });
    await userEvent.click(close!);

    await waitFor(() =>
      expect(screen.getByTestId("path")).toHaveTextContent("/widgets"),
    );
  });

  // returnTo arrives from the URL, so a protocol-relative or absolute value must not become an
  // off-site navigation target.
  it("ignores a return path that is not an in-app route", async () => {
    editorAt("/widgets/widget-1?returnTo=%2F%2Fevil.example.com");

    // The editor frame renders a header close control and a footer cancel; either exits.
    const [close] = await screen.findAllByRole("button", { name: /^Close$/ });
    await userEvent.click(close!);

    await waitFor(() =>
      expect(screen.getByTestId("path")).toHaveTextContent("/widgets"),
    );
  });

  // A Widget created from a playlist's content picker has to come back identified,
  // or the playlist the author started from has no way to add it.
  it("names a newly created Widget on the way back to the playlist", async () => {
    editorAt("/widgets/widget-1?returnTo=%2Fplaylists%2Fplaylist-1&created=1");

    const [close] = await screen.findAllByRole("button", { name: /^Close$/ });
    await userEvent.click(close!);

    await waitFor(() =>
      expect(screen.getByTestId("path")).toHaveTextContent(
        "/playlists/playlist-1?newWidget=widget-1",
      ),
    );
  });

  // Opening an existing Widget from a playlist must not re-add it on return.
  it("does not name a Widget that was only edited", async () => {
    editorAt("/widgets/widget-1?returnTo=%2Fplaylists%2Fplaylist-1");

    const [close] = await screen.findAllByRole("button", { name: /^Close$/ });
    await userEvent.click(close!);

    await waitFor(() =>
      expect(screen.getByTestId("path")).toHaveTextContent(
        "/playlists/playlist-1",
      ),
    );
    expect(screen.getByTestId("path")).not.toHaveTextContent("newWidget");
  });

  it("reports the playlists and Layouts that use the Widget", async () => {
    editorAt("/widgets/widget-1");

    expect(
      await screen.findByRole("link", { name: /Cafeteria loop/ }),
    ).toHaveAttribute("href", "/playlists/playlist-1");
    expect(
      screen.getByRole("link", { name: /Cafeteria Layout/ }),
    ).toHaveAttribute("href", "/layouts/layout-1");
  });
});
