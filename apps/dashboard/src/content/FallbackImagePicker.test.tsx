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
import type { ReactNode } from "react";
import { RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { Asset } from "../api/types";
import { WebsiteEditor } from "../pages/ContentPage";
import { YouTubeSourceEditor } from "./SourceEditors";

vi.mock("../components/content-picker", () => ({
  ContentPicker: (props: {
    open: boolean;
    mode: string;
    allowedTypes?: string[];
    selectedIds?: string[];
    title?: string;
    onConfirm: (items: { id: string; name: string }[]) => void;
    onClose: () => void;
  }) =>
    props.open ? (
      <div
        data-testid="media-picker"
        data-mode={props.mode}
        data-types={(props.allowedTypes ?? []).join(",")}
        data-selected={(props.selectedIds ?? []).join(",")}
        data-title={props.title ?? ""}
      >
        <button
          type="button"
          onClick={() =>
            props.onConfirm([{ id: "picked-1", name: "Picked poster" }])
          }
        >
          confirm-picked
        </button>
        <button type="button" onClick={props.onClose}>
          close-picker
        </button>
      </div>
    ) : null,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderEditor(editor: ReactNode) {
  const router = createMemoryRouter([{ path: "*", element: editor }]);
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function mockAssetNames(names: Record<string, string>) {
  return vi
    .spyOn(api, "asset")
    .mockImplementation((id: string) =>
      Promise.resolve({ id, name: names[id] ?? id } as Asset),
    );
}

const noop = () => {};

function youtubeAsset(fallbackImageAssetId?: string): Asset {
  return {
    id: "widget-1",
    name: "Lobby reel",
    description: "",
    type: "widget",
    widget: {
      provider: "youtube",
      configuration: {
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        startSeconds: 0,
        loop: false,
        muted: false,
        volume: 100,
        captions: false,
        captionLanguage: "",
        controls: false,
        failureBehavior: "fallback_image",
        playlistPlaybackMode: "until_end",
        fallbackImageAssetId,
      },
    },
  } as unknown as Asset;
}

describe("fallback image picker", () => {
  it("resolves the YouTube fallback by ID instead of listing images", async () => {
    const list = vi.spyOn(api, "assets");
    const detail = mockAssetNames({ "img-1": "Lobby poster" });
    renderEditor(
      <YouTubeSourceEditor
        asset={youtubeAsset("img-1")}
        csrf="csrf"
        onClose={noop}
        onSaved={noop}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Fallback image" });
    expect(await screen.findByText("Lobby poster")).toBeInTheDocument();
    expect(trigger).toHaveTextContent("Lobby poster");
    expect(detail.mock.calls.map(([id]) => id)).toEqual(["img-1"]);
    expect(list).not.toHaveBeenCalled();
  });

  it("picks a YouTube fallback through the single-image Media picker", async () => {
    const list = vi.spyOn(api, "assets");
    mockAssetNames({ "picked-1": "Picked poster" });
    renderEditor(
      <YouTubeSourceEditor csrf="csrf" onClose={noop} onSaved={noop} />,
    );
    const trigger = screen.getByRole("button", { name: "Fallback image" });
    expect(trigger).toHaveTextContent("None");
    fireEvent.click(trigger);
    const picker = await screen.findByTestId("media-picker");
    expect(picker).toHaveAttribute("data-mode", "single");
    expect(picker).toHaveAttribute("data-types", "image");
    expect(picker).toHaveAttribute("data-selected", "");
    expect(picker).toHaveAttribute("data-title", "Choose a fallback image");
    fireEvent.click(screen.getByRole("button", { name: "confirm-picked" }));
    expect(await screen.findByText("Picked poster")).toBeInTheDocument();
    expect(list).not.toHaveBeenCalled();
  });

  it("clears the YouTube fallback back to none", async () => {
    mockAssetNames({ "img-1": "Lobby poster" });
    renderEditor(
      <YouTubeSourceEditor
        asset={youtubeAsset("img-1")}
        csrf="csrf"
        onClose={noop}
        onSaved={noop}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Fallback image" });
    expect(await screen.findByText("Lobby poster")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(trigger).toHaveTextContent("None"));
    expect(
      screen.queryByRole("button", { name: "Remove" }),
    ).not.toBeInTheDocument();
  });

  it("shows the Website fallback trigger without listing images", () => {
    const list = vi.spyOn(api, "assets");
    renderEditor(<WebsiteEditor csrf="csrf" onClose={noop} onSaved={noop} />);
    expect(
      screen.getByRole("button", { name: "Fallback image" }),
    ).toHaveTextContent("None");
    expect(list).not.toHaveBeenCalled();
  });
});
