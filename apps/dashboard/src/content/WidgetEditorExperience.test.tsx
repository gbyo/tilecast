// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type {
  ContentDefinitionField,
  WidgetDefinition,
  WidgetPresentation,
} from "../api/types";
import { GenericWidgetEditor } from "./GenericDefinitionEditors";
import { WidgetProviderGallery } from "./SourceEditors";
import { V2WidgetEditor } from "./V2WidgetEditor";
import clockManifest from "../../../../widgets/clock/tilecast.widget.json";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const preview: WidgetPresentation = {
  schemaVersion: 1,
  kind: "native",
  requiredCapabilities: {},
  native: { root: { type: "text", props: { text: "Preview" } } },
};

function renderEditor(editor: ReactNode) {
  vi.spyOn(api, "compileWidgetPreview").mockResolvedValue(preview);
  vi.spyOn(api, "contentDefinitions").mockResolvedValue({
    revision: "1",
    compilerVersion: "1",
    fingerprint: "test",
    widgets: [
      {
        id: "espn",
        version: 1,
        name: "ESPN",
        description: "Sports headlines and stories from ESPN.",
        category: "News",
        icon: "espn",
        kind: "app",
        featured: true,
        runtime: "native",
        configurationSchema: { fields: [] },
        defaultConfiguration: {},
        presentationSchemaVersion: 1,
        requiredCapabilities: {},
        emptyStateBehavior: "placeholder",
      },
      {
        id: "google-sheets-display",
        version: 1,
        name: "Google Sheets",
        description: "Display a published Google spreadsheet.",
        category: "Google",
        icon: "google-sheets",
        kind: "app",
        runtime: "web",
        configurationSchema: { fields: [] },
        defaultConfiguration: {},
        presentationSchemaVersion: 1,
        requiredCapabilities: {},
        emptyStateBehavior: "placeholder",
      },
      {
        id: "notion",
        version: 1,
        name: "Notion",
        description: "Display a published Notion page.",
        category: "Design & Documents",
        icon: "notion",
        kind: "app",
        availability: {
          enabled: false,
          reason: "No dependable first-party signage embed contract.",
        },
        runtime: "web",
        configurationSchema: { fields: [] },
        defaultConfiguration: {},
        presentationSchemaVersion: 1,
        requiredCapabilities: {},
        emptyStateBehavior: "placeholder",
      },
    ],
    dataSources: [],
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{editor}</QueryClientProvider>,
  );
}

describe("Widget editor experience", () => {
  it("organizes and searches the integration catalog", async () => {
    renderEditor(
      <WidgetProviderGallery onChoose={vi.fn()} onClose={vi.fn()} page />,
    );

    expect(
      await screen.findByRole("heading", { name: "Featured" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "News" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Google" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Notion/ })).toBeDisabled();

    await userEvent.type(screen.getByRole("searchbox"), "spreadsheet");
    expect(screen.getByRole("button", { name: /Google Sheets/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /ESPN/ })).toBeNull();
  });

  it("edits Clock through the generic V2 editor and its real preview", async () => {
    vi.spyOn(api, "settings").mockResolvedValue({ values: {} } as never);
    const definition: WidgetDefinition = {
      id: "clock",
      version: 1,
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
        version: 1,
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
    renderEditor(
      <V2WidgetEditor
        definition={definition}
        catalog={{
          revision: "test",
          compilerVersion: "99",
          fingerprint: "test",
          widgets: [definition],
          dataSources: [],
        }}
        csrf="csrf"
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    // The generic inspector replaces the old per-Widget sections.
    expect(
      screen.getByRole("heading", { name: "Widget details" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Content" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeTruthy();
    expect(
      screen.getByText(/Leave blank to use the organization timezone/),
    ).toBeTruthy();
    // The style select renders as visual cards with the manifest copy.
    expect(
      screen.getByRole("radiogroup", { name: "Style" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Analog shows a dial/)).toBeTruthy();
    // The preview is the real Web Component, not a Studio drawing.
    const frame = await screen.findByRole("img", { name: "Live preview" });
    await screen.findByText("Preview ready.");
    expect(frame.querySelector("tc-widget-clock")).toBeTruthy();
    // Minimal hides the date toggle through manifest visibility metadata.
    await userEvent.click(screen.getByRole("radio", { name: "Minimal" }));
    expect(
      screen.queryByRole("switch", { name: "Show date" }),
    ).not.toBeInTheDocument();
  });

  it("uses the same guided structure for catalog-defined Widgets", () => {
    const definition = {
      id: "notice",
      version: 1,
      name: "Notice",
      description: "Show a short notice.",
      category: "Text",
      icon: "text",
      runtime: "native",
      configurationSchema: { fields: [] },
      defaultConfiguration: {},
      presentationSchemaVersion: 1,
      requiredCapabilities: {},
      emptyStateBehavior: "Show nothing",
    } satisfies WidgetDefinition;

    renderEditor(
      <GenericWidgetEditor
        definition={definition}
        csrf="csrf"
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Widget details" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Content and appearance" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("complementary", { name: "Live preview" }),
    ).toBeTruthy();
  });
});
