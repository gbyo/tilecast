import { FileImage, FileVideo } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Asset } from "../../api/types";

export function AssetPreview({ asset }: { asset: Asset }) {
  const { t } = useTranslation(["content", "common"]);
  const [failedImageUrl, setFailedImageUrl] = useState<string>();
  const imageUrl = asset.thumbnailUrl;
  const isSuperwide = Boolean(
    asset.width && asset.height && asset.width / asset.height >= 2.4,
  );

  if (imageUrl && imageUrl !== failedImageUrl) {
    return (
      <img
        src={imageUrl}
        alt=""
        draggable={false}
        style={isSuperwide ? { objectFit: "contain" } : undefined}
        onError={() => setFailedImageUrl(imageUrl)}
      />
    );
  }
  if (asset.type === "widget")
    return (
      <span className="asset-preview-unavailable">
        {t("media.preview.unavailable")}
      </span>
    );
  if (asset.type === "video") return <FileVideo size={28} />;
  return <FileImage size={28} />;
}
