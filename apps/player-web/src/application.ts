import type {
  HostMessageV1,
  RuntimeReadyV1,
  PresentationMessage,
  EvidenceReportV1,
} from "@tilecast/player-runtime/host-contract";
import {
  projectManifestItems,
  type Manifest,
  type ManifestItem,
  type PlayerConfig,
  type DeviceMetadata,
} from "@tilecast/player-runtime/projection";
import { missingCapabilities } from "./compatibility";
import { runtimeHost } from "./host";
import { loadIdentity } from "./identity";
import { authenticate, pause, type BrowserSession } from "./authentication";
import { PlayerAPI, PlayerAPIError } from "./api";
import {
  clockDiscontinuity,
  meaningfulEvidence,
  runExclusive,
  type EvidenceEnvironment,
} from "./lifecycle";
import { openDatabase } from "./storage/database";
import { OPFSFiles } from "./storage/opfs";
import { IndexedObjects } from "./storage/index";
import { VerifiedStore } from "./storage/verified-store";
import { prepareResources } from "./storage/preparation";
import {
  commitActivation,
  loadActivation,
  type PreparedActivation,
} from "./storage/activation";
import { installMediaAuthorization } from "./media-authorization";
import { requestManagedStorage } from "./storage/persistence";

declare const __RUNTIME_PATH__: string;
declare const __HOST_VERSION__: string;

interface Selection {
  source: string;
  contentType: string;
  contentId: string;
  selectionId?: string;
}
interface ServerSelection {
  at: string;
  current?: { selected?: Selection; nextEvaluationAt?: string };
}

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
  const identity = await navigator.locks.request(
    "tilecast-player-identity",
    () => loadIdentity(database, identitySlot),
  );
  await runExclusive(
    navigator.locks,
    identity.slotId ?? identitySlot,
    async () => {
      const signal = new AbortController();
      addEventListener("pagehide", () => signal.abort(), { once: true });
      const environment: EvidenceEnvironment = {
        visible: !document.hidden,
        frozen: false,
        reconciled: false,
        bindingValid: false,
        activationValid: false,
      };
      let active: PreparedActivation | undefined;
      let currentItemId: string | undefined;
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
          if (value.activation?.activationId === active?.activationId)
            environment.activationValid = value.outcome === "accepted";
        },
        evidence(value: EvidenceReportV1) {
          if (
            value.activation?.activationId !== active?.activationId ||
            !meaningfulEvidence(environment)
          )
            return;
          currentItemId = value.itemId ?? undefined;
          // Runtime remains the evidence producer. Activity transport is wired
          // through the shared reporting contract, separately from this bridge.
        },
        error() {
          environment.activationValid = false;
        },
      });
      (globalThis as Record<string, unknown>).tilecastRuntimeHost = bridge.host;
      const cleanMedia = installMediaAuthorization(
        database,
        () => active,
        () => environment.bindingValid,
      );
      const register = await navigator.serviceWorker.register(
        "/player/service-worker.js",
        { scope: "/player", updateViaCache: "none" },
      );
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise<void>((resolve) => {
          navigator.serviceWorker.addEventListener(
            "controllerchange",
            () => resolve(),
            { once: true },
          );
        });
      }
      const base = document.createElement("base");
      base.href = `${__RUNTIME_PATH__}/`;
      document.head.append(base);
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = `${__RUNTIME_PATH__}/runtime.css`;
      document.head.append(css);
      const script = document.createElement("script");
      script.src = `${__RUNTIME_PATH__}/runtime.js`;
      document.head.append(script);
      await readiness;
      const controls = platformControls(database, bridge.send);
      let session: BrowserSession;
      try {
        const authenticated = await authenticate(
          api,
          database,
          identity,
          identitySlot,
          recovery,
          metadata(identity.installationId),
          bridge.send,
          signal.signal,
        );
        recovery = null;
        session = authenticated.session;
        environment.bindingValid = true;
        const files = await OPFSFiles.open();
        const index = new IndexedObjects(database);
        const previous = await loadActivation(database, session.slotId);
        let generation = previous?.generation ?? 0;
        let acceptedKey = "";
        let clockOffsetMs = 0;
        const restore = async () =>
          navigator.locks.request("tilecast-player-cas", async () => {
            if (
              !previous ||
              previous.bindingId !== session.bindingId ||
              previous.serverInstallationId !==
                authenticated.server.installationId
            )
              return;
            const store = new VerifiedStore(
              index,
              files,
              Number.MAX_SAFE_INTEGER,
            );
            for (const resource of previous.resources)
              if (!(await store.verified(resource))) return;
            active = previous;
            environment.activationValid = true;
            bridge.send(previous.plugins);
            bridge.send(previous.presentation);
          });
        await restore();
        const reconcile = async () => {
          const before = Date.now();
          const [manifest, config, selection] = await Promise.all([
            api.request<Manifest>("/api/v1/player/manifest"),
            api.request<PlayerConfig>("/api/v1/player/config"),
            api.request<ServerSelection>("/api/v1/player/browser/selection"),
          ]);
          clockOffsetMs =
            Date.parse(manifest.serverTime) - (before + Date.now()) / 2;
          const selected = selection.current?.selected;
          const key = JSON.stringify([
            manifest.manifestVersion,
            config.configRevision,
            selected,
          ]);
          if (key === acceptedKey && active && environment.reconciled) return;
          const at = new Date(selection.at);
          const items = selectedItems(manifest, selected);
          const limit = Number(config.cache.maximumBytes ?? 2 * 1024 ** 3);
          await navigator.locks.request("tilecast-player-cas", async () => {
            await files.reconcile(
              new Set((await index.list()).map((object) => object.digest)),
            );
            const store = new VerifiedStore(index, files, limit);
            const resources = manifest.assets.map((asset) => ({
              assetId: asset.assetId,
              variantId: asset.variantId,
              digest: asset.sha256,
              size: asset.fileSize,
              mimeType: asset.mimeType,
            }));
            const release = await prepareResources(
              store,
              index,
              resources,
              (claim) =>
                api.media(
                  manifest.assets.find(
                    (asset) => asset.sha256 === claim.digest,
                  )!.downloadPath,
                  signal.signal,
                ),
            );
            try {
              const nextGeneration = ++generation;
              const activationId = crypto.randomUUID();
              active = await commitActivation(
                database,
                {
                  slotId: session.slotId,
                  bindingId: session.bindingId,
                  serverInstallationId: authenticated.server.installationId,
                  activationId,
                  generation: nextGeneration,
                  resources,
                  presentation: {
                    type: "presentation",
                    presentation: { state: "idle" },
                  },
                  plugins: {
                    type: "plugins",
                    plugins: manifest.plugins ?? [],
                    clockOffsetMs,
                  },
                },
                (media): PresentationMessage => {
                  const projected = projectManifestItems(
                    manifest,
                    items,
                    config.playback,
                    at,
                    media,
                  );
                  return {
                    type: "presentation",
                    activation: { activationId, generation: nextGeneration },
                    presentation: projected.length
                      ? {
                          state: "playing",
                          items: projected,
                          generation: nextGeneration,
                          takeover: selected?.source === "takeover",
                        }
                      : {
                          state: selected ? "unavailable" : "idle",
                          title: selected
                            ? "Content unavailable"
                            : "No content assigned",
                        },
                    projection: {
                      schema: manifest.schemaVersion,
                      clockOffsetMs,
                      manifest: manifest as unknown as Record<string, unknown>,
                      media,
                      playback: config.playback,
                    },
                  };
                },
              );
              environment.reconciled = true;
              // Publish before accepting evidence; Runtime acknowledges this ref.
              environment.activationValid = false;
              bridge.send(active.plugins);
              bridge.send(active.presentation);
              acceptedKey = key;
            } finally {
              await release();
            }
          });
        };
        let sample = { wallMs: Date.now(), monotonicMs: performance.now() };
        const resume = () => {
          environment.visible = !document.hidden;
          environment.frozen = false;
          environment.reconciled = false;
        };
        document.addEventListener("visibilitychange", resume, {
          signal: signal.signal,
        });
        document.addEventListener(
          "freeze",
          () => {
            environment.frozen = true;
            environment.reconciled = false;
          },
          { signal: signal.signal },
        );
        document.addEventListener("resume", resume, { signal: signal.signal });
        while (!signal.signal.aborted) {
          const now = { wallMs: Date.now(), monotonicMs: performance.now() };
          if (clockDiscontinuity(sample, now)) environment.reconciled = false;
          sample = now;
          try {
            await api.request("/api/v1/player/browser/session");
            if (!document.hidden && !environment.frozen) await reconcile();
            await api.request("/api/v1/player/heartbeat", {
              screenWidth: Math.max(1, innerWidth),
              screenHeight: Math.max(1, innerHeight),
              playerVersion: __HOST_VERSION__,
              playerFamily: "browser",
              ...(currentItemId && /^[a-f0-9-]{36}$/.test(currentItemId)
                ? { currentItemId }
                : {}),
              playbackState:
                meaningfulEvidence(environment) &&
                active?.presentation.presentation.state === "playing"
                  ? "playing"
                  : "idle",
              presentationSchemaVersions: ready?.support?.presentationSchemas,
              nativePresentationCapabilities: {
                ...ready?.support?.declarativeCapabilities,
                ...Object.fromEntries(
                  Object.entries(ready?.support?.widgetComponents ?? {}).map(
                    ([type, version]) => [`widget.${type}`, version],
                  ),
                ),
              },
              uptimeSeconds: Math.floor(performance.now() / 1000),
            });
          } catch (error) {
            if (
              error instanceof PlayerAPIError &&
              [401, 403].includes(error.status)
            ) {
              environment.bindingValid = false;
              environment.reconciled = false;
              bridge.send({
                type: "presentation",
                presentation: {
                  state: error.status === 403 ? "disabled" : "unavailable",
                  title:
                    error.status === 403
                      ? "Screen disabled"
                      : "Browser Player disconnected",
                  message:
                    "The administrator changed this Player's authorization. Reload to reconnect.",
                },
              });
              break;
            }
            // Ordinary network loss retains the last completely verified activation.
          }
          await pause(10_000, signal.signal);
        }
        // Keep the slot lock while disconnected so a second window cannot act.
        if (!signal.signal.aborted)
          await new Promise<void>((resolve) =>
            signal.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
      } catch (error) {
        recovery = null;
        environment.bindingValid = false;
        bridge.send({
          type: "presentation",
          presentation: {
            state: "unavailable",
            title: "Browser Player could not connect",
            message:
              error instanceof PlayerAPIError
                ? "Check the server connection and managed launch link, then reload."
                : error instanceof Error
                  ? error.message
                  : "Reload this Browser Player to reconnect.",
          },
        });
        if (!signal.signal.aborted)
          await new Promise<void>((resolve) =>
            signal.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
      } finally {
        cleanMedia();
        controls.remove();
        database.close();
        // Waiting workers activate naturally when all old pages close. This Host
        // never replaces Runtime or requests worker activation during playback.
        void register;
      }
    },
    () =>
      compatibilityProblem(
        "This Browser Player is already running in another window.",
      ),
  );
}

function selectedItems(
  manifest: Manifest,
  selected?: Selection,
): ManifestItem[] {
  if (!selected) return [];
  if (selected.contentType === "layout")
    return [
      {
        id: `layout:${selected.contentId}`,
        assetId: "",
        layoutId: selected.contentId,
        assetType: "layout",
        fitMode: "contain",
        transition: "none",
        audioEnabled: false,
        volume: 0,
        deliveryPolicy: "download",
      },
    ];
  if (selected.contentType === "playlist")
    return (
      [
        manifest.playlist,
        manifest.directFallbackPlaylist,
        ...manifest.playlists,
      ].find((playlist) => playlist?.id === selected.contentId)?.items ?? []
    );
  // Quick Present publishes its synthetic asset playlist in the same manifest.
  return manifest.playlist?.items ?? [];
}

function metadata(installationId: string): DeviceMetadata {
  return {
    playerInstallationId: installationId,
    platform: "browser",
    manufacturer: "Browser",
    model: "Chromium",
    androidVersion: "",
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
