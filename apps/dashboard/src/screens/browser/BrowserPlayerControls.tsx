import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import QRCode from "qrcode";
import { api } from "../../api/client";
import type { BrowserLaunch } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { useConfirm } from "../../components/ConfirmDialog";
import { Button, buttonVariants } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../../components/ui/dialog";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "../../components/ui/card";
import { Alert, AlertDescription } from "../../components/ui/alert";
import {
  PairingDetailsForm,
  makeApprovalSchema,
} from "../../pairing/PairingDetailsForm";
import type { ApprovalForm } from "../../pairing/pairingFlow";
import { screenKeys } from "../../data/screens";

/** Launch credentials remain in this mounted UI's memory and are shown once. */
function LaunchLink({ launch }: { launch: BrowserLaunch }) {
  const { t } = useTranslation("screens");
  const [qr, setQr] = useState<string>();
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const url = `${location.origin}/player/${launch.id}#r=${launch.recoverySecret}`;
  useEffect(() => {
    if (!showQr) return;
    let mounted = true;
    void QRCode.toDataURL(url, { margin: 1, width: 240 }).then(
      (image) => {
        if (mounted) setQr(image);
      },
      () => {
        if (mounted) setFailed(true);
      },
    );
    return () => {
      mounted = false;
    };
  }, [showQr, url]);
  return (
    <div className="space-y-3">
      <p className="text-sm">{t("browser.readyBody")}</p>
      <p className="break-all rounded-sm border bg-muted p-3 font-mono text-xs">
        {url}
      </p>
      <div className="flex flex-wrap gap-2">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({ size: "sm" })}
        >
          {t("browser.open")}
        </a>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(url).then(
              () => setCopied(true),
              () => setFailed(true),
            );
          }}
        >
          {copied ? t("browser.copied") : t("browser.copy")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowQr((value) => !value)}
        >
          {showQr ? t("browser.hideQr") : t("browser.showQr")}
        </Button>
      </div>
      {showQr && qr && (
        <img src={qr} width={240} height={240} alt={t("browser.qrAlt")} />
      )}
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {t("browser.copyFailed")}
        </p>
      )}
      <Alert>
        <AlertDescription>{t("browser.secretWarning")}</AlertDescription>
      </Alert>
      <p className="text-sm text-muted-foreground">
        {t("browser.startupHelp")}
      </p>
      <p className="text-sm text-muted-foreground">{t("browser.once")}</p>
      <Link
        to={`/screens/${launch.screenId}`}
        className="text-sm underline underline-offset-4"
      >
        {t("browser.viewScreen")}
      </Link>
    </div>
  );
}

export function AddBrowserPlayer() {
  const { t } = useTranslation("screens");
  const auth = useAuth();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [launch, setLaunch] = useState<BrowserLaunch>();
  const form = useForm<ApprovalForm>({
    resolver: zodResolver(useMemo(() => makeApprovalSchema(t), [t])),
    defaultValues: { name: "", roomName: "", roomNumber: "", description: "" },
  });
  const locations = useQuery({
    queryKey: ["locations"],
    queryFn: api.locations,
    enabled: open,
  });
  const create = useMutation({
    mutationFn: (values: ApprovalForm) =>
      api.createBrowserPlayer(
        { ...values, locationId: values.locationId || undefined },
        auth.status?.csrfToken ?? "",
      ),
    onSuccess(value) {
      setLaunch(value);
      void client.invalidateQueries({ queryKey: screenKeys.all });
    },
  });
  const close = (value: boolean) => {
    setOpen(value);
    if (!value) {
      setLaunch(undefined);
      create.reset();
      form.reset();
    }
  };
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {t("browser.add")}
      </Button>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {launch ? t("browser.readyTitle") : t("browser.add")}
            </DialogTitle>
            <DialogDescription>{t("browser.createBody")}</DialogDescription>
          </DialogHeader>
          {launch ? (
            <LaunchLink launch={launch} />
          ) : (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                void form.handleSubmit((values) => create.mutate(values))(
                  event,
                );
              }}
            >
              <PairingDetailsForm
                form={form}
                locations={locations.data?.items ?? []}
              />
              {location.protocol !== "https:" && (
                <Alert>
                  <AlertDescription>
                    {t("browser.httpsRequired")}
                  </AlertDescription>
                </Alert>
              )}
              {create.isError && (
                <p role="alert" className="text-sm text-destructive">
                  {t("browser.createFailed")}
                </p>
              )}
              <Button
                type="submit"
                disabled={create.isPending || location.protocol !== "https:"}
              >
                {create.isPending ? t("browser.creating") : t("browser.create")}
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

export function BrowserRecoveryPanel({
  screenId,
  csrfToken,
}: {
  screenId: string;
  csrfToken: string;
}) {
  const { t } = useTranslation("screens");
  const query = useQuery({
    queryKey: ["browser-slot", screenId],
    queryFn: () => api.browserPlayerSlot(screenId),
  });
  const [launch, setLaunch] = useState<BrowserLaunch>();
  const { confirm, dialog } = useConfirm();
  const change = useMutation({
    mutationFn: (enabled: boolean) =>
      api.setBrowserRecovery(screenId, enabled, csrfToken),
    onSuccess(value) {
      if (value.recoverySecret) setLaunch(value);
      else setLaunch(undefined);
      change.reset();
      void query.refetch();
    },
  });
  const regenerate = async () => {
    if (
      await confirm({
        title: t("browser.regenerate"),
        body: t("browser.regenerateWarning"),
        action: t("browser.regenerate"),
        destructive: true,
      })
    )
      change.mutate(true);
  };
  const disable = async () => {
    if (
      await confirm({
        title: t("browser.disable"),
        body: t("browser.disableWarning"),
        action: t("browser.disable"),
        destructive: true,
      })
    )
      change.mutate(false);
  };
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{t("browser.recoveryTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {t("browser.secretWarning")}
        </p>
        {query.data && (
          <p className="text-sm">
            {query.data?.recoveryEnabled
              ? t("browser.recoveryEnabled")
              : t("browser.recoveryDisabled")}
          </p>
        )}
        {query.data?.lastRecoveredAt && (
          <p className="text-sm text-muted-foreground">
            {t("browser.lastRecovered", {
              time: new Date(query.data.lastRecoveredAt).toLocaleString(),
            })}
          </p>
        )}
        {!launch && (
          <p className="text-sm text-muted-foreground">{t("browser.once")}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={change.isPending || query.isPending}
            onClick={() => void regenerate()}
          >
            {t("browser.regenerate")}
          </Button>
          {query.data?.recoveryEnabled && (
            <Button
              size="sm"
              variant="outline"
              disabled={change.isPending}
              onClick={() => void disable()}
            >
              {t("browser.disable")}
            </Button>
          )}
        </div>
        {(query.isError || change.isError) && (
          <p role="alert" className="text-sm text-destructive">
            {t("browser.recoveryFailed")}
          </p>
        )}
        <Dialog
          open={!!launch}
          onOpenChange={(open) => {
            if (!open) setLaunch(undefined);
          }}
        >
          <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>{t("browser.readyTitle")}</DialogTitle>
              <DialogDescription>{t("browser.once")}</DialogDescription>
            </DialogHeader>
            {launch && <LaunchLink launch={launch} />}
          </DialogContent>
        </Dialog>
        {dialog}
      </CardContent>
    </Card>
  );
}
