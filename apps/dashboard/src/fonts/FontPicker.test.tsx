// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { FontFamily } from "../api/types";
import {
  StudioSessionProvider,
  testStudioSession,
} from "../plugin-host/testing";
import { FontPicker, type FontChoice } from "./FontPicker";

const FONT = "5c0a2f8e-3c1b-4d2a-9e7f-0a1b2c3d4e5f";
const { listFonts } = vi.hoisted(() => ({ listFonts: vi.fn() }));
vi.mock("../api/fonts", () => ({
  listFonts,
  searchFontCatalog: vi.fn(),
  getFontCatalogFamily: vi.fn(),
  importGoogleFont: vi.fn(),
  fontCatalogPreviewUrl: (id: string) => `/api/v1/fonts/catalog/${id}/preview`,
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

const chosen: FontChoice[] = [];

function Harness({ initial }: { initial: FontChoice }) {
  const [value, setValue] = useState<FontChoice>(initial);
  return (
    <FontPicker
      id="picker"
      label="Bar font"
      value={value}
      onChange={(next) => {
        chosen.push(next);
        setValue(next);
      }}
      builtIn={[{ value: "player", label: "Player default" }]}
      builtInLabel="Tilecast"
    />
  );
}

// Plugins render the picker with the session override only, never inside
// Studio's AuthProvider.
function renderPicker(initial: FontChoice, role = "owner") {
  render(
    <MemoryRouter>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <StudioSessionProvider session={testStudioSession(role)}>
          <Harness initial={initial} />
        </StudioSessionProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("FontPicker", () => {
  afterEach(() => {
    cleanup();
    chosen.length = 0;
    vi.clearAllMocks();
  });

  it("lists organization fonts before the caller's own choices", async () => {
    listFonts.mockResolvedValue([family]);
    renderPicker({ kind: "builtIn", value: "player" });
    const user = userEvent.setup();
    const trigger = await screen.findByRole("combobox", { name: "Bar font" });
    expect(trigger).toHaveTextContent("Player default");
    await user.click(trigger);
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Brand Display",
      "Player default",
    ]);
    expect(screen.getByText("Organization fonts")).toBeInTheDocument();
    expect(screen.getByText("Tilecast")).toBeInTheDocument();
    await user.click(options[0]!);
    expect(chosen).toEqual([{ kind: "library", id: FONT }]);
    await user.click(screen.getByRole("combobox", { name: "Bar font" }));
    await user.click(
      await screen.findByRole("option", { name: "Player default" }),
    );
    expect(chosen.at(-1)).toEqual({ kind: "builtIn", value: "player" });
  });

  it("keeps a removed family visible instead of showing another font", async () => {
    listFonts.mockResolvedValue([]);
    renderPicker({ kind: "library", id: FONT }, "viewer");
    expect(
      await screen.findByText("Removed font (uses the fallback)"),
    ).toBeInTheDocument();
    // A viewer cannot add fonts.
    expect(
      screen.queryByRole("button", { name: "Add fonts" }),
    ).not.toBeInTheDocument();
  });

  it("offers the add shortcut to people who manage settings", async () => {
    listFonts.mockResolvedValue([family]);
    renderPicker({ kind: "library", id: FONT });
    expect(
      await screen.findByRole("button", { name: "Add fonts" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Add or remove organization fonts" }),
    ).toHaveAttribute("href", "/settings/fonts");
  });
});
