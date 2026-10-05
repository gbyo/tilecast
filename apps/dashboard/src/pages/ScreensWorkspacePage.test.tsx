// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { api } from "../api/client";
import { PairScreenDialog } from "../pairing/PairScreenDialog";
import { ScreensPage, ScreensWorkspacePage } from "./ScreensPage";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: { csrfToken: "csrf", user: { role: "owner" } },
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Pathname() {
  return <output>{useLocation().pathname}</output>;
}

function renderPairDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/screens/pair"]}>
        <Routes>
          <Route path="/screens/pair" element={<PairScreenDialog />} />
          <Route path="/screens" element={<p>Screens home</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderWorkspace(pathname: string) {
  vi.spyOn(api, "screens").mockResolvedValue({ items: [], total: 0 });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[pathname]}>
        <Pathname />
        <Routes>
          <Route path="/screens" element={<ScreensWorkspacePage />}>
            <Route index element={<p>Fleet view</p>} />
            <Route path="archive" element={<p>Archive view</p>} />
            <Route path="pair" element={<p>Pair route</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderFleetWorkspace() {
  vi.spyOn(api, "screens").mockResolvedValue({ items: [], total: 0 });
  vi.spyOn(api, "pendingPairings").mockResolvedValue({ items: [], total: 0 });
  vi.spyOn(api, "locations").mockResolvedValue({ items: [], total: 0 });
  vi.spyOn(api, "takeovers").mockResolvedValue({ items: [], total: 0 });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/screens"]}>
        <Routes>
          <Route path="/screens" element={<ScreensWorkspacePage />}>
            <Route index element={<ScreensPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Pair screen dialog", () => {
  it("renders pairing as a modal task and closes back to Screens", async () => {
    const user = userEvent.setup();
    renderPairDialog();

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "Pair a screen" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("textbox", { name: "Pairing code" }),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Close" }));

    expect(screen.getByText("Screens home")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("Screens workspace tabs", () => {
  it("selects Archive when opened directly and keeps its canonical path", () => {
    renderWorkspace("/screens/archive");

    expect(screen.getByRole("tab", { name: "Archive" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Archive view")).toBeInTheDocument();
    expect(screen.getByText("/screens/archive")).toBeInTheDocument();
  });

  it("uses Fleet tab activation to navigate back to /screens", async () => {
    const user = userEvent.setup();
    renderWorkspace("/screens/archive");

    await user.click(screen.getByRole("tab", { name: "Fleet" }));

    expect(screen.getByText("Fleet view")).toBeInTheDocument();
    expect(screen.getByText("/screens")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Fleet" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("keeps a direct pair route in the Fleet workspace", () => {
    renderWorkspace("/screens/pair");

    expect(screen.getByText("Pair route")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Fleet" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("names the page in the Studio top bar, not a second visible heading", async () => {
    renderFleetWorkspace();

    const title = await screen.findByRole("heading", {
      name: "Screens",
      level: 1,
    });
    // The h1 stays for document structure; it is not drawn in the body.
    expect(title).toHaveClass("sr-only");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
  });

  it("renders Fleet page actions once, with Takeover in the overflow menu", async () => {
    const user = userEvent.setup();
    renderFleetWorkspace();

    expect(
      await screen.findByRole("link", { name: "Pair screen" }),
    ).toBeInTheDocument();
    // Takeover no longer competes with Pair screen as a second button.
    expect(
      screen.queryByRole("button", { name: "Takeover" }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "More screen actions" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Takeover" }));
    expect(
      await screen.findByRole("dialog", { name: "Takeover" }),
    ).toBeInTheDocument();
  });
});
