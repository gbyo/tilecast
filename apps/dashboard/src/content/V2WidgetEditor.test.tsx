// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { toast } from "../components/ui/toast";
import type {
  Asset,
  ContentDefinitionCatalog,
  ContentDefinitionField,
  WidgetDefinition,
} from "../api/types";
import type { WidgetContext } from "@tilecast/widget-sdk";
import { V2WidgetEditor } from "./V2WidgetEditor";
import { captureWidgetPreview } from "./widgetPreviewCapture";
import clockManifest from "../../../../widgets/clock/tilecast.widget.json";

vi.mock("./widgetPreviewCapture", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./widgetPreviewCapture")>();
  return {
    ...actual,
    captureWidgetPreview: vi.fn(() =>
      Promise.resolve(new Blob(["preview"], { type: "image/jpeg" })),
    ),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function clockDefinition(): WidgetDefinition {
  return {
    id: "clock",
    version: 1,
    apiVersion: 1,
    name: "Clock",
    description: "Show live local time in a configured timezone.",
    category: "Essentials",
    icon: "clock",
    runtime: "native",
    configurationSchema: clockManifest.configurationSchema as {
      fields: ContentDefinitionField[];
    },
    defaultConfiguration: clockManifest.defaultConfiguration,
    component: {
      type: "tilecast.clock",
      version: 2,
      tagName: "tc-widget-clock",
      entrypoint: "./runtime/index.ts",
      configTemplate: clockManifest.component.configTemplate,
      dataSourceFields: [],
      empty: "render",
    },
    compatibility: { fallback: "legacy" },
    presentationSchemaVersion: 1,
    requiredCapabilities: {},
    emptyStateBehavior: "text",
  };
}

function catalog(definition: WidgetDefinition): ContentDefinitionCatalog {
  return {
    revision: "test",
    compilerVersion: "99",
    fingerprint: "test",
    widgets: [definition],
    dataSources: [],
  };
}

function editor(props?: {
  asset?: Asset;
  readOnly?: boolean;
  onSaved?: (asset: Asset) => void;
}) {
  const definition = clockDefinition();
  const onClose = vi.fn();
  const onSaved = props?.onSaved ?? vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter([
    {
      path: "*",
      element: (
        <V2WidgetEditor
          definition={definition}
          catalog={catalog(definition)}
          asset={props?.asset}
          csrf="test-csrf"
          readOnly={props?.readOnly}
          onClose={onClose}
          onSaved={onSaved}
        />
      ),
    },
  ]);
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, onClose, onSaved, definition };
}

beforeEach(() => {
  vi.spyOn(api, "settings").mockResolvedValue({
    values: {
      "organization.locale": "en-US",
      "organization.timezone": "UTC",
      "organization.time_format": "locale",
    },
  } as never);
  vi.spyOn(api, "compileWidgetPreview").mockResolvedValue({} as never);
  vi.spyOn(api, "previewSavedDataSource").mockRejectedValue(
    new Error("no sources connected"),
  );
  // The canonical save surface resolves its component through the same
  // definitions query as every other V2 zone preview.
  const definition = clockDefinition();
  vi.spyOn(api, "contentDefinitions").mockResolvedValue(catalog(definition));
});

describe("V2WidgetEditor", () => {
  it("renders the manifest-driven inspector and the real Clock element", async () => {
    const { container } = editor();
    // Sections come from manifest ui metadata: Clock has content and
    // appearance controls, and no data or behavior controls.
    expect(
      screen.getByRole("heading", { name: "Content" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Appearance" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Data" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Behavior" }),
    ).not.toBeInTheDocument();
    // The style select renders as visual radio cards.
    const styleGroup = screen.getByRole("radiogroup", { name: "Style" });
    expect(
      within(styleGroup)
        .getAllByRole("radio")
        .map((option) => option),
    ).toHaveLength(3);
    // Conditional visibility: Minimal hides the date toggle.
    expect(
      screen.getByRole("switch", { name: "Show date" }),
    ).toBeInTheDocument();
    // The preview mounts the real Web Component, not a Studio drawing.
    const frame = screen.getByRole("img", { name: "Live preview" });
    await waitFor(() => frame.querySelector("tc-widget-clock"));
    expect(container.querySelector("tc-widget-clock")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("Preview ready.")).toBeInTheDocument(),
    );
  });

  it("hides the date toggle for the Minimal style", async () => {
    editor();
    await screen.findByRole("img", { name: "Live preview" });
    await userEvent.click(screen.getByRole("radio", { name: "Minimal" }));
    expect(
      screen.queryByRole("switch", { name: "Show date" }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Standard" }));
    expect(
      screen.getByRole("switch", { name: "Show date" }),
    ).toBeInTheDocument();
  });

  it("compiles edits locally without server preview calls and keeps the element", async () => {
    const { container } = editor();
    const frame = await screen.findByRole("img", { name: "Live preview" });
    const before = (await waitFor(() =>
      frame.querySelector("tc-widget-clock"),
    )) as Element;
    const timezone = screen.getByLabelText("Timezone");
    fireEvent.change(timezone, { target: { value: "America/Chicago" } });
    await waitFor(() =>
      expect(screen.getByText("Preview ready.")).toBeInTheDocument(),
    );
    expect(api.compileWidgetPreview).not.toHaveBeenCalled();
    expect(api.previewSavedDataSource).not.toHaveBeenCalled();
    expect(container.querySelector("tc-widget-clock")).toBe(before);
  });

  it("uses one fixed date for the Widget clock and Data Source preview", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 23, 12));
    const sourceId = "source-preview";
    const asset = {
      id: "asset-preview",
      name: "Clock preview",
      description: "",
      type: "widget",
      widget: {
        provider: "clock",
        managedDataSourceId: sourceId,
        configuration: clockManifest.defaultConfiguration,
      },
    } as unknown as Asset;
    vi.mocked(api.previewSavedDataSource).mockResolvedValue({
      records: [],
      fields: [],
      usingCachedData: false,
    } as never);
    editor({ asset });
    await screen.findByRole("img", { name: "Live preview" });
    await userEvent.click(screen.getByRole("button", { name: "At a time" }));
    const dateControl = screen.getByRole("button", {
      name: "Preview date and time",
    });
    await userEvent.click(dateControl);
    await userEvent.click(
      await screen.findByRole("button", { name: /September 24th, 2026$/ }),
    );
    await userEvent.click(screen.getByRole("radio", { name: "Date" }));

    await waitFor(() =>
      expect(api.previewSavedDataSource).toHaveBeenLastCalledWith(
        sourceId,
        "2026-09-24",
      ),
    );
    await waitFor(() => {
      const text =
        document.querySelector("tc-widget-clock")?.shadowRoot?.textContent ??
        "";
      expect(text).toContain("24");
      expect(text).toContain("2026");
    });
  });

  it("waits for organization regional settings before saving a thumbnail", async () => {
    type Settings = Awaited<ReturnType<typeof api.settings>>;
    let resolveSettings!: (value: Settings) => void;
    vi.mocked(api.settings).mockImplementationOnce(
      () =>
        new Promise<Settings>((resolve) => {
          resolveSettings = resolve;
        }),
    );
    vi.spyOn(api, "createWidget").mockResolvedValue({
      id: "asset-regional",
      name: "Clock",
      description: "",
      provider: "clock",
    } as never);
    vi.spyOn(api, "uploadWidgetPreview").mockResolvedValue(undefined);
    const captureCount = vi.mocked(captureWidgetPreview).mock.calls.length;
    let capturedContext: WidgetContext | undefined;
    vi.mocked(captureWidgetPreview).mockImplementationOnce((element) => {
      const widget = element.querySelector<
        HTMLElement & { context?: WidgetContext }
      >("tc-widget-clock");
      capturedContext = widget?.context;
      return Promise.resolve(new Blob(["preview"], { type: "image/jpeg" }));
    });
    const { container } = editor();
    await screen.findByRole("img", { name: "Live preview" });
    const save = screen.getByRole("button", { name: "Save Widget" });
    const visibleWidget = await waitFor(
      () =>
        container.querySelector("tc-widget-clock") as HTMLElement & {
          context: { timeZone: string };
        },
    );

    expect(visibleWidget.context.timeZone).toBe("UTC");
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(vi.mocked(captureWidgetPreview).mock.calls).toHaveLength(
      captureCount,
    );

    act(() => {
      resolveSettings({
        values: {
          "organization.locale": "fr-FR",
          "organization.timezone": "Europe/Paris",
          "organization.time_format": "24-hour",
        },
      } as never);
    });
    await waitFor(() => {
      expect(save).toBeEnabled();
      expect(visibleWidget.context.timeZone).toBe("Europe/Paris");
    });
    expect(visibleWidget.context).toMatchObject({
      locale: "fr-FR",
      timeZone: "Europe/Paris",
      hourCycle: "h23",
    });

    await userEvent.click(save);
    await waitFor(() =>
      expect(vi.mocked(captureWidgetPreview).mock.calls).toHaveLength(
        captureCount + 1,
      ),
    );
    expect(capturedContext).toMatchObject({
      locale: "fr-FR",
      timeZone: "Europe/Paris",
    });
    await waitFor(() =>
      expect(api.uploadWidgetPreview).toHaveBeenCalledWith(
        "asset-regional",
        expect.any(Blob),
        "test-csrf",
      ),
    );
  });

  it("disables save while the configuration cannot render", async () => {
    editor();
    await screen.findByRole("img", { name: "Live preview" });
    const save = screen.getByRole("button", { name: "Save Widget" });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Timezone"), {
      target: { value: "!!!" },
    });
    await waitFor(() =>
      expect(
        screen.getByText("Preview cannot render: widget_config_invalid"),
      ).toBeInTheDocument(),
    );
    expect(save).toBeDisabled();
  });

  it("saves through one explicit action with a real snapshot", async () => {
    const created = {
      id: "asset-1",
      name: "Lobby clock",
      description: "",
      provider: "clock",
    };
    vi.spyOn(api, "createWidget").mockResolvedValue(created as never);
    vi.spyOn(api, "uploadWidgetPreview").mockResolvedValue(undefined);
    const onSaved = vi.fn();
    editor({ onSaved });
    await screen.findByRole("img", { name: "Live preview" });
    fireEvent.change(screen.getByLabelText("Widget name"), {
      target: { value: "Lobby clock" },
    });
    const save = screen.getByRole("button", { name: "Save Widget" });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    await waitFor(() => expect(api.createWidget).toHaveBeenCalled());
    expect(api.createWidget).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "clock",
        name: "Lobby clock",
        configuration: expect.objectContaining({ style: "standard" }) as Record<
          string,
          unknown
        >,
      }),
      "test-csrf",
    );
    await waitFor(() =>
      expect(api.uploadWidgetPreview).toHaveBeenCalledWith(
        "asset-1",
        expect.any(Blob),
        "test-csrf",
      ),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it("keeps the Widget save successful when its thumbnail upload fails", async () => {
    const created = {
      id: "asset-2",
      name: "Lobby clock",
      description: "",
      provider: "clock",
    };
    vi.spyOn(api, "createWidget").mockResolvedValue(created as never);
    vi.spyOn(api, "uploadWidgetPreview").mockRejectedValue(
      new Error("thumbnail upload failed"),
    );
    const toastSpy = vi.spyOn(toast, "add");
    const onSaved = vi.fn();
    editor({ onSaved });
    await screen.findByRole("img", { name: "Live preview" });
    const save = screen.getByRole("button", { name: "Save Widget" });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(created));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title:
            "The Widget was saved, but its thumbnail could not be updated.",
          type: "warning",
        }),
      ),
    );
    expect(api.createWidget).toHaveBeenCalledOnce();
    expect(
      screen.queryByText("thumbnail upload failed"),
    ).not.toBeInTheDocument();
  });

  it("saves the Widget when its canonical preview cannot be captured", async () => {
    const created = {
      id: "asset-3",
      name: "Lobby clock",
      description: "",
      provider: "clock",
    };
    vi.spyOn(api, "createWidget").mockResolvedValue(created as never);
    vi.spyOn(api, "uploadWidgetPreview").mockResolvedValue(undefined);
    vi.mocked(captureWidgetPreview).mockRejectedValueOnce(
      new Error("canvas unavailable"),
    );
    const toastSpy = vi.spyOn(toast, "add");
    const onSaved = vi.fn();
    editor({ onSaved });
    await screen.findByRole("img", { name: "Live preview" });
    const save = screen.getByRole("button", { name: "Save Widget" });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(created));
    expect(api.createWidget).toHaveBeenCalledOnce();
    expect(api.uploadWidgetPreview).not.toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "The Widget was saved, but its thumbnail could not be updated.",
        type: "warning",
      }),
    );
  });

  async function saveWithSelectedSize(
    selectSize: () => Promise<void>,
    visibleFrameWidth: string,
  ) {
    const created = { id: "asset-1", name: "Lobby clock", description: "" };
    vi.spyOn(api, "createWidget").mockResolvedValue(created as never);
    vi.spyOn(api, "uploadWidgetPreview").mockResolvedValue(undefined);
    // Hold the capture gate open so the hidden canonical surface can be
    // inspected while the save is in flight.
    let releaseCapture!: (blob: Blob) => void;
    vi.mocked(captureWidgetPreview).mockImplementationOnce(
      () =>
        new Promise<Blob>((resolve) => {
          releaseCapture = resolve;
        }),
    );
    const onSaved = vi.fn();
    const { container } = editor({ onSaved });
    await screen.findByRole("img", { name: "Live preview" });
    await selectSize();
    fireEvent.change(screen.getByLabelText("Widget name"), {
      target: { value: "Lobby clock" },
    });
    const save = screen.getByRole("button", { name: "Save Widget" });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    // The authoring preview shows the selected geometry...
    const visibleFrame = container.querySelector(".v2-editor__frame");
    const visibleStage = visibleFrame?.firstElementChild as HTMLElement | null;
    expect(visibleStage?.style.width).toBe(visibleFrameWidth);
    // ...while the save captures a hidden surface at the canonical frame.
    const hidden = await waitFor(() => {
      const surface = container.querySelector(".widget-snapshot-backfill");
      expect(surface).not.toBeNull();
      return surface as HTMLElement;
    });
    const hiddenHost = hidden.querySelector('[role="img"]');
    expect(hiddenHost).not.toBeNull();
    const hiddenStage = hiddenHost?.firstElementChild as HTMLElement | null;
    const hiddenFrame = hiddenStage?.firstElementChild as HTMLElement | null;
    expect(hiddenStage?.style.width).toBe("960px");
    expect(hiddenStage?.style.height).toBe("540px");
    expect(hiddenFrame?.style.width).toBe("960px");
    expect(hiddenFrame?.style.height).toBe("540px");
    releaseCapture(new Blob(["preview"], { type: "image/jpeg" }));
    await waitFor(() =>
      expect(api.uploadWidgetPreview).toHaveBeenCalledWith(
        "asset-1",
        expect.any(Blob),
        "test-csrf",
      ),
    );
    expect(onSaved).toHaveBeenCalled();
    // The captured element is the canonical surface, never the selected frame.
    // (The mock accumulates calls across tests, so read this test's capture.)
    const captured = vi.mocked(captureWidgetPreview).mock.calls.at(-1)?.[0];
    expect(captured).toBeInstanceOf(HTMLElement);
    expect(hidden.contains(captured as Node)).toBe(true);
    expect(visibleFrame?.contains(captured as Node)).toBe(false);
  }

  it("saves a canonical thumbnail when portrait is selected", async () => {
    await saveWithSelectedSize(async () => {
      await userEvent.click(
        screen.getByRole("button", { name: "Portrait 9:16" }),
      );
    }, "540px");
  });

  it("saves a canonical thumbnail when a wide strip is selected", async () => {
    await saveWithSelectedSize(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Wide strip" }));
    }, "960px");
  });

  it("saves a canonical thumbnail for a custom non-16:9 frame", async () => {
    await saveWithSelectedSize(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Custom" }));
      fireEvent.change(screen.getByLabelText("Custom width (px)"), {
        target: { value: "400" },
      });
      fireEvent.change(screen.getByLabelText("Custom height (px)"), {
        target: { value: "400" },
      });
    }, "400px");
  });

  it("switches Clock modes with their own controls", async () => {
    editor();
    await screen.findByRole("img", { name: "Live preview" });
    await userEvent.click(screen.getByRole("radio", { name: "Date" }));
    expect(screen.getByLabelText("Date format")).toBeInTheDocument();
    expect(
      screen.queryByRole("radiogroup", { name: "Style" }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "World clocks" }));
    expect(screen.getByText("Zones")).toBeInTheDocument();
    expect(screen.queryByLabelText("Date format")).not.toBeInTheDocument();
  });

  it("opens a saved legacy row upgraded and saves only accepted keys", async () => {
    const asset = {
      id: "asset-7",
      name: "Front desk",
      description: "",
      type: "widget",
      widget: {
        provider: "clock",
        configuration: {
          timezone: "Europe/Berlin",
          format: "12",
          showSeconds: false,
          foregroundColor: "#F5F7FA",
          backgroundColor: "#0E141B",
          textScale: 150,
          retiredOption: true,
        },
      },
    } as unknown as Asset;
    vi.spyOn(api, "updateWidget").mockResolvedValue(asset);
    vi.spyOn(api, "uploadWidgetPreview").mockResolvedValue(undefined);
    editor({ asset });
    await screen.findByRole("img", { name: "Live preview" });
    const save = screen.getByRole("button", { name: "Save Widget" });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    await waitFor(() => expect(api.updateWidget).toHaveBeenCalled());
    const [, input] = vi.mocked(api.updateWidget).mock.calls[0]!;
    const configuration = (input as { configuration: Record<string, unknown> })
      .configuration;
    // A retained key the compatibility presentation reads survives; a key
    // the provider no longer accepts is left out.
    expect(configuration["textScale"]).toBe(150);
    expect(configuration["timezone"]).toBe("Europe/Berlin");
    expect(configuration).not.toHaveProperty("retiredOption");
  });

  it("marks unsaved changes", async () => {
    editor();
    await screen.findByRole("img", { name: "Live preview" });
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Widget name"), {
      target: { value: "Renamed" },
    });
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("hides save and disables controls when read-only", async () => {
    const definition = clockDefinition();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const router = createMemoryRouter([
      {
        path: "*",
        element: (
          <V2WidgetEditor
            definition={definition}
            catalog={catalog(definition)}
            csrf="test-csrf"
            readOnly
            onClose={vi.fn()}
            onSaved={vi.fn()}
          />
        ),
      },
    ]);
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByRole("img", { name: "Live preview" });
    expect(
      screen.queryByRole("button", { name: "Save Widget" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Widget name")).toBeDisabled();
  });

  it("keeps every control keyboard reachable", async () => {
    const { container } = editor();
    await screen.findByRole("img", { name: "Live preview" });
    const controls = [
      ...container.querySelectorAll(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ),
    ];
    expect(controls.length).toBeGreaterThan(10);
    (document.activeElement as HTMLElement | null)?.blur?.();
    const seen = new Set<Element>();
    for (let step = 0; step < controls.length + 2; step += 1) {
      await userEvent.tab();
      if (document.activeElement && document.activeElement !== document.body) {
        seen.add(document.activeElement);
      }
    }
    // Tabbing walks the editor instead of getting stuck outside it.
    expect(seen.size).toBeGreaterThan(10);
  });
});

function renderEditorWithAwayLink(onClose: () => void) {
  const definition = clockDefinition();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: (
          <>
            <V2WidgetEditor
              definition={definition}
              catalog={catalog(definition)}
              csrf="test-csrf"
              onClose={onClose}
              onSaved={vi.fn()}
            />
            <Link to="/elsewhere">away</Link>
          </>
        ),
      },
      { path: "/elsewhere", element: <p>Elsewhere</p> },
    ],
    { initialEntries: ["/"] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("V2WidgetEditor unsaved changes", () => {
  it("confirms through Back before discarding widget edits", async () => {
    const { onClose } = editor();
    await screen.findByLabelText("Widget name");
    fireEvent.change(screen.getByLabelText("Widget name"), {
      target: { value: "Renamed clock" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Discard unsaved widget changes?",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Discard changes" }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("closes Back directly when nothing changed", async () => {
    const { onClose } = editor();
    await screen.findByLabelText("Widget name");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("warns before following an in-app link and discards on confirm", async () => {
    renderEditorWithAwayLink(vi.fn());
    await screen.findByLabelText("Widget name");
    fireEvent.change(screen.getByLabelText("Widget name"), {
      target: { value: "Renamed clock" },
    });

    fireEvent.click(screen.getByRole("link", { name: "away" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Discard unsaved widget changes?",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Discard changes" }),
    );
    expect(await screen.findByText("Elsewhere")).toBeInTheDocument();
  });
});
