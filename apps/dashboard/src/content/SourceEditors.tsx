import { Select } from "../components/legacy-ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import QRCode from "qrcode";
import { api } from "../api/client";
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

export function WidgetProviderGallery({
  onChoose,
  onClose,
  page = false,
}: {
  onChoose: (provider: WidgetProvider, presetId?: WidgetPreset) => void;
  onClose: () => void;
  page?: boolean;
}) {
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
      <button
        type="button"
        key={definition.id}
        disabled={disabled}
        aria-describedby={
          disabled ? `widget-availability-${definition.id}` : undefined
        }
        onClick={() => onChoose(definition.id)}
      >
        <WidgetThumbnail
          name={definition.thumbnail ?? definition.id}
          label={definition.name}
        />
        <strong>{definition.name}</strong>
        <span>{definition.description}</span>
        {disabled && (
          <small id={`widget-availability-${definition.id}`}>
            {definition.availability?.reason}
          </small>
        )}
      </button>
    );
  };

  const featured = visible.filter(
    (definition) =>
      definition.featured && definition.availability?.enabled !== false,
  );

  return (
    <div className="details-backdrop" role={page ? undefined : "presentation"}>
      <section
        className="source-gallery source-gallery--catalog"
        role={page ? undefined : "dialog"}
        aria-modal={page ? undefined : true}
        aria-labelledby="source-gallery-title"
      >
        <header>
          <div>
            <h2 id="source-gallery-title">Create Widget</h2>
            <p>Choose an App or building block for your signage.</p>
          </div>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="widget-catalog-toolbar">
          <label className="widget-catalog-search">
            <span className="sr-only">Search Widget catalog</span>
            <input
              type="search"
              value={search}
              placeholder="Search Apps and Widgets"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <div
            className="widget-catalog-categories"
            aria-label="Widget categories"
          >
            {["All", ...categories].map((name) => (
              <button
                type="button"
                key={name}
                className={category === name ? "is-active" : ""}
                aria-pressed={category === name}
                onClick={() => setCategory(name)}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
        <div className="source-provider-groups">
          {category === "All" && !needle && featured.length > 0 && (
            <section className="source-provider-group source-provider-group--featured">
              <header className="source-provider-group__heading">
                <h3>Featured</h3>
                <p>Recommended integrations for common signage needs.</p>
              </header>
              <div className="source-provider-grid">{featured.map(card)}</div>
            </section>
          )}
          {sections.map((section) => (
            <section className="source-provider-group" key={section.name}>
              <header className="source-provider-group__heading">
                <h3>{section.name}</h3>
              </header>
              {section.items.length > 0 ? (
                <div className="source-provider-grid">
                  {section.items.map(card)}
                </div>
              ) : (
                <p className="source-gallery__no-results">
                  No Widgets match this search.
                </p>
              )}
            </section>
          ))}
          {visible.length === 0 && (
            <p className="source-gallery__no-results">
              No Apps or Widgets match “{search}”.
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
const nativeDefault = (provider: NativeProvider): NativeConfig => {
  const colors = { foregroundColor: "#F5F7FA", backgroundColor: "#0E141B" };
  if (provider === "clock")
    return {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      format: "12",
      showSeconds: false,
      ...colors,
    };
  if (provider === "date")
    return {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      format: "full",
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
      completionText: "Event started",
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
      emptyState: "No value available",
      ...colors,
    };
  if (provider === "cards")
    return {
      dataSourceId: "",
      titleField: "",
      columns: 2,
      maximumItems: 6,
      density: "comfortable",
      emptyState: "No items available",
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
      emptyState: "No information available",
      ...colors,
    };
  if (provider === "stat_grid")
    return {
      dataSourceId: "",
      metrics: [{ label: "Value", valueField: "", format: "number" }],
      columns: 2,
      emptyState: "No information available",
      ...colors,
    };
  if (provider === "chart")
    return {
      dataSourceId: "",
      dataset: "records",
      chartType: "line",
      series: [{ field: "", label: "Series 1", color: "#4DB6FF" }],
      showLegend: true,
      showAxes: true,
      emptyState: "No chart data available",
      ...colors,
    };
  if (provider === "progress")
    return {
      dataSourceId: "",
      valueField: "",
      staticTarget: 100,
      label: "Progress",
      showPercent: true,
      completionText: "Complete",
      emptyState: "No information available",
      ...colors,
    };
  if (provider === "timeline")
    return {
      dataSourceId: "",
      dateField: "",
      titleField: "",
      orientation: "vertical",
      maximumItems: 8,
      emptyState: "No milestones available",
      ...colors,
    };
  if (provider === "world_clock")
    return {
      zones: [
        {
          label: "Local",
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        },
      ],
      format: "12",
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
      emptyState: "No items available",
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
    emptyState: "No items available",
    ...colors,
  };
};

function nativeWidgetGuidance(provider: NativeProvider) {
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
    return "Connect the information to show, choose how it is presented, and check the live preview.";
  return "Configure what appears on screen and check the live preview as you work.";
}

function nativeWidgetContentGuidance(provider: NativeProvider) {
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
    return "Start by choosing the data this Widget should use, then map and format the fields that appear.";
  if (provider === "countdown")
    return "Set the target time, decide what happens when it is reached, and choose which time units appear.";
  if (provider === "qrcode")
    return "Enter the destination people should open after scanning, then add an optional on-screen label.";
  if (provider === "world_clock")
    return "Add each location and its IANA timezone, such as America/New_York or Europe/London.";
  if (provider === "clock" || provider === "date")
    return "Choose the timezone and format that should appear on the screen.";
  return "Enter the content people should see and choose how it behaves on screen.";
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
  const queryClient = useQueryClient();
  const previewRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(asset?.name ?? "");
  const [description, setDescription] = useState(asset?.description ?? "");
  const [configuration, setConfiguration] = useState<NativeConfig>(
    (asset?.widget?.configuration as NativeConfig | undefined) ??
      nativeDefault(provider),
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
        throw new Error("Wait for the Widget preview before saving.");
      const previewImage = await captureWidgetPreview(previewRef.current);
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
    <div className="details-backdrop" role={page ? undefined : "presentation"}>
      <section
        className="asset-details source-editor widget-editor"
        role={page ? undefined : "dialog"}
        aria-modal={page ? undefined : true}
        aria-labelledby="native-app-title"
      >
        <header>
          <div>
            <h2 id="native-app-title">
              {asset ? "Edit" : "Create"}{" "}
              {provider === "qrcode"
                ? "QR Code"
                : provider[0]!.toUpperCase() + provider.slice(1)}{" "}
              Widget
            </h2>
            <p>{nativeWidgetGuidance(provider)}</p>
          </div>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="source-editor__body">
          {presetId && (
            <div className="notice">
              Guided preset: <strong>{presetId.replaceAll("_", " ")}</strong>.
              This saves as a reusable {provider.replaceAll("_", " ")} Widget;
              playback does not depend on the preset.
            </div>
          )}
          <section className="widget-editor__section">
            <header>
              <h3>Widget details</h3>
              <p>Name this Widget so it is easy to recognize later.</p>
            </header>
            <div className="widget-editor__section-body">
              <label className="field">
                <span className="field__label">Widget name</span>
                <input
                  value={name}
                  disabled={readOnly}
                  onChange={(e) => setName(e.target.value)}
                />
                <small>
                  Used to find this Widget in Content and playlists.
                </small>
              </label>
              <label className="field">
                <span className="field__label">Description</span>
                <input
                  value={description}
                  disabled={readOnly}
                  onChange={(e) => setDescription(e.target.value)}
                />
                <small>
                  Optional notes for other people managing this installation.
                </small>
              </label>
            </div>
          </section>
          <section className="widget-editor__section">
            <header>
              <h3>Content and behavior</h3>
              <p>{nativeWidgetContentGuidance(provider)}</p>
            </header>
            <div className="widget-editor__section-body">
              {(provider === "clock" || provider === "date") && (
                <label className="field">
                  <span className="field__label">Timezone</span>
                  <input
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
                  <small>
                    Use an IANA timezone such as America/New_York. Use UTC for
                    universal time.
                  </small>
                </label>
              )}
              {provider === "clock" && (
                <div className="form-grid form-grid--2">
                  <label className="field">
                    <span className="field__label">Time format</span>
                    <Select
                      value={(configuration as ClockWidgetConfig).format}
                      disabled={readOnly}
                      onChange={(e) =>
                        setConfiguration((current) => ({
                          ...(current as ClockWidgetConfig),
                          format: e.target.value as "12" | "24",
                        }))
                      }
                    >
                      <option value="12">12-hour</option>
                      <option value="24">24-hour</option>
                    </Select>
                  </label>
                  <label className="switch-row">
                    <input
                      type="checkbox"
                      checked={(configuration as ClockWidgetConfig).showSeconds}
                      disabled={readOnly}
                      onChange={(e) =>
                        setConfiguration((current) => ({
                          ...current,
                          showSeconds: e.target.checked,
                        }))
                      }
                    />
                    <span>Show seconds</span>
                  </label>
                </div>
              )}
              {provider === "date" && (
                <label className="field">
                  <span className="field__label">Date format</span>
                  <Select
                    value={(configuration as DateWidgetConfig).format}
                    disabled={readOnly}
                    onChange={(e) =>
                      setConfiguration((current) => ({
                        ...(current as DateWidgetConfig),
                        format: e.target.value as DateWidgetConfig["format"],
                      }))
                    }
                  >
                    <option value="full">Full</option>
                    <option value="long">Long</option>
                    <option value="medium">Medium</option>
                    <option value="short">Short</option>
                  </Select>
                </label>
              )}
              {provider === "countdown" && (
                <>
                  <div className="form-grid form-grid--2">
                    <label className="field">
                      <span className="field__label">Target date and time</span>
                      <input
                        type="datetime-local"
                        value={(configuration as CountdownWidgetConfig).target}
                        disabled={readOnly}
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...current,
                            target: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="field">
                      <span className="field__label">Timezone</span>
                      <input
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
                    </label>
                    <label className="field">
                      <span className="field__label">Mode</span>
                      <Select
                        value={(configuration as CountdownWidgetConfig).mode}
                        disabled={readOnly}
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...(current as CountdownWidgetConfig),
                            mode: event.target
                              .value as CountdownWidgetConfig["mode"],
                            recurrence:
                              event.target.value === "count_up"
                                ? "none"
                                : ((current as CountdownWidgetConfig)
                                    .recurrence ?? "none"),
                          }))
                        }
                      >
                        <option value="countdown">Count down</option>
                        <option value="count_up">Count up</option>
                      </Select>
                    </label>
                    <label className="field">
                      <span className="field__label">Repeat</span>
                      <Select
                        value={
                          (configuration as CountdownWidgetConfig).recurrence ??
                          "none"
                        }
                        disabled={
                          readOnly ||
                          (configuration as CountdownWidgetConfig).mode ===
                            "count_up"
                        }
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...(current as CountdownWidgetConfig),
                            recurrence: event.target
                              .value as CountdownWidgetConfig["recurrence"],
                          }))
                        }
                      >
                        <option value="none">Does not repeat</option>
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                        <option value="monthly">Monthly</option>
                        <option value="yearly">Yearly</option>
                      </Select>
                    </label>
                    <label className="field">
                      <span className="field__label">Layout</span>
                      <Select
                        value={
                          (configuration as CountdownWidgetConfig).layout ??
                          "stacked"
                        }
                        disabled={readOnly}
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...(current as CountdownWidgetConfig),
                            layout: event.target
                              .value as CountdownWidgetConfig["layout"],
                          }))
                        }
                      >
                        <option value="stacked">Title above countdown</option>
                        <option value="horizontal">
                          Title beside countdown
                        </option>
                        <option value="countdown_only">Countdown only</option>
                      </Select>
                    </label>
                    <label className="field">
                      <span className="field__label">Completion behavior</span>
                      <Select
                        value={
                          (configuration as CountdownWidgetConfig)
                            .completionAction
                        }
                        disabled={
                          readOnly ||
                          ((configuration as CountdownWidgetConfig)
                            .recurrence ?? "none") !== "none"
                        }
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...current,
                            completionAction: event.target
                              .value as CountdownWidgetConfig["completionAction"],
                          }))
                        }
                      >
                        <option value="completed_text">
                          Show completion text
                        </option>
                        <option value="hide">Hide</option>
                        <option value="count_up">Continue counting up</option>
                      </Select>
                    </label>
                  </div>
                  <div className="form-grid form-grid--2">
                    <label className="field">
                      <span className="field__label">Title</span>
                      <input
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
                    </label>
                    <label className="field">
                      <span className="field__label">Completion text</span>
                      <input
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
                    </label>
                  </div>
                  <fieldset>
                    <legend>Visible units</legend>
                    <div className="checkbox-grid">
                      {(["Days", "Hours", "Minutes", "Seconds"] as const).map(
                        (unit) => {
                          const key =
                            `show${unit}` as keyof CountdownWidgetConfig;
                          return (
                            <label key={unit}>
                              <input
                                type="checkbox"
                                checked={Boolean(
                                  (configuration as CountdownWidgetConfig)[key],
                                )}
                                disabled={readOnly}
                                onChange={(event) =>
                                  setConfiguration((current) => ({
                                    ...current,
                                    [key]: event.target.checked,
                                  }))
                                }
                              />
                              <span>{unit}</span>
                            </label>
                          );
                        },
                      )}
                    </div>
                  </fieldset>
                </>
              )}
              {provider === "qrcode" && (
                <>
                  <label className="field">
                    <span className="field__label">Text or URL</span>
                    <textarea
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
                  </label>
                  <div className="form-grid form-grid--2">
                    <label className="field">
                      <span className="field__label">Label</span>
                      <input
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
                    </label>
                    <label className="field">
                      <span className="field__label">Error correction</span>
                      <Select
                        value={
                          (configuration as QRCodeWidgetConfig).errorCorrection
                        }
                        disabled={readOnly}
                        onChange={(e) =>
                          setConfiguration((current) => ({
                            ...current,
                            errorCorrection: e.target
                              .value as QRCodeWidgetConfig["errorCorrection"],
                          }))
                        }
                      >
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="quartile">Quartile</option>
                        <option value="high">High</option>
                      </Select>
                      <small>
                        Higher correction is easier to scan if the code is
                        damaged, but makes the pattern denser.
                      </small>
                    </label>
                  </div>
                  <div className="form-grid form-grid--2">
                    <label className="field">
                      <span className="field__label">Speed</span>
                      <Select
                        value={(configuration as TickerWidgetConfig).speed}
                        disabled={readOnly}
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...current,
                            speed: event.target
                              .value as TickerWidgetConfig["speed"],
                          }))
                        }
                      >
                        <option value="slow">Slow</option>
                        <option value="normal">Normal</option>
                        <option value="fast">Fast</option>
                      </Select>
                    </label>
                    <label className="field">
                      <span className="field__label">Direction</span>
                      <Select
                        value={(configuration as TickerWidgetConfig).direction}
                        disabled={readOnly}
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...current,
                            direction: event.target
                              .value as TickerWidgetConfig["direction"],
                          }))
                        }
                      >
                        <option value="left">Left</option>
                        <option value="right">Right</option>
                      </Select>
                    </label>
                  </div>
                  {(configuration as QRCodeWidgetConfig).value.length > 500 && (
                    <div className="notice notice--warning">
                      Dense QR Code. Test scanning at the intended display
                      distance.
                    </div>
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
                  <div className="form-grid form-grid--2">
                    <fieldset>
                      <legend>Fields (up to three)</legend>
                      <div className="checkbox-grid">
                        {availableFields.map((field) => {
                          const config = configuration as TickerWidgetConfig;
                          const selected = (
                            config.fields ?? [config.field]
                          ).includes(field.key);
                          return (
                            <label key={field.key}>
                              <input
                                type="checkbox"
                                checked={selected}
                                disabled={
                                  readOnly ||
                                  (!selected &&
                                    (config.fields ?? [config.field]).filter(
                                      Boolean,
                                    ).length >= 3)
                                }
                                onChange={(event) =>
                                  setConfiguration((current) => {
                                    const ticker =
                                      current as TickerWidgetConfig;
                                    const fields = (
                                      ticker.fields ?? [ticker.field]
                                    ).filter(Boolean);
                                    const next = event.target.checked
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
                              />
                              <span>{field.label}</span>
                            </label>
                          );
                        })}
                      </div>
                    </fieldset>
                    <label className="field">
                      <span className="field__label">Separator</span>
                      <input
                        value={(configuration as TickerWidgetConfig).separator}
                        disabled={readOnly}
                        onChange={(e) =>
                          setConfiguration((current) => ({
                            ...current,
                            separator: e.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="field">
                      <span className="field__label">Field separator</span>
                      <input
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
                    </label>
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
                  <fieldset>
                    <legend>Displayed fields</legend>
                    {!availableFields.length ? (
                      <small>Select a Data Source to choose its fields.</small>
                    ) : (
                      <div className="checkbox-grid">
                        {availableFields.map((field) => {
                          const selected = (
                            configuration as DisplayWidgetConfig
                          ).fields.includes(field.key);
                          return (
                            <label key={field.key}>
                              <input
                                type="checkbox"
                                checked={selected}
                                disabled={readOnly}
                                onChange={(event) =>
                                  setConfiguration((current) => {
                                    const config =
                                      current as DisplayWidgetConfig;
                                    const fields = event.target.checked
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
                              />
                              <span>{field.label}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </fieldset>
                  {provider === "list" && (
                    <div className="form-grid form-grid--2">
                      {(
                        [
                          ["primaryField", "Primary field"],
                          ["secondaryField", "Secondary field"],
                          ["leadingField", "Leading field"],
                          ["trailingField", "Trailing field"],
                        ] as const
                      ).map(([key, label]) => (
                        <FieldSelect
                          key={key}
                          label={label}
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
                      <label className="switch-row">
                        <input
                          type="checkbox"
                          checked={
                            (configuration as DisplayWidgetConfig)
                              .showDividers ?? false
                          }
                          disabled={readOnly}
                          onChange={(event) =>
                            setConfiguration((current) => ({
                              ...current,
                              showDividers: event.target.checked,
                            }))
                          }
                        />
                        <span>Show row dividers</span>
                      </label>
                    </div>
                  )}
                  {provider === "menu" && (
                    <div className="form-grid form-grid--2">
                      <label className="field">
                        <span className="field__label">Presentation</span>
                        <Select
                          value={
                            (configuration as DisplayWidgetConfig).mode ??
                            "single_record"
                          }
                          disabled={readOnly}
                          onChange={(event) =>
                            setConfiguration((current) => ({
                              ...(current as DisplayWidgetConfig),
                              mode: event.target
                                .value as DisplayWidgetConfig["mode"],
                            }))
                          }
                        >
                          <option value="single_record">
                            Fields from one record
                          </option>
                          <option value="records">Label and value rows</option>
                        </Select>
                      </label>
                      {(configuration as DisplayWidgetConfig).mode ===
                        "records" && (
                        <>
                          <FieldSelect
                            label="Label field"
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
                            label="Value field"
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
                      <div className="checkbox-grid">
                        <label>
                          <input
                            type="checkbox"
                            checked={
                              (configuration as DisplayWidgetConfig)
                                .showHeader ?? false
                            }
                            disabled={readOnly}
                            onChange={(event) =>
                              setConfiguration((current) => ({
                                ...current,
                                showHeader: event.target.checked,
                              }))
                            }
                          />
                          <span>Show column headers</span>
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={
                              (configuration as DisplayWidgetConfig)
                                .alternatingRows ?? false
                            }
                            disabled={readOnly}
                            onChange={(event) =>
                              setConfiguration((current) => ({
                                ...current,
                                alternatingRows: event.target.checked,
                              }))
                            }
                          />
                          <span>Alternate row backgrounds</span>
                        </label>
                      </div>
                      <fieldset>
                        <legend>Column presentation</legend>
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
                                className="form-grid form-grid--4"
                                key={fieldKey}
                              >
                                <label className="field">
                                  <span className="field__label">Label</span>
                                  <input
                                    value={existing.label ?? ""}
                                    disabled={readOnly}
                                    onChange={(event) =>
                                      updateColumn({
                                        label: event.target.value,
                                      })
                                    }
                                  />
                                </label>
                                <label className="field">
                                  <span className="field__label">Format</span>
                                  <Select
                                    value={existing.format ?? "text"}
                                    disabled={readOnly}
                                    onChange={(event) =>
                                      updateColumn({
                                        format: event.target
                                          .value as FieldFormat["format"],
                                      })
                                    }
                                  >
                                    <option value="text">Text</option>
                                    <option value="number">Number</option>
                                    <option value="integer">Integer</option>
                                    <option value="percent">Percent</option>
                                    <option value="currency">Currency</option>
                                    <option value="date-short">
                                      Short date
                                    </option>
                                    <option value="date-long">Long date</option>
                                  </Select>
                                </label>
                                <label className="field">
                                  <span className="field__label">
                                    Alignment
                                  </span>
                                  <Select
                                    value={existing.alignment ?? "left"}
                                    disabled={readOnly}
                                    onChange={(event) =>
                                      updateColumn({
                                        alignment: event.target
                                          .value as FieldFormat["alignment"],
                                      })
                                    }
                                  >
                                    <option value="left">Left</option>
                                    <option value="center">Center</option>
                                    <option value="right">Right</option>
                                  </Select>
                                </label>
                                <label className="field">
                                  <span className="field__label">Width %</span>
                                  <input
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
                                </label>
                              </div>
                            );
                          },
                        )}
                      </fieldset>
                    </>
                  )}
                  {provider === "agenda" && (
                    <div className="form-grid form-grid--2">
                      {(
                        [
                          ["dateField", "Date field"],
                          ["timeField", "Time field"],
                          ["titleField", "Title field"],
                          ["locationField", "Location field"],
                          ["descriptionField", "Description field"],
                        ] as const
                      ).map(([key, label]) => (
                        <FieldSelect
                          key={key}
                          label={label}
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
                  <label className="field">
                    <span className="field__label">Maximum items</span>
                    <input
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
                    <small>
                      Limits how many rows or events can appear at once.
                    </small>
                  </label>
                  <label className="field">
                    <span className="field__label">
                      Message when there is no data
                    </span>
                    <input
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
                    <small>
                      Shown on screen when the source returns no usable records.
                    </small>
                  </label>
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
                  <div className="form-grid form-grid--2">
                    <FieldSelect
                      label="Value field"
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
                    <label className="field">
                      <span className="field__label">Static label</span>
                      <input
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
                    </label>
                    <FieldSelect
                      label="Label field"
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
                      label="Secondary field"
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
                    <label className="field">
                      <span className="field__label">Format</span>
                      <Select
                        value={(configuration as MetricWidgetConfig).format}
                        disabled={readOnly}
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...(current as MetricWidgetConfig),
                            format: event.target
                              .value as MetricWidgetConfig["format"],
                          }))
                        }
                      >
                        <option value="number">Number</option>
                        <option value="integer">Integer</option>
                        <option value="percent">Percent</option>
                        <option value="currency">Currency</option>
                      </Select>
                    </label>
                    <label className="field">
                      <span className="field__label">Decimal places</span>
                      <input
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
                    </label>
                    <label className="field">
                      <span className="field__label">Prefix</span>
                      <input
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
                    </label>
                    <label className="field">
                      <span className="field__label">Suffix</span>
                      <input
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
                    </label>
                    <label className="field">
                      <span className="field__label">Alignment</span>
                      <Select
                        value={(configuration as MetricWidgetConfig).alignment}
                        disabled={readOnly}
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...current,
                            alignment: event.target
                              .value as MetricWidgetConfig["alignment"],
                          }))
                        }
                      >
                        <option value="left">Left</option>
                        <option value="center">Center</option>
                        <option value="right">Right</option>
                      </Select>
                    </label>
                  </div>
                  <label className="field">
                    <span className="field__label">Empty state</span>
                    <input
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
                  </label>
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
                  <div className="form-grid form-grid--2">
                    <FieldSelect
                      label="Title field"
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
                      ["subtitleField", "bodyField", "badgeField"] as const
                    ).map((key) => (
                      <FieldSelect
                        key={key}
                        label={key.replace("Field", "")}
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
                    <label className="field">
                      <span className="field__label">Columns</span>
                      <input
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
                    </label>
                    <label className="field">
                      <span className="field__label">Maximum items</span>
                      <input
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
                    </label>
                    <label className="field">
                      <span className="field__label">Density</span>
                      <Select
                        value={(configuration as CardsWidgetConfig).density}
                        disabled={readOnly}
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...current,
                            density: event.target
                              .value as CardsWidgetConfig["density"],
                          }))
                        }
                      >
                        <option value="comfortable">Comfortable</option>
                        <option value="compact">Compact</option>
                      </Select>
                    </label>
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
                  <div className="checkbox-grid">
                    {[
                      ["showLocation", "Location"],
                      ["showCurrent", "Current conditions"],
                      ["showHumidity", "Humidity"],
                      ["showWind", "Wind"],
                      ["showPrecipitation", "Precipitation"],
                    ].map(([key, label]) => (
                      <label key={key}>
                        <input
                          type="checkbox"
                          checked={Boolean(
                            (
                              configuration as unknown as Record<
                                string,
                                unknown
                              >
                            )[key!],
                          )}
                          disabled={readOnly}
                          onChange={(event) =>
                            setConfiguration((current) => ({
                              ...current,
                              [key!]: event.target.checked,
                            }))
                          }
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                  <label className="field">
                    <span className="field__label">Forecast days</span>
                    <input
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
                  </label>
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
                  <div className="form-grid form-grid--2">
                    {(
                      [
                        ["titleField", "Title field", false],
                        ["subtitleField", "Subtitle field", true],
                        ["bodyField", "Body field", true],
                        ["badgeField", "Badge field", true],
                        ["dateField", "Date field", true],
                      ] as const
                    ).map(([key, label, allowEmpty]) => (
                      <FieldSelect
                        key={key}
                        label={label}
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
                    <label className="field">
                      <span className="field__label">Uploaded image</span>
                      <Select
                        value={
                          (configuration as SpotlightWidgetConfig)
                            .imageAssetId ?? ""
                        }
                        disabled={readOnly}
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...current,
                            imageAssetId: event.target.value || undefined,
                          }))
                        }
                      >
                        <option value="">No image</option>
                        {(imageAssets.data?.items ?? []).map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </Select>
                    </label>
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
                  <label className="field">
                    <span className="field__label">Columns</span>
                    <input
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
                  </label>
                  <fieldset>
                    <legend>Metrics</legend>
                    {(configuration as StatGridWidgetConfig).metrics.map(
                      (metric, index) => (
                        <div className="form-grid form-grid--4" key={index}>
                          <label className="field">
                            <span className="field__label">Label</span>
                            <input
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
                          </label>
                          <FieldSelect
                            label="Value field"
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
                          <label className="field">
                            <span className="field__label">Format</span>
                            <Select
                              value={metric.format ?? "number"}
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
                                              format: event.target
                                                .value as typeof metric.format,
                                            }
                                          : item,
                                    ),
                                  };
                                })
                              }
                            >
                              <option value="number">Number</option>
                              <option value="integer">Integer</option>
                              <option value="percent">Percent</option>
                              <option value="currency">Currency</option>
                            </Select>
                          </label>
                          <button
                            type="button"
                            className="button"
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
                            Remove
                          </button>
                        </div>
                      ),
                    )}
                    <button
                      type="button"
                      className="button"
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
                              label: "Value",
                              valueField: "",
                              format: "number",
                            },
                          ],
                        }))
                      }
                    >
                      Add metric
                    </button>
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
                  <div className="form-grid form-grid--2">
                    <label className="field">
                      <span className="field__label">Chart type</span>
                      <Select
                        value={(configuration as ChartWidgetConfig).chartType}
                        disabled={readOnly}
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...current,
                            chartType: event.target
                              .value as ChartWidgetConfig["chartType"],
                          }))
                        }
                      >
                        <option value="line">Line</option>
                        <option value="bar">Bar</option>
                        <option value="donut">Donut</option>
                      </Select>
                    </label>
                    <label className="field">
                      <span className="field__label">Dataset</span>
                      <input
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
                    </label>
                  </div>
                  <fieldset>
                    <legend>Series</legend>
                    {(configuration as ChartWidgetConfig).series.map(
                      (series, index) => (
                        <div className="form-grid form-grid--4" key={index}>
                          <FieldSelect
                            label="Numeric field"
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
                          <label className="field">
                            <span className="field__label">Label</span>
                            <input
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
                          </label>
                          <label className="field">
                            <span className="field__label">Color</span>
                            <input
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
                          </label>
                          <button
                            type="button"
                            className="button"
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
                            Remove
                          </button>
                        </div>
                      ),
                    )}
                    <button
                      type="button"
                      className="button"
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
                              label: "Series",
                              color: "#FFB547",
                            },
                          ],
                        }))
                      }
                    >
                      Add series
                    </button>
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
                  <div className="form-grid form-grid--2">
                    <FieldSelect
                      label="Value field"
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
                      label="Target field"
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
                    <label className="field">
                      <span className="field__label">Static target</span>
                      <input
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
                    </label>
                    <label className="field">
                      <span className="field__label">Label</span>
                      <input
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
                    </label>
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
                  <div className="form-grid form-grid--2">
                    {(
                      [
                        ["dateField", "Date field", false],
                        ["titleField", "Title field", false],
                        ["bodyField", "Body field", true],
                        ["statusField", "Status field", true],
                      ] as const
                    ).map(([key, label, allowEmpty]) => (
                      <FieldSelect
                        key={key}
                        label={label}
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
                    <label className="field">
                      <span className="field__label">Orientation</span>
                      <Select
                        value={
                          (configuration as TimelineWidgetConfig).orientation
                        }
                        disabled={readOnly}
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...current,
                            orientation: event.target
                              .value as TimelineWidgetConfig["orientation"],
                          }))
                        }
                      >
                        <option value="vertical">Vertical</option>
                        <option value="horizontal">Horizontal</option>
                      </Select>
                    </label>
                  </div>
                </>
              )}
              {provider === "world_clock" && (
                <>
                  <div className="form-grid form-grid--2">
                    <label className="field">
                      <span className="field__label">Time format</span>
                      <Select
                        value={(configuration as WorldClockWidgetConfig).format}
                        disabled={readOnly}
                        onChange={(event) =>
                          setConfiguration((current) => ({
                            ...(current as WorldClockWidgetConfig),
                            format: event.target
                              .value as WorldClockWidgetConfig["format"],
                          }))
                        }
                      >
                        <option value="12">12-hour</option>
                        <option value="24">24-hour</option>
                      </Select>
                    </label>
                    <label className="field">
                      <span className="field__label">Columns</span>
                      <input
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
                    </label>
                  </div>
                  <fieldset>
                    <legend>Locations</legend>
                    {(configuration as WorldClockWidgetConfig).zones.map(
                      (zone, index) => (
                        <div className="form-grid form-grid--2" key={index}>
                          <label className="field">
                            <span className="field__label">Label</span>
                            <input
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
                          </label>
                          <label className="field">
                            <span className="field__label">IANA timezone</span>
                            <input
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
                          </label>
                        </div>
                      ),
                    )}
                    <button
                      type="button"
                      className="button"
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
                            { label: "Location", timezone: "UTC" },
                          ],
                        }))
                      }
                    >
                      Add location
                    </button>
                  </fieldset>
                </>
              )}
            </div>
          </section>
          <section className="widget-editor__section">
            <header>
              <h3>Appearance</h3>
              <p>
                Adjust spacing, scale, and colors after the content looks right.
              </p>
            </header>
            <div className="widget-editor__section-body">
              <div className="widget-editor__subsection">
                <header>
                  <strong>Size and spacing</strong>
                  <p>Control how much of the Widget the content occupies.</p>
                </header>
                <label className="switch-row">
                  <input
                    type="checkbox"
                    checked={configuration.textScale !== undefined}
                    disabled={readOnly}
                    onChange={(event) =>
                      setConfiguration((current) => {
                        if (event.target.checked)
                          return { ...current, textScale: 100 };
                        const automatic = { ...current };
                        delete automatic.textScale;
                        return automatic;
                      })
                    }
                  />
                  <span>Use a custom scale</span>
                </label>
                {configuration.textScale !== undefined && (
                  <label className="field">
                    <span className="field__label">
                      Scale ({configuration.textScale}%)
                    </span>
                    <input
                      type="range"
                      min={25}
                      max={500}
                      step={25}
                      value={configuration.textScale}
                      disabled={readOnly}
                      onChange={(event) =>
                        setConfiguration((current) => ({
                          ...current,
                          textScale: Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                )}
                <label className="field">
                  <span className="field__label">
                    Padding ({configuration.contentPadding ?? 10}%)
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={40}
                    step={1}
                    value={configuration.contentPadding ?? 10}
                    disabled={readOnly}
                    onChange={(event) =>
                      setConfiguration((current) => ({
                        ...current,
                        contentPadding: Number(event.target.value),
                      }))
                    }
                  />
                </label>
                <small>
                  By default, content uses the center 80% of the Widget. Reduce
                  padding to let it fill more space; custom scale ranges up to
                  500% and still fits long text within the available area.
                </small>
              </div>
              <div className="widget-editor__subsection">
                <header>
                  <strong>Colors</strong>
                  <p>Set the foreground and background used on screen.</p>
                </header>
                <div className="form-grid form-grid--2">
                  <label className="field">
                    <span className="field__label">Text and accent color</span>
                    <input
                      type="color"
                      value={configuration.foregroundColor}
                      disabled={readOnly}
                      onChange={(e) =>
                        updateColors("foregroundColor", e.target.value)
                      }
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">Background color</span>
                    <input
                      type="color"
                      value={configuration.backgroundColor}
                      disabled={readOnly}
                      onChange={(e) =>
                        updateColors("backgroundColor", e.target.value)
                      }
                    />
                  </label>
                </div>
              </div>
            </div>
          </section>
          <aside className="widget-editor__preview" aria-label="Live preview">
            <header>
              <strong>Live preview</strong>
              <span>Updates as you make changes.</span>
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
                "Preparing preview…"
              ) : (
                "Complete the required fields to see a preview."
              )}
            </div>
          </aside>
          {save.error && <p className="form-error">{save.error.message}</p>}
        </div>
        <footer>
          {!readOnly && (
            <button
              className="button button--primary"
              disabled={
                save.isPending ||
                !name.trim() ||
                !compiledPreview.data ||
                Boolean(selectedDataSourceId && sourcePreview.isLoading)
              }
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving…" : "Save Widget"}
            </button>
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
    if (!url) return "Web presentation URL is unavailable.";
    const external =
      new URL(url, window.location.href).origin !== window.location.origin;
    return (
      <iframe
        className="presentation-preview__web"
        src={url}
        title="Web Widget preview"
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
    "Presentation root is unavailable."
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
  const props = node.props ?? {};
  const binding = node.binding;
  // A node reads the dataset it names. An unknown name falls back to the primary records so a
  // single-source Widget, and any presentation compiled before datasets were keyed, is unchanged.
  const datasetRecords = (name?: string) =>
    (name && datasets?.[name]) || records;
  const resolveBinding = (candidate: PresentationBinding) => {
    if (candidate.source === "literal")
      return formatPresentationValue(candidate.value ?? "", candidate, now);
    if (candidate.source === "repeat")
      return formatPresentationValue(
        record?.[candidate.path ?? ""] ?? candidate.fallback ?? "",
        candidate,
        now,
      );
    if (candidate.source === "repeat_index")
      return formatPresentationValue(
        String((recordIndex ?? 0) + 1),
        candidate,
        now,
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
      return formatPresentationValue(joined, candidate, now);
    }
    if (candidate.source === "environment") {
      const format = candidate.format?.split(":") ?? [];
      const timezone = format.at(-1) || "UTC";
      if (format[0] === "date")
        return new Intl.DateTimeFormat(undefined, {
          dateStyle:
            (format[1] as "full" | "long" | "medium" | "short") ?? "full",
          timeZone: timezone,
        }).format(now);
      if (format[0] === "time")
        return new Intl.DateTimeFormat(undefined, {
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
          ? "Now"
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
      result = new Intl.DateTimeFormat(undefined, {
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
        result = new Intl.NumberFormat(undefined, {
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
        result = new Intl.DateTimeFormat(undefined, {
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
      alt={`QR Code for ${value}`}
    />
  ) : (
    <span>Preparing QR Code…</span>
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
  return (
    <DataSourcePicker
      value={value}
      description="Choose the information this Widget should display. You can connect a new source without leaving the editor."
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
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <Select
        value={value}
        disabled={disabled || fields.length === 0}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">
          {allowEmpty ? "None" : "Select a Data Source first"}
        </option>
        {fields.map((field) => (
          <option key={field.key} value={field.key}>
            {field.label}
          </option>
        ))}
      </Select>
      <small>
        Choose which field from the connected data supplies this value.
      </small>
    </label>
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
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ["assets"] });
      onSaved(saved);
    },
  });
  const close = () => {
    if (!dirty || confirm("Discard unsaved YouTube Widget changes?")) onClose();
  };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (!dirty || confirm("Discard unsaved YouTube Widget changes?"))
          onClose();
      }
    };
    addEventListener("keydown", escape);
    return () => removeEventListener("keydown", escape);
  }, [dirty, onClose]);
  return (
    <div className="details-backdrop" role={page ? undefined : "presentation"}>
      <section
        className="asset-details source-editor"
        role={page ? undefined : "dialog"}
        aria-modal={page ? undefined : true}
        aria-labelledby="youtube-source-title"
      >
        <header>
          <div>
            <h2 id="youtube-source-title">
              {asset ? "Edit YouTube Widget" : "Create YouTube Widget"}
            </h2>
            <p>
              Videos and playlists play fullscreen through YouTube’s embedded
              player.
            </p>
          </div>
          <button className="icon-button" aria-label="Close" onClick={close}>
            <X size={18} />
          </button>
        </header>
        <label className="field">
          <span className="field__label">Name</span>
          <input
            disabled={readOnly}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setDirty(true);
            }}
          />
        </label>
        <label className="field">
          <span className="field__label">Description</span>
          <textarea
            disabled={readOnly}
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
              setDirty(true);
            }}
          />
        </label>
        <label className="field">
          <span className="field__label">YouTube video or playlist URL</span>
          <input
            disabled={readOnly}
            value={configuration.url}
            onChange={(event) => set("url", event.target.value)}
          />
          <small>
            Tilecast detects whether this is a video or playlist. No YouTube API
            key is required.
          </small>
        </label>
        <div className="source-editor__columns">
          <label className="field">
            <span className="field__label">Start time (seconds)</span>
            <input
              type="number"
              min={0}
              disabled={readOnly}
              value={configuration.startSeconds}
              onChange={(event) =>
                set("startSeconds", Number(event.target.value))
              }
            />
          </label>
          <label className="field">
            <span className="field__label">End time (optional)</span>
            <input
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
          </label>
          <label className="field">
            <span className="field__label">Volume</span>
            <div className="unit-input">
              <input
                type="number"
                min={0}
                max={100}
                disabled={readOnly || configuration.muted}
                value={configuration.volume}
                onChange={(event) => set("volume", Number(event.target.value))}
              />
              <span>%</span>
            </div>
          </label>
          <label className="field">
            <span className="field__label">Caption language</span>
            <input
              disabled={readOnly || !configuration.captions}
              placeholder="en"
              value={configuration.captionLanguage}
              onChange={(event) => set("captionLanguage", event.target.value)}
            />
          </label>
        </div>
        <div className="source-switches">
          {(
            [
              ["loop", "Loop playback"],
              ["muted", "Mute audio"],
              ["captions", "Show captions"],
              ["controls", "Show YouTube controls"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              <input
                type="checkbox"
                disabled={readOnly}
                checked={configuration[key]}
                onChange={(event) => set(key, event.target.checked)}
              />{" "}
              {label}
            </label>
          ))}
        </div>
        <label className="field">
          <span className="field__label">Playlist item behavior</span>
          <Select
            disabled={readOnly}
            value={configuration.playlistPlaybackMode}
            onChange={(event) =>
              set(
                "playlistPlaybackMode",
                event.target.value as YouTubeConfig["playlistPlaybackMode"],
              )
            }
          >
            <option value="until_end">Play until video ends</option>
            <option value="fixed_duration">Play for a fixed duration</option>
          </Select>
        </label>
        {configuration.playlistPlaybackMode === "fixed_duration" && (
          <label className="field">
            <span className="field__label">Fixed duration (seconds)</span>
            <input
              type="number"
              min={1}
              max={86400}
              disabled={readOnly}
              value={configuration.fixedDurationSeconds ?? 30}
              onChange={(event) =>
                set("fixedDurationSeconds", Number(event.target.value))
              }
            />
          </label>
        )}
        <label className="field">
          <span className="field__label">Failure behavior</span>
          <Select
            disabled={readOnly}
            value={configuration.failureBehavior}
            onChange={(event) =>
              set(
                "failureBehavior",
                event.target.value as YouTubeConfig["failureBehavior"],
              )
            }
          >
            <option value="placeholder">Show Tilecast placeholder</option>
            <option value="fallback_image">Show fallback image</option>
            <option value="skip">Skip playlist item</option>
          </Select>
        </label>
        <label className="field">
          <span className="field__label">Fallback image</span>
          <Select
            disabled={readOnly}
            value={configuration.fallbackImageAssetId ?? ""}
            onChange={(event) =>
              set("fallbackImageAssetId", event.target.value || undefined)
            }
          >
            <option value="">None</option>
            {images.data?.items?.map((image) => (
              <option key={image.id} value={image.id}>
                {image.name}
              </option>
            ))}
          </Select>
        </label>
        {save.error && (
          <div className="notice notice--error">{save.error.message}</div>
        )}
        <footer>
          {!readOnly && (
            <button
              className="button button--primary"
              disabled={save.isPending || !name.trim()}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving…" : "Save Widget"}
            </button>
          )}
          <button className="button button--quiet" onClick={close}>
            Cancel
          </button>
        </footer>
      </section>
    </div>
  );
}
