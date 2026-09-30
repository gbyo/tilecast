import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Alert, AlertDescription } from "../components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { EditorHeaderActions } from "./EditorHeaderActions";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { toast } from "../components/ui/toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import QRCode from "qrcode";
import { api } from "../api/client";
import { apiErrorMessage } from "../i18n";
import type { OrganizationRegionalProfile } from "../settings/regionalProfile";
import {
  formatRegionalDateTimeValue,
  parseISODateTime,
} from "../settings/regionalFormatting";
import type {
  Asset,
  WidgetProvider,
  WidgetPreset,
  YouTubeConfig,
  WidgetPresentation,
  PresentationBinding,
  PresentationNode,
} from "../api/types";
import { WidgetThumbnail } from "./WidgetThumbnail";
import {
  previewFieldCurrencies,
  previewRecordMaps,
  type PreviewDatasetCurrencies,
  type PreviewDatasets,
} from "./previewRecords";

export type WidgetsT = TFunction<["content", "common"], undefined>;

// Snapshot-capture failures surface through the Widget save mutation. They are
// thrown by widgetPreviewCapture (which has no translator), so the editors map
// the known English messages here; everything else keeps apiErrorMessage.
const captureErrorKeys = {
  "Preview is not ready yet.": "widgets.errors.capture.notReady",
  "Preview could not be rasterized.": "widgets.errors.capture.rasterize",
  "Preview image could not be created.": "widgets.errors.capture.create",
  "Preview canvas is unavailable.": "widgets.errors.capture.canvas",
  "Preview image is too detailed to store.": "widgets.errors.capture.tooLarge",
} as const;

export function widgetSaveErrorMessage(t: WidgetsT, error: unknown): string {
  if (error instanceof Error) {
    const key =
      captureErrorKeys[error.message as keyof typeof captureErrorKeys];
    if (key) return t(key);
  }
  return apiErrorMessage(error);
}

function galleryCategoryLabel(t: WidgetsT, name: string): string {
  switch (name) {
    case "All":
      return t("widgets.gallery.categories.all");
    case "Essentials":
      return t("widgets.gallery.categories.essentials");
    case "Information":
      return t("widgets.gallery.categories.information");
    case "Data display":
      return t("widgets.gallery.categories.dataDisplay");
    case "Integrations":
      return t("widgets.gallery.categories.integrations");
    default:
      return name;
  }
}

export function WidgetProviderGallery({
  onChoose,
  onClose,
  page = false,
}: {
  onChoose: (provider: WidgetProvider, presetId?: WidgetPreset) => void;
  onClose: () => void;
  page?: boolean;
}) {
  const { t } = useTranslation(["content", "common"]);
  const definitions = useQuery({
    queryKey: ["content-definitions"],
    queryFn: api.contentDefinitions,
    staleTime: 5 * 60_000,
  });
  const pluginCatalog = useQuery({
    queryKey: ["plugins"],
    queryFn: api.plugins,
    staleTime: 5 * 60_000,
  });
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    addEventListener("keydown", escape);
    return () => removeEventListener("keydown", escape);
  }, [onClose]);

  const catalog = definitions.data?.widgets ?? [];
  // Provenance for plugin-owned Widgets: the gallery is built from the
  // effective catalog, and installation state decides whether a
  // plugin-owned provider can be created. An uninstalled plugin's Widget
  // stays visible but disabled with its owning plugin named, so the
  // definition never looks silently broken. The Server enforces the same
  // decision authoritatively; when the plugin catalog cannot be read the
  // gallery degrades to the static catalog alone.
  const installedPlugins = new Map(
    (pluginCatalog.data?.items ?? []).map((plugin) => [plugin.id, plugin]),
  );
  const sourceInfo = (definition: (typeof catalog)[number]) => {
    const source = definition.source;
    if (!source || source.kind !== "plugin") return null;
    const plugin = installedPlugins.get(source.pluginId);
    const name = plugin?.name ?? source.pluginId;
    if (plugin && !plugin.installed) {
      return {
        badge: t("widgets.gallery.sourcePlugin", { name }),
        unavailable: t("widgets.gallery.requiresPlugin", { name }),
      };
    }
    return {
      badge: t("widgets.gallery.sourcePlugin", { name }),
      unavailable: null as string | null,
    };
  };
  // The visual Widget catalog comes first, grouped by purpose; every Web
  // Integration (runtime "web") shows remote content and sits apart from
  // it (docs/widgets-v2-catalog.md §7).
  const categories = [
    "Essentials",
    "Information",
    "Data display",
    "Integrations",
  ];
  const galleryCategory = (definition: (typeof catalog)[number]) => {
    if (definition.runtime === "web") return "Integrations";
    if (categories.includes(definition.category)) return definition.category;
    return "Data display";
  };
  const needle = search.trim().toLowerCase();
  const visible = catalog.filter((definition) => {
    // Superseded providers remain editable for saved content but leave new
    // creation once their V2 replacement proves parity.
    if (definition.deprecation?.deprecated) return false;
    if (category !== "All" && galleryCategory(definition) !== category)
      return false;
    if (!needle) return true;
    return [
      definition.name,
      definition.description,
      definition.category,
      ...(definition.keywords ?? []),
    ]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });
  const sections =
    category === "All"
      ? categories
          .map((name) => ({
            name,
            items: visible.filter(
              (definition) => galleryCategory(definition) === name,
            ),
          }))
          .filter((section) => section.items.length > 0)
      : [{ name: category, items: visible }];

  const card = (definition: (typeof catalog)[number]) => {
    const provenance = sourceInfo(definition);
    const reason = provenance?.unavailable ?? definition.availability?.reason;
    const disabled =
      definition.availability?.enabled === false ||
      provenance?.unavailable != null;
    return (
      <Button
        type="button"
        variant="outline"
        key={definition.id}
        disabled={disabled}
        aria-describedby={
          disabled ? `widget-availability-${definition.id}` : undefined
        }
        onClick={() => onChoose(definition.id)}
        className="grid h-auto min-w-0 w-full grid-cols-1 justify-items-stretch gap-2 p-3 text-left whitespace-normal transition-colors hover:border-foreground/20 disabled:opacity-60"
      >
        <span className="grid aspect-video w-full place-items-center overflow-hidden rounded-xl bg-muted">
          <WidgetThumbnail
            name={definition.thumbnail ?? definition.id}
            label={definition.name}
          />
        </span>
        <span className="grid min-w-0 gap-0.5">
          <strong className="truncate text-sm font-medium">
            {definition.name}
          </strong>
          <span className="text-xs text-muted-foreground">
            {definition.description}
          </span>
          {provenance?.badge && (
            <span className="text-xs text-muted-foreground">
              {provenance.badge}
            </span>
          )}
          {disabled && reason && (
            <small
              id={`widget-availability-${definition.id}`}
              className="text-xs text-muted-foreground"
            >
              {reason}
            </small>
          )}
        </span>
      </Button>
    );
  };

  const featured = visible.filter(
    (definition) =>
      definition.featured &&
      definition.availability?.enabled !== false &&
      sourceInfo(definition)?.unavailable == null,
  );

  return (
    <div
      className={
        page
          ? "w-full min-w-0 space-y-5"
          : "fixed inset-0 z-50 overflow-y-auto bg-black/50 p-4"
      }
      role={page ? undefined : "presentation"}
    >
      <section
        className={
          page
            ? "w-full min-w-0 space-y-5"
            : "mx-auto w-full max-w-4xl space-y-5 rounded-xl bg-background p-5"
        }
        role={page ? undefined : "dialog"}
        aria-modal={page ? undefined : true}
        aria-labelledby="source-gallery-title"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 id="source-gallery-title" className="text-xl font-semibold">
              {t("widgets.gallery.title")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("widgets.gallery.subtitle")}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("common:actions.close")}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="search"
            value={search}
            placeholder={t("widgets.gallery.searchPlaceholder")}
            aria-label={t("widgets.gallery.searchLabel")}
            onChange={(event) => setSearch(event.target.value)}
            className="max-w-xs"
          />
          <div
            className="flex flex-wrap items-center gap-1"
            aria-label={t("widgets.gallery.categoriesLabel")}
          >
            {["All", ...categories].map((name) => (
              <Button
                type="button"
                key={name}
                variant={category === name ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={category === name}
                onClick={() => setCategory(name)}
              >
                {galleryCategoryLabel(t, name)}
              </Button>
            ))}
          </div>
        </div>
        <div className="grid gap-6">
          {category === "All" && !needle && featured.length > 0 && (
            <section className="grid gap-2">
              <div className="space-y-0.5">
                <h3 className="text-sm font-semibold">
                  {t("widgets.gallery.featured")}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {t("widgets.gallery.featuredHint")}
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {featured.map(card)}
              </div>
            </section>
          )}
          {sections.map((section) => (
            <section className="grid gap-2" key={section.name}>
              <h3 className="text-sm font-semibold">
                {galleryCategoryLabel(t, section.name)}
              </h3>
              {section.items.length > 0 ? (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {section.items.map(card)}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("widgets.gallery.noResults")}
                </p>
              )}
            </section>
          ))}
          {visible.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {t("widgets.gallery.noMatch", { search })}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
export function DeclarativePresentationPreview({
  presentation,
  source,
  datasets,
  datasetCurrencies,
  regional,
  now,
  assetImageUrl,
  onWebReady,
}: {
  presentation: WidgetPresentation;
  // The primary source's payload. Bindings that name a dataset the map does not carry fall back
  // to this, which keeps every single-source Widget rendering exactly as before.
  source: unknown;
  // Records keyed "<dataSourceId>:<datasetId>", for Widgets that reference several sources.
  datasets?: PreviewDatasets;
  datasetCurrencies?: PreviewDatasetCurrencies;
  regional?: OrganizationRegionalProfile;
  now?: Date;
  assetImageUrl?: string;
  onWebReady?: () => void;
}) {
  const { t } = useTranslation(["content", "common"]);
  const [liveNow, setLiveNow] = useState(() => now ?? new Date());
  useEffect(() => {
    if (now || presentation.kind !== "native") return;
    // Returning from a fixed preview time resumes at the real instant instead of showing the
    // clock the preview was frozen at until the next tick.
    setLiveNow(new Date());
    const timer = window.setInterval(() => setLiveNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, [now, presentation.kind]);
  if (presentation.kind === "web") {
    const url = presentation.web?.url;
    if (!url) return t("widgets.preview.webUnavailable");
    const external =
      new URL(url, window.location.href).origin !== window.location.origin;
    return (
      <iframe
        className="presentation-preview__web"
        src={url}
        title={t("widgets.preview.webTitle")}
        sandbox={`allow-scripts allow-forms allow-popups allow-presentation${external ? " allow-same-origin" : ""}`}
        allow="autoplay; encrypted-media; fullscreen"
        referrerPolicy="strict-origin-when-cross-origin"
        onLoad={onWebReady}
      />
    );
  }
  const records = previewRecordMaps(source);
  const root = presentation.native?.root;
  const formatting = regional ?? {
    locale: "en-US",
    timezone: "UTC",
    dateFormat: "locale",
    timeFormat: "locale",
  };
  return root ? (
    <PreviewNode
      node={root}
      records={records}
      datasets={datasets}
      sourceCurrencies={previewFieldCurrencies(source)}
      datasetCurrencies={datasetCurrencies}
      regional={formatting}
      now={now ?? liveNow}
      assetImageUrl={assetImageUrl}
    />
  ) : (
    t("widgets.preview.rootUnavailable")
  );
}

export function formatCountdownPreview(
  target: string,
  mode: string,
  completionText: string,
  now: Date,
  recurrence = "none",
  timezone = "UTC",
  completionAction = "completed_text",
  visibleUnits?: string,
) {
  const targetTime = resolveCountdownTarget(target, timezone, recurrence, now);
  if (!Number.isFinite(targetTime)) return completionText;
  const rawDifference =
    mode === "count_up"
      ? now.getTime() - targetTime
      : targetTime - now.getTime();
  if (rawDifference <= 0 && mode !== "count_up") {
    if (completionAction === "hide") return "";
    if (completionAction !== "count_up") return completionText;
  }
  const totalSeconds = Math.floor(Math.abs(rawDifference) / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return (
    visibleUnits
      ? [
          visibleUnits[0] === "1" ? `${days}d` : "",
          visibleUnits[1] === "1" ? `${hours}h` : "",
          visibleUnits[2] === "1" ? `${minutes}m` : "",
          visibleUnits[3] === "1" ? `${seconds}s` : "",
        ]
      : [
          days > 0 ? `${days}d` : "",
          days > 0 || hours > 0 ? `${hours}h` : "",
          `${minutes}m`,
          `${seconds}s`,
        ]
  )
    .filter(Boolean)
    .join(" ");
}

function resolveCountdownTarget(
  target: string,
  timezone: string,
  recurrence: string,
  now: Date,
) {
  const explicitOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(target);
  const original = explicitOffset
    ? new Date(target)
    : zonedLocalDate(target, timezone);
  if (!Number.isFinite(original.getTime()) || recurrence === "none")
    return original.getTime();

  const seed = zonedParts(original, timezone);
  const current = zonedParts(now, timezone);
  const build = (year: number, month: number, day: number) =>
    zonedLocalDate(
      `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}T${seed.hour.toString().padStart(2, "0")}:${seed.minute.toString().padStart(2, "0")}:${seed.second.toString().padStart(2, "0")}`,
      timezone,
    );
  let candidate: Date;
  if (recurrence === "daily") {
    candidate = build(current.year, current.month, current.day);
    if (candidate <= now) {
      const next = addCalendarDays(current, 1);
      candidate = build(next.year, next.month, next.day);
    }
  } else if (recurrence === "weekly") {
    let offset = (seed.weekday - current.weekday + 7) % 7;
    let next = addCalendarDays(current, offset);
    candidate = build(next.year, next.month, next.day);
    if (candidate <= now) {
      offset += 7;
      next = addCalendarDays(current, offset);
      candidate = build(next.year, next.month, next.day);
    }
  } else if (recurrence === "monthly") {
    const monthly = (year: number, month: number) =>
      build(year, month, Math.min(seed.day, daysInMonth(year, month)));
    candidate = monthly(current.year, current.month);
    if (candidate <= now) {
      const nextMonth = current.month === 12 ? 1 : current.month + 1;
      candidate = monthly(
        current.month === 12 ? current.year + 1 : current.year,
        nextMonth,
      );
    }
  } else {
    const yearly = (year: number) =>
      build(
        year,
        seed.month,
        Math.min(seed.day, daysInMonth(year, seed.month)),
      );
    candidate = yearly(current.year);
    if (candidate <= now) candidate = yearly(current.year + 1);
  }
  return candidate.getTime();
}

function zonedLocalDate(value: string, timezone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(
    value,
  );
  if (!match) return new Date(Number.NaN);
  const desired = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
  };
  let timestamp = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute,
    desired.second,
  );
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const actual = zonedParts(new Date(timestamp), timezone);
      const actualAsUTC = Date.UTC(
        actual.year,
        actual.month - 1,
        actual.day,
        actual.hour,
        actual.minute,
        actual.second,
      );
      const desiredAsUTC = Date.UTC(
        desired.year,
        desired.month - 1,
        desired.day,
        desired.hour,
        desired.minute,
        desired.second,
      );
      timestamp += desiredAsUTC - actualAsUTC;
    }
    return new Date(timestamp);
  } catch {
    return new Date(Number.NaN);
  }
}

function zonedParts(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "0";
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    year: Number(part("year")),
    month: Number(part("month")),
    day: Number(part("day")),
    hour: Number(part("hour")),
    minute: Number(part("minute")),
    second: Number(part("second")),
    weekday: weekdays.indexOf(part("weekday")),
  };
}

function addCalendarDays(
  value: { year: number; month: number; day: number },
  days: number,
) {
  const date = new Date(
    Date.UTC(value.year, value.month - 1, value.day + days),
  );
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function PreviewNode({
  node,
  records,
  datasets,
  sourceCurrencies,
  datasetCurrencies,
  regional,
  recordCurrencies,
  record,
  recordIndex,
  now,
  assetImageUrl,
}: {
  node: PresentationNode;
  records: Record<string, string>[];
  datasets?: PreviewDatasets;
  sourceCurrencies: Record<string, string>;
  datasetCurrencies?: PreviewDatasetCurrencies;
  regional: OrganizationRegionalProfile;
  recordCurrencies?: Record<string, string>;
  record?: Record<string, string>;
  recordIndex?: number;
  now: Date;
  assetImageUrl?: string;
}) {
  const { t } = useTranslation(["content", "common"]);
  const formatLocale = regional.locale ?? "en-US";
  const props = node.props ?? {};
  const binding = node.binding;
  // A node reads the dataset it names. An unknown name falls back to the primary records so a
  // single-source Widget, and any presentation compiled before datasets were keyed, is unchanged.
  const datasetRecords = (name?: string) =>
    (name && datasets?.[name]) || records;
  const resolveBinding = (candidate: PresentationBinding) => {
    const currency = candidate.path
      ? candidate.source === "dataset"
        ? (datasetCurrencies?.[candidate.dataset ?? ""]?.[candidate.path] ??
          sourceCurrencies[candidate.path])
        : candidate.source === "repeat"
          ? (recordCurrencies?.[candidate.path] ??
            sourceCurrencies[candidate.path])
          : undefined
      : undefined;
    if (candidate.source === "literal")
      return formatPresentationValue(
        candidate.value ?? "",
        candidate,
        now,
        currency,
        formatLocale,
        t,
        regional,
      );
    if (candidate.source === "repeat")
      return formatPresentationValue(
        record?.[candidate.path ?? ""] ?? candidate.fallback ?? "",
        candidate,
        now,
        currency,
        formatLocale,
        t,
        regional,
      );
    if (candidate.source === "repeat_index")
      return formatPresentationValue(
        String((recordIndex ?? 0) + 1),
        candidate,
        now,
        undefined,
        formatLocale,
        t,
        regional,
      );
    if (candidate.source === "dataset") {
      const scoped = selectTemporalRecords(
        datasetRecords(candidate.dataset),
        now,
        candidate.selector,
        candidate.startField,
        candidate.endField,
      );
      if (candidate.path)
        return formatPresentationValue(
          scoped[0]?.[candidate.path] ?? candidate.fallback ?? "",
          candidate,
          now,
          currency,
          formatLocale,
          t,
          regional,
        );
      const joined =
        scoped
          .map((item) =>
            (candidate.fields ?? [])
              .map((field) => item[field])
              .filter(Boolean)
              .join(" "),
          )
          .filter(Boolean)
          .join(candidate.separator ?? " ") ||
        candidate.fallback ||
        "";
      return formatPresentationValue(
        joined,
        candidate,
        now,
        currency,
        formatLocale,
        t,
        regional,
      );
    }
    if (candidate.source === "environment") {
      const format = candidate.format?.split(":") ?? [];
      const timezone = format.at(-1) || regional.timezone;
      if (format[0] === "date")
        return format[1] && format[1] !== "locale"
          ? new Intl.DateTimeFormat(formatLocale, {
              dateStyle: format[1] as "full" | "long" | "medium" | "short",
              timeZone: timezone,
            }).format(now)
          : formatRegionalDateTimeValue(now.toISOString(), "date", {
              ...regional,
              timezone,
            });
      if (format[0] === "time") {
        const hour12 =
          format[1] === "12"
            ? true
            : format[1] === "24"
              ? false
              : regional.timeFormat === "12-hour"
                ? true
                : regional.timeFormat === "24-hour"
                  ? false
                  : undefined;
        return new Intl.DateTimeFormat(formatLocale, {
          timeStyle: format[2] === "true" ? "medium" : "short",
          ...(hour12 === undefined ? {} : { hour12 }),
          timeZone: timezone,
        }).format(now);
      }
      if (format[0] === "countdown") {
        if (format[1] === "v2") {
          const decode = (value: string | undefined) =>
            decodeURIComponent((value ?? "").replaceAll("+", " "));
          return formatCountdownPreview(
            decode(format[2]),
            format[4] || "countdown",
            decode(format[8]) || "Complete",
            now,
            format[5] || "none",
            decode(format[3]) || timezone,
            format[6] || "completed_text",
            format[7] || "1111",
          );
        }
        const completionText = format.pop() || "Complete";
        const mode = format.pop() || "countdown";
        format.pop(); // Timezone is already reflected in the saved ISO target.
        const target = format.slice(1).join(":");
        return formatCountdownPreview(target, mode, completionText, now);
      }
    }
    return candidate.fallback ?? "";
  };
  const resolve = () => (binding ? resolveBinding(binding) : "");
  if (node.condition) {
    const actual = resolveBinding(node.condition.binding);
    const expected = node.condition.value ?? "";
    const actualDate = parseISODateTime(actual)?.date;
    const expectedDate = parseISODateTime(expected)?.date;
    const actualNumber = Number(actual);
    const expectedNumber = Number(expected);
    const matches = {
      equals: actual === expected,
      not_equals: actual !== expected,
      empty: actual.length === 0,
      not_empty: actual.length > 0,
      greater_than: actualNumber > expectedNumber,
      greater_or_equal: actualNumber >= expectedNumber,
      less_than: actualNumber < expectedNumber,
      less_or_equal: actualNumber <= expectedNumber,
      before: Boolean(
        actualDate &&
        expectedDate &&
        actualDate.getTime() < expectedDate.getTime(),
      ),
      after: Boolean(
        actualDate &&
        expectedDate &&
        actualDate.getTime() > expectedDate.getTime(),
      ),
    }[node.condition.op];
    if (!matches) return null;
  }
  if (node.type === "repeat") {
    const scoped = selectTemporalRecords(
      datasetRecords(node.repeat?.dataset),
      now,
      node.repeat?.selector,
      node.repeat?.startField,
      node.repeat?.endField,
    ).slice(node.repeat?.offset ?? 0);
    return (
      <>
        {scoped.slice(0, node.repeat?.limit ?? 20).map((item, index) => (
          <div key={item.id ?? index}>
            {node.children?.map((child, childIndex) => (
              <PreviewNode
                key={child.id ?? childIndex}
                node={child}
                records={records}
                datasets={datasets}
                sourceCurrencies={sourceCurrencies}
                record={item}
                recordIndex={index}
                recordCurrencies={
                  datasetCurrencies?.[node.repeat?.dataset ?? ""] ??
                  sourceCurrencies
                }
                regional={regional}
                now={now}
                assetImageUrl={assetImageUrl}
              />
            ))}
          </div>
        ))}
      </>
    );
  }
  if (node.type === "qr_code") return <PresentationQrCode value={resolve()} />;
  if (["text", "badge", "marquee"].includes(node.type)) {
    const fontSize = Number(props.fontSize);
    const authoredFontSize =
      Number.isFinite(fontSize) && fontSize > 0 ? fontSize : undefined;
    return (
      <span
        className={`presentation-preview__${node.type}${typeof props.role === "string" ? ` presentation-preview__${node.type}--${props.role}` : ""}`}
        data-preview-font-size={authoredFontSize}
        style={{
          color: typeof props.color === "string" ? props.color : undefined,
          fontSize: authoredFontSize ? `${authoredFontSize}px` : undefined,
          fontWeight: Number.isFinite(Number(props.fontWeight))
            ? Number(props.fontWeight)
            : undefined,
          textAlign:
            props.align === "left" ||
            props.align === "center" ||
            props.align === "right"
              ? props.align
              : undefined,
        }}
      >
        {resolve()}
      </span>
    );
  }
  if (node.type === "progress") {
    const value = Number(resolve());
    const targetProp = props.target;
    const target = props.targetIsField
      ? Number(datasetRecords(binding?.dataset)[0]?.[String(targetProp)] ?? 0)
      : Number(targetProp ?? 100);
    const percent =
      target > 0 ? Math.max(0, Math.min(100, (value / target) * 100)) : 0;
    return (
      <div className="presentation-preview__progress">
        <span style={{ width: `${percent}%` }} />
        {props.showPercent === true && <strong>{Math.round(percent)}%</strong>}
      </div>
    );
  }
  if (["line_chart", "bar_chart", "donut_chart"].includes(node.type)) {
    const fields = node.binding?.fields ?? [];
    const values = datasetRecords(node.binding?.dataset).flatMap((entry) =>
      fields.map((field) => Number(entry[field])).filter(Number.isFinite),
    );
    const maximum = Math.max(...values, 1);
    return (
      <div
        className={`presentation-preview__chart presentation-preview__${node.type}`}
      >
        {(values.length ? values : [0]).slice(0, 24).map((value, index) => (
          <i
            key={index}
            style={{ height: `${Math.max(3, (value / maximum) * 100)}%` }}
          />
        ))}
      </div>
    );
  }
  if (node.type === "asset_image")
    return assetImageUrl ? (
      <img
        className="presentation-preview__asset-image"
        src={assetImageUrl}
        alt=""
      />
    ) : null;
  const direction = node.type === "row" ? "row" : "column";
  const columns = Math.max(1, Number(props.columns ?? 1));
  const background =
    typeof props.backgroundColor === "string"
      ? props.backgroundColor
      : typeof props.background === "string"
        ? props.background
        : undefined;
  if (node.type === "surface") {
    // paddingPercent and textScale are author percentages: the padding insets
    // each edge (10 gives the content the center 80 percent) and the scale
    // multiplies the preview's typography, with a fit pass as the final guard.
    const padding = Math.max(
      0,
      Math.min(40, Number(props.paddingPercent ?? props.padding ?? 10)),
    );
    const scale =
      Math.max(25, Math.min(500, Number(props.textScale ?? 100))) / 100;
    return (
      <PreviewSurface
        background={
          typeof props.backgroundColor === "string"
            ? props.backgroundColor
            : undefined
        }
        inset={100 - padding * 2}
        textScale={scale}
      >
        {node.children?.map((child, index) => (
          <PreviewNode
            key={child.id ?? index}
            node={child}
            records={records}
            datasets={datasets}
            sourceCurrencies={sourceCurrencies}
            record={record}
            recordIndex={recordIndex}
            recordCurrencies={recordCurrencies}
            regional={regional}
            now={now}
            assetImageUrl={assetImageUrl}
          />
        ))}
      </PreviewSurface>
    );
  }
  return (
    <div
      className={`presentation-preview__${node.type}`}
      style={{
        display: node.type === "grid" ? "grid" : "flex",
        flexDirection: direction,
        alignItems: props.align === "center" ? "center" : undefined,
        justifyContent: props.justify === "center" ? "center" : undefined,
        gridTemplateColumns:
          node.type === "grid"
            ? `repeat(${columns}, minmax(0, 1fr))`
            : undefined,
        gap: `${Number(props.gap ?? 8)}px`,
        background,
        padding: `${Number(props.padding ?? 0)}px`,
        borderRadius: Number.isFinite(Number(props.radius))
          ? `${Number(props.radius)}px`
          : undefined,
      }}
    >
      {node.children?.map((child, index) => (
        <PreviewNode
          key={child.id ?? index}
          node={child}
          records={records}
          datasets={datasets}
          sourceCurrencies={sourceCurrencies}
          record={record}
          recordIndex={recordIndex}
          recordCurrencies={recordCurrencies}
          regional={regional}
          now={now}
          assetImageUrl={assetImageUrl}
        />
      ))}
    </div>
  );
}

/**
 * The Widget surface: a full-bleed background with the content inset by the
 * author's padding percentage and its typography multiplied by their scale.
 * After layout, any text that still overflows the content area is shrunk, so
 * the preview matches the Player's fit-to-bounds guard instead of clipping.
 */
function PreviewSurface({
  background,
  inset,
  textScale,
  children,
}: {
  background?: string;
  inset: number;
  textScale: number;
  children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    for (const el of Array.from(
      content.querySelectorAll<HTMLElement>("span, div"),
    )) {
      if (el.firstElementChild) continue;
      const authoredSize = Number(el.dataset.previewFontSize);
      el.style.fontSize =
        Number.isFinite(authoredSize) && authoredSize > 0
          ? `${authoredSize}px`
          : "";
      let size = parseFloat(window.getComputedStyle(el).fontSize);
      if (!Number.isFinite(size)) continue;
      let guard = 0;
      while (
        guard++ < 60 &&
        size > 6 &&
        (el.scrollWidth > content.clientWidth + 1 ||
          el.scrollHeight > content.clientHeight + 1)
      ) {
        size = Math.max(6, size * 0.9);
        el.style.fontSize = `${size}px`;
      }
    }
  });
  return (
    <div
      className="presentation-preview__surface"
      style={
        {
          background,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          "--widget-text-scale": textScale,
        } as CSSProperties
      }
    >
      <div
        ref={contentRef}
        className="presentation-preview__surface-content"
        style={{ width: `${inset}%`, height: `${inset}%` }}
      >
        {children}
      </div>
    </div>
  );
}

export function formatPresentationValue(
  value: string,
  binding: NonNullable<PresentationNode["binding"]>,
  now: Date,
  // Field metadata carries the ISO currency code. Preview records are flat strings, so the
  // callers below have none to pass; see the currency fallback in the numeric branch.
  currency?: string,
  locale?: string,
  t?: WidgetsT,
  regional?: OrganizationRegionalProfile,
) {
  let result = value;
  const profile = regional ?? {
    locale: locale ?? "en-US",
    timezone: "UTC",
    dateFormat: "locale",
    timeFormat: "locale",
  };
  if (value && binding.format === "relative-countdown") {
    const target = parseISODateTime(value)?.date;
    const remaining = target ? target.getTime() - now.getTime() : Number.NaN;
    if (Number.isFinite(remaining)) {
      const seconds = Math.max(0, Math.floor(remaining / 1000));
      const days = Math.floor(seconds / 86_400);
      const hours = Math.floor((seconds % 86_400) / 3_600);
      const minutes = Math.floor((seconds % 3_600) / 60);
      const trailingSeconds = seconds % 60;
      result =
        remaining <= 0
          ? (t?.("widgets.preview.relativeNow") ?? "Now")
          : days > 0
            ? `${days}d ${hours}h`
            : hours > 0
              ? `${hours}h ${minutes}m`
              : minutes > 0
                ? `${minutes}m ${trailingSeconds}s`
                : `${trailingSeconds}s`;
    }
  } else if (
    value &&
    ["date", "date-short", "date-long", "datetime", "time"].includes(
      binding.format ?? "",
    )
  ) {
    result = formatRegionalDateTimeValue(
      value,
      binding.format as
        "date" | "date-short" | "date-long" | "datetime" | "time",
      profile,
    );
  } else {
    const numeric = Number(value);
    if (value && Number.isFinite(numeric)) {
      const precision =
        binding.precision ?? (binding.format === "integer" ? 0 : 2);
      if (
        ["number", "integer", "percent", "currency"].includes(
          binding.format ?? "",
        )
      ) {
        // Matches DeclarativePresentationPlayback.formatValue: percent records hold whole
        // percentages, and an explicit precision pins both fraction-digit bounds. Currency
        // styling needs an ISO code; without one the preview keeps plain-number formatting
        // rather than guessing a currency the Player would not use.
        const style =
          binding.format === "percent"
            ? "percent"
            : binding.format === "currency" && currency
              ? "currency"
              : "decimal";
        const numberOptions: Intl.NumberFormatOptions = {
          style,
          currency: style === "currency" ? currency : undefined,
        };
        // Let Intl use the ISO currency's standard fraction digits (JPY 0,
        // EUR 2, KWD 3). A locale is for presentation and cannot supply the
        // semantic currency or its minor-unit precision.
        if (!(binding.format === "currency" && binding.precision == null)) {
          numberOptions.maximumFractionDigits = precision;
          numberOptions.minimumFractionDigits =
            binding.precision ?? (binding.format === "integer" ? 0 : undefined);
        }
        result = new Intl.NumberFormat(profile.locale, numberOptions).format(
          binding.format === "percent" ? numeric / 100 : numeric,
        );
      }
    }
  }
  return `${binding.prefix ?? ""}${result}${binding.suffix ?? ""}`;
}

export function selectTemporalRecords(
  records: Record<string, string>[],
  now: Date,
  selector: PresentationBinding["selector"] = "all",
  startField = "",
  endField = "",
) {
  if (!selector || selector === "all") return records;
  if (!startField) return [];
  const timed = records
    .map((record) => ({
      record,
      start: parseISODateTime(record[startField] ?? "")?.date,
      end: endField
        ? parseISODateTime(record[endField] ?? "")?.date
        : undefined,
    }))
    .filter(
      (item): item is typeof item & { start: Date } => item.start !== undefined,
    )
    .sort((left, right) => left.start.getTime() - right.start.getTime());
  const current = timed
    .filter(
      ({ start, end }) =>
        start <= now &&
        end !== undefined &&
        !Number.isNaN(end.getTime()) &&
        end > now,
    )
    .map(({ record }) => record);
  const upcoming = timed
    .filter(({ start }) => start > now)
    .map(({ record }) => record);
  if (selector === "current") return current;
  if (selector === "next") return upcoming.slice(0, 1);
  if (selector === "upcoming") return upcoming;
  if (selector === "current_or_next")
    return current.length ? current : upcoming.slice(0, 1);
  return [];
}

function PresentationQrCode({ value }: { value: string }) {
  const { t } = useTranslation(["content", "common"]);
  const [url, setUrl] = useState("");
  useEffect(() => {
    let current = true;
    if (!value) {
      setUrl("");
      return;
    }
    void QRCode.toDataURL(value, { margin: 1, width: 640 })
      .then((next) => {
        if (current) setUrl(next);
      })
      .catch(() => {
        if (current) setUrl("");
      });
    return () => {
      current = false;
    };
  }, [value]);
  return url ? (
    <img
      className="presentation-preview__qr-code"
      src={url}
      alt={t("widgets.preview.qrAlt", { value })}
    />
  ) : (
    <span>{t("widgets.preview.qrPreparing")}</span>
  );
}
const defaultYouTube: YouTubeConfig = {
  url: "https://www.youtube.com/watch?v=",
  startSeconds: 0,
  loop: false,
  muted: false,
  volume: 100,
  captions: false,
  captionLanguage: "",
  controls: false,
  failureBehavior: "placeholder",
  playlistPlaybackMode: "until_end",
};

export function YouTubeSourceEditor({
  asset,
  csrf,
  readOnly = false,
  onClose,
  onSaved,
  page = false,
}: {
  asset?: Asset;
  csrf: string;
  readOnly?: boolean;
  onClose: () => void;
  onSaved: (asset: Asset) => void;
  page?: boolean;
}) {
  const { t } = useTranslation(["content", "common"]);
  const queryClient = useQueryClient();
  const configured = asset?.widget?.configuration as YouTubeConfig | undefined;
  const [name, setName] = useState(asset?.name ?? "");
  const [description, setDescription] = useState(asset?.description ?? "");
  const [configuration, setConfiguration] = useState<YouTubeConfig>(
    configured ?? defaultYouTube,
  );
  const [dirty, setDirty] = useState(false);
  const set = <K extends keyof YouTubeConfig>(
    key: K,
    value: YouTubeConfig[K],
  ) => {
    setConfiguration((current) => ({ ...current, [key]: value }));
    setDirty(true);
  };
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [dirty]);
  const images = useQuery({
    queryKey: ["assets", "source-fallbacks"],
    queryFn: () =>
      api.assets(
        new URLSearchParams({
          page: "1",
          pageSize: "100",
          type: "image",
          status: "ready",
        }),
      ),
  });
  const save = useMutation({
    mutationFn: () => {
      const input = {
        provider: "youtube" as const,
        name,
        description,
        configuration,
      };
      return asset
        ? api.updateWidget(asset.id, input, csrf)
        : api.createWidget(input, csrf);
    },
    onSuccess: (saved) => {
      toast.add({
        title: asset ? "Widget updated." : "Widget created.",
        type: "success",
      });
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ["assets"] });
      onSaved(saved);
    },
  });
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const requestClose = () => {
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };
  const close = requestClose;
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (dirty) setConfirmDiscard(true);
        else onClose();
      }
    };
    addEventListener("keydown", escape);
    return () => removeEventListener("keydown", escape);
  }, [dirty, onClose]);
  return (
    <div
      className={
        page
          ? "grid w-full min-w-0 gap-5"
          : "fixed inset-0 z-50 overflow-y-auto bg-black/50 p-4"
      }
      role={page ? undefined : "presentation"}
    >
      <section
        className={
          page
            ? "grid w-full min-w-0 gap-5"
            : "mx-auto grid w-full max-w-3xl gap-5 rounded-xl bg-background p-5"
        }
        role={page ? undefined : "dialog"}
        aria-modal={page ? undefined : true}
        aria-labelledby="youtube-source-title"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 id="youtube-source-title" className="text-xl font-semibold">
              {asset
                ? t("widgets.editors.youtube.editTitle")
                : t("widgets.editors.youtube.createTitle")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("widgets.editors.youtube.hint")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {page && !readOnly && (
              <EditorHeaderActions
                dirty={dirty}
                dirtyLabel={t("widgets.editors.v2.unsaved")}
                onSave={() => save.mutate()}
                saveDisabled={save.isPending || !name.trim()}
                saveLabel={
                  save.isPending
                    ? t("common:actions.saving")
                    : t("widgets.editors.shared.saveWidget")
                }
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("common:actions.close")}
              onClick={close}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        </div>
        <Field>
          <FieldLabel htmlFor="name">
            {t("widgets.editors.youtube.nameLabel")}
          </FieldLabel>
          <Input
            id="name"
            disabled={readOnly}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setDirty(true);
            }}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="youtube-description">
            {t("widgets.editors.shared.description")}
          </FieldLabel>
          <Textarea
            id="youtube-description"
            disabled={readOnly}
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
              setDirty(true);
            }}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="youtube-url">
            {t("widgets.editors.youtube.urlLabel")}
          </FieldLabel>
          <Input
            id="youtube-url"
            disabled={readOnly}
            value={configuration.url}
            onChange={(event) => set("url", event.target.value)}
          />
          <FieldDescription>
            {t("widgets.editors.youtube.urlHint")}
          </FieldDescription>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="youtube-start">
              {t("widgets.editors.youtube.startLabel")}
            </FieldLabel>
            <Input
              id="youtube-start"
              type="number"
              min={0}
              disabled={readOnly}
              value={configuration.startSeconds}
              onChange={(event) =>
                set("startSeconds", Number(event.target.value))
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="youtube-end">
              {t("widgets.editors.youtube.endLabel")}
            </FieldLabel>
            <Input
              id="youtube-end"
              type="number"
              min={1}
              disabled={readOnly}
              value={configuration.endSeconds ?? ""}
              onChange={(event) =>
                set(
                  "endSeconds",
                  event.target.value ? Number(event.target.value) : undefined,
                )
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="youtube-volume">
              {t("widgets.editors.youtube.volumeLabel")}
            </FieldLabel>
            <div className="flex items-center gap-2">
              <Input
                id="youtube-volume"
                type="number"
                min={0}
                max={100}
                disabled={readOnly || configuration.muted}
                value={configuration.volume}
                onChange={(event) => set("volume", Number(event.target.value))}
                className="max-w-28"
              />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
          </Field>
          <Field>
            <FieldLabel htmlFor="youtube-captions">
              {t("widgets.editors.youtube.captionsLabel")}
            </FieldLabel>
            <Input
              id="youtube-captions"
              disabled={readOnly || !configuration.captions}
              placeholder="en"
              value={configuration.captionLanguage}
              onChange={(event) => set("captionLanguage", event.target.value)}
            />
          </Field>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {(
            [
              ["loop", "widgets.editors.youtube.loop"],
              ["muted", "widgets.editors.youtube.muted"],
              ["captions", "widgets.editors.youtube.captions"],
              ["controls", "widgets.editors.youtube.controls"],
            ] as const
          ).map(([key, labelKey]) => (
            <label key={key} className="flex items-center gap-2 text-sm">
              <Switch
                disabled={readOnly}
                checked={configuration[key]}
                onCheckedChange={(checked) => set(key, checked === true)}
                aria-label={t(labelKey)}
              />
              <span>{t(labelKey)}</span>
            </label>
          ))}
        </div>
        <Field>
          <FieldLabel htmlFor="youtube-playback-mode">
            {t("widgets.editors.youtube.behavior")}
          </FieldLabel>
          <Select
            items={[
              {
                value: "until_end",
                label: t("widgets.editors.youtube.behaviorUntilEnd"),
              },
              {
                value: "fixed_duration",
                label: t("widgets.editors.youtube.behaviorFixed"),
              },
            ]}
            disabled={readOnly}
            value={configuration.playlistPlaybackMode}
            onValueChange={(next) =>
              set(
                "playlistPlaybackMode",
                next as YouTubeConfig["playlistPlaybackMode"],
              )
            }
          >
            <SelectTrigger
              id="youtube-playback-mode"
              aria-label={t("widgets.editors.youtube.behavior")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="until_end">
                {t("widgets.editors.youtube.behaviorUntilEnd")}
              </SelectItem>
              <SelectItem value="fixed_duration">
                {t("widgets.editors.youtube.behaviorFixed")}
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {configuration.playlistPlaybackMode === "fixed_duration" && (
          <Field>
            <FieldLabel htmlFor="youtube-fixed-duration">
              {t("widgets.editors.youtube.fixedDuration")}
            </FieldLabel>
            <Input
              id="youtube-fixed-duration"
              type="number"
              min={1}
              max={86400}
              disabled={readOnly}
              value={configuration.fixedDurationSeconds ?? 30}
              onChange={(event) =>
                set("fixedDurationSeconds", Number(event.target.value))
              }
            />
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor="youtube-failure">
            {t("widgets.editors.youtube.failure")}
          </FieldLabel>
          <Select
            items={[
              {
                value: "placeholder",
                label: t("widgets.editors.youtube.failurePlaceholder"),
              },
              {
                value: "fallback_image",
                label: t("widgets.editors.youtube.failureImage"),
              },
              {
                value: "skip",
                label: t("widgets.editors.youtube.failureSkip"),
              },
            ]}
            disabled={readOnly}
            value={configuration.failureBehavior}
            onValueChange={(next) =>
              set("failureBehavior", next as YouTubeConfig["failureBehavior"])
            }
          >
            <SelectTrigger
              id="youtube-failure"
              aria-label={t("widgets.editors.youtube.failure")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="placeholder">
                {t("widgets.editors.youtube.failurePlaceholder")}
              </SelectItem>
              <SelectItem value="fallback_image">
                {t("widgets.editors.youtube.failureImage")}
              </SelectItem>
              <SelectItem value="skip">
                {t("widgets.editors.youtube.failureSkip")}
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="youtube-fallback">
            {t("widgets.editors.youtube.fallback")}
          </FieldLabel>
          <Select
            items={[
              { value: "", label: t("widgets.editors.shared.none") },
              ...(images.data?.items ?? []).map((image) => ({
                value: image.id,
                label: image.name,
              })),
            ]}
            disabled={readOnly}
            value={configuration.fallbackImageAssetId ?? ""}
            onValueChange={(next) =>
              set("fallbackImageAssetId", next || undefined)
            }
          >
            <SelectTrigger
              id="youtube-fallback"
              aria-label={t("widgets.editors.youtube.fallback")}
            >
              <SelectValue>
                {images.data?.items?.find(
                  (image) => image.id === configuration.fallbackImageAssetId,
                )?.name ?? t("widgets.editors.shared.none")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">
                {t("widgets.editors.shared.none")}
              </SelectItem>
              {images.data?.items?.map((image) => (
                <SelectItem key={image.id} value={image.id}>
                  {image.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {save.error && (
          <Alert variant="destructive">
            <AlertDescription>
              {widgetSaveErrorMessage(t, save.error)}
            </AlertDescription>
          </Alert>
        )}
        <footer className="flex flex-wrap items-center gap-2">
          {!readOnly && !page && (
            <Button
              disabled={save.isPending || !name.trim()}
              onClick={() => save.mutate()}
            >
              {save.isPending
                ? t("common:actions.saving")
                : t("widgets.editors.shared.saveWidget")}
            </Button>
          )}
          <Button type="button" variant="outline" onClick={requestClose}>
            {t("common:actions.cancel")}
          </Button>
        </footer>
        <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("widgets.editors.youtube.discardTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("widgets.editors.youtube.discardHint")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                {t("widgets.editors.youtube.keepEditing")}
              </AlertDialogCancel>
              <AlertDialogAction onClick={onClose}>
                {t("widgets.editors.youtube.discard")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </section>
    </div>
  );
}
