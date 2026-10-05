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
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { Asset } from "../api/types";
import { ContentPage } from "./ContentPage";

const auth = vi.hoisted(() => ({ role: "owner" }));

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: {
      csrfToken: "csrf",
      user: { id: "u1", role: auth.role },
    },
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  auth.role = "owner";
});

const ARCHIVE_NOTE =
  "Archived and expired content stays here until you restore or permanently delete it.";
const LIBRARY_DESCRIPTION =
  "Uploaded images and videos available to playlists and Layouts.";

function asset(id: string, name: string): Asset {
  return {
    id,
    name,
    description: "",
    type: "image",
    originalFilename: `${id}.png`,
    declaredMimeType: "image/png",
    detectedMimeType: "image/png",
    sha256: "aabbcc",
    originalSize: 2048,
    width: 1920,
    height: 1080,
    metadata: {},
    processingStatus: "ready",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    variants: [],
    playlistUsage: 0,
    layoutUsage: [],
    tags: [],
    collectionIds: [],
  };
}

function mockLibrary({ active = 3, archived = 2 } = {}) {
  const make = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) =>
      asset(`${prefix}-${i + 1}`, `${prefix}-${i + 1}`),
    );
  vi.spyOn(api, "assets").mockImplementation((params) => {
    const items =
      params.get("archived") === "true"
        ? make("Old", archived)
        : make("Poster", active);
    return Promise.resolve({
      items,
      total: items.length,
      page: 1,
      pageSize: 48,
    });
  });
  vi.spyOn(api, "contentFolders").mockResolvedValue([]);
  vi.spyOn(api, "contentCollections").mockResolvedValue([]);
  vi.spyOn(api, "contentTags").mockResolvedValue([]);
}

function renderPage() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <ContentPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Media workspace anatomy", () => {
  it("owns one screen-reader-only H1 and no visible duplicate title", async () => {
    mockLibrary();
    renderPage();
    expect(await screen.findByText("Poster-1")).toBeInTheDocument();

    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent("Media");
    expect(headings[0]).toHaveClass("sr-only");
    expect(screen.queryByText("Media", { selector: "h2" })).toBeNull();
  });

  it("leads with the library toggle, asset count and upload action", async () => {
    mockLibrary({ active: 3 });
    renderPage();
    expect(await screen.findByText("Poster-1")).toBeInTheDocument();

    const toggle = screen.getByRole("group", { name: "Library view" });
    expect(toggle).toHaveAttribute("data-slot", "toggle-group");
    expect(toggle).toHaveAttribute("data-variant", "outline");
    expect(
      within(toggle).getByRole("button", { name: "Library" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(toggle).getByRole("button", { name: "Archive" }),
    ).toHaveAttribute("aria-pressed", "false");

    const count = screen.getByText("3 assets");
    expect(count).not.toHaveAttribute("aria-live");
    expect(count.closest("[aria-live]")).toBeNull();
    expect(count).not.toHaveAttribute("data-slot", "badge");
    expect(
      screen.getByRole("button", { name: "Upload assets" }),
    ).toBeInTheDocument();
  });

  it("no longer renders the generic library description", async () => {
    mockLibrary();
    renderPage();
    expect(await screen.findByText("Poster-1")).toBeInTheDocument();
    expect(screen.queryByText(LIBRARY_DESCRIPTION)).toBeNull();
    expect(screen.queryByText(ARCHIVE_NOTE)).toBeNull();
  });

  it("keeps the existing filters and display controls", async () => {
    mockLibrary();
    renderPage();
    expect(await screen.findByText("Poster-1")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "View" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Library view" })).toBeVisible();
  });

  it("hides Upload assets from users who cannot manage content", async () => {
    auth.role = "viewer";
    mockLibrary();
    renderPage();
    expect(await screen.findByText("Poster-1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload assets" })).toBeNull();
    expect(screen.getByText("3 assets")).toBeInTheDocument();
  });

  it("switches to the archive with its lifecycle note and no upload action", async () => {
    mockLibrary({ active: 3, archived: 2 });
    renderPage();
    expect(await screen.findByText("Poster-1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(await screen.findByText("Old-1")).toBeInTheDocument();
    expect(screen.getByText(ARCHIVE_NOTE)).toBeInTheDocument();
    expect(screen.getByText("2 assets")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload assets" })).toBeNull();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    expect(await screen.findByText("Poster-1")).toBeInTheDocument();
    expect(screen.queryByText(ARCHIVE_NOTE)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Upload assets" }),
    ).toBeInTheDocument();
  });

  it("explains an empty library with the upload path", async () => {
    mockLibrary({ active: 0 });
    renderPage();
    expect(await screen.findByText("No media yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose files" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Upload assets" }),
    ).toBeInTheDocument();
    expect(screen.getByText("0 assets")).toBeInTheDocument();
  });

  it("explains an empty archive once, without repeating the lifecycle note", async () => {
    mockLibrary({ archived: 0 });
    renderPage();
    expect(await screen.findByText("Poster-1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(await screen.findByText("Archive is empty")).toBeInTheDocument();
    expect(screen.queryByText(ARCHIVE_NOTE)).toBeNull();
  });

  it("places Organize beside Upload and drops the standalone organization row", async () => {
    mockLibrary();
    renderPage();
    expect(await screen.findByText("Poster-1")).toBeInTheDocument();

    expect(
      screen.queryByRole("button", { name: "Content organization" }),
    ).toBeNull();
    const organize = screen.getByRole("button", { name: "Organize" });
    const upload = screen.getByRole("button", { name: "Upload assets" });
    expect(organize.parentElement).toBe(upload.parentElement);
    expect(
      organize.compareDocumentPosition(upload) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(organize).toHaveAttribute("aria-haspopup", "menu");
  });

  it("keeps the existing organization actions behind the Organize menu", async () => {
    const user = userEvent.setup();
    mockLibrary();
    renderPage();
    expect(await screen.findByText("Poster-1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Organize" }));
    const menu = await screen.findByRole("menu", {
      name: "Organize",
    });
    for (const name of ["Create folder", "Create collection", "Create tag"]) {
      expect(within(menu).getByRole("menuitem", { name })).toBeInTheDocument();
    }
    await user.click(
      within(menu).getByRole("menuitem", { name: "Create folder" }),
    );
    expect(await screen.findByLabelText("Folder name")).toBeInTheDocument();
  });

  it("offers Organize only to managers in the Library view", async () => {
    mockLibrary();
    renderPage();
    expect(await screen.findByText("Poster-1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(await screen.findByText("Old-1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Organize" })).toBeNull();
  });

  it("hides Organize from viewers", async () => {
    auth.role = "viewer";
    mockLibrary();
    renderPage();
    expect(await screen.findByText("Poster-1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Organize" })).toBeNull();
  });

  it("hands over to the selection toolbar instead of duplicating Organize", async () => {
    mockLibrary();
    renderPage();
    expect(await screen.findByText("Poster-1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Poster-1" }));
    const bar = await screen.findByRole("toolbar", { name: "1 selected" });
    expect(screen.getAllByRole("button", { name: "Organize" })).toHaveLength(1);
    expect(
      within(bar).getByRole("button", { name: "Organize" }),
    ).toBeInTheDocument();
    expect(
      within(bar).getByRole("button", { name: "Archive" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Upload assets" }),
    ).toBeInTheDocument();

    fireEvent.click(within(bar).getByRole("button", { name: "Clear" }));
    expect(
      await screen.findByRole("button", { name: "Organize" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});
