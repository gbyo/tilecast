/** Same-server transport. Cookies stay in the browser's HTTP boundary. */
export class PlayerAPIError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export class PlayerAPI {
  slotId?: string;
  constructor(private readonly transport: typeof fetch = fetch) {}

  async request<T>(
    path: string,
    body?: unknown,
    authorization?: string,
  ): Promise<T> {
    if (!path.startsWith("/api/v1/"))
      throw new Error("Invalid Player API path");
    const response = await this.transport(path, {
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
    const envelope = (await response.json()) as {
      data: T;
      error?: { code: string };
    };
    if (!response.ok)
      throw new PlayerAPIError(
        response.status,
        envelope.error?.code ?? "request_failed",
      );
    return envelope.data;
  }

  media(path: string, signal?: AbortSignal): Promise<Response> {
    const url = new URL(path, location.origin);
    if (
      url.origin !== location.origin ||
      !/^\/api\/v1\/player\/(assets|span-panels)\//.test(url.pathname)
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
