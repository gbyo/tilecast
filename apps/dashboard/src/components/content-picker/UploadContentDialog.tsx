import { Upload, X } from "lucide-react";
import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import type { Asset } from "../../api/types";
import { apiErrorMessage } from "../../i18n";
import { useConfirm } from "../ConfirmDialog";
import { Button } from "../ui/button";
import { droppedFiles } from "../content/dragDrop";

type UploadItem = {
  id: string;
  name: string;
  size: number;
  uploaded: number;
  state: "waiting" | "uploading" | "processing" | "failed";
  error?: string;
};

const accepted =
  "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm,video/x-matroska";
const chunkSize = 4 * 1024 * 1024;

const stateKeys = {
  waiting: "picker.upload.stateWaiting",
  uploading: "picker.upload.stateUploading",
  processing: "picker.upload.stateProcessing",
  failed: "picker.upload.stateFailed",
} as const;

export function UploadContentDialog({
  csrf,
  closeLabel,
  onCreated,
  onClose,
}: {
  csrf: string;
  closeLabel?: string;
  onCreated: (asset: Asset) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const { t: tErrors } = useTranslation("errors");
  const { t } = useTranslation(["content", "common"]);
  const resolvedCloseLabel = closeLabel ?? t("picker.upload.closeLabel");
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const active = items.some((item) =>
    ["waiting", "uploading"].includes(item.state),
  );
  const close = () => {
    if (!active) {
      onClose();
      return;
    }
    void confirm({
      title: t("picker.upload.activeTitle"),
      action: t("common:actions.close"),
    }).then((ok) => {
      if (ok) onClose();
    });
  };
  const update = (id: string, value: Partial<UploadItem>) =>
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...value } : item)),
    );
  const upload = async (file: File) => {
    const id = crypto.randomUUID();
    const mimeType = file.type || "application/octet-stream";
    setItems((current) => [
      ...current,
      { id, name: file.name, size: file.size, uploaded: 0, state: "waiting" },
    ]);
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
      update(id, {
        state: "processing",
        uploaded: file.size,
      });
      onCreated(asset);
    } catch (error) {
      update(id, {
        state: "failed",
        error:
          error instanceof Error
            ? apiErrorMessage(error)
            : tErrors("fallback.uploadFailed"),
      });
    }
  };
  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    for (const file of Array.from(event.target.files ?? [])) void upload(file);
    event.target.value = "";
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    for (const file of droppedFiles(event.dataTransfer)) void upload(file);
  };
  return (
    <>
      {confirmDialog}
      <div
        className="content-picker-child-backdrop"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            close();
          }
          if (event.key === "Tab" && dialog.current) {
            const controls = [
              ...dialog.current.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
              ),
            ];
            const first = controls[0];
            const last = controls.at(-1);
            if (
              first &&
              last &&
              event.shiftKey &&
              document.activeElement === first
            ) {
              event.preventDefault();
              last.focus();
            } else if (
              first &&
              last &&
              !event.shiftKey &&
              document.activeElement === last
            ) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <section
          ref={dialog}
          className="upload-content-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="upload-content-title"
        >
          <header>
            <div>
              <h3 id="upload-content-title">{t("picker.upload.title")}</h3>
              <p>{t("picker.upload.description")}</p>
            </div>
            <Button
              autoFocus
              variant="ghost"
              size="icon-sm"
              aria-label={t("picker.upload.closeUploads")}
              onClick={close}
            >
              <X size={18} />
            </Button>
          </header>
          <button
            type="button"
            className="picker-upload-dropzone"
            onClick={() => input.current?.click()}
            onDragOver={(event) => event.preventDefault()}
            onDrop={drop}
          >
            <Upload size={24} />
            <strong>{t("picker.upload.dropHint")}</strong>
            <span>{t("picker.upload.dropFormats")}</span>
          </button>
          <input
            ref={input}
            className="visually-hidden"
            type="file"
            multiple
            accept={accepted}
            onChange={choose}
          />
          <div className="picker-upload-list" aria-live="polite">
            {items.map((item) => (
              <div key={item.id}>
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.error ?? t(stateKeys[item.state])}</small>
                </span>
                <progress value={item.uploaded} max={item.size} />
              </div>
            ))}
          </div>
          <footer>
            <Button variant="secondary" onClick={close}>
              {resolvedCloseLabel}
            </Button>
          </footer>
        </section>
      </div>
    </>
  );
}
