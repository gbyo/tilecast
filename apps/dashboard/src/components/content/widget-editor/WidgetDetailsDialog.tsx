import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { widgetDetailLimits } from "./widgetEditorModel";
import type { WidgetEditorSession } from "./useWidgetEditorSession";

/**
 * The Widget's name and description. Apply changes the draft only; like
 * every other change, they reach the Server with Save changes.
 */
export function WidgetDetailsDialog({
  session,
}: {
  session: WidgetEditorSession;
}) {
  const { t } = useTranslation(["content", "common"]);
  const open = session.detailsOpen;
  const [name, setName] = useState(session.draft.name);
  const [description, setDescription] = useState(session.draft.description);
  useEffect(() => {
    if (!open) return;
    setName(session.draft.name);
    setDescription(session.draft.description);
    // Start from the draft each time the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const nameId = useId();
  const descriptionId = useId();
  const trimmed = name.trim();
  const nameProblem = !trimmed
    ? t("widgets.editor.validation.nameRequired")
    : trimmed.length > widgetDetailLimits.name
      ? t("widgets.editor.validation.tooLong", {
          count: widgetDetailLimits.name,
        })
      : undefined;
  const showNameProblem =
    Boolean(nameProblem) && (session.revealed || name !== session.draft.name);
  const readOnly = session.readOnly;
  const apply = () => {
    if (nameProblem) return;
    session.updateDetails({ name, description });
    session.setDetailsOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={session.setDetailsOpen}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("widgets.editor.details.title")}</DialogTitle>
            <DialogDescription>
              {readOnly
                ? t("widgets.editor.details.readOnly")
                : t("widgets.editor.details.description")}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-4">
            <Field data-invalid={showNameProblem ? true : undefined}>
              <FieldLabel htmlFor={nameId}>
                {t("widgets.editor.details.name")}
              </FieldLabel>
              <Input
                id={nameId}
                value={name}
                disabled={readOnly}
                required
                maxLength={widgetDetailLimits.name}
                aria-invalid={showNameProblem ? true : undefined}
                aria-describedby={
                  showNameProblem ? `${nameId}-error` : undefined
                }
                autoFocus={!readOnly}
                onChange={(event) => setName(event.target.value)}
              />
              {showNameProblem && (
                <FieldError id={`${nameId}-error`}>{nameProblem}</FieldError>
              )}
            </Field>
            <Field>
              <FieldLabel htmlFor={descriptionId}>
                {t("widgets.editor.details.descriptionLabel")}
              </FieldLabel>
              <Textarea
                id={descriptionId}
                value={description}
                disabled={readOnly}
                maxLength={widgetDetailLimits.description}
                aria-describedby={`${descriptionId}-hint`}
                onChange={(event) => setDescription(event.target.value)}
              />
              <FieldDescription id={`${descriptionId}-hint`}>
                {t("widgets.editor.details.descriptionHint")}
              </FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              {readOnly
                ? t("common:actions.close")
                : t("common:actions.cancel")}
            </DialogClose>
            {!readOnly && (
              <Button type="submit" disabled={Boolean(nameProblem)}>
                {t("widgets.editor.details.apply")}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
