import { contentQueries } from "../../data/content";
/**
 * The Layout zone preview for migrated V2 Widgets
 * (docs/widget-authoring.md, Preview capabilities).
 *
 * The same real Web Component the editor previews and the Player mounts,
 * sized to the zone. Widgets still on their hand-written zone preview keep
 * it; each migration deletes its branch from `WidgetLivePreview` and lands
 * here with no zone-specific renderer.
 */
import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { resolveTheme, type WidgetContext } from "@tilecast/widget-sdk";
import { compileComponentConfig } from "@tilecast/widget-sdk/manifest";
import type {
  WidgetComponentRef,
  WidgetMountState,
} from "@tilecast/widget-sdk/mount";
import type { Asset } from "../../api/types";
import { useOrganizationRegionalProfile } from "../../settings/regionalProfile";
import { PreviewClock } from "../../content/previewClock";
import { studioPreviewComponent } from "../../content/studioWidgets";
import {
  WidgetPreviewHost,
  type PreviewFit,
} from "../../content/WidgetPreviewHost";
import { useWidgetPreviewResources } from "../../content/widgetPreviewResources";
import {
  widgetPreviewConfiguration,
  widgetPreviewDataSourceIds,
  widgetPreviewMedia,
} from "../../content/widgetPreviewSources";

/**
 * Convert a Layout preview date (YYYY-MM-DD) to local noon in the selected
 * time zone. Returns null when the input is absent, invalid, or impossible
 * in that time zone, which means the preview stays live.
 */
export function layoutPreviewDateToMs(
  previewDate?: string,
  timeZone = "UTC",
): number | null {
  if (!previewDate) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(previewDate);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Calendar checks come first so an impossible date means live, not a
  // normalized nearby date.
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const lastDay = new Date(0);
  lastDay.setUTCFullYear(year, month, 0);
  if (day > lastDay.getUTCDate()) return null;

  const wallClock = new Date(0);
  wallClock.setUTCFullYear(year, month - 1, day);
  wallClock.setUTCHours(12, 0, 0, 0);
  const target = wallClock.getTime();
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return null;
  }
  const localWallClock = (instant: number): number => {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(instant))
        .map((part) => [part.type, Number(part.value)]),
    );
    const year = parts["year"];
    const month = parts["month"];
    const day = parts["day"];
    const hour = parts["hour"];
    const minute = parts["minute"];
    const second = parts["second"];
    if (
      year === undefined ||
      month === undefined ||
      day === undefined ||
      hour === undefined ||
      minute === undefined ||
      second === undefined
    )
      return Number.NaN;
    const local = new Date(0);
    local.setUTCFullYear(year, month - 1, day);
    local.setUTCHours(hour, minute, second, 0);
    return local.getTime();
  };

  // Correct the UTC guess by the difference between its local wall clock and
  // the requested one. Noon avoids the daylight-saving gaps around midnight.
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const correction = target - localWallClock(candidate);
    if (correction === 0) return candidate;
    candidate += correction;
  }
  return null;
}

export function V2ZonePreview({
  provider,
  asset,
  width,
  height,
  onState,
  fit = "shrink",
  previewDate,
}: {
  provider: string;
  asset?: Asset;
  /**
   * Intrinsic zone dimensions in Layout-canvas pixels. WidgetPreviewHost fits
   * that frame into Studio without changing the Widget's container geometry.
   */
  width: number;
  height: number;
  /** Mount state, for callers that capture the preview once it settles. */
  onState?: (state: WidgetMountState) => void;
  /**
   * Shrink-only by default so hidden capture surfaces keep deterministic
   * intrinsic geometry. The visible Layout canvas passes fill so zones
   * still fill their placement when Studio zooms above 100%.
   */
  fit?: PreviewFit;
  /**
   * Layout-selected preview date (YYYY-MM-DD). It freezes the Widget's own
   * clock and date-selects its Data Source previews, so time-sensitive
   * Widgets agree with the Layout's text bindings. Absent means live.
   */
  previewDate?: string;
}) {
  const { t } = useTranslation(["content", "common"]);
  const regional = useOrganizationRegionalProfile();
  const definitions = useQuery({
    ...contentQueries.definitions(),
  });
  const resolved = useMemo(
    () => studioPreviewComponent(definitions.data, provider),
    [definitions.data, provider],
  );
  const component =
    resolved?.kind === "trusted"
      ? resolved.component
      : resolved?.kind === "sandbox"
        ? resolved.sandbox
        : null;
  const definitionFields = useMemo(
    () =>
      definitions.data?.widgets.find((entry) => entry.id === provider)
        ?.configurationSchema.fields ?? [],
    [definitions.data, provider],
  );
  const preview = useMemo(
    () =>
      widgetPreviewMedia(
        definitionFields,
        widgetPreviewConfiguration(
          asset?.widget?.authorConfiguration ??
            asset?.widget?.configuration ??
            {},
          asset?.widget?.managedDataSourceId,
        ),
      ),
    [asset, definitionFields],
  );
  const configuration = preview.configuration;
  const dataSourceIds = useMemo(
    () =>
      widgetPreviewDataSourceIds(
        definitionFields,
        configuration,
        asset?.widget?.managedDataSourceId,
      ),
    [definitionFields, configuration, asset],
  );
  const {
    resources,
    loading: sourcesLoading,
    failedIds,
  } = useWidgetPreviewResources(
    dataSourceIds,
    dataSourceIds,
    preview.media,
    previewDate,
  );
  // A granted source that cannot be loaded is a preview error, not an
  // empty Widget: without this the mount would resolve a missing document
  // to empty("no_source") and captures would store the failure as blank.
  const sourcesFailed = failedIds.length > 0;
  const compiled = useMemo((): WidgetComponentRef | null => {
    if (!component) return null;
    try {
      return {
        type: component.type,
        version: component.version,
        config: compileComponentConfig(component.configTemplate, configuration),
      };
    } catch {
      return null;
    }
  }, [component, configuration]);
  const setupError =
    definitions.isError && !definitions.data
      ? "definitions_unavailable"
      : !definitions.isLoading && definitions.data && !component
        ? "component_unavailable"
        : component && !compiled
          ? "configuration_invalid"
          : sourcesFailed
            ? "source_unavailable"
            : undefined;
  const reportedSetupError = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!setupError) {
      reportedSetupError.current = undefined;
      return;
    }
    if (!onState || reportedSetupError.current === setupError) return;
    reportedSetupError.current = setupError;
    onState({ state: "error", code: setupError });
  }, [setupError, onState]);
  const clock = useMemo(() => new PreviewClock(), []);
  // The Layout preview date drives the Widget's own clock in place: a fixed
  // date freezes it (no ticking, no remount), clearing the date goes live.
  const fixedMs = layoutPreviewDateToMs(previewDate, regional.timezone);
  useEffect(() => {
    if (fixedMs == null) clock.setMode("live");
    else clock.setFixed(fixedMs);
    // The clock instance is stable; only the selected date matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixedMs]);
  const reducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const context: WidgetContext = useMemo(() => {
    // Bumps context identity when the Layout preview date changes so the
    // mount reassigns the (mutated) clock in place instead of remounting.
    void fixedMs;
    return {
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
      motion: { reduced: reducedMotion },
      mode: "preview" as const,
    };
  }, [
    clock,
    fixedMs,
    reducedMotion,
    regional.locale,
    regional.timezone,
    regional.timeFormat,
    configuration,
  ]);

  // The sandbox bridge carries exactly the grants the trusted mount
  // resolves: the same Data Source ids and media refs.
  const declared = useMemo(
    () => ({ dataSources: dataSourceIds, media: preview.media }),
    [dataSourceIds, preview.media],
  );
  const frameUrl =
    resolved?.kind === "sandbox" ? resolved.sandbox.frameUrl : undefined;
  const sandbox = useMemo(
    () => (frameUrl ? { frameUrl, declared } : undefined),
    [frameUrl, declared],
  );

  if (definitions.isLoading) return null;
  if (sourcesLoading) return null;
  if (sourcesFailed)
    return (
      <p role="alert" className="v2-zone-preview__source-error">
        {t("widgets.editors.v2.sourceError")}
      </p>
    );
  if (!compiled) return null;
  return (
    <WidgetPreviewHost
      component={compiled}
      resources={resources}
      context={context}
      frame={{ width, height }}
      label={t("widgets.editors.v2.zonePreview")}
      onState={onState}
      fit={fit}
      sandbox={sandbox}
    />
  );
}
