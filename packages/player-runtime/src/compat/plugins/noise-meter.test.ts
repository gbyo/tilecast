import { tilecastNoiseMeter } from "./noise-meter";
import { afterEach, describe, expect, it, vi } from "vitest";

interface NoiseMeterPlugin {
  id: string;
  type: string;
  version: number;
  config: {
    name?: string;
    message?: string;
    warningLevel: number;
    loudLevel: number;
    sensitivity: number;
    triggerHoldMs: number;
    clearHoldMs: number;
    displayMode: string;
    heightPx: number;
    scheduleEnabled?: boolean;
    scheduleDaysOfWeek?: number[];
    scheduleStartTime?: string | null;
    scheduleEndTime?: string | null;
    scheduleTimezone?: string;
  };
}

interface Settings {
  id: string;
  scheduleEnabled: boolean;
  scheduleDaysOfWeek: number[];
  scheduleStartTime: string | null;
  scheduleEndTime: string | null;
  scheduleTimezone: string;
  name: string;
  message: string;
  warningLevel: number;
  loudLevel: number;
  sensitivity: number;
  triggerHoldMs: number;
  clearHoldMs: number;
  displayMode: "overlay" | "push";
  heightPx: number;
}

interface HistoryBucket {
  startedAt: string;
  averageLevel: number;
  peakLevel: number;
  monitoredMs: number;
  warningMs: number;
  loudMs: number;
  triggerCount: number;
}

interface Reading {
  state: "normal" | "triggering" | "loud" | "recovering" | "unavailable";
  visible: boolean;
  level: number;
}

interface NoiseMeterModule {
  resolve(plugins: unknown[] | null | undefined): Settings | null;
  stripOwner(candidates: {
    alertTicker: boolean;
    noiseMeter: boolean;
    countdownBar: boolean;
  }): "alert_ticker" | "noise_meter" | "countdown_bar" | "none";
  levelFromRms(rms: number, sensitivity: number): number;
  createSmoother(options?: { attackMs?: number; releaseMs?: number }): {
    push(level: number, nowMs: number): number;
    reset(): void;
  };
  createStateMachine(settings: {
    warningLevel: number;
    loudLevel: number;
    triggerHoldMs: number;
    clearHoldMs: number;
  }): { update(level: number | null, nowMs: number): Reading; reset(): void };
  createHistoryAggregator(settings: {
    warningLevel: number;
    loudLevel: number;
  }): {
    push(
      level: number | null,
      atMs: number,
      enteredLoud?: boolean,
    ): HistoryBucket | null;
    flush(): HistoryBucket | null;
    reset(): void;
  };
  readonly historyBucketMs: number;
  scheduleOpen(
    settings: {
      scheduleEnabled: boolean;
      scheduleDaysOfWeek: number[];
      scheduleStartTime: string | null;
      scheduleEndTime: string | null;
      scheduleTimezone: string;
    },
    at: Date,
  ): boolean;
  createCapture(options: {
    onLevel(rms: number | null): void;
    onDiagnostic?(message: string, detail?: Record<string, unknown>): void;
    retryIntervalMs?: number;
    sampleIntervalMs?: number;
    requestStream?(): Promise<MediaStream>;
    createContext?(): AudioContext;
    observeDeviceChange?(listener: () => void): () => void;
  }): { start(): void; stop(): void; readonly active: boolean };
  readonly sampleIntervalMs: number;
}

const meter = tilecastNoiseMeter;

function instance(
  overrides: Partial<NoiseMeterPlugin["config"]> = {},
  id = "meter-1",
): NoiseMeterPlugin {
  return {
    id,
    type: "noise_meter",
    version: 1,
    config: {
      name: "Cafeteria noise",
      message: "Please lower the volume",
      warningLevel: 60,
      loudLevel: 80,
      sensitivity: 100,
      triggerHoldMs: 1_000,
      clearHoldMs: 3_000,
      displayMode: "overlay",
      heightPx: 96,
      ...overrides,
    },
  };
}

/** The default thresholds, as one machine under test. */
function machine(
  overrides: Partial<{
    warningLevel: number;
    loudLevel: number;
    triggerHoldMs: number;
    clearHoldMs: number;
  }> = {},
) {
  return meter.createStateMachine({
    warningLevel: 60,
    loudLevel: 80,
    triggerHoldMs: 1_000,
    clearHoldMs: 3_000,
    ...overrides,
  });
}

describe("noise meter resolution", () => {
  it("ignores plugin types and versions it does not implement", () => {
    expect(
      meter.resolve([
        { id: "bar-1", type: "countdown_bar", version: 1, config: {} },
        { id: "meter-2", type: "noise_meter", version: 2, config: {} },
      ]),
    ).toBeNull();
    expect(meter.resolve([])).toBeNull();
    expect(meter.resolve(null)).toBeNull();
  });

  it("resolves one meter, because one screen has one microphone", () => {
    const resolved = meter.resolve([
      instance({}, "meter-b"),
      instance({ name: "Gym" }, "meter-a"),
    ]);
    // Deterministic rather than whichever the server happened to list first.
    expect(resolved?.id).toBe("meter-a");
    expect(resolved?.name).toBe("Gym");
  });

  it("clamps every configured bound defensively", () => {
    const resolved = meter.resolve([
      instance({
        warningLevel: 0,
        loudLevel: 400,
        sensitivity: 5_000,
        triggerHoldMs: 1,
        clearHoldMs: 90_000,
        heightPx: 4,
        displayMode: "corner",
      }),
    ]);
    expect(resolved).toMatchObject({
      warningLevel: 1,
      loudLevel: 100,
      sensitivity: 300,
      triggerHoldMs: 100,
      clearHoldMs: 30_000,
      heightPx: 40,
      displayMode: "overlay",
    });
  });

  it("keeps the warning level below the loud level", () => {
    // One value cannot both raise and clear the bar, whatever the manifest says.
    const resolved = meter.resolve([
      instance({ warningLevel: 90, loudLevel: 80 }),
    ]);
    expect(resolved?.warningLevel).toBeLessThan(resolved!.loudLevel);
  });
});

describe("noise level normalization", () => {
  it("maps silence safely to the bottom of the scale", () => {
    expect(meter.levelFromRms(0, 100)).toBe(0);
    expect(meter.levelFromRms(-1, 100)).toBe(0);
    expect(meter.levelFromRms(Number.NaN, 100)).toBe(0);
    // -60 dBFS is the floor of the scale, so anything quieter still lands at 0.
    expect(meter.levelFromRms(0.0001, 100)).toBe(0);
  });

  it("maps a clipping input safely to the top of the scale", () => {
    expect(meter.levelFromRms(1, 100)).toBe(100);
    expect(meter.levelFromRms(8, 100)).toBe(100);
  });

  it("rises monotonically between the two ends", () => {
    const quiet = meter.levelFromRms(0.01, 100);
    const talking = meter.levelFromRms(0.05, 100);
    const shouting = meter.levelFromRms(0.4, 100);
    expect(quiet).toBeGreaterThan(0);
    expect(talking).toBeGreaterThan(quiet);
    expect(shouting).toBeGreaterThan(talking);
    expect(shouting).toBeLessThan(100);
  });

  it("clamps sensitivity rather than trusting it", () => {
    // 25-300 percent are the bounds; anything outside them is pulled in, so a
    // hand-edited manifest cannot make every room read as 100.
    expect(meter.levelFromRms(0.05, 100_000)).toBe(
      meter.levelFromRms(0.05, 300),
    );
    expect(meter.levelFromRms(0.05, 1)).toBe(meter.levelFromRms(0.05, 25));
    expect(meter.levelFromRms(0.05, -10)).toBe(meter.levelFromRms(0.05, 25));
    // A missing value is an omission rather than a floor, so it reads as 100.
    expect(meter.levelFromRms(0.05, undefined as unknown as number)).toBe(
      meter.levelFromRms(0.05, 100),
    );
    // Turning it up raises the reading for the same room.
    expect(meter.levelFromRms(0.05, 200)).toBeGreaterThan(
      meter.levelFromRms(0.05, 100),
    );
  });
});

describe("noise level smoothing", () => {
  it("never produces an invalid value", () => {
    const smoother = meter.createSmoother();
    const inputs = [0, 100, Number.NaN, Number.POSITIVE_INFINITY, -50, 42];
    let at = 0;
    for (const input of inputs) {
      at += 60;
      const value = smoother.push(input, at);
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
    expect(Number.isFinite(smoother.push(50, Number.NaN))).toBe(true);
  });

  it("starts at the first reading rather than climbing from zero", () => {
    const smoother = meter.createSmoother();
    expect(smoother.push(70, 0)).toBe(70);
  });

  it("follows a sustained rise and lags a momentary dip", () => {
    const smoother = meter.createSmoother();
    smoother.push(20, 0);
    let at = 0;
    for (let step = 0; step < 20; step += 1) {
      at += 60;
      smoother.push(90, at);
    }
    expect(smoother.push(90, at + 60)).toBeGreaterThan(85);
    // One quiet window in a loud room must not drop the meter to that window.
    expect(smoother.push(0, at + 120)).toBeGreaterThan(50);
  });
});

describe("noise meter state machine", () => {
  it("stays hidden while the room is normal", () => {
    const state = machine();
    for (let at = 0; at <= 10_000; at += 250) {
      const reading = state.update(35, at);
      expect(reading.visible).toBe(false);
      expect(reading.state).toBe("normal");
    }
  });

  it("does not show the bar for a brief spike", () => {
    const state = machine();
    state.update(30, 0);
    expect(state.update(95, 100).state).toBe("triggering");
    expect(state.update(95, 400).visible).toBe(false);
    // The door slams, and the room is quiet again well inside the hold.
    expect(state.update(30, 600).state).toBe("normal");
    expect(state.update(30, 2_000).visible).toBe(false);
  });

  it("shows the bar only after the level stays loud for the trigger hold", () => {
    const state = machine();
    state.update(30, 0);
    expect(state.update(85, 500).visible).toBe(false);
    expect(state.update(85, 1_400).visible).toBe(false);
    expect(state.update(85, 1_500).state).toBe("loud");
    expect(state.update(85, 1_500).visible).toBe(true);
  });

  it("stays visible while the room remains loud", () => {
    const state = machine();
    state.update(90, 0);
    state.update(90, 1_100);
    for (let at = 2_000; at < 60_000; at += 500) {
      const reading = state.update(70 + (at % 1_000 === 0 ? 20 : 15), at);
      expect(reading.visible).toBe(true);
    }
  });

  it("begins recovery below the clear threshold and hides after the clear hold", () => {
    const state = machine();
    state.update(90, 0);
    state.update(90, 1_100);
    expect(state.update(50, 2_000).state).toBe("recovering");
    expect(state.update(50, 4_000).visible).toBe(true);
    expect(state.update(50, 4_999).visible).toBe(true);
    expect(state.update(50, 5_000).state).toBe("normal");
    expect(state.update(50, 5_000).visible).toBe(false);
  });

  it("cancels recovery when the room gets loud again", () => {
    const state = machine();
    state.update(90, 0);
    state.update(90, 1_100);
    expect(state.update(40, 2_000).state).toBe("recovering");
    expect(state.update(75, 3_000).state).toBe("loud");
    expect(state.update(75, 3_000).visible).toBe(true);
    // The hide timer restarted, so the original deadline passes with the bar up.
    expect(state.update(40, 4_000).state).toBe("recovering");
    expect(state.update(40, 5_000).visible).toBe(true);
    expect(state.update(40, 7_000).state).toBe("normal");
  });

  it("treats the thresholds as at-or-above and strictly-below", () => {
    const state = machine();
    state.update(0, 0);
    // Exactly the loud level counts as loud.
    expect(state.update(80, 10).state).toBe("triggering");
    expect(state.update(80, 1_100).state).toBe("loud");
    // Exactly the warning level is not yet a return to normal.
    expect(state.update(60, 2_000).state).toBe("loud");
    expect(state.update(59.9, 2_100).state).toBe("recovering");
  });

  it("hides the bar when the input disappears and resumes when it returns", () => {
    const state = machine();
    state.update(95, 0);
    state.update(95, 1_100);
    expect(state.update(95, 1_200).visible).toBe(true);
    // Someone unplugs the USB microphone.
    const lost = state.update(null, 1_500);
    expect(lost.state).toBe("unavailable");
    expect(lost.visible).toBe(false);
    expect(lost.level).toBe(0);
    expect(state.update(Number.NaN, 1_600).state).toBe("unavailable");
    // It comes back to a quiet room: normal, and the bar stays down.
    expect(state.update(20, 20_000).state).toBe("normal");
    // A room that is loud again has to earn the bar from the beginning.
    expect(state.update(95, 20_100).state).toBe("triggering");
    expect(state.update(95, 21_200).state).toBe("loud");
  });
});

describe("bottom strip arbitration", () => {
  it("gives an emergency ticker the strip over everything else", () => {
    expect(
      meter.stripOwner({
        alertTicker: true,
        noiseMeter: true,
        countdownBar: true,
      }),
    ).toBe("alert_ticker");
  });

  it("gives the noise meter the strip over a countdown bar", () => {
    expect(
      meter.stripOwner({
        alertTicker: false,
        noiseMeter: true,
        countdownBar: true,
      }),
    ).toBe("noise_meter");
  });

  it("returns the strip to the noise meter when an emergency clears", () => {
    const loudRoom = { noiseMeter: true, countdownBar: true };
    expect(meter.stripOwner({ alertTicker: true, ...loudRoom })).toBe(
      "alert_ticker",
    );
    expect(meter.stripOwner({ alertTicker: false, ...loudRoom })).toBe(
      "noise_meter",
    );
  });

  it("returns the strip to the countdown bar when the room is normal again", () => {
    expect(
      meter.stripOwner({
        alertTicker: false,
        noiseMeter: false,
        countdownBar: true,
      }),
    ).toBe("countdown_bar");
    expect(
      meter.stripOwner({
        alertTicker: false,
        noiseMeter: false,
        countdownBar: false,
      }),
    ).toBe("none");
  });
});

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
    const capture = meter.createCapture({
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
    const capture = meter.createCapture({
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
    const capture = meter.createCapture({
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
    const capture = meter.createCapture({
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
    const capture = meter.createCapture({
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

describe("playback isolation", () => {
  it("only ever produces readings and strip ownership", () => {
    // The meter has no reference to presentation state, and the renderer wires
    // it to the same independent plugin channel Countdown Bar and the alert
    // ticker use. A full loud-and-back cycle therefore cannot advance the
    // playlist, remount media, or change the renderer generation, because the
    // only thing it emits is the reading below.
    const playback = { generation: 7, item: "video-1" };
    const state = machine();
    const readings: Reading[] = [];
    for (const [level, at] of [
      [30, 0],
      [95, 100],
      [95, 1_200],
      [95, 5_000],
      [20, 6_000],
      [20, 9_100],
    ] as const) {
      readings.push(state.update(level, at));
    }
    expect(readings.map((reading) => reading.visible)).toEqual([
      false,
      false,
      true,
      true,
      true,
      false,
    ]);
    expect(playback).toEqual({ generation: 7, item: "video-1" });
    expect(Object.isFrozen(meter)).toBe(true);
  });
});

describe("ten-second history aggregation", () => {
  const BASE = Date.UTC(2026, 7, 10, 12, 0, 0);

  function aggregator() {
    return meter.createHistoryAggregator({ warningLevel: 60, loudLevel: 80 });
  }

  /** Feed one level for a span of the bucket at the live sampling rate. */
  function feed(
    history: ReturnType<typeof aggregator>,
    level: number,
    fromMs: number,
    toMs: number,
    step = 60,
  ): HistoryBucket[] {
    const completed: HistoryBucket[] = [];
    for (let at = fromMs; at <= toMs; at += step) {
      const bucket = history.push(level, at);
      if (bucket) completed.push(bucket);
    }
    return completed;
  }

  it("aggregates live samples into one ten-second bucket", () => {
    const history = aggregator();
    feed(history, 40, BASE, BASE + 9_960);
    const bucket = history.push(40, BASE + 10_000);
    expect(bucket).not.toBeNull();
    expect(bucket!.startedAt).toBe(new Date(BASE).toISOString());
    expect(bucket!.monitoredMs).toBeGreaterThan(9_000);
    expect(bucket!.monitoredMs).toBeLessThanOrEqual(10_000);
  });

  it("averages by the time each level actually held", () => {
    const history = aggregator();
    // Five seconds at 20, five at 60: the average is the middle, and it is not
    // the mean of two readings but of the time they held.
    feed(history, 20, BASE, BASE + 5_000);
    feed(history, 60, BASE + 5_060, BASE + 9_960);
    const bucket = history.push(20, BASE + 10_000)!;
    expect(bucket.averageLevel).toBeGreaterThan(35);
    expect(bucket.averageLevel).toBeLessThan(45);
  });

  it("keeps the loudest reading as the peak", () => {
    const history = aggregator();
    feed(history, 30, BASE, BASE + 4_000);
    history.push(97, BASE + 4_060);
    feed(history, 30, BASE + 4_120, BASE + 9_960);
    const bucket = history.push(30, BASE + 10_000)!;
    expect(bucket.peakLevel).toBe(97);
    // One spike in ten seconds barely moves the average, which is exactly why
    // both numbers are stored.
    expect(bucket.averageLevel).toBeLessThan(40);
  });

  it("accumulates warning and loud time separately", () => {
    const history = aggregator();
    feed(history, 30, BASE, BASE + 2_000);
    feed(history, 70, BASE + 2_060, BASE + 5_000);
    feed(history, 90, BASE + 5_060, BASE + 9_960);
    const bucket = history.push(30, BASE + 10_000)!;
    // Roughly three seconds in the warning band and five in the loud one.
    expect(bucket.warningMs).toBeGreaterThan(2_500);
    expect(bucket.warningMs).toBeLessThan(3_500);
    expect(bucket.loudMs).toBeGreaterThan(4_400);
    expect(bucket.loudMs).toBeLessThan(5_400);
    expect(bucket.warningMs + bucket.loudMs).toBeLessThanOrEqual(
      bucket.monitoredMs,
    );
  });

  it("rolls over on the fixed grid rather than ten seconds after the last one", () => {
    const history = aggregator();
    // Starting mid-slot still closes on the grid boundary.
    feed(history, 50, BASE + 3_000, BASE + 12_000);
    const second = history.push(50, BASE + 20_000)!;
    expect(second.startedAt).toBe(new Date(BASE + 10_000).toISOString());
  });

  it("counts a trigger where the state machine enters its loud state", () => {
    const history = aggregator();
    history.push(90, BASE, true);
    feed(history, 90, BASE + 60, BASE + 4_000);
    history.push(90, BASE + 4_060, true);
    feed(history, 90, BASE + 4_120, BASE + 9_960);
    const bucket = history.push(90, BASE + 10_000)!;
    expect(bucket.triggerCount).toBe(2);
  });

  it("creates no bucket for a slot the microphone never covered", () => {
    const history = aggregator();
    // The input is gone: no readings, and therefore nothing to write down.
    expect(history.push(null, BASE + 1_000)).toBeNull();
    expect(history.push(null, BASE + 11_000)).toBeNull();
    expect(history.flush()).toBeNull();
  });

  it("keeps only the time it really measured when the input drops out", () => {
    const history = aggregator();
    feed(history, 50, BASE, BASE + 2_000);
    // Microphone unplugged for the rest of the slot.
    history.push(null, BASE + 2_060);
    const bucket = history.push(50, BASE + 10_000)!;
    // A partly monitored bucket must not read as ten seconds of quiet.
    expect(bucket.monitoredMs).toBeLessThan(3_000);
    expect(bucket.monitoredMs).toBeGreaterThan(1_500);
  });

  it("cannot be poisoned by an invalid measurement", () => {
    const history = aggregator();
    feed(history, 55, BASE, BASE + 5_000);
    history.push(Number.NaN, BASE + 5_060);
    history.push(Number.POSITIVE_INFINITY, BASE + 5_120);
    feed(history, 55, BASE + 5_180, BASE + 9_960);
    const bucket = history.push(55, BASE + 10_000)!;
    for (const value of [
      bucket.averageLevel,
      bucket.peakLevel,
      bucket.monitoredMs,
      bucket.warningMs,
      bucket.loudMs,
    ]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(bucket.averageLevel).toBeCloseTo(55, 0);
  });

  it("emits nothing but derived numbers", () => {
    const history = aggregator();
    feed(history, 45, BASE, BASE + 9_960);
    const bucket = history.push(45, BASE + 10_000)!;
    // No sample, no waveform, nothing replayable — by construction.
    expect(Object.keys(bucket).sort()).toEqual([
      "averageLevel",
      "loudMs",
      "monitoredMs",
      "peakLevel",
      "startedAt",
      "triggerCount",
      "warningMs",
    ]);
    expect(meter.historyBucketMs).toBe(10_000);
  });

  it("hands over a part-finished bucket when monitoring stops", () => {
    const history = aggregator();
    feed(history, 65, BASE, BASE + 3_000);
    const bucket = history.flush()!;
    expect(bucket.startedAt).toBe(new Date(BASE).toISOString());
    expect(bucket.monitoredMs).toBeGreaterThan(2_000);
    // Flushing closes it; there is nothing left behind to emit twice.
    expect(history.flush()).toBeNull();
  });
});

describe("display window", () => {
  function window(overrides: Partial<Settings> = {}) {
    return {
      scheduleEnabled: true,
      scheduleDaysOfWeek: [1, 2, 3, 4, 5],
      scheduleStartTime: "08:00",
      scheduleEndTime: "15:30",
      scheduleTimezone: "America/Chicago",
      ...overrides,
    } as Settings;
  }

  /** A local instant in the window's own zone, stated as UTC. */
  function chicago(day: number, hour: number, minute = 0) {
    // August, so Chicago is UTC-5.
    return new Date(Date.UTC(2026, 7, day, hour + 5, minute));
  }

  it("lets the bar show at any time when no window is configured", () => {
    const settings = window({ scheduleEnabled: false });
    expect(meter.scheduleOpen(settings, chicago(10, 3))).toBe(true);
    expect(meter.scheduleOpen(settings, chicago(9, 23))).toBe(true);
  });

  it("opens inside the window on a selected day", () => {
    // Monday 10 August 2026, mid-morning.
    expect(meter.scheduleOpen(window(), chicago(10, 10))).toBe(true);
  });

  it("is half-open at both bounds", () => {
    // The start is inside the window and the end is not, so two adjacent
    // windows cannot both claim the same minute.
    expect(meter.scheduleOpen(window(), chicago(10, 8, 0))).toBe(true);
    expect(meter.scheduleOpen(window(), chicago(10, 15, 29))).toBe(true);
    expect(meter.scheduleOpen(window(), chicago(10, 15, 30))).toBe(false);
    expect(meter.scheduleOpen(window(), chicago(10, 7, 59))).toBe(false);
  });

  it("stays closed on a day that was not selected", () => {
    // Saturday 15 August, inside the hours but not on a chosen day.
    expect(meter.scheduleOpen(window(), chicago(15, 10))).toBe(false);
  });

  it("treats an end at or before the start as an overnight window", () => {
    const overnight = window({
      scheduleStartTime: "21:00",
      scheduleEndTime: "02:00",
      scheduleDaysOfWeek: [1],
    });
    // Monday evening, and the small hours of Tuesday that belong to it.
    expect(meter.scheduleOpen(overnight, chicago(10, 22))).toBe(true);
    expect(meter.scheduleOpen(overnight, chicago(11, 1))).toBe(true);
    expect(meter.scheduleOpen(overnight, chicago(11, 2))).toBe(false);
    // Tuesday evening is not Monday's window.
    expect(meter.scheduleOpen(overnight, chicago(11, 22))).toBe(false);
  });

  it("evaluates the window in its own timezone", () => {
    const settings = window();
    // 13:00 UTC is 08:00 in Chicago: inside. The same instant read as UTC
    // would be outside, which is the bug a stated timezone prevents.
    expect(
      meter.scheduleOpen(settings, new Date(Date.UTC(2026, 7, 10, 13, 0))),
    ).toBe(true);
    expect(
      meter.scheduleOpen(settings, new Date(Date.UTC(2026, 7, 10, 21, 0))),
    ).toBe(false);
  });

  it("fails toward showing the bar when the window cannot be read", () => {
    // A room that is too loud is what this plugin exists to show, so an
    // unreadable window must not be what silences it.
    expect(
      meter.scheduleOpen(
        window({ scheduleTimezone: "Mars/Olympus" }),
        chicago(10, 3),
      ),
    ).toBe(true);
    expect(
      meter.scheduleOpen(
        window({ scheduleStartTime: "half eight" }),
        chicago(10, 3),
      ),
    ).toBe(true);
    expect(
      meter.scheduleOpen(window({ scheduleDaysOfWeek: [] }), chicago(10, 3)),
    ).toBe(true);
  });

  it("ignores a half-configured window when resolving an instance", () => {
    // Switched on with no times is not a window; it must not hide the bar
    // forever.
    const resolved = meter.resolve([
      instance({ scheduleEnabled: true, scheduleDaysOfWeek: [1] }),
    ]);
    expect(resolved?.scheduleEnabled).toBe(false);
    const configured = meter.resolve([
      instance({
        scheduleEnabled: true,
        scheduleDaysOfWeek: [1, 2],
        scheduleStartTime: "08:00",
        scheduleEndTime: "15:30",
        scheduleTimezone: "America/Chicago",
      }),
    ]);
    expect(configured?.scheduleEnabled).toBe(true);
    expect(configured?.scheduleDaysOfWeek).toEqual([1, 2]);
  });
});
