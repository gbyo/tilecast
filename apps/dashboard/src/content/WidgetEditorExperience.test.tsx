// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { WidgetDefinition, WidgetPresentation } from "../api/types";
import { GenericWidgetEditor } from "./GenericDefinitionEditors";
import { NativeAppEditor, WidgetProviderGallery } from "./SourceEditors";

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

  it("groups built-in Widget settings and keeps a named live preview", () => {
    renderEditor(
      <NativeAppEditor
        provider="clock"
        csrf="csrf"
        onClose={vi.fn()}
        onSaved={vi.fn()}
        page
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Widget details" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Content and behavior" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeTruthy();
    expect(
      screen.getByRole("complementary", { name: "Live preview" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Used to find this Widget in Content and playlists."),
    ).toBeTruthy();
    expect(
      screen.getByText(/Leave blank to use the organization timezone/),
    ).toBeTruthy();

    const contentSection = screen
      .getByRole("heading", { name: "Content and behavior" })
      .closest("section");
    expect(contentSection).toHaveClass("widget-editor__section");
    expect(contentSection).toContainElement(screen.getByText("Timezone"));
  });

  it("presents appearance controls as consistent subsections instead of a one-off fieldset", () => {
    renderEditor(
      <NativeAppEditor
        provider="clock"
        csrf="csrf"
        onClose={vi.fn()}
        onSaved={vi.fn()}
        page
      />,
    );

    expect(screen.getByText("Size and spacing")).toBeTruthy();
    expect(screen.getByText("Colors")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Content sizing" })).toBeNull();
    expect(
      document.querySelectorAll(".widget-editor__subsection"),
    ).toHaveLength(2);
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
