import { useCallback, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { buttonVariants } from "./ui/button";

export type ConfirmRequest = {
  title: string;
  body?: ReactNode;
  action?: string;
  destructive?: boolean;
};

/**
 * Base UI replacement for window.confirm. Awaiting the returned promise keeps
 * the call site reading like the synchronous version without blocking the
 * browser chrome. Render the returned dialog next to the confirming UI.
 */
export function useConfirm() {
  const { t } = useTranslation("common");
  const [pending, setPending] = useState<{
    request: ConfirmRequest;
    resolve: (value: boolean) => void;
  } | null>(null);

  const confirm = useCallback(
    (request: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        setPending({ request, resolve });
      }),
    [],
  );

  const settle = useCallback((value: boolean) => {
    setPending((current) => {
      current?.resolve(value);
      return null;
    });
  }, []);

  const dialog = (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{pending?.request.title}</AlertDialogTitle>
          {pending?.request.body ? (
            <AlertDialogDescription>
              {pending.request.body}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => settle(false)}>
            {t("actions.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            className={
              pending?.request.destructive
                ? buttonVariants({ variant: "destructive" })
                : undefined
            }
            onClick={() => settle(true)}
          >
            {pending?.request.action ?? t("actions.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { confirm, dialog };
}
