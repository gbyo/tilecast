import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
  /** The dismissing choice. "Cancel" by default. */
  cancel?: string;
  destructive?: boolean;
};

type PendingConfirmation = {
  request: ConfirmRequest;
  resolve: (value: boolean) => void;
  present: () => Promise<string | null>;
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
  const [queue, setQueue] = useState<PendingConfirmation[]>([]);
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const outstanding = useRef(new Set<PendingConfirmation>());
  const mounted = useRef(false);

  const presentNativeAlert = useNativeAlert();

  const confirm = useCallback(
    (request: ConfirmRequest) => {
      if (!mounted.current) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        const entry: PendingConfirmation = {
          request,
          resolve,
          present: () =>
            request.body === undefined || typeof request.body === "string"
              ? presentNativeAlert({
                  title: request.title,
                  ...(request.body ? { message: request.body } : {}),
                  actions: [
                    {
                      id: "cancel",
                      label: request.cancel ?? t("actions.cancel"),
                      role: "cancel",
                    },
                    {
                      id: "confirm",
                      label: request.action ?? t("actions.confirm"),
                      role: request.destructive ? "destructive" : "default",
                    },
                  ],
                })
              : Promise.resolve(null),
        };
        outstanding.current.add(entry);
        setQueue((current) => [...current, entry]);
      });
    },
    [presentNativeAlert, t],
  );

  const settle = useCallback((entry: PendingConfirmation, value: boolean) => {
    if (!outstanding.current.delete(entry)) return;
    entry.resolve(value);
    if (!mounted.current) return;
    setPending((current) => (current === entry ? null : current));
    setQueue((current) => current.filter((item) => item !== entry));
  }, []);

  useEffect(() => {
    mounted.current = true;
    const requests = outstanding.current;
    return () => {
      mounted.current = false;
      for (const entry of requests) entry.resolve(false);
      requests.clear();
    };
  }, []);

  const active = queue[0];
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void active.present().then(
      (chosen) => {
        if (cancelled || !outstanding.current.has(active)) return;
        if (chosen === null) setPending(active);
        else settle(active, chosen === "confirm");
      },
      () => {
        if (!cancelled) settle(active, false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active, settle]);

  const dialog = (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open && pending) settle(pending, false);
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
          <AlertDialogCancel onClick={() => pending && settle(pending, false)}>
            {pending?.request.cancel ?? t("actions.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            className={
              pending?.request.destructive
                ? buttonVariants({ variant: "destructive" })
                : undefined
            }
            onClick={() => pending && settle(pending, true)}
          >
            {pending?.request.action ?? t("actions.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { confirm, dialog };
}
