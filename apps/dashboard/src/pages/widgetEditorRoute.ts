/**
 * What the Widget editor route should show, decided from what it has
 * loaded. Pure, so every outcome is a plain value the page only renders.
 */
import type {
  Asset,
  ContentDefinitionCatalog,
  WidgetDefinition,
} from "@/api/types";
import { ApiError } from "@/api/client";
import {
  widgetAuthoring,
  type WidgetAuthoring,
} from "@/components/content/widget-editor/widgetAuthoring";

export type WidgetEditorRoute =
  | { kind: "gallery" }
  | { kind: "loading" }
  | { kind: "assetFailed"; error: unknown; notFound: boolean }
  | { kind: "catalogFailed" }
  | {
      kind: "unavailable";
      definition?: WidgetDefinition;
      authoring: WidgetAuthoring | null;
    }
  | { kind: "noPermission" }
  | {
      kind: "ready";
      definition: WidgetDefinition;
      authoring: Exclude<WidgetAuthoring, { kind: "unsupported" }>;
      asset?: Asset;
    };

export function resolveWidgetEditorRoute({
  id,
  providerParam,
  widget,
  definitions,
  canManage,
}: {
  id: string | undefined;
  providerParam: string | undefined;
  widget: {
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    data?: Asset;
  };
  definitions: {
    isLoading: boolean;
    isError: boolean;
    data?: ContentDefinitionCatalog;
  };
  canManage: boolean;
}): WidgetEditorRoute {
  if (!id && !providerParam) return { kind: "gallery" };
  if ((id && widget.isLoading) || definitions.isLoading)
    return { kind: "loading" };
  if (id && widget.isError)
    return {
      kind: "assetFailed",
      error: widget.error,
      notFound: widget.error instanceof ApiError && widget.error.status === 404,
    };
  if (definitions.isError || !definitions.data)
    return { kind: "catalogFailed" };

  const asset = id ? widget.data : undefined;
  const provider = providerParam ?? asset?.widget?.provider;
  const definition = definitions.data.widgets.find(
    (candidate) => candidate.id === provider,
  );
  const authoring = definition
    ? widgetAuthoring(definition, definitions.data)
    : null;
  if (!definition || !authoring || authoring.kind === "unsupported")
    return { kind: "unavailable", definition, authoring };
  // A viewer reaching a create route has nothing to edit.
  if (!asset && !canManage) return { kind: "noPermission" };
  return { kind: "ready", definition, authoring, asset };
}
