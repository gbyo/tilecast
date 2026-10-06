/**
 * Everything the real Widget component needs to render the current draft:
 * the compiled component config, the Data Sources and media it is granted,
 * and the Widget context. It is the same contract Layout zones and the
 * Player use; the editor only adds a preview clock the author can move.
 */
import { useEffect, useMemo, useRef } from "react";
import { resolveTheme, type WidgetContext } from "@tilecast/widget-sdk";
import { compileComponentConfig } from "@tilecast/widget-sdk/manifest";
import type { WidgetComponentRef } from "@tilecast/widget-sdk/mount";
import type { ContentDefinitionField } from "@/api/types";
import type { StudioWidgetComponent } from "@/content/studioWidgets";
import { PreviewClock } from "@/content/previewClock";
import {
  parsePreviewTimeInput,
  resolvePreviewDate,
  type PreviewTime,
} from "@/content/previewTime";
import { useWidgetPreviewResources } from "@/content/widgetPreviewResources";
import {
  widgetPreviewAssetFields,
  widgetPreviewConfiguration,
  widgetPreviewDataSourceIds,
  widgetPreviewMedia,
} from "@/content/widgetPreviewSources";
import { useOrganizationRegionalProfile } from "@/settings/regionalProfile";
import { apiErrorMessage } from "@/i18n";

function hourCycleFor(timeFormat: string | undefined) {
  if (timeFormat === "12-hour") return "h12" as const;
  if (timeFormat === "24-hour") return "h23" as const;
  return "locale" as const;
}

function prefersReducedMotion() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function useComponentPreview({
  component,
  fields,
  configuration,
  managedDataSourceId,
  previewTime,
}: {
  component: StudioWidgetComponent;
  fields: readonly ContentDefinitionField[];
  configuration: Record<string, unknown>;
  managedDataSourceId?: string;
  previewTime: PreviewTime;
}) {
  const regional = useOrganizationRegionalProfile();
  const clock = useMemo(() => new PreviewClock(), []);
  // A fixed preview instant freezes the Widget's own clock; live follows
  // the wall clock. The clock is mutated in place, never remounted.
  useEffect(() => {
    const fixed =
      previewTime.mode === "fixed"
        ? parsePreviewTimeInput(previewTime.value)
        : null;
    if (fixed) clock.setFixed(fixed.getTime());
    else clock.setMode("live");
  }, [clock, previewTime]);

  const media = useMemo(
    () =>
      widgetPreviewMedia(
        fields as ContentDefinitionField[],
        widgetPreviewConfiguration(configuration, managedDataSourceId),
      ),
    [fields, configuration, managedDataSourceId],
  );
  const previewConfiguration = media.configuration;
  const dataSourceIds = useMemo(
    () =>
      widgetPreviewDataSourceIds(
        fields as ContentDefinitionField[],
        previewConfiguration,
        managedDataSourceId,
      ),
    [fields, previewConfiguration, managedDataSourceId],
  );
  const assetFields = useMemo(
    () => widgetPreviewAssetFields(fields, previewConfiguration),
    [fields, previewConfiguration],
  );
  const { resources, loading, failedIds } = useWidgetPreviewResources(
    dataSourceIds,
    dataSourceIds,
    media.media,
    resolvePreviewDate(previewTime),
    assetFields,
  );

  // Edits compile locally and update the mounted element in place; the
  // Server is not involved until Save. A configuration the template cannot
  // compile keeps showing the last good render beside the problem.
  const lastGood = useRef<WidgetComponentRef | null>(null);
  const compiled = useMemo((): {
    ref: WidgetComponentRef | null;
    problem?: string;
  } => {
    try {
      const ref = {
        type: component.type,
        version: component.version,
        config: compileComponentConfig(
          component.configTemplate,
          previewConfiguration,
        ),
      };
      lastGood.current = ref;
      return { ref };
    } catch (error) {
      return {
        ref: lastGood.current,
        problem: apiErrorMessage(error),
      };
    }
  }, [component, previewConfiguration]);

  const reducedMotion = prefersReducedMotion();
  const background = configuration["backgroundColor"];
  const foreground = configuration["foregroundColor"];
  const context: WidgetContext = useMemo(
    () => ({
      clock,
      locale: regional.locale ?? "en-US",
      timeZone: regional.timezone ?? "UTC",
      hourCycle: hourCycleFor(regional.timeFormat),
      theme: resolveTheme({ background, foreground }),
      motion: { reduced: reducedMotion },
      mode: "preview" as const,
    }),
    // A new preview instant rebuilds context so the mount reassigns the
    // (mutated) clock without remounting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      clock,
      regional.locale,
      regional.timezone,
      regional.timeFormat,
      background,
      foreground,
      reducedMotion,
      previewTime.mode,
      previewTime.value,
    ],
  );

  return {
    ready: regional.ready,
    componentRef: compiled.ref,
    compileProblem: compiled.problem,
    resources,
    context,
    dataSourceIds,
    sourcesLoading: loading,
    sourcesFailed: failedIds.length > 0,
  };
}
