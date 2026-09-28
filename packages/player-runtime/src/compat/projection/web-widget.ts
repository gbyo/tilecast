/**
 * Remote web Widgets in the shared projection: a schema-13 Widget whose
 * server-compiled presentation is `kind: "web"`, and the YouTube Widget.
 *
 * The server's `presentation.web` descriptor is used as it is; nothing is
 * recompiled from provider configuration, except the YouTube player settings
 * that the descriptor does not carry (start and end, loop, captions,
 * controls, mute, volume, completion). Those come from the server's
 * normalized YouTube configuration.
 */
import type { RuntimeRemoteWebSpecV1 } from "../../host/contract";
import {
  specFromWebDescriptor,
  specFromYouTube,
  type WebDescriptor,
} from "../../remote-web/spec";
import { isAvailableAt } from "./content-availability";
import type { ManifestWidget } from "./content-types";
import type { ManifestAsset } from "./types";

/** Whether the Widget needs a remote web surface (`web.remote`). */
export function isRemoteWebWidget(widget: ManifestWidget): boolean {
  return widget.provider === "youtube" || widget.presentation?.kind === "web";
}

/** The remote web spec of a Widget, or null when it cannot be shown. */
export function remoteWebForWidget(
  widget: ManifestWidget,
  assets: ManifestAsset[],
  at: Date,
): RuntimeRemoteWebSpecV1 | null {
  if (widget.provider === "youtube") {
    const config = widget.configuration ?? {};
    const fallbackId = config["fallbackImageAssetId"];
    const fallback =
      typeof fallbackId === "string"
        ? assets.find(
            (asset) =>
              asset.assetId === fallbackId &&
              asset.mimeType.startsWith("image/") &&
              isAvailableAt(asset, at),
          )
        : undefined;
    return specFromYouTube(
      config,
      fallback
        ? `tcmedia://variant/${fallback.assetId}/${fallback.variantId}`
        : null,
    );
  }
  if (widget.presentation?.kind === "web") {
    return specFromWebDescriptor(
      widget.presentation.web as WebDescriptor | null | undefined,
    );
  }
  return null;
}
