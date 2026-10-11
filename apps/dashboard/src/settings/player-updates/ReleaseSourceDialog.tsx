import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { api } from "../../api/client";
import { configureGitHubReleases } from "../../api/domains/system";
import type { GitHubAuthStatus, GitHubDeviceStart } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { apiErrorMessage } from "../../i18n";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button, buttonVariants } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../../components/ui/dialog";
import { Field, FieldLabel, FieldDescription } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Spinner } from "../../components/ui/spinner";
import { toast } from "../../components/ui/toast";

export function ReleaseSourceDialog({
  github,
  onClose,
}: {
  github: GitHubAuthStatus;
  onClose: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const auth = useAuth();
  const client = useQueryClient();
  const csrf = auth.status?.csrfToken ?? "";
  const [clientId, setClientId] = useState("");
  const [configured, setConfigured] = useState(false);
  const [flow, setFlow] = useState<
    GitHubDeviceStart & { retryAfterSeconds: number }
  >();
  const [error, setError] = useState("");
  const start = useMutation({
    mutationFn: async () => {
      if (!github.available && !configured) {
        await configureGitHubReleases(clientId.trim(), csrf);
        setConfigured(true);
      }
      return api.startGitHubDeviceAuthorization(csrf);
    },
    onSuccess: (result) => {
      setFlow({ ...result, retryAfterSeconds: result.pollIntervalSeconds });
      void client.invalidateQueries({ queryKey: ["player-releases"] });
    },
    onError: (error) => {
      const message = apiErrorMessage(error);
      setError(message);
      toast.add({ title: message, type: "error" });
    },
  });
  const disconnect = useMutation({
    mutationFn: () => api.disconnectGitHub(csrf),
    onSuccess: () => {
      toast.add({
        title: t("updates.panel.githubDisconnected"),
        type: "success",
      });
      void client.invalidateQueries({ queryKey: ["player-releases"] });
      onClose();
    },
    onError: (error) => setError(apiErrorMessage(error)),
  });
  useEffect(() => {
    if (!flow) return;
    let disposed = false;
    const timer = window.setTimeout(() => {
      void api
        .pollGitHubDeviceAuthorization(flow.flowId, csrf)
        .then((result) => {
          if (disposed) return;
          if (result.status === "connected") {
            toast.add({
              title: t("updates.panel.githubConnected", {
                login: result.login ?? t("updates.panel.defaultLogin"),
              }),
              type: "success",
            });
            void client.invalidateQueries({ queryKey: ["player-releases"] });
            onClose();
          } else if (
            result.status === "denied" ||
            result.status === "expired"
          ) {
            setFlow(undefined);
            const message =
              result.status === "denied"
                ? t("updates.panel.githubDeclined")
                : t("updates.panel.githubExpired");
            setError(message);
            toast.add({ title: message, type: "error" });
          } else
            setFlow((current) =>
              current
                ? {
                    ...current,
                    retryAfterSeconds:
                      result.retryAfterSeconds ?? current.pollIntervalSeconds,
                  }
                : current,
            );
        })
        .catch((error) => {
          if (!disposed) {
            setFlow(undefined);
            setError(apiErrorMessage(error));
            toast.add({ title: apiErrorMessage(error), type: "error" });
          }
        });
    }, flow.retryAfterSeconds * 1000);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [flow, csrf, client, t, onClose]);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {flow
              ? t("updates.setup.authTitle")
              : t("updates.console.configureSource")}
          </DialogTitle>
          <DialogDescription>
            {flow
              ? t("updates.setup.authBody")
              : t("updates.console.sourceHint")}
          </DialogDescription>
        </DialogHeader>
        {flow ? (
          <div className="grid gap-3">
            <Field>
              <FieldLabel>{t("updates.panel.oneTimeCode")}</FieldLabel>
              <strong className="select-all font-mono text-xl tracking-widest">
                {flow.userCode}
              </strong>
            </Field>
            <a
              href={flow.verificationUri}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: "default" })}
            >
              <ExternalLink aria-hidden="true" />
              {t("updates.panel.openGitHub")}
            </a>
            <p
              role="status"
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              <Spinner />
              {t("updates.panel.waitingAuth")}
            </p>
          </div>
        ) : github.connected ? (
          <p className="text-sm">
            {github.login
              ? t("updates.panel.authorizedAs", { login: github.login })
              : t("updates.panel.authorizedToken")}
          </p>
        ) : !github.available && !configured ? (
          <Field>
            <FieldLabel htmlFor="github-client-id">
              {t("updates.setup.clientIdLabel")}
            </FieldLabel>
            <FieldDescription>{t("updates.setup.intro")}</FieldDescription>
            <a
              className="text-sm underline"
              href="https://github.com/settings/developers"
              target="_blank"
              rel="noreferrer"
            >
              {t("updates.setup.openApps")}
            </a>
            <Input
              id="github-client-id"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              autoComplete="off"
            />
            <FieldDescription>
              {t("updates.console.deviceFlowHint")}
            </FieldDescription>
          </Field>
        ) : null}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          {!flow &&
            (github.canDisconnect ? (
              <Button
                variant="outline"
                disabled={disconnect.isPending}
                onClick={() => disconnect.mutate()}
              >
                {disconnect.isPending && <Spinner />}
                {t("updates.panel.disconnect")}
              </Button>
            ) : !github.connected ? (
              <Button
                disabled={
                  start.isPending ||
                  (!github.available &&
                    !configured &&
                    !/^[A-Za-z0-9._-]{8,128}$/.test(clientId.trim()))
                }
                onClick={() => {
                  setError("");
                  start.mutate();
                }}
              >
                {start.isPending && <Spinner />}
                {t("updates.panel.connect")}
              </Button>
            ) : null)}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
