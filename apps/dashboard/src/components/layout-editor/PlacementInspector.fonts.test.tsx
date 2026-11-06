// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { FontFamily, LayoutPlacement } from "../../api/types";
import { layoutFontStack } from "../../layoutFonts";
import { PlacementInspector } from "./PlacementInspector";

const FONT = "5c0a2f8e-3c1b-4d2a-9e7f-0a1b2c3d4e5f";
const { listFonts, capabilities } = vi.hoisted(() => ({
  listFonts: vi.fn(),
  capabilities: { list: ["settings.manage"] as string[] },
}));

const catalog = vi.hoisted(() => ({
  searchFontCatalog: vi.fn(),
  getFontCatalogFamily: vi.fn(),
  importGoogleFont: vi.fn(),
}));

vi.mock("../../api/fonts", () => ({
  listFonts,
  ...catalog,
  fontCatalogPreviewUrl: (id: string) => `/api/v1/fonts/catalog/${id}/preview`,
}));
vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: { csrfToken: "csrf", capabilities: capabilities.list },
  }),
}));

const family: FontFamily = {
  id: FONT,
  family: "Brand Display",
  source: "upload",
  sourceId: "",
  sourceVersion: "",
  category: "",
  license: "",
  subsets: [],
  faces: [],
  totalBytes: 0,
  createdAt: "2026-11-04T00:00:00Z",
  updatedAt: "2026-11-04T00:00:00Z",
};

function textPlacement(primitive: Partial<LayoutPlacement["primitive"]> = {}) {
  return {
    id: "welcome",
    type: "primitive",
    name: "Welcome",
    x: 0,
    y: 0,
    width: 800,
    height: 200,
    layer: 0,
    opacity: 1,
    visible: true,
    locked: false,
    primitive: {
      kind: "text",
      text: "Welcome",
      fontFamily: "Roboto",
      ...primitive,
    },
  } as LayoutPlacement;
}

function renderInspector(item: LayoutPlacement) {
  const changes: LayoutPlacement[] = [];
  const update = (change: (item: LayoutPlacement) => void) => {
    const next = structuredClone(item);
    change(next);
    changes.push(next);
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <PlacementInspector
          item={item}
          dataSources={[]}
          update={update}
          duplicate={() => undefined}
          group={() => undefined}
          ungroup={() => undefined}
          canGroup={false}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return changes;
}

describe("Layout text font picker", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    capabilities.list = ["settings.manage"];
  });

  it("offers organization fonts and keeps the bundled family as fallback", async () => {
    listFonts.mockResolvedValue([family]);
    const changes = renderInspector(textPlacement());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("combobox", { name: "Font" }));
    await user.click(
      await screen.findByRole("option", { name: "Brand Display" }),
    );
    const changed = changes.at(-1)!.primitive!;
    expect(changed.fontId).toBe(FONT);
    expect(changed.fontFamily).toBe("Roboto");
    expect(
      screen.getByRole("link", { name: "Add or remove organization fonts" }),
    ).toHaveAttribute("href", "/settings/fonts");
  });

  it("adds a Google Fonts family from the picker and applies it", async () => {
    listFonts.mockResolvedValue([]);
    const lobster = {
      id: "lobster",
      family: "Lobster",
      category: "display",
      license: "OFL-1.1",
      subsets: ["latin"],
      weights: [400],
      styles: ["normal"],
      defaultSubset: "latin",
      variable: false,
    };
    catalog.searchFontCatalog.mockResolvedValue({
      families: [lobster],
      total: 1,
    });
    catalog.getFontCatalogFamily.mockResolvedValue({
      ...lobster,
      version: "5.3.0",
      weightRange: null,
    });
    catalog.importGoogleFont.mockResolvedValue({
      ...family,
      family: "Lobster",
    });
    const changes = renderInspector(textPlacement());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add fonts" }));
    await user.click(await screen.findByRole("button", { name: /Lobster/ }));
    await user.click(
      await screen.findByRole("button", { name: "Add to organization" }),
    );
    await vi.waitFor(() =>
      expect(changes.at(-1)?.primitive?.fontId).toBe(FONT),
    );
    expect(catalog.importGoogleFont).toHaveBeenCalledWith(
      {
        sourceId: "lobster",
        subsets: ["latin"],
        styles: ["normal"],
        weights: [400],
      },
      "csrf",
    );
  });

  it("clears the library family when a built-in font is chosen", async () => {
    listFonts.mockResolvedValue([family]);
    const changes = renderInspector(textPlacement({ fontId: FONT }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("combobox", { name: "Font" }));
    await user.click(await screen.findByRole("option", { name: "Inter" }));
    const changed = changes.at(-1)!.primitive!;
    expect(changed.fontId).toBeUndefined();
    expect(changed.fontFamily).toBe("Inter");
  });

  it("names a removed family instead of showing a blank choice", async () => {
    listFonts.mockResolvedValue([]);
    capabilities.list = [];
    renderInspector(textPlacement({ fontId: FONT }));
    expect(
      await screen.findByText("Removed font (uses the fallback)"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Add or remove organization fonts" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add fonts" }),
    ).not.toBeInTheDocument();
  });
});

describe("Layout text font stacks", () => {
  it("draws the library family first, then the bundled fallback", () => {
    expect(layoutFontStack("Roboto", FONT)).toBe(
      `"tcf-${FONT}", "Roboto", ui-sans-serif, system-ui, sans-serif`,
    );
    expect(layoutFontStack("Roboto")).toBe(
      '"Roboto", ui-sans-serif, system-ui, sans-serif',
    );
    expect(layoutFontStack(undefined, 'x", red')).toBe(
      '"Inter", ui-sans-serif, system-ui, sans-serif',
    );
  });
});
