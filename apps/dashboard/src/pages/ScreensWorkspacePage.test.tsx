// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { api } from "../api/client";
import { PairScreenDialog, ScreensWorkspacePage } from "./ScreensPage";

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
});
