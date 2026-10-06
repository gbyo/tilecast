// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { ApiError } from "../api/errors";
import { emptyDraft, type ScheduleDraft } from "./scheduleEditorModel";
import { preflightResult } from "./scheduleEditorTestKit";
import {
  PREFLIGHT_DEBOUNCE_MS,
  useSchedulePreflight,
} from "./useSchedulePreflight";

class RequestWithoutSignal extends globalThis.Request {
  constructor(input: RequestInfo | URL, init: RequestInit = {}) {
    const rest = { ...init };
    delete (rest as { signal?: unknown }).signal;
    super(input, rest);
  }
}
globalThis.Request = RequestWithoutSignal;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const complete = (changes: Partial<ScheduleDraft> = {}): ScheduleDraft => ({
  ...emptyDraft("America/Chicago"),
  name: "Morning Broadcast",
  content: { kind: "playlist", id: "playlist-1", name: "Announcements" },
  targets: [{ type: "group", id: "group-1", name: "Libraries" }],
  ...changes,
});

function setup(initial: ScheduleDraft, scheduleId?: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    ({ draft }: { draft: ScheduleDraft }) =>
      useSchedulePreflight(draft, scheduleId),
    { wrapper, initialProps: { draft: initial } },
  );
}

const settle = (ms = PREFLIGHT_DEBOUNCE_MS + 150) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

describe("useSchedulePreflight", () => {
  it("does not ask while the draft cannot be checked", async () => {
    const spy = vi.spyOn(api, "preflightSchedule");
    const { result, rerender } = setup(emptyDraft("UTC"));
    await settle();
    expect(result.current.status).toBe("incomplete");
    // A name alone is not enough either.
    rerender({ draft: { ...emptyDraft("UTC"), name: "Named" } });
    await settle();
    expect(spy).not.toHaveBeenCalled();
  });

  it("asks at once for a draft that opens complete, with the saved schedule's id", async () => {
    const spy = vi
      .spyOn(api, "preflightSchedule")
      .mockResolvedValue(preflightResult());
    const { result } = setup(complete(), "schedule-1");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(spy).toHaveBeenCalledTimes(1);
    const [proposed, scheduleId] = spy.mock.calls[0]!;
    expect(scheduleId).toBe("schedule-1");
    // Name and description never travel with the check.
    expect(proposed).toMatchObject({
      name: "",
      description: "",
      playlistId: "playlist-1",
    });
    expect(result.current).toMatchObject({ current: true, blocking: false });
  });

  it("does not ask again for a new name or description", async () => {
    const spy = vi
      .spyOn(api, "preflightSchedule")
      .mockResolvedValue(preflightResult());
    const { result, rerender } = setup(complete());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    rerender({
      draft: complete({ name: "Renamed", description: "Longer note" }),
    });
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("ready");
  });

  it.each([
    ["timing", { dailyStart: "08:00" }],
    ["targets", { targets: [{ type: "screen" as const, id: "s1" }] }],
    ["priority", { priority: 100 }],
    ["enabled state", { enabled: false }],
    ["timezone", { timezone: "America/New_York" }],
    ["weekdays", { daysOfWeek: [1, 2] }],
  ])("asks again when the %s changes", async (_label, change) => {
    const spy = vi
      .spyOn(api, "preflightSchedule")
      .mockResolvedValue(preflightResult());
    const { result, rerender } = setup(complete());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    rerender({ draft: complete(change) });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });

  it("waits for edits to stop, then asks once for the last one", async () => {
    const spy = vi
      .spyOn(api, "preflightSchedule")
      .mockResolvedValue(preflightResult());
    const { result, rerender } = setup(complete());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    for (const priority of [1, 2, 3, 4])
      rerender({ draft: complete({ priority }) });
    // Not yet: the author may still be typing.
    expect(spy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2), {
      timeout: 2000,
    });
    expect(spy.mock.calls[1]![0]).toMatchObject({ priority: 4 });
  });

  it("keeps the last answer on screen, marked as checking, until the new one arrives", async () => {
    let finish!: (value: ReturnType<typeof preflightResult>) => void;
    const spy = vi
      .spyOn(api, "preflightSchedule")
      .mockResolvedValueOnce(preflightResult({ winningScreenCount: 8 }))
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
    const { result, rerender } = setup(complete());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    rerender({ draft: complete({ priority: 100 }) });
    // Immediately: stale, not blank, and not presented as current.
    expect(result.current).toMatchObject({
      status: "checking",
      current: false,
    });
    expect(
      result.current.status === "incomplete"
        ? null
        : result.current.result?.winningScreenCount,
    ).toBe(8);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2), {
      timeout: 2000,
    });
    expect(result.current).toMatchObject({
      status: "checking",
      current: false,
    });
    await act(async () => {
      finish(preflightResult({ winningScreenCount: 3 }));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(
      result.current.status === "incomplete"
        ? null
        : result.current.result?.winningScreenCount,
    ).toBe(3);
  });

  it("stops asking, and shows what is missing, when the draft becomes incomplete", async () => {
    const spy = vi
      .spyOn(api, "preflightSchedule")
      .mockResolvedValue(preflightResult());
    const { result, rerender } = setup(complete());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    rerender({ draft: complete({ targets: [] }) });
    expect(result.current.status).toBe("incomplete");
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("reports a failed check, lets it be retried, and never blocks saving", async () => {
    const spy = vi
      .spyOn(api, "preflightSchedule")
      .mockRejectedValueOnce(
        new ApiError("Server unavailable.", 503, "unavailable"),
      )
      .mockResolvedValueOnce(preflightResult());
    const { result } = setup(complete());
    await waitFor(() => expect(result.current.status).toBe("error"));
    const failed = result.current;
    if (failed.status === "incomplete") throw new Error("unreachable");
    expect(failed.blocking).toBe(false);
    expect(failed.error?.message).toBe("Server unavailable.");
    act(() => failed.retry());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("blocks saving only when a current check found a blocking problem", async () => {
    vi.spyOn(api, "preflightSchedule").mockResolvedValue(
      preflightResult({
        unsupportedScreenCount: 2,
        issues: [
          {
            code: "display_control_unsupported",
            severity: "blocking",
            screenCount: 2,
          },
        ],
      }),
    );
    const { result, rerender } = setup(complete());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const checked = result.current;
    if (checked.status === "incomplete") throw new Error("unreachable");
    expect(checked.blocking).toBe(true);
    // A new draft is not yet checked, so the old verdict no longer blocks it.
    rerender({ draft: complete({ priority: 5 }) });
    const changed = result.current;
    if (changed.status === "incomplete") throw new Error("unreachable");
    expect(changed.blocking).toBe(false);
  });

  it("does not block saving for a warning", async () => {
    vi.spyOn(api, "preflightSchedule").mockResolvedValue(
      preflightResult({
        issues: [{ code: "no_upcoming_run", severity: "warning" }],
      }),
    );
    const { result } = setup(complete());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    if (result.current.status === "incomplete") throw new Error("unreachable");
    expect(result.current.blocking).toBe(false);
  });
});
