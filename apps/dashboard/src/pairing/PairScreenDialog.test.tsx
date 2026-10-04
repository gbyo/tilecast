// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PairScreenDialog } from "./PairScreenDialog";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: { csrfToken: "csrf", user: { role: "owner" } },
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, "innerWidth", {
    writable: true,
    configurable: true,
    value: 1024,
  });
});

function renderDialog(path = "/screens/pair") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/screens/pair" element={<PairScreenDialog />} />
          <Route path="/screens/pair/:code" element={<PairScreenDialog />} />
          <Route
            path="/screens/pair/request/:requestId"
            element={<PairScreenDialog />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PairScreenDialog", () => {
  it("hosts the flow in a dialog on desktop widths", async () => {
    renderDialog();

    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="dialog-content"]'),
      ).toBeInTheDocument(),
    );
    expect(
      document.querySelector('[data-slot="drawer-content"]'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Pairing code" }),
    ).toBeInTheDocument();
  });

  it("hosts the same flow in a drawer on narrow screens", async () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 500,
    });
    renderDialog();

    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="drawer-content"]'),
      ).toBeInTheDocument(),
    );
    expect(
      document.querySelector('[data-slot="dialog-content"]'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Pairing code" }),
    ).toBeInTheDocument();
  });
});
