import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import type { DataSourceDetail, DataSourceProvider } from "../../api/types";
import { GenericDataSourceEditor } from "../GenericDefinitionEditors";
import { CalendarDataSourceEditor } from "./calendar";
import { LiveDataSourceEditor, type LiveProvider } from "./live";
import { ManualDataSourceEditor } from "./manual";
import { StructuredDataSourceEditor } from "./structured";
import { WeatherDataSourceEditor } from "./weather";
import { legacyDataSourceProviders } from "./shared";
import type { StructuredProvider } from "./structured";

export function DataSourceEditor({
  provider,
  dataSource,
  csrf,
  readOnly,
  onClose,
  onSaved,
  page,
}: {
  provider: DataSourceProvider;
  dataSource?: DataSourceDetail;
  csrf: string;
  readOnly?: boolean;
  onClose: () => void;
  onSaved: (dataSource: DataSourceDetail) => void;
  page?: boolean;
}) {
  const definitions = useQuery({
    queryKey: ["content-definitions"],
    queryFn: api.contentDefinitions,
  });
  const { t } = useTranslation("content");
  const definition = definitions.data?.dataSources?.find(
    (candidate) => candidate.id === provider,
  );
  // Release-defined providers are anything the legacy editors below do not handle. Wait for
  // the catalog before routing them, so a new definition renders through the generic editor
  // without a hardcoded provider check here.
  if (!legacyDataSourceProviders.has(provider) && definitions.isLoading)
    return (
      <div className="table-loading">
        {t("sources.dispatcher.loadingDefinition")}
      </div>
    );
  if (definition && !definition.legacyEditor)
    return (
      <GenericDataSourceEditor
        definition={definition}
        dataSource={dataSource}
        csrf={csrf}
        readOnly={readOnly}
        onClose={onClose}
        onSaved={onSaved}
      />
    );
  if (provider === "manual")
    return (
      <ManualDataSourceEditor
        dataSource={dataSource}
        csrf={csrf}
        readOnly={readOnly}
        onClose={onClose}
        onSaved={onSaved}
        page={page}
      />
    );
  if (provider === "weather")
    return (
      <WeatherDataSourceEditor
        dataSource={dataSource}
        csrf={csrf}
        readOnly={readOnly}
        onClose={onClose}
        onSaved={onSaved}
        page={page}
      />
    );
  if (provider === "calendar")
    return (
      <CalendarDataSourceEditor
        dataSource={dataSource}
        csrf={csrf}
        readOnly={readOnly}
        onClose={onClose}
        onSaved={onSaved}
        page={page}
      />
    );
  if (
    provider === "transit" ||
    provider === "cap_alerts" ||
    provider === "air_quality"
  )
    return (
      <LiveDataSourceEditor
        provider={provider as LiveProvider}
        dataSource={dataSource}
        csrf={csrf}
        readOnly={readOnly}
        onClose={onClose}
        onSaved={onSaved}
        page={page}
      />
    );
  return (
    <StructuredDataSourceEditor
      provider={provider as StructuredProvider}
      dataSource={dataSource}
      csrf={csrf}
      readOnly={readOnly}
      onClose={onClose}
      onSaved={onSaved}
      page={page}
    />
  );
}
