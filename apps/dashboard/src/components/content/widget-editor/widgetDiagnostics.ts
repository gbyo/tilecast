/**
 * Which runtime diagnostics, if any, a Widget can report. This is a narrow
 * capability and never owns any part of editing.
 */
import type { Asset, WidgetDefinition } from "@/api/types";

export type WidgetDiagnosticsKind = "website" | "managedSource";

// Website Widgets report player load results through their own endpoint.
const providerDiagnostics: Record<string, WidgetDiagnosticsKind> = {
  website: "website",
};

export function widgetDiagnosticsKind(
  definition: WidgetDefinition,
  asset: Asset | undefined,
): WidgetDiagnosticsKind | null {
  if (!asset) return null;
  if (providerDiagnostics[definition.id])
    return providerDiagnostics[definition.id]!;
  if (definition.recipe && asset.widget?.managedDataSourceId)
    return "managedSource";
  return null;
}
