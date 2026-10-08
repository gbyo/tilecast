/**
 * On-demand live screen preview.
 *
 * Studio opens a short-lived (60s) preview lease while a screen page is open.
 * The player polls the lease and, while it is active, captures the window
 * roughly every 20 seconds (immediately on a fresh session or a manual
 * capture signal) and uploads a downscaled JPEG. Captures are not commands
 * and create no history. Protected states (pairing, safe mode, sleep) report
 * an unavailable status instead of uploading an image.
 *
 * The actual pixel capture and JPEG encoding are the host's job (Electron
 * capturePage); this coordinator owns only the polling/interval policy.
 */

import type { ApiClient } from "./api";
import { ApiError, NetworkError } from "./api";
import { logger } from "./log";

const log = logger("preview");

const IDLE_POLL_MS = 15_000;
const ACTIVE_CAPTURE_MS = 20_000;
const MAX_WIDTH = 960;
const MAX_HEIGHT = 540;
const MAX_BYTES = 500 * 1024;

export interface Capture {
  jpeg: Buffer;
  width: number;
  height: number;
}

export interface PreviewHost {
  /** Capture the current window scaled within max dimensions/bytes, or null
   * if the screen is in a protected state that must not be uploaded. */
  capture(max: {
    width: number;
    height: number;
    bytes: number;
  }): Promise<Capture | null>;
  playerVersion: string;
}

export class LivePreview {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private lastCaptureMs = 0;
  private busy = false;
  private wakePending = false;

  constructor(
    private readonly client: ApiClient,
    private readonly host: PreviewHost,
    private readonly now: () => number,
  ) {}

  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => void this.tick(), IDLE_POLL_MS);
    this.timer.unref?.();
    void this.tick();
  }

  sessionChanged(): void {
    if (this.stopped) return;
    if (this.busy) {
      this.wakePending = true;
      return;
    }
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.busy) {
      return;
    }
    this.busy = true;
    try {
      let session: Record<string, unknown> | null;
      try {
        session = await this.client.previewSession();
      } catch (err) {
        if (err instanceof ApiError && err.credentialRejected) {
          this.stop();
        }
        return; // no active lease reachable; try again next idle poll
      }
      if (!session || session["active"] === false) {
        return;
      }
      const manualCapture = session["captureNow"] === true;
      const due = this.now() - this.lastCaptureMs >= ACTIVE_CAPTURE_MS;
      if (!manualCapture && !due && this.lastCaptureMs !== 0) {
        return;
      }
      await this.captureAndUpload();
    } finally {
      this.busy = false;
      if (this.wakePending && !this.stopped) {
        this.wakePending = false;
        void this.tick();
      }
    }
  }

  private async captureAndUpload(): Promise<void> {
    let capture: Capture | null;
    try {
      capture = await this.host.capture({
        width: MAX_WIDTH,
        height: MAX_HEIGHT,
        bytes: MAX_BYTES,
      });
    } catch (err) {
      capture = null;
      log.debug("capture failed", { error: String(err) });
    }

    const form = new FormData();
    if (capture) {
      form.append("capturedAt", new Date(this.now()).toISOString());
      form.append("width", String(capture.width));
      form.append("height", String(capture.height));
      form.append("fileSize", String(capture.jpeg.byteLength));
      form.append("playerVersion", this.host.playerVersion);
      form.append(
        "preview",
        new Blob([new Uint8Array(capture.jpeg)], { type: "image/jpeg" }),
        "preview.jpg",
      );
    } else {
      // Protected state or capture failure: report status, never a black frame.
      form.append("failureStatus", "unavailable");
      form.append("playerVersion", this.host.playerVersion);
    }

    try {
      await this.client.postPreview(form);
      this.lastCaptureMs = this.now();
    } catch (err) {
      if (!(err instanceof NetworkError)) {
        log.debug("preview upload error", { error: String(err) });
      }
    }
  }
}
