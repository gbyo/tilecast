// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { NotificationsPanel } from "./NotificationsPanel";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ status: { csrfToken: "csrf-token" } }),
}));

describe("Notifications settings query errors", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows retry states instead of normal unavailable and empty states", async () => {
    const status = vi
      .spyOn(api, "notificationStatus")
      .mockRejectedValue(new Error("Network unavailable"));
    vi.spyOn(api, "notificationWebhooks").mockRejectedValue(
      new Error("Network unavailable"),
    );
    vi.spyOn(api, "notificationDeliveries").mockRejectedValue(
      new Error("Network unavailable"),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <NotificationsPanel manageable />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText("Email delivery status could not be checked."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Webhooks could not be loaded."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Recent deliveries could not be loaded."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Email is unavailable.")).not.toBeInTheDocument();
    expect(screen.queryByText("No webhooks")).not.toBeInTheDocument();
    expect(screen.queryByText("No deliveries")).not.toBeInTheDocument();

    const statusRetry = screen.getAllByRole("button", { name: "Retry" })[0];
    if (!statusRetry)
      throw new Error("Expected a retry button for email status");
    fireEvent.click(statusRetry);
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
  });
});
