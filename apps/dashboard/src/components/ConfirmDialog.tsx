import { useCallback, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNativeAlert } from "../native-host/useNativeAlert";
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
 *
 * In the iOS app the confirmation is a native alert, so every call site
 * gets it with no change. A request whose body is not plain text, and a
 * host that cannot show the alert, use the web dialog.
 */
export function useConfirm() {
  const { t } = useTranslation("common");
  const [pending, setPending] = useState<{
    request: ConfirmRequest;
    resolve: (value: boolean) => void;
  } | null>(null);

  const presentNativeAlert = useNativeAlert();

  const confirm = useCallback(
    async (request: ConfirmRequest) => {
      if (request.body === undefined || typeof request.body === "string") {
        const chosen = await presentNativeAlert({
          title: request.title,
          ...(request.body ? { message: request.body } : {}),
          actions: [
            { id: "cancel", label: t("actions.cancel"), role: "cancel" },
            {
              id: "confirm",
              label: request.action ?? t("actions.confirm"),
              role: request.destructive ? "destructive" : "default",
            },
          ],
        });
        if (chosen !== null) return chosen === "confirm";
      }
      return new Promise<boolean>((resolve) => {
        setPending({ request, resolve });
      });
    },
    [presentNativeAlert, t],
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
