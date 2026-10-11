// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "../../api/client";
import { UpdateDeploymentDetail } from "./UpdateDeploymentDetail";
import { detail, fleet } from "./fixtures.test-support";
vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({ status: { csrfToken: "csrf", user: { role: "owner" } } }),
}));
function mount(manageable = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UpdateDeploymentDetail
        deploymentId="d1"
        screens={fleet}
        manageable={manageable}
        open
        onOpenChange={() => {}}
      />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.spyOn(api, "updateDeployment").mockResolvedValue(detail);
  vi.spyOn(api, "retryUpdateScreen").mockResolvedValue({ state: "pending" });
  vi.spyOn(api, "cancelUpdateDeployment").mockResolvedValue({
    id: "d1",
    status: "cancelled",
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("rollout detail", () => {
  it("sorts attention first, displays exact safe errors and real byte progress", async () => {
    mount();
    await screen.findByText("Not enough storage.");
    const items = screen.getAllByRole("listitem");
    expect(
      items.map((i) => i.textContent?.match(/ARM Hall|Library|Lobby/)?.[0]),
    ).toEqual(["ARM Hall", "Library", "Lobby"]);
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
    expect(screen.getByText(/25 MiB of 50 MiB/)).toBeInTheDocument();
    expect(screen.getByText(/25000 → 26006 · Offline/)).toBeInTheDocument();
    expect(screen.getByText("Tilecast Edge · x86_64")).toBeInTheDocument();
  });
  it("filters and searches status rows", async () => {
    mount();
    await screen.findByText("Lobby");
    await userEvent.click(
      screen.getByRole("button", { name: "Needs attention 1" }),
    );
    expect(screen.queryByText("Lobby")).not.toBeInTheDocument();
    expect(screen.getByText("ARM Hall")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Finished 1" }));
    expect(screen.getByText("Lobby")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox"), "No match");
    expect(
      screen.getByText("No screen matches this filter."),
    ).toBeInTheDocument();
  });
  it("offers retry only for failed rows and confirms cancellation before calling the server", async () => {
    mount();
    await screen.findByText("Lobby");
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(api.retryUpdateScreen).toHaveBeenCalledWith("d1", "s3", "csrf"),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Cancel deployment" }),
    );
    expect(api.cancelUpdateDeployment).not.toHaveBeenCalled();
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveTextContent(
      "Screens already updated stay on the new release.",
    );
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Cancel deployment" }),
    );
    await waitFor(() =>
      expect(api.cancelUpdateDeployment).toHaveBeenCalledWith("d1", "csrf"),
    );
  });
  it("gates cancel and retry by role and hides cancel for terminal deployments", async () => {
    mount(false);
    await screen.findByText("Lobby");
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Cancel deployment" }),
    ).not.toBeInTheDocument();
    cleanup();
    vi.mocked(api.updateDeployment).mockResolvedValue({
      ...detail,
      status: "completed",
    });
    mount();
    await screen.findByText("Lobby");
    expect(
      screen.queryByRole("button", { name: "Cancel deployment" }),
    ).not.toBeInTheDocument();
  });
  it("prefers incompatible safe_error over an Android-specific fallback", async () => {
    vi.mocked(api.updateDeployment).mockResolvedValue({
      ...detail,
      screens: [
        {
          ...detail.screens[2]!,
          state: "incompatible",
          safeError: "Requires x86_64; reports aarch64.",
        },
      ],
    });
    mount();
    expect(
      await screen.findByText("Requires x86_64; reports aarch64."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Android version/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
  });
});
