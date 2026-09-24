import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("forms");
  return (
    <div className="grid gap-2 border-t border-border pt-3">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {t("palette.title")}
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
            title={t(meta.descriptionKey)}
          >
            <span className="text-xs font-medium">{t(meta.labelKey)}</span>
            <span className="text-left text-[0.7rem] font-normal text-muted-foreground">
              {t(meta.descriptionKey)}
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
}
