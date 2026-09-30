// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { ContentReviewPage } from "./ContentReviewPage";
import { ApiError, api } from "../api/client";
import { i18n } from "../i18n";
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

const review = {
  id: "44444444-4444-4444-8444-444444444444",
  contentType: "playlist",
  contentId: "55555555-5555-4555-8555-555555555555",
  revision: 7,
  decision: "approved",
  reviewedAt: "2026-07-30T11:00:00Z",
} as const;

describe("Content review", () => {
  beforeEach(() => {
    role = "editor";
  });
  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await i18n.changeLanguage("en");
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
      .mockResolvedValue(review);
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
      .mockResolvedValue(review);
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

  it("filters the queue by review state with a single pressed toggle", async () => {
    const reviews = vi.spyOn(api, "contentReviews").mockResolvedValue({
      required: true,
      items: [],
    });
    const user = userEvent.setup();
    renderPage();

    const group = await screen.findByRole("group", { name: "Review state" });
    expect(group).toBeTruthy();
    const pendingItem = screen.getByRole("button", {
      name: "Waiting for review",
    });
    expect(pendingItem.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(reviews).toHaveBeenCalledWith("pending"));

    await user.click(screen.getByRole("button", { name: "Sent back" }));
    await waitFor(() => expect(reviews).toHaveBeenCalledWith("rejected"));
    expect(
      screen
        .getByRole("button", { name: "Sent back" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(pendingItem.getAttribute("aria-pressed")).toBe("false");

    // Pressing the active filter again keeps it selected.
    await user.click(screen.getByRole("button", { name: "Sent back" }));
    expect(
      screen
        .getByRole("button", { name: "Sent back" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    await user.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(reviews).toHaveBeenCalledWith(""));
  });

  it("presents queue load failures through the localized API error path", async () => {
    await i18n.changeLanguage("ru");
    vi.spyOn(api, "contentReviews").mockRejectedValue(
      new ApiError("Server-provided queue failure.", 429, "rate_limited"),
    );
    renderPage();
    expect(
      await screen.findByText(
        "Слишком много попыток. Подождите немного и повторите попытку.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Server-provided queue failure.")).toBe(null);
  });

  it("presents decision failures through the localized API error path", async () => {
    await i18n.changeLanguage("ru");
    vi.spyOn(api, "contentReviews").mockResolvedValue({
      required: true,
      items: [pending],
    });
    vi.spyOn(api, "decideContentReview").mockRejectedValue(
      new ApiError("Server-provided decision failure.", 429, "rate_limited"),
    );
    renderPage();
    const user = userEvent.setup();
    // The queue renders both a mobile card list and a desktop table, so the
    // Review action exists twice; either one opens the same sheet.
    const reviewButtons = await screen.findAllByRole("button", {
      name: "Проверить",
    });
    await user.click(reviewButtons[0]!);
    await user.click(
      await screen.findByRole("button", { name: "Согласовать" }),
    );
    expect(
      await screen.findByText(
        "Слишком много попыток. Подождите немного и повторите попытку.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Server-provided decision failure.")).toBe(null);
  });
});
