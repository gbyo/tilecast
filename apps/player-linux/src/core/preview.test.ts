import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "./api";
import { LivePreview, type Capture } from "./preview";

const CAPTURED_AT_MS = Date.parse("2026-07-25T18:30:00.000Z");

function capture(): Capture {
  return {
    jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    width: 320,
    height: 180,
  };
}

describe("LivePreview", () => {
  it("uploads the server-required capture timestamp", async () => {
    let uploaded: FormData | null = null;
    const client = {
      previewSession: vi.fn(async () => ({ active: true, captureNow: false })),
      postPreview: vi.fn(async (form: FormData) => {
        uploaded = form;
      }),
    } as unknown as ApiClient;
    const preview = new LivePreview(
      client,
      {
        capture: vi.fn(async () => capture()),
        playerVersion: "0.2.2",
      },
      () => CAPTURED_AT_MS,
    );

    preview.start();
    await vi.waitFor(() => expect(client.postPreview).toHaveBeenCalledOnce());
    preview.stop();

    expect(uploaded).not.toBeNull();
    expect(uploaded!.get("capturedAt")).toBe("2026-07-25T18:30:00.000Z");
    expect(uploaded!.get("width")).toBe("320");
    expect(uploaded!.get("height")).toBe("180");
    expect(uploaded!.get("playerVersion")).toBe("0.2.2");
    expect(uploaded!.get("preview")).toBeInstanceOf(Blob);
  });

  it(
    "reconciles a preview notification without waiting for the next timer",
    async () => {
      const client = {
        previewSession: vi.fn(async () => ({
          active: false,
          captureNow: false,
        })),
        postPreview: vi.fn(async () => {}),
      } as unknown as ApiClient;
      const preview = new LivePreview(
        client,
        { capture: vi.fn(async () => capture()), playerVersion: "0.2.2" },
        () => CAPTURED_AT_MS,
      );

      preview.start();
      await vi.waitFor(() =>
        expect(client.previewSession).toHaveBeenCalledOnce(),
      );
      preview.sessionChanged();
      await vi.waitFor(() =>
        expect(client.previewSession).toHaveBeenCalledTimes(2),
      );
      preview.stop();
    },
  );

  it("honors the server captureNow signal before the interval is due", async () => {
    const client = {
      previewSession: vi.fn(async () => ({ active: true, captureNow: true })),
      postPreview: vi.fn(async () => {}),
    } as unknown as ApiClient;
    const host = {
      capture: vi.fn(async () => capture()),
      playerVersion: "0.2.2",
    };
    const preview = new LivePreview(client, host, () => CAPTURED_AT_MS);
    const state = preview as unknown as {
      lastCaptureMs: number;
      tick(): Promise<void>;
    };
    state.lastCaptureMs = CAPTURED_AT_MS - 1_000;

    await state.tick();

    expect(host.capture).toHaveBeenCalledOnce();
    expect(client.postPreview).toHaveBeenCalledOnce();
  });
});

describe("ApiClient.postPreview", () => {
  it("surfaces non-authentication upload rejections", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "invalid_preview",
              message: "capture time is required",
            },
          }),
          {
            status: 422,
            headers: { "Content-Type": "application/json" },
          },
        ),
    ) as unknown as typeof fetch;
    const client = new ApiClient(
      "https://tilecast.example",
      "tc_device_public.secret",
      fetchImpl,
    );

    await expect(client.postPreview(new FormData())).rejects.toEqual(
      expect.objectContaining<ApiError>({
        name: "ApiError",
        status: 422,
        code: "invalid_preview",
        message: "capture time is required",
      }),
    );
  });
});
