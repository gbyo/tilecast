// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { useWidgetPreviewResources } from "./widgetPreviewResources";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("keeps equivalent preview inputs stable while source data and grants still update", async () => {
  const preview = (text: string) => ({
    fields: [{ key: "title", label: "Title", type: "text" as const }],
    records: [{ id: "r1", values: { title: text } }],
    usingCachedData: false,
    unavailable: false,
  });
  vi.spyOn(api, "previewSavedDataSource").mockResolvedValue(preview("First"));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { result, rerender, unmount } = renderHook(
    ({ granted }: { granted: string[] }) =>
      useWidgetPreviewResources(["source"], granted, []),
    {
      initialProps: { granted: ["source"] },
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  await waitFor(() => expect(result.current.loading).toBe(false));
  const first = result.current.resources;
  expect(
    first.dataset("source", "records")?.records?.[0]?.values.title?.text,
  ).toBe("First");
  rerender({ granted: ["source"] });
  expect(result.current.resources).toBe(first);

  act(() => {
    client.setQueryData(
      ["widget-v2-source-preview", "source", null],
      preview("Second"),
    );
  });
  await waitFor(() =>
    expect(
      result.current.resources.dataset("source", "records")?.records?.[0]
        ?.values.title?.text,
    ).toBe("Second"),
  );
  expect(result.current.resources).not.toBe(first);
  rerender({ granted: [] });
  expect(result.current.resources.dataDocument("source")).toBeNull();
  unmount();
  client.clear();
});
