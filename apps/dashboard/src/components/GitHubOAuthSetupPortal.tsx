import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Clipboard, ExternalLink, Github } from "lucide-react";
import { useLocation } from "react-router";
import { api } from "../api/client";
import type { GitHubDeviceStart } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { Dialog } from "./legacy-ui";
import "./GitHubOAuthSetupPortal.css";

type ActiveFlow = GitHubDeviceStart & { retryAfterSeconds: number };

type ErrorResponse = {
  error?: { message?: string };
};

async function configureGitHubClientID(clientId: string, csrfToken: string) {
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
      body.error?.message ?? "Tilecast could not save the GitHub Client ID.",
    );
  }
}

function validClientID(value: string) {
  return /^[A-Za-z0-9._-]{8,128}$/.test(value.trim());
}

export function GitHubOAuthSetupPortal() {
  const auth = useAuth();
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
      ).find((button) => button.textContent?.includes("Connect GitHub"));
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
  }, [location.pathname, owner]);

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
      await configureGitHubClientID(clientId.trim(), csrfToken);
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
              `Connected to GitHub as @${result.login ?? "authorized user"}.`,
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
                ? "GitHub authorization was declined."
                : "The GitHub authorization code expired. Start again for a new code.",
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
              : "GitHub authorization could not be completed.",
          );
        });
    }, flow.retryAfterSeconds * 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [csrfToken, flow, queryClient]);

  const copy = async (label: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(""), 1500);
  };

  return (
    <>
      {target &&
        createPortal(
          <button
            type="button"
            className="button button--secondary"
            onClick={() => {
              setMessage("");
              setSetupOpen(true);
            }}
          >
            <Github size={16} aria-hidden="true" />
            Connect GitHub
          </button>,
          target,
        )}
      <Dialog
        open={setupOpen}
        title="Set up GitHub connection"
        onClose={() => setSetupOpen(false)}
      >
        <div className="github-oauth-setup">
          <p className="github-oauth-setup__intro">
            Create one GitHub OAuth App for this Tilecast installation. Tilecast
            only needs the public Client ID; do not create or paste a client
            secret.
          </p>

          <section className="github-oauth-setup__step">
            <span className="github-oauth-setup__number">1</span>
            <div>
              <h3>Create the OAuth App</h3>
              <p>
                Open GitHub Developer Settings and register a new OAuth App.
              </p>
              <a
                className="button button--secondary"
                href="https://github.com/settings/applications/new"
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={16} aria-hidden="true" />
                Open GitHub OAuth Apps
              </a>
            </div>
          </section>

          <section className="github-oauth-setup__step">
            <span className="github-oauth-setup__number">2</span>
            <div>
              <h3>Enter these exact values</h3>
              <p>
                GitHub requires a callback URL even though Tilecast signs in
                through Device Flow.
              </p>
              <CopyValue
                label="Application name"
                value={setupValues.applicationName}
                copied={copied}
                onCopy={copy}
              />
              <CopyValue
                label="Homepage URL"
                value={setupValues.homepageUrl}
                copied={copied}
                onCopy={copy}
              />
              <CopyValue
                label="Authorization callback URL"
                value={setupValues.callbackUrl}
                copied={copied}
                onCopy={copy}
              />
              <div className="github-oauth-setup__device-flow">
                <Check size={18} aria-hidden="true" />
                <span>
                  Turn on <strong>Enable Device Flow</strong> before registering
                  the application.
                </span>
              </div>
            </div>
          </section>

          <section className="github-oauth-setup__step">
            <span className="github-oauth-setup__number">3</span>
            <div>
              <h3>Paste the Client ID</h3>
              <p>
                After GitHub registers the app, copy its Client ID and paste it
                below. Tilecast saves it in persistent application data and then
                starts sign-in immediately.
              </p>
              <label className="field">
                <span className="field__label">GitHub Client ID</span>
                <input
                  value={clientId}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="Ov23li…"
                  onChange={(event) => setClientId(event.target.value)}
                />
              </label>
            </div>
          </section>

          {message && (
            <div className="notice notice--error" role="alert">
              {message}
            </div>
          )}
          <footer className="github-oauth-setup__actions">
            <button
              type="button"
              className="button button--quiet"
              onClick={() => setSetupOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button--primary"
              disabled={!validClientID(clientId) || configure.isPending}
              onClick={() => configure.mutate()}
            >
              <Github size={16} aria-hidden="true" />
              {configure.isPending ? "Saving…" : "Save and connect"}
            </button>
          </footer>
        </div>
      </Dialog>

      <Dialog
        open={Boolean(flow)}
        title="Authorize Tilecast on GitHub"
        onClose={() => setFlow(null)}
      >
        {flow && (
          <div className="github-oauth-device">
            <p>
              Open GitHub, enter this one-time code, and approve the Tilecast
              OAuth App. This window will update automatically.
            </p>
            <strong className="github-oauth-device__code">
              {flow.userCode}
            </strong>
            <a
              className="button button--primary"
              href={flow.verificationUri}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={16} aria-hidden="true" />
              Open GitHub
            </a>
            <small>Waiting for authorization…</small>
          </div>
        )}
      </Dialog>
    </>
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
  return (
    <label className="github-oauth-copy">
      <span>{label}</span>
      <span>
        <input value={value} readOnly />
        <button
          type="button"
          className="icon-button"
          title={`Copy ${label}`}
          aria-label={`Copy ${label}`}
          onClick={() => void onCopy(label, value)}
        >
          {copied === label ? (
            <Check size={16} aria-hidden="true" />
          ) : (
            <Clipboard size={16} aria-hidden="true" />
          )}
        </button>
      </span>
    </label>
  );
}
