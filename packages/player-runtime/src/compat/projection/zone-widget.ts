import type {
  RuntimeWidgetComponentPayload,
  RuntimeRemoteWebSpecV1,
} from "../../host/contract";
import { projectWidgetComponent } from "../../widgets/projection";
import type { ManifestWidget } from "./content-types";
import { resolveRegionalFormatting } from "./format";
import type { LayoutRenderContext } from "./layout-render";
import type { WidgetRenderPayload } from "./render-tree";
import { isRemoteWebWidget, remoteWebForWidget } from "./web-widget";
import { renderWidget } from "./widget-render";

export type ZoneWidgetProjection =
  | {
      kind: "widget";
      widget: WidgetRenderPayload | RuntimeWidgetComponentPayload;
    }
  | { kind: "remote-web"; remoteWeb: RuntimeRemoteWebSpecV1 };

/** Placement and timed occurrence share resource grants and data projection. */
export function projectZoneWidget(
  widget: ManifestWidget,
  ctx: LayoutRenderContext,
  zoneHeight: number,
): ZoneWidgetProjection {
  if (isRemoteWebWidget(widget)) {
    const remoteWeb = remoteWebForWidget(widget, ctx.manifest.assets, ctx.at);
    if (!remoteWeb)
      throw new Error("Layout Widget remote web projection failed");
    return { kind: "remote-web", remoteWeb };
  }
  const payload =
    widget.presentation?.kind === "component"
      ? projectWidgetComponent(widget, {
          dataSources: ctx.dataSources,
          assets: ctx.manifest.assets,
          regionalFormat:
            ctx.regionalFormat ?? resolveRegionalFormatting(undefined),
          at: ctx.at,
        })
      : renderWidget(widget, {
          dataSources: ctx.dataSources,
          assets: ctx.manifest.assets,
          at: ctx.at,
          zoneHeight,
          regionalFormat: ctx.regionalFormat,
        });
  if (!payload) throw new Error("Layout Widget projection failed");
  return { kind: "widget", widget: payload };
}
