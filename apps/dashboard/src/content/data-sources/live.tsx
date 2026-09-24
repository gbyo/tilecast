import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { apiErrorMessage } from "../../i18n";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button as RheaButton } from "../../components/ui/button";
import { Checkbox as RheaCheckbox } from "../../components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import {
  Select as RheaSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Switch as RheaSwitch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import type {
  DataSourceDetail,
  TransitSourceConfig,
  CAPAlertsSourceConfig,
  AirQualitySourceConfig,
  TypedDatasetPayload,
} from "../../api/types";
import { providerLabel } from "../dataSourceProviderMeta";
import { EditorFrame, optionLabel } from "./shared";

const feedModeOptions = [
  { value: "auto", labelKey: "dataSources.live.feedModeAuto" },
  { value: "cap", labelKey: "dataSources.live.feedModeCap" },
  { value: "index", labelKey: "dataSources.live.feedModeIndex" },
] as const;

const severityOptions = [
  { value: "unknown", labelKey: "dataSources.live.severityUnknown" },
  { value: "minor", labelKey: "dataSources.live.severityMinor" },
  { value: "moderate", labelKey: "dataSources.live.severityModerate" },
  { value: "severe", labelKey: "dataSources.live.severitySevere" },
  { value: "extreme", labelKey: "dataSources.live.severityExtreme" },
] as const;

const aqiStandardOptions = [
  { value: "us", labelKey: "dataSources.options.usAqi" },
  { value: "european", labelKey: "dataSources.options.europeanAqi" },
] as const;

const pollutantOptions = [
  "pm2_5",
  "pm10",
  "ozone",
  "nitrogen_dioxide",
  "alder_pollen",
  "birch_pollen",
  "grass_pollen",
  "ragweed_pollen",
];

export type LiveProvider = "transit" | "cap_alerts" | "air_quality";
type LiveConfiguration =
  TransitSourceConfig | CAPAlertsSourceConfig | AirQualitySourceConfig;

function defaultLiveConfiguration(provider: LiveProvider): LiveConfiguration {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (provider === "transit")
    return {
      staticUrl: "https://",
      tripUpdatesUrl: "https://",
      serviceAlertsUrl: "",
      stopIds: [],
      routeIds: [],
      timezone,
      maximumDepartures: 40,
      realtimeRefreshSeconds: 60,
      staticRefreshHours: 24,
      stalenessLimitMinutes: 30,
    };
  if (provider === "cap_alerts")
    return {
      url: "https://",
      feedMode: "auto",
      preferredLanguage: "",
      minimumSeverity: "minor",
      includeAreaKeywords: [],
      excludeAreaKeywords: [],
      maximumAlerts: 50,
      refreshIntervalSeconds: 300,
      stalenessLimitHours: 24,
    };
  return {
    locationLabel: "",
    latitude: 0,
    longitude: 0,
    timezone,
    aqiStandard: "us",
    pollutants: ["pm2_5", "pm10", "ozone", "nitrogen_dioxide"],
    forecastHours: 48,
    nonCommercialAccepted: false,
    refreshIntervalSeconds: 3600,
    stalenessLimitHours: 24,
  };
}

export function LiveDataSourceEditor({
  provider,
  dataSource,
  csrf,
  readOnly = false,
  onClose,
  onSaved,
  page,
}: {
  provider: LiveProvider;
  dataSource?: DataSourceDetail;
  csrf: string;
  readOnly?: boolean;
  onClose: () => void;
  onSaved: (dataSource: DataSourceDetail) => void;
  page?: boolean;
}) {
  const { t } = useTranslation(["content", "common"]);
  const queryClient = useQueryClient();
  const [name, setName] = useState(dataSource?.name ?? "");
  const [description, setDescription] = useState(dataSource?.description ?? "");
  const [configuration, setConfiguration] = useState<LiveConfiguration>(
    (dataSource?.configuration as LiveConfiguration | undefined) ??
      defaultLiveConfiguration(provider),
  );
  const [preview, setPreview] = useState<TypedDatasetPayload>();
  const previewMutation = useMutation({
    mutationFn: () =>
      api.previewDataSource(
        provider,
        configuration,
        csrf,
      ) as unknown as Promise<TypedDatasetPayload>,
    onSuccess: setPreview,
  });
  const save = useMutation({
    mutationFn: () => {
      const input = { provider, name, description, configuration };
      return dataSource
        ? api.updateDataSource(dataSource.id, input, csrf)
        : api.createDataSource(input, csrf);
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ["data-sources"] });
      onSaved(saved);
    },
  });
  const patch = (values: Partial<LiveConfiguration>) =>
    setConfiguration((current) => ({ ...current, ...values }));
  return (
    <EditorFrame
      title={t(
        dataSource
          ? "dataSources.live.titleEdit"
          : "dataSources.live.titleCreate",
        { provider: providerLabel(provider, t) },
      )}
      description={t(
        provider === "transit"
          ? "dataSources.live.descriptionTransit"
          : provider === "cap_alerts"
            ? "dataSources.live.descriptionCapAlerts"
            : "dataSources.live.descriptionAirQuality",
      )}
      page={page}
      onClose={onClose}
      footer={
        !readOnly && (
          <RheaButton
            type="button"
            disabled={save.isPending || !name.trim()}
            onClick={() => save.mutate()}
          >
            {save.isPending
              ? t("common:actions.saving")
              : t("dataSources.editor.save")}
          </RheaButton>
        )
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="live-name">
            {t("dataSources.editor.name")}
          </FieldLabel>
          <Input
            id="live-name"
            value={name}
            disabled={readOnly}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="live-description">
            {t("dataSources.editor.description")}
          </FieldLabel>
          <Input
            id="live-description"
            value={description}
            disabled={readOnly}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
      </div>
      {provider === "transit" && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="transit-static-url">
                {t("dataSources.live.staticUrl")}
              </FieldLabel>
              <Input
                id="transit-static-url"
                value={(configuration as TransitSourceConfig).staticUrl}
                disabled={readOnly}
                onChange={(event) => patch({ staticUrl: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="transit-trip-url">
                {t("dataSources.live.tripUpdatesUrl")}
              </FieldLabel>
              <Input
                id="transit-trip-url"
                value={(configuration as TransitSourceConfig).tripUpdatesUrl}
                disabled={readOnly}
                onChange={(event) =>
                  patch({ tripUpdatesUrl: event.target.value })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="transit-alerts-url">
                {t("dataSources.live.serviceAlertsUrl")}
              </FieldLabel>
              <Input
                id="transit-alerts-url"
                value={
                  (configuration as TransitSourceConfig).serviceAlertsUrl ?? ""
                }
                disabled={readOnly}
                onChange={(event) =>
                  patch({ serviceAlertsUrl: event.target.value })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="transit-timezone">
                {t("dataSources.editor.ianaTimezone")}
              </FieldLabel>
              <Input
                id="transit-timezone"
                value={(configuration as TransitSourceConfig).timezone}
                disabled={readOnly}
                onChange={(event) => patch({ timezone: event.target.value })}
              />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="transit-stop-ids">
              {t("dataSources.live.stopIds")}
            </FieldLabel>
            <Textarea
              id="transit-stop-ids"
              value={(configuration as TransitSourceConfig).stopIds.join("\n")}
              disabled={readOnly}
              onChange={(event) =>
                patch({
                  stopIds: event.target.value
                    .split(/[\n,]/)
                    .map((value) => value.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="transit-route-ids">
              {t("dataSources.live.routeIds")}
            </FieldLabel>
            <Input
              id="transit-route-ids"
              value={
                (configuration as TransitSourceConfig).routeIds?.join(", ") ??
                ""
              }
              disabled={readOnly}
              onChange={(event) =>
                patch({
                  routeIds: event.target.value
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
        </>
      )}
      {provider === "cap_alerts" && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="cap-url">
                {t("dataSources.live.capUrl")}
              </FieldLabel>
              <Input
                id="cap-url"
                value={(configuration as CAPAlertsSourceConfig).url}
                disabled={readOnly}
                onChange={(event) => patch({ url: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="cap-feed-mode">
                {t("dataSources.live.feedMode")}
              </FieldLabel>
              <RheaSelect
                value={(configuration as CAPAlertsSourceConfig).feedMode}
                disabled={readOnly}
                onValueChange={(next) =>
                  patch({
                    feedMode: next as CAPAlertsSourceConfig["feedMode"],
                  })
                }
              >
                <SelectTrigger
                  id="cap-feed-mode"
                  aria-label={t("dataSources.live.feedMode")}
                >
                  <SelectValue>
                    {optionLabel(
                      feedModeOptions.map((option) => ({
                        value: option.value,
                        label: t(option.labelKey),
                      })),
                      (configuration as CAPAlertsSourceConfig).feedMode,
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {feedModeOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </RheaSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="cap-language">
                {t("dataSources.live.preferredLanguage")}
              </FieldLabel>
              <Input
                id="cap-language"
                placeholder="en-US"
                value={
                  (configuration as CAPAlertsSourceConfig).preferredLanguage ??
                  ""
                }
                disabled={readOnly}
                onChange={(event) =>
                  patch({ preferredLanguage: event.target.value })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="cap-severity">
                {t("dataSources.live.minimumSeverity")}
              </FieldLabel>
              <RheaSelect
                value={(configuration as CAPAlertsSourceConfig).minimumSeverity}
                disabled={readOnly}
                onValueChange={(next) =>
                  patch({
                    minimumSeverity:
                      next as CAPAlertsSourceConfig["minimumSeverity"],
                  })
                }
              >
                <SelectTrigger
                  id="cap-severity"
                  aria-label={t("dataSources.live.minimumSeverity")}
                >
                  <SelectValue>
                    {optionLabel(
                      severityOptions.map((option) => ({
                        value: option.value,
                        label: t(option.labelKey),
                      })),
                      (configuration as CAPAlertsSourceConfig).minimumSeverity,
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {severityOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </RheaSelect>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="cap-include-areas">
              {t("dataSources.live.includeAreas")}
            </FieldLabel>
            <Input
              id="cap-include-areas"
              value={
                (
                  configuration as CAPAlertsSourceConfig
                ).includeAreaKeywords?.join(", ") ?? ""
              }
              disabled={readOnly}
              onChange={(event) =>
                patch({
                  includeAreaKeywords: event.target.value
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="cap-exclude-areas">
              {t("dataSources.live.excludeAreas")}
            </FieldLabel>
            <Input
              id="cap-exclude-areas"
              value={
                (
                  configuration as CAPAlertsSourceConfig
                ).excludeAreaKeywords?.join(", ") ?? ""
              }
              disabled={readOnly}
              onChange={(event) =>
                patch({
                  excludeAreaKeywords: event.target.value
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
        </>
      )}
      {provider === "air_quality" && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {(
              [
                ["locationLabel", "dataSources.weather.locationLabel", "text"],
                ["timezone", "dataSources.editor.ianaTimezone", "text"],
                ["latitude", "dataSources.weather.latitude", "number"],
                ["longitude", "dataSources.weather.longitude", "number"],
              ] as const
            ).map(([key, labelKey, type]) => (
              <Field key={key}>
                <FieldLabel htmlFor={`air-quality-${key}`}>
                  {t(labelKey)}
                </FieldLabel>
                <Input
                  id={`air-quality-${key}`}
                  type={type}
                  step={type === "number" ? "0.0001" : undefined}
                  value={
                    (
                      configuration as unknown as Record<
                        string,
                        string | number
                      >
                    )[key]
                  }
                  disabled={readOnly}
                  onChange={(event) =>
                    patch({
                      [key]:
                        type === "number"
                          ? Number(event.target.value)
                          : event.target.value,
                    })
                  }
                />
              </Field>
            ))}
            <Field>
              <FieldLabel htmlFor="air-quality-standard">
                {t("dataSources.live.aqiStandard")}
              </FieldLabel>
              <RheaSelect
                value={(configuration as AirQualitySourceConfig).aqiStandard}
                disabled={readOnly}
                onValueChange={(next) =>
                  patch({
                    aqiStandard: next as AirQualitySourceConfig["aqiStandard"],
                  })
                }
              >
                <SelectTrigger
                  id="air-quality-standard"
                  aria-label={t("dataSources.live.aqiStandard")}
                >
                  <SelectValue>
                    {optionLabel(
                      aqiStandardOptions.map((option) => ({
                        value: option.value,
                        label: t(option.labelKey),
                      })),
                      (configuration as AirQualitySourceConfig).aqiStandard,
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {aqiStandardOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </RheaSelect>
            </Field>
          </div>
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">
              {t("dataSources.live.measurements")}
            </legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {pollutantOptions.map((pollutant) => (
                // The wrapping label names the checkbox; no extra aria-label.
                <label
                  key={pollutant}
                  className="flex items-center gap-2 text-sm"
                >
                  <RheaCheckbox
                    checked={(
                      configuration as AirQualitySourceConfig
                    ).pollutants.includes(pollutant)}
                    disabled={readOnly}
                    onCheckedChange={(checked) => {
                      const values = (configuration as AirQualitySourceConfig)
                        .pollutants;
                      patch({
                        pollutants:
                          checked === true
                            ? [...values, pollutant]
                            : values.filter((value) => value !== pollutant),
                      });
                    }}
                  />
                  <span>{pollutant.replaceAll("_", " ").toUpperCase()}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {/* The wrapping label names the switch; no extra aria-label. */}
          <label className="flex items-center gap-2 text-sm">
            <RheaSwitch
              checked={
                (configuration as AirQualitySourceConfig).nonCommercialAccepted
              }
              disabled={readOnly}
              onCheckedChange={(checked) =>
                patch({ nonCommercialAccepted: checked === true })
              }
            />
            <span>{t("dataSources.live.nonCommercial")}</span>
          </label>
          <FieldDescription>
            {t("dataSources.live.commercialHint")}
          </FieldDescription>
        </>
      )}
      {!readOnly && (
        <RheaButton
          type="button"
          variant="outline"
          disabled={previewMutation.isPending}
          onClick={() => previewMutation.mutate()}
        >
          {previewMutation.isPending
            ? t("dataSources.preview.loading")
            : t("dataSources.preview.realData")}
        </RheaButton>
      )}
      {preview && (
        <div className="grid gap-2">
          {preview.datasets.map((dataset) => (
            <div
              key={dataset.id}
              className="grid gap-0.5 rounded-lg border p-3"
            >
              <strong className="text-sm">{dataset.id}</strong>
              <span className="text-sm text-muted-foreground">
                {t("dataSources.live.previewValues", {
                  count:
                    dataset.records?.length ??
                    dataset.points?.length ??
                    Object.keys(dataset.values ?? {}).length,
                })}
              </span>
              {dataset.attribution && (
                <small className="text-xs text-muted-foreground">
                  {dataset.attribution}
                </small>
              )}
            </div>
          ))}
        </div>
      )}
      {(save.error || previewMutation.error) && (
        <Alert variant="destructive">
          <AlertDescription>
            {apiErrorMessage(save.error ?? previewMutation.error)}
          </AlertDescription>
        </Alert>
      )}
      {dataSource && (
        <Alert>
          <AlertDescription>
            {t("dataSources.live.suggestedWidgets", {
              suggestions: t(
                provider === "transit"
                  ? "dataSources.live.suggestionsTransit"
                  : provider === "cap_alerts"
                    ? "dataSources.live.suggestionsCapAlerts"
                    : "dataSources.live.suggestionsAirQuality",
              ),
            })}
          </AlertDescription>
        </Alert>
      )}
    </EditorFrame>
  );
}
