import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { Alert, AlertDescription } from "../components/ui/alert";
import { AspectRatio } from "../components/ui/aspect-ratio";
import { Button } from "../components/ui/button";
import {
  clearLoginBackground,
  getLoginBackground,
  setLoginBackground,
  type LoginBackground,
} from "../api/loginBackground";
import type { Asset } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { toast } from "../components/ui/toast";

const chunkSize = 5 * 1024 * 1024;

export function BrandingAssets({
  values,
  editable,
  onChange,
}: {
  values: Record<string, unknown>;
  editable: boolean;
  onChange: (key: string, value: unknown) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const auth = useAuth();
  const queryClient = useQueryClient();
  const background = useQuery({
    queryKey: ["login-background"],
    queryFn: getLoginBackground,
  });
  const saveBackground = useMutation({
    mutationFn: (assetId: string) =>
      setLoginBackground(assetId, auth.status?.csrfToken ?? ""),
    onSuccess: (result) => {
      queryClient.setQueryData(["login-background"], result);
      toast.add({ title: "Login background saved.", type: "success" });
    },
  });
  const removeBackground = useMutation({
    mutationFn: () => clearLoginBackground(auth.status?.csrfToken ?? ""),
    onSuccess: () => {
      toast.add({ title: "Login background removed.", type: "success" });
      queryClient.setQueryData(["login-background"], {
        imageUrl: "/api/v1/auth/background",
      } satisfies LoginBackground);
    },
  });

  return (
    <section className="grid gap-4 rounded-xl border border-border p-4">
      <header className="grid gap-1">
        <h3 className="text-base font-semibold">{t("branding.title")}</h3>
        <p className="text-sm text-muted-foreground">
          {t("branding.description")}
        </p>
      </header>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <BrandingAssetUpload
          titleKey="branding.logo.title"
          descriptionKey="branding.logo.description"
          value={stringValue(values["branding.logo_asset_id"])}
          editable={editable}
          onSelect={(assetId) => onChange("branding.logo_asset_id", assetId)}
          onRemove={() => onChange("branding.logo_asset_id", "")}
        />
        <BrandingAssetUpload
          titleKey="branding.icon.title"
          descriptionKey="branding.icon.description"
          value={stringValue(values["branding.icon_asset_id"])}
          editable={editable}
          onSelect={(assetId) => onChange("branding.icon_asset_id", assetId)}
          onRemove={() => onChange("branding.icon_asset_id", "")}
        />
        <BrandingAssetUpload
          titleKey="branding.loginBackground.title"
          descriptionKey="branding.loginBackground.description"
          value={background.data?.assetId ?? ""}
          editable={editable && !background.isLoading}
          fallbackImageUrl={
            background.data?.imageUrl ?? "/api/v1/auth/background"
          }
          previewMode="cover"
          pending={saveBackground.isPending || removeBackground.isPending}
          actionError={
            saveBackground.error?.message ?? removeBackground.error?.message
          }
          onSelect={async (assetId) => {
            await saveBackground.mutateAsync(assetId);
          }}
          onRemove={async () => {
            await removeBackground.mutateAsync();
          }}
        />
      </div>
    </section>
  );
}

type BrandingAssetTitleKey =
  | "branding.logo.title"
  | "branding.icon.title"
  | "branding.loginBackground.title";
type BrandingAssetDescriptionKey =
  | "branding.logo.description"
  | "branding.icon.description"
  | "branding.loginBackground.description";

function BrandingAssetUpload({
  titleKey,
  descriptionKey,
  value,
  editable,
  fallbackImageUrl,
  previewMode = "contain",
  pending = false,
  actionError,
  onSelect,
  onRemove,
}: {
  titleKey: BrandingAssetTitleKey;
  descriptionKey: BrandingAssetDescriptionKey;
  value: string;
  editable: boolean;
  fallbackImageUrl?: string;
  previewMode?: "contain" | "cover";
  pending?: boolean;
  actionError?: string;
  onSelect: (assetId: string) => void | Promise<void>;
  onRemove: () => void | Promise<void>;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const title = t(titleKey);
  const auth = useAuth();
  const input = useRef<HTMLInputElement>(null);
  const [uploadedAsset, setUploadedAsset] = useState<Asset>();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();
  const existing = useQuery({
    queryKey: ["branding-asset", value],
    queryFn: () => api.asset(value),
    enabled: Boolean(value) && uploadedAsset?.id !== value,
    retry: false,
  });
  const asset = uploadedAsset?.id === value ? uploadedAsset : existing.data;

  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  const upload = async (file: File) => {
    setError(undefined);
    if (!file.type.startsWith("image/")) {
      setError(t("branding.invalidType"));
      return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(file));
    setUploading(true);
    setProgress(0);
    let sessionId = "";
    try {
      const session = await api.createUpload(
        {
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
        },
        auth.status?.csrfToken ?? "",
      );
      sessionId = session.id;
      let offset = session.offset;
      while (offset < file.size) {
        const next = Math.min(file.size, offset + chunkSize);
        offset = await api.uploadChunk(
          session.id,
          offset,
          file.slice(offset, next),
          auth.status?.csrfToken ?? "",
        );
        setProgress(Math.round((offset / file.size) * 100));
      }
      const completed = await api.completeUpload(
        session.id,
        auth.status?.csrfToken ?? "",
      );
      setUploadedAsset(completed);
      await onSelect(completed.id);
      setProgress(100);
    } catch (uploadError) {
      if (sessionId)
        void api
          .cancelUpload(sessionId, auth.status?.csrfToken ?? "")
          .catch(() => {});
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : t("branding.uploadFailed"),
      );
    } finally {
      setUploading(false);
    }
  };

  const imageUrl = previewUrl || asset?.thumbnailUrl || fallbackImageUrl;
  const busy = uploading || pending;
  return (
    <article className="grid gap-4 rounded-xl border border-border bg-card p-4">
      <AspectRatio
        ratio={16 / 10}
        className="grid min-h-28 place-items-center overflow-hidden rounded-xl border border-border bg-muted"
      >
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={t("branding.previewAlt", { title })}
            className={
              previewMode === "cover"
                ? "h-full w-full object-cover"
                : "h-full w-full object-contain"
            }
          />
        ) : (
          <span aria-hidden="true" className="text-sm text-muted-foreground">
            {title}
          </span>
        )}
      </AspectRatio>
      <div className="grid min-w-0 content-between gap-3">
        <div className="grid gap-1">
          <strong className="text-sm font-semibold">{title}</strong>
          <p className="text-sm text-muted-foreground">{t(descriptionKey)}</p>
          {asset && (
            <small className="text-xs text-muted-foreground">
              {asset.name || asset.originalFilename}
            </small>
          )}
          {value && !asset && !existing.isLoading && (
            <small className="text-sm text-destructive">
              {t("branding.unavailable")}
            </small>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            hidden
            disabled={!editable || busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
              event.target.value = "";
            }}
          />
          <Button
            type="button"
            variant="default"
            disabled={!editable || busy}
            onClick={() => input.current?.click()}
          >
            {uploading
              ? t("branding.uploading", { progress })
              : value
                ? t("branding.replace")
                : t("branding.upload")}
          </RheaButton>
          {value && (
            <Button
              type="button"
              variant="ghost"
              disabled={!editable || busy}
              onClick={() => {
                void Promise.resolve(onRemove())
                  .then(() => {
                    setUploadedAsset(undefined);
                    if (previewUrl) URL.revokeObjectURL(previewUrl);
                    setPreviewUrl(undefined);
                  })
                  .catch(() => {});
              }}
            >
              {t("branding.remove")}
            </RheaButton>
          )}
        </div>
        {(error || actionError) && (
          <Alert variant="destructive">
            <AlertDescription>{error ?? actionError}</AlertDescription>
          </Alert>
        )}
      </div>
    </article>
  );
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}
