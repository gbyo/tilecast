// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { isAvailableAt } from "@tilecast/presentation-model";
import { useAvailabilityInstant } from "./useAvailabilityInstant";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("refreshes at start and exclusive expiration, then clears the timer", async () => {
  vi.useFakeTimers();
  const start = Date.parse("2026-10-02T12:00:00Z");
  vi.setSystemTime(start);
  const windows = [
    {
      availableFrom: new Date(start + 1000).toISOString(),
      expiresAt: new Date(start + 2000).toISOString(),
    },
  ];
  const view = renderHook(() => useAvailabilityInstant(windows));
  expect(isAvailableAt(windows[0], new Date(view.result.current))).toBe(false);
  await act(() => vi.advanceTimersByTimeAsync(1001));
  expect(isAvailableAt(windows[0], new Date(view.result.current))).toBe(true);
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(isAvailableAt(windows[0], new Date(view.result.current))).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  view.unmount();
});

it("bounds a 60-day wait and cancels on unmount", async () => {
  vi.useFakeTimers();
  const start = Date.parse("2026-10-02T12:00:00Z");
  vi.setSystemTime(start);
  const windows = [
    { availableFrom: new Date(start + 60 * 86400000).toISOString() },
  ];
  const view = renderHook(() => useAvailabilityInstant(windows));
  expect(vi.getTimerCount()).toBe(1);
  await act(() => vi.advanceTimersByTimeAsync(2147483647));
  expect(view.result.current).toBe(start + 2147483647);
  expect(vi.getTimerCount()).toBe(1);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("replaces a pending boundary when the windows change", async () => {
  vi.useFakeTimers();
  const start = Date.parse("2026-10-02T12:00:00Z");
  vi.setSystemTime(start);
  const first = [{ availableFrom: new Date(start + 1000).toISOString() }];
  const second = [{ availableFrom: new Date(start + 2000).toISOString() }];
  const view = renderHook(({ windows }) => useAvailabilityInstant(windows), {
    initialProps: { windows: first },
  });
  view.rerender({ windows: second });
  expect(vi.getTimerCount()).toBe(1);
  await act(() => vi.advanceTimersByTimeAsync(1001));
  expect(view.result.current).toBe(start);
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(isAvailableAt(second[0], new Date(view.result.current))).toBe(true);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps selected instants fixed and rechecks on tab resume", async () => {
  vi.useFakeTimers();
  const start = Date.parse("2026-10-02T12:00:00Z");
  vi.setSystemTime(start);
  const windows = [{ availableFrom: new Date(start + 1000).toISOString() }];
  const view = renderHook<number, { fixedAt: number | null }>(
    ({ fixedAt }: { fixedAt: number | null }) =>
      useAvailabilityInstant(windows, fixedAt),
    { initialProps: { fixedAt: start } },
  );
  expect(vi.getTimerCount()).toBe(0);
  vi.setSystemTime(start + 2000);
  view.rerender({ fixedAt: null });
  expect(view.result.current).toBe(start + 2000);
  vi.setSystemTime(start + 3000);
  await act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(view.result.current).toBe(start + 3000);
  view.unmount();
  vi.setSystemTime(start + 4000);
  await act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(view.result.current).toBe(start + 3000);
});
