import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { DateTimeInput } from "../components/date-picker";
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
import { Checkbox } from "../components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Slider } from "../components/ui/slider";
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
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import QRCode from "qrcode";
import { api } from "../api/client";
import { apiErrorMessage, useFormatLocale } from "../i18n";
import type {
  Asset,
  DataSource,
  DataSourceField,
  DataSourceProvider,
  WidgetProvider,
  ClockWidgetConfig,
  DateWidgetConfig,
  QRCodeWidgetConfig,
  CountdownWidgetConfig,
  TickerWidgetConfig,
  DisplayWidgetConfig,
  FieldFormat,
  MetricWidgetConfig,
  CardsWidgetConfig,
  WeatherWidgetConfig,
  SpotlightWidgetConfig,
  StatGridWidgetConfig,
  ChartWidgetConfig,
  ProgressWidgetConfig,
  TimelineWidgetConfig,
  WorldClockWidgetConfig,
  WidgetPreset,
  YouTubeConfig,
  WidgetPresentation,
  PresentationBinding,
  PresentationNode,
} from "../api/types";
import { DataSourcePicker } from "./DataSourcePicker";
import { WidgetThumbnail } from "./WidgetThumbnail";
import { previewRecordMaps, type PreviewDatasets } from "./previewRecords";
import { PreviewTimeControl } from "./PreviewTimeControl";
import { initialPreviewTime, resolvePreviewNow } from "./previewTime";
import { captureWidgetPreview } from "./widgetPreviewCapture";

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
    case "News":
      return t("widgets.gallery.categories.news");
    case "Google":
      return t("widgets.gallery.categories.google");
    case "Design & Documents":
      return t("widgets.gallery.categories.designDocuments");
    case "Dashboards":
      return t("widgets.gallery.categories.dashboards");
    case "Feeds":
      return t("widgets.gallery.categories.feeds");
    case "Video":
      return t("widgets.gallery.categories.video");
    case "Social":
      return t("widgets.gallery.categories.social");
    case "Building Blocks / Advanced":
      return t("widgets.gallery.categories.buildingBlocks");
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
  const categories = [
    "News",
    "Google",
    "Design & Documents",
    "Dashboards",
    "Feeds",
    "Video",
    "Social",
    "Building Blocks / Advanced",
  ];
  const galleryCategory = (definition: (typeof catalog)[number]) => {
    if (categories.includes(definition.category)) return definition.category;
    if (definition.id === "youtube") return "Video";
    return "Building Blocks / Advanced";
  };
  const needle = search.trim().toLowerCase();
  const visible = catalog.filter((definition) => {
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
    const disabled = definition.availability?.enabled === false;
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
          {disabled && (
            <small
              id={`widget-availability-${definition.id}`}
              className="text-xs text-muted-foreground"
            >
              {definition.availability?.reason}
            </small>
          )}
        </span>
      </Button>
    );
  };

  const featured = visible.filter(
    (definition) =>
      definition.featured && definition.availability?.enabled !== false,
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

export type NativeProvider =
  | "clock"
  | "date"
  | "qrcode"
  | "countdown"
  | "ticker"
  | "menu"
  | "list"
  | "table"
  | "agenda"
  | "metric"
  | "cards"
  | "weather"
  | "spotlight"
  | "stat_grid"
  | "chart"
  | "progress"
  | "timeline"
  | "world_clock";
type NativeConfig =
  | ClockWidgetConfig
  | DateWidgetConfig
  | QRCodeWidgetConfig
  | CountdownWidgetConfig
  | TickerWidgetConfig
  | DisplayWidgetConfig
  | MetricWidgetConfig
  | CardsWidgetConfig
  | WeatherWidgetConfig
  | SpotlightWidgetConfig
  | StatGridWidgetConfig
  | ChartWidgetConfig
  | ProgressWidgetConfig
  | TimelineWidgetConfig
  | WorldClockWidgetConfig;
const nativeDefault = (provider: NativeProvider, t: WidgetsT): NativeConfig => {
  const colors = { foregroundColor: "#F5F7FA", backgroundColor: "#0E141B" };
  if (provider === "clock")
    return {
      timezone: "",
      format: "locale",
      showSeconds: false,
      ...colors,
    };
  if (provider === "date")
    return {
      timezone: "",
      format: "locale",
      ...colors,
    };
  if (provider === "qrcode")
    return {
      value: "https://",
      label: "",
      errorCorrection: "medium",
      foregroundColor: "#000000",
      backgroundColor: "#FFFFFF",
    };
  if (provider === "countdown")
    return {
      target: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 16),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      mode: "countdown",
      recurrence: "none",
      layout: "stacked",
      label: "",
      completionText: t("widgets.defaults.eventStarted"),
      completionAction: "completed_text",
      showDays: true,
      showHours: true,
      showMinutes: true,
      showSeconds: false,
      ...colors,
    };
  if (provider === "metric")
    return {
      dataSourceId: "",
      valueField: "",
      label: "",
      format: "number",
      precision: 0,
      alignment: "center",
      emptyState: t("widgets.defaults.noValue"),
      ...colors,
    };
  if (provider === "cards")
    return {
      dataSourceId: "",
      titleField: "",
      columns: 2,
      maximumItems: 6,
      density: "comfortable",
      emptyState: t("widgets.defaults.noItems"),
      ...colors,
    };
  if (provider === "weather")
    return {
      dataSourceId: "",
      showLocation: true,
      showCurrent: true,
      showHumidity: true,
      showWind: true,
      showPrecipitation: true,
      forecastDays: 5,
      ...colors,
    };
  if (provider === "spotlight")
    return {
      dataSourceId: "",
      titleField: "",
      emptyState: t("widgets.defaults.noInformation"),
      ...colors,
    };
  if (provider === "stat_grid")
    return {
      dataSourceId: "",
      metrics: [
        {
          label: t("widgets.defaults.metricLabel"),
          valueField: "",
          format: "number",
        },
      ],
      columns: 2,
      emptyState: t("widgets.defaults.noInformation"),
      ...colors,
    };
  if (provider === "chart")
    return {
      dataSourceId: "",
      dataset: "records",
      chartType: "line",
      series: [
        {
          field: "",
          label: t("widgets.defaults.seriesFirst"),
          color: "#4DB6FF",
        },
      ],
      showLegend: true,
      showAxes: true,
      emptyState: t("widgets.defaults.noChartData"),
      ...colors,
    };
  if (provider === "progress")
    return {
      dataSourceId: "",
      valueField: "",
      staticTarget: 100,
      label: t("widgets.defaults.progressLabel"),
      showPercent: true,
      completionText: t("widgets.defaults.complete"),
      emptyState: t("widgets.defaults.noInformation"),
      ...colors,
    };
  if (provider === "timeline")
    return {
      dataSourceId: "",
      dateField: "",
      titleField: "",
      orientation: "vertical",
      maximumItems: 8,
      emptyState: t("widgets.defaults.noMilestones"),
      ...colors,
    };
  if (provider === "world_clock")
    return {
      zones: [
        {
          label: t("widgets.defaults.zoneLocal"),
          timezone: "",
        },
      ],
      format: "locale",
      showSeconds: false,
      showDate: true,
      columns: 1,
      ...colors,
    };
  if (["menu", "list", "table", "agenda"].includes(provider))
    return {
      dataSourceId: "",
      fields: ["title", "subtitle"],
      maximumItems: provider === "menu" ? 2 : 20,
      emptyState: t("widgets.defaults.noItems"),
      rowSpacing: "comfortable",
      mode: provider === "menu" ? "single_record" : "records",
      ...colors,
    };
  return {
    dataSourceId: "",
    field: "title",
    separator: " • ",
    speed: "normal",
    direction: "left",
    emptyState: t("widgets.defaults.noItems"),
    ...colors,
  };
};

function nativeWidgetGuidance(provider: NativeProvider, t: WidgetsT) {
  if (
    [
      "ticker",
      "menu",
      "list",
      "table",
      "agenda",
      "metric",
      "cards",
      "weather",
      "spotlight",
      "stat_grid",
      "chart",
      "progress",
      "timeline",
    ].includes(provider)
  )
    return t("widgets.editors.native.guidanceData");
  return t("widgets.editors.native.guidanceSimple");
}

function nativeWidgetContentGuidance(provider: NativeProvider, t: WidgetsT) {
  if (
    [
      "ticker",
      "menu",
      "list",
      "table",
      "agenda",
      "metric",
      "cards",
      "weather",
      "spotlight",
      "stat_grid",
      "chart",
      "progress",
      "timeline",
    ].includes(provider)
  )
    return t("widgets.editors.native.contentGuidanceData");
  if (provider === "countdown")
    return t("widgets.editors.native.contentGuidanceCountdown");
  if (provider === "qrcode")
    return t("widgets.editors.native.contentGuidanceQr");
  if (provider === "world_clock")
    return t("widgets.editors.native.contentGuidanceWorldClock");
  if (provider === "clock" || provider === "date")
    return t("widgets.editors.native.contentGuidanceClock");
  return t("widgets.editors.native.contentGuidanceText");
}

export function NativeAppEditor({
  provider,
  asset,
  csrf,
  readOnly = false,
  onClose,
  onSaved,
  page = false,
  presetId,
}: {
  provider: NativeProvider;
  asset?: Asset;
  csrf: string;
  readOnly?: boolean;
  onClose: () => void;
  onSaved: (asset: Asset) => void;
  page?: boolean;
  presetId?: WidgetPreset;
}) {
  const { t } = useTranslation(["content", "common"]);
  const queryClient = useQueryClient();
  const previewRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(asset?.name ?? "");
  const [description, setDescription] = useState(asset?.description ?? "");
  const [configuration, setConfiguration] = useState<NativeConfig>(
    (asset?.widget?.configuration as NativeConfig | undefined) ??
      nativeDefault(provider, t),
  );
  const [previewTime, setPreviewTime] = useState(initialPreviewTime);
  const dataSources = useQuery({
    queryKey: ["widget-data-sources"],
    queryFn: () =>
      api.listDataSources(
        new URLSearchParams({ page: "1", pageSize: "100", sort: "name" }),
      ),
    enabled: [
      "ticker",
      "menu",
      "list",
      "table",
      "agenda",
      "metric",
      "cards",
      "weather",
      "spotlight",
      "stat_grid",
      "chart",
      "progress",
      "timeline",
    ].includes(provider),
  });
  const imageAssets = useQuery({
    queryKey: ["widget-image-assets"],
    queryFn: () =>
      api.assets(
        new URLSearchParams({
          page: "1",
          pageSize: "100",
          type: "image",
          status: "ready",
          sort: "name",
        }),
      ),
    enabled: provider === "spotlight",
  });
  const acceptedProviders: Record<string, string[]> = {
    ticker: ["rss", "atom", "calendar", "json", "csv", "manual", "weather"],
    menu: ["calendar", "rss", "atom", "json", "csv", "manual", "weather"],
    list: ["calendar", "rss", "atom", "json", "csv", "manual", "weather"],
    table: ["calendar", "rss", "atom", "json", "csv", "manual", "weather"],
    agenda: ["calendar", "json", "csv", "manual", "weather"],
    metric: ["json", "csv", "manual", "weather"],
    cards: ["calendar", "rss", "atom", "json", "csv", "manual", "weather"],
    weather: ["weather"],
    spotlight: [
      "calendar",
      "rss",
      "atom",
      "json",
      "csv",
      "manual",
      "weather",
      "transit",
      "cap_alerts",
      "air_quality",
    ],
    stat_grid: ["json", "csv", "manual", "weather", "air_quality"],
    chart: ["json", "csv", "manual", "weather", "air_quality"],
    progress: ["json", "csv", "manual", "weather", "air_quality"],
    timeline: [
      "calendar",
      "json",
      "csv",
      "manual",
      "weather",
      "transit",
      "cap_alerts",
    ],
  };
  const compatibleDataSources = (dataSources.data?.items ?? []).filter(
    (source) => (acceptedProviders[provider] ?? []).includes(source.provider),
  );
  // The same acceptance list narrows what the picker's Connect flow may create, so an author
  // cannot connect a provider this Widget would then refuse.
  const acceptedCreateProviders = (acceptedProviders[provider] ??
    []) as DataSourceProvider[];
  const selectedDataSourceId = [
    "ticker",
    "menu",
    "list",
    "table",
    "agenda",
    "metric",
    "cards",
    "weather",
    "spotlight",
    "stat_grid",
    "chart",
    "progress",
    "timeline",
  ].includes(provider)
    ? (
        configuration as
          | TickerWidgetConfig
          | DisplayWidgetConfig
          | MetricWidgetConfig
          | CardsWidgetConfig
          | WeatherWidgetConfig
          | SpotlightWidgetConfig
          | StatGridWidgetConfig
          | ChartWidgetConfig
          | ProgressWidgetConfig
          | TimelineWidgetConfig
      ).dataSourceId
    : "";
  const selectedDataSource = useQuery({
    queryKey: ["widget-data-source", selectedDataSourceId],
    queryFn: () => api.getDataSource(selectedDataSourceId),
    enabled: Boolean(selectedDataSourceId),
  });
  const sourcePreview = useQuery({
    queryKey: ["widget-data-source-preview", selectedDataSourceId],
    queryFn: () => api.previewSavedDataSource(selectedDataSourceId),
    enabled: Boolean(selectedDataSourceId),
  });
  const compiledPreview = useQuery({
    queryKey: ["compiled-widget-preview", provider, configuration],
    queryFn: () =>
      api.compileWidgetPreview(
        provider,
        configuration as Parameters<typeof api.compileWidgetPreview>[1],
        csrf,
      ),
    retry: false,
  });
  const availableFields = selectedDataSource.data?.fields ?? [];
  const save = useMutation({
    mutationFn: async () => {
      if (
        !previewRef.current ||
        !compiledPreview.data ||
        (selectedDataSourceId && sourcePreview.isLoading)
      )
        throw new Error(t("widgets.errors.previewWait"));
      const previewImage = await captureWidgetPreview(previewRef.current, t);
      const input = { provider, presetId, name, description, configuration };
      const saved = asset
        ? api.updateWidget(asset.id, input, csrf)
        : api.createWidget(input, csrf);
      const result = await saved;
      await api.uploadWidgetPreview(result.id, previewImage, csrf);
      return {
        ...result,
        thumbnailUrl: `/api/v1/assets/${encodeURIComponent(result.id)}/thumbnail`,
      };
    },
    onSuccess: (saved) => {
      toast.add({
        title: asset ? "Widget updated." : "Widget created.",
        type: "success",
      });
      void queryClient.invalidateQueries({ queryKey: ["assets"] });
      onSaved(saved);
    },
  });
  const updateColors = (
    key: "foregroundColor" | "backgroundColor",
    value: string,
  ) => setConfiguration((current) => ({ ...current, [key]: value }));
  const previewImageAssetId =
    "imageAssetId" in configuration &&
    typeof configuration.imageAssetId === "string"
      ? configuration.imageAssetId
      : "";
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
            : "mx-auto grid w-full max-w-5xl gap-5 rounded-xl bg-background p-5"
        }
        role={page ? undefined : "dialog"}
        aria-modal={page ? undefined : true}
        aria-labelledby="native-app-title"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 id="native-app-title" className="text-xl font-semibold">
              {t(
                asset
                  ? "widgets.editors.native.editTitle"
                  : "widgets.editors.native.createTitle",
                {
                  // i18n-ignore: provider IDs stay English; only "QR Code" is a display name
                  provider:
                    provider === "qrcode"
                      ? t("widgets.editors.native.qrCodeName")
                      : provider[0]!.toUpperCase() + provider.slice(1),
                },
              )}
            </h2>
            <p className="text-sm text-muted-foreground">
              {nativeWidgetGuidance(provider, t)}
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
        <div className="grid min-w-0 gap-5">
          {presetId && (
            <Alert>
              <AlertDescription>
                <Trans
                  i18nKey="widgets.editors.native.presetNotice"
                  ns="content"
                  values={{
                    preset: presetId.replaceAll("_", " "),
                    provider: provider.replaceAll("_", " "),
                  }}
                  components={{ strong: <strong /> }}
                />
              </AlertDescription>
            </Alert>
          )}
          <section className="widget-editor__section">
            <header>
              <h3>{t("widgets.editors.shared.detailsTitle")}</h3>
              <p>{t("widgets.editors.shared.detailsHint")}</p>
            </header>
            <div className="widget-editor__section-body">
              <Field>
                <FieldLabel htmlFor="widget-name">
                  {t("widgets.editors.shared.widgetName")}
                </FieldLabel>
                <Input
                  id="widget-name"
                  value={name}
                  disabled={readOnly}
                  onChange={(e) => setName(e.target.value)}
                />
                <FieldDescription>
                  {t("widgets.editors.native.nameHint")}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="description">
                  {t("widgets.editors.shared.description")}
                </FieldLabel>
                <Input
                  id="description"
                  value={description}
                  disabled={readOnly}
                  onChange={(e) => setDescription(e.target.value)}
                />
                <FieldDescription>
                  {t("widgets.editors.shared.descriptionHint")}
                </FieldDescription>
              </Field>
            </div>
          </section>
          <section className="widget-editor__section">
            <header>
              <h3>{t("widgets.editors.native.contentTitle")}</h3>
              <p>{nativeWidgetContentGuidance(provider, t)}</p>
            </header>
            <div className="widget-editor__section-body">
              {(provider === "clock" || provider === "date") && (
                <Field>
                  <FieldLabel htmlFor="timezone">
                    {t("widgets.editors.shared.timezone")}
                  </FieldLabel>
                  <Input
                    id="timezone"
                    value={
                      (configuration as ClockWidgetConfig | DateWidgetConfig)
                        .timezone
                    }
                    disabled={readOnly}
                    onChange={(e) =>
                      setConfiguration((current) => ({
                        ...current,
                        timezone: e.target.value,
                      }))
                    }
                  />
                  <FieldDescription>
                    {t("widgets.editors.clock.timezoneHint")}
                  </FieldDescription>
                </Field>
              )}
              {provider === "clock" && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="widget-time-format">
                      {t("widgets.editors.shared.timeFormat")}
                    </FieldLabel>
                    <Select
                      items={[
                        {
                          value: "locale",
                          label: t(
                            "widgets.editors.options.organizationFormat",
                          ),
                        },
                        {
                          value: "12",
                          label: t("widgets.editors.options.hour12"),
                        },
                        {
                          value: "24",
                          label: t("widgets.editors.options.hour24"),
                        },
                      ]}
                      value={(configuration as ClockWidgetConfig).format}
                      disabled={readOnly}
                      onValueChange={(next) =>
                        setConfiguration((current) => ({
                          ...(current as ClockWidgetConfig),
                          format: next as ClockWidgetConfig["format"],
                        }))
                      }
                    >
                      <SelectTrigger
                        id="widget-time-format"
                        aria-label={t("widgets.editors.shared.timeFormat")}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="locale">
                          {t("widgets.editors.options.organizationFormat")}
                        </SelectItem>
                        <SelectItem value="12">
                          {t("widgets.editors.options.hour12")}
                        </SelectItem>
                        <SelectItem value="24">
                          {t("widgets.editors.options.hour24")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <label className="flex items-center gap-2 self-end pb-2 text-sm">
                    <Switch
                      checked={(configuration as ClockWidgetConfig).showSeconds}
                      disabled={readOnly}
                      onCheckedChange={(checked) =>
                        setConfiguration((current) => ({
                          ...current,
                          showSeconds: checked === true,
                        }))
                      }
                      aria-label={t("widgets.editors.clock.showSeconds")}
                    />
                    <span>{t("widgets.editors.clock.showSeconds")}</span>
                  </label>
                </div>
              )}
              {provider === "date" && (
                <Field>
                  <FieldLabel htmlFor="widget-date-format">
                    {t("widgets.editors.date.dateFormat")}
                  </FieldLabel>
                  <Select
                    items={[
                      {
                        value: "locale",
                        label: t("widgets.editors.options.organizationFormat"),
                      },
                      {
                        value: "full",
                        label: t("widgets.editors.options.dateFull"),
                      },
                      {
                        value: "long",
                        label: t("widgets.editors.options.dateLong"),
                      },
                      {
                        value: "medium",
                        label: t("widgets.editors.options.dateMedium"),
                      },
                      {
                        value: "short",
                        label: t("widgets.editors.options.dateShort"),
                      },
                    ]}
                    value={(configuration as DateWidgetConfig).format}
                    disabled={readOnly}
                    onValueChange={(next) =>
                      setConfiguration((current) => ({
                        ...(current as DateWidgetConfig),
                        format: next as DateWidgetConfig["format"],
                      }))
                    }
                  >
                    <SelectTrigger
                      id="widget-date-format"
                      aria-label={t("widgets.editors.date.dateFormat")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="locale">
                        {t("widgets.editors.options.organizationFormat")}
                      </SelectItem>
                      <SelectItem value="full">
                        {t("widgets.editors.options.dateFull")}
                      </SelectItem>
                      <SelectItem value="long">
                        {t("widgets.editors.options.dateLong")}
                      </SelectItem>
                      <SelectItem value="medium">
                        {t("widgets.editors.options.dateMedium")}
                      </SelectItem>
                      <SelectItem value="short">
                        {t("widgets.editors.options.dateShort")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              )}
              {provider === "countdown" && (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor="countdown-target">
                        {t("widgets.editors.countdown.target")}
                      </FieldLabel>
                      <DateTimeInput
                        id="countdown-target"
                        aria-label={t("widgets.editors.countdown.target")}
                        timeLabel={t("widgets.editors.countdown.targetTime")}
                        value={(configuration as CountdownWidgetConfig).target}
                        disabled={readOnly}
                        onChange={(value) =>
                          setConfiguration((current) => ({
                            ...current,
                            target: value,
                          }))
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="countdown-timezone">
                        {t("widgets.editors.shared.timezone")}
                      </FieldLabel>
                      <Input
                        id="countdown-timezone"
                        value={
                          (configuration as CountdownWidgetConfig).timezone
                        }
                        disabled={readOnly}
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...current,
                            timezone: event.target.value,
                          }))
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="countdown-mode">
                        {t("widgets.editors.countdown.mode")}
                      </FieldLabel>
                      <Select
                        items={[
                          {
                            value: "locale",
                            label: t(
                              "widgets.editors.options.organizationFormat",
                            ),
                          },
                          {
                            value: "locale",
                            label: t(
                              "widgets.editors.options.organizationFormat",
                            ),
                          },
                          {
                            value: "countdown",
                            label: t("widgets.editors.countdown.modeDown"),
                          },
                          {
                            value: "count_up",
                            label: t("widgets.editors.countdown.modeUp"),
                          },
                        ]}
                        value={(configuration as CountdownWidgetConfig).mode}
                        disabled={readOnly}
                        onValueChange={(next) =>
                          setConfiguration((current) => ({
                            ...(current as CountdownWidgetConfig),
                            mode: next as CountdownWidgetConfig["mode"],
                            recurrence:
                              next === "count_up"
                                ? "none"
                                : ((current as CountdownWidgetConfig)
                                    .recurrence ?? "none"),
                          }))
                        }
                      >
                        <SelectTrigger
                          id="countdown-mode"
                          aria-label={t("widgets.editors.countdown.mode")}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="countdown">
                            {t("widgets.editors.countdown.modeDown")}
                          </SelectItem>
                          <SelectItem value="count_up">
                            {t("widgets.editors.countdown.modeUp")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="countdown-repeat">
                        {t("widgets.editors.countdown.repeat")}
                      </FieldLabel>
                      <Select
                        items={[
                          {
                            value: "none",
                            label: t("widgets.editors.countdown.repeatNone"),
                          },
                          {
                            value: "daily",
                            label: t("widgets.editors.countdown.repeatDaily"),
                          },
                          {
                            value: "weekly",
                            label: t("widgets.editors.countdown.repeatWeekly"),
                          },
                          {
                            value: "monthly",
                            label: t("widgets.editors.countdown.repeatMonthly"),
                          },
                          {
                            value: "yearly",
                            label: t("widgets.editors.countdown.repeatYearly"),
                          },
                        ]}
                        value={
                          (configuration as CountdownWidgetConfig).recurrence ??
                          "none"
                        }
                        disabled={
                          readOnly ||
                          (configuration as CountdownWidgetConfig).mode ===
                            "count_up"
                        }
                        onValueChange={(next) =>
                          setConfiguration((current) => ({
                            ...(current as CountdownWidgetConfig),
                            recurrence:
                              next as CountdownWidgetConfig["recurrence"],
                          }))
                        }
                      >
                        <SelectTrigger
                          id="countdown-repeat"
                          aria-label={t("widgets.editors.countdown.repeat")}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">
                            {t("widgets.editors.countdown.repeatNone")}
                          </SelectItem>
                          <SelectItem value="daily">
                            {t("widgets.editors.countdown.repeatDaily")}
                          </SelectItem>
                          <SelectItem value="weekly">
                            {t("widgets.editors.countdown.repeatWeekly")}
                          </SelectItem>
                          <SelectItem value="monthly">
                            {t("widgets.editors.countdown.repeatMonthly")}
                          </SelectItem>
                          <SelectItem value="yearly">
                            {t("widgets.editors.countdown.repeatYearly")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="countdown-layout">
                        {t("widgets.editors.countdown.layout")}
                      </FieldLabel>
                      <Select
                        items={[
                          {
                            value: "stacked",
                            label: t("widgets.editors.countdown.layoutStacked"),
                          },
                          {
                            value: "horizontal",
                            label: t(
                              "widgets.editors.countdown.layoutHorizontal",
                            ),
                          },
                          {
                            value: "countdown_only",
                            label: t("widgets.editors.countdown.layoutOnly"),
                          },
                        ]}
                        value={
                          (configuration as CountdownWidgetConfig).layout ??
                          "stacked"
                        }
                        disabled={readOnly}
                        onValueChange={(next) =>
                          setConfiguration((current) => ({
                            ...(current as CountdownWidgetConfig),
                            layout: next as CountdownWidgetConfig["layout"],
                          }))
                        }
                      >
                        <SelectTrigger
                          id="countdown-layout"
                          aria-label={t("widgets.editors.countdown.layout")}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="stacked">
                            {t("widgets.editors.countdown.layoutStacked")}
                          </SelectItem>
                          <SelectItem value="horizontal">
                            {t("widgets.editors.countdown.layoutHorizontal")}
                          </SelectItem>
                          <SelectItem value="countdown_only">
                            {t("widgets.editors.countdown.layoutOnly")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="countdown-completion">
                        {t("widgets.editors.countdown.completion")}
                      </FieldLabel>
                      <Select
                        items={[
                          {
                            value: "completed_text",
                            label: t(
                              "widgets.editors.countdown.completionText",
                            ),
                          },
                          {
                            value: "hide",
                            label: t("widgets.editors.countdown.hide"),
                          },
                          {
                            value: "count_up",
                            label: t(
                              "widgets.editors.countdown.completionCountUp",
                            ),
                          },
                        ]}
                        value={
                          (configuration as CountdownWidgetConfig)
                            .completionAction
                        }
                        disabled={
                          readOnly ||
                          ((configuration as CountdownWidgetConfig)
                            .recurrence ?? "none") !== "none"
                        }
                        onValueChange={(next) =>
                          setConfiguration((current) => ({
                            ...current,
                            completionAction:
                              next as CountdownWidgetConfig["completionAction"],
                          }))
                        }
                      >
                        <SelectTrigger
                          id="countdown-completion"
                          aria-label={t("widgets.editors.countdown.completion")}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="completed_text">
                            {t("widgets.editors.countdown.completionText")}
                          </SelectItem>
                          <SelectItem value="hide">
                            {t("widgets.editors.countdown.hide")}
                          </SelectItem>
                          <SelectItem value="count_up">
                            {t("widgets.editors.countdown.completionCountUp")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor="countdown-title">
                        {t("widgets.editors.countdown.title")}
                      </FieldLabel>
                      <Input
                        id="countdown-title"
                        value={
                          (configuration as CountdownWidgetConfig).label ?? ""
                        }
                        disabled={
                          readOnly ||
                          ((configuration as CountdownWidgetConfig).layout ??
                            "stacked") === "countdown_only"
                        }
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...current,
                            label: event.target.value,
                          }))
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="countdown-completion-text">
                        {t("widgets.editors.countdown.completionLabel")}
                      </FieldLabel>
                      <Input
                        id="countdown-completion-text"
                        value={
                          (configuration as CountdownWidgetConfig)
                            .completionText ?? ""
                        }
                        disabled={
                          readOnly ||
                          ((configuration as CountdownWidgetConfig)
                            .recurrence ?? "none") !== "none"
                        }
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...current,
                            completionText: event.target.value,
                          }))
                        }
                      />
                    </Field>
                  </div>
                  <fieldset className="grid gap-2">
                    <legend className="text-sm font-medium">
                      {t("widgets.editors.countdown.units")}
                    </legend>
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                      {(
                        [
                          ["Days", "widgets.editors.countdown.unitsDays"],
                          ["Hours", "widgets.editors.countdown.unitsHours"],
                          ["Minutes", "widgets.editors.countdown.unitsMinutes"],
                          ["Seconds", "widgets.editors.countdown.unitsSeconds"],
                        ] as const
                      ).map(([unit, labelKey]) => {
                        const key =
                          `show${unit}` as keyof CountdownWidgetConfig;
                        return (
                          <label
                            key={unit}
                            className="flex items-center gap-2 text-sm"
                          >
                            <Checkbox
                              checked={Boolean(
                                (configuration as CountdownWidgetConfig)[key],
                              )}
                              disabled={readOnly}
                              onCheckedChange={(checked) =>
                                setConfiguration((current) => ({
                                  ...current,
                                  [key]: checked === true,
                                }))
                              }
                              aria-label={t(labelKey)}
                            />
                            <span>{t(labelKey)}</span>
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                </>
              )}
              {provider === "qrcode" && (
                <>
                  <Field>
                    <FieldLabel htmlFor="qrcode-value">
                      {t("widgets.editors.qrcode.valueLabel")}
                    </FieldLabel>
                    <Textarea
                      id="qrcode-value"
                      value={(configuration as QRCodeWidgetConfig).value}
                      maxLength={2048}
                      disabled={readOnly}
                      onChange={(e) =>
                        setConfiguration((current) => ({
                          ...current,
                          value: e.target.value,
                        }))
                      }
                    />
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor="qrcode-label">
                        {t("widgets.editors.shared.label")}
                      </FieldLabel>
                      <Input
                        id="qrcode-label"
                        value={
                          (configuration as QRCodeWidgetConfig).label ?? ""
                        }
                        disabled={readOnly}
                        onChange={(e) =>
                          setConfiguration((current) => ({
                            ...current,
                            label: e.target.value,
                          }))
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="qrcode-error-correction">
                        {t("widgets.editors.qrcode.errorCorrection")}
                      </FieldLabel>
                      <Select
                        items={[
                          {
                            value: "low",
                            label: t("widgets.editors.qrcode.levelLow"),
                          },
                          {
                            value: "medium",
                            label: t("widgets.editors.qrcode.levelMedium"),
                          },
                          {
                            value: "quartile",
                            label: t("widgets.editors.qrcode.levelQuartile"),
                          },
                          {
                            value: "high",
                            label: t("widgets.editors.qrcode.levelHigh"),
                          },
                        ]}
                        value={
                          (configuration as QRCodeWidgetConfig).errorCorrection
                        }
                        disabled={readOnly}
                        onValueChange={(next) =>
                          setConfiguration((current) => ({
                            ...current,
                            errorCorrection:
                              next as QRCodeWidgetConfig["errorCorrection"],
                          }))
                        }
                      >
                        <SelectTrigger
                          id="qrcode-error-correction"
                          aria-label={t(
                            "widgets.editors.qrcode.errorCorrection",
                          )}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="low">
                            {t("widgets.editors.qrcode.levelLow")}
                          </SelectItem>
                          <SelectItem value="medium">
                            {t("widgets.editors.qrcode.levelMedium")}
                          </SelectItem>
                          <SelectItem value="quartile">
                            {t("widgets.editors.qrcode.levelQuartile")}
                          </SelectItem>
                          <SelectItem value="high">
                            {t("widgets.editors.qrcode.levelHigh")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <FieldDescription>
                        {t("widgets.editors.qrcode.levelHint")}
                      </FieldDescription>
                    </Field>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor="qrcode-speed">
                        {t("widgets.editors.qrcode.speed")}
                      </FieldLabel>
                      <Select
                        items={[
                          {
                            value: "slow",
                            label: t("widgets.editors.options.speedSlow"),
                          },
                          {
                            value: "normal",
                            label: t("widgets.editors.options.speedNormal"),
                          },
                          {
                            value: "fast",
                            label: t("widgets.editors.options.speedFast"),
                          },
                        ]}
                        value={(configuration as TickerWidgetConfig).speed}
                        disabled={readOnly}
                        onValueChange={(next) =>
                          setConfiguration((current) => ({
                            ...current,
                            speed: next as TickerWidgetConfig["speed"],
                          }))
                        }
                      >
                        <SelectTrigger
                          id="qrcode-speed"
                          aria-label={t("widgets.editors.qrcode.speed")}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="slow">
                            {t("widgets.editors.options.speedSlow")}
                          </SelectItem>
                          <SelectItem value="normal">
                            {t("widgets.editors.options.speedNormal")}
                          </SelectItem>
                          <SelectItem value="fast">
                            {t("widgets.editors.options.speedFast")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="qrcode-direction">
                        {t("widgets.editors.qrcode.direction")}
                      </FieldLabel>
                      <Select
                        items={[
                          {
                            value: "left",
                            label: t("widgets.editors.options.alignLeft"),
                          },
                          {
                            value: "right",
                            label: t("widgets.editors.options.alignRight"),
                          },
                        ]}
                        value={(configuration as TickerWidgetConfig).direction}
                        disabled={readOnly}
                        onValueChange={(next) =>
                          setConfiguration((current) => ({
                            ...current,
                            direction: next as TickerWidgetConfig["direction"],
                          }))
                        }
                      >
                        <SelectTrigger
                          id="qrcode-direction"
                          aria-label={t("widgets.editors.qrcode.direction")}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="left">
                            {t("widgets.editors.options.alignLeft")}
                          </SelectItem>
                          <SelectItem value="right">
                            {t("widgets.editors.options.alignRight")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                  {(configuration as QRCodeWidgetConfig).value.length > 500 && (
                    <Alert>
                      <AlertDescription>
                        {t("widgets.editors.qrcode.denseAlert")}
                      </AlertDescription>
                    </Alert>
                  )}
                </>
              )}
              {provider === "ticker" && (
                <>
                  <DataSourceSelect
                    value={(configuration as TickerWidgetConfig).dataSourceId}
                    sources={compatibleDataSources}
                    createProviders={acceptedCreateProviders}
                    csrf={csrf}
                    disabled={readOnly}
                    onChange={(dataSourceId) =>
                      setConfiguration((current) => ({
                        ...current,
                        dataSourceId,
                      }))
                    }
                  />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <fieldset className="grid gap-2">
                      <legend className="text-sm font-medium">
                        {t("widgets.editors.ticker.fields")}
                      </legend>
                      <div className="flex flex-wrap gap-x-4 gap-y-2">
                        {availableFields.map((field) => {
                          const config = configuration as TickerWidgetConfig;
                          const selected = (
                            config.fields ?? [config.field]
                          ).includes(field.key);
                          return (
                            <label
                              key={field.key}
                              className="flex items-center gap-2 text-sm"
                            >
                              <Checkbox
                                checked={selected}
                                disabled={
                                  readOnly ||
                                  (!selected &&
                                    (config.fields ?? [config.field]).filter(
                                      Boolean,
                                    ).length >= 3)
                                }
                                onCheckedChange={(checked) =>
                                  setConfiguration((current) => {
                                    const ticker =
                                      current as TickerWidgetConfig;
                                    const fields = (
                                      ticker.fields ?? [ticker.field]
                                    ).filter(Boolean);
                                    const next =
                                      checked === true
                                        ? [...fields, field.key]
                                        : fields.filter(
                                            (item) => item !== field.key,
                                          );
                                    return {
                                      ...ticker,
                                      fields: next,
                                      field: next[0] ?? "",
                                    };
                                  })
                                }
                                aria-label={field.label}
                              />
                              <span>{field.label}</span>
                            </label>
                          );
                        })}
                      </div>
                    </fieldset>
                    <Field>
                      <FieldLabel htmlFor="ticker-separator">
                        {t("widgets.editors.ticker.separator")}
                      </FieldLabel>
                      <Input
                        id="ticker-separator"
                        value={(configuration as TickerWidgetConfig).separator}
                        disabled={readOnly}
                        onChange={(e) =>
                          setConfiguration((current) => ({
                            ...current,
                            separator: e.target.value,
                          }))
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="ticker-field-separator">
                        {t("widgets.editors.ticker.fieldSeparator")}
                      </FieldLabel>
                      <Input
                        id="ticker-field-separator"
                        value={
                          (configuration as TickerWidgetConfig)
                            .fieldSeparator ?? " — "
                        }
                        disabled={readOnly}
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...current,
                            fieldSeparator: event.target.value,
                          }))
                        }
                      />
                    </Field>
                  </div>
                </>
              )}
              {["menu", "list", "table", "agenda"].includes(provider) && (
                <>
                  <DataSourceSelect
                    value={(configuration as DisplayWidgetConfig).dataSourceId}
                    sources={compatibleDataSources}
                    createProviders={acceptedCreateProviders}
                    csrf={csrf}
                    disabled={readOnly}
                    onChange={(dataSourceId) =>
                      setConfiguration((current) => ({
                        ...current,
                        dataSourceId,
                      }))
                    }
                  />
                  <fieldset className="grid gap-2">
                    <legend className="text-sm font-medium">
                      {t("widgets.editors.display.displayedFields")}
                    </legend>
                    {!availableFields.length ? (
                      <p className="text-sm text-muted-foreground">
                        {t("widgets.editors.display.noSource")}
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-x-4 gap-y-2">
                        {availableFields.map((field) => {
                          const selected = (
                            configuration as DisplayWidgetConfig
                          ).fields.includes(field.key);
                          return (
                            <label
                              key={field.key}
                              className="flex items-center gap-2 text-sm"
                            >
                              <Checkbox
                                checked={selected}
                                disabled={readOnly}
                                onCheckedChange={(checked) =>
                                  setConfiguration((current) => {
                                    const config =
                                      current as DisplayWidgetConfig;
                                    const fields =
                                      checked === true
                                        ? [
                                            ...config.fields.filter(
                                              (item) => item !== field.key,
                                            ),
                                            field.key,
                                          ]
                                        : config.fields.filter(
                                            (item) => item !== field.key,
                                          );
                                    return { ...config, fields };
                                  })
                                }
                                aria-label={field.label}
                              />
                              <span>{field.label}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </fieldset>
                  {provider === "list" && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {(
                        [
                          ["primaryField", "widgets.editors.list.primaryField"],
                          [
                            "secondaryField",
                            "widgets.editors.shared.secondaryField",
                          ],
                          ["leadingField", "widgets.editors.list.leadingField"],
                          [
                            "trailingField",
                            "widgets.editors.list.trailingField",
                          ],
                        ] as const
                      ).map(([key, labelKey]) => (
                        <FieldSelect
                          key={key}
                          label={t(labelKey)}
                          value={
                            (configuration as DisplayWidgetConfig)[key] ?? ""
                          }
                          fields={availableFields}
                          allowEmpty={key !== "primaryField"}
                          disabled={readOnly}
                          onChange={(value) =>
                            setConfiguration((current) => ({
                              ...current,
                              [key]: value,
                            }))
                          }
                        />
                      ))}
                      <label className="flex items-center gap-2 text-sm">
                        <Switch
                          checked={
                            (configuration as DisplayWidgetConfig)
                              .showDividers ?? false
                          }
                          disabled={readOnly}
                          onCheckedChange={(checked) =>
                            setConfiguration((current) => ({
                              ...current,
                              showDividers: checked === true,
                            }))
                          }
                          aria-label={t("widgets.editors.list.showDividers")}
                        />
                        <span>{t("widgets.editors.list.showDividers")}</span>
                      </label>
                    </div>
                  )}
                  {provider === "menu" && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field>
                        <FieldLabel htmlFor="menu-presentation">
                          {t("widgets.editors.menu.presentation")}
                        </FieldLabel>
                        <Select
                          items={[
                            {
                              value: "single_record",
                              label: t("widgets.editors.menu.modeSingle"),
                            },
                            {
                              value: "records",
                              label: t("widgets.editors.menu.modeRows"),
                            },
                          ]}
                          value={
                            (configuration as DisplayWidgetConfig).mode ??
                            "single_record"
                          }
                          disabled={readOnly}
                          onValueChange={(next) =>
                            setConfiguration((current) => ({
                              ...(current as DisplayWidgetConfig),
                              mode: next as DisplayWidgetConfig["mode"],
                            }))
                          }
                        >
                          <SelectTrigger
                            id="menu-presentation"
                            aria-label={t("widgets.editors.menu.presentation")}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="single_record">
                              {t("widgets.editors.menu.modeSingle")}
                            </SelectItem>
                            <SelectItem value="records">
                              {t("widgets.editors.menu.modeRows")}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </Field>
                      {(configuration as DisplayWidgetConfig).mode ===
                        "records" && (
                        <>
                          <FieldSelect
                            label={t("widgets.editors.shared.labelField")}
                            value={
                              (configuration as DisplayWidgetConfig)
                                .labelField ?? ""
                            }
                            fields={availableFields}
                            disabled={readOnly}
                            onChange={(labelField) =>
                              setConfiguration((current) => ({
                                ...current,
                                labelField,
                              }))
                            }
                          />
                          <FieldSelect
                            label={t("widgets.editors.shared.valueField")}
                            value={
                              (configuration as DisplayWidgetConfig)
                                .valueField ?? ""
                            }
                            fields={availableFields}
                            disabled={readOnly}
                            onChange={(valueField) =>
                              setConfiguration((current) => ({
                                ...current,
                                valueField,
                              }))
                            }
                          />
                        </>
                      )}
                    </div>
                  )}
                  {provider === "table" && (
                    <>
                      <div className="flex flex-wrap gap-x-4 gap-y-2">
                        <label className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={
                              (configuration as DisplayWidgetConfig)
                                .showHeader ?? false
                            }
                            disabled={readOnly}
                            onCheckedChange={(checked) =>
                              setConfiguration((current) => ({
                                ...current,
                                showHeader: checked === true,
                              }))
                            }
                            aria-label={t("widgets.editors.table.showHeader")}
                          />
                          <span>{t("widgets.editors.table.showHeader")}</span>
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={
                              (configuration as DisplayWidgetConfig)
                                .alternatingRows ?? false
                            }
                            disabled={readOnly}
                            onCheckedChange={(checked) =>
                              setConfiguration((current) => ({
                                ...current,
                                alternatingRows: checked === true,
                              }))
                            }
                            aria-label={t("widgets.editors.table.alternating")}
                          />
                          <span>{t("widgets.editors.table.alternating")}</span>
                        </label>
                      </div>
                      <fieldset className="grid gap-2">
                        <legend className="text-sm font-medium">
                          {t("widgets.editors.table.columnPresentation")}
                        </legend>
                        {(configuration as DisplayWidgetConfig).fields.map(
                          (fieldKey) => {
                            const config = configuration as DisplayWidgetConfig;
                            const existing = config.columns?.find(
                              (column) => column.field === fieldKey,
                            ) ?? {
                              field: fieldKey,
                              label:
                                availableFields.find(
                                  (field) => field.key === fieldKey,
                                )?.label ?? fieldKey,
                              format: "text" as const,
                              alignment: "left" as const,
                              width: 0,
                            };
                            const updateColumn = (
                              patch: Partial<FieldFormat>,
                            ) =>
                              setConfiguration((current) => {
                                const table = current as DisplayWidgetConfig;
                                const columns = table.fields.map((key) => {
                                  const column = table.columns?.find(
                                    (item) => item.field === key,
                                  ) ?? { field: key };
                                  return key === fieldKey
                                    ? { ...column, ...existing, ...patch }
                                    : column;
                                });
                                return { ...table, columns };
                              });
                            return (
                              <div
                                className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
                                key={fieldKey}
                              >
                                <Field>
                                  <FieldLabel
                                    htmlFor={`column-label-${fieldKey}`}
                                  >
                                    {t("widgets.editors.shared.label")}
                                  </FieldLabel>
                                  <Input
                                    id={`column-label-${fieldKey}`}
                                    value={existing.label ?? ""}
                                    disabled={readOnly}
                                    onChange={(event) =>
                                      updateColumn({
                                        label: event.target.value,
                                      })
                                    }
                                  />
                                </Field>
                                <Field>
                                  <FieldLabel
                                    htmlFor={`column-format-${fieldKey}`}
                                  >
                                    {t("widgets.editors.shared.format")}
                                  </FieldLabel>
                                  <Select
                                    items={[
                                      {
                                        value: "text",
                                        label: t(
                                          "widgets.editors.options.formatText",
                                        ),
                                      },
                                      {
                                        value: "number",
                                        label: t(
                                          "widgets.editors.options.formatNumber",
                                        ),
                                      },
                                      {
                                        value: "integer",
                                        label: t(
                                          "widgets.editors.options.formatInteger",
                                        ),
                                      },
                                      {
                                        value: "percent",
                                        label: t(
                                          "widgets.editors.options.formatPercent",
                                        ),
                                      },
                                      {
                                        value: "currency",
                                        label: t(
                                          "widgets.editors.options.formatCurrency",
                                        ),
                                      },
                                      {
                                        value: "date-short",
                                        label: t(
                                          "widgets.editors.options.formatDateShort",
                                        ),
                                      },
                                      {
                                        value: "date-long",
                                        label: t(
                                          "widgets.editors.options.formatDateLong",
                                        ),
                                      },
                                    ]}
                                    value={existing.format ?? "text"}
                                    disabled={readOnly}
                                    onValueChange={(next) =>
                                      updateColumn({
                                        format: next as FieldFormat["format"],
                                      })
                                    }
                                  >
                                    <SelectTrigger
                                      id={`column-format-${fieldKey}`}
                                      aria-label={t(
                                        "widgets.editors.table.formatFor",
                                        { field: fieldKey },
                                      )}
                                    >
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="text">
                                        {t(
                                          "widgets.editors.options.formatText",
                                        )}
                                      </SelectItem>
                                      <SelectItem value="number">
                                        {t(
                                          "widgets.editors.options.formatNumber",
                                        )}
                                      </SelectItem>
                                      <SelectItem value="integer">
                                        {t(
                                          "widgets.editors.options.formatInteger",
                                        )}
                                      </SelectItem>
                                      <SelectItem value="percent">
                                        {t(
                                          "widgets.editors.options.formatPercent",
                                        )}
                                      </SelectItem>
                                      <SelectItem value="currency">
                                        {t(
                                          "widgets.editors.options.formatCurrency",
                                        )}
                                      </SelectItem>
                                      <SelectItem value="date-short">
                                        {t(
                                          "widgets.editors.options.formatDateShort",
                                        )}
                                      </SelectItem>
                                      <SelectItem value="date-long">
                                        {t(
                                          "widgets.editors.options.formatDateLong",
                                        )}
                                      </SelectItem>
                                    </SelectContent>
                                  </Select>
                                </Field>
                                <Field>
                                  <FieldLabel
                                    htmlFor={`column-alignment-${fieldKey}`}
                                  >
                                    {t("widgets.editors.shared.alignment")}
                                  </FieldLabel>
                                  <Select
                                    items={[
                                      {
                                        value: "left",
                                        label: t(
                                          "widgets.editors.options.alignLeft",
                                        ),
                                      },
                                      {
                                        value: "center",
                                        label: t(
                                          "widgets.editors.options.alignCenter",
                                        ),
                                      },
                                      {
                                        value: "right",
                                        label: t(
                                          "widgets.editors.options.alignRight",
                                        ),
                                      },
                                    ]}
                                    value={existing.alignment ?? "left"}
                                    disabled={readOnly}
                                    onValueChange={(next) =>
                                      updateColumn({
                                        alignment:
                                          next as FieldFormat["alignment"],
                                      })
                                    }
                                  >
                                    <SelectTrigger
                                      id={`column-alignment-${fieldKey}`}
                                      aria-label={t(
                                        "widgets.editors.table.alignmentFor",
                                        { field: fieldKey },
                                      )}
                                    >
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="left">
                                        {t("widgets.editors.options.alignLeft")}
                                      </SelectItem>
                                      <SelectItem value="center">
                                        {t(
                                          "widgets.editors.options.alignCenter",
                                        )}
                                      </SelectItem>
                                      <SelectItem value="right">
                                        {t(
                                          "widgets.editors.options.alignRight",
                                        )}
                                      </SelectItem>
                                    </SelectContent>
                                  </Select>
                                </Field>
                                <Field>
                                  <FieldLabel
                                    htmlFor={`column-width-${fieldKey}`}
                                  >
                                    {t("widgets.editors.table.columnWidth")}
                                  </FieldLabel>
                                  <Input
                                    id={`column-width-${fieldKey}`}
                                    type="number"
                                    min={0}
                                    max={100}
                                    value={existing.width ?? 0}
                                    disabled={readOnly}
                                    onChange={(event) =>
                                      updateColumn({
                                        width: Number(event.target.value),
                                      })
                                    }
                                  />
                                </Field>
                              </div>
                            );
                          },
                        )}
                      </fieldset>
                    </>
                  )}
                  {provider === "agenda" && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {(
                        [
                          ["dateField", "widgets.editors.shared.dateField"],
                          ["timeField", "widgets.editors.agenda.timeField"],
                          ["titleField", "widgets.editors.shared.titleField"],
                          [
                            "locationField",
                            "widgets.editors.agenda.locationField",
                          ],
                          [
                            "descriptionField",
                            "widgets.editors.agenda.descriptionField",
                          ],
                        ] as const
                      ).map(([key, labelKey]) => (
                        <FieldSelect
                          key={key}
                          label={t(labelKey)}
                          value={
                            (configuration as DisplayWidgetConfig)[key] ?? ""
                          }
                          fields={availableFields}
                          allowEmpty={key !== "titleField"}
                          disabled={readOnly}
                          onChange={(value) =>
                            setConfiguration((current) => ({
                              ...current,
                              [key]: value,
                            }))
                          }
                        />
                      ))}
                    </div>
                  )}
                  <Field>
                    <FieldLabel htmlFor="display-maximum-items">
                      {t("widgets.editors.shared.maximumItems")}
                    </FieldLabel>
                    <Input
                      id="display-maximum-items"
                      type="number"
                      min={1}
                      max={100}
                      value={
                        (configuration as DisplayWidgetConfig).maximumItems
                      }
                      disabled={readOnly}
                      onChange={(event) =>
                        setConfiguration((current) => ({
                          ...current,
                          maximumItems: Number(event.target.value),
                        }))
                      }
                    />
                    <FieldDescription>
                      {t("widgets.editors.display.maximumHint")}
                    </FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="display-empty-state">
                      {t("widgets.editors.display.emptyLabel")}
                    </FieldLabel>
                    <Input
                      id="display-empty-state"
                      value={
                        (configuration as DisplayWidgetConfig).emptyState ?? ""
                      }
                      disabled={readOnly}
                      onChange={(event) =>
                        setConfiguration((current) => ({
                          ...current,
                          emptyState: event.target.value,
                        }))
                      }
                    />
                    <FieldDescription>
                      {t("widgets.editors.display.emptyHint")}
                    </FieldDescription>
                  </Field>
                </>
              )}
              {provider === "metric" && (
                <>
                  <DataSourceSelect
                    value={(configuration as MetricWidgetConfig).dataSourceId}
                    sources={compatibleDataSources}
                    createProviders={acceptedCreateProviders}
                    csrf={csrf}
                    disabled={readOnly}
                    onChange={(dataSourceId) =>
                      setConfiguration((current) => ({
                        ...current,
                        dataSourceId,
                      }))
                    }
                  />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FieldSelect
                      label={t("widgets.editors.shared.valueField")}
                      value={(configuration as MetricWidgetConfig).valueField}
                      fields={availableFields.filter((field) =>
                        ["number", "integer", "percent", "currency"].includes(
                          field.type,
                        ),
                      )}
                      disabled={readOnly}
                      onChange={(valueField) =>
                        setConfiguration((current) => ({
                          ...current,
                          valueField,
                        }))
                      }
                    />
                    <Field>
                      <FieldLabel htmlFor="static-label">
                        {t("widgets.editors.metric.staticLabel")}
                      </FieldLabel>
                      <Input
                        id="static-label"
                        value={
                          (configuration as MetricWidgetConfig).label ?? ""
                        }
                        disabled={readOnly}
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...current,
                            label: event.target.value,
                          }))
                        }
                      />
                    </Field>
                    <FieldSelect
                      label={t("widgets.editors.shared.labelField")}
                      value={
                        (configuration as MetricWidgetConfig).labelField ?? ""
                      }
                      fields={availableFields}
                      allowEmpty
                      disabled={readOnly}
                      onChange={(labelField) =>
                        setConfiguration((current) => ({
                          ...current,
                          labelField,
                        }))
                      }
                    />
                    <FieldSelect
                      label={t("widgets.editors.shared.secondaryField")}
                      value={
                        (configuration as MetricWidgetConfig).secondaryField ??
                        ""
                      }
                      fields={availableFields}
                      allowEmpty
                      disabled={readOnly}
                      onChange={(secondaryField) =>
                        setConfiguration((current) => ({
                          ...current,
                          secondaryField,
                        }))
                      }
                    />
                    <Field>
                      <FieldLabel htmlFor="metric-format">
                        {t("widgets.editors.shared.format")}
                      </FieldLabel>
                      <Select
                        items={[
                          {
                            value: "number",
                            label: t("widgets.editors.options.formatNumber"),
                          },
                          {
                            value: "integer",
                            label: t("widgets.editors.options.formatInteger"),
                          },
                          {
                            value: "percent",
                            label: t("widgets.editors.options.formatPercent"),
                          },
                          {
                            value: "currency",
                            label: t("widgets.editors.options.formatCurrency"),
                          },
                        ]}
                        value={(configuration as MetricWidgetConfig).format}
                        disabled={readOnly}
                        onValueChange={(next) =>
                          setConfiguration((current) => ({
                            ...(current as MetricWidgetConfig),
                            format: next as MetricWidgetConfig["format"],
                          }))
                        }
                      >
                        <SelectTrigger
                          id="metric-format"
                          aria-label={t("widgets.editors.shared.format")}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="number">
                            {t("widgets.editors.options.formatNumber")}
                          </SelectItem>
                          <SelectItem value="integer">
                            {t("widgets.editors.options.formatInteger")}
                          </SelectItem>
                          <SelectItem value="percent">
                            {t("widgets.editors.options.formatPercent")}
                          </SelectItem>
                          <SelectItem value="currency">
                            {t("widgets.editors.options.formatCurrency")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="metric-precision">
                        {t("widgets.editors.metric.precision")}
                      </FieldLabel>
                      <Input
                        id="metric-precision"
                        type="number"
                        min={0}
                        max={6}
                        value={(configuration as MetricWidgetConfig).precision}
                        disabled={readOnly}
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...current,
                            precision: Number(event.target.value),
                          }))
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="prefix">
                        {t("widgets.editors.metric.prefix")}
                      </FieldLabel>
                      <Input
                        id="prefix"
                        value={
                          (configuration as MetricWidgetConfig).prefix ?? ""
                        }
                        disabled={readOnly}
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...current,
                            prefix: event.target.value,
                          }))
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="suffix">
                        {t("widgets.editors.metric.suffix")}
                      </FieldLabel>
                      <Input
                        id="suffix"
                        value={
                          (configuration as MetricWidgetConfig).suffix ?? ""
                        }
                        disabled={readOnly}
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...current,
                            suffix: event.target.value,
                          }))
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="metric-alignment">
                        {t("widgets.editors.shared.alignment")}
                      </FieldLabel>
                      <Select
                        items={[
                          {
                            value: "left",
                            label: t("widgets.editors.options.alignLeft"),
                          },
                          {
                            value: "center",
                            label: t("widgets.editors.options.alignCenter"),
                          },
                          {
                            value: "right",
                            label: t("widgets.editors.options.alignRight"),
                          },
                        ]}
                        value={(configuration as MetricWidgetConfig).alignment}
                        disabled={readOnly}
                        onValueChange={(next) =>
                          setConfiguration((current) => ({
                            ...current,
                            alignment: next as MetricWidgetConfig["alignment"],
                          }))
                        }
                      >
                        <SelectTrigger
                          id="metric-alignment"
                          aria-label={t("widgets.editors.shared.alignment")}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="left">
                            {t("widgets.editors.options.alignLeft")}
                          </SelectItem>
                          <SelectItem value="center">
                            {t("widgets.editors.options.alignCenter")}
                          </SelectItem>
                          <SelectItem value="right">
                            {t("widgets.editors.options.alignRight")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                  <Field>
                    <FieldLabel htmlFor="metric-empty-state">
                      {t("widgets.editors.metric.emptyState")}
                    </FieldLabel>
                    <Input
                      id="metric-empty-state"
                      value={
                        (configuration as TickerWidgetConfig).emptyState ?? ""
                      }
                      disabled={readOnly}
                      onChange={(event) =>
                        setConfiguration((current) => ({
                          ...current,
                          emptyState: event.target.value,
                        }))
                      }
                    />
                  </Field>
                </>
              )}
              {provider === "cards" && (
                <>
                  <DataSourceSelect
                    value={(configuration as CardsWidgetConfig).dataSourceId}
                    sources={compatibleDataSources}
                    createProviders={acceptedCreateProviders}
                    csrf={csrf}
                    disabled={readOnly}
                    onChange={(dataSourceId) =>
                      setConfiguration((current) => ({
                        ...current,
                        dataSourceId,
                      }))
                    }
                  />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FieldSelect
                      label={t("widgets.editors.shared.titleField")}
                      value={(configuration as CardsWidgetConfig).titleField}
                      fields={availableFields}
                      disabled={readOnly}
                      onChange={(titleField) =>
                        setConfiguration((current) => ({
                          ...current,
                          titleField,
                        }))
                      }
                    />
                    {(
                      [
                        [
                          "subtitleField",
                          "widgets.editors.cards.subtitleLabel",
                        ],
                        ["bodyField", "widgets.editors.cards.bodyLabel"],
                        ["badgeField", "widgets.editors.cards.badgeLabel"],
                      ] as const
                    ).map(([key, labelKey]) => (
                      <FieldSelect
                        key={key}
                        label={t(labelKey)}
                        value={(configuration as CardsWidgetConfig)[key] ?? ""}
                        fields={availableFields}
                        allowEmpty
                        disabled={readOnly}
                        onChange={(value) =>
                          setConfiguration((current) => ({
                            ...current,
                            [key]: value,
                          }))
                        }
                      />
                    ))}
                    <Field>
                      <FieldLabel htmlFor="columns">
                        {t("widgets.editors.shared.columns")}
                      </FieldLabel>
                      <Input
                        id="columns"
                        type="number"
                        min={1}
                        max={4}
                        value={(configuration as CardsWidgetConfig).columns}
                        disabled={readOnly}
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...(current as CardsWidgetConfig),
                            columns: Number(event.target.value),
                          }))
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="maximum-items">
                        {t("widgets.editors.shared.maximumItems")}
                      </FieldLabel>
                      <Input
                        id="maximum-items"
                        type="number"
                        min={1}
                        max={12}
                        value={
                          (configuration as CardsWidgetConfig).maximumItems
                        }
                        disabled={readOnly}
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...current,
                            maximumItems: Number(event.target.value),
                          }))
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="cards-density">
                        {t("widgets.editors.cards.density")}
                      </FieldLabel>
                      <Select
                        items={[
                          {
                            value: "comfortable",
                            label: t(
                              "widgets.editors.cards.densityComfortable",
                            ),
                          },
                          {
                            value: "compact",
                            label: t("widgets.editors.cards.densityCompact"),
                          },
                        ]}
                        value={(configuration as CardsWidgetConfig).density}
                        disabled={readOnly}
                        onValueChange={(next) =>
                          setConfiguration((current) => ({
                            ...current,
                            density: next as CardsWidgetConfig["density"],
                          }))
                        }
                      >
                        <SelectTrigger
                          id="cards-density"
                          aria-label={t("widgets.editors.cards.density")}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="comfortable">
                            {t("widgets.editors.cards.densityComfortable")}
                          </SelectItem>
                          <SelectItem value="compact">
                            {t("widgets.editors.cards.densityCompact")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                </>
              )}
              {provider === "weather" && (
                <>
                  <DataSourceSelect
                    value={(configuration as WeatherWidgetConfig).dataSourceId}
                    sources={compatibleDataSources}
                    createProviders={acceptedCreateProviders}
                    csrf={csrf}
                    disabled={readOnly}
                    onChange={(dataSourceId) =>
                      setConfiguration((current) => ({
                        ...current,
                        dataSourceId,
                      }))
                    }
                  />
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {(
                      [
                        [
                          "showLocation",
                          "widgets.editors.weather.showLocation",
                        ],
                        ["showCurrent", "widgets.editors.weather.showCurrent"],
                        [
                          "showHumidity",
                          "widgets.editors.weather.showHumidity",
                        ],
                        ["showWind", "widgets.editors.weather.showWind"],
                        [
                          "showPrecipitation",
                          "widgets.editors.weather.showPrecipitation",
                        ],
                      ] as const
                    ).map(([key, labelKey]) => (
                      <label
                        key={key}
                        className="flex items-center gap-2 text-sm"
                      >
                        <Checkbox
                          checked={Boolean(
                            (
                              configuration as unknown as Record<
                                string,
                                unknown
                              >
                            )[key],
                          )}
                          disabled={readOnly}
                          onCheckedChange={(checked) =>
                            setConfiguration((current) => ({
                              ...current,
                              [key]: checked === true,
                            }))
                          }
                          aria-label={t(labelKey)}
                        />
                        <span>{t(labelKey)}</span>
                      </label>
                    ))}
                  </div>
                  <Field>
                    <FieldLabel htmlFor="weather-forecast-days">
                      {t("widgets.editors.weather.forecastDays")}
                    </FieldLabel>
                    <Input
                      id="weather-forecast-days"
                      type="number"
                      min={0}
                      max={7}
                      value={
                        (configuration as WeatherWidgetConfig).forecastDays
                      }
                      disabled={readOnly}
                      onChange={(event) =>
                        setConfiguration((current) => ({
                          ...current,
                          forecastDays: Number(event.target.value),
                        }))
                      }
                    />
                  </Field>
                </>
              )}
              {provider === "spotlight" && (
                <>
                  <DataSourceSelect
                    value={
                      (configuration as SpotlightWidgetConfig).dataSourceId
                    }
                    sources={compatibleDataSources}
                    createProviders={acceptedCreateProviders}
                    csrf={csrf}
                    disabled={readOnly}
                    onChange={(dataSourceId) =>
                      setConfiguration((current) => ({
                        ...current,
                        dataSourceId,
                      }))
                    }
                  />
                  <div className="grid gap-3 sm:grid-cols-2">
                    {(
                      [
                        [
                          "titleField",
                          "widgets.editors.shared.titleField",
                          false,
                        ],
                        [
                          "subtitleField",
                          "widgets.editors.shared.subtitleField",
                          true,
                        ],
                        ["bodyField", "widgets.editors.shared.bodyField", true],
                        [
                          "badgeField",
                          "widgets.editors.shared.badgeField",
                          true,
                        ],
                        ["dateField", "widgets.editors.shared.dateField", true],
                      ] as const
                    ).map(([key, labelKey, allowEmpty]) => (
                      <FieldSelect
                        key={key}
                        label={t(labelKey)}
                        value={
                          (configuration as SpotlightWidgetConfig)[key] ?? ""
                        }
                        fields={availableFields}
                        allowEmpty={allowEmpty}
                        disabled={readOnly}
                        onChange={(value) =>
                          setConfiguration((current) => ({
                            ...current,
                            [key]: value,
                          }))
                        }
                      />
                    ))}
                    <Field>
                      <FieldLabel htmlFor="spotlight-image">
                        {t("widgets.editors.spotlight.image")}
                      </FieldLabel>
                      <Select
                        items={[
                          {
                            value: "",
                            label: t("widgets.editors.spotlight.noImage"),
                          },
                          ...(imageAssets.data?.items ?? []).map((item) => ({
                            value: item.id,
                            label: item.name,
                          })),
                        ]}
                        value={
                          (configuration as SpotlightWidgetConfig)
                            .imageAssetId ?? ""
                        }
                        disabled={readOnly}
                        onValueChange={(next) =>
                          setConfiguration((current) => ({
                            ...current,
                            imageAssetId: next || undefined,
                          }))
                        }
                      >
                        <SelectTrigger
                          id="spotlight-image"
                          aria-label={t("widgets.editors.spotlight.image")}
                        >
                          <SelectValue>
                            {(imageAssets.data?.items ?? []).find(
                              (item) =>
                                item.id ===
                                (configuration as SpotlightWidgetConfig)
                                  .imageAssetId,
                            )?.name ?? t("widgets.editors.spotlight.noImage")}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="">
                            {t("widgets.editors.spotlight.noImage")}
                          </SelectItem>
                          {(imageAssets.data?.items ?? []).map((item) => (
                            <SelectItem key={item.id} value={item.id}>
                              {item.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                </>
              )}
              {provider === "stat_grid" && (
                <>
                  <DataSourceSelect
                    value={(configuration as StatGridWidgetConfig).dataSourceId}
                    sources={compatibleDataSources}
                    createProviders={acceptedCreateProviders}
                    csrf={csrf}
                    disabled={readOnly}
                    onChange={(dataSourceId) =>
                      setConfiguration((current) => ({
                        ...current,
                        dataSourceId,
                      }))
                    }
                  />
                  <Field>
                    <FieldLabel htmlFor="stat-grid-columns">
                      {t("widgets.editors.shared.columns")}
                    </FieldLabel>
                    <Input
                      id="stat-grid-columns"
                      type="number"
                      min={1}
                      max={4}
                      value={(configuration as StatGridWidgetConfig).columns}
                      disabled={readOnly}
                      onChange={(event) =>
                        setConfiguration((current) => ({
                          ...(current as StatGridWidgetConfig),
                          columns: Number(event.target.value),
                        }))
                      }
                    />
                  </Field>
                  <fieldset>
                    <legend>{t("widgets.editors.statGrid.metrics")}</legend>
                    {(configuration as StatGridWidgetConfig).metrics.map(
                      (metric, index) => (
                        <div
                          className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
                          key={index}
                        >
                          <Field>
                            <FieldLabel htmlFor={`stat-grid-label-${index}`}>
                              {t("widgets.editors.shared.label")}
                            </FieldLabel>
                            <Input
                              id={`stat-grid-label-${index}`}
                              value={metric.label ?? ""}
                              disabled={readOnly}
                              onChange={(event) =>
                                setConfiguration((current) => {
                                  const config =
                                    current as StatGridWidgetConfig;
                                  return {
                                    ...config,
                                    metrics: config.metrics.map(
                                      (item, itemIndex) =>
                                        itemIndex === index
                                          ? {
                                              ...item,
                                              label: event.target.value,
                                            }
                                          : item,
                                    ),
                                  };
                                })
                              }
                            />
                          </Field>
                          <FieldSelect
                            label={t("widgets.editors.shared.valueField")}
                            value={metric.valueField}
                            fields={availableFields.filter((field) =>
                              [
                                "number",
                                "integer",
                                "percent",
                                "currency",
                              ].includes(field.type),
                            )}
                            disabled={readOnly}
                            onChange={(valueField) =>
                              setConfiguration((current) => {
                                const config = current as StatGridWidgetConfig;
                                return {
                                  ...config,
                                  metrics: config.metrics.map(
                                    (item, itemIndex) =>
                                      itemIndex === index
                                        ? { ...item, valueField }
                                        : item,
                                  ),
                                };
                              })
                            }
                          />
                          <Field>
                            <FieldLabel htmlFor={`stat-grid-format-${index}`}>
                              {t("widgets.editors.shared.format")}
                            </FieldLabel>
                            <Select
                              items={[
                                {
                                  value: "number",
                                  label: t(
                                    "widgets.editors.options.formatNumber",
                                  ),
                                },
                                {
                                  value: "integer",
                                  label: t(
                                    "widgets.editors.options.formatInteger",
                                  ),
                                },
                                {
                                  value: "percent",
                                  label: t(
                                    "widgets.editors.options.formatPercent",
                                  ),
                                },
                                {
                                  value: "currency",
                                  label: t(
                                    "widgets.editors.options.formatCurrency",
                                  ),
                                },
                              ]}
                              value={metric.format ?? "number"}
                              disabled={readOnly}
                              onValueChange={(next) =>
                                setConfiguration((current) => {
                                  const config =
                                    current as StatGridWidgetConfig;
                                  return {
                                    ...config,
                                    metrics: config.metrics.map(
                                      (item, itemIndex) =>
                                        itemIndex === index
                                          ? {
                                              ...item,
                                              format:
                                                next as typeof metric.format,
                                            }
                                          : item,
                                    ),
                                  };
                                })
                              }
                            >
                              <SelectTrigger
                                id={`stat-grid-format-${index}`}
                                aria-label={t(
                                  "widgets.editors.statGrid.formatFor",
                                  { index: index + 1 },
                                )}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="number">
                                  {t("widgets.editors.options.formatNumber")}
                                </SelectItem>
                                <SelectItem value="integer">
                                  {t("widgets.editors.options.formatInteger")}
                                </SelectItem>
                                <SelectItem value="percent">
                                  {t("widgets.editors.options.formatPercent")}
                                </SelectItem>
                                <SelectItem value="currency">
                                  {t("widgets.editors.options.formatCurrency")}
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          </Field>
                          <Button
                            type="button"
                            variant="secondary"
                            disabled={
                              readOnly ||
                              (configuration as StatGridWidgetConfig).metrics
                                .length === 1
                            }
                            onClick={() =>
                              setConfiguration((current) => ({
                                ...current,
                                metrics: (
                                  current as StatGridWidgetConfig
                                ).metrics.filter(
                                  (_, itemIndex) => itemIndex !== index,
                                ),
                              }))
                            }
                          >
                            {t("widgets.editors.shared.remove")}
                          </Button>
                        </div>
                      ),
                    )}
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={
                        readOnly ||
                        (configuration as StatGridWidgetConfig).metrics
                          .length >= 12
                      }
                      onClick={() =>
                        setConfiguration((current) => ({
                          ...current,
                          metrics: [
                            ...(current as StatGridWidgetConfig).metrics,
                            {
                              label: t("widgets.defaults.metricLabel"),
                              valueField: "",
                              format: "number",
                            },
                          ],
                        }))
                      }
                    >
                      {t("widgets.editors.statGrid.addMetric")}
                    </Button>
                  </fieldset>
                </>
              )}
              {provider === "chart" && (
                <>
                  <DataSourceSelect
                    value={(configuration as ChartWidgetConfig).dataSourceId}
                    sources={compatibleDataSources}
                    createProviders={acceptedCreateProviders}
                    csrf={csrf}
                    disabled={readOnly}
                    onChange={(dataSourceId) =>
                      setConfiguration((current) => ({
                        ...current,
                        dataSourceId,
                      }))
                    }
                  />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor="chart-type">
                        {t("widgets.editors.chart.chartType")}
                      </FieldLabel>
                      <Select
                        items={[
                          {
                            value: "line",
                            label: t("widgets.editors.chart.chartLine"),
                          },
                          {
                            value: "bar",
                            label: t("widgets.editors.chart.chartBar"),
                          },
                          {
                            value: "donut",
                            label: t("widgets.editors.chart.chartDonut"),
                          },
                        ]}
                        value={(configuration as ChartWidgetConfig).chartType}
                        disabled={readOnly}
                        onValueChange={(next) =>
                          setConfiguration((current) => ({
                            ...current,
                            chartType: next as ChartWidgetConfig["chartType"],
                          }))
                        }
                      >
                        <SelectTrigger
                          id="chart-type"
                          aria-label={t("widgets.editors.chart.chartType")}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="line">
                            {t("widgets.editors.chart.chartLine")}
                          </SelectItem>
                          <SelectItem value="bar">
                            {t("widgets.editors.chart.chartBar")}
                          </SelectItem>
                          <SelectItem value="donut">
                            {t("widgets.editors.chart.chartDonut")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="chart-dataset">
                        {t("widgets.editors.chart.dataset")}
                      </FieldLabel>
                      <Input
                        id="chart-dataset"
                        value={
                          (configuration as ChartWidgetConfig).dataset ?? ""
                        }
                        disabled={readOnly}
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...current,
                            dataset: event.target.value,
                          }))
                        }
                      />
                    </Field>
                  </div>
                  <fieldset>
                    <legend>{t("widgets.editors.chart.series")}</legend>
                    {(configuration as ChartWidgetConfig).series.map(
                      (series, index) => (
                        <div
                          className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
                          key={index}
                        >
                          <FieldSelect
                            label={t("widgets.editors.chart.numericField")}
                            value={series.field}
                            fields={availableFields.filter((field) =>
                              [
                                "number",
                                "integer",
                                "percent",
                                "currency",
                              ].includes(field.type),
                            )}
                            disabled={readOnly}
                            onChange={(field) =>
                              setConfiguration((current) => {
                                const config = current as ChartWidgetConfig;
                                return {
                                  ...config,
                                  series: config.series.map(
                                    (item, itemIndex) =>
                                      itemIndex === index
                                        ? { ...item, field }
                                        : item,
                                  ),
                                };
                              })
                            }
                          />
                          <Field>
                            <FieldLabel htmlFor={`chart-label-${index}`}>
                              {t("widgets.editors.shared.label")}
                            </FieldLabel>
                            <Input
                              id={`chart-label-${index}`}
                              value={series.label ?? ""}
                              disabled={readOnly}
                              onChange={(event) =>
                                setConfiguration((current) => {
                                  const config = current as ChartWidgetConfig;
                                  return {
                                    ...config,
                                    series: config.series.map(
                                      (item, itemIndex) =>
                                        itemIndex === index
                                          ? {
                                              ...item,
                                              label: event.target.value,
                                            }
                                          : item,
                                    ),
                                  };
                                })
                              }
                            />
                          </Field>
                          <Field>
                            <FieldLabel htmlFor={`chart-color-${index}`}>
                              {t("widgets.editors.chart.seriesColor")}
                            </FieldLabel>
                            <Input
                              id={`chart-color-${index}`}
                              type="color"
                              value={series.color ?? "#4DB6FF"}
                              disabled={readOnly}
                              onChange={(event) =>
                                setConfiguration((current) => {
                                  const config = current as ChartWidgetConfig;
                                  return {
                                    ...config,
                                    series: config.series.map(
                                      (item, itemIndex) =>
                                        itemIndex === index
                                          ? {
                                              ...item,
                                              color: event.target.value,
                                            }
                                          : item,
                                    ),
                                  };
                                })
                              }
                            />
                          </Field>
                          <Button
                            type="button"
                            variant="secondary"
                            disabled={
                              readOnly ||
                              (configuration as ChartWidgetConfig).series
                                .length === 1
                            }
                            onClick={() =>
                              setConfiguration((current) => ({
                                ...current,
                                series: (
                                  current as ChartWidgetConfig
                                ).series.filter(
                                  (_, itemIndex) => itemIndex !== index,
                                ),
                              }))
                            }
                          >
                            {t("widgets.editors.shared.remove")}
                          </Button>
                        </div>
                      ),
                    )}
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={
                        readOnly ||
                        (configuration as ChartWidgetConfig).series.length >= 4
                      }
                      onClick={() =>
                        setConfiguration((current) => ({
                          ...current,
                          series: [
                            ...(current as ChartWidgetConfig).series,
                            {
                              field: "",
                              label: t("widgets.defaults.seriesAdded"),
                              color: "#FFB547",
                            },
                          ],
                        }))
                      }
                    >
                      {t("widgets.editors.chart.addSeries")}
                    </Button>
                  </fieldset>
                </>
              )}
              {provider === "progress" && (
                <>
                  <DataSourceSelect
                    value={(configuration as ProgressWidgetConfig).dataSourceId}
                    sources={compatibleDataSources}
                    createProviders={acceptedCreateProviders}
                    csrf={csrf}
                    disabled={readOnly}
                    onChange={(dataSourceId) =>
                      setConfiguration((current) => ({
                        ...current,
                        dataSourceId,
                      }))
                    }
                  />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FieldSelect
                      label={t("widgets.editors.shared.valueField")}
                      value={(configuration as ProgressWidgetConfig).valueField}
                      fields={availableFields.filter((field) =>
                        ["number", "integer", "percent", "currency"].includes(
                          field.type,
                        ),
                      )}
                      disabled={readOnly}
                      onChange={(valueField) =>
                        setConfiguration((current) => ({
                          ...current,
                          valueField,
                        }))
                      }
                    />
                    <FieldSelect
                      label={t("widgets.editors.progress.targetField")}
                      value={
                        (configuration as ProgressWidgetConfig).targetField ??
                        ""
                      }
                      fields={availableFields.filter((field) =>
                        ["number", "integer", "percent", "currency"].includes(
                          field.type,
                        ),
                      )}
                      allowEmpty
                      disabled={readOnly}
                      onChange={(targetField) =>
                        setConfiguration((current) => ({
                          ...current,
                          targetField,
                        }))
                      }
                    />
                    <Field>
                      <FieldLabel htmlFor="static-target">
                        {t("widgets.editors.progress.staticTarget")}
                      </FieldLabel>
                      <Input
                        id="static-target"
                        type="number"
                        value={
                          (configuration as ProgressWidgetConfig)
                            .staticTarget ?? 100
                        }
                        disabled={
                          readOnly ||
                          Boolean(
                            (configuration as ProgressWidgetConfig).targetField,
                          )
                        }
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...current,
                            staticTarget: Number(event.target.value),
                          }))
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="label-3">
                        {t("widgets.editors.shared.label")}
                      </FieldLabel>
                      <Input
                        id="label-3"
                        value={
                          (configuration as ProgressWidgetConfig).label ?? ""
                        }
                        disabled={readOnly}
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...current,
                            label: event.target.value,
                          }))
                        }
                      />
                    </Field>
                  </div>
                </>
              )}
              {provider === "timeline" && (
                <>
                  <DataSourceSelect
                    value={(configuration as TimelineWidgetConfig).dataSourceId}
                    sources={compatibleDataSources}
                    createProviders={acceptedCreateProviders}
                    csrf={csrf}
                    disabled={readOnly}
                    onChange={(dataSourceId) =>
                      setConfiguration((current) => ({
                        ...current,
                        dataSourceId,
                      }))
                    }
                  />
                  <div className="grid gap-3 sm:grid-cols-2">
                    {(
                      [
                        [
                          "dateField",
                          "widgets.editors.shared.dateField",
                          false,
                        ],
                        [
                          "titleField",
                          "widgets.editors.shared.titleField",
                          false,
                        ],
                        ["bodyField", "widgets.editors.shared.bodyField", true],
                        [
                          "statusField",
                          "widgets.editors.timeline.statusField",
                          true,
                        ],
                      ] as const
                    ).map(([key, labelKey, allowEmpty]) => (
                      <FieldSelect
                        key={key}
                        label={t(labelKey)}
                        value={
                          (configuration as TimelineWidgetConfig)[key] ?? ""
                        }
                        fields={availableFields}
                        allowEmpty={allowEmpty}
                        disabled={readOnly}
                        onChange={(value) =>
                          setConfiguration((current) => ({
                            ...current,
                            [key]: value,
                          }))
                        }
                      />
                    ))}
                    <Field>
                      <FieldLabel htmlFor="timeline-orientation">
                        {t("widgets.editors.timeline.orientation")}
                      </FieldLabel>
                      <Select
                        items={[
                          {
                            value: "vertical",
                            label: t(
                              "widgets.editors.timeline.orientationVertical",
                            ),
                          },
                          {
                            value: "horizontal",
                            label: t(
                              "widgets.editors.timeline.orientationHorizontal",
                            ),
                          },
                        ]}
                        value={
                          (configuration as TimelineWidgetConfig).orientation
                        }
                        disabled={readOnly}
                        onValueChange={(next) =>
                          setConfiguration((current) => ({
                            ...current,
                            orientation:
                              next as TimelineWidgetConfig["orientation"],
                          }))
                        }
                      >
                        <SelectTrigger
                          id="timeline-orientation"
                          aria-label={t("widgets.editors.timeline.orientation")}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="vertical">
                            {t("widgets.editors.timeline.orientationVertical")}
                          </SelectItem>
                          <SelectItem value="horizontal">
                            {t(
                              "widgets.editors.timeline.orientationHorizontal",
                            )}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                </>
              )}
              {provider === "world_clock" && (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor="world-clock-format">
                        {t("widgets.editors.shared.timeFormat")}
                      </FieldLabel>
                      <Select
                        items={[
                          {
                            value: "locale",
                            label: t(
                              "widgets.editors.options.organizationFormat",
                            ),
                          },
                          {
                            value: "12",
                            label: t("widgets.editors.options.hour12"),
                          },
                          {
                            value: "24",
                            label: t("widgets.editors.options.hour24"),
                          },
                        ]}
                        value={(configuration as WorldClockWidgetConfig).format}
                        disabled={readOnly}
                        onValueChange={(next) =>
                          setConfiguration((current) => ({
                            ...(current as WorldClockWidgetConfig),
                            format: next as WorldClockWidgetConfig["format"],
                          }))
                        }
                      >
                        <SelectTrigger
                          id="world-clock-format"
                          aria-label={t("widgets.editors.shared.timeFormat")}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="locale">
                            {t("widgets.editors.options.organizationFormat")}
                          </SelectItem>
                          <SelectItem value="12">
                            {t("widgets.editors.options.hour12")}
                          </SelectItem>
                          <SelectItem value="24">
                            {t("widgets.editors.options.hour24")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="world-clock-columns">
                        {t("widgets.editors.shared.columns")}
                      </FieldLabel>
                      <Input
                        id="world-clock-columns"
                        type="number"
                        min={1}
                        max={4}
                        value={
                          (configuration as WorldClockWidgetConfig).columns
                        }
                        disabled={readOnly}
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...(current as WorldClockWidgetConfig),
                            columns: Number(event.target.value),
                          }))
                        }
                      />
                    </Field>
                  </div>
                  <fieldset className="grid gap-2">
                    <legend className="text-sm font-medium">
                      {t("widgets.editors.worldClock.locations")}
                    </legend>
                    {(configuration as WorldClockWidgetConfig).zones.map(
                      (zone, index) => (
                        <div className="grid gap-3 sm:grid-cols-2" key={index}>
                          <Field>
                            <FieldLabel htmlFor={`world-clock-label-${index}`}>
                              {t("widgets.editors.shared.label")}
                            </FieldLabel>
                            <Input
                              id={`world-clock-label-${index}`}
                              value={zone.label}
                              disabled={readOnly}
                              onChange={(event) =>
                                setConfiguration((current) => {
                                  const config =
                                    current as WorldClockWidgetConfig;
                                  return {
                                    ...config,
                                    zones: config.zones.map(
                                      (item, itemIndex) =>
                                        itemIndex === index
                                          ? {
                                              ...item,
                                              label: event.target.value,
                                            }
                                          : item,
                                    ),
                                  };
                                })
                              }
                            />
                          </Field>
                          <Field>
                            <FieldLabel
                              htmlFor={`world-clock-timezone-${index}`}
                            >
                              {t("widgets.editors.worldClock.ianaLabel")}
                            </FieldLabel>
                            <Input
                              id={`world-clock-timezone-${index}`}
                              value={zone.timezone}
                              disabled={readOnly}
                              onChange={(event) =>
                                setConfiguration((current) => {
                                  const config =
                                    current as WorldClockWidgetConfig;
                                  return {
                                    ...config,
                                    zones: config.zones.map(
                                      (item, itemIndex) =>
                                        itemIndex === index
                                          ? {
                                              ...item,
                                              timezone: event.target.value,
                                            }
                                          : item,
                                    ),
                                  };
                                })
                              }
                            />
                          </Field>
                        </div>
                      ),
                    )}
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={
                        readOnly ||
                        (configuration as WorldClockWidgetConfig).zones
                          .length >= 8
                      }
                      onClick={() =>
                        setConfiguration((current) => ({
                          ...current,
                          zones: [
                            ...(current as WorldClockWidgetConfig).zones,
                            {
                              label: t("widgets.defaults.zoneAdded"),
                              timezone: "UTC",
                            },
                          ],
                        }))
                      }
                    >
                      {t("widgets.editors.worldClock.addLocation")}
                    </Button>
                  </fieldset>
                </>
              )}
            </div>
          </section>
          <section className="widget-editor__section">
            <header>
              <h3>{t("widgets.editors.appearance.title")}</h3>
              <p>{t("widgets.editors.appearance.hint")}</p>
            </header>
            <div className="widget-editor__section-body">
              <div className="widget-editor__subsection">
                <header>
                  <strong>{t("widgets.editors.appearance.sizeTitle")}</strong>
                  <p>{t("widgets.editors.appearance.sizeHint")}</p>
                </header>
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={configuration.textScale !== undefined}
                    disabled={readOnly}
                    onCheckedChange={(checked) =>
                      setConfiguration((current) => {
                        if (checked === true)
                          return { ...current, textScale: 100 };
                        const automatic = { ...current };
                        delete automatic.textScale;
                        return automatic;
                      })
                    }
                    aria-label={t("widgets.editors.appearance.customScale")}
                  />
                  <span>{t("widgets.editors.appearance.customScale")}</span>
                </label>
                {configuration.textScale !== undefined && (
                  <Field>
                    <FieldTitle>
                      {t("widgets.editors.appearance.scaleTitle", {
                        value: configuration.textScale,
                      })}
                    </FieldTitle>
                    <Slider
                      aria-label={t("widgets.editors.appearance.scaleAria", {
                        value: configuration.textScale,
                      })}
                      min={25}
                      max={500}
                      step={25}
                      value={[configuration.textScale]}
                      disabled={readOnly}
                      onValueChange={(next: number | readonly number[]) => {
                        const values =
                          typeof next === "number" ? [next] : [...next];
                        const [first] = values;
                        setConfiguration((current) => ({
                          ...current,
                          textScale: first ?? configuration.textScale,
                        }));
                      }}
                    />
                  </Field>
                )}
                <Field>
                  <FieldTitle>
                    {t("widgets.editors.appearance.paddingTitle", {
                      value: configuration.contentPadding ?? 10,
                    })}
                  </FieldTitle>
                  <Slider
                    aria-label={t("widgets.editors.appearance.paddingAria", {
                      value: configuration.contentPadding ?? 10,
                    })}
                    min={0}
                    max={40}
                    step={1}
                    value={[configuration.contentPadding ?? 10]}
                    disabled={readOnly}
                    onValueChange={(next: number | readonly number[]) => {
                      const values =
                        typeof next === "number" ? [next] : [...next];
                      const [first] = values;
                      setConfiguration((current) => ({
                        ...current,
                        contentPadding: first ?? 10,
                      }));
                    }}
                  />
                </Field>
                <small>{t("widgets.editors.appearance.paddingHint")}</small>
              </div>
              <div className="widget-editor__subsection">
                <header>
                  <strong>{t("widgets.editors.appearance.colorsTitle")}</strong>
                  <p>{t("widgets.editors.appearance.colorsHint")}</p>
                </header>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="text-and-accent-color">
                      {t("widgets.editors.appearance.foreground")}
                    </FieldLabel>
                    <Input
                      id="text-and-accent-color"
                      type="color"
                      value={configuration.foregroundColor}
                      disabled={readOnly}
                      onChange={(e) =>
                        updateColors("foregroundColor", e.target.value)
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="background-color">
                      {t("widgets.editors.appearance.background")}
                    </FieldLabel>
                    <Input
                      id="background-color"
                      type="color"
                      value={configuration.backgroundColor}
                      disabled={readOnly}
                      onChange={(e) =>
                        updateColors("backgroundColor", e.target.value)
                      }
                    />
                  </Field>
                </div>
              </div>
            </div>
          </section>
          <aside
            className="widget-editor__preview"
            aria-label={t("widgets.editors.shared.livePreview")}
          >
            <header>
              <strong>{t("widgets.editors.shared.livePreview")}</strong>
              <span>{t("widgets.editors.shared.livePreviewHint")}</span>
            </header>
            <PreviewTimeControl value={previewTime} onChange={setPreviewTime} />
            <div
              ref={previewRef}
              className="native-app-preview declarative-widget-preview"
            >
              {compiledPreview.data ? (
                <DeclarativePresentationPreview
                  presentation={compiledPreview.data}
                  source={sourcePreview.data}
                  now={resolvePreviewNow(previewTime)}
                  assetImageUrl={
                    previewImageAssetId
                      ? api.assetPreviewUrl(previewImageAssetId)
                      : undefined
                  }
                />
              ) : compiledPreview.isLoading || sourcePreview.isLoading ? (
                t("widgets.editors.shared.preparingPreview")
              ) : (
                t("widgets.editors.native.completeFields")
              )}
            </div>
          </aside>
          {save.error && (
            <Alert variant="destructive">
              <AlertDescription>
                {widgetSaveErrorMessage(t, save.error)}
              </AlertDescription>
            </Alert>
          )}
        </div>
        <footer>
          {!readOnly && (
            <Button
              disabled={
                save.isPending ||
                !name.trim() ||
                !compiledPreview.data ||
                Boolean(selectedDataSourceId && sourcePreview.isLoading)
              }
              onClick={() => save.mutate()}
            >
              {save.isPending
                ? t("common:actions.saving")
                : t("widgets.editors.shared.saveWidget")}
            </Button>
          )}
        </footer>
      </section>
    </div>
  );
}

export function DeclarativePresentationPreview({
  presentation,
  source,
  datasets,
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
  return root ? (
    <PreviewNode
      node={root}
      records={records}
      datasets={datasets}
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
  record,
  recordIndex,
  now,
  assetImageUrl,
}: {
  node: PresentationNode;
  records: Record<string, string>[];
  datasets?: PreviewDatasets;
  record?: Record<string, string>;
  recordIndex?: number;
  now: Date;
  assetImageUrl?: string;
}) {
  const { t } = useTranslation(["content", "common"]);
  const formatLocale = useFormatLocale();
  const props = node.props ?? {};
  const binding = node.binding;
  // A node reads the dataset it names. An unknown name falls back to the primary records so a
  // single-source Widget, and any presentation compiled before datasets were keyed, is unchanged.
  const datasetRecords = (name?: string) =>
    (name && datasets?.[name]) || records;
  const resolveBinding = (candidate: PresentationBinding) => {
    if (candidate.source === "literal")
      return formatPresentationValue(
        candidate.value ?? "",
        candidate,
        now,
        undefined,
        formatLocale,
        t,
      );
    if (candidate.source === "repeat")
      return formatPresentationValue(
        record?.[candidate.path ?? ""] ?? candidate.fallback ?? "",
        candidate,
        now,
        undefined,
        formatLocale,
        t,
      );
    if (candidate.source === "repeat_index")
      return formatPresentationValue(
        String((recordIndex ?? 0) + 1),
        candidate,
        now,
        undefined,
        formatLocale,
        t,
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
          undefined,
          formatLocale,
          t,
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
        undefined,
        formatLocale,
        t,
      );
    }
    if (candidate.source === "environment") {
      const format = candidate.format?.split(":") ?? [];
      const timezone = format.at(-1) || "UTC";
      if (format[0] === "date")
        return new Intl.DateTimeFormat(formatLocale, {
          dateStyle:
            (format[1] as "full" | "long" | "medium" | "short") ?? "full",
          timeZone: timezone,
        }).format(now);
      if (format[0] === "time")
        return new Intl.DateTimeFormat(formatLocale, {
          timeStyle: format[2] === "true" ? "medium" : "short",
          hour12: format[1] !== "24",
          timeZone: timezone,
        }).format(now);
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
            decode(format[3]) || "UTC",
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
      before: new Date(actual).getTime() < new Date(expected).getTime(),
      after: new Date(actual).getTime() > new Date(expected).getTime(),
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
                record={item}
                recordIndex={index}
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
            record={record}
            recordIndex={recordIndex}
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
          record={record}
          recordIndex={recordIndex}
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
) {
  let result = value;
  if (value && binding.format === "relative-countdown") {
    const remaining = new Date(value).getTime() - now.getTime();
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
  } else if (value && binding.format === "time") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime()))
      result = new Intl.DateTimeFormat(locale, {
        timeStyle: "short",
      }).format(parsed);
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
        result = new Intl.NumberFormat(locale, {
          style,
          currency: style === "currency" ? currency : undefined,
          maximumFractionDigits: precision,
          minimumFractionDigits:
            binding.precision ?? (binding.format === "integer" ? 0 : undefined),
        }).format(binding.format === "percent" ? numeric / 100 : numeric);
      }
    } else if (value && binding.format?.startsWith("date")) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime()))
        result = new Intl.DateTimeFormat(locale, {
          dateStyle: binding.format === "date-long" ? "long" : "short",
        }).format(parsed);
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
      start: new Date(record[startField] ?? ""),
      end: endField ? new Date(record[endField] ?? "") : undefined,
    }))
    .filter(({ start }) => !Number.isNaN(start.getTime()))
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

// The legacy Widget editors reach the shared picker through this thin wrapper so every provider
// branch below keeps its existing call shape while gaining inline source creation, status, and
// sample values.
function DataSourceSelect({
  value,
  sources,
  createProviders,
  csrf,
  disabled,
  onChange,
}: {
  value: string;
  sources: DataSource[];
  // Providers this Widget accepts, so the Connect flow cannot create a source it would reject.
  createProviders?: DataSourceProvider[];
  csrf?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation(["content", "common"]);
  return (
    <DataSourcePicker
      value={value}
      description={t("widgets.editors.dataSourceDescription")}
      sources={sources}
      createProviders={createProviders}
      csrf={csrf}
      disabled={disabled}
      onChange={onChange}
    />
  );
}

function FieldSelect({
  label,
  value,
  fields,
  disabled,
  allowEmpty = false,
  onChange,
}: {
  label: string;
  value: string;
  fields: DataSourceField[];
  disabled?: boolean;
  allowEmpty?: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation(["content", "common"]);
  const id = useId();
  const emptyLabel = allowEmpty
    ? t("widgets.editors.shared.none")
    : t("widgets.editors.shared.selectSourceFirst");
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        items={[
          { value: "", label: emptyLabel },
          ...fields.map((field) => ({
            value: field.key,
            label: field.label,
          })),
        ]}
        value={value}
        disabled={disabled || fields.length === 0}
        onValueChange={(next) => {
          if (typeof next === "string") onChange(next);
        }}
      >
        <SelectTrigger id={id} aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">{emptyLabel}</SelectItem>
          {fields.map((field) => (
            <SelectItem key={field.key} value={field.key}>
              {field.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldDescription>
        {t("widgets.editors.fieldDescription")}
      </FieldDescription>
    </Field>
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
          {!readOnly && (
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
