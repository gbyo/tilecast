// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { ContentReviewPage } from "./ContentReviewPage";
import { api } from "../api/client";
import type { ContentReviewItem } from "../api/types";

let role = "editor";
vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ status: { csrfToken: "csrf", user: { role } } }),
}));

const pending: ContentReviewItem = {
  contentType: "playlist",
  contentId: "p1",
  name: "Cafeteria Menu",
  revision: 7,
  state: "pending",
  assignedScreens: 3,
  updatedAt: "2026-03-04T12:00:00Z",
  authorName: "Student Council",
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ContentReviewPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Content review", () => {
  beforeEach(() => {
    role = "editor";
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("says approval is not enforced when the setting is off", async () => {
    vi.spyOn(api, "contentReviews").mockResolvedValue({
      required: false,
      items: [],
    });
    renderPage();
    expect(
      await screen.findByText(/Approval is not required on this installation/),
    ).toBeTruthy();
  });

  it("flags content that is already on screens as the urgent case", async () => {
    vi.spyOn(api, "contentReviews").mockResolvedValue({
      required: true,
      items: [pending],
    });
    renderPage();
    expect(await screen.findByText("Cafeteria Menu")).toBeTruthy();
    expect(screen.getByText(/Already on 3 screens/)).toBeTruthy();
    expect(screen.getByText(/revision 7/)).toBeTruthy();
  });

  it("sends the revision that was reviewed, so a later edit cannot inherit the approval", async () => {
    vi.spyOn(api, "contentReviews").mockResolvedValue({
      required: true,
      items: [pending],
    });
    const decide = vi
      .spyOn(api, "decideContentReview")
      .mockResolvedValue(undefined);
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Review" }));
    await user.click(await screen.findByRole("button", { name: "Approve" }));

    await waitFor(() => expect(decide).toHaveBeenCalled());
    const [contentType, , decision] = decide.mock.calls[0] ?? [];
    expect(contentType).toBe("playlist");
    expect(decision).toMatchObject({ approve: true, revision: 7 });
  });

  it("passes the note along when sending content back", async () => {
    vi.spyOn(api, "contentReviews").mockResolvedValue({
      required: true,
      items: [pending],
    });
    const decide = vi
      .spyOn(api, "decideContentReview")
      .mockResolvedValue(undefined);
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Review" }));
    await user.click(await screen.findByRole("button", { name: "Send back" }));
    const dialog = await screen.findByRole("dialog");
    const note = await screen.findByLabelText("Note");
    await user.type(note, "Wrong date");
    const confirm = screen
      .getAllByRole("button", { name: "Send back" })
      .find((button) => dialog.contains(button));
    expect(confirm).toBeTruthy();
    await user.click(confirm!);

    await waitFor(() => expect(decide).toHaveBeenCalled());
    const [, , decision] = decide.mock.calls[0] ?? [];
    expect(decision).toMatchObject({ approve: false, note: "Wrong date" });
  });

  it("shows a contributor the queue without decision controls", async () => {
    role = "contributor";
    vi.spyOn(api, "contentReviews").mockResolvedValue({
      required: true,
      items: [pending],
    });
    renderPage();
    expect(await screen.findByText("Cafeteria Menu")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review" })).toBe(null);
    expect(screen.queryByRole("button", { name: "Approve" })).toBe(null);
    expect(screen.queryByRole("button", { name: "Send back" })).toBe(null);
  });
});
