// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type {
  ContentDefinitionField,
  WidgetDefinition,
  WidgetPresentation,
} from "../api/types";
import { WidgetProviderGallery } from "./SourceEditors";
import qrManifest from "../../../../widgets/qr-code/tilecast.widget.json";

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
        component: {
          type: "tilecast.news",
          version: 1,
          tagName: "tc-widget-news",
          entrypoint: "./runtime/index.ts",
          configTemplate: {},
          dataSourceFields: [],
          empty: "render",
        },
        presentationSchemaVersion: 1,
        requiredCapabilities: {},
        emptyStateBehavior: "placeholder",
      },
      {
        id: "google-sheets-display",
        version: 1,
        name: "Google Sheets — Display",
        description: "Show the published spreadsheet itself as a web embed.",
        category: "Google",
        icon: "google-sheets",
        kind: "app",
        runtime: "web",
        webIntegration: { urlField: "url" },
        configurationSchema: {
          fields: [{ key: "url", label: "Published URL", control: "url" }],
        },
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
      {
        id: "qr-code",
        version: 1,
        apiVersion: 1,
        name: "QR Code",
        description:
          "Show a scannable code with an optional heading and instruction.",
        category: "Essentials",
        icon: "qr_code",
        runtime: "native",
        configurationSchema: qrManifest.configurationSchema as {
          fields: ContentDefinitionField[];
        },
        defaultConfiguration: qrManifest.defaultConfiguration,
        component: {
          type: "tilecast.qr-code",
          version: 1,
          tagName: "tc-widget-qr-code",
          entrypoint: "./runtime/index.ts",
          configTemplate: qrManifest.component.configTemplate,
          dataSourceFields: [],
          empty: "render",
        },
        compatibility: { fallback: "none" },
        presentationSchemaVersion: 1,
        requiredCapabilities: {},
        emptyStateBehavior: "text",
      },
      {
        id: "qrcode",
        version: 1,
        apiVersion: 1,
        name: "QR Code",
        description: "Display text or a URL as a scannable code.",
        category: "Essentials",
        icon: "qr_code",
        runtime: "native",
        configurationSchema: qrManifest.configurationSchema as {
          fields: ContentDefinitionField[];
        },
        defaultConfiguration: qrManifest.defaultConfiguration,
        component: {
          type: "tilecast.qr-code",
          version: 1,
          tagName: "tc-widget-qr-code",
          entrypoint: "./runtime/index.ts",
          configTemplate: {
            payload: {
              $config: "payload",
              default: { $config: "value", default: "" },
            },
            style: { $config: "style", default: "standard" },
          },
          dataSourceFields: [],
          empty: "render",
        },
        compatibility: { fallback: "legacy" },
        deprecation: { deprecated: true, replacement: "qr-code" },
        presentationSchemaVersion: 1,
        requiredCapabilities: {},
        emptyStateBehavior: "text",
      },
      {
        id: "qr-call-to-action",
        version: 1,
        apiVersion: 1,
        name: "QR Call to Action",
        description:
          "Pair a scannable code with a heading and short instruction.",
        category: "Essentials",
        icon: "qr",
        runtime: "native",
        configurationSchema: { fields: [] },
        defaultConfiguration: {},
        presentationSchemaVersion: 1,
        requiredCapabilities: {},
        emptyStateBehavior: "text",
        deprecation: { deprecated: true, replacement: "qr-code" },
      },
    ],
    dataSources: [],
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter([{ path: "*", element: editor }]);
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("Widget provider gallery", () => {
  it("groups visual Widgets by purpose and keeps Web Integrations apart", async () => {
    renderEditor(
      <WidgetProviderGallery onChoose={vi.fn()} onClose={vi.fn()} page />,
    );

    expect(
      await screen.findByRole("heading", { name: "Featured" }),
    ).toBeTruthy();
    // Web Integrations sit apart from the visual catalog; a provider's own
    // category (News, Google) no longer names a gallery group.
    expect(screen.getByRole("heading", { name: "Integrations" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Data display" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Google" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "News" })).toBeNull();
    expect(screen.getByRole("button", { name: /Notion/ })).toBeDisabled();

    await userEvent.type(screen.getByRole("searchbox"), "spreadsheet");
    expect(
      screen.getByRole("button", { name: /Google Sheets — Display/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /ESPN/ })).toBeNull();
  });

  it("traps focus in the modal gallery and restores it when closed", async () => {
    const user = userEvent.setup();
    function ModalGalleryHarness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open widget gallery
          </button>
          {open && (
            <WidgetProviderGallery
              onChoose={vi.fn()}
              onClose={() => setOpen(false)}
            />
          )}
        </>
      );
    }

    renderEditor(<ModalGalleryHarness />);
    const opener = screen.getByRole("button", { name: "Open widget gallery" });
    await user.click(opener);

    const dialog = await screen.findByRole(
      "dialog",
      { name: "Create Widget" },
      { timeout: 500 },
    );
    await screen.findByRole("heading", { name: "Featured" }, { timeout: 500 });
    await waitFor(
      () => {
        expect(dialog).toContainElement(document.activeElement as HTMLElement);
      },
      { timeout: 500 },
    );

    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();

    last?.focus();
    await user.tab();
    await waitFor(() => {
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    });
    first?.focus();
    await user.tab({ shift: true });
    await waitFor(() => {
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    });

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(opener).toHaveFocus();
  });

  it("shows canonical Status once and hides superseded catalog aliases", async () => {
    vi.spyOn(api, "contentDefinitions").mockResolvedValue({
      revision: "1",
      compilerVersion: "1",
      fingerprint: "test",
      widgets: [
        {
          id: "status",
          version: 1,
          apiVersion: 1,
          name: "Status",
          description: "Show a status and message.",
          category: "Information",
          icon: "status",
          runtime: "native",
          configurationSchema: { fields: [] },
          defaultConfiguration: {},
          component: {
            type: "tilecast.status",
            version: 1,
            tagName: "tc-widget-status",
            entrypoint: "./runtime/index.ts",
            configTemplate: {},
            dataSourceFields: [],
            empty: "render",
          },
          compatibility: { fallback: "template" },
          presentationSchemaVersion: 1,
          requiredCapabilities: {},
          emptyStateBehavior: "text",
        },
        ...["school-status-banner", "alert-banner"].map(
          (id): WidgetDefinition => ({
            id,
            version: 1,
            apiVersion: 1,
            name:
              id === "alert-banner" ? "Alert Banner" : "School Status Banner",
            description: "Saved alias.",
            category: "Information",
            icon: id,
            runtime: "native",
            configurationSchema: { fields: [] },
            defaultConfiguration: {},
            component: {
              type: "tilecast.status",
              version: 1,
              tagName: "tc-widget-status",
              entrypoint: "./runtime/index.ts",
              configTemplate: {},
              dataSourceFields: [],
              empty: "render",
            },
            compatibility: { fallback: "template" },
            deprecation: { deprecated: true, replacement: "status" },
            presentationSchemaVersion: 1,
            requiredCapabilities: {},
            emptyStateBehavior: "text",
          }),
        ),
        {
          id: "metric",
          version: 1,
          apiVersion: 1,
          name: "Metrics",
          description: "Show key numbers.",
          category: "Data display",
          icon: "metric",
          runtime: "native",
          configurationSchema: { fields: [] },
          defaultConfiguration: {},
          component: {
            type: "tilecast.metrics",
            version: 1,
            tagName: "tc-widget-metrics",
            entrypoint: "./runtime/index.ts",
            configTemplate: {},
            dataSourceFields: [],
            empty: "render",
          },
          compatibility: { fallback: "legacy" },
          presentationSchemaVersion: 1,
          requiredCapabilities: {},
          emptyStateBehavior: "text",
        },
        {
          id: "stat_grid",
          version: 1,
          apiVersion: 1,
          name: "Stat Grid",
          description: "Superseded by Metrics.",
          category: "Data display",
          icon: "stat_grid",
          runtime: "native",
          configurationSchema: { fields: [] },
          defaultConfiguration: {},
          compatibility: { fallback: "legacy" },
          deprecation: { deprecated: true, replacement: "metric" },
          presentationSchemaVersion: 1,
          requiredCapabilities: {},
          emptyStateBehavior: "text",
        },
        {
          id: "fundraising-thermometer",
          version: 1,
          apiVersion: 1,
          name: "Fundraising Thermometer",
          description: "Superseded by Progress.",
          category: "Data display",
          icon: "thermometer",
          runtime: "native",
          configurationSchema: { fields: [] },
          defaultConfiguration: {},
          compatibility: { fallback: "template" },
          deprecation: { deprecated: true, replacement: "progress" },
          presentationSchemaVersion: 1,
          requiredCapabilities: {},
          emptyStateBehavior: "text",
        },
      ],
      dataSources: [],
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <WidgetProviderGallery onChoose={vi.fn()} onClose={vi.fn()} page />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("heading", { name: "Information" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Status/ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Alert Banner/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /School Status Banner/ }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: /Metrics/ })).toBeTruthy();
    // Superseded providers stay resolvable for saved content but leave
    // new creation once their V2 replacement proves parity.
    expect(screen.queryByRole("button", { name: /Stat Grid/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Fundraising Thermometer/ }),
    ).toBeNull();
  });

  it("shows one QR Code for new creation once the legacy provider is superseded", async () => {
    renderEditor(
      <WidgetProviderGallery onChoose={vi.fn()} onClose={vi.fn()} page />,
    );

    await screen.findByRole("heading", { name: "Featured" });
    // The canonical Widget is the only QR choice; the deprecated legacy
    // provider stays resolvable for saved content but leaves the gallery.
    expect(screen.getAllByRole("button", { name: /QR Code/ })).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: /QR Call to Action/ }),
    ).toBeNull();
  });

  it("hides a type that cannot describe itself to the Widget editor", async () => {
    vi.spyOn(api, "contentDefinitions").mockResolvedValue({
      revision: "1",
      compilerVersion: "1",
      fingerprint: "test",
      widgets: [
        {
          id: "componentless",
          version: 1,
          name: "Componentless",
          description: "A native type with no component.",
          category: "Essentials",
          icon: "box",
          runtime: "native",
          configurationSchema: {
            fields: [{ key: "text", label: "Text", control: "text" }],
          },
          defaultConfiguration: {},
          presentationSchemaVersion: 1,
          requiredCapabilities: {},
          emptyStateBehavior: "text",
        },
        {
          id: "addressless",
          version: 1,
          name: "Addressless",
          description: "A web integration with no address field.",
          category: "Web and video",
          icon: "globe",
          runtime: "web",
          webIntegration: { urlField: "url" },
          configurationSchema: { fields: [] },
          defaultConfiguration: {},
          presentationSchemaVersion: 1,
          requiredCapabilities: {},
          emptyStateBehavior: "placeholder",
        },
        {
          id: "clock",
          version: 1,
          name: "Clock",
          description: "Show the time.",
          category: "Essentials",
          icon: "clock",
          runtime: "native",
          configurationSchema: { fields: [] },
          defaultConfiguration: {},
          component: {
            type: "tilecast.clock",
            version: 2,
            tagName: "tc-widget-clock",
            entrypoint: "./runtime/index.ts",
            configTemplate: {},
            dataSourceFields: [],
            empty: "render",
          },
          presentationSchemaVersion: 1,
          requiredCapabilities: {},
          emptyStateBehavior: "text",
        },
      ],
      dataSources: [],
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <WidgetProviderGallery onChoose={vi.fn()} onClose={vi.fn()} page />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("button", { name: /Clock/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Componentless/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Addressless/ })).toBeNull();
  });

  it("names a plugin-owned Widget's provenance while its plugin is installed", async () => {
    renderGalleryWithPluginSource(true);
    // The badge shows the plugin's name only after the plugin catalog
    // query resolves, so waiting for it waits for installation state too.
    await screen.findByText("Plugin · Emergency Alerts");
    const card = screen.getByRole("button", { name: /Siren/ });
    expect(card).not.toBeDisabled();
    expect(screen.queryByText(/Requires/)).toBeNull();
  });

  it("disables a plugin-owned Widget with its plugin named while uninstalled", async () => {
    const onChoose = vi.fn();
    renderGalleryWithPluginSource(false, onChoose);
    await screen.findByText("Plugin · Emergency Alerts");
    const card = screen.getByRole("button", { name: /Siren/ });
    expect(card).toBeDisabled();
    expect(screen.getByText("Requires Emergency Alerts")).toBeTruthy();
    expect(onChoose).not.toHaveBeenCalled();
  });
});

function renderGalleryWithPluginSource(
  installed: boolean,
  onChoose: (provider: string) => void = vi.fn(),
) {
  const siren = {
    id: "emergency_alerts_siren",
    version: 1,
    apiVersion: 1,
    name: "Siren",
    description: "Sound the siren.",
    category: "Essentials",
    icon: "siren",
    runtime: "native",
    source: { kind: "plugin", pluginId: "emergency_alerts" },
    configurationSchema: { fields: [] },
    defaultConfiguration: {},
    presentationSchemaVersion: 1,
    requiredCapabilities: {},
    emptyStateBehavior: "text",
    component: {
      type: "emergencyalerts.siren",
      version: 1,
      tagName: "tc-widget-emergencyalerts-siren",
      entrypoint: "./runtime/index.ts",
      configTemplate: {},
      dataSourceFields: [],
      empty: "render",
    },
    compatibility: { fallback: "none" },
  } satisfies WidgetDefinition;
  vi.spyOn(api, "contentDefinitions").mockResolvedValue({
    revision: "1",
    compilerVersion: "1",
    fingerprint: "test",
    widgets: [siren],
    dataSources: [],
  });
  vi.spyOn(api, "plugins").mockResolvedValue({
    items: [
      {
        id: "emergency_alerts",
        name: "Emergency Alerts",
        installed,
      },
    ],
    unsupportedInstallations: [],
  } as never);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <WidgetProviderGallery onChoose={onChoose} onClose={vi.fn()} page />
    </QueryClientProvider>,
  );
}
