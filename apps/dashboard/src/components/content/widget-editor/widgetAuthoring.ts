/**
 * The Studio side of the Widget authoring contract (docs/widget-authoring.md).
 *
 * Studio has one Widget editor. A definition either describes itself well
 * enough for that editor or it is unsupported; there is no per-provider
 * editor to fall back to. The Server enforces the same contract over the
 * shipped catalog (contentdefs.AuthoringProblem).
 */
import type { ContentDefinitionCatalog, WidgetDefinition } from "@/api/types";
import {
  studioPreviewComponent,
  type StudioPreviewComponent,
} from "@/content/studioWidgets";

export type WidgetAuthoring =
  | {
      /** Renders through its real component, the one the Player mounts. */
      readonly kind: "component";
      readonly component: StudioPreviewComponent;
    }
  | {
      /** A remote web integration: previewed through a sandboxed frame. */
      readonly kind: "web";
      readonly urlField: string;
    }
  | {
      readonly kind: "unsupported";
      readonly reason: "unavailable" | "component" | "schema";
    };

export function widgetAuthoring(
  definition: WidgetDefinition,
  catalog: ContentDefinitionCatalog | undefined,
): WidgetAuthoring {
  if (definition.availability?.enabled === false)
    return { kind: "unsupported", reason: "unavailable" };
  if (definition.runtime === "web") {
    const urlField = definition.webIntegration?.urlField ?? "url";
    const declared = definition.configurationSchema.fields.some(
      (field) => field.key === urlField,
    );
    return declared
      ? { kind: "web", urlField }
      : { kind: "unsupported", reason: "schema" };
  }
  // A native definition without a previewable component cannot be
  // previewed or authored; the catalog would be invalid, and Studio says
  // so. Package-source Widgets author against the same draft contract
  // and preview through the sandbox executor.
  const component = definition.component
    ? studioPreviewComponent(catalog, definition.id)
    : null;
  return component
    ? { kind: "component", component }
    : { kind: "unsupported", reason: "component" };
}

/**
 * Whether a definition describes itself well enough for the editor at all:
 * a native Widget names its component, a web integration declares its
 * address field. The gallery hides definitions that do not, instead of
 * offering a type that could only open as unavailable.
 */
export function describesAuthoring(definition: WidgetDefinition): boolean {
  if (definition.runtime === "web") {
    const urlField = definition.webIntegration?.urlField ?? "url";
    return definition.configurationSchema.fields.some(
      (field) => field.key === urlField,
    );
  }
  return Boolean(definition.component);
}

/** The definition declares that its result depends on the current instant. */
export function previewsTime(definition: WidgetDefinition): boolean {
  return definition.authoring?.preview?.time === true;
}
