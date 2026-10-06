/**
 * Everything the real Widget component needs to render the current draft:
 * the compiled component config, the Data Sources and media it is granted,
 * and the Widget context. It is the same contract Layout zones and the
 * Player use; the editor only adds a preview clock the author can move.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { resolveTheme, type WidgetContext } from "@tilecast/widget-sdk";
import { compileComponentConfig } from "@tilecast/widget-sdk/manifest";
import type {
  WidgetComponentRef,
  WidgetMountState,
} from "@tilecast/widget-sdk/mount";
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
import { componentPreviewStatus } from "./previewStatus";
import { useLastGood } from "./useLastGood";

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

/** Compile the draft and report how the real Widget is doing. */
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
  const attempt = useMemo((): {
    ref: WidgetComponentRef | null;
    problem?: string;
  } => {
    try {
      return {
        ref: {
          type: component.type,
          version: component.version,
          config: compileComponentConfig(
            component.configTemplate,
            previewConfiguration,
          ),
        },
      };
    } catch (error) {
      return { ref: null, problem: apiErrorMessage(error) };
    }
  }, [component, previewConfiguration]);
  const componentRef = useLastGood(attempt.ref);

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

  const { t } = useTranslation("content");
  const [mount, setMount] = useState<WidgetMountState>({ state: "pending" });
  const status = componentPreviewStatus(
    {
      ready: regional.ready,
      sourcesFailed: failedIds.length > 0,
      sourcesLoading: loading,
      compileProblem: attempt.problem,
      mount,
    },
    t,
  );

  return {
    status,
    /** What the host mounts; null until there is something to show. */
    host:
      regional.ready && componentRef
        ? { component: componentRef, resources, context, onState: setMount }
        : null,
    dataSourceIds,
  };
}
