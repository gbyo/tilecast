import {
  CircleCheck,
  Clock,
  FileUp,
  FileWarning,
  RotateCcw,
  Upload,
  X,
} from "lucide-react";
import { cn } from "cn";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { api } from "../../api/client";
import type { Asset, AssetStatus } from "../../api/types";
import { droppedFiles } from "../content/dragDrop";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "../ui/attachment";
import { Button } from "../ui/button";
import { Progress } from "../ui/progress";
import { Spinner } from "../ui/spinner";

export type MediaUploadState =
  "waiting" | "uploading" | "processing" | "failed" | "ready";

export type MediaUpload = {
  id: string;
  file: File;
  uploaded: number;
  state: MediaUploadState;
  /** Set once the server accepts the upload and creates the library asset. */
  asset?: Asset;
  error?: string;
};

const accepted =
  "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm,video/x-matroska";
const chunkSize = 4 * 1024 * 1024;
const pollIntervalMs = 1500;
const pollAttempts = 400;
const settled = new Set<AssetStatus>(["ready", "failed", "deleted"]);

// Upload rows map Tilecast's lifecycle onto the generated Attachment states.
// Server-side inspection and encoding stay "processing" until the asset is
// actually ready, so a row never claims completion early.
export function attachmentState(state: MediaUploadState) {
  return (
    {
      waiting: "idle",
      uploading: "uploading",
      processing: "processing",
      failed: "error",
      ready: "done",
    } as const
  )[state];
}

export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
}

function processingLabel(asset?: Asset) {
  const status = asset?.processingStatus;
  const stage =
    status === "inspecting"
      ? "Inspecting"
      : status === "queued" || status === "uploaded"
        ? "Waiting for processing"
        : "Processing";
  return asset?.processingProgress != null
    ? `${stage} · ${Math.round(asset.processingProgress)}%`
    : stage;
}

function readyLabel(asset?: Asset) {
  if (!asset) return "Ready";
  const parts = ["Ready", asset.type === "video" ? "Video" : "Image"];
  if (asset.width && asset.height) parts.push(`${asset.width}×${asset.height}`);
  if (asset.durationSeconds != null) {
    const seconds = Math.round(asset.durationSeconds);
    parts.push(
      `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`,
    );
  }
  return parts.join(" · ");
}

/**
 * MediaUploadPanel uploads images and videos into the library and follows
 * each new asset until the server finishes processing it. It is surface-free:
 * the Content Picker shows it in its Upload tab and the global Upload media
 * command shows it inside a Dialog.
 */
export function MediaUploadPanel({
  csrf,
  onAsset,
  onActiveChange,
  className,
}: {
  csrf: string;
  /** Called when an upload creates an asset and whenever its status changes. */
  onAsset?: (asset: Asset) => void;
  /** Reports whether a file is still transferring, for close protection. */
  onActiveChange?: (active: boolean) => void;
  className?: string;
}) {
  const [uploads, setUploads] = useState<MediaUpload[]>([]);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const onAssetRef = useRef(onAsset);
  useEffect(() => {
    onAssetRef.current = onAsset;
  }, [onAsset]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const active = uploads.some(
    (upload) => upload.state === "waiting" || upload.state === "uploading",
  );
  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  const update = useCallback((id: string, value: Partial<MediaUpload>) => {
    if (!mounted.current) return;
    setUploads((current) =>
      current.map((upload) =>
        upload.id === id ? { ...upload, ...value } : upload,
      ),
    );
  }, []);

  const follow = useCallback(
    async (id: string, asset: Asset) => {
      let latest = asset;
      for (
        let attempt = 0;
        attempt < pollAttempts && !settled.has(latest.processingStatus);
        attempt += 1
      ) {
        await new Promise((resolve) =>
          window.setTimeout(resolve, pollIntervalMs),
        );
        if (!mounted.current) return;
        const next = await api.asset(asset.id).catch(() => undefined);
        if (!next) continue;
        latest = next;
        update(id, { asset: latest });
        onAssetRef.current?.(latest);
      }
      if (latest.processingStatus === "ready") {
        update(id, { state: "ready", asset: latest });
      } else if (settled.has(latest.processingStatus)) {
        update(id, {
          state: "failed",
          asset: latest,
          error:
            latest.errorMessage ||
            "Processing failed. Check the file and try again.",
        });
      }
    },
    [update],
  );

  const upload = useCallback(
    async (file: File, id: string = crypto.randomUUID()) => {
      const mimeType = file.type || "application/octet-stream";
      setUploads((current) => {
        const next: MediaUpload = { id, file, uploaded: 0, state: "waiting" };
        return current.some((item) => item.id === id)
          ? current.map((item) => (item.id === id ? next : item))
          : [...current, next];
      });
      try {
        const session = await api.createUpload(
          { filename: file.name, mimeType, sizeBytes: file.size },
          csrf,
        );
        let offset = session.offset;
        update(id, { state: "uploading", uploaded: offset });
        while (offset < file.size) {
          const next = Math.min(file.size, offset + chunkSize);
          offset = await api.uploadChunk(
            session.id,
            offset,
            file.slice(offset, next),
            csrf,
          );
          update(id, { uploaded: offset });
        }
        const asset = await api.completeUpload(session.id, csrf);
        update(id, { state: "processing", uploaded: file.size, asset });
        onAssetRef.current?.(asset);
        await follow(id, asset);
      } catch (error) {
        update(id, {
          state: "failed",
          error:
            error instanceof Error
              ? error.message
              : "Upload failed. Check the file and try again.",
        });
      }
    },
    [csrf, follow, update],
  );

  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    for (const file of Array.from(event.target.files ?? [])) void upload(file);
    event.target.value = "";
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    for (const file of droppedFiles(event.dataTransfer)) void upload(file);
  };
  const dismiss = (id: string) =>
    setUploads((current) => current.filter((upload) => upload.id !== id));

  return (
    <div className={cn("grid content-start gap-4", className)}>
      <div
        data-dragging={dragging || undefined}
        className={cn(
          "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 text-center transition-colors data-dragging:border-primary data-dragging:bg-muted",
          uploads.length ? "py-6" : "py-12",
        )}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
      >
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-foreground">
          <Upload className="size-5" aria-hidden="true" />
        </div>
        <div className="grid gap-1">
          <p className="text-sm font-medium">Drop images or videos here</p>
          <p className="text-sm text-muted-foreground">
            JPEG, PNG, WebP, GIF, MP4, MOV, WebM, or MKV. Multiple files are
            supported.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => input.current?.click()}
        >
          <FileUp aria-hidden="true" />
          Choose files
        </Button>
        {/* The native file input is the browser primitive for file choice; the
            visible button above opens it. */}
        <input
          ref={input}
          className="sr-only"
          tabIndex={-1}
          type="file"
          multiple
          accept={accepted}
          aria-label="Choose media files"
          onChange={choose}
        />
      </div>

      {uploads.length > 0 && (
        <section aria-label="Uploads" className="grid gap-2">
          {uploads.map((item) => (
            <MediaUploadRow
              key={item.id}
              item={item}
              onRetry={() => void upload(item.file, item.id)}
              onDismiss={() => dismiss(item.id)}
            />
          ))}
        </section>
      )}
    </div>
  );
}

function MediaUploadRow({
  item,
  onRetry,
  onDismiss,
}: {
  item: MediaUpload;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const percent = item.file.size
    ? Math.round((item.uploaded / item.file.size) * 100)
    : 100;
  const name = item.file.name;
  // A failure before the server created an asset can be retried from the
  // same file; a processing failure needs a different file.
  const retryable = item.state === "failed" && !item.asset;
  const settledRow = item.state === "failed" || item.state === "ready";

  return (
    <Attachment
      state={attachmentState(item.state)}
      className="w-full"
      aria-label={name}
    >
      <AttachmentMedia
        variant={
          item.state === "ready" && item.asset?.thumbnailUrl ? "image" : "icon"
        }
      >
        {item.state === "waiting" ? (
          <Clock aria-hidden="true" />
        ) : item.state === "uploading" || item.state === "processing" ? (
          <Spinner aria-hidden="true" />
        ) : item.state === "failed" ? (
          <FileWarning aria-hidden="true" />
        ) : item.asset?.thumbnailUrl ? (
          <img src={item.asset.thumbnailUrl} alt="" />
        ) : (
          <CircleCheck aria-hidden="true" />
        )}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{name}</AttachmentTitle>
        <AttachmentDescription role="status">
          {item.state === "waiting"
            ? `Waiting to upload · ${formatBytes(item.file.size)}`
            : item.state === "uploading"
              ? `Uploading · ${percent}% · ${formatBytes(item.uploaded)} of ${formatBytes(item.file.size)}`
              : item.state === "processing"
                ? processingLabel(item.asset)
                : item.state === "failed"
                  ? item.error
                  : readyLabel(item.asset)}
        </AttachmentDescription>
        {item.state === "uploading" && (
          <Progress
            className="mt-2"
            aria-label={`Upload progress for ${name}`}
            value={percent}
          />
        )}
        {item.state === "processing" &&
          item.asset?.processingProgress != null && (
            <Progress
              className="mt-2"
              aria-label={`Processing progress for ${name}`}
              value={Math.round(item.asset.processingProgress)}
            />
          )}
      </AttachmentContent>
      {settledRow && (
        <AttachmentActions>
          {retryable && (
            <AttachmentAction
              aria-label={`Retry uploading ${name}`}
              onClick={onRetry}
            >
              <RotateCcw aria-hidden="true" />
            </AttachmentAction>
          )}
          <AttachmentAction aria-label={`Dismiss ${name}`} onClick={onDismiss}>
            <X aria-hidden="true" />
          </AttachmentAction>
        </AttachmentActions>
      )}
    </Attachment>
  );
}
