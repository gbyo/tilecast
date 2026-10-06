import { useTranslation } from "react-i18next";
import type { Asset } from "@/api/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";

/** Confirms deleting the Widget. A Widget something still shows cannot be deleted. */
export function DeleteWidgetDialog({
  asset,
  usage,
  pending,
  open,
  onOpenChange,
  onConfirm,
}: {
  asset: Asset;
  usage: number;
  pending: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation("content");
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("widgets.editor.delete.title", { name: asset.name })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {usage > 0
              ? t("widgets.editor.delete.inUse", { count: usage })
              : t("widgets.editor.delete.body")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            {t("widgets.editor.delete.keep")}
          </AlertDialogCancel>
          {usage === 0 && (
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              disabled={pending}
              onClick={onConfirm}
            >
              {t("widgets.editor.delete.confirm")}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
