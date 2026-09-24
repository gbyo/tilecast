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

describe("ContentPicker", () => {
  it("mounts the overlay at the document root above route chrome", async () => {
    vi.spyOn(api, "assets").mockResolvedValue({
      items: [welcome],
      total: 1,
      page: 1,
      pageSize: 48,
    });
    const { container } = picker("multiple");

    await screen.findByRole("button", { name: /Welcome/ });
    expect(container.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(
      document.body.querySelector('[data-slot="dialog-content"]'),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Choose content" })).toBeTruthy();
  });

  it("selects and confirms multiple reusable content items", async () => {
    vi.spyOn(api, "assets").mockResolvedValue({
      items,
      total: 2,
      page: 1,
      pageSize: 48,
    });
    const confirm = vi.fn().mockResolvedValue({ failures: [] });
    picker("multiple", confirm);
    fireEvent.click(await screen.findByRole("button", { name: /Welcome/ }));
    fireEvent.click(screen.getByRole("button", { name: /Menu/ }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Add to playlist (2)" }),
    );
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(items));
  });

  it("keeps only the latest selection in single mode", async () => {
    vi.spyOn(api, "assets").mockResolvedValue({
      items,
      total: 2,
      page: 1,
      pageSize: 48,
    });
    picker("single");
    fireEvent.click(await screen.findByRole("button", { name: /Welcome/ }));
    fireEvent.click(screen.getByRole("button", { name: /Menu/ }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(document.querySelector(".selected-content-tray")).toHaveTextContent(
      "Menu",
    );
    expect(
      document.querySelector(".selected-content-tray"),
    ).not.toHaveTextContent("Welcome");
  });

  it("filters the library by folder and tag", async () => {
    const assets = vi.spyOn(api, "assets").mockResolvedValue({
      items,
      total: 2,
      page: 1,
      pageSize: 48,
    });
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

  it("scopes the request and the type tabs to what the caller accepts", async () => {
    const assets = vi.spyOn(api, "assets").mockResolvedValue({
      items: [menuApp],
      total: 1,
      page: 1,
      pageSize: 48,
    });
    vi.spyOn(api, "contentFolders").mockResolvedValue([]);
    vi.spyOn(api, "contentCollections").mockResolvedValue([]);
    vi.spyOn(api, "contentTags").mockResolvedValue([]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <ContentPicker
          open
          mode="multiple"
          csrf="csrf"
          allowedTypes={["widget"]}
          title="Choose apps"
          onConfirm={vi.fn()}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );

    // Without the server-side scope an "All" page of mixed content is filtered down
    // client-side and a widgets-only picker looks empty.
    await waitFor(() =>
      expect(assets.mock.lastCall?.[0].get("type")).toBe("widget"),
    );
    expect(screen.getByText("Choose apps")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Images" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Websites" }),
    ).toBeInTheDocument();
    // Apps are not uploaded, so the media upload action is not offered here.
    expect(
      screen.queryByRole("button", { name: /Upload media/ }),
    ).not.toBeInTheDocument();
  });

  it("asks the server for media only when apps are not allowed", async () => {
    const assets = vi.spyOn(api, "assets").mockResolvedValue({
      items: [welcome],
      total: 1,
      page: 1,
      pageSize: 48,
    });
    vi.spyOn(api, "contentFolders").mockResolvedValue([]);
    vi.spyOn(api, "contentCollections").mockResolvedValue([]);
    vi.spyOn(api, "contentTags").mockResolvedValue([]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <ContentPicker
          open
          mode="multiple"
          csrf="csrf"
          allowedTypes={["image", "video"]}
          onConfirm={vi.fn()}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(assets.mock.lastCall?.[0].get("type")).toBe("media"),
    );
    expect(
      screen.queryByRole("button", { name: "Websites" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Images" })).toBeInTheDocument();
  });
});
