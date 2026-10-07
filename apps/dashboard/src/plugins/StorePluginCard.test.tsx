// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginStoreEntry } from "../api/types";
import {
  catalogPlugin,
  customPackage,
  marketplaceListing,
} from "./catalogFixtures";
import { StorePluginCard, StorePluginCardSkeleton } from "./StorePluginCard";
import { storeCardView, storeCategoryLabel } from "./storeCardView";

// i18n-ignore: test route marker, not Studio copy
const detailRoute = "Plugin detail";

afterEach(cleanup);

const iconUrl = "/api/v1/plugin-store/acme.weather/artwork/icon?v=abc123";

const includedIconUrl =
  "/api/v1/plugin-store/countdown_bar/artwork/icon?v=0123456789ab";

function included(
  overrides = {},
  presentation?: PluginStoreEntry["included"],
): PluginStoreEntry {
  const plugin = catalogPlugin({ id: "countdown_bar", ...overrides });
  return {
    packageId: plugin.id,
    source: { kind: "included" },
    plugin,
    ...(presentation ? { included: presentation } : {}),
  };
}

/** An included plugin whose release ships Store presentation. */
function includedWithStore(overrides = {}): PluginStoreEntry {
  return included(overrides, {
    publisherName: "Tilecast",
    artwork: { iconUrl: includedIconUrl },
  });
}

function marketplace(
  overrides: Parameters<typeof marketplaceListing>[0] = {},
): PluginStoreEntry {
  return {
    packageId: "acme.weather",
    source: { kind: "marketplace", catalogId: "tilecast-marketplace" },
    marketplace: marketplaceListing(overrides),
  };
}

function custom(
  overrides: Parameters<typeof customPackage>[0] = {},
): PluginStoreEntry {
  return {
    packageId: "acme.kiosk",
    source: { kind: "custom", repository: "https://github.com/acme/kiosk" },
    custom: customPackage(overrides),
  };
}

function renderCard(entry: PluginStoreEntry, variant?: "default" | "featured") {
  const view = storeCardView(entry);
  if (!view) throw new Error("fixture has no card view");
  return render(
    <MemoryRouter initialEntries={["/plugins/store"]}>
      <Routes>
        <Route
          path="/plugins/store"
          element={<StorePluginCard view={view} variant={variant} />}
        />
        <Route path="/plugins/store/:id" element={<p>{detailRoute}</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("storeCardView", () => {
  it("normalizes included, marketplace, and custom entries into one shape", () => {
    expect(storeCardView(includedWithStore())).toMatchObject({
      packageId: "countdown_bar",
      to: "/plugins/store/countdown_bar",
      pluginId: "countdown_bar",
      publisher: "Tilecast",
      iconUrl: includedIconUrl,
      compatible: true,
      updateAvailable: false,
      source: { kind: "included" },
    });
    expect(
      storeCardView(
        marketplace({
          categories: ["data", "sports"],
          featured: true,
          updateAvailable: true,
          installed: true,
          artwork: { iconUrl },
        }),
      ),
    ).toMatchObject({
      name: "Weather",
      publisher: "Acme",
      pluginId: undefined,
      iconUrl,
      categories: ["data", "sports"],
      featured: true,
      updateAvailable: true,
      installed: true,
    });
    expect(storeCardView(custom({ compatible: false }))).toMatchObject({
      name: "Lobby Kiosk",
      publisher: "Acme",
      iconUrl: undefined,
      compatible: false,
      featured: false,
      updateAvailable: false,
    });
  });

  it("encodes the detail route and tolerates entries with no detail", () => {
    const entry = marketplace();
    expect(storeCardView({ ...entry, packageId: "acme.a b" })?.to).toBe(
      "/plugins/store/acme.a%20b",
    );
    expect(
      storeCardView({ packageId: "x", source: { kind: "included" } }),
    ).toBeNull();
  });

  it("degrades to the built-in glyph without Store metadata", () => {
    expect(storeCardView(included())).toMatchObject({
      pluginId: "countdown_bar",
      publisher: undefined,
      iconUrl: undefined,
    });
  });

  it("never lets an included plugin take marketplace artwork", () => {
    const entry = included();
    entry.marketplace = marketplaceListing({ artwork: { iconUrl } });
    expect(storeCardView(entry)?.iconUrl).toBeUndefined();
  });
});

describe("StorePluginCard", () => {
  it("renders an included plugin with its first-party icon and publisher", () => {
    const { container } = renderCard(
      includedWithStore({ category: "Display" }),
    );
    const card = container.querySelector("[data-slot='card']") as HTMLElement;
    expect(card).toHaveAttribute("data-source", "included");
    expect(
      within(card).getByRole("link", { name: "Countdown Bar" }),
    ).toBeInTheDocument();
    expect(within(card).getByText("by Tilecast")).toBeVisible();
    expect(within(card).getByText("Included with Tilecast")).toBeVisible();
    expect(within(card).getByText("Display")).toBeVisible();
    const image = card.querySelector(
      "[data-slot='store-card-icon'] img",
    ) as HTMLImageElement;
    expect(image.getAttribute("src")).toBe(includedIconUrl);
    expect(image).toHaveAttribute("alt", "");
    // Cards never carry screenshot carousels.
    expect(card.querySelectorAll("img")).toHaveLength(1);
  });

  it("shows the built-in glyph when an included plugin ships no artwork", () => {
    const { container } = renderCard(included({ category: "Display" }));
    const card = container.querySelector("[data-slot='card']") as HTMLElement;
    expect(card.querySelector("img")).toBeNull();
    expect(
      card.querySelector("[data-slot='store-card-icon'] svg"),
    ).not.toBeNull();
    expect(within(card).queryByText(/^by /)).toBeNull();
  });

  it("falls back to the built-in glyph when included artwork fails to load", () => {
    const { container } = renderCard(includedWithStore());
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(container.querySelector("img")).toBeNull();
    expect(
      container.querySelector("[data-slot='store-card-icon'] svg"),
    ).not.toBeNull();
    expect(screen.getByText("by Tilecast")).toBeVisible();
  });

  it("renders a marketplace listing with publisher, provenance, and artwork", () => {
    const { container } = renderCard(
      marketplace({ categories: ["data"], artwork: { iconUrl } }),
    );
    const card = container.querySelector("[data-slot='card']") as HTMLElement;
    expect(card).toHaveAttribute("data-source", "marketplace");
    expect(within(card).getByText("by Acme")).toBeVisible();
    expect(within(card).getByText("Marketplace")).toBeVisible();
    expect(within(card).getByText("data")).toBeVisible();
    const image = card.querySelector("img") as HTMLImageElement;
    // Studio loads artwork only from the server's own path, as decoration.
    expect(image.getAttribute("src")).toBe(iconUrl);
    expect(image).toHaveAttribute("alt", "");
    expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
  });

  it("renders a custom entry with the fallback icon and its provenance", () => {
    const { container } = renderCard(custom());
    const card = container.querySelector("[data-slot='card']") as HTMLElement;
    expect(card).toHaveAttribute("data-source", "custom");
    expect(within(card).getByText("Custom")).toBeVisible();
    expect(within(card).getByText("by Acme")).toBeVisible();
    expect(card.querySelector("img")).toBeNull();
    expect(card.querySelector("svg.lucide-puzzle")).not.toBeNull();
  });

  it("falls back to the generic icon when a marketplace listing has no artwork", () => {
    const { container } = renderCard(marketplace());
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg.lucide-puzzle")).not.toBeNull();
  });

  it("falls back to the generic icon when artwork fails to load", () => {
    const { container } = renderCard(marketplace({ artwork: { iconUrl } }));
    const image = container.querySelector("img") as HTMLImageElement;
    fireEvent.error(image);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg.lucide-puzzle")).not.toBeNull();
    // The failed image never breaks the rest of the card.
    expect(screen.getByRole("link", { name: "Weather" })).toBeVisible();
    expect(screen.getByText("Marketplace")).toBeVisible();
  });

  it("shows installed, update, and incompatible state as text", () => {
    renderCard(
      marketplace({
        installed: true,
        installedVersion: "0.9.0",
        updateAvailable: true,
        compatible: false,
      }),
    );
    expect(screen.getByText("Installed")).toBeVisible();
    expect(screen.getByText("Update available")).toBeVisible();
    expect(screen.getByText("Incompatible")).toBeVisible();
  });

  it("shows no status badges for a plain compatible listing", () => {
    renderCard(marketplace());
    expect(screen.queryByText("Installed")).toBeNull();
    expect(screen.queryByText("Update available")).toBeNull();
    expect(screen.queryByText("Incompatible")).toBeNull();
  });

  it("keeps the incompatible warning compact and leaves the card usable", () => {
    const { container } = renderCard(marketplace({ compatible: false }));
    const badge = screen.getByText("Incompatible");
    expect(badge.closest("[data-slot='card-action']")).not.toBeNull();
    expect(container.querySelector("[data-slot='card']")).not.toHaveClass(
      "opacity-50",
    );
    expect(screen.getByRole("link", { name: "Weather" })).toBeVisible();
  });

  it("collapses categories beyond two into a count", () => {
    renderCard(
      marketplace({ categories: ["data", "sports", "news", "kiosk"] }),
    );
    expect(screen.getByText("data")).toBeVisible();
    expect(screen.getByText("sports")).toBeVisible();
    expect(screen.queryByText("news")).toBeNull();
    expect(screen.getByText("+2")).toBeVisible();
  });

  it("clamps the description and keeps the card from showing detail-page data", () => {
    const { container } = renderCard(marketplace());
    const description = screen.getByText("Current conditions.");
    expect(description).toHaveClass("line-clamp-2");
    const card = container.querySelector("[data-slot='card']") as HTMLElement;
    for (const detail of ["sha256:", "github.com", ">=0.0.0", "MIT", "1.0.0"]) {
      expect(card).not.toHaveTextContent(detail);
    }
  });

  it("renders a larger featured variant of the same card", () => {
    const { container } = renderCard(marketplace(), "featured");
    const card = container.querySelector("[data-slot='card']") as HTMLElement;
    expect(card).toHaveAttribute("data-variant", "featured");
    expect(screen.getByText("Current conditions.")).toHaveClass("line-clamp-3");
    expect(card.querySelector("[data-slot='store-card-icon']")).toHaveClass(
      "size-14",
    );
  });

  it("makes the whole card one keyboard-reachable navigation target", async () => {
    const user = userEvent.setup();
    const { container } = renderCard(marketplace());
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    const link = links[0] as HTMLElement;
    expect(link).toHaveAttribute("href", "/plugins/store/acme.weather");
    // The link stretches over the card, so a click anywhere reaches it.
    expect(link.className).toContain("after:absolute");
    expect(link.className).toContain("after:inset-0");
    expect(container.querySelector("[data-slot='card']")).toHaveClass(
      "relative",
      "has-focus-visible:ring-2",
    );

    await user.tab();
    expect(link).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await screen.findByText("Plugin detail")).toBeVisible();
  });
});

describe("StorePluginCardSkeleton", () => {
  it("matches the card's structure and is hidden from assistive technology", () => {
    const { container } = render(<StorePluginCardSkeleton />);
    const skeleton = container.querySelector("[data-slot='card']");
    expect(skeleton).toHaveAttribute("aria-hidden", "true");
    expect(skeleton?.querySelector("[data-slot='card-header']")).not.toBeNull();
    expect(
      skeleton?.querySelector("[data-slot='card-content']"),
    ).not.toBeNull();
    expect(skeleton?.querySelector("[data-slot='card-footer']")).not.toBeNull();
    expect(
      skeleton?.querySelectorAll("[data-slot='skeleton']").length,
    ).toBeGreaterThan(3);
  });
});

describe("storeCategoryLabel", () => {
  it("localizes Studio categories and shows marketplace slugs as written", () => {
    const t = ((key: string) => `t:${key}`) as never;
    expect(storeCategoryLabel("Display", t)).toBe(
      "t:catalog.categories.display",
    );
    expect(storeCategoryLabel("hardware", t)).toBe(
      "t:catalog.categories.hardware",
    );
    expect(storeCategoryLabel("sports", t)).toBe("sports");
  });
});
