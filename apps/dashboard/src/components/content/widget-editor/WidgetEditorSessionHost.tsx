import type { Asset, WidgetDefinition } from "@/api/types";
import { useWidgetEditorSession } from "./useWidgetEditorSession";
import type { WidgetAuthoring } from "./widgetAuthoring";
import { WidgetEditorWorkspace } from "./WidgetEditorWorkspace";

/**
 * Owns one authoring session. The route keys it by Widget, so opening a
 * different Widget or a new type starts a fresh draft.
 */
export function WidgetEditorSessionHost({
  definition,
  authoring,
  asset,
  csrf,
  canManage,
  returnTo,
  createdHere,
}: {
  definition: WidgetDefinition;
  authoring: Exclude<WidgetAuthoring, { kind: "unsupported" }>;
  asset?: Asset;
  csrf: string;
  canManage: boolean;
  returnTo: string | null;
  createdHere: boolean;
}) {
  const session = useWidgetEditorSession({
    definition,
    authoring,
    asset,
    csrf,
    readOnly: !canManage,
    returnTo,
    createdHere,
  });
  return (
    <WidgetEditorWorkspace
      session={session}
      csrf={csrf}
      canManage={canManage}
    />
  );
}
