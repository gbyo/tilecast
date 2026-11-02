// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { i18n } from "../../i18n";
import type { Asset } from "../../api/types";
import { MediaUploadDialog } from "./MediaUploadDialog";
import { attachmentState, MediaUploadPanel } from "./MediaUploadPanel";
import { mockAuthAs, mockWholeLibrary } from "../../test/capabilities";

beforeEach(() => {
  mockWholeLibrary();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const asset = (status: Asset["processingStatus"]): Asset => ({
  id: "asset-1",
  name: "Clip",
  description: "",
  type: "video",
  originalFilename: "Clip.mp4",
  declaredMimeType: "video/mp4",
  detectedMimeType: "video/mp4",
  sha256: "aa",
  originalSize: 8,
  metadata: {},
  processingStatus: status,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  variants: [],
  playlistUsage: 0,
  layoutUsage: [],
  tags: [],
  collectionIds: [],
});

function renderPanel(ui: React.ReactElement) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {ui}
    </QueryClientProvider>,
  );
}

// The upload destination is known once the account's access has loaded.
const ready = () =>
  waitFor(() =>
    expect(screen.getByRole("button", { name: "Choose files" })).toBeEnabled(),
  );

const clip = () => new File(["12345678"], "Clip.mp4", { type: "video/mp4" });
const row = () =>
  screen.getByText("Clip.mp4").closest('[data-slot="attachment"]');
const choose = (file: File) =>
  fireEvent.change(screen.getByLabelText("Choose media files"), {
    target: { files: [file] },
  });

describe("MediaUploadPanel", () => {
  it("updates file-size formatting when the Studio language changes", async () => {
    vi.spyOn(api, "createUpload").mockResolvedValue({
      id: "s1",
      offset: 0,
    } as Awaited<ReturnType<typeof api.createUpload>>);
    vi.spyOn(api, "uploadChunk").mockReturnValue(new Promise(() => undefined));
    renderPanel(<MediaUploadPanel csrf="csrf" />);
    await ready();
    choose(new File([new Uint8Array(1536)], "Clip.mp4", { type: "video/mp4" }));
    await waitFor(() => expect(row()).toHaveTextContent("1.5 KiB"));
    try {
      await act(() => i18n.changeLanguage("es"));
      await waitFor(() => expect(row()).toHaveTextContent("1,5 KiB"));
    } finally {
      await act(() => i18n.changeLanguage("en"));
    }
  });

  it("maps the Tilecast upload lifecycle onto Attachment states", () => {
    expect(attachmentState("waiting")).toBe("idle");
    expect(attachmentState("uploading")).toBe("uploading");
    expect(attachmentState("processing")).toBe("processing");
    expect(attachmentState("failed")).toBe("error");
    expect(attachmentState("ready")).toBe("done");
  });

  it("drives the generated Progress from transferred bytes", async () => {
    vi.spyOn(api, "createUpload").mockResolvedValue({
      id: "s1",
      offset: 4,
    } as Awaited<ReturnType<typeof api.createUpload>>);
    vi.spyOn(api, "uploadChunk").mockReturnValue(new Promise(() => undefined));
    renderPanel(<MediaUploadPanel csrf="csrf" />);
    await ready();
    choose(clip());

    await waitFor(() =>
      expect(row()).toHaveAttribute("data-state", "uploading"),
    );
    expect(
      screen.getByRole("progressbar", { name: "Upload progress for Clip.mp4" }),
    ).toHaveAttribute("aria-valuenow", "50");
    expect(
      screen.getByText("Uploading · 50% · 4 B of 8 B"),
    ).toBeInTheDocument();
    expect(document.querySelector("progress")).toBeNull();
  });

  it("does not report an upload that completes after unmount", async () => {
    vi.spyOn(api, "createUpload").mockResolvedValue({
      id: "s-unmount",
      offset: 8,
    } as Awaited<ReturnType<typeof api.createUpload>>);
    let resolveComplete!: (value: Asset) => void;
    vi.spyOn(api, "completeUpload").mockReturnValue(
      new Promise<Asset>((resolve) => {
        resolveComplete = resolve;
      }),
    );
    const onAsset = vi.fn();
    const rendered = renderPanel(
      <MediaUploadPanel csrf="csrf" onAsset={onAsset} />,
    );
    await ready();
    choose(clip());

    await waitFor(() => expect(api.completeUpload).toHaveBeenCalled());
    rendered.unmount();
    await act(async () => {
      resolveComplete(asset("ready"));
      await Promise.resolve();
    });

    expect(onAsset).not.toHaveBeenCalled();
  });

  it("retries a transfer failure from the same file", async () => {
    const create = vi
      .spyOn(api, "createUpload")
      .mockRejectedValueOnce(new Error("Network lost."))
      .mockResolvedValueOnce({
        id: "s2",
        offset: 8,
      } as Awaited<ReturnType<typeof api.createUpload>>);
    vi.spyOn(api, "completeUpload").mockResolvedValue(asset("ready"));
    const onAsset = vi.fn();
    renderPanel(<MediaUploadPanel csrf="csrf" onAsset={onAsset} />);
    await ready();
    choose(clip());

    await waitFor(() => expect(row()).toHaveAttribute("data-state", "error"));
    expect(screen.getByText("Network lost.")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry uploading Clip.mp4" }),
    );
    await waitFor(() => expect(row()).toHaveAttribute("data-state", "done"));
    expect(create).toHaveBeenCalledTimes(2);
    expect(onAsset).toHaveBeenCalledWith(
      expect.objectContaining({ id: "asset-1" }),
    );
    // Retrying replaces the row instead of adding a second one.
    expect(screen.getAllByText("Clip.mp4")).toHaveLength(1);
  });
});

describe("MediaUploadDialog", () => {
  it("hosts the same upload panel for the global Upload media command", async () => {
    vi.spyOn(api, "createUpload").mockResolvedValue({
      id: "s3",
      offset: 8,
    } as Awaited<ReturnType<typeof api.createUpload>>);
    vi.spyOn(api, "completeUpload").mockResolvedValue(asset("ready"));
    const onClose = vi.fn();
    const onAsset = vi.fn();
    renderPanel(
      <MediaUploadDialog
        open
        csrf="csrf"
        onAsset={onAsset}
        onClose={onClose}
      />,
    );
    expect(
      screen.getByRole("dialog", { name: "Upload media" }),
    ).toBeInTheDocument();
    await ready();
    choose(clip());
    await waitFor(() => expect(row()).toHaveAttribute("data-state", "done"));
    // The row can read done a tick before the asset callback runs.
    await waitFor(() => expect(onAsset).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("MediaUploadPanel destination", () => {
  const room313 = {
    id: "folder-313",
    name: "Room 313",
    description: "",
    assetCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const room314 = { ...room313, id: "folder-314", name: "Room 314" };

  function teacher(writableFolderIds: string[]) {
    mockAuthAs("classroom_media", [
      "media.read",
      "media.upload",
      "media.tags.assign",
    ]);
    vi.spyOn(api, "myAccess").mockResolvedValue({
      role: { key: "classroom_media", name: "Classroom Media", builtin: false },
      capabilities: ["media.read", "media.upload", "media.tags.assign"],
      content: {
        libraryMode: "restricted",
        tagMode: "restricted",
        writableFolderIds,
      },
    });
    vi.spyOn(api, "contentFolders").mockResolvedValue([room313, room314]);
  }

  const upload = () =>
    vi.spyOn(api, "createUpload").mockResolvedValue({
      id: "s1",
      offset: 0,
    } as Awaited<ReturnType<typeof api.createUpload>>);

  it("leaves the folder out for an account with the whole library", async () => {
    const create = upload();
    vi.spyOn(api, "uploadChunk").mockReturnValue(new Promise(() => undefined));
    renderPanel(<MediaUploadPanel csrf="csrf" />);
    await ready();
    choose(clip());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![0]).not.toHaveProperty("folderId");
    expect(screen.queryByLabelText("Upload to")).toBeNull();
  });

  it("uploads a restricted account's files into its only folder", async () => {
    teacher(["folder-313"]);
    const create = upload();
    vi.spyOn(api, "uploadChunk").mockReturnValue(new Promise(() => undefined));
    renderPanel(<MediaUploadPanel csrf="csrf" />);
    await ready();
    choose(clip());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![0]).toMatchObject({ folderId: "folder-313" });
    // One choice needs no chooser.
    expect(screen.queryByLabelText("Upload to")).toBeNull();
  });

  it("asks a restricted account with several folders to choose, and sends the choice", async () => {
    teacher(["folder-313", "folder-314"]);
    const create = upload();
    vi.spyOn(api, "uploadChunk").mockReturnValue(new Promise(() => undefined));
    renderPanel(<MediaUploadPanel csrf="csrf" />);

    const chooser = await screen.findByLabelText("Upload to");
    expect(screen.getByRole("button", { name: "Choose files" })).toBeDisabled();
    fireEvent.change(chooser, { target: { value: "folder-314" } });
    await ready();
    choose(clip());
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![0]).toMatchObject({ folderId: "folder-314" });
  });

  it("explains an account that has no folder to upload into", async () => {
    teacher([]);
    const create = upload();
    renderPanel(<MediaUploadPanel csrf="csrf" />);
    expect(
      await screen.findByText(/No folder is available to upload into/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose files" })).toBeDisabled();
    expect(create).not.toHaveBeenCalled();
  });
});
