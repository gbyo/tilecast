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
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { LayoutSummary } from "../api/types";
import { i18n } from "../i18n";
import {
  filterAndSortLayouts,
  formatLayoutUpdatedAt,
  layoutPublicationLabel,
  layoutPublicationState,
  LayoutsPage,
} from "./LayoutsPage";

const t = i18n.getFixedT("en", "layouts");

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: {
      csrfToken: "csrf-token",
      user: { role: "owner" },
    },
  }),
}));

vi.mock("../api/client", () => ({
  api: {
    layouts: vi.fn(),
    updateLayout: vi.fn(),
    createLayout: vi.fn(),
    saveLayoutDraft: vi.fn(),
    duplicateLayout: vi.fn(),
    deleteLayout: vi.fn(),
  },
}));

const layout = (
  values: Partial<LayoutSummary> & Pick<LayoutSummary, "id" | "name">,
): LayoutSummary => {
  const { id, name, ...overrides } = values;
  return {
    id,
    name,
    description: "",
    orientation: "landscape",
    canvasWidth: 1920,
    canvasHeight: 1080,
    draftRevision: 1,
    hasUnpublishedChanges: false,
    createdAt: "2026-07-01T12:00:00Z",
    updatedAt: "2026-07-01T12:00:00Z",
    ...overrides,
  };
};

const savedLayout = layout({
  id: "layout-1",
  name: "Lobby",
  // i18n-ignore: fixture user content, not UI text
  description: "Welcome board",
  draftRevision: 2,
  publishedRevision: 1,
  hasUnpublishedChanges: true,
  createdAt: "2026-07-21T12:00:00Z",
  updatedAt: "2026-07-21T12:00:00Z",
  previewImageUrl: "/api/v1/layouts/layout-1/preview-image",
});

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
  vi.mocked(api.layouts).mockResolvedValue({
    items: [savedLayout],
    total: 1,
    page: 1,
    pageSize: 100,
  });
  vi.mocked(api.updateLayout).mockResolvedValue(savedLayout as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <LayoutsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("layout library page", () => {
  it("shows the saved layout render instead of rebuilding a live preview", async () => {
    const { container } = renderPage();
    await screen.findByRole("button", { name: "Edit Lobby" });
    expect(
      container.querySelector(".layout-library-thumbnail"),
    ).toHaveAttribute("src", savedLayout.previewImageUrl);
  });

  it("labels each toolbar filter with its option label, not its value", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: "Edit Lobby" });

    const orientation = screen.getByRole("combobox", {
      name: "Filter layouts by orientation",
    });
    expect(orientation).toHaveTextContent("All orientations");
    expect(
      screen.getByRole("combobox", {
        name: "Filter layouts by publication status",
      }),
    ).toHaveTextContent("All statuses");
    expect(
      screen.getByRole("combobox", { name: "Sort layouts" }),
    ).toHaveTextContent("Recently updated");

    await user.click(orientation);
    await user.click(await screen.findByRole("option", { name: "Portrait" }));

    expect(orientation).toHaveTextContent("Portrait");
    expect(orientation).not.toHaveTextContent("portrait");
    expect(
      screen.queryByRole("button", { name: "Edit Lobby" }),
    ).not.toBeInTheDocument();
  });

  it("uses the shared search field for the layout library", async () => {
    renderPage();
    const search = await screen.findByRole("searchbox", {
      name: "Search layouts",
    });
    expect(search.closest('[data-slot="input-group"]')).not.toBeNull();
  });

  it("renames a layout from its card menu", async () => {
    const user = userEvent.setup();
    renderPage();

    // Base UI menus open on the contextmenu event in this suite; the card
    // offers the same actions through right-click and the actions button.
    fireEvent.contextMenu(
      await screen.findByRole("button", { name: "Edit Lobby" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const renameDialog = await screen.findByRole("dialog", {
      name: "Rename layout",
    });
    const input = within(renameDialog).getByRole("textbox");
    await user.clear(input);
    await user.type(input, "Main Lobby");
    await user.click(
      within(renameDialog).getByRole("button", { name: "Save name" }),
    );

    expect(api.updateLayout).toHaveBeenCalledWith(
      "layout-1",
      // i18n-ignore: assertion on user content passed to the API
      { name: "Main Lobby", description: "Welcome board" },
      "csrf-token",
    );
  });
});

describe("layout library helpers", () => {
  it("searches names, descriptions, dimensions, and status", () => {
    const items = [
      layout({ id: "welcome", name: "Welcome board" }),
      layout({
        id: "lunch",
        name: "Daily information",
        // i18n-ignore: fixture user content, not UI text
        description: "Cafeteria lunch and library notices",
      }),
      layout({
        id: "portrait",
        name: "Hallway schedule",
        orientation: "portrait",
        canvasWidth: 1080,
        canvasHeight: 1920,
        publishedRevision: 2,
        draftRevision: 3,
        hasUnpublishedChanges: true,
      }),
    ];

    expect(
      filterAndSortLayouts(items, "library", "all", "all", "name", t, "en"),
    ).toEqual([items[1]]);
    expect(
      filterAndSortLayouts(items, "1080x1920", "all", "all", "name", t, "en"),
    ).toEqual([items[2]]);
    expect(
      filterAndSortLayouts(
        items,
        "unpublished changes",
        "all",
        "all",
        "name",
        t,
        "en",
      ),
    ).toEqual([items[2]]);
  });

  it("filters by orientation and publication state", () => {
    const items = [
      layout({ id: "draft", name: "Draft" }),
      layout({
        id: "published",
        name: "Published",
        publishedRevision: 2,
        draftRevision: 2,
      }),
      layout({
        id: "changes",
        name: "Changes",
        orientation: "portrait",
        canvasWidth: 1080,
        canvasHeight: 1920,
        publishedRevision: 2,
        draftRevision: 3,
        hasUnpublishedChanges: true,
      }),
    ];

    expect(
      filterAndSortLayouts(items, "", "portrait", "all", "name", t, "en"),
    ).toEqual([items[2]]);
    expect(
      filterAndSortLayouts(items, "", "all", "published", "name", t, "en"),
    ).toEqual([items[1]]);
    expect(
      filterAndSortLayouts(items, "", "all", "draft", "name", t, "en"),
    ).toEqual([items[0]]);
  });

  it("sorts by updates and publication date with name fallbacks", () => {
    const items = [
      layout({
        id: "alpha",
        name: "Alpha",
        updatedAt: "2026-07-02T12:00:00Z",
        publishedAt: "2026-07-01T12:00:00Z",
      }),
      layout({
        id: "beta",
        name: "Beta",
        updatedAt: "2026-07-03T12:00:00Z",
        publishedAt: "2026-07-04T12:00:00Z",
      }),
      layout({
        id: "charlie",
        name: "Charlie",
        updatedAt: "2026-07-01T12:00:00Z",
      }),
    ];

    expect(
      filterAndSortLayouts(items, "", "all", "all", "updated", t, "en").map(
        (item) => item.id,
      ),
    ).toEqual(["beta", "alpha", "charlie"]);
    expect(
      filterAndSortLayouts(items, "", "all", "all", "published", t, "en").map(
        (item) => item.id,
      ),
    ).toEqual(["beta", "alpha", "charlie"]);
  });

  it("describes publication state and useful relative update times", () => {
    const draft = layout({ id: "draft", name: "Draft" });
    const changes = layout({
      id: "changes",
      name: "Changes",
      publishedRevision: 2,
      draftRevision: 3,
      hasUnpublishedChanges: true,
    });
    const published = layout({
      id: "published",
      name: "Published",
      publishedRevision: 2,
      draftRevision: 5,
      hasUnpublishedChanges: false,
    });

    expect(layoutPublicationState(draft)).toBe("draft");
    expect(layoutPublicationState(changes)).toBe("changes");
    expect(layoutPublicationState(published)).toBe("published");
    expect(layoutPublicationLabel(changes, t)).toBe("Unpublished changes");
    expect(layoutPublicationLabel(published, t)).toBe("Published r2");

    const now = Date.parse("2026-07-26T16:00:00Z");
    expect(formatLayoutUpdatedAt("2026-07-26T15:59:30Z", t, "en", now)).toBe(
      "Updated just now",
    );
    expect(formatLayoutUpdatedAt("2026-07-26T14:00:00Z", t, "en", now)).toBe(
      "Updated 2 hours ago",
    );
    expect(formatLayoutUpdatedAt("2026-07-23T16:00:00Z", t, "en", now)).toBe(
      "Updated 3 days ago",
    );
    expect(
      formatLayoutUpdatedAt("2025-12-01T16:00:00Z", t, "en", now),
    ).toContain("2025");
    expect(formatLayoutUpdatedAt("not-a-date", t, "en", now)).toBe(
      "Update time unavailable",
    );
  });
});
