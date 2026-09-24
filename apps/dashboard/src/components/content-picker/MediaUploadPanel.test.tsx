// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { Asset } from "../../api/types";
import { MediaUploadDialog } from "./MediaUploadDialog";
import { attachmentState, MediaUploadPanel } from "./MediaUploadPanel";

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
});

const clip = () => new File(["12345678"], "Clip.mp4", { type: "video/mp4" });
const row = () =>
  screen.getByText("Clip.mp4").closest('[data-slot="attachment"]');
const choose = (file: File) =>
  fireEvent.change(screen.getByLabelText("Choose media files"), {
    target: { files: [file] },
  });

describe("MediaUploadPanel", () => {
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
    render(<MediaUploadPanel csrf="csrf" />);
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
    render(<MediaUploadPanel csrf="csrf" onAsset={onAsset} />);
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
    render(
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
    choose(clip());
    await waitFor(() => expect(row()).toHaveAttribute("data-state", "done"));
    expect(onAsset).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
  });
});
