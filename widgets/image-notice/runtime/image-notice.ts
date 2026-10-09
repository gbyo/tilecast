/**
 * Image Notice: the compatibility presentation of saved Image Notice
 * Widgets (docs/widgets-v2-catalog.md §4).
 *
 * A plain image is Media, so Image Notice is not offered for new creation.
 * Saved Image Notices still render here: one managed image, fitted as the
 * author chose, with an optional caption below it. The image arrives only
 * through the presentation's managed media grant; the Widget never
 * addresses a URL of its own. Ready is reported after the image decodes,
 * so a transition never swaps in an empty frame.
 */
import {
  css,
  html,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from "lit";
import {
  announceEmpty,
  announceError,
  announceReady,
  empty,
  parseHexColor,
  ready,
  widgetInputRevision,
  type ConfigResult,
  type WidgetResolution,
  type WidgetResources,
} from "@tilecast/widget-sdk";
import { boundText, TilecastWidgetElement } from "@tilecast/widget-kit";

export const IMAGE_FITS = ["contain", "cover", "stretch"] as const;
export type ImageFit = (typeof IMAGE_FITS)[number];

const IDENTIFIER = /^[A-Za-z0-9-]{0,64}$/;

export interface ImageNoticeConfig {
  readonly assetId: string;
  readonly variantId: string;
  readonly fit: ImageFit;
  readonly caption: string;
  readonly background: string | null;
  readonly foreground: string | null;
}

export interface ImageNoticeData {
  /** The host-authorized image URI. */
  readonly src: string;
}

export function parseImageNoticeConfig(
  value: unknown,
): ConfigResult<ImageNoticeConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, problem: "configuration must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const image = (raw["image"] ?? {}) as Record<string, unknown>;
  const assetId = image["assetId"] ?? "";
  const variantId = image["variantId"] ?? "";
  if (
    typeof assetId !== "string" ||
    typeof variantId !== "string" ||
    !IDENTIFIER.test(assetId) ||
    !IDENTIFIER.test(variantId)
  ) {
    return { ok: false, problem: "image must name a media variant" };
  }
  const fit = raw["fit"] ?? "contain";
  if (!IMAGE_FITS.includes(fit as never)) {
    return { ok: false, problem: "fit must be contain, cover or stretch" };
  }
  const caption = raw["caption"] ?? "";
  if (typeof caption !== "string" || caption.length > 200) {
    return { ok: false, problem: "caption must be at most 200 characters" };
  }
  return {
    ok: true,
    config: {
      assetId,
      variantId,
      fit: fit as ImageFit,
      caption: boundText(caption.trim(), 200),
      background: parseHexColor(raw["background"]),
      foreground: parseHexColor(raw["foreground"]),
    },
  };
}

export function resolveImageNoticeData(
  config: ImageNoticeConfig,
  resources: WidgetResources,
): WidgetResolution<ImageNoticeData> {
  if (config.assetId === "") return empty("no_image");
  const src = resources.media(config.assetId, config.variantId);
  return src ? ready({ src }) : empty("image_unavailable");
}

export class TilecastImageNoticeWidget extends TilecastWidgetElement<
  ImageNoticeConfig,
  ImageNoticeData
> {
  static override styles = [
    ...(TilecastWidgetElement.styles as never[]),
    css`
      figure {
        position: absolute;
        inset: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
      }
      .image {
        flex: 1 1 auto;
        min-height: 0;
        width: 100%;
        object-fit: contain;
      }
      .image[data-fit="cover"] {
        object-fit: cover;
      }
      .image[data-fit="stretch"] {
        object-fit: fill;
      }
      figcaption {
        flex: none;
        padding: min(2.4cqh, 1.8cqw) var(--tc-gutter);
        font-size: clamp(12px, min(5.4cqh, 3.2cqw), 84px);
        font-weight: 550;
        line-height: 1.25;
        text-align: center;
        overflow-wrap: anywhere;
      }
      @container tc-widget (max-height: 150px) or (max-width: 200px) {
        figcaption {
          display: none;
        }
      }
    `,
  ];

  private decoding = 0;

  protected override themeOverrides(config: ImageNoticeConfig) {
    return { background: config.background, foreground: config.foreground };
  }

  protected override renderContent(
    data: ImageNoticeData | null,
  ): TemplateResult {
    if (!data) return html``;
    return html`<figure>
      <img
        class="image"
        data-fit=${this.config.fit}
        src=${data.src}
        alt=${this.config.caption}
      />
      ${
        this.config.caption
          ? html`<div aria-hidden="true">
              <figcaption>${this.config.caption}</figcaption>
            </div>`
          : nothing
      }
    </figure>`;
  }

  protected override updated(changed: PropertyValues): void {
    if (!["config", "data", "empty", "context"].some((key) => changed.has(key)))
      return;
    if (this.empty !== null) {
      announceEmpty(this, this.empty);
      return;
    }
    const image = this.renderRoot.querySelector<HTMLImageElement>(".image");
    if (!image || typeof image.decode !== "function") {
      announceReady(this);
      return;
    }
    const attempt = ++this.decoding;
    const revision = widgetInputRevision(this);
    image.decode().then(
      () => {
        if (attempt === this.decoding) announceReady(this, revision);
      },
      () => {
        if (attempt === this.decoding)
          announceError(this, "image_unavailable", revision);
      },
    );
  }
}
