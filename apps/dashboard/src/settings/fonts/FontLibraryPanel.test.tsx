// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "../../api/errors";
import type { FontFamily } from "../../api/types";
import { i18n } from "../../i18n";
import { FontLibraryPanel } from "./FontLibraryPanel";

const fonts = vi.hoisted(() => ({
  listFonts: vi.fn(),
  deleteFont: vi.fn(),
  uploadFont: vi.fn(),
  searchFontCatalog: vi.fn(),
  getFontCatalogFamily: vi.fn(),
  importGoogleFont: vi.fn(),
  fontCatalogPreviewUrl: (id: string) => `/api/v1/fonts/catalog/${id}/preview`,
}));
const { confirm } = vi.hoisted(() => ({
  confirm: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("../../api/fonts", () => fonts);
vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({ status: { csrfToken: "csrf" } }),
}));
vi.mock("../../components/ConfirmDialog", () => ({
  useConfirm: () => ({ confirm, dialog: null }),
}));

const inter: FontFamily = {
  id: "5c0a2f8e-3c1b-4d2a-9e7f-0a1b2c3d4e5f",
  family: "Inter",
  source: "google",
  sourceId: "inter",
  sourceVersion: "5.3.0",
  category: "sans-serif",
  license: "OFL-1.1",
  subsets: ["latin"],
  faces: [
    {
      id: "9d1e2f3a-4b5c-4d6e-8f70-112233445566",
      assetId: "1f8f2d8e-1b1a-4c55-9a0d-3d2f6c7b8a90",
      variantId: "7b6a5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d",
      style: "normal",
      weightMin: 100,
      weightMax: 900,
      subset: "latin",
      unicodeRange: "U+0000-00FF",
      mimeType: "font/woff2",
      fileSize: 48256,
      fileUrl: "/api/v1/fonts/x/faces/y/file",
    },
  ],
  totalBytes: 48256,
  createdAt: "2026-11-04T00:00:00Z",
  updatedAt: "2026-11-04T00:00:00Z",
};

function renderPanel(canManage = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <FontLibraryPanel canManage={canManage} />
    </QueryClientProvider>,
  );
}

describe("Font library panel", () => {
  beforeEach(() => {
    fonts.listFonts.mockResolvedValue([inter]);
  });
  afterEach(async () => {
    cleanup();
    vi.clearAllMocks();
    await i18n.changeLanguage("en");
  });

  it("lists families with their source, license, and files", async () => {
    renderPanel();
    expect(await screen.findByText("Inter")).toBeInTheDocument();
    expect(screen.getByText("Google Fonts")).toBeInTheDocument();
    expect(
      screen.getByText(/OFL-1\.1 · 1 file · 47\.1 KiB · latin/),
    ).toBeInTheDocument();
  });

  it("hides management controls from people who cannot change settings", async () => {
    renderPanel(false);
    expect(await screen.findByText("Inter")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add from Google Fonts" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove Inter" }),
    ).not.toBeInTheDocument();
  });

  it("shows the server's reason when a Layout still uses the family", async () => {
    fonts.deleteFont.mockRejectedValue(
      new ApiError(
        "Choose another font in these Layouts first: Lobby welcome.",
        409,
        "font_in_use",
      ),
    );
    renderPanel();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Remove Inter" }),
    );
    expect(
      await screen.findByText(
        "Choose another font in these Layouts first: Lobby welcome.",
      ),
    ).toBeInTheDocument();
    expect(fonts.deleteFont).toHaveBeenCalledWith(inter.id, "csrf");
  });

  it("uploads only after the rights confirmation", async () => {
    fonts.uploadFont.mockResolvedValue({
      family: { ...inter, family: "Brand Sans", source: "upload" },
      embeddingRestricted: true,
    });
    renderPanel();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Upload font files" }),
    );
    const file = new File(["font"], "BrandSans-Regular.ttf", {
      type: "font/ttf",
    });
    await user.upload(screen.getByLabelText("Font files"), file);
    const submit = screen.getByRole("button", { name: "Upload 1 file" });
    expect(submit).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", {
        name: "My organization has the right to show these fonts on its displays.",
      }),
    );
    await user.click(submit);
    await waitFor(() =>
      expect(fonts.uploadFont).toHaveBeenCalledWith(file, true, "csrf"),
    );
    expect(await screen.findByText(/may not be embedded/)).toBeInTheDocument();
  });

  it("copies the chosen subsets and styles of a catalog family", async () => {
    fonts.searchFontCatalog.mockResolvedValue({
      families: [
        {
          id: "lobster",
          family: "Lobster",
          category: "display",
          license: "OFL-1.1",
          subsets: ["latin", "cyrillic"],
          weights: [400],
          styles: ["normal"],
          defaultSubset: "latin",
          variable: false,
        },
      ],
      total: 1,
    });
    fonts.getFontCatalogFamily.mockResolvedValue({
      id: "lobster",
      family: "Lobster",
      category: "display",
      license: "OFL-1.1",
      subsets: ["latin", "cyrillic"],
      weights: [400],
      styles: ["normal"],
      defaultSubset: "latin",
      variable: false,
      version: "5.2.1",
      weightRange: null,
    });
    fonts.importGoogleFont.mockResolvedValue({ ...inter, family: "Lobster" });
    renderPanel();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Add from Google Fonts" }),
    );
    await user.click(await screen.findByRole("button", { name: /Lobster/ }));
    await user.click(await screen.findByRole("checkbox", { name: "cyrillic" }));
    await user.click(
      screen.getByRole("button", { name: "Add to organization" }),
    );
    await waitFor(() =>
      expect(fonts.importGoogleFont).toHaveBeenCalledWith(
        {
          sourceId: "lobster",
          subsets: ["latin", "cyrillic"],
          styles: ["normal"],
          weights: [400],
        },
        "csrf",
      ),
    );
  });

  it("explains when the catalog is turned off", async () => {
    await i18n.changeLanguage("es");
    fonts.searchFontCatalog.mockRejectedValue(
      new ApiError("English server wording", 503, "font_catalog_disabled"),
    );
    renderPanel();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: i18n.t("settings:fonts.addGoogle"),
      }),
    );
    expect(
      await screen.findByText(i18n.t("errors:codes.font_catalog_disabled")),
    ).toBeInTheDocument();
  });
});
