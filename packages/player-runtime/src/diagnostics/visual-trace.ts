/**
 * Opt-in visual tracing: structured, timestamped records of what the Runtime
 * believes its compositor-driven layers are doing (transitions, startup
 * reveal), for correlation with the frames a host presents.
 *
 * Tracing exists only when the host injects a sink before the Runtime loads
 * (`globalThis.__tilecastVisualTrace`, see `docs/tilecast-edge-visual-trace.md`).
 * A host injects it only when an operator asks for it on that screen. Without
 * the sink every entry point here is a check of one constant boolean: call
 * sites guard with `trace.enabled` before they build any record, so normal
 * playback allocates nothing and runs no extra code per frame.
 *
 * Records never carry content: no item IDs, zone IDs, URLs or text. Identity
 * is a Runtime-local ordinal (transition, animation, layout, zone, mount) or a
 * token from a closed set (layer "a"/"b", item kind, phase). Times are
 * `performance.now()` milliseconds, the document timeline that animation
 * start and current times also use.
 *
 * Plain mode reads nothing from layout or style and schedules nothing per
 * frame: it only records at points the Runtime already passes through, and
 * listens to promises the engine resolves anyway. Deep mode (the sink says
 * `deep: true`) samples computed opacity and transform every animation frame
 * while a transition runs. That forces style resolution and main-thread
 * frames that an accelerated animation would not otherwise need, so it can
 * change the timing it measures. Use it only after plain mode.
 */

export const VISUAL_TRACE_SCHEMA = "tilecast-visual-v1";
export const VISUAL_TRACE_GLOBAL = "__tilecastVisualTrace";

/** Where a record comes from. */
export type TraceScope = "stage" | "zone" | "startup" | "trace";

export type TraceValue = number | boolean | string | null;
export type TraceFields = Readonly<Record<string, TraceValue>>;

export interface TraceRecord {
  /** `performance.now()` in milliseconds, rounded to microseconds. */
  t: number;
  scope: TraceScope;
  ev: string;
  [field: string]: TraceValue;
}

export interface TraceBatch {
  schema: typeof VISUAL_TRACE_SCHEMA;
  /** Batch sequence number, from 1. */
  seq: number;
  /** `performance.now()` when the batch was handed to the host. */
  sentAt: number;
  /** Records dropped since the previous batch because a bound was reached. */
  dropped: number;
  records: TraceRecord[];
}

/** What a host injects. Frozen by the host; checked here before use. */
export interface VisualTraceSink {
  schema: typeof VISUAL_TRACE_SCHEMA;
  deep: boolean;
  emit(batch: TraceBatch): void;
  /**
   * False once the host's trace window has ended. Optional: a sink without it
   * stays active for the life of the document.
   */
  active?(): boolean;
}

/** Identity attached to every record of one traced transition. */
export interface TraceTag {
  scope: TraceScope;
  fields: TraceFields;
}

/** Bounds; the host applies its own bounds again. */
export const TRACE_LIMITS = {
  /** Records waiting for the next batch. */
  pending: 512,
  /** Records per batch. */
  batch: 128,
  /** Records over the life of one document. */
  total: 50_000,
  /** Keys per record, including t, scope and ev. */
  keys: 24,
  /** Length of a string value. */
  string: 48,
  /** Flush delay for a partial batch, in milliseconds. */
  flushMs: 250,
} as const;

const TOKEN = /^[A-Za-z0-9_.:-]*$/;
const KEY = /^[A-Za-z][A-Za-z0-9]{0,23}$/;

export interface VisualTrace {
  readonly enabled: boolean;
  readonly deep: boolean;
  /** Records one event. A field that is not a bounded token is dropped. */
  record(scope: TraceScope, event: string, fields?: TraceFields): void;
  /** Next ordinal in an identity space ("transition", "layout", ...). */
  nextId(space: string): number;
  /**
   * Records an animation's creation, readiness (start time, current time,
   * play state) and end, under one animation ordinal. Returns the ordinal.
   */
  watchAnimation(
    tag: TraceTag,
    label: string,
    animation: Animation,
    element?: Element,
  ): number;
  /** Deep mode: samples `element` every frame until the returned stop runs. */
  sample(tag: TraceTag, label: string, element: Element): () => void;
  /** Sends what is pending now (tests, and before a document unloads). */
  flush(): void;
}

const noop = () => undefined;

const DISABLED: VisualTrace = Object.freeze({
  enabled: false,
  deep: false,
  record: noop,
  nextId: () => 0,
  watchAnimation: () => 0,
  sample: () => noop,
  flush: noop,
});

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Accepts only values that cannot carry content. */
export function traceValue(value: unknown): TraceValue | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? round(value) : null;
  if (
    typeof value === "string" &&
    value.length <= TRACE_LIMITS.string &&
    TOKEN.test(value)
  )
    return value;
  return undefined;
}

/** A sink is usable only when it is exactly the shape a host injects. */
export function isVisualTraceSink(value: unknown): value is VisualTraceSink {
  if (!value || typeof value !== "object") return false;
  const sink = value as Partial<VisualTraceSink>;
  return (
    sink.schema === VISUAL_TRACE_SCHEMA &&
    typeof sink.deep === "boolean" &&
    typeof sink.emit === "function" &&
    (sink.active === undefined || typeof sink.active === "function")
  );
}

function timing(animation: Animation): TraceFields {
  const startTime = animation.startTime;
  const currentTime = animation.currentTime;
  return {
    playState: traceValue(animation.playState) ?? null,
    startTime: typeof startTime === "number" ? round(startTime) : null,
    currentTime: typeof currentTime === "number" ? round(currentTime) : null,
  };
}

/** The effect's end on the animation's own timeline, so a trace can tell an
 * animation that reached its end from one cancelled before it. */
function effectEnd(animation: Animation): TraceFields {
  const effect = (animation as Partial<Animation>).effect;
  if (!effect || typeof effect.getComputedTiming !== "function") return {};
  const end = effect.getComputedTiming().endTime;
  return typeof end === "number" && Number.isFinite(end)
    ? { endTime: round(end) }
    : {};
}

interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  requestAnimationFrame?(callback: (time: number) => void): unknown;
  getComputedStyle?(element: Element): { opacity: string; transform: string };
}

function browserClock(): Clock {
  return {
    now: () => performance.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    ...(typeof requestAnimationFrame === "function"
      ? {
          requestAnimationFrame: (callback: (time: number) => void) =>
            requestAnimationFrame(callback),
        }
      : {}),
    ...(typeof getComputedStyle === "function"
      ? { getComputedStyle: (element: Element) => getComputedStyle(element) }
      : {}),
  };
}

class ActiveVisualTrace implements VisualTrace {
  readonly enabled = true;
  readonly deep: boolean;
  private pending: TraceRecord[] = [];
  private dropped = 0;
  private total = 0;
  private seq = 0;
  private flushScheduled = false;
  private stopped = false;
  private readonly ids = new Map<string, number>();
  private readonly samples = new Map<
    number,
    { tag: TraceTag; label: string; element: Element }
  >();
  private sampling = false;

  constructor(
    private readonly sink: VisualTraceSink,
    private readonly clock: Clock,
  ) {
    this.deep = sink.deep;
  }

  record(scope: TraceScope, event: string, fields?: TraceFields): void {
    if (this.stopped) return;
    if (!this.sinkActive()) {
      this.stop();
      return;
    }
    if (this.total >= TRACE_LIMITS.total) {
      this.push({ t: round(this.clock.now()), scope: "trace", ev: "limit" });
      this.flush();
      this.stop();
      return;
    }
    if (this.pending.length >= TRACE_LIMITS.pending) {
      this.dropped += 1;
      return;
    }
    const record: TraceRecord = {
      t: round(this.clock.now()),
      scope,
      ev: traceValue(event) === event ? event : "invalid",
    };
    let keys = 3;
    if (fields) {
      for (const [key, raw] of Object.entries(fields)) {
        if (keys >= TRACE_LIMITS.keys) break;
        if (!KEY.test(key) || key === "t" || key === "scope" || key === "ev")
          continue;
        const value = traceValue(raw);
        if (value === undefined) continue;
        record[key] = value;
        keys += 1;
      }
    }
    this.push(record);
  }

  nextId(space: string): number {
    const next = (this.ids.get(space) ?? 0) + 1;
    this.ids.set(space, next);
    return next;
  }

  watchAnimation(
    tag: TraceTag,
    label: string,
    animation: Animation,
    element?: Element,
  ): number {
    const anim = this.nextId("animation");
    const base = { ...tag.fields, anim, label };
    this.record(tag.scope, "anim.create", {
      ...base,
      ...timing(animation),
      ...effectEnd(animation),
    });
    const ready = (animation as Partial<Animation>).ready;
    if (ready && typeof ready.then === "function") {
      ready.then(
        () =>
          this.record(tag.scope, "anim.ready", {
            ...base,
            ...timing(animation),
          }),
        () => undefined,
      );
    }
    const finished = (animation as Partial<Animation>).finished;
    if (finished && typeof finished.then === "function") {
      finished.then(
        () =>
          this.record(tag.scope, "anim.finish", {
            ...base,
            ...timing(animation),
          }),
        () =>
          this.record(tag.scope, "anim.cancel", {
            ...base,
            ...timing(animation),
          }),
      );
    }
    if (this.deep && element && !this.stopped) {
      const stop = this.sample(tag, label, element);
      if (finished && typeof finished.then === "function")
        finished.then(stop, stop);
    }
    return anim;
  }

  sample(tag: TraceTag, label: string, element: Element): () => void {
    if (this.stopped || !this.deep || !this.clock.requestAnimationFrame)
      return noop;
    const id = this.nextId("sample");
    this.samples.set(id, { tag, label, element });
    this.startSampling();
    return () => {
      this.samples.delete(id);
    };
  }

  flush(): void {
    this.flushScheduled = false;
    while (this.pending.length > 0 || this.dropped > 0) {
      const records = this.pending.splice(0, TRACE_LIMITS.batch);
      this.seq += 1;
      const batch: TraceBatch = {
        schema: VISUAL_TRACE_SCHEMA,
        seq: this.seq,
        sentAt: round(this.clock.now()),
        dropped: this.dropped,
        records,
      };
      this.dropped = 0;
      try {
        this.sink.emit(batch);
      } catch {
        // A diagnostic sink never affects presentation.
      }
    }
  }

  /** Ends recording and sampling: at the record limit or when the host's window ends. */
  private stop(): void {
    this.stopped = true;
    this.samples.clear();
    this.pending = [];
    this.dropped = 0;
  }

  private sinkActive(): boolean {
    try {
      return this.sink.active === undefined || this.sink.active() !== false;
    } catch {
      return false;
    }
  }

  private push(record: TraceRecord): void {
    this.total += 1;
    this.pending.push(record);
    if (this.pending.length >= TRACE_LIMITS.batch) {
      this.flush();
    } else if (!this.flushScheduled) {
      this.flushScheduled = true;
      this.clock.setTimeout(() => this.flush(), TRACE_LIMITS.flushMs);
    }
  }

  private startSampling(): void {
    if (this.sampling) return;
    this.sampling = true;
    const frame = (time: number) => {
      if (this.samples.size > 0 && !this.sinkActive()) this.stop();
      if (this.samples.size === 0) {
        this.sampling = false;
        return;
      }
      for (const { tag, label, element } of this.samples.values()) {
        const style = this.clock.getComputedStyle?.(element);
        const fields: Record<string, TraceValue> = {
          ...tag.fields,
          label,
          frameTime: round(time),
        };
        if (style) {
          const opacity = Number.parseFloat(style.opacity);
          fields.opacity = Number.isFinite(opacity) ? round(opacity) : null;
          fields.transformed = style.transform !== "none";
        }
        const animations =
          typeof element.getAnimations === "function"
            ? element.getAnimations()
            : [];
        fields.animations = animations.length;
        const first = animations[0];
        if (first) Object.assign(fields, timing(first));
        this.record(tag.scope, "deep.sample", fields);
      }
      this.clock.requestAnimationFrame!(frame);
    };
    this.clock.requestAnimationFrame!(frame);
  }
}

let current: VisualTrace | null = null;

/**
 * The trace for this document: active only when the host injected a valid
 * sink before the Runtime started.
 */
export function visualTrace(): VisualTrace {
  if (current) return current;
  const sink = (globalThis as Record<string, unknown>)[VISUAL_TRACE_GLOBAL];
  current = isVisualTraceSink(sink)
    ? new ActiveVisualTrace(sink, browserClock())
    : DISABLED;
  if (current.enabled) {
    current.record("trace", "start", {
      schema: VISUAL_TRACE_SCHEMA,
      deep: current.deep,
    });
  }
  return current;
}

/** Tests: install a trace with an explicit sink and clock, or none. */
export function installVisualTraceForTest(
  sink: VisualTraceSink | null,
  clock?: Partial<Clock>,
): VisualTrace {
  current = sink
    ? new ActiveVisualTrace(sink, { ...browserClock(), ...clock })
    : DISABLED;
  return current;
}
