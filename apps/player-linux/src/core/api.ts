/**
 * Typed HTTP client for the Tilecast server.
 *
 * Every response is unwrapped from the `{"data": ...}` / `{"error": {...}}`
 * envelope. Errors carry the server's stable error code so callers can make
 * exact decisions — in particular, a stored device credential is cleared
 * only on `device_credential_invalid` or `device_credential_revoked`, never
 * on network failures, 5xx, or `screen_disabled`.
 */

import type {
  CommandResultReport,
  EnrollmentResult,
  Heartbeat,
  HeartbeatAck,
  Identity,
  Manifest,
  PairingCreated,
  PairingPollResult,
  PlayerCommand,
  PlayerConfig,
  DeviceMetadata,
  UpdateMetadata,
  UpdateStatusReport,
} from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** The stored credential is proven dead; only these codes may clear it. */
  get credentialRejected(): boolean {
    return (
      this.code === "device_credential_invalid" ||
      this.code === "device_credential_revoked"
    );
  }

  get screenDisabled(): boolean {
    return this.code === "screen_disabled";
  }
}

/** Network-level failure (DNS, refused, timeout) — always retryable. */
export class NetworkError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "NetworkError";
  }
}

export interface ConditionalResult<T> {
  /** null when the server answered 304 Not Modified. */
  value: T | null;
  etag: string | null;
  notModified: boolean;
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * What one request cost and how it ended. Reported for every request from the
 * single choke point below, so the telemetry counters describe all of the
 * player's traffic rather than whichever call sites remembered to measure.
 */
export interface RequestObservation {
  /** Absent when no response arrived at all. */
  status?: number;
  /** Milliseconds until the response headers arrived. */
  timeToFirstByteMs: number;
  /** Milliseconds until the body was fully read. */
  durationMs: number;
  bytes: number;
  /** True when the previous attempt at this same endpoint failed. */
  retry: boolean;
}

/** How many endpoints' failure state is remembered, for retry attribution. */
const FAILED_ENDPOINT_LIMIT = 32;

export class ApiClient {
  private observer: ((observation: RequestObservation) => void) | null = null;
  /**
   * Endpoints whose last attempt failed. A request to one of them is a retry,
   * which is what makes "the player is hammering a failing endpoint" visible
   * as something other than ordinary traffic.
   */
  private failedEndpoints = new Set<string>();

  constructor(
    readonly baseUrl: string,
    private credential: string | null = null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Telemetry observes requests through this rather than by wrapping fetch. */
  observeRequests(observer: (observation: RequestObservation) => void): void {
    this.observer = observer;
  }

  setCredential(credential: string | null): void {
    this.credential = credential;
  }

  get hasCredential(): boolean {
    return this.credential !== null;
  }

  authHeaders(): Record<string, string> {
    return this.credential
      ? { Authorization: `Bearer ${this.credential}` }
      : {};
  }

  url(path: string): string {
    return this.baseUrl.replace(/\/+$/, "") + path;
  }

  private async request(
    method: string,
    path: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      auth?: boolean;
    } = {},
  ): Promise<{ status: number; headers: Headers; json: unknown }> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (options.auth !== false && this.credential) {
      headers["Authorization"] = `Bearer ${this.credential}`;
    }

    const endpoint = `${method} ${path}`;
    const retry = this.failedEndpoints.has(endpoint);
    const startedAt = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path), {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : null,
        signal: controller.signal,
      });
    } catch (err) {
      // No status: the request never reached a response, which is a different
      // fact from a server that answered with an error.
      this.finishRequest(endpoint, retry, startedAt, startedAt, 0, undefined);
      throw new NetworkError(`request failed: ${method} ${path}`, err);
    } finally {
      clearTimeout(timer);
    }
    const headersAt = Date.now();

    if (response.status === 304) {
      this.finishRequest(endpoint, retry, startedAt, headersAt, 0, 304);
      return { status: 304, headers: response.headers, json: null };
    }

    let json: unknown = null;
    const text = await response.text().catch(() => "");
    this.finishRequest(
      endpoint,
      retry,
      startedAt,
      headersAt,
      text.length,
      response.status,
    );
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }

    if (!response.ok) {
      const errObj =
        json && typeof json === "object" && "error" in json
          ? (json as { error: { code?: string; message?: string } }).error
          : undefined;
      throw new ApiError(
        response.status,
        errObj?.code ?? `http_${response.status}`,
        errObj?.message ?? `${method} ${path} failed with ${response.status}`,
      );
    }

    return { status: response.status, headers: response.headers, json };
  }

  /**
   * Reports the request and remembers whether this endpoint is currently
   * failing. The failure set is capped: a player that cannot reach the server at
   * all would otherwise accumulate an entry per distinct path it tried.
   */
  private finishRequest(
    endpoint: string,
    retry: boolean,
    startedAt: number,
    headersAt: number,
    bytes: number,
    status?: number,
  ): void {
    const failed = status === undefined || status >= 400;
    if (failed) {
      if (this.failedEndpoints.size < FAILED_ENDPOINT_LIMIT) {
        this.failedEndpoints.add(endpoint);
      }
    } else {
      this.failedEndpoints.delete(endpoint);
    }
    this.observer?.({
      status,
      timeToFirstByteMs: Math.max(0, headersAt - startedAt),
      durationMs: Math.max(0, Date.now() - startedAt),
      bytes,
      retry,
    });
  }

  private static data<T>(json: unknown): T {
    if (json && typeof json === "object" && "data" in json) {
      return (json as { data: T }).data;
    }
    throw new NetworkError("response missing data envelope");
  }

  // ---- Bootstrap and pairing (no device auth) -----------------------------

  async identity(): Promise<Identity> {
    const res = await this.request("GET", "/api/v1/system/identity", {
      auth: false,
    });
    return ApiClient.data<Identity>(res.json);
  }

  async createPairingSession(
    installationId: string,
    metadata: DeviceMetadata,
  ): Promise<PairingCreated> {
    const res = await this.request("POST", "/api/v1/player/pairing-sessions", {
      auth: false,
      body: { installationId, metadata },
    });
    return ApiClient.data<PairingCreated>(res.json);
  }

  async pollPairingSession(
    id: string,
    pollSecret: string,
  ): Promise<PairingPollResult> {
    const res = await this.request(
      "GET",
      `/api/v1/player/pairing-sessions/${id}`,
      { auth: false, headers: { Authorization: `Pairing ${pollSecret}` } },
    );
    return ApiClient.data<PairingPollResult>(res.json);
  }

  async enroll(
    pairingSessionId: string,
    enrollmentToken: string,
  ): Promise<EnrollmentResult> {
    const res = await this.request("POST", "/api/v1/player/enroll", {
      auth: false,
      body: { pairingSessionId, enrollmentToken },
    });
    return ApiClient.data<EnrollmentResult>(res.json);
  }

  // ---- Device-authenticated ------------------------------------------------

  async manifest(etag: string | null): Promise<ConditionalResult<Manifest>> {
    const headers: Record<string, string> = {};
    if (etag) {
      headers["If-None-Match"] = etag;
    }
    const res = await this.request("GET", "/api/v1/player/manifest", {
      headers,
    });
    if (res.status === 304) {
      return { value: null, etag, notModified: true };
    }
    return {
      value: ApiClient.data<Manifest>(res.json),
      etag: res.headers.get("ETag"),
      notModified: false,
    };
  }

  async config(etag: string | null): Promise<ConditionalResult<PlayerConfig>> {
    const headers: Record<string, string> = {};
    if (etag) {
      headers["If-None-Match"] = etag;
    }
    const res = await this.request("GET", "/api/v1/player/config", { headers });
    if (res.status === 304) {
      return { value: null, etag, notModified: true };
    }
    return {
      value: ApiClient.data<PlayerConfig>(res.json),
      etag: res.headers.get("ETag"),
      notModified: false,
    };
  }

  /**
   * Returns what the server acknowledged. Noise Meter history is only dropped
   * from the Player's queue once this response has been seen, so the result is
   * the acknowledgement rather than a fire-and-forget send.
   */
  async heartbeat(body: Heartbeat): Promise<HeartbeatAck> {
    const res = await this.request("POST", "/api/v1/player/heartbeat", {
      body,
    });
    try {
      return ApiClient.data<HeartbeatAck>(res.json);
    } catch {
      // An older server answers without the envelope this expects. The
      // heartbeat still succeeded; nothing was acknowledged.
      return { accepted: true };
    }
  }

  async fetchCommands(): Promise<PlayerCommand[]> {
    const res = await this.request("GET", "/api/v1/player/commands");
    const data = ApiClient.data<{ items: PlayerCommand[] }>(res.json);
    return data.items ?? [];
  }

  async acknowledgeCommand(id: string): Promise<void> {
    await this.request("POST", `/api/v1/player/commands/${id}/acknowledge`);
  }

  async reportCommandResult(
    id: string,
    result: CommandResultReport,
  ): Promise<void> {
    await this.request("POST", `/api/v1/player/commands/${id}/result`, {
      body: {
        success: result.success,
        code: result.code.slice(0, 80),
        message: result.message.slice(0, 240),
      },
    });
  }

  /** Fetch signed release metadata for a targeted player update. */
  async fetchUpdateMetadata(releaseId: string): Promise<UpdateMetadata> {
    const res = await this.request(
      "GET",
      `/api/v1/player/updates/${releaseId}`,
    );
    return ApiClient.data<UpdateMetadata>(res.json);
  }

  /** Report progress of an in-flight update deployment for this screen. */
  async reportUpdateStatus(
    deploymentId: string,
    body: UpdateStatusReport,
  ): Promise<void> {
    await this.request(
      "POST",
      `/api/v1/player/update-deployments/${deploymentId}/status`,
      {
        body: {
          state: body.state,
          downloadedBytes: body.downloadedBytes ?? 0,
          error: (body.error ?? "").slice(0, 240),
        },
      },
    );
  }

  /** Upload a bounded batch of append-only activity events (max 200). */
  async postActivityEvents(events: unknown[]): Promise<{
    accepted: number;
    duplicates: number;
    highestSequence: number;
    acknowledgedEventIds: string[];
  }> {
    const res = await this.request("POST", "/api/v1/player/activity-events", {
      body: { events },
    });
    return ApiClient.data<{
      accepted: number;
      duplicates: number;
      highestSequence: number;
      acknowledgedEventIds: string[];
    }>(res.json);
  }

  /**
   * Upload one bounded telemetry sample. Interval counters are deltas since
   * the previous sample, so the server can roll them up without the player
   * ever shipping raw high-frequency data.
   */
  async postTelemetry(sample: unknown): Promise<void> {
    await this.request("POST", "/api/v1/player/telemetry", { body: sample });
  }

  /**
   * Fetch Presentation Network provisioning material for THIS screen.
   *
   * The request carries no network identifier: the server derives the network
   * from the authenticated screen's own assignment, which is what makes it
   * impossible for one player to obtain another player's network. The response is
   * no-store, and its body is never logged.
   */
  async presentationNetworkProvisioning(): Promise<Record<string, unknown>> {
    const res = await this.request(
      "GET",
      "/api/v1/player/presentation-network",
    );
    return ApiClient.data<Record<string, unknown>>(res.json);
  }

  /** Poll the live-preview lease. Returns raw session JSON (or null). */
  async previewSession(): Promise<Record<string, unknown> | null> {
    const res = await this.request("GET", "/api/v1/player/preview-session");
    return (res.json as { data?: Record<string, unknown> })?.data ?? null;
  }

  /** Read the separate, ephemeral Studio live-stream lease. */
  async liveStreamSession(): Promise<Record<string, unknown>> {
    const res = await this.request("GET", "/api/v1/player/live-stream-session");
    return (res.json as { data?: Record<string, unknown> })?.data ?? {};
  }

  /** Upload a preview capture (or a failure status) as multipart form data. */
  async postPreview(form: FormData): Promise<void> {
    if (!this.credential) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await this.fetchImpl(
        this.url("/api/v1/player/preview"),
        {
          method: "POST",
          headers: { Authorization: `Bearer ${this.credential}` },
          body: form,
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        let error: { code?: string; message?: string } | undefined;
        if (text.length > 0) {
          try {
            const body = JSON.parse(text) as {
              error?: { code?: string; message?: string };
            };
            error = body.error;
          } catch {
            // Preserve the HTTP status when an intermediary returns non-JSON.
          }
        }
        throw new ApiError(
          response.status,
          error?.code ?? `http_${response.status}`,
          error?.message ??
            `preview upload failed with status ${response.status}`,
        );
      }
    } catch (err) {
      if (err instanceof ApiError) {
        throw err;
      }
      throw new NetworkError("preview upload failed", err);
    } finally {
      clearTimeout(timer);
    }
  }
}
