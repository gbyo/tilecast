/**
 * Pure presentation resolution for hosts that receive an authoritative content
 * selection from the Server and project it with the shared Runtime.
 *
 * This is not a schedule engine. The caller names which content the Server
 * selected; this module looks that content up in the verified manifest, applies
 * the accepted player configuration, and states exactly which verified media
 * the resulting presentation can display. It performs no I/O, reads no clock,
 * and has no knowledge of the host that calls it.
 *
 * Resolution has two steps so a host can prepare media before it publishes:
 *
 *   1. `planPresentation` names the selection and the exact resource closure.
 *   2. `realizePresentation` turns the plan into Runtime messages once the host
 *      has authorized a media binding for every required resource.
 *
 * The closure is derived by running the Runtime's own projector against
 * placeholder bindings and collecting the placeholders it emits, so the set of
 * downloaded resources cannot drift from the set the Runtime will request.
 */
import type {
  ActivationRefV1,
  PluginsMessage,
  PresentationMessage,
  ProjectionContextV1,
  RuntimeItem,
  RuntimePresentation,
  RuntimeSupportV1,
} from "../../host/contract";
import { createProjector } from "../projector";
import {
  isAvailableAt,
  nextAvailabilityTransition,
  type AvailabilityWindow,
} from "./content-availability";
import { projectManifestItems } from "./items";
import type {
  Manifest,
  ManifestAsset,
  ManifestItem,
  ManifestPlaylist,
  PlayerConfig,
} from "./types";

/** The Server's answer to "what is this Screen showing". Copied, not derived. */
export interface PresentationSelection {
  source: string;
  contentType: string;
  contentId: string;
  selectionId?: string | null;
}

export type ConfigurationSections = Partial<
  Pick<PlayerConfig, "branding" | "playback" | "website">
>;

export interface ResolveInput {
  manifest: Manifest;
  config: ConfigurationSections;
  /** Nothing selected is a valid answer: the Screen has no content assigned. */
  selection: PresentationSelection | null | undefined;
  /** The corrected Server instant at which the selection was made. */
  at: Date;
  clockOffsetMs: number;
  /** The Server's next re-evaluation boundary, when it supplied one. */
  nextEvaluationAt?: Date | null;
  /** Live Runtime support, when known. Used only to report compatibility. */
  support?: RuntimeSupportV1;
}

export interface MediaRequirement {
  assetId: string;
  variantId: string;
  digest: string;
  size: number;
  mimeType: string;
  downloadPath: string;
}

export type MediaBinding = ProjectionContextV1["media"][number];

export type ResolvedKind = "playing" | "idle" | "unavailable";

/**
 * Facts a host reports about the content the Server chose, in the vocabulary
 * every Player reports: `source` is `takeover`, `quick_present`, `schedule`
 * or `direct`.
 */
export interface SelectionFacts {
  source: string;
  contentType: string;
  contentId: string;
  selectionId: string | null;
  playlistId: string | null;
  layoutId: string | null;
  scheduleId: string | null;
  takeoverId: string | null;
  nextTransitionAt: string | null;
}

export interface CompatibilityFailure {
  code: "widget_component_unsupported";
  component: string;
  version: number;
}

export interface PresentationPlan {
  readonly input: ResolveInput;
  readonly kind: ResolvedKind;
  readonly selection: SelectionFacts | null;
  /** Exactly the verified media this presentation can display. */
  readonly requirements: MediaRequirement[];
  readonly compatibility: {
    /** Component Widget types and versions the presentation uses. */
    required: Record<string, number>;
    failures: CompatibilityFailure[];
  };
  /**
   * The corrected instant at which this plan stops being valid for any reason
   * other than a new Server selection: an availability window opening or
   * closing, or the Server's own re-evaluation boundary.
   */
  readonly validUntil: Date | null;
}

export interface ResolvedPresentation {
  kind: ResolvedKind;
  presentation: PresentationMessage;
  plugins: PluginsMessage;
}

// ---------------------------------------------------------------- status surfaces

export type StatusKind = "connecting" | "idle" | "unavailable" | "disabled";

export interface StatusOverrides {
  title?: string;
  message?: string;
  /** An authorized logo URI, or null for none. */
  logoSrc?: string | null;
}

const COLOR = /^#[0-9a-fA-F]{6}$/;
const color = (value: unknown, fallback: string): string =>
  typeof value === "string" && COLOR.test(value) ? value : fallback;
const text = (value: unknown, fallback: string): string =>
  typeof value === "string" && value !== "" ? value : fallback;

/**
 * Every non-playing surface the Runtime branded-status states can show, built
 * from the accepted configuration's branding section. Hosts supply nothing
 * except an authorized logo URI and, for host-only conditions such as a
 * revoked connection, their own explanation.
 */
export function statusSurface(
  kind: StatusKind,
  config: Pick<ConfigurationSections, "branding"> | undefined,
  overrides: StatusOverrides = {},
): RuntimePresentation {
  const branding = config?.branding ?? {};
  const common = {
    backgroundColor: color(branding["backgroundColor"], "#0E141B"),
    textColor: color(branding["textColor"], "#F5F7FA"),
    logoSrc: overrides.logoSrc ?? null,
    footerText: String(branding["footerText"] ?? ""),
  };
  switch (kind) {
    case "connecting":
      return {
        state: "idle",
        ...common,
        title: overrides.title ?? "Connecting to Tilecast",
        message:
          overrides.message ??
          "Content status will appear when the server is available.",
        status: "connecting",
      };
    case "idle":
      return {
        state: "idle",
        ...common,
        title:
          overrides.title ??
          text(branding["noContentTitle"], "No content assigned"),
        message:
          overrides.message ?? String(branding["noContentMessage"] ?? ""),
        status: "no_content",
      };
    case "disabled":
      return {
        state: "disabled",
        ...common,
        title:
          overrides.title ?? text(branding["disabledTitle"], "Screen disabled"),
        message: overrides.message ?? String(branding["disabledMessage"] ?? ""),
        status: "disabled",
      };
    case "unavailable":
      return {
        state: "unavailable",
        ...common,
        title: overrides.title ?? "Content unavailable",
        message:
          overrides.message ?? "Assigned content is not currently available.",
        status: "unavailable",
      };
  }
}

// ---------------------------------------------------------------- content lookup

const LAYOUT_ITEM_PREFIX = "layout-";

export function layoutItemId(layoutId: string): string {
  return `${LAYOUT_ITEM_PREFIX}${layoutId}`;
}

export function layoutIdFromItemId(itemId: string): string | null {
  return itemId.startsWith(LAYOUT_ITEM_PREFIX)
    ? itemId.slice(LAYOUT_ITEM_PREFIX.length)
    : null;
}

interface Content {
  playlistId: string | null;
  layoutId: string | null;
}

/**
 * Names the playlist or Layout the Server selected. This is an identifier
 * lookup. It compares no times and ranks nothing: the Server already decided.
 */
function contentFor(
  manifest: Manifest,
  selection: PresentationSelection,
): Content {
  if (selection.source === "quick_present") {
    const override = manifest.presentationOverride;
    if (
      override &&
      (!selection.selectionId || override.id === selection.selectionId)
    ) {
      return {
        playlistId:
          override.playlistId ??
          (override.contentType === "playlist" ? override.contentId : null),
        layoutId:
          override.layoutId ??
          (override.contentType === "layout" ? override.contentId : null),
      };
    }
  }
  return {
    playlistId:
      selection.contentType === "playlist" ? selection.contentId : null,
    layoutId: selection.contentType === "layout" ? selection.contentId : null,
  };
}

function findPlaylist(
  manifest: Manifest,
  playlistId: string | null,
): ManifestPlaylist | null {
  if (!playlistId) return null;
  return (
    [
      manifest.playlist,
      manifest.directFallbackPlaylist,
      ...(manifest.playlists ?? []),
    ].find((playlist) => playlist?.id === playlistId) ?? null
  );
}

function hasLayout(manifest: Manifest, layoutId: string): boolean {
  const layouts = [
    ...((manifest.layouts ?? []) as { id?: string }[]),
    ...(manifest.layout ? [manifest.layout as { id?: string }] : []),
  ];
  return layouts.some((layout) => layout?.id === layoutId);
}

/**
 * The Server names a direct assignment `assignment`. Every Player reports it
 * as `direct`: in the heartbeat's `selectionSource` and as the Activity
 * `trigger`. Reporting is the one place the two vocabularies meet.
 */
const reportedSource = (source: string): string =>
  source === "assignment" ? "direct" : source;

function selectionFacts(
  selection: PresentationSelection,
  content: Content,
  nextTransitionAt: Date | null | undefined,
): SelectionFacts {
  return {
    source: reportedSource(selection.source),
    contentType: selection.contentType,
    contentId: selection.contentId,
    selectionId: selection.selectionId ?? null,
    playlistId: content.playlistId,
    layoutId: content.layoutId,
    scheduleId:
      selection.source === "schedule" ? (selection.selectionId ?? null) : null,
    takeoverId:
      selection.source === "takeover" ? (selection.selectionId ?? null) : null,
    nextTransitionAt: nextTransitionAt ? nextTransitionAt.toISOString() : null,
  };
}

// ---------------------------------------------------------------- building

interface Built {
  kind: ResolvedKind;
  presentation: RuntimePresentation;
  facts: SelectionFacts | null;
  /** Items whose availability bounds the plan's validity. */
  windowed: readonly ManifestItem[];
}

const assetKey = (assetId: string, variantId: string) =>
  `${assetId}/${variantId}`;

function logoAsset(manifest: Manifest, at: Date): ManifestAsset | null {
  const { logoAssetId, logoVariantId } = manifest.branding ?? {};
  if (!logoAssetId || !logoVariantId) return null;
  return (
    manifest.assets.find(
      (asset) =>
        asset.assetId === logoAssetId &&
        asset.variantId === logoVariantId &&
        isAvailableAt(asset, at),
    ) ?? null
  );
}

/**
 * The authorized logo URI for a manifest's branding, if the host granted one.
 * Hosts use it for surfaces they raise themselves, such as a disabled Screen.
 */
export function brandingLogoUri(
  manifest: Manifest | null | undefined,
  media: readonly MediaBinding[],
  at: Date,
): string | null {
  if (!manifest) return null;
  const asset = logoAsset(manifest, at);
  if (!asset) return null;
  return (
    media.find(
      (binding) =>
        binding.assetId === asset.assetId &&
        binding.variantId === asset.variantId,
    )?.uri ?? null
  );
}

function build(
  input: ResolveInput,
  media: readonly MediaBinding[],
  generation: number,
  ignoreItemWindows = false,
): Built {
  const { manifest, config, selection, at } = input;
  const logoSrc = brandingLogoUri(manifest, media, at);
  const branded = (kind: StatusKind, overrides: StatusOverrides = {}) =>
    statusSurface(kind, config, { logoSrc, ...overrides });
  if (!selection) {
    return {
      kind: "idle",
      presentation: branded("idle"),
      facts: null,
      windowed: [],
    };
  }
  const content = contentFor(manifest, selection);
  const facts = selectionFacts(selection, content, input.nextEvaluationAt);

  let items: ManifestItem[];
  if (content.layoutId && !content.playlistId) {
    if (!hasLayout(manifest, content.layoutId)) {
      return {
        kind: "unavailable",
        presentation: branded("unavailable", {
          message: "The assigned Layout is not currently renderable.",
        }),
        facts,
        windowed: [],
      };
    }
    items = [
      {
        id: layoutItemId(content.layoutId),
        assetId: "",
        layoutId: content.layoutId,
        assetType: "layout",
        fitMode: "contain",
        transition: "none",
        audioEnabled: false,
        volume: 0,
        deliveryPolicy: "download",
      },
    ];
  } else {
    const playlist = findPlaylist(manifest, content.playlistId);
    if (!playlist) {
      return {
        kind: "idle",
        presentation: branded("idle"),
        facts,
        windowed: [],
      };
    }
    items = playlist.items;
    if (items.length === 0) {
      return {
        kind: "unavailable",
        presentation: branded("unavailable"),
        facts,
        windowed: [],
      };
    }
  }
  const projected: RuntimeItem[] = projectManifestItems(
    manifest,
    ignoreItemWindows ? items.map(withoutWindow) : items,
    config.playback,
    at,
    media,
    { website: config.website },
  );
  if (projected.length === 0) {
    return {
      kind: "unavailable",
      presentation: branded("unavailable"),
      facts,
      windowed: items,
    };
  }
  return {
    kind: "playing",
    presentation: {
      state: "playing",
      items: projected,
      generation,
      takeover: selection.source === "takeover",
    },
    facts,
    windowed: items,
  };
}

function projectionContext(
  input: ResolveInput,
  media: readonly MediaBinding[],
): ProjectionContextV1 {
  return {
    schema: input.manifest.schemaVersion,
    clockOffsetMs: input.clockOffsetMs,
    manifest: input.manifest as unknown as Record<string, unknown>,
    media: [...media],
    ...(input.config.playback ? { playback: input.config.playback } : {}),
  };
}

// ---------------------------------------------------------------- closure

const PLACEHOLDER = "tcreq:";

function withoutWindow<T extends AvailabilityWindow>(value: T): T {
  const { availableFrom: _from, expiresAt: _until, ...rest } = value;
  return rest as T;
}

/** The manifest assets a scan of an emitted presentation names. */
function placeholderIndices(emitted: unknown): Set<number> {
  const found = new Set<number>();
  for (const match of JSON.stringify(emitted).matchAll(
    new RegExp(`${PLACEHOLDER}(\\d+)`, "g"),
  )) {
    found.add(Number(match[1]));
  }
  return found;
}

/**
 * The assets this presentation could display if every availability window
 * were open. Asset windows change the presentation only for these assets, so
 * their boundaries bound the plan. A window on an asset the presentation can
 * never reach changes nothing the viewer sees.
 */
function reachableAssets(
  input: ResolveInput,
  placeholders: readonly MediaBinding[],
): Set<number> {
  const manifest = {
    ...input.manifest,
    assets: input.manifest.assets.map(withoutWindow),
  };
  const probe = { ...input, manifest };
  const built = build(probe, placeholders, 0, true);
  const emitted: unknown[] = [built.presentation];
  if (built.kind === "playing" && built.presentation.state === "playing") {
    try {
      emitted.push(
        createProjector(projectionContext(probe, placeholders))?.project(
          built.presentation,
          input.at.getTime() - input.clockOffsetMs,
        ),
      );
    } catch {
      /* A reference the Runtime cannot project shows no media. */
    }
  }
  return placeholderIndices(emitted);
}

/** Walks plugin configuration for `<name>AssetId` / `<name>VariantId` pairs. */
function pluginMediaPairs(
  value: unknown,
  depth = 0,
): { assetId: string; variantId: string }[] {
  if (!value || typeof value !== "object" || depth > 4) return [];
  if (Array.isArray(value))
    return value.flatMap((entry) => pluginMediaPairs(entry, depth + 1));
  const record = value as Record<string, unknown>;
  const pairs: { assetId: string; variantId: string }[] = [];
  for (const [key, entry] of Object.entries(record)) {
    const match = /^(.*)(?:A|a)ssetId$/.exec(key);
    if (match && typeof entry === "string" && entry) {
      const prefix = match[1] ?? "";
      const variant = record[`${prefix}${prefix ? "V" : "v"}ariantId`];
      if (typeof variant === "string" && variant)
        pairs.push({ assetId: entry, variantId: variant });
    } else if (entry && typeof entry === "object") {
      pairs.push(...pluginMediaPairs(entry, depth + 1));
    }
  }
  return pairs;
}

function componentsIn(
  value: unknown,
  found: Map<string, number>,
  depth = 0,
): void {
  if (!value || typeof value !== "object" || depth > 12) return;
  if (Array.isArray(value)) {
    for (const entry of value) componentsIn(entry, found, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  const component = record["component"] as
    { type?: unknown; version?: unknown } | undefined;
  if (
    component &&
    typeof component.type === "string" &&
    typeof component.version === "number"
  ) {
    found.set(
      component.type,
      Math.max(found.get(component.type) ?? 0, component.version),
    );
  }
  for (const entry of Object.values(record))
    componentsIn(entry, found, depth + 1);
}

/**
 * Plans the presentation for one Server selection. The result names the exact
 * verified media required and reports compatibility; it is plain data.
 */
export function planPresentation(input: ResolveInput): PresentationPlan {
  const { manifest, at } = input;
  const placeholders: MediaBinding[] = manifest.assets.map((asset, index) => ({
    assetId: asset.assetId,
    variantId: asset.variantId,
    uri: `${PLACEHOLDER}${index}`,
  }));
  let built = build(input, placeholders, 0);
  const emitted: unknown[] = [built.presentation];
  const components = new Map<string, number>();
  if (built.kind === "playing" && built.presentation.state === "playing") {
    try {
      const projector = createProjector(projectionContext(input, placeholders));
      const projected = projector?.project(
        built.presentation,
        at.getTime() - input.clockOffsetMs,
      );
      emitted.push(projected);
      componentsIn(projected, components);
    } catch {
      // A reference the Runtime could not project would not render either.
      built = {
        kind: "unavailable",
        presentation: statusSurface("unavailable", input.config),
        facts: built.facts,
        windowed: built.windowed,
      };
      emitted.length = 0;
      emitted.push(built.presentation);
    }
  }
  const needed = placeholderIndices(emitted);
  const logo = logoAsset(manifest, at);
  if (logo) needed.add(manifest.assets.indexOf(logo));
  const catalog = new Map(
    manifest.assets.map((asset, index) => [
      assetKey(asset.assetId, asset.variantId),
      index,
    ]),
  );
  for (const plugin of manifest.plugins ?? []) {
    for (const pair of pluginMediaPairs(
      (plugin as { config?: unknown }).config,
    )) {
      const index = catalog.get(assetKey(pair.assetId, pair.variantId));
      if (index !== undefined && isAvailableAt(manifest.assets[index], at))
        needed.add(index);
    }
  }
  const requirements = [...needed]
    .filter((index) => index >= 0)
    .map((index) => manifest.assets[index]!)
    .map<MediaRequirement>((asset) => ({
      assetId: asset.assetId,
      variantId: asset.variantId,
      digest: asset.sha256.toLowerCase(),
      size: asset.fileSize,
      mimeType: asset.mimeType,
      downloadPath: asset.downloadPath,
    }))
    .sort(
      (a, b) =>
        a.assetId.localeCompare(b.assetId) ||
        a.variantId.localeCompare(b.variantId),
    );

  const required = Object.fromEntries(components);
  const failures: CompatibilityFailure[] = [];
  if (input.support) {
    for (const [type, version] of components) {
      const supported = input.support.widgetComponents[`widget.${type}`];
      if (supported === undefined || supported < version)
        failures.push({
          code: "widget_component_unsupported",
          component: type,
          version,
        });
    }
  }

  const catalogIndex = (assetId: string, variantId: string) =>
    catalog.get(assetKey(assetId, variantId));
  const windowed: (AvailabilityWindow | undefined)[] = [...built.windowed];
  if (nextAvailabilityTransition([...manifest.assets, ...built.windowed], at)) {
    // Some window is still to come. Only the ones that can change what this
    // presentation shows bound the plan.
    const reachable = reachableAssets(input, placeholders);
    const { logoAssetId, logoVariantId } = manifest.branding ?? {};
    const logoIndex =
      logoAssetId && logoVariantId
        ? catalogIndex(logoAssetId, logoVariantId)
        : undefined;
    if (logoIndex !== undefined) reachable.add(logoIndex);
    for (const plugin of manifest.plugins ?? []) {
      for (const pair of pluginMediaPairs(
        (plugin as { config?: unknown }).config,
      )) {
        const index = catalogIndex(pair.assetId, pair.variantId);
        if (index !== undefined) reachable.add(index);
      }
    }
    for (const index of reachable) windowed.push(manifest.assets[index]);
  }
  const boundaries = [
    nextAvailabilityTransition(windowed, at),
    input.nextEvaluationAt && input.nextEvaluationAt.getTime() > at.getTime()
      ? input.nextEvaluationAt
      : null,
  ].filter((value): value is Date => value !== null);
  const validUntil = boundaries.length
    ? new Date(Math.min(...boundaries.map((value) => value.getTime())))
    : null;

  return {
    input,
    kind: built.kind,
    selection: built.facts,
    requirements,
    compatibility: { required, failures },
    validUntil,
  };
}

/**
 * Builds the Runtime messages for a plan. `media` must authorize every
 * requirement of the plan; a missing binding throws instead of rendering
 * partially.
 */
export function realizePresentation(
  plan: PresentationPlan,
  media: readonly MediaBinding[],
  activation: ActivationRefV1,
): ResolvedPresentation {
  const built = build(plan.input, media, activation.generation);
  if (built.kind !== plan.kind)
    throw new Error("Presentation changed between planning and realization");
  return {
    kind: built.kind,
    presentation: {
      type: "presentation",
      activation,
      presentation: built.presentation,
      projection: projectionContext(plan.input, media),
    },
    plugins: {
      type: "plugins",
      plugins: (plan.input.manifest.plugins ??
        []) as unknown as PluginsMessage["plugins"],
      clockOffsetMs: plan.input.clockOffsetMs,
      media: [...media],
    },
  };
}
