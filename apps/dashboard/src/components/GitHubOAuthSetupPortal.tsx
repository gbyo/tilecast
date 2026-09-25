import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Clipboard, ExternalLink, Github } from "lucide-react";
import { useLocation } from "react-router";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { api } from "../api/client";
import type { GitHubDeviceStart } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { Alert, AlertDescription } from "./ui/alert";
import { Button, buttonVariants } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Field, FieldLabel } from "./ui/field";
import { toast } from "./ui/toast";

type ActiveFlow = GitHubDeviceStart & { retryAfterSeconds: number };

type ErrorResponse = {
  error?: { message?: string };
};

async function configureGitHubClientID(
  clientId: string,
  csrfToken: string,
  t?: TFunction<"settings">,
) {
  const response = await fetch("/api/v1/player-releases/github/configuration", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify({ clientId }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ErrorResponse;
    throw new Error(
      body.error?.message ??
        t?.("updates.setup.saveError") ??
        "Tilecast could not save the GitHub Client ID.",
    );
  }
}

function validClientID(value: string) {
  return /^[A-Za-z0-9._-]{8,128}$/.test(value.trim());
}

export function GitHubOAuthSetupPortal() {
  const auth = useAuth();
  const { t } = useTranslation(["settings", "common"]);
  const location = useLocation();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [clientId, setClientId] = useState("");
  const [flow, setFlow] = useState<ActiveFlow | null>(null);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState("");
  const owner = auth.status?.user?.role === "owner";
  const csrfToken = auth.status?.csrfToken ?? "";

  useEffect(() => {
    const restoreHidden = () => {
      document
        .querySelectorAll<HTMLElement>("[data-tilecast-github-setup-hidden]")
        .forEach((element) => {
          element.hidden = false;
          delete element.dataset.tilecastGithubSetupHidden;
        });
    };
    if (!owner || location.pathname !== "/settings/player/updates") {
      restoreHidden();
      setTarget(null);
      return;
    }
    const root = document.getElementById("root");
    if (!root) return;
    const findTarget = () => {
      const configuration = document.querySelector<HTMLElement>(
        ".github-auth__configuration",
      );
      const actions = document.querySelector<HTMLElement>(
        ".github-auth__actions",
      );
      const connectButton = Array.from(
        actions?.querySelectorAll<HTMLButtonElement>("button") ?? [],
      ).find((button) =>
        // The settings page renders this label through the same key, so the
        // match follows the active language instead of English.
        button.textContent?.includes(t("updates.panel.connect")),
      );
      if (!configuration || !actions || !connectButton) {
        setTarget(null);
        return;
      }
      configuration.hidden = true;
      configuration.dataset.tilecastGithubSetupHidden = "true";
      connectButton.hidden = true;
      connectButton.dataset.tilecastGithubSetupHidden = "true";
      setTarget(actions);
    };
    findTarget();
    const observer = new MutationObserver(findTarget);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      restoreHidden();
    };
  }, [location.pathname, owner, t]);

  const setupValues = useMemo(() => {
    const origin = window.location.origin;
    return {
      applicationName: `Tilecast at ${window.location.host}`.slice(0, 100),
      homepageUrl: origin,
      callbackUrl: `${origin}/settings/player/updates`,
    };
  }, []);

  const configure = useMutation({
    mutationFn: async () => {
      await configureGitHubClientID(clientId.trim(), csrfToken, t);
      return api.startGitHubDeviceAuthorization(csrfToken);
    },
    onMutate: () => setMessage(""),
    onSuccess: async (started) => {
      setSetupOpen(false);
      setFlow({
        ...started,
        retryAfterSeconds: started.pollIntervalSeconds,
      });
      await queryClient.invalidateQueries({ queryKey: ["player-releases"] });
    },
    onError: (error) => setMessage(error.message),
  });

  useEffect(() => {
    if (!flow) return;
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void api
        .pollGitHubDeviceAuthorization(flow.flowId, csrfToken)
        .then(async (result) => {
          if (cancelled) return;
          if (result.status === "connected") {
            setFlow(null);
            setMessage(
              t("updates.setup.connected", {
                login: result.login ?? t("updates.setup.defaultLogin"),
              }),
            );
            await queryClient.invalidateQueries({
              queryKey: ["player-releases"],
            });
            return;
          }
          if (result.status === "denied" || result.status === "expired") {
            setFlow(null);
            setMessage(
              result.status === "denied"
                ? t("updates.setup.declined")
                : t("updates.setup.expired"),
            );
            return;
          }
          setFlow((current) =>
            current?.flowId === flow.flowId
              ? {
                  ...current,
                  retryAfterSeconds:
                    result.retryAfterSeconds ?? current.pollIntervalSeconds,
                }
              : current,
          );
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setFlow(null);
          setMessage(
            error instanceof Error
              ? error.message
              : t("updates.setup.incomplete"),
          );
        });
    }, flow.retryAfterSeconds * 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [csrfToken, flow, queryClient, t]);

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      toast.add({
        title: t("common:clipboard.copied", { label }),
        type: "success",
      });
      window.setTimeout(() => setCopied(""), 1500);
    } catch {
      toast.add({
        title: t("common:clipboard.copyFailed", { label }),
        type: "error",
      });
    }
  };

  return (
    <>
      {target &&
        createPortal(
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setMessage("");
              setSetupOpen(true);
            }}
          >
            <Github size={16} aria-hidden="true" />
            {t("updates.setup.connect")}
          </Button>,
          target,
        )}
      <Dialog
        open={setupOpen}
        onOpenChange={(open) => {
          if (!open) setSetupOpen(false);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("updates.setup.title")}</DialogTitle>
            <DialogDescription>{t("updates.setup.intro")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <SetupStep
              number="1"
              title={t("updates.setup.stepCreateTitle")}
              body={t("updates.setup.stepCreateBody")}
            >
              <a
                className={buttonVariants({ variant: "secondary" })}
                href="https://github.com/settings/applications/new"
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={16} aria-hidden="true" />
                {t("updates.setup.openApps")}
              </a>
            </SetupStep>

            <SetupStep
              number="2"
              title={t("updates.setup.stepValuesTitle")}
              body={t("updates.setup.stepValuesBody")}
            >
              <CopyValue
                label={t("updates.setup.appName")}
                value={setupValues.applicationName}
                copied={copied}
                onCopy={copy}
              />
              <CopyValue
                label={t("updates.setup.homepageUrl")}
                value={setupValues.homepageUrl}
                copied={copied}
                onCopy={copy}
              />
              <CopyValue
                label={t("updates.setup.callbackUrl")}
                value={setupValues.callbackUrl}
                copied={copied}
                onCopy={copy}
              />
              <div className="flex items-center gap-2 rounded-[var(--tc-radius-control)] bg-primary/10 px-3 py-2.5 text-sm">
                <Check
                  size={18}
                  aria-hidden="true"
                  className="shrink-0 text-primary"
                />
                <span>
                  <Trans
                    i18nKey="updates.setup.deviceFlowNote"
                    ns="settings"
                    components={{ deviceFlow: <strong /> }}
                  />
                </span>
              </div>
            </SetupStep>

            <SetupStep
              number="3"
              title={t("updates.setup.stepClientIdTitle")}
              body={t("updates.setup.stepClientIdBody")}
            >
              <Field className="gap-1.5">
                <FieldLabel
                  htmlFor="github-client-id"
                  className="text-sm font-medium"
                >
                  {t("updates.setup.clientIdLabel")}
                </FieldLabel>
                <Input
                  id="github-client-id"
                  value={clientId}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  // i18n-ignore: sample Client ID format, not language text
                  placeholder="Ov23li…"
                  onChange={(event) => setClientId(event.target.value)}
                />
              </Field>
            </SetupStep>

            {message && (
              <Alert variant="destructive">
                <AlertDescription>{message}</AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setSetupOpen(false)}
            >
              {t("common:actions.cancel")}
            </Button>
            <Button
              type="button"
              disabled={!validClientID(clientId) || configure.isPending}
              onClick={() => configure.mutate()}
            >
              <Github size={16} aria-hidden="true" />
              {configure.isPending
                ? t("common:actions.saving")
                : t("updates.setup.saveConnect")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(flow)}
        onOpenChange={(open) => {
          if (!open) setFlow(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("updates.setup.authTitle")}</DialogTitle>
          </DialogHeader>
          {flow && (
            <div className="grid w-full max-w-md gap-4 justify-items-center text-center">
              <p className="m-0 text-sm text-muted-foreground">
                {t("updates.setup.authBody")}
              </p>
              <strong className="rounded-[var(--tc-radius-control)] border border-border bg-muted px-4 py-3 font-mono text-2xl tracking-[0.12em]">
                {flow.userCode}
              </strong>
              <a
                className={buttonVariants({ variant: "default" })}
                href={flow.verificationUri}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={16} aria-hidden="true" />
                {t("updates.setup.openGitHub")}
              </a>
              <small className="text-muted-foreground">
                {t("updates.setup.waiting")}
              </small>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function SetupStep({
  number,
  title,
  body,
  children,
}: {
  number: string;
  title: string;
  body: string;
  children: ReactNode;
}) {
  return (
    <section className="grid grid-cols-[30px_minmax(0,1fr)] gap-3 border-t border-border pt-4">
      <span
        aria-hidden="true"
        className="grid size-7 place-items-center rounded-full bg-primary text-[13px] font-bold text-primary-foreground"
      >
        {number}
      </span>
      <div className="grid min-w-0 content-start gap-2.5">
        <h3 className="m-0 mt-0.5 text-base font-semibold">{title}</h3>
        <p className="m-0 text-sm text-muted-foreground">{body}</p>
        {children}
      </div>
    </section>
  );
}

function CopyValue({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: string;
  onCopy: (label: string, value: string) => Promise<void>;
}) {
  const { t } = useTranslation("settings");
  const copyLabel = t("updates.setup.copyValue", { label });
  return (
    <Field className="gap-1">
      <FieldLabel
        htmlFor={`copy-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
        className="text-xs text-muted-foreground"
      >
        {label}
      </FieldLabel>
      <span className="grid grid-cols-[minmax(0,1fr)_auto] gap-1.5">
        <Input
          id={`copy-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
          value={value}
          readOnly
          className="h-8 text-xs"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title={copyLabel}
          aria-label={copyLabel}
          onClick={() => void onCopy(label, value)}
        >
          {copied === label ? (
            <Check size={16} aria-hidden="true" />
          ) : (
            <Clipboard size={16} aria-hidden="true" />
          )}
        </Button>
      </span>
    </Field>
  );
}
