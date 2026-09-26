import { afterEach, describe, expect, it, vi } from "vitest";
import { ManualClock } from "../clock/scheduler";
import {
  createMicrophoneCapture,
  MicrophoneService,
  type MicrophoneCaptureOptions,
} from "./microphone";

describe("microphone lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeTrack() {
    const listeners: Array<() => void> = [];
    return {
      stopped: false,
      addEventListener(_name: string, listener: () => void) {
        listeners.push(listener);
      },
      removeEventListener(_name: string, listener: () => void) {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      },
      stop() {
        this.stopped = true;
      },
      end() {
        for (const listener of [...listeners]) listener();
      },
    };
  }

  function fakeStream(track: ReturnType<typeof fakeTrack>) {
    return {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream;
  }

  function fakeContext(amplitude: { value: number }) {
    const context = {
      closed: false,
      connected: [] as string[],
      createMediaStreamSource: () => ({
        connect: (target: unknown) => {
          context.connected.push(
            (target as { role?: string }).role ?? "unknown",
          );
        },
        disconnect: () => {},
      }),
      createAnalyser: () => ({
        role: "analyser",
        fftSize: 2_048,
        smoothingTimeConstant: 1,
        getFloatTimeDomainData: (target: Float32Array) => {
          target.fill(amplitude.value);
        },
      }),
      close: () => {
        context.closed = true;
        return Promise.resolve();
      },
      destination: { role: "destination" },
    };
    return context;
  }

  it("samples a level without ever reaching the speakers", async () => {
    vi.useFakeTimers();
    const amplitude = { value: 0.5 };
    const track = fakeTrack();
    const context = fakeContext(amplitude);
    const levels: (number | null)[] = [];
    const capture = createMicrophoneCapture({
      onLevel: (rms) => levels.push(rms),
      requestStream: () => Promise.resolve(fakeStream(track)),
      createContext: () => context as unknown as AudioContext,
      observeDeviceChange: () => () => {},
      sampleIntervalMs: 60,
    });
    capture.start();
    await vi.advanceTimersByTimeAsync(200);
    expect(levels.length).toBeGreaterThanOrEqual(3);
    expect(levels[0]).toBeCloseTo(0.5, 5);
    // The graph ends at the analyser. Monitoring the room through the display's
    // own speakers would feed the meter back into itself.
    expect(context.connected).toEqual(["analyser"]);
    expect(context.connected).not.toContain("destination");
    capture.stop();
    expect(track.stopped).toBe(true);
    expect(context.closed).toBe(true);
  });

  it("fails open and retries when permission or hardware is missing", async () => {
    vi.useFakeTimers();
    const amplitude = { value: 0.25 };
    const track = fakeTrack();
    const diagnostics: string[] = [];
    const levels: (number | null)[] = [];
    let attempts = 0;
    const capture = createMicrophoneCapture({
      onLevel: (rms) => levels.push(rms),
      onDiagnostic: (message) => diagnostics.push(message),
      requestStream: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("Permission denied"))
          : Promise.resolve(fakeStream(track));
      },
      createContext: () => fakeContext(amplitude) as unknown as AudioContext,
      observeDeviceChange: () => () => {},
      retryIntervalMs: 10_000,
      sampleIntervalMs: 60,
    });
    capture.start();
    await vi.advanceTimersByTimeAsync(0);
    // A missing microphone reports itself and lets the bar come down; it never
    // throws into the renderer or blocks playback.
    expect(levels).toEqual([null]);
    expect(diagnostics.some((entry) => entry.includes("unavailable"))).toBe(
      true,
    );
    await vi.advanceTimersByTimeAsync(10_100);
    expect(attempts).toBe(2);
    expect(levels.at(-1)).toBeCloseTo(0.25, 5);
    capture.stop();
  });

  it("reports the input as unavailable when the microphone is unplugged", async () => {
    vi.useFakeTimers();
    const amplitude = { value: 0.3 };
    const track = fakeTrack();
    const context = fakeContext(amplitude);
    const levels: (number | null)[] = [];
    const capture = createMicrophoneCapture({
      onLevel: (rms) => levels.push(rms),
      requestStream: () => Promise.resolve(fakeStream(track)),
      createContext: () => context as unknown as AudioContext,
      observeDeviceChange: () => () => {},
      sampleIntervalMs: 60,
    });
    capture.start();
    await vi.advanceTimersByTimeAsync(120);
    levels.length = 0;
    track.end();
    expect(levels).toEqual([null]);
    expect(context.closed).toBe(true);
    capture.stop();
  });

  it("recovers as soon as a device is plugged back in", async () => {
    vi.useFakeTimers();
    const amplitude = { value: 0.4 };
    const track = fakeTrack();
    let attempts = 0;
    let notifyDeviceChange = () => {};
    const capture = createMicrophoneCapture({
      onLevel: () => {},
      requestStream: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("no device"))
          : Promise.resolve(fakeStream(track));
      },
      createContext: () => fakeContext(amplitude) as unknown as AudioContext,
      observeDeviceChange: (listener) => {
        notifyDeviceChange = listener;
        return () => {
          notifyDeviceChange = () => {};
        };
      },
      retryIntervalMs: 10_000,
    });
    capture.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    // Well before the ten-second retry would have fired.
    notifyDeviceChange();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(2);
    capture.stop();
  });

  it("releases the microphone when the plugin is torn down", async () => {
    vi.useFakeTimers();
    const amplitude = { value: 0.2 };
    const track = fakeTrack();
    const context = fakeContext(amplitude);
    let released = false;
    const capture = createMicrophoneCapture({
      onLevel: () => {},
      requestStream: () => Promise.resolve(fakeStream(track)),
      createContext: () => context as unknown as AudioContext,
      observeDeviceChange: () => () => {
        released = true;
      },
    });
    capture.start();
    await vi.advanceTimersByTimeAsync(120);
    expect(capture.active).toBe(true);
    capture.stop();
    expect(capture.active).toBe(false);
    expect(track.stopped).toBe(true);
    expect(context.closed).toBe(true);
    expect(released).toBe(true);
  });
});

describe("microphone service", () => {
  const clock = () => new ManualClock({ wallMs: 0 });

  it("delivers host-measured levels to every open handle, clamped", () => {
    const service = new MicrophoneService({
      source: "host-levels",
      clock: clock(),
      report: () => {},
      diagnostic: () => {},
    });
    const microphone = service.forPlugin();
    const levels: (number | null)[] = [];
    const handle = microphone.open((rms) => levels.push(rms));
    service.hostLevel(0.5);
    service.hostLevel(4);
    service.hostLevel(Number.NaN);
    service.hostLevel(null);
    handle?.close();
    service.hostLevel(0.25);
    expect(levels).toEqual([0.5, 1, null, null]);
  });

  it("ignores host levels when the renderer measures", () => {
    const opened: MicrophoneCaptureOptions[] = [];
    let stopped = 0;
    const service = new MicrophoneService({
      source: "renderer-microphone",
      clock: clock(),
      report: () => {},
      diagnostic: () => {},
      createCapture: (options) => {
        opened.push(options);
        return {
          start() {},
          stop() {
            stopped += 1;
          },
          active: true,
        };
      },
    });
    const levels: (number | null)[] = [];
    const handle = service.forPlugin().open((rms) => levels.push(rms));
    service.hostLevel(0.9);
    expect(levels).toEqual([]);
    expect(opened).toHaveLength(1);
    opened[0]?.onLevel(0.3);
    expect(levels).toEqual([0.3]);
    handle?.close();
    expect(stopped).toBe(1);
  });

  it("has nothing to open without a source", () => {
    const service = new MicrophoneService({
      source: null,
      clock: clock(),
      report: () => {},
      diagnostic: () => {},
    });
    expect(service.forPlugin().open(() => {})).toBeNull();
  });

  it("forwards reports and diagnostics unchanged", () => {
    const reports: unknown[] = [];
    const diagnostics: string[] = [];
    const service = new MicrophoneService({
      source: "host-levels",
      clock: clock(),
      report: (report) => reports.push(report),
      diagnostic: (message) => diagnostics.push(message),
    });
    const microphone = service.forPlugin();
    microphone.report({ status: "active", level: null });
    microphone.diagnostic("checked");
    expect(reports).toEqual([{ status: "active", level: null }]);
    expect(diagnostics).toEqual(["checked"]);
  });
});
