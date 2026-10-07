import { describe, expect, it } from "vitest";
import {
  DisplayController,
  WAKE_LOCK_RETRY_MS,
  startControlLabel,
  type DisplayEnvironment,
  type WakeLockSentinelLike,
} from "./display";

function environment(
  initial: Partial<{
    visible: boolean;
    installed: boolean;
    wakeLock: boolean;
  }> = {},
) {
  const state = {
    visible: true,
    fullscreen: false,
    installed: false,
    activated: false,
    denyWakeLock: false,
    requests: 0,
    fullscreenRequests: 0,
    ...initial,
  };
  const fullscreen: (() => void)[] = [];
  const visibility: (() => void)[] = [];
  const sentinels: (WakeLockSentinelLike & {
    fire(): void;
    released: boolean;
  })[] = [];
  const env: DisplayEnvironment = {
    ...(initial.wakeLock === false
      ? {}
      : {
          requestWakeLock: async () => {
            state.requests += 1;
            if (state.denyWakeLock)
              throw new DOMException("denied", "NotAllowedError");
            const listeners: (() => void)[] = [];
            const sentinel = {
              released: false,
              release: async () => void (sentinel.released = true),
              addEventListener: (_: "release", listener: () => void) =>
                void listeners.push(listener),
              fire: () => listeners.forEach((listener) => listener()),
            };
            sentinels.push(sentinel);
            return sentinel;
          },
        }),
    requestFullscreen: async () => {
      state.fullscreenRequests += 1;
      state.fullscreen = true;
      state.activated = true;
      fullscreen.forEach((listener) => listener());
    },
    fullscreenActive: () => state.fullscreen,
    installedApp: () => state.installed,
    visible: () => state.visible,
    userActivated: () => state.activated,
    onFullscreenChange: (listener) => (
      fullscreen.push(listener),
      () => undefined
    ),
    onVisibilityChange: (listener) => (
      visibility.push(listener),
      () => undefined
    ),
  };
  return {
    env,
    state,
    sentinels,
    setVisible(value: boolean) {
      state.visible = value;
      visibility.forEach((listener) => listener());
    },
    leaveFullscreen() {
      state.fullscreen = false;
      fullscreen.forEach((listener) => listener());
    },
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("display privileges", () => {
  it("one operator action attempts fullscreen, the wake lock and audio", async () => {
    const h = environment();
    const display = new DisplayController(h.env);
    expect(display.operatorNeeds()).toEqual({
      audio: true,
      presentation: true,
    });
    const facts = await display.start();
    expect(facts).toMatchObject({
      fullscreenActive: true,
      wakeLock: "active",
      audioUnlocked: true,
    });
    expect(display.operatorNeeds()).toEqual({
      audio: false,
      presentation: false,
    });
    expect(startControlLabel(display.operatorNeeds(), true)).toBeNull();
  });

  it("does not require fullscreen inside an installed app", async () => {
    const h = environment({ installed: true });
    const display = new DisplayController(h.env);
    await display.start();
    expect(h.state.fullscreenRequests).toBe(0);
    expect(display.facts()).toMatchObject({
      displayMode: "standalone_pwa",
      unattendedPresentation: true,
    });
    expect(display.operatorNeeds().presentation).toBe(false);
  });

  it("reacquires a released wake lock when the page is visible again", async () => {
    const h = environment();
    const display = new DisplayController(h.env);
    await display.start();
    expect(display.facts().wakeLock).toBe("active");
    // The browser drops the lock when the page is hidden.
    h.setVisible(false);
    h.sentinels[0]!.fire();
    expect(display.facts().wakeLock).toBe("released");
    h.setVisible(true);
    await settle();
    expect(h.sentinels).toHaveLength(2);
    expect(display.facts().wakeLock).toBe("active");
  });

  it("never asks for a wake lock while the page is hidden", async () => {
    const h = environment({ visible: false });
    const display = new DisplayController(h.env);
    await display.maintain();
    expect(h.state.requests).toBe(0);
  });

  it("reports a denial and retries only after the pause", async () => {
    let now = 0;
    const h = environment();
    h.state.denyWakeLock = true;
    const display = new DisplayController(h.env, () => now);
    await display.maintain();
    expect(display.facts().wakeLock).toBe("denied");
    await display.maintain();
    expect(h.state.requests).toBe(1);
    h.state.denyWakeLock = false;
    now += WAKE_LOCK_RETRY_MS + 1;
    await display.maintain();
    expect(display.facts().wakeLock).toBe("active");
  });

  it("releases the lock outside active hours and takes it back after", async () => {
    const h = environment();
    const display = new DisplayController(h.env);
    await display.maintain();
    await display.setAwakeWanted(false);
    expect(h.sentinels[0]!.released).toBe(true);
    expect(display.facts().wakeLock).toBe("released");
    await display.setAwakeWanted(true);
    expect(display.facts().wakeLock).toBe("active");
  });

  it("does not request fullscreen again after it is exited, and says what is missing", async () => {
    const h = environment();
    const display = new DisplayController(h.env);
    await display.start();
    h.leaveFullscreen();
    await display.maintain();
    expect(h.state.fullscreenRequests).toBe(1);
    expect(display.operatorNeeds()).toEqual({
      audio: false,
      presentation: true,
    });
    expect(startControlLabel(display.operatorNeeds(), true)).toBe(
      "Enter fullscreen",
    );
  });

  it("states an unsupported wake lock instead of pretending", async () => {
    const h = environment({ wakeLock: false });
    const display = new DisplayController(h.env);
    await display.start();
    expect(display.facts().wakeLock).toBe("unsupported");
  });

  it("notifies listeners of every change", async () => {
    const h = environment();
    const display = new DisplayController(h.env);
    const seen: string[] = [];
    display.subscribe((facts) =>
      seen.push(`${facts.fullscreenActive}:${facts.wakeLock}`),
    );
    await display.start();
    h.leaveFullscreen();
    expect(seen.at(-1)).toBe("false:active");
  });

  it("labels the single control from what is still missing", () => {
    expect(startControlLabel({ audio: true, presentation: true }, false)).toBe(
      "Start player",
    );
    expect(startControlLabel({ audio: true, presentation: false }, true)).toBe(
      "Enable sound",
    );
    expect(
      startControlLabel({ audio: false, presentation: false }, true),
    ).toBeNull();
  });
});
