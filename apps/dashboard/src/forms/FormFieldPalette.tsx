import { Separator } from "../components/ui/separator";
import { Button } from "../components/ui/button";
import type { FormFieldControl } from "../api/types";
import { CONTROLS } from "./formSchema";

// FormFieldPalette lists the supported controls as accessible Add buttons. It intentionally uses
// no drag-and-drop dependency in this pass.
export function FormFieldPalette({
  onAdd,
  disabled,
}: {
  onAdd: (control: FormFieldControl) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-2 border-t border-border pt-3">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Add a field
      </h3>
      <Separator />
      <div className="grid grid-cols-2 gap-1">
        {CONTROLS.map((meta) => (
          <Button
            key={meta.control}
            type="button"
            variant="outline"
            size="sm"
            className="h-auto flex-col items-start gap-0.5 px-2.5 py-2"
            disabled={disabled}
            onClick={() => onAdd(meta.control)}
            title={meta.description}
          >
            <span className="text-xs font-medium">{meta.label}</span>
            <span className="text-left text-[0.7rem] font-normal text-muted-foreground">
              {meta.description}
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
}
