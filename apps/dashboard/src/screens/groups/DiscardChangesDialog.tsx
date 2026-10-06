import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";

/** The one "you have unsaved work" prompt shared by every guarded exit. */
export function DiscardChangesDialog({
  open,
  title,
  description,
  onKeepEditing,
  onDiscard,
}: {
  open: boolean;
  title: string;
  description: string;
  onKeepEditing: () => void;
  onDiscard: () => void;
}) {
  const { t } = useTranslation("screens");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onKeepEditing();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onKeepEditing}>
            {t("groups.detail.keepEditing")}
          </Button>
          <Button variant="destructive" onClick={onDiscard}>
            {t("groups.detail.discardAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
