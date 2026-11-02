/** Same-server transport. Cookies stay in the browser's HTTP boundary. */
export class PlayerAPIError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }

  /**
   * The server did not answer authoritatively: no connection, a gateway error
   * or a response that is not a Tilecast envelope. A 401 or 403 is an answer,
   * so it never counts as unreachable.
   */
  get unreachable(): boolean {
    return this.status === 0 || this.code === SERVER_UNREACHABLE;
  }
}

export const SERVER_UNREACHABLE = "server_unreachable";

export function serverUnreachable(error: unknown): boolean {
  return error instanceof PlayerAPIError && error.unreachable;
}

export class PlayerAPI {
  slotId?: string;
  constructor(
    private readonly transport: typeof fetch = (input, init) =>
      globalThis.fetch(input, init),
  ) {}

  async request<T>(
    path: string,
    body?: unknown,
    authorization?: string,
  ): Promise<T> {
    if (!path.startsWith("/api/v1/"))
      throw new Error("Invalid Player API path");
    let response: Response;
    try {
      response = await this.send(path, body, authorization);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError")
        throw error;
      throw new PlayerAPIError(0, SERVER_UNREACHABLE);
    }
    let envelope: { data: T; error?: { code: string } };
    try {
      envelope = (await response.json()) as typeof envelope;
    } catch {
      // A proxy error page or an empty gateway response is not an answer.
      throw new PlayerAPIError(response.status, SERVER_UNREACHABLE);
    }
    if (!response.ok)
      throw new PlayerAPIError(
        response.status,
        response.status >= 502 && response.status <= 504
          ? SERVER_UNREACHABLE
          : (envelope.error?.code ?? "request_failed"),
      );
    return envelope.data;
  }

  private send(
    path: string,
    body: unknown,
    authorization: string | undefined,
  ): Promise<Response> {
    return this.transport(path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(this.slotId ? { "X-Tilecast-Player-Slot": this.slotId } : {}),
        ...(authorization ? { Authorization: authorization } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  media(path: string, signal?: AbortSignal): Promise<Response> {
    const url = new URL(path, location.origin);
    if (
      url.origin !== location.origin ||
      !/^\/api\/v1\/player\/(assets|span-panels|packages)\//.test(url.pathname)
    ) {
      throw new Error("Media download is outside the Player API");
    }
    return this.transport(url, {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal,
      headers: { "X-Tilecast-Player-Slot": this.slotId ?? "" },
    });
  }
}
