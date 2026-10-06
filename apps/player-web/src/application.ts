import type {
  EvidenceReportV1,
  HostMessageV1,
  PresentationMessage,
  RuntimeReadyV1,
} from "@tilecast/player-runtime/host-contract";
import {
  layoutIdFromItemId,
  statusSurface,
  type DeviceMetadata,
  type StatusKind,
} from "@tilecast/player-runtime/projection";
import { missingCapabilities } from "./compatibility";
import { runtimeHost } from "./host";
import { loadIdentity, type BrowserIdentity } from "./identity";
import {
  assertSameServer,
  authenticate,
  fetchServerIdentity,
  IdentityMismatch,
  pause,
  PairingEnded,
} from "./authentication";
import { PlayerAPI, PlayerAPIError, serverUnreachable } from "./api";
import {
  clockDiscontinuity,
  foregroundEligible,
  initialHostState,
  meaningfulEvidence,
  requireReconfirmation,
  revokeLocalAuthority,
  runExclusive,
} from "./lifecycle";
import { openDatabase } from "./storage/database";
import { OPFSFiles } from "./storage/opfs";
import { IndexedObjects } from "./storage/index";
import { VerifiedStore } from "./storage/verified-store";
import {
  discardActivation,
  type PreparedActivation,
} from "./storage/activation";
import { installMediaAuthorization } from "./media-authorization";
import { requestManagedStorage } from "./storage/persistence";
import { restoreLocalActivation } from "./restore";
import { reconcileSelection, type ReconcileMemory } from "./reconcile";
import { heartbeatPayload } from "./heartbeat";
import { loadRuntime, registerShell } from "./runtime-boot";

declare const __HOST_VERSION__: string;

const POLL_MS = 10_000;
// A server that cannot be reached is retried sooner at first, then settles.
const UNREACHABLE_FIRST_MS = 2_000;
const MAX_BACKOFF_MS = 15_000;

export async function start(recovery: string | null): Promise<void> {
  const missing = missingCapabilities();
  if (missing.length) {
    compatibilityProblem(
      `This browser needs ${missing.join(", ")}. Use current Chrome or Microsoft Edge over HTTPS.`,
    );
    return;
  }
  const pathSlot = /^\/player\/([a-f0-9-]{36})\/?$/.exec(
    location.pathname,
  )?.[1];
  const identitySlot = pathSlot ?? "unmanaged";
  const database = await openDatabase();
  let identity: BrowserIdentity = await navigator.locks.request(
    "tilecast-player-identity",
    () => loadIdentity(database, identitySlot),
  );
  await runExclusive(
    navigator.locks,
    identity.slotId ?? identitySlot,
    async () => {
      const abort = new AbortController();
      addEventListener("pagehide", () => abort.abort(), { once: true });
      const state = initialHostState(!document.hidden);
      let active: PreparedActivation | undefined;
      let currentItemId: string | undefined;
      let lastPlaybackError: string | undefined;
      let ready: RuntimeReadyV1 | undefined;
      let resolveReady!: () => void;
      const readiness = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
      const api = new PlayerAPI();
      const bridge = runtimeHost({
        info: {
          host: "browser",
          hostVersion: __HOST_VERSION__,
          engine: "Chromium",
          engineVersion: "",
        },
        ready(value) {
          ready = value;
          resolveReady();
        },
        result(value) {
          if (value.activation?.activationId !== active?.activationId) return;
          state.runtimeActivationAccepted = value.outcome === "accepted";
          if (value.outcome !== "accepted")
            lastPlaybackError = value.message ?? value.code;
        },
        evidence(value: EvidenceReportV1) {
          if (
            value.activation?.activationId !== active?.activationId ||
            !meaningfulEvidence(state)
          )
            return;
          currentItemId =
            (value.itemId ? layoutIdFromItemId(value.itemId) : null) ??
            value.itemId ??
            undefined;
          // Runtime remains the evidence producer. Activity transport is wired
          // through the shared reporting contract, separately from this bridge.
        },
        error(value) {
          if (value.activation?.activationId === active?.activationId)
            state.runtimeActivationAccepted = false;
          lastPlaybackError = value.message;
        },
      });
      (globalThis as Record<string, unknown>).tilecastRuntimeHost = bridge.host;
      const cleanMedia = installMediaAuthorization(
        database,
        () => active,
        // Local media is served for any activation this page authorized, with
        // or without the server. The server revokes it by saying so.
        () => state.localActivationAuthorized,
      );
      // The status surface shown until an activation exists. It carries no
      // content decision: connection wording belongs to the host, branding
      // and layout of the surface belong to the shared resolver.
      const surface = (
        kind: StatusKind,
        title?: string,
        message?: string,
      ): void =>
        bridge.send({
          type: "presentation",
          presentation: statusSurface(kind, undefined, {
            ...(title ? { title } : {}),
            ...(message ? { message } : {}),
          }),
        });
      surface("connecting");
      const files = await OPFSFiles.open();
      const index = new IndexedObjects(database);
      const session = new Set<string>();
      const exclusively = <T>(run: () => Promise<T>): Promise<T> =>
        navigator.locks.request("tilecast-player-cas", run);
      const controls = platformControls(database, bridge.send);
      const restoreAtStartup = async (): Promise<void> => {
        const restored = await exclusively(() =>
          restoreLocalActivation(
            database,
            new VerifiedStore(index, files, Number.MAX_SAFE_INTEGER, Date.now, {
              session,
            }),
            identity,
          ),
        );
        if (restored) {
          active = restored;
          state.localActivationAuthorized = true;
        }
      };
      const publish = (next: PreparedActivation): void => {
        state.runtimeActivationAccepted = false;
        bridge.send(next.plugins);
        bridge.send(next.presentation);
      };
      let registration: ServiceWorkerRegistration | undefined;
      try {
        // Online and offline start share these steps. The Runtime starts and
        // the last committed activation is revalidated before the network is
        // consulted, so a server outage never prevents playback.
        const [shell] = await Promise.all([
          registerShell().then((value) => {
            loadRuntime();
            return value;
          }),
          restoreAtStartup(),
        ]);
        registration = shell;
        await readiness;
        if (active) publish(active);

        const memory: ReconcileMemory = {
          key: "",
          generation: active?.generation ?? 0,
          validUntilMs: null,
          clockOffsetMs: 0,
        };
        // Waking and connectivity events end the wait so the Host reconfirms
        // with the server promptly instead of at the next poll.
        const wake = new EventTarget();
        const wakeNow = () => wake.dispatchEvent(new Event("wake"));
        const resume = () => {
          state.visible = !document.hidden;
          state.frozen = false;
          requireReconfirmation(state);
          if (state.visible) wakeNow();
        };
        addEventListener("online", wakeNow, { signal: abort.signal });
        document.addEventListener("visibilitychange", resume, {
          signal: abort.signal,
        });
        document.addEventListener(
          "freeze",
          () => {
            state.frozen = true;
            requireReconfirmation(state);
          },
          { signal: abort.signal },
        );
        document.addEventListener("resume", resume, { signal: abort.signal });

        let sample = { wallMs: Date.now(), monotonicMs: performance.now() };
        let backoff = POLL_MS;
        while (!abort.signal.aborted) {
          const now = { wallMs: Date.now(), monotonicMs: performance.now() };
          if (clockDiscontinuity(sample, now)) requireReconfirmation(state);
          sample = now;
          try {
            const server = await fetchServerIdentity(api);
            assertSameServer(identity, server);
            const authenticated = await authenticate(
              api,
              database,
              server,
              identity,
              identitySlot,
              recovery,
              metadata(identity.installationId),
              bridge.send,
              abort.signal,
            );
            recovery = null;
            identity = authenticated.identity;
            const bound = authenticated.session;
            if (
              active &&
              (active.bindingId !== bound.bindingId ||
                active.serverInstallationId !== server.installationId)
            ) {
              // A different binding must never inherit this one's content.
              await discardActivation(database, active.slotId);
              active = undefined;
              revokeLocalAuthority(state);
              memory.key = "";
              surface("connecting");
            }
            state.serverBindingConfirmed = true;
            if (foregroundEligible(state)) {
              const result = await reconcileSelection(
                {
                  api,
                  database,
                  files,
                  index,
                  binding: {
                    slotId: bound.slotId,
                    bindingId: bound.bindingId,
                    serverInstallationId: server.installationId,
                  },
                  support: () => ready?.support,
                  signal: abort.signal,
                  storeOptions: { session },
                  exclusively,
                },
                memory,
              );
              if (result.changed) {
                active = result.activation;
                state.localActivationAuthorized = true;
                publish(active);
              }
              state.selectionCurrent = true;
            }
            const plan = memory.plan;
            await api.request(
              "/api/v1/player/heartbeat",
              heartbeatPayload({
                screenWidth: innerWidth,
                screenHeight: innerHeight,
                hostVersion: __HOST_VERSION__,
                uptimeSeconds: performance.now() / 1000,
                ...(currentItemId ? { currentItemId } : {}),
                playing:
                  meaningfulEvidence(state) &&
                  active?.presentation.presentation.state === "playing",
                support: ready?.support,
                selection: plan?.selection,
                manifestVersion: memory.manifestVersion,
                configRevision: memory.configRevision,
                lastPlaybackError:
                  lastPlaybackError ??
                  plan?.compatibility.failures
                    .map((failure) => failure.component)
                    .join(", "),
              }),
            );
            backoff = POLL_MS;
          } catch (error) {
            if (abort.signal.aborted) break;
            // The server may be down; the last verified activation continues.
            // While it is, nothing counts as confirmed against the server.
            requireReconfirmation(state);
            if (serverUnreachable(error)) {
              if (!active)
                surface(
                  "connecting",
                  "Waiting for the Tilecast server",
                  "This Browser Player will connect when the server is available.",
                );
              backoff = Math.min(
                MAX_BACKOFF_MS,
                backoff === POLL_MS ? UNREACHABLE_FIRST_MS : backoff * 2,
              );
            } else if (
              error instanceof IdentityMismatch ||
              (error instanceof PlayerAPIError &&
                [401, 403].includes(error.status))
            ) {
              // The server said this binding is revoked, replaced, disabled or
              // is a different installation. Local content is no longer trusted.
              revokeLocalAuthority(state);
              const disabled =
                error instanceof PlayerAPIError && error.status === 403;
              if (!disabled && active) {
                await discardActivation(database, active.slotId);
                active = undefined;
              }
              memory.key = "";
              surface(
                disabled ? "disabled" : "unavailable",
                disabled ? undefined : "Browser Player disconnected",
                disabled
                  ? undefined
                  : error instanceof IdentityMismatch
                    ? error.message
                    : "The administrator changed this Player's authorization. Open a current launch link to reconnect.",
              );
              if (!disabled) break;
              backoff = MAX_BACKOFF_MS;
            } else if (error instanceof PairingEnded) {
              surface("unavailable", "Pairing ended", error.message);
              break;
            } else {
              lastPlaybackError =
                error instanceof Error ? error.message : "Reconcile failed";
              backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
            }
          }
          try {
            await Promise.race([
              pause(backoff, abort.signal),
              new Promise<void>((resolve) =>
                wake.addEventListener("wake", () => resolve(), { once: true }),
              ),
            ]);
          } catch {
            break;
          }
        }
        // Keep the slot lock while disconnected so a second window cannot act.
        if (!abort.signal.aborted)
          await new Promise<void>((resolve) =>
            abort.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
      } catch (error) {
        recovery = null;
        revokeLocalAuthority(state);
        surface(
          "unavailable",
          "Browser Player could not start",
          "Reload this Browser Player to reconnect.",
        );
        if (!abort.signal.aborted)
          await new Promise<void>((resolve) =>
            abort.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
      } finally {
        cleanMedia();
        controls.remove();
        database.close();
        // Waiting workers activate naturally when all old pages close. This Host
        // never replaces Runtime or requests worker activation during playback.
        void registration;
      }
    },
    () =>
      compatibilityProblem(
        "This Browser Player is already running in another window.",
      ),
  );
}

function metadata(installationId: string): DeviceMetadata {
  return {
    playerInstallationId: installationId,
    platform: "browser",
    manufacturer: "Browser",
    model: "Chromium",
    androidVersion: "Not applicable",
    playerVersion: __HOST_VERSION__,
    screenWidth: Math.max(1, innerWidth),
    screenHeight: Math.max(1, innerHeight),
    density: devicePixelRatio,
    locale: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

function compatibilityProblem(message: string): void {
  const main = document.createElement("main");
  const title = document.createElement("h1");
  title.textContent = "Tilecast Browser Player";
  const copy = document.createElement("p");
  copy.textContent = message;
  main.append(title, copy);
  document.body.replaceChildren(main);
}

function platformControls(
  database: IDBDatabase,
  send: (message: HostMessageV1) => void,
): HTMLElement {
  const button = document.createElement("button");
  button.className = "player-start";
  button.textContent = "Start player";
  button.addEventListener("click", async () => {
    await document.documentElement.requestFullscreen().catch(() => undefined);
    if ("wakeLock" in navigator)
      await navigator.wakeLock.request("screen").catch(() => undefined);
    await requestManagedStorage(database);
    send({ type: "command", command: "retry-item" });
    button.textContent = document.fullscreenElement
      ? "Player started"
      : "Enter fullscreen";
  });
  document.body.append(button);
  return button;
}

export type { PresentationMessage };
