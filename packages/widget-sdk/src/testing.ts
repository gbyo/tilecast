/**
 * Deterministic Widget harnesses for unit tests, Storybook and visual
 * regression. They build the same WidgetContext and WidgetResources shapes
 * production hosts build, so a story or test exercises the production API.
 */
import {
  TILECAST_DISPLAY_THEME,
  type WidgetClock,
  type WidgetContext,
  type WidgetTheme,
  type WidgetTimer,
} from "./context.ts";
import { WidgetRegistry, type AnyWidgetDefinition } from "./definition.ts";
import {
  WidgetMount,
  type WidgetComponentRef,
  type WidgetMountState,
} from "./mount.ts";
import {
  createWidgetResources,
  type WidgetDataDocument,
  type WidgetMediaRef,
  type WidgetResources,
} from "./resources.ts";

export interface ManualWidgetClock extends WidgetClock {
  /** Move time forward, firing due timers in deadline order. */
  advance(milliseconds: number): void;
  /** Jump corrected wall time without moving monotonic time. */
  setNow(correctedMs: number): void;
  /** Timers that are scheduled and not cancelled. */
  readonly pendingTimers: number;
}

interface ManualTimer {
  id: number;
  at: number;
  run: () => void;
  cancelled: boolean;
}

export const FIXTURE_NOW = Date.parse("2026-09-28T14:25:36Z");

export function createManualClock(
  nowMs: number = FIXTURE_NOW,
): ManualWidgetClock {
  let wall = nowMs;
  let monotonic = 1_000;
  let nextId = 1;
  let timers: ManualTimer[] = [];
  const clock: ManualWidgetClock = {
    now: () => wall,
    monotonicNow: () => monotonic,
    after(delayMs: number, run: () => void): WidgetTimer {
      const timer: ManualTimer = {
        id: nextId++,
        at: monotonic + Math.max(0, delayMs),
        run,
        cancelled: false,
      };
      timers.push(timer);
      return {
        cancel() {
          timer.cancelled = true;
        },
      };
    },
    advance(milliseconds: number) {
      const end = monotonic + milliseconds;
      for (;;) {
        timers = timers.filter((timer) => !timer.cancelled);
        const due = timers
          .filter((timer) => timer.at <= end)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        wall += due.at - monotonic;
        monotonic = due.at;
        due.cancelled = true;
        due.run();
      }
      wall += end - monotonic;
      monotonic = end;
    },
    setNow(correctedMs: number) {
      wall = correctedMs;
    },
    get pendingTimers() {
      return timers.filter((timer) => !timer.cancelled).length;
    },
  };
  return clock;
}

export interface TestContextOptions {
  clock?: WidgetClock;
  locale?: string;
  timeZone?: string;
  hourCycle?: "locale" | "h12" | "h23";
  theme?: WidgetTheme;
  reducedMotion?: boolean;
  mode?: "playback" | "preview";
}

export function createTestContext(
  options: TestContextOptions = {},
): WidgetContext {
  return Object.freeze({
    clock: options.clock ?? createManualClock(),
    locale: options.locale ?? "en-US",
    timeZone: options.timeZone ?? "America/Chicago",
    hourCycle: options.hourCycle ?? "locale",
    theme: options.theme ?? TILECAST_DISPLAY_THEME,
    motion: Object.freeze({ reduced: options.reducedMotion ?? true }),
    mode: options.mode ?? "preview",
  });
}

export interface FixtureResourceInput {
  documents?: Record<string, WidgetDataDocument>;
  /** Fixture media aliases keyed by `${assetId}/${variantId}`. */
  media?: Record<string, string>;
}

/** Resources that grant every fixture document and media alias. */
export function fixtureResources(
  input: FixtureResourceInput = {},
): WidgetResources {
  const documents = new Map(Object.entries(input.documents ?? {}));
  const media = new Map(Object.entries(input.media ?? {}));
  const mediaRefs: WidgetMediaRef[] = [...media.keys()].map((key) => {
    const [assetId = "", variantId = ""] = key.split("/");
    return { assetId, variantId };
  });
  return createWidgetResources(
    { documents, media },
    { dataSources: [...documents.keys()], media: mediaRefs },
  );
}

export interface MountedTestWidget {
  readonly mount: WidgetMount;
  readonly container: HTMLElement;
  readonly states: WidgetMountState[];
  readonly element: HTMLElement | null;
  dispose(): void;
}

/**
 * Mount one definition into a fresh container attached to the document.
 * The container is sized so container queries have a box to query.
 */
export function mountForTest(
  definition: AnyWidgetDefinition,
  options: {
    config: unknown;
    version?: number;
    resources?: WidgetResources;
    context?: WidgetContext;
    width?: number;
    height?: number;
    container?: HTMLElement;
    registry?: WidgetRegistry;
  },
): MountedTestWidget {
  const container = options.container ?? document.createElement("div");
  if (!options.container) {
    container.style.setProperty("width", `${options.width ?? 960}px`);
    container.style.setProperty("height", `${options.height ?? 540}px`);
    document.body.appendChild(container);
  }
  const states: WidgetMountState[] = [];
  const component: WidgetComponentRef = {
    type: definition.type,
    version: options.version ?? definition.version,
    config: options.config,
  };
  const mount = new WidgetMount({
    registry: options.registry ?? new WidgetRegistry([definition]),
    container,
    component,
    resources: options.resources ?? fixtureResources(),
    context: options.context ?? createTestContext(),
    onState: (state) => states.push(state),
  });
  return {
    mount,
    container,
    states,
    get element() {
      return mount.element;
    },
    dispose() {
      mount.dispose();
      if (!options.container) container.remove();
    },
  };
}
