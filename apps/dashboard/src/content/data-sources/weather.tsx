import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { toast } from "../../components/ui/toast";
import { apiErrorMessage } from "../../i18n";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Field, FieldDescription, FieldLabel } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import type {
  DataSourceDetail,
  TypedRecordData,
  WeatherSourceConfig,
} from "../../api/types";
import { EditorFrame, optionLabel } from "./shared";

const weatherUnitOptions = [
  { value: "imperial", labelKey: "dataSources.options.imperial" },
  { value: "metric", labelKey: "dataSources.options.metric" },
] as const;

export function WeatherDataSourceEditor({
  dataSource,
  csrf,
  readOnly = false,
  onClose,
  onSaved,
  page,
}: {
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
  const [configuration, setConfiguration] = useState<WeatherSourceConfig>(
    (dataSource?.configuration as WeatherSourceConfig | undefined) ?? {
      locationLabel: "",
      latitude: 0,
      longitude: 0,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      units: "imperial",
      forecastDays: 5,
      contact: "",
      refreshIntervalSeconds: 1800,
      stalenessLimitHours: 24,
    },
  );
  const [preview, setPreview] = useState<TypedRecordData>();
  const previewMutation = useMutation({
    mutationFn: () =>
      api.previewDataSource(
        "weather",
        configuration,
        csrf,
      ) as unknown as Promise<TypedRecordData>,
    onSuccess: setPreview,
  });
  const save = useMutation({
    mutationFn: () => {
      const input = {
        provider: "weather" as const,
        name,
        description,
        configuration,
      };
      return dataSource
        ? api.updateDataSource(dataSource.id, input, csrf)
        : api.createDataSource(input, csrf);
    },
    onSuccess: (saved) => {
      toast.add({
        title: dataSource ? "Data Source updated." : "Data Source created.",
        type: "success",
      });
      void queryClient.invalidateQueries({ queryKey: ["data-sources"] });
      onSaved(saved);
    },
  });
  const set = <K extends keyof WeatherSourceConfig>(
    key: K,
    value: WeatherSourceConfig[K],
  ) => setConfiguration((current) => ({ ...current, [key]: value }));
  return (
    <EditorFrame
      title={
        dataSource
          ? t("dataSources.weather.titleEdit")
          : t("dataSources.weather.titleCreate")
      }
      description={t("dataSources.weather.description")}
      page={page}
      onClose={onClose}
      footer={
        !readOnly && (
          <Button
            type="button"
            disabled={save.isPending || !name.trim()}
            onClick={() => save.mutate()}
          >
            {save.isPending
              ? t("common:actions.saving")
              : t("dataSources.editor.save")}
          </Button>
        )
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="weather-name">
            {t("dataSources.editor.name")}
          </FieldLabel>
          <Input
            id="weather-name"
            value={name}
            disabled={readOnly}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="weather-description">
            {t("dataSources.editor.description")}
          </FieldLabel>
          <Input
            id="weather-description"
            value={description}
            disabled={readOnly}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="weather-location">
            {t("dataSources.weather.locationLabel")}
          </FieldLabel>
          <Input
            id="weather-location"
            value={configuration.locationLabel}
            disabled={readOnly}
            onChange={(event) => set("locationLabel", event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="weather-timezone">
            {t("dataSources.editor.timezone")}
          </FieldLabel>
          <Input
            id="weather-timezone"
            value={configuration.timezone}
            disabled={readOnly}
            onChange={(event) => set("timezone", event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="weather-latitude">
            {t("dataSources.weather.latitude")}
          </FieldLabel>
          <Input
            id="weather-latitude"
            type="number"
            step="0.0001"
            value={configuration.latitude}
            disabled={readOnly}
            onChange={(event) => set("latitude", Number(event.target.value))}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="weather-longitude">
            {t("dataSources.weather.longitude")}
          </FieldLabel>
          <Input
            id="weather-longitude"
            type="number"
            step="0.0001"
            value={configuration.longitude}
            disabled={readOnly}
            onChange={(event) => set("longitude", Number(event.target.value))}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="weather-units">
            {t("dataSources.weather.units")}
          </FieldLabel>
          <Select
            value={configuration.units}
            disabled={readOnly}
            onValueChange={(next) =>
              set("units", next as WeatherSourceConfig["units"])
            }
            items={weatherUnitOptions.map((option) => ({
              value: option.value,
              label: t(option.labelKey),
            }))}
          >
            <SelectTrigger
              id="weather-units"
              aria-label={t("dataSources.weather.units")}
            >
              <SelectValue>
                {optionLabel(
                  weatherUnitOptions.map((option) => ({
                    value: option.value,
                    label: t(option.labelKey),
                  })),
                  configuration.units,
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {weatherUnitOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="weather-forecast-days">
            {t("dataSources.weather.forecastDays")}
          </FieldLabel>
          <Input
            id="weather-forecast-days"
            type="number"
            min={1}
            max={7}
            value={configuration.forecastDays}
            disabled={readOnly}
            onChange={(event) =>
              set("forecastDays", Number(event.target.value))
            }
          />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="weather-contact">
          {t("dataSources.weather.contact")}
        </FieldLabel>
        <Input
          id="weather-contact"
          value={configuration.contact}
          disabled={readOnly}
          onChange={(event) => set("contact", event.target.value)}
        />
        <FieldDescription>
          {t("dataSources.weather.contactHint")}
        </FieldDescription>
      </Field>
      {!readOnly && (
        <Button
          type="button"
          variant="outline"
          disabled={previewMutation.isPending}
          onClick={() => previewMutation.mutate()}
        >
          {previewMutation.isPending
            ? t("common:status.loading")
            : t("dataSources.preview.forecast")}
        </Button>
      )}
      {preview && (
        <div className="grid gap-2">
          {preview.records.slice(0, 4).map((record) => (
            <div key={record.id} className="grid gap-0.5 rounded-lg border p-3">
              <strong className="text-sm">
                {record.values.date ?? t("dataSources.weather.current")}
              </strong>
              <span className="text-sm text-muted-foreground">
                {record.values.condition}{" "}
                {record.values.temperature
                  ? `${record.values.temperature}${record.values.temperatureUnit}`
                  : `${record.values.high}${record.values.temperatureUnit} / ${record.values.low}${record.values.temperatureUnit}`}
              </span>
            </div>
          ))}
          <small className="text-xs text-muted-foreground">
            {preview.attribution}
          </small>
        </div>
      )}
      {(save.error || previewMutation.error) && (
        <Alert variant="destructive">
          <AlertDescription>
            {apiErrorMessage(save.error ?? previewMutation.error)}
          </AlertDescription>
        </Alert>
      )}
    </EditorFrame>
  );
}
