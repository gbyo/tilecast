import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { WidgetEditorSession } from "../useWidgetEditorSession";
import { originOf } from "./headerModel";

/** Back: returns to where the author came from, through the unsaved-changes check. */
export function WidgetHeaderNavigation({
  session,
}: {
  session: WidgetEditorSession;
}) {
  const { t } = useTranslation("content");
  const origin = originOf(session.returnTo);
  const label = origin
    ? t(`widgets.editor.back.${origin}`)
    : session.returnTo
      ? t("widgets.editor.back.previous")
      : t("widgets.editor.back.widgets");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            onClick={session.close}
          />
        }
      >
        <ArrowLeft aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
