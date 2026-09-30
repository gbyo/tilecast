// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
import { api } from "../api/client";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: {
      csrfToken: "csrf",
      user: { id: "user-1", name: "Owner", role: "owner" },
    },
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [{ path: "/settings/general", element: <SettingsPage /> }],
    { initialEntries: ["/settings/general"] },
  );
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("Settings page load failure", () => {
  it("renders the load error with retry instead of the settings shell", async () => {
    const settings = vi
      .spyOn(api, "settings")
      .mockRejectedValue(new Error("offline"));
    renderPage();

    expect(
      await screen.findByText("Settings could not be loaded."),
    ).toBeInTheDocument();
    expect(screen.getByText("offline")).toBeInTheDocument();
    expect(
      screen.queryByRole("navigation", { name: "Settings sections" }),
    ).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(settings).toHaveBeenCalledTimes(2);
  });
});
