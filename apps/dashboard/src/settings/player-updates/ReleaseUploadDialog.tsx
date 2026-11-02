import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { apiErrorMessage, useFormatLocale } from "../../i18n";
import { formatBytes } from "../../lib/formatBytes";
import type { UpdateFamilyTab } from "../../playerPlatform";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../../components/ui/dialog";
import { Field, FieldLabel } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import {
  ItemGroup,
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
} from "../../components/ui/item";
import { Progress } from "../../components/ui/progress";
import { Spinner } from "../../components/ui/spinner";
import { toast } from "../../components/ui/toast";
import { familyLabel } from "./model";
type ReleaseFileSlot = {
  label: string;
  matches: (name: string) => boolean;
  maxBytes?: number;
};
const RELEASE_FILES: Record<UpdateFamilyTab, readonly ReleaseFileSlot[]> = {
  android: [
    {
      label: "tilecast-player.apk",
      matches: (name) => name === "tilecast-player.apk",
    },
    {
      label: "tilecast-player-update.json",
      matches: (name) => name === "tilecast-player-update.json",
      maxBytes: 128 * 1024,
    },
    {
      label: "tilecast-player-update.json.sig",
      matches: (name) => name === "tilecast-player-update.json.sig",
      maxBytes: 4 * 1024,
    },
  ],
  linux: [
    {
      label: "tilecast-player.AppImage",
      matches: (name) => name === "tilecast-player.AppImage",
    },
    {
      label: "tilecast-player-update-linux.json",
      matches: (name) => name === "tilecast-player-update-linux.json",
      maxBytes: 128 * 1024,
    },
    {
      label: "tilecast-player-update-linux.json.sig",
      matches: (name) => name === "tilecast-player-update-linux.json.sig",
      maxBytes: 4 * 1024,
    },
  ],
  edge: [
    {
      label: "tilecast-edge-<version>-<arch>.tar.zst",
      matches: (name) =>
        /^tilecast-edge-\d{1,9}\.\d{1,9}\.\d{1,9}(-[0-9A-Za-z.]+)?-(x86_64|aarch64)\.tar\.zst$/.test(
          name,
        ),
    },
    {
      label: "tilecast-edge-update.json",
      matches: (name) => name === "tilecast-edge-update.json",
      maxBytes: 16 * 1024,
    },
    {
      label: "tilecast-edge-update.json.sig",
      matches: (name) => name === "tilecast-edge-update.json.sig",
      maxBytes: 4 * 1024,
    },
  ],
  windows: [
    {
      label: "tilecast-windows-<version>-<arch>.msix",
      matches: (name) =>
        /^tilecast-windows-\d{1,9}\.\d{1,9}\.\d{1,9}(-[0-9A-Za-z.]+)?-(x86_64|aarch64)\.msix$/.test(
          name,
        ),
    },
    {
      label: "tilecast-windows-update.json",
      matches: (name) => name === "tilecast-windows-update.json",
      maxBytes: 16 * 1024,
    },
    {
      label: "tilecast-windows-update.json.sig",
      matches: (name) => name === "tilecast-windows-update.json.sig",
      maxBytes: 4 * 1024,
    },
  ],
};

export function ReleaseUploadDialog({
  family,
  onClose,
  onImported,
}: {
  family: UpdateFamilyTab;
  onClose: () => void;
  onImported: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const locale = useFormatLocale();
  const auth = useAuth();
  const client = useQueryClient();
  const slots = RELEASE_FILES[family];
  const [files, setFiles] = useState<Record<string, File>>({});
  const [clientError, setClientError] = useState("");
  const [progress, setProgress] = useState(0);
  const [verifying, setVerifying] = useState(false);
  const upload = useMutation({
    mutationFn: () =>
      api.uploadPlayerRelease(
        slots.map((s) => files[s.label]!).filter(Boolean),
        auth.status?.csrfToken ?? "",
        (value) => {
          setProgress(value);
          if (value >= 100) setVerifying(true);
        },
      ),
    onMutate: () => {
      setProgress(0);
      setVerifying(false);
    },
    onSuccess: async () => {
      toast.add({ title: t("updates.panel.releaseUploaded"), type: "success" });
      await client.invalidateQueries({ queryKey: ["player-releases"] });
      onImported();
    },
  });
  function selectFiles(selected: FileList | File[]) {
    if (upload.isPending) return;
    const next = { ...files };
    let error = "";
    for (const file of Array.from(selected)) {
      const slot = slots.find((s) => s.matches(file.name));
      if (!slot) {
        error = t("updates.panel.unexpectedFile", { name: file.name });
        continue;
      }
      if (slot.maxBytes && file.size > slot.maxBytes) {
        error = t("updates.console.fileTooLarge", {
          name: file.name,
          size: formatBytes(slot.maxBytes, locale),
        });
        continue;
      }
      next[slot.label] = file;
    }
    setFiles(next);
    setClientError(error);
    upload.reset();
  }
  const ready = slots.every((s) => files[s.label]) && !clientError;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !upload.isPending && onClose()}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {t("updates.panel.uploadTitle", {
              platform: familyLabel(family, t),
            })}
          </DialogTitle>
          <DialogDescription>
            {t("updates.console.uploadHint")}
          </DialogDescription>
        </DialogHeader>
        <Field
          className="gap-2 rounded-md border border-dashed p-4"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            selectFiles(e.dataTransfer.files);
          }}
        >
          <FieldLabel htmlFor="release-files">
            {t("updates.panel.dropTitle")}
          </FieldLabel>
          <Input
            id="release-files"
            type="file"
            multiple
            disabled={upload.isPending}
            onChange={(e) => {
              if (e.target.files) selectFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </Field>
        <ItemGroup render={<ul />} className="gap-0 divide-y">
          {slots.map((slot, index) => (
            <Item key={slot.label} render={<li />} size="sm" className="px-0">
              <ItemContent>
                <ItemTitle>
                  {t(
                    index === 0
                      ? "updates.console.artifact"
                      : index === 1
                        ? "updates.console.manifest"
                        : "updates.console.signature",
                  )}
                </ItemTitle>
                <ItemDescription className="line-clamp-none break-all font-mono text-xs">
                  {files[slot.label]?.name ?? slot.label}
                </ItemDescription>
                <p className="text-xs text-muted-foreground">
                  {files[slot.label]
                    ? formatBytes(files[slot.label]!.size, locale)
                    : t("updates.panel.fileRequired")}
                </p>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
        {(clientError || upload.error) && (
          <Alert variant="destructive">
            <AlertDescription>
              {clientError || apiErrorMessage(upload.error)}
            </AlertDescription>
          </Alert>
        )}
        {upload.isPending &&
          (verifying ? (
            <p role="status" className="flex items-center gap-2 text-sm">
              <Spinner />
              {t("updates.console.verifyingRelease")}
            </p>
          ) : (
            <div className="grid gap-2">
              <Progress
                value={progress}
                aria-label={t("updates.panel.uploading", { progress })}
              />
              <p role="status" className="text-sm tabular-nums">
                {t("updates.panel.uploading", { progress })}
              </p>
            </div>
          ))}
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={upload.isPending}
            onClick={() => {
              setFiles({});
              setClientError("");
              upload.reset();
            }}
          >
            {t("updates.panel.clearFiles")}
          </Button>
          <Button
            disabled={!ready || upload.isPending}
            onClick={() => upload.mutate()}
          >
            {upload.isPending && <Spinner />}
            {t("updates.panel.uploadVerify")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
