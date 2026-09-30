import type { ReactNode } from "react";
import { Button } from "../components/ui/button";

// Shared persistent save treatment for page-mode custom Widget editors
// (website, YouTube), mirroring the V2 editor header: a dirty indicator
// plus Save, reachable without scrolling to the end of the form. The close
// affordance stays with each editor's own header.
export function EditorHeaderActions({
  dirty,
  dirtyLabel,
  onSave,
  saveDisabled = false,
  saveLabel,
}: {
  dirty: boolean;
  dirtyLabel: string;
  onSave: () => void;
  saveDisabled?: boolean;
  saveLabel: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {dirty && (
        <span className="text-sm text-muted-foreground">{dirtyLabel}</span>
      )}
      <Button type="button" disabled={saveDisabled} onClick={onSave}>
        {saveLabel}
      </Button>
    </div>
  );
}
