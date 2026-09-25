import type { DataSourceDefinition } from "../api/types";

export function initialDataSourceConfiguration(
  definition: Pick<DataSourceDefinition, "id" | "defaultConfiguration">,
  currentYear = new Date().getFullYear(),
): Record<string, unknown> {
  const configuration = { ...definition.defaultConfiguration };
  if (definition.id === "public-holidays") configuration.year = currentYear;
  return configuration;
}
