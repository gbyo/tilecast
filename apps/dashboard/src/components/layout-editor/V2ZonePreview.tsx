/**
 * The Layout zone preview for migrated V2 Widgets
 * (docs/widgets-v2-authoring-and-first-wave.md).
 *
 * The same real Web Component the editor previews and the Player mounts,
 * sized to the zone. Widgets still on their hand-written zone preview keep
 * it; each migration deletes its branch from `WidgetLivePreview` and lands
 * here with no zone-specific renderer.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  createWidgetResources,
  resolveTheme,
  type WidgetContext,
} from "@tilecast/widget-sdk";
import { compileComponentConfig } from "@tilecast/widget-sdk/manifest";
import type { WidgetComponentRef } from "@tilecast/widget-sdk/mount";
import { api } from "../../api/client";
import type { Asset } from "../../api/types";
import { useOrganizationRegionalProfile } from "../../settings/regionalProfile";
import { PreviewClock } from "../../content/previewClock";
import { studioWidgetComponent } from "../../content/studioWidgets";
import { WidgetPreviewHost } from "../../content/WidgetPreviewHost";
import { widgetPreviewConfiguration } from "../../content/widgetPreviewSources";

export function V2ZonePreview({
  provider,
  asset,
  width,
  height,
}: {
  provider: string;
  asset?: Asset;
  /** Zone dimensions in preview pixels. Sizes the frame, never the Widget. */
  width: number;
  height: number;
}) {
  const { t } = useTranslation(["content", "common"]);
  const regional = useOrganizationRegionalProfile();
  const definitions = useQuery({
    queryKey: ["content-definitions"],
    queryFn: () => api.contentDefinitions(),
  });
  const component = useMemo(
    () => studioWidgetComponent(definitions.data, provider),
    [definitions.data, provider],
  );
  const configuration = useMemo(
    () =>
      widgetPreviewConfiguration(
        asset?.widget?.authorConfiguration ??
          asset?.widget?.configuration ??
          {},
        asset?.widget?.managedDataSourceId,
      ),
    [asset],
  );
  const compiled = useMemo((): WidgetComponentRef | null => {
    if (!component) return null;
    try {
      return {
        type: component.type,
        version: component.version,
        config: compileComponentConfig(
          component.configTemplate,
          configuration,
        ),
      };
    } catch {
      return null;
    }
  }, [component, configuration]);
  const resources = useMemo(
    () => createWidgetResources({ documents: new Map() }, { dataSources: [] }),
    [],
  );
  const clock = useMemo(() => new PreviewClock(), []);
  const context: WidgetContext = useMemo(
    () => ({
      clock,
      locale: regional.locale ?? "en-US",
      timeZone: regional.timezone ?? "UTC",
      hourCycle:
        regional.timeFormat === "12-hour"
          ? ("h12" as const)
          : regional.timeFormat === "24-hour"
            ? ("h23" as const)
            : ("locale" as const),
      theme: resolveTheme({
        background: configuration["backgroundColor"],
        foreground: configuration["foregroundColor"],
      }),
      motion: { reduced: false },
      mode: "preview" as const,
    }),
    [clock, regional.locale, regional.timezone, regional.timeFormat, configuration],
  );

  if (definitions.isLoading) return null;
  if (!compiled) return null;
  return (
    <WidgetPreviewHost
      component={compiled}
      resources={resources}
      context={context}
      frame={{ width, height }}
      label={t("widgets.editors.v2.zonePreview")}
    />
  );
}
