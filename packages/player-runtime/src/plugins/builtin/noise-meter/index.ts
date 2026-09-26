/**
 * MIGRATION ONLY. Noise Meter as a runtime plugin, kept in this package until
 * milestone 4 moves it to plugins/noise-meter. A live-tier claim on the
 * bottom strip while the room stays too loud inside the display window.
 *
 * The microphone comes from the host's generic microphone service: this
 * plugin receives RMS levels, never audio, and reports only its state and
 * ten-second aggregates. When neither the live bar nor history needs the
 * microphone, it closes it rather than measuring and discarding.
 */
import {
  defineRuntimePlugin,
  element,
  setStyles,
  type MicrophoneLevels,
  type SurfaceClaim,
  type TimerHandle,
} from "@tilecast/plugin-sdk/runtime";
import {
  tilecastNoiseMeter,
  type TilecastNoiseHistoryAggregator,
  type TilecastNoiseHistoryBucket,
  type TilecastNoiseMeterMachine,
  type TilecastNoiseMeterReading,
  type TilecastNoiseMeterSettings,
} from "./meter";

const ENTRANCE_MS = 1_400;

const words = (...nodes: (Element | null)[]) =>
  nodes
    .map((node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ");

export default defineRuntimePlugin({
  id: "noise_meter",
  tier: "live",
  manifestTypes: ["noise_meter"],
  surfaces: ["strip.bottom"],
  create(context) {
    const meter = tilecastNoiseMeter;
    const microphone = context.microphone ?? null;
    const smoother = meter.createSmoother();

    let settings: TilecastNoiseMeterSettings | null = null;
    let settingsKey = "";
    let machine: TilecastNoiseMeterMachine | null = null;
    let levels: MicrophoneLevels | null = null;
    let reading: TilecastNoiseMeterReading = {
      state: "unavailable",
      visible: false,
      level: 0,
    };
    let history: TilecastNoiseHistoryAggregator | null = null;
    let windowWasOpen = true;
    let lastReportedStatus = "";
    let shown = false;

    let root: HTMLElement | null = null;
    let marker: HTMLElement | null = null;
    let label: HTMLElement | null = null;
    let warning: HTMLElement | null = null;
    let entranceId = "";
    let entranceTimer: TimerHandle | null = null;

    const windowOpen = () =>
      settings !== null &&
      meter.scheduleOpen(settings, new Date(context.clock.now()));

    const historyWanted = () =>
      settings !== null &&
      settings.historyEnabled &&
      (context.awake() || !settings.historyActiveHoursOnly);

    const status = (): string => {
      if (!levels) return "inactive";
      switch (reading.state) {
        case "unavailable":
          return "unavailable";
        case "loud":
        case "recovering":
          return "loud";
        default:
          return "normal";
      }
    };

    /** On a state change and once per completed bucket, never per sample. */
    const reportState = (
      next: string,
      level: number | null,
      bucket: TilecastNoiseHistoryBucket | null = null,
    ) => {
      if (next === lastReportedStatus && bucket === null) return;
      lastReportedStatus = next;
      microphone?.report({ status: next, level, bucket });
    };

    const flushHistory = () => {
      const bucket = history?.flush() ?? null;
      if (bucket) microphone?.report({ status: status(), bucket });
    };

    const onSample = (rms: number | null) => {
      const current = settings;
      if (!current || !machine) return;
      const at = context.clock.monotonicNow();
      const level =
        rms === null
          ? null
          : smoother.push(meter.levelFromRms(rms, current.sensitivity), at);
      if (rms === null) smoother.reset();
      const previous = reading;
      reading = machine.update(level, at);
      // A trigger is counted where it happens: entering the loud state.
      const enteredLoud = reading.state === "loud" && previous.state !== "loud";
      if (history) {
        // Buckets sit on the fixed wall-clock grid, on the corrected clock.
        const bucket = history.push(level, context.clock.now(), enteredLoud);
        if (bucket) reportState(status(), reading.level, bucket);
      }
      reportState(status(), reading.level);
      if (reading.visible !== previous.visible) {
        // Handing the strip over is worth doing now, not on the next tick.
        context.invalidate();
        return;
      }
      if (reading.visible && shown && marker) {
        setStyles(marker, { left: `${reading.level}%` });
      }
    };

    /**
     * Open or close the microphone to match what is wanted now. The host
     * re-evaluates after this runs, so it never asks for an update itself.
     */
    const applyLifecycle = () => {
      const source = microphone?.source ?? null;
      const wantsHistory = historyWanted();
      const wantsLive = settings !== null && context.awake() && windowOpen();
      if (!settings || !source || (!wantsHistory && !wantsLive)) {
        flushHistory();
        history = null;
        levels?.close();
        levels = null;
        smoother.reset();
        reading = { state: "unavailable", visible: false, level: 0 };
        reportState("inactive", null);
        return;
      }
      if (wantsHistory) {
        history ??= meter.createHistoryAggregator(settings);
      } else if (history) {
        flushHistory();
        history = null;
      }
      if (!levels && microphone) {
        // With host-measured levels, "active" is how the host learns to open
        // its microphone, and "inactive" is how it learns to close it.
        if (source === "host-levels") reportState("active", null);
        levels = microphone.open(onSample);
      }
    };

    const syncSettings = (next: TilecastNoiseMeterSettings | null) => {
      const key = next === null ? "" : JSON.stringify(next);
      if (key === settingsKey && (next !== null || !levels)) return;
      settingsKey = key;
      settings = next;
      // Thresholds changed: the hysteresis and the open aggregate restart,
      // because a bucket measured against two thresholds is not one measurement.
      machine = next ? meter.createStateMachine(next) : null;
      applyLifecycle();
    };

    return {
      mount(_slot, container) {
        root = element("div", "tc-noise-meter");
        root.setAttribute("role", "status");
        label = element("span", "tc-noise-meter__label", "Noise level");
        const scale = element("span", "tc-noise-meter__scale");
        scale.setAttribute("aria-hidden", "true");
        for (const zone of ["normal", "warning", "loud"]) {
          scale.appendChild(
            element(
              "span",
              `tc-noise-meter__zone tc-noise-meter__zone--${zone}`,
            ),
          );
        }
        marker = element("span", "tc-noise-meter__marker");
        scale.appendChild(marker);
        warning = element("span", "tc-noise-meter__warning", "Too loud");
        root.append(label, scale, warning);
        container.appendChild(root);
      },

      update(entries) {
        syncSettings(meter.resolve(entries));
        const open = windowOpen();
        if (settings !== null && open !== windowWasOpen) {
          windowWasOpen = open;
          applyLifecycle();
        } else {
          windowWasOpen = open;
        }
        const claims: SurfaceClaim[] = [];
        if (settings && reading.visible && open) {
          claims.push({
            slot: "strip.bottom",
            priority: 0,
            heightPx: settings.heightPx,
            displayMode: settings.displayMode,
          });
        }
        return claims;
      },

      render(grant) {
        const now = grant.shown.has("strip.bottom") ? settings : null;
        shown = now !== null;
        if (!root || !warning) return;
        root.classList.toggle("tc-noise-meter--visible", shown);
        setStyles(root, {
          "--tc-noise-meter-warning": now ? `${now.warningLevel}%` : null,
          "--tc-noise-meter-loud": now ? `${now.loudLevel}%` : null,
        });
        warning.textContent = now ? now.message || "TOO LOUD" : "Too loud";
        if (!now) {
          entranceId = "";
          return;
        }
        if (now.id === entranceId) return;
        // A brief emphasis on the warning label when the bar arrives, and
        // nothing after that: a bar that keeps flashing stops being read.
        entranceId = now.id;
        root.classList.add("tc-noise-meter--entering");
        entranceTimer?.cancel();
        entranceTimer = context.clock.after(ENTRANCE_MS, () =>
          root?.classList.remove("tc-noise-meter--entering"),
        );
      },

      setAwake() {
        applyLifecycle();
      },

      describe() {
        return words(label, warning);
      },

      dispose() {
        levels?.close();
        levels = null;
      },
    };
  },
});
