// @vitest-environment jsdom
// A preview that stops compiling keeps showing the last render that worked,
// while the problem is reported on its own. Only a later success replaces it.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import type { WidgetPresentation } from "@/api/types";
import type { StudioPreviewComponent } from "@/content/studioWidgets";
import { useComponentPreview } from "./useComponentPreview";
import { useLastGood } from "./useLastGood";
import { useWebIntegrationPreview } from "./useWebIntegrationPreview";

vi.mock("@/settings/regionalProfile", () => ({
  useOrganizationRegionalProfile: () => ({
    ready: true,
    locale: "en-US",
    timezone: "UTC",
    timeFormat: "locale",
  }),
}));
vi.mock("@/content/widgetPreviewResources", () => ({
  useWidgetPreviewResources: () => ({
    resources: {},
    loading: false,
    failedIds: [],
  }),
}));

afterEach(() => vi.restoreAllMocks());

describe("useLastGood", () => {
  const lastGood = (initial: string | null) =>
    renderHook(({ value }: { value: string | null }) => useLastGood(value), {
      initialProps: { value: initial },
    });

  it("returns nothing until something succeeds", () => {
    const { result } = lastGood(null);
    expect(result.current).toBeNull();
  });

  it("keeps the last success when a later attempt fails", () => {
    const { result, rerender } = lastGood("first");
    expect(result.current).toBe("first");
    rerender({ value: null });
    expect(result.current).toBe("first");
    rerender({ value: null });
    expect(result.current).toBe("first");
  });

  it("replaces it with the next success", () => {
    const { result, rerender } = lastGood("first");
    rerender({ value: null });
    rerender({ value: "second" });
    expect(result.current).toBe("second");
    rerender({ value: null });
    expect(result.current).toBe("second");
  });
});

describe("a native component preview", () => {
  const component = {
    kind: "trusted",
    component: {
      definition: {},
      type: "example.note",
      version: 1,
      configTemplate: { text: { $config: "text" } },
      dataSourceFields: [],
    },
  } as unknown as StudioPreviewComponent;

  const preview = (configuration: Record<string, unknown>) =>
    renderHook(
      ({ configuration }) =>
        useComponentPreview({
          component,
          fields: [],
          configuration,
          previewTime: { mode: "live", value: "" },
        }),
      { initialProps: { configuration } },
    );

  it("mounts the compiled configuration", () => {
    const { result } = preview({ text: "Hello" });
    expect(result.current.host?.component.config).toEqual({ text: "Hello" });
    expect(result.current.status.kind).not.toBe("error");
  });

  it("keeps the last good render beside a configuration that cannot compile", () => {
    const { result, rerender } = preview({ text: "Hello" });
    const good = result.current.host?.component;
    rerender({ configuration: {} });
    // The previous render stays mounted...
    expect(result.current.host?.component).toBe(good);
    expect(result.current.host?.component.config).toEqual({ text: "Hello" });
    // ...and the problem is reported separately, with its detail.
    expect(result.current.status).toMatchObject({
      kind: "error",
      detail: expect.stringContaining("missing configuration text") as string,
    });
  });

  it("replaces the last good render once the configuration compiles again", () => {
    const { result, rerender } = preview({ text: "Hello" });
    rerender({ configuration: {} });
    rerender({ configuration: { text: "Fixed" } });
    expect(result.current.host?.component.config).toEqual({ text: "Fixed" });
    expect(result.current.status.kind).not.toBe("error");
  });

  it("shows nothing, with the problem, when it never compiled", () => {
    const { result } = preview({});
    expect(result.current.host).toBeNull();
    expect(result.current.status.kind).toBe("error");
  });
});

describe("a web integration preview", () => {
  const presentation = (url: string) =>
    ({
      schemaVersion: 1,
      kind: "web",
      requiredCapabilities: {},
      web: { url },
    }) as unknown as WidgetPresentation;

  function wrapper({ children }: { children: ReactNode }) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }

  const preview = (configuration: Record<string, unknown>) =>
    renderHook(
      ({ configuration }) =>
        useWebIntegrationPreview({
          provider: "website",
          configuration,
          csrf: "csrf",
          canCompile: true,
        }),
      { initialProps: { configuration }, wrapper },
    );

  const shows = (url: string) => ({
    kind: "presentation",
    presentation: presentation(url),
  });

  it("keeps the previous page while a bad draft reports its error, then replaces it", async () => {
    const compile = vi
      .spyOn(api, "compileWidgetPreview")
      .mockResolvedValue(presentation("https://one.example"));
    const { result, rerender } = preview({ url: "https://one.example" });
    await waitFor(() =>
      expect(result.current.surface).toEqual(shows("https://one.example")),
    );
    expect(result.current.status.kind).toBe("ready");

    // A later draft the compiler rejects: the page stays, the error is reported.
    compile.mockRejectedValue(new Error("The address is not allowed."));
    rerender({ configuration: { url: "http://nope" } });
    await waitFor(() => expect(result.current.status.kind).toBe("error"), {
      timeout: 3000,
    });
    expect(result.current.status).toMatchObject({
      detail: "The address is not allowed.",
    });
    expect(result.current.surface).toEqual(shows("https://one.example"));

    // A later success replaces it and clears the error.
    compile.mockResolvedValue(presentation("https://two.example"));
    rerender({ configuration: { url: "https://two.example" } });
    await waitFor(
      () =>
        expect(result.current.surface).toEqual(shows("https://two.example")),
      { timeout: 3000 },
    );
    expect(result.current.status.kind).toBe("ready");
  });

  it("does not ask the Server to compile a blank address", () => {
    const compile = vi.spyOn(api, "compileWidgetPreview");
    const { result } = preview({ url: "   " });
    expect(compile).not.toHaveBeenCalled();
    expect(result.current.surface).toBeNull();
    expect(result.current.status).toMatchObject({
      kind: "unavailable",
      message: "Enter a web address to see it here.",
    });
  });

  it("keeps the last page when the address is cleared, and says why", async () => {
    vi.spyOn(api, "compileWidgetPreview").mockResolvedValue(
      presentation("https://one.example"),
    );
    const { result, rerender } = preview({ url: "https://one.example" });
    await waitFor(() =>
      expect(result.current.surface).toEqual(shows("https://one.example")),
    );
    rerender({ configuration: { url: "" } });
    expect(result.current.surface).toEqual(shows("https://one.example"));
    expect(result.current.status.kind).toBe("unavailable");
  });

  it("falls back to the saved thumbnail when compiling is not permitted", () => {
    const { result } = renderHook(
      () =>
        useWebIntegrationPreview({
          provider: "website",
          configuration: { url: "https://one.example" },
          csrf: "csrf",
          canCompile: false,
          savedThumbnailUrl: "/thumb.jpg",
        }),
      { wrapper },
    );
    expect(result.current.surface).toEqual({
      kind: "thumbnail",
      url: "/thumb.jpg",
    });
    expect(result.current.status.kind).toBe("ready");
  });
});
