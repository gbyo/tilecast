/**
 * The Player microphone as a runtime host service, for plugins that declare
 * hardware `microphone`. It yields root-mean-square levels and nothing else:
 * no sample leaves this module, nothing is recorded, stored, or transmitted,
 * and the capture graph is never connected to `context.destination`, so a
 * room is never played back through the display in front of it.
 *
 * Two sources exist. `renderer-microphone`: this document opens the input
 * with getUserMedia and measures it here. `host-levels`: the host process
 * measures and sends levels as `noise-level` messages. A plugin sees the same
 * contract either way.
 */
import type {
  MicrophoneLevels,
  MicrophoneSource,
  RuntimeMicrophone,
} from "@tilecast/plugin-sdk/runtime";
import {
  browserClock,
  type RuntimeClock,
  type TimerHandle,
} from "../clock/scheduler";

// ~16 updates a second: fast enough to read as live movement, slow enough to
// stay invisible on the low-end mini PCs these players run on.
export const MICROPHONE_SAMPLE_INTERVAL_MS = 60;
const RETRY_INTERVAL_MS = 10_000;
const SAMPLE_INTERVAL_MS = MICROPHONE_SAMPLE_INTERVAL_MS;

export interface MicrophoneCaptureOptions {
  /** Called with each window's RMS, or `null` when the input is unavailable. */
  onLevel(rms: number | null): void;
  onDiagnostic?(message: string, detail?: Record<string, unknown>): void;
  retryIntervalMs?: number;
  sampleIntervalMs?: number;
  requestStream?(): Promise<MediaStream>;
  createContext?(): AudioContext;
  /** Returns a function that removes the listener again. */
  observeDeviceChange?(listener: () => void): () => void;
  /** Timers for sampling and retries. Defaults to the browser clock. */
  clock?: RuntimeClock;
}

export interface MicrophoneCapture {
  start(): void;
  stop(): void;
  readonly active: boolean;
}

function defaultRequestStream(): Promise<MediaStream> {
  const media = (globalThis as { navigator?: Navigator }).navigator
    ?.mediaDevices;
  if (!media?.getUserMedia) {
    return Promise.reject(new Error("no media capture API is available"));
  }
  // Audio only, and with the three call-oriented processing features off:
  // echo cancellation, noise suppression, and automatic gain control all
  // rewrite level continuously, which is exactly what a room meter must not
  // have happening underneath it. A player whose stack ignores the hints
  // still works — the reading is simply less stable.
  return media.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  });
}

function defaultCreateContext(): AudioContext {
  const constructor = (globalThis as { AudioContext?: typeof AudioContext })
    .AudioContext;
  if (!constructor) throw new Error("no Web Audio API is available");
  return new constructor();
}

function defaultObserveDeviceChange(listener: () => void): () => void {
  const media = (globalThis as { navigator?: Navigator }).navigator
    ?.mediaDevices;
  if (!media?.addEventListener) return () => {};
  media.addEventListener("devicechange", listener);
  return () => media.removeEventListener("devicechange", listener);
}

export function createMicrophoneCapture(
  options: MicrophoneCaptureOptions,
): MicrophoneCapture {
  const retryIntervalMs = options.retryIntervalMs ?? RETRY_INTERVAL_MS;
  const sampleIntervalMs = options.sampleIntervalMs ?? SAMPLE_INTERVAL_MS;
  const requestStream = options.requestStream ?? defaultRequestStream;
  const createContext = options.createContext ?? defaultCreateContext;
  const observeDeviceChange =
    options.observeDeviceChange ?? defaultObserveDeviceChange;
  const diagnostic = options.onDiagnostic ?? (() => {});
  const clock = options.clock ?? browserClock();

  let wanted = false;
  let opening = false;
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let frame: Float32Array<ArrayBuffer> | null = null;
  let sampleTimer: TimerHandle | null = null;
  let retryTimer: TimerHandle | null = null;
  let releaseDeviceChange: (() => void) | null = null;

  function teardown(): void {
    sampleTimer?.cancel();
    sampleTimer = null;
    for (const track of stream?.getTracks() ?? []) {
      track.removeEventListener("ended", handleLoss);
      track.stop();
    }
    source?.disconnect();
    // Closing releases the audio device. A player that keeps a context open
    // for a plugin it no longer has would hold the microphone forever.
    void context?.close().catch(() => {});
    stream = null;
    context = null;
    source = null;
    analyser = null;
    frame = null;
  }

  function scheduleRetry(): void {
    if (!wanted || retryTimer !== null) return;
    retryTimer = clock.at(clock.monotonicNow() + retryIntervalMs, () => {
      retryTimer = null;
      void open();
    });
  }

  function fail(reason: string): void {
    teardown();
    // Fail open: the meter reports itself unavailable, the bar comes down,
    // and normal signage is untouched.
    options.onLevel(null);
    diagnostic("microphone input unavailable", { reason });
    scheduleRetry();
  }

  function handleLoss(): void {
    if (!wanted) return;
    fail("the microphone input ended");
  }

  function sample(): void {
    if (!analyser || !frame) return;
    try {
      analyser.getFloatTimeDomainData(frame);
    } catch (error) {
      fail(String(error));
      return;
    }
    let sum = 0;
    for (let index = 0; index < frame.length; index += 1) {
      const amplitude = frame[index] ?? 0;
      sum += amplitude * amplitude;
    }
    const rms = Math.sqrt(sum / frame.length);
    options.onLevel(Number.isFinite(rms) ? rms : 0);
  }

  async function open(): Promise<void> {
    if (!wanted || opening || analyser) return;
    opening = true;
    try {
      const opened = await requestStream();
      if (!wanted) {
        for (const track of opened.getTracks()) track.stop();
        return;
      }
      stream = opened;
      context = createContext();
      source = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      // Smoothing is applied to the normalized level instead, where its time
      // constant is expressed in milliseconds rather than in FFT frames.
      analyser.smoothingTimeConstant = 0;
      source.connect(analyser);
      // Deliberately not connected to context.destination: a room must never
      // be played back through the display it is being measured in front of.
      frame = new Float32Array(analyser.fftSize);
      for (const track of stream.getAudioTracks()) {
        track.addEventListener("ended", handleLoss);
      }
      sampleTimer = clock.every(sampleIntervalMs, sample);
      diagnostic("microphone opened");
    } catch (error) {
      fail(String(error));
    } finally {
      opening = false;
    }
  }

  return {
    start(): void {
      if (wanted) return;
      wanted = true;
      // A USB microphone plugged back in should recover in seconds rather
      // than on the next retry tick.
      releaseDeviceChange = observeDeviceChange(() => {
        if (!wanted || analyser) return;
        retryTimer?.cancel();
        retryTimer = null;
        void open();
      });
      void open();
    },
    stop(): void {
      wanted = false;
      retryTimer?.cancel();
      retryTimer = null;
      releaseDeviceChange?.();
      releaseDeviceChange = null;
      teardown();
    },
    get active(): boolean {
      return wanted;
    },
  };
}

export interface MicrophoneServiceOptions {
  source: MicrophoneSource | null;
  clock: RuntimeClock;
  report(report: {
    status: string;
    level?: number | null;
    bucket?: unknown;
  }): void;
  diagnostic(message: string, detail?: Record<string, unknown>): void;
  /** Tests replace the capture; production opens the real input. */
  createCapture?(options: MicrophoneCaptureOptions): MicrophoneCapture;
}

/**
 * One microphone for the Player. Levels from the host are delivered to every
 * open handle; a renderer capture is opened per handle and closed with it.
 */
export class MicrophoneService {
  private readonly listeners = new Set<(rms: number | null) => void>();

  constructor(private readonly options: MicrophoneServiceOptions) {}

  get source(): MicrophoneSource | null {
    return this.options.source;
  }

  /** A `noise-level` host message. Ignored unless the host measures. */
  hostLevel(rms: number | null): void {
    if (this.options.source !== "host-levels") return;
    const level =
      rms === null || !Number.isFinite(rms)
        ? null
        : Math.min(Math.max(rms, 0), 1);
    for (const listener of [...this.listeners]) listener(level);
  }

  /** The contract a plugin receives. */
  forPlugin(): RuntimeMicrophone {
    const service = this;
    return {
      get source() {
        return service.options.source;
      },
      open: (onLevel) => service.open(onLevel),
      report: (report) => service.options.report(report),
      diagnostic: (message, detail) =>
        service.options.diagnostic(message, detail),
    };
  }

  private open(onLevel: (rms: number | null) => void): MicrophoneLevels | null {
    switch (this.options.source) {
      case "host-levels": {
        this.listeners.add(onLevel);
        return { close: () => void this.listeners.delete(onLevel) };
      }
      case "renderer-microphone": {
        const capture = (this.options.createCapture ?? createMicrophoneCapture)(
          {
            onLevel,
            onDiagnostic: (message, detail) =>
              this.options.diagnostic(message, detail),
            clock: this.options.clock,
          },
        );
        capture.start();
        return { close: () => capture.stop() };
      }
      default:
        return null;
    }
  }
}
