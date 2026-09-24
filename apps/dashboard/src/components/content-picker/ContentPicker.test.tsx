// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { Asset } from "../../api/types";
import { ContentPicker } from "./ContentPicker";

const asset = (id: string, name: string, type: Asset["type"]): Asset => ({
  id,
  name,
  description: "",
  type,
  originalFilename: type === "widget" ? "" : `${name}.png`,
  declaredMimeType: type === "widget" ? "application/json" : "image/png",
  detectedMimeType: type === "widget" ? "application/json" : "image/png",
  sha256: "aabb",
  originalSize: 100,
  metadata: {},
  processingStatus: "ready",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  variants: [],
  widget:
    type === "widget"
      ? { provider: "website", configVersion: 1, configuration: {} as never }
      : undefined,
});

const welcome = asset("one", "Welcome", "image");
const menuApp = asset("two", "Menu", "widget");
const items = [welcome, menuApp];

function picker(mode: "single" | "multiple", onConfirm = vi.fn()) {
  vi.spyOn(api, "contentFolders").mockResolvedValue([]);
  vi.spyOn(api, "contentCollections").mockResolvedValue([]);
  vi.spyOn(api, "contentTags").mockResolvedValue([]);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ContentPicker
        open
        mode={mode}
        csrf="csrf"
        confirmLabel="Add to playlist"
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPicker(
  props: Partial<Parameters<typeof ContentPicker>[0]> = {},
) {
  vi.spyOn(api, "contentFolders").mockResolvedValue([]);
  vi.spyOn(api, "contentCollections").mockResolvedValue([]);
  vi.spyOn(api, "contentTags").mockResolvedValue([]);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onClose = vi.fn();
  const onConfirm = vi.fn().mockResolvedValue({ failures: [] });
  render(
    <QueryClientProvider client={client}>
      <ContentPicker
        open
        mode="multiple"
        csrf="csrf"
        confirmLabel="Add to playlist"
        onConfirm={onConfirm}
        onClose={onClose}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onClose, onConfirm };
}

const listing = (assets: Asset[]) => ({
  items: assets,
  total: assets.length,
  page: 1,
  pageSize: 48,
});

describe("ContentPicker", () => {
  it("mounts the overlay at the document root above route chrome", async () => {
    vi.spyOn(api, "assets").mockResolvedValue(listing([welcome]));
    const { container } = picker("multiple");

    await screen.findByRole("checkbox", { name: "Welcome" });
    expect(container.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(
      document.body.querySelector('[data-slot="dialog-content"]'),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Choose content" })).toBeTruthy();
  });

  it("selects and confirms multiple reusable content items", async () => {
    vi.spyOn(api, "assets").mockResolvedValue(listing(items));
    const confirm = vi.fn().mockResolvedValue({ failures: [] });
    picker("multiple", confirm);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Welcome" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Menu" }));
    expect(screen.getByRole("checkbox", { name: "Welcome" })).toBeChecked();
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Add to playlist (2)" }),
    );
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(items));
  });

  it("toggles an entry by clicking anywhere on its card", async () => {
    vi.spyOn(api, "assets").mockResolvedValue(listing([welcome]));
    picker("multiple");
    const box = await screen.findByRole("checkbox", { name: "Welcome" });
    fireEvent.click(screen.getByText("Welcome"));
    expect(box).toBeChecked();
    // The card holds exactly one control, never a button around a checkbox.
    const card = box.closest('[data-slot="card"]')!;
    expect(card.querySelectorAll("button")).toHaveLength(
      card.querySelectorAll('button[role="checkbox"]').length,
    );
  });

  it("keeps only the latest selection in single mode", async () => {
    vi.spyOn(api, "assets").mockResolvedValue(listing(items));
    picker("single");
    fireEvent.click(await screen.findByRole("checkbox", { name: "Welcome" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Menu" }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    const selection = screen.getByRole("list", { name: "Selected content" });
    expect(selection).toHaveTextContent("Menu");
    expect(selection).not.toHaveTextContent("Welcome");
    fireEvent.click(
      within(selection).getByRole("button", {
        name: "Remove Menu from selection",
      }),
    );
    expect(screen.getByText("0 selected")).toBeInTheDocument();
  });

  it("switches between the Card grid and the Item list", async () => {
    vi.spyOn(api, "assets").mockResolvedValue(listing(items));
    picker("multiple");
    const box = await screen.findByRole("checkbox", { name: "Welcome" });
    expect(box.closest('[data-slot="card"]')).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "List view" }));
    const entry = screen
      .getByRole("checkbox", { name: "Welcome" })
      .closest('[role="listitem"]');
    expect(entry).not.toBeNull();
    expect(entry?.closest('[data-slot="card"]')).toBeNull();
  });

  it("disables unready and already-added content with a visible reason", async () => {
    vi.spyOn(api, "assets").mockResolvedValue(
      listing([{ ...welcome, processingStatus: "processing" }, menuApp]),
    );
    renderPicker({ disabledItemIds: [menuApp.id] });

    const processing = await screen.findByRole("checkbox", { name: "Welcome" });
    expect(processing).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Processing")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Menu" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByText(/Already added/)).toBeInTheDocument();
  });

  it("filters the library by folder and tag", async () => {
    const assets = vi.spyOn(api, "assets").mockResolvedValue(listing(items));
    vi.spyOn(api, "contentFolders").mockResolvedValue([
      {
        id: "folder-1",
        name: "Campus A",
        description: "",
        assetCount: 1,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ]);
    vi.spyOn(api, "contentCollections").mockResolvedValue([]);
    vi.spyOn(api, "contentTags").mockResolvedValue([
      { id: "tag-1", name: "Lobby", color: "#dc2626", assetCount: 1 },
    ]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <ContentPicker
          open
          mode="multiple"
          csrf="csrf"
          onConfirm={vi.fn()}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();

    expect(
      screen.queryByRole("combobox", { name: "Filter by collection" }),
    ).not.toBeInTheDocument();
    await user.click(
      await screen.findByRole("combobox", { name: "Filter by tag" }),
    );
    await user.click(await screen.findByRole("option", { name: "Lobby" }));
    await waitFor(() =>
      expect(assets.mock.lastCall?.[0].get("tagId")).toBe("tag-1"),
    );

    await user.click(
      screen.getByRole("combobox", { name: "Filter by folder" }),
    );
    await user.click(await screen.findByRole("option", { name: "Campus A" }));
    await waitFor(() =>
      expect(assets.mock.lastCall?.[0].get("folderId")).toBe("folder-1"),
    );
    expect(assets.mock.lastCall?.[0].get("tagId")).toBe("tag-1");
  });

  it("searches and filters by type from the toolbar", async () => {
    const assets = vi.spyOn(api, "assets").mockResolvedValue(listing(items));
    renderPicker();
    const user = userEvent.setup();

    await screen.findByRole("checkbox", { name: "Welcome" });
    await user.type(
      screen.getByRole("searchbox", { name: "Search content" }),
      "lobby",
    );
    await waitFor(() =>
      expect(assets.mock.lastCall?.[0].get("search")).toBe("lobby"),
    );
    await user.click(screen.getByRole("combobox", { name: "Content type" }));
    await user.click(await screen.findByRole("option", { name: "Videos" }));
    await waitFor(() =>
      expect(assets.mock.lastCall?.[0].get("type")).toBe("video"),
    );
  });

  it("scopes the request and the type filter to what the caller accepts", async () => {
    const assets = vi
      .spyOn(api, "assets")
      .mockResolvedValue(listing([menuApp]));
    renderPicker({ allowedTypes: ["widget"], title: "Choose apps" });
    const user = userEvent.setup();

    // Without the server-side scope an "All" page of mixed content is filtered down
    // client-side and a widgets-only picker looks empty.
    await waitFor(() =>
      expect(assets.mock.lastCall?.[0].get("type")).toBe("widget"),
    );
    expect(screen.getByText("Choose apps")).toBeInTheDocument();
    await user.click(
      await screen.findByRole("combobox", { name: "Content type" }),
    );
    expect(
      await screen.findByRole("option", { name: "Websites" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Images" })).toBeNull();
    // Apps are not uploaded, so the Upload tab is not offered here.
    expect(screen.queryByRole("tab", { name: /Upload/ })).toBeNull();
  });

  it("asks the server for media only when apps are not allowed", async () => {
    const assets = vi
      .spyOn(api, "assets")
      .mockResolvedValue(listing([welcome]));
    renderPicker({ allowedTypes: ["image", "video"] });
    const user = userEvent.setup();

    await waitFor(() =>
      expect(assets.mock.lastCall?.[0].get("type")).toBe("media"),
    );
    await user.click(
      await screen.findByRole("combobox", { name: "Content type" }),
    );
    expect(
      await screen.findByRole("option", { name: "Images" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Websites" })).toBeNull();
  });
});

describe("ContentPicker states", () => {
  it("shows skeletons while the library loads", async () => {
    vi.spyOn(api, "assets").mockReturnValue(new Promise(() => undefined));
    renderPicker();
    expect(await screen.findByLabelText("Loading content")).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });

  it("uses Empty with a path to upload when nothing exists", async () => {
    vi.spyOn(api, "assets").mockResolvedValue(listing([]));
    renderPicker();
    expect(await screen.findByText("No content yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Upload media" }));
    expect(screen.getByRole("tab", { name: /Upload/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("offers to clear filters when a search has no results", async () => {
    vi.spyOn(api, "assets").mockResolvedValue(listing([]));
    renderPicker();
    fireEvent.change(
      await screen.findByRole("searchbox", { name: "Search content" }),
      { target: { value: "nothing" } },
    );
    expect(await screen.findByText("No matching content")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(
      screen.getByRole("searchbox", { name: "Search content" }),
    ).toHaveValue("");
  });

  it("reports load failures in an Alert with a retry", async () => {
    const assets = vi
      .spyOn(api, "assets")
      .mockRejectedValue(new Error("offline"));
    renderPicker();
    expect(
      await screen.findByText("Content could not be loaded."),
    ).toBeInTheDocument();
    assets.mockResolvedValue(listing([welcome]));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("checkbox", { name: "Welcome" }),
    ).toBeInTheDocument();
  });
});

describe("ContentPicker upload tab", () => {
  const file = () => new File(["abc"], "Fresh.png", { type: "image/png" });

  function mockUpload(
    polls: Array<Partial<Asset>>,
    initial: Partial<Asset> = { processingStatus: "inspecting" },
  ) {
    vi.spyOn(api, "createUpload").mockResolvedValue({
      id: "session-1",
      offset: 0,
    } as Awaited<ReturnType<typeof api.createUpload>>);
    vi.spyOn(api, "uploadChunk").mockResolvedValue(3);
    const created = asset("fresh", "Fresh", "image");
    vi.spyOn(api, "completeUpload").mockResolvedValue({
      ...created,
      ...initial,
    });
    const poll = vi.spyOn(api, "asset");
    for (const next of polls)
      poll.mockResolvedValueOnce({ ...created, ...next });
    return created;
  }

  const row = () =>
    screen.getByText("Fresh.png").closest('[data-slot="attachment"]');

  it("switches to an Upload tab inside the same dialog", async () => {
    vi.spyOn(api, "assets").mockResolvedValue(listing([welcome]));
    renderPicker();
    fireEvent.click(await screen.findByRole("tab", { name: /Upload/ }));
    expect(
      screen.getByRole("button", { name: "Choose files" }),
    ).toBeInTheDocument();
    // No dialog opens on top of the picker.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("keeps an upload processing until the server reports it ready, then selects it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.spyOn(api, "assets").mockResolvedValue(listing([welcome]));
      mockUpload([
        { processingStatus: "processing", processingProgress: 40 },
        {
          processingStatus: "ready",
          width: 1600,
          height: 900,
          thumbnailUrl: "/thumb.png",
        },
      ]);
      const { onConfirm } = renderPicker();
      fireEvent.click(await screen.findByRole("tab", { name: /Upload/ }));
      fireEvent.change(screen.getByLabelText("Choose media files"), {
        target: { files: [file()] },
      });

      await waitFor(() =>
        expect(row()).toHaveAttribute("data-state", "processing"),
      );
      expect(screen.getByText("1 selected")).toBeInTheDocument();
      // Still processing on the server, so it cannot be confirmed yet.
      expect(
        screen.getByRole("button", { name: "Add to playlist (1)" }),
      ).toBeDisabled();

      await vi.advanceTimersByTimeAsync(1600);
      await waitFor(() =>
        expect(screen.getByText("Processing · 40%")).toBeInTheDocument(),
      );
      expect(row()).toHaveAttribute("data-state", "processing");

      await vi.advanceTimersByTimeAsync(1600);
      await waitFor(() => expect(row()).toHaveAttribute("data-state", "done"));
      expect(screen.getByText("Ready · Image · 1600×900")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("tab", { name: /Library/ }));
      expect(screen.getByRole("checkbox", { name: "Fresh" })).toBeChecked();
      const add = screen.getByRole("button", { name: "Add to playlist (1)" });
      expect(add).toBeEnabled();
      fireEvent.click(add);
      await waitFor(() =>
        expect(onConfirm).toHaveBeenCalledWith([
          expect.objectContaining({ id: "fresh", processingStatus: "ready" }),
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a processing failure as an error Attachment", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.spyOn(api, "assets").mockResolvedValue(listing([welcome]));
      mockUpload([
        { processingStatus: "failed", errorMessage: "The video is corrupt." },
      ]);
      renderPicker();
      fireEvent.click(await screen.findByRole("tab", { name: /Upload/ }));
      fireEvent.change(screen.getByLabelText("Choose media files"), {
        target: { files: [file()] },
      });
      await vi.advanceTimersByTimeAsync(1600);
      await waitFor(() => expect(row()).toHaveAttribute("data-state", "error"));
      expect(screen.getByText("The video is corrupt.")).toBeInTheDocument();
      // It can never be confirmed, so it leaves the selection.
      expect(screen.getByText("0 selected")).toBeInTheDocument();
      // A server-side failure is not retried with the same file.
      expect(
        screen.queryByRole("button", { name: "Retry uploading Fresh.png" }),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks before closing while a file is still transferring", async () => {
    vi.spyOn(api, "assets").mockResolvedValue(listing([welcome]));
    vi.spyOn(api, "createUpload").mockReturnValue(new Promise(() => undefined));
    const { onClose } = renderPicker();
    fireEvent.click(await screen.findByRole("tab", { name: /Upload/ }));
    fireEvent.change(screen.getByLabelText("Choose media files"), {
      target: { files: [file()] },
    });
    await waitFor(() => expect(row()).toHaveAttribute("data-state", "idle"));

    // Switching tabs never drops the transfer.
    fireEvent.click(screen.getByRole("tab", { name: /Library/ }));
    fireEvent.click(screen.getByRole("tab", { name: /Upload/ }));
    expect(row()).toHaveAttribute("data-state", "idle");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      await screen.findByRole("alertdialog", {
        name: "Uploads are still active. Close this upload view?",
      }),
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
