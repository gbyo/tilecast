/**
 * A controllable HTMLMediaElement for jsdom tests.
 *
 * jsdom implements neither playback nor seeking. This installs a small model
 * on `HTMLMediaElement.prototype` so a test can decide exactly when metadata
 * arrives, when a seek completes and how far media time has advanced, and can
 * count every decoder (element) the code under test creates. Nothing here
 * ships: only `*.test.ts` files import it.
 */
import { vi } from "vitest";

export interface FakeMediaState {
  currentTimeS: number;
  readyState: number;
  seeking: boolean;
  paused: boolean;
  ended: boolean;
  durationS: number;
  playbackRate: number;
  error: { message: string } | null;
  frameCallbacks: Map<number, VideoFrameRequestCallback>;
  nextFrameId: number;
}

export interface RecordedSeek {
  element: HTMLMediaElement;
  toMs: number;
}

export interface RecordedRate {
  element: HTMLMediaElement;
  rate: number;
}

export class FakeMedia {
  /** Every <video> element created through document.createElement. */
  readonly created: HTMLVideoElement[] = [];
  /** Every seek issued after metadata was available. */
  readonly seeks: RecordedSeek[] = [];
  readonly rates: RecordedRate[] = [];
  plays = 0;
  pauses = 0;
  loads = 0;
  private readonly states = new WeakMap<HTMLMediaElement, FakeMediaState>();
  private readonly restore: (() => void)[] = [];

  static install(): FakeMedia {
    const media = new FakeMedia();
    media.patch();
    return media;
  }

  uninstall(): void {
    for (const undo of this.restore.splice(0).reverse()) undo();
  }

  state(element: HTMLMediaElement): FakeMediaState {
    let state = this.states.get(element);
    if (!state) {
      state = {
        currentTimeS: 0,
        readyState: 0,
        seeking: false,
        paused: true,
        ended: false,
        durationS: 60,
        playbackRate: 1,
        error: null,
        frameCallbacks: new Map(),
        nextFrameId: 1,
      };
      this.states.set(element, state);
    }
    return state;
  }

  /** Metadata and enough data to play: the element can be swapped in. */
  ready(element: HTMLMediaElement): void {
    const state = this.state(element);
    state.readyState = 4;
    element.dispatchEvent(new Event("loadedmetadata"));
    element.dispatchEvent(new Event("canplay"));
  }

  /** Finish the seek in flight. */
  completeSeek(element: HTMLMediaElement): void {
    const state = this.state(element);
    if (!state.seeking) return;
    state.seeking = false;
    element.dispatchEvent(new Event("seeked"));
  }

  /** Advance media time as a playing element would. */
  play(element: HTMLMediaElement, wallMs: number): void {
    const state = this.state(element);
    if (state.paused || state.seeking || state.readyState < 3) return;
    state.currentTimeS = Math.min(
      state.durationS,
      state.currentTimeS + (wallMs / 1_000) * state.playbackRate,
    );
    if (state.currentTimeS >= state.durationS) {
      state.ended = true;
      state.paused = true;
      element.dispatchEvent(new Event("ended"));
    }
    element.dispatchEvent(new Event("timeupdate"));
  }

  /** Present one decoded frame at `mediaTimeS`. */
  frame(element: HTMLMediaElement, mediaTimeS: number): void {
    const state = this.state(element);
    const callbacks = [...state.frameCallbacks.values()];
    state.frameCallbacks.clear();
    for (const callback of callbacks) {
      callback(0, {
        mediaTime: mediaTimeS,
        presentedFrames: 1,
        presentationTime: 0,
        expectedDisplayTime: 0,
        width: 1,
        height: 1,
      });
    }
  }

  fail(element: HTMLMediaElement, message = "decode error"): void {
    this.state(element).error = { message };
    element.dispatchEvent(new Event("error"));
  }

  /** The element the page created most recently. */
  get last(): HTMLVideoElement {
    return this.created[this.created.length - 1]!;
  }

  private patch(): void {
    const proto = HTMLMediaElement.prototype;
    const self = this;
    const define = (name: string, descriptor: PropertyDescriptor) => {
      const original = Object.getOwnPropertyDescriptor(proto, name);
      Object.defineProperty(proto, name, {
        configurable: true,
        ...descriptor,
      });
      this.restore.push(() => {
        if (original) Object.defineProperty(proto, name, original);
        else delete (proto as unknown as Record<string, unknown>)[name];
      });
    };
    define("currentTime", {
      get(this: HTMLMediaElement) {
        return self.state(this).currentTimeS;
      },
      set(this: HTMLMediaElement, value: number) {
        const state = self.state(this);
        state.currentTimeS = value;
        state.ended = false;
        // Before metadata a write is only the default start position.
        if (state.readyState < 1) return;
        state.seeking = true;
        self.seeks.push({ element: this, toMs: value * 1_000 });
        this.dispatchEvent(new Event("seeking"));
      },
    });
    for (const name of [
      "readyState",
      "seeking",
      "paused",
      "ended",
      "duration",
      "error",
    ] as const) {
      define(name, {
        get(this: HTMLMediaElement) {
          const state = self.state(this);
          return name === "duration" ? state.durationS : state[name];
        },
      });
    }
    define("playbackRate", {
      get(this: HTMLMediaElement) {
        return self.state(this).playbackRate;
      },
      set(this: HTMLMediaElement, value: number) {
        const state = self.state(this);
        if (state.playbackRate === value) return;
        state.playbackRate = value;
        self.rates.push({ element: this, rate: value });
      },
    });
    define("play", {
      value(this: HTMLMediaElement) {
        const state = self.state(this);
        self.plays += 1;
        state.paused = false;
        return Promise.resolve();
      },
    });
    define("pause", {
      value(this: HTMLMediaElement) {
        self.pauses += 1;
        self.state(this).paused = true;
      },
    });
    define("load", {
      value(this: HTMLMediaElement) {
        self.loads += 1;
        const state = self.state(this);
        state.readyState = 0;
        state.paused = true;
      },
    });
    const video = HTMLVideoElement.prototype as unknown as Record<
      string,
      unknown
    >;
    const defineVideo = (name: string, value: unknown) => {
      const original = Object.getOwnPropertyDescriptor(video, name);
      Object.defineProperty(video, name, { configurable: true, value });
      this.restore.push(() => {
        if (original) Object.defineProperty(video, name, original);
        else delete video[name];
      });
    };
    defineVideo(
      "requestVideoFrameCallback",
      function (this: HTMLVideoElement, callback: VideoFrameRequestCallback) {
        const state = self.state(this);
        const id = state.nextFrameId++;
        state.frameCallbacks.set(id, callback);
        return id;
      },
    );
    defineVideo(
      "cancelVideoFrameCallback",
      function (this: HTMLVideoElement, id: number) {
        self.state(this).frameCallbacks.delete(id);
      },
    );

    const create = document.createElement.bind(document);
    const spy = vi.spyOn(document, "createElement").mockImplementation(((
      tag: string,
      options?: ElementCreationOptions,
    ) => {
      const element = create(tag, options);
      if (tag.toLowerCase() === "video") {
        self.created.push(element as HTMLVideoElement);
      }
      return element;
    }) as typeof document.createElement);
    this.restore.push(() => spy.mockRestore());
  }
}

/** Let promise continuations (prepare(), play()) run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
