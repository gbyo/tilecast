// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../../api/client";
import { DisplayGroupDetailPage } from "./DisplayGroupDetailPage";

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: {
      csrfToken: "csrf",
      user: { id: "owner-1", name: "Owner", role: "owner" },
    },
  }),
}));

function stubRelatedQueries() {
  const empty = { items: [] } as never;
  vi.spyOn(api, "screens").mockResolvedValue(empty);
  vi.spyOn(api, "screenGroups").mockResolvedValue(empty);
  vi.spyOn(api, "playlists").mockResolvedValue(empty);
  vi.spyOn(api, "layouts").mockResolvedValue(empty);
}

function renderGroupDetail() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/groups/group-1"]}>
        <Routes>
          <Route path="/groups/:id" element={<DisplayGroupDetailPage />} />
          <Route path="/groups" element={<h1>Display Groups index</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DisplayGroupDetailPage request states", () => {
  it("keeps the skeleton while loading and offers retry after a failure", async () => {
    stubRelatedQueries();
    let rejectPending!: (reason: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => {
      rejectPending = reject;
    });
    const loadGroup = vi
      .spyOn(api, "screenGroup")
      .mockReturnValueOnce(pending)
      .mockRejectedValue(new Error("Connection refused"));
    renderGroupDetail();

    expect(await screen.findByLabelText("Loading group")).toBeInTheDocument();
    rejectPending(new Error("Connection refused"));
    expect(
      await screen.findByRole("heading", {
        name: "Display Group could not be loaded",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Try again, or return to Display Groups."),
    ).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(loadGroup).toHaveBeenCalledTimes(2));
    expect(
      screen.getByRole("link", { name: "Back to Display Groups" }),
    ).toHaveAttribute("href", "/groups");
  });

  it("shows a not-found state with navigation back to Display Groups", async () => {
    stubRelatedQueries();
    vi.spyOn(api, "screenGroup").mockRejectedValue(
      new ApiError("Not found", 404, "schedule_not_found"),
    );
    renderGroupDetail();

    expect(
      await screen.findByRole("heading", { name: "Display Group not found" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "It may have been deleted, or the link may be out of date.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("link", { name: "Back to Display Groups" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Display Groups index" }),
    ).toBeInTheDocument();
  });
});
