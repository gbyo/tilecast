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
import type { Layout, LayoutSummary } from "../api/types";
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
    layout: vi.fn(),
    layoutPage: vi.fn(),
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

const newAnnouncementLayout = {
  id: "layout-announcement",
  name: "Assembly update",
  description: "",
  orientation: "landscape",
  canvasWidth: 1920,
  canvasHeight: 1080,
  draft: {
    schemaVersion: 2,
    canvas: {
      width: 1920,
      height: 1080,
      orientation: "landscape",
      backgroundColor: "#0E141B",
      safeAreaPercent: 5,
    },
    placements: [],
  },
  draftRevision: 1,
  hasUnpublishedChanges: false,
  createdAt: "2026-09-29T12:00:00Z",
  updatedAt: "2026-09-29T12:00:00Z",
  dependencies: [],
  usage: { screens: [], schedules: [], campaigns: [] },
};

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
  vi.mocked(api.layoutPage).mockResolvedValue({
    items: [savedLayout],
    total: 1,
    page: 1,
    pageSize: 100,
  });
  vi.mocked(api.updateLayout).mockResolvedValue(savedLayout as never);
  vi.mocked(api.createLayout).mockReset();
  vi.mocked(api.layout).mockReset();
  vi.mocked(api.saveLayoutDraft).mockReset();
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
    await screen.findByRole("link", { name: "Edit Lobby" });
    expect(
      container.querySelector(".layout-library-thumbnail"),
    ).toHaveAttribute("src", savedLayout.previewImageUrl);
  });

  it("retries announcement template setup on the already-created Layout", async () => {
    const user = userEvent.setup();
    vi.mocked(api.createLayout).mockResolvedValue(
      newAnnouncementLayout as never,
    );
    vi.mocked(api.layout).mockResolvedValue(newAnnouncementLayout as never);
    vi.mocked(api.saveLayoutDraft)
      .mockRejectedValueOnce(new Error("Temporary draft failure"))
      .mockResolvedValue(newAnnouncementLayout as never);
    renderPage();

    await user.click(
      await screen.findByRole("button", { name: "Create layout" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Create layout",
    });
    await user.type(
      within(dialog).getByRole("textbox", { name: "Name *" }),
      "Assembly update",
    );
    await user.click(
      within(dialog).getByRole("button", { name: /Announcement/ }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Create layout" }),
    );

    expect(
      await within(dialog).findByText(
        /The Layout was created, but its announcement template could not be initialized/,
      ),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Retry template setup" }),
    );

    await vi.waitFor(() =>
      expect(api.saveLayoutDraft).toHaveBeenCalledTimes(2),
    );
    expect(api.createLayout).toHaveBeenCalledTimes(1);
    expect(api.layout).toHaveBeenCalledWith("layout-announcement");
    expect(api.saveLayoutDraft).toHaveBeenNthCalledWith(
      1,
      "layout-announcement",
      1,
      expect.any(Object),
      "csrf-token",
    );
    expect(api.saveLayoutDraft).toHaveBeenNthCalledWith(
      2,
      "layout-announcement",
      1,
      expect.any(Object),
      "csrf-token",
    );
  });

  it("keeps announcement settings when creation is dismissed while pending", async () => {
    const user = userEvent.setup();
    let finishCreate!: (value: Layout) => void;
    vi.mocked(api.createLayout).mockImplementation(
      () =>
        new Promise<Layout>((resolve) => {
          finishCreate = resolve;
        }),
    );
    vi.mocked(api.saveLayoutDraft).mockRejectedValue(
      new Error("Temporary draft failure"),
    );
    renderPage();

    await user.click(
      await screen.findByRole("button", { name: "Create layout" }),
    );
    let dialog = await screen.findByRole("dialog", {
      name: "Create layout",
    });
    const nameInput = within(dialog).getByRole("textbox", { name: "Name *" });
    await user.type(nameInput, "Assembly update");
    await user.click(
      within(dialog).getByRole("button", { name: /Announcement/ }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Create layout" }),
    );
    await vi.waitFor(() => expect(api.createLayout).toHaveBeenCalledOnce());

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Create layout" }));
    dialog = await screen.findByRole("dialog", { name: "Create layout" });
    expect(within(dialog).getByRole("textbox", { name: "Name *" })).toHaveValue(
      "Assembly update",
    );
    expect(
      within(dialog).getByRole("button", { name: /Announcement/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(dialog).getByRole("textbox", { name: "Name *" }),
    ).toBeDisabled();

    finishCreate(newAnnouncementLayout as unknown as Layout);
    expect(
      await within(dialog).findByText(
        /The Layout was created, but its announcement template could not be initialized/,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "Name *" })).toHaveValue(
      "Assembly update",
    );
    expect(
      within(dialog).getByRole("button", { name: "Retry template setup" }),
    ).toBeEnabled();
  });

  it("clears a conflicted retry when dismissed but keeps its Layout in the library", async () => {
    const user = userEvent.setup();
    vi.mocked(api.layoutPage).mockResolvedValue({
      items: [
        savedLayout,
        layout({ id: "layout-announcement", name: "Assembly update" }),
      ],
      total: 2,
      page: 1,
      pageSize: 100,
    });
    vi.mocked(api.createLayout).mockResolvedValue(
      newAnnouncementLayout as never,
    );
    vi.mocked(api.layout).mockResolvedValue({
      ...(newAnnouncementLayout as unknown as Layout),
      draftRevision: 2,
    });
    vi.mocked(api.saveLayoutDraft).mockRejectedValueOnce(
      new Error("Temporary draft failure"),
    );
    renderPage();

    await user.click(
      await screen.findByRole("button", { name: "Create layout" }),
    );
    let dialog = await screen.findByRole("dialog", {
      name: "Create layout",
    });
    await user.type(
      within(dialog).getByRole("textbox", { name: "Name *" }),
      "Assembly update",
    );
    await user.click(
      within(dialog).getByRole("button", { name: /Announcement/ }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Create layout" }),
    );
    await within(dialog).findByText(
      /The Layout was created, but its announcement template could not be initialized/,
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Retry template setup" }),
    );
    expect(
      await within(dialog).findByText(
        "This Layout's draft changed after creation. Close this dialog and review the existing Layout in the library.",
      ),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await screen.findByRole("link", { name: "Edit Assembly update" });
    await user.click(screen.getByRole("button", { name: "Create layout" }));
    dialog = await screen.findByRole("dialog", { name: "Create layout" });
    const nameInput = within(dialog).getByRole("textbox", { name: "Name *" });
    expect(nameInput).toBeEnabled();
    expect(nameInput).toHaveValue("");
    await user.type(nameInput, "Fresh notice");
    expect(
      within(dialog).getByRole("button", { name: "Create layout" }),
    ).toBeEnabled();
    await user.click(
      within(dialog).getByRole("button", { name: "Create layout" }),
    );

    expect(api.createLayout).toHaveBeenCalledTimes(2);
    expect(api.saveLayoutDraft).toHaveBeenCalledOnce();
  });

  it("recognizes a template saved before the server response failed", async () => {
    const user = userEvent.setup();
    let currentLayout = newAnnouncementLayout as unknown as Layout;
    vi.mocked(api.createLayout).mockResolvedValue(
      newAnnouncementLayout as never,
    );
    vi.mocked(api.layout).mockImplementation(() =>
      Promise.resolve(currentLayout),
    );
    vi.mocked(api.saveLayoutDraft)
      .mockRejectedValue(new Error("Unexpected duplicate template save"))
      .mockImplementationOnce((_id, revision, document) => {
        currentLayout = {
          ...currentLayout,
          draft: document,
          draftRevision: revision + 1,
        };
        return Promise.reject(
          new Error("The response was lost after the draft was saved."),
        );
      });
    renderPage();

    await user.click(
      await screen.findByRole("button", { name: "Create layout" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Create layout",
    });
    await user.type(
      within(dialog).getByRole("textbox", { name: "Name *" }),
      "Assembly update",
    );
    await user.click(
      within(dialog).getByRole("button", { name: /Announcement/ }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Create layout" }),
    );
    expect(
      await within(dialog).findByText(
        /The Layout was created, but its announcement template could not be initialized/,
      ),
    ).toBeInTheDocument();

    await user.click(
      within(dialog).getByRole("button", { name: "Retry template setup" }),
    );
    await within(dialog).findByRole("button", { name: "Create layout" });

    expect(api.createLayout).toHaveBeenCalledTimes(1);
    expect(api.layout).toHaveBeenCalledWith("layout-announcement");
    expect(api.saveLayoutDraft).toHaveBeenCalledTimes(1);
  });

  it("labels each toolbar filter with its option label, not its value", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("link", { name: "Edit Lobby" });

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
      screen.queryByRole("link", { name: "Edit Lobby" }),
    ).not.toBeInTheDocument();
  });

  it("uses the shared search field for the layout library", async () => {
    renderPage();
    const search = await screen.findByRole("searchbox", {
      name: "Search layouts",
    });
    expect(search.closest('[data-slot="input-group"]')).not.toBeNull();
  });

  it("reports a failed library load as an error with retry, not as empty", async () => {
    vi.mocked(api.layoutPage).mockRejectedValueOnce(new Error("boom"));
    renderPage();

    expect(await screen.findByText("boom")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText("No layouts yet")).toBeNull();
  });

  it("renames a layout from its card menu", async () => {
    const user = userEvent.setup();
    renderPage();

    // Base UI menus open on the contextmenu event in this suite; the card
    // offers the same actions through right-click and the actions button.
    fireEvent.contextMenu(
      await screen.findByRole("link", { name: "Edit Lobby" }),
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
