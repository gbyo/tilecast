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
import { EditorFrame, optionLabel } from "./shared";

const feedModeOptions = [
  { value: "auto", labelKey: "sources.live.feedAuto" },
  { value: "cap", labelKey: "sources.live.feedCap" },
  { value: "index", labelKey: "sources.live.feedIndex" },
] as const;

const severityOptions = [
  { value: "unknown", labelKey: "sources.live.severityUnknown" },
  { value: "minor", labelKey: "sources.live.severityMinor" },
  { value: "moderate", labelKey: "sources.live.severityModerate" },
  { value: "severe", labelKey: "sources.live.severitySevere" },
  { value: "extreme", labelKey: "sources.live.severityExtreme" },
] as const;

const aqiStandardOptions = [
  { value: "us", labelKey: "sources.live.aqiUs" },
  { value: "european", labelKey: "sources.live.aqiEuropean" },
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
  const queryClient = useQueryClient();
  const { t } = useTranslation(["content", "common"]);
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
  const feedModes = feedModeOptions.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));
  const severities = severityOptions.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));
  const aqiStandards = aqiStandardOptions.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));
  const titleKey =
    provider === "transit"
      ? "sources.live.transitTitle"
      : provider === "cap_alerts"
        ? "sources.live.capTitle"
        : "sources.live.airTitle";
  const frameKey =
    provider === "transit"
      ? "sources.live.transitDescription"
      : provider === "cap_alerts"
        ? "sources.live.capDescription"
        : "sources.live.airDescription";
  return (
    <EditorFrame
      title={t(
        dataSource ? "sources.live.editTitle" : "sources.live.createTitle",
        {
          provider: t(titleKey),
        },
      )}
      description={t(frameKey)}
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
              : t("sources.shared.saveDataSource")}
          </RheaButton>
        )
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="live-name">
            {t("sources.shared.name")}
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
            {t("sources.shared.description")}
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
                {t("sources.live.staticUrl")}
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
                {t("sources.live.tripUrl")}
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
                {t("sources.live.alertsUrl")}
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
                {t("sources.live.ianaTimezone")}
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
              {t("sources.live.stopIds")}
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
              {t("sources.live.routeIds")}
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
                {t("sources.live.capUrl")}
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
                {t("sources.live.feedMode")}
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
                  aria-label={t("sources.live.feedMode")}
                >
                  <SelectValue>
                    {optionLabel(
                      feedModes,
                      (configuration as CAPAlertsSourceConfig).feedMode,
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {feedModes.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </RheaSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="cap-language">
                {t("sources.live.preferredLanguage")}
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
                {t("sources.live.minimumSeverity")}
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
                  aria-label={t("sources.live.minimumSeverity")}
                >
                  <SelectValue>
                    {optionLabel(
                      severities,
                      (configuration as CAPAlertsSourceConfig).minimumSeverity,
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {severities.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </RheaSelect>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="cap-include-areas">
              {t("sources.live.includeAreas")}
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
              {t("sources.live.excludeAreas")}
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
                ["locationLabel", "sources.live.locationLabel", "text"],
                ["timezone", "sources.live.timezone", "text"],
                ["latitude", "sources.live.latitude", "number"],
                ["longitude", "sources.live.longitude", "number"],
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
                {t("sources.live.aqiStandard")}
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
                  aria-label={t("sources.live.aqiStandard")}
                >
                  <SelectValue>
                    {optionLabel(
                      aqiStandards,
                      (configuration as AirQualitySourceConfig).aqiStandard,
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {aqiStandards.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </RheaSelect>
            </Field>
          </div>
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">
              {t("sources.live.measurements")}
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
            <span>{t("sources.live.nonCommercial")}</span>
          </label>
          <FieldDescription>
            {t("sources.live.commercialNote")}
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
            ? t("sources.shared.loadingPreview")
            : t("sources.shared.previewRealData")}
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
                {t("sources.live.valuesCount", {
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
            {t(
              provider === "transit"
                ? "sources.live.suggestedTransit"
                : provider === "cap_alerts"
                  ? "sources.live.suggestedCap"
                  : "sources.live.suggestedAir",
            )}
          </AlertDescription>
        </Alert>
      )}
    </EditorFrame>
  );
}
