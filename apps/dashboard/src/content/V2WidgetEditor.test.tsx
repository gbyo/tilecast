// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type {
  Asset,
  ContentDefinitionCatalog,
  ContentDefinitionField,
  WidgetDefinition,
} from "../api/types";
import { V2WidgetEditor } from "./V2WidgetEditor";
import clockManifest from "../../../../widgets/clock/tilecast.widget.json";
import { parsePreviewTimeInput, previewTimeInputValue } from "./previewTime";

vi.mock("./widgetPreviewCapture", () => ({
  captureWidgetPreview: vi.fn(() =>
    Promise.resolve(new Blob(["preview"], { type: "image/jpeg" })),
  ),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
  const view = render(
    <QueryClientProvider client={client}>
      <V2WidgetEditor
        definition={definition}
        catalog={catalog(definition)}
        asset={props?.asset}
        csrf="test-csrf"
        readOnly={props?.readOnly}
        onClose={onClose}
        onSaved={onSaved}
      />
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

  it("renders a fixed preview instant through the Widget's own clock", async () => {
    editor();
    await screen.findByRole("img", { name: "Live preview" });
    // Switching to a fixed instant keeps today's date; setting the time of
    // day drives the Widget's own clock to that instant.
    await userEvent.click(screen.getByRole("button", { name: "At a time" }));
    const timeInput = screen.getByLabelText("Preview time of day");
    fireEvent.change(timeInput, { target: { value: "00:00" } });
    const datePart = previewTimeInputValue(new Date()).split("T")[0]!;
    const instant = parsePreviewTimeInput(`${datePart}T00:00`)!;
    // The element renders time parts in separate spans, so compare without
    // whitespace.
    const expected = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      hour: "numeric",
      minute: "2-digit",
    })
      .format(instant)
      .replace(/\s+/g, "");
    await waitFor(() => {
      const text = (
        document.querySelector("tc-widget-clock")?.shadowRoot?.textContent ?? ""
      ).replace(/\s+/g, "");
      expect(text).toContain(expected);
    });
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
    render(
      <QueryClientProvider client={client}>
        <V2WidgetEditor
          definition={definition}
          catalog={catalog(definition)}
          csrf="test-csrf"
          readOnly
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />
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
