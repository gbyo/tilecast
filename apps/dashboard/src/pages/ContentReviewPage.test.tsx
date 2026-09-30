// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { ContentReviewPage } from "./ContentReviewPage";
import { ApiError } from "../api/errors";
import { api } from "../api/client";
import type { ContentReviewItem } from "../api/types";
import { toast } from "../components/ui/toast";
import { i18n } from "../i18n";

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
  beforeEach(async () => {
    role = "editor";
    await i18n.changeLanguage("en");
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

  it("localizes API errors when the review queue fails to load", async () => {
    await i18n.changeLanguage("es");
    try {
      vi.spyOn(api, "contentReviews").mockRejectedValue(
        new ApiError(
          "The server response was English.",
          503,
          "database_unavailable",
        ),
      );
      renderPage();

      expect(
        await screen.findByText("La base de datos no está lista."),
      ).toBeTruthy();
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("uses translated fallback copy for a queue transport failure", async () => {
    await i18n.changeLanguage("ru");
    try {
      vi.spyOn(api, "contentReviews").mockRejectedValue(
        new TypeError("Failed to fetch"),
      );
      renderPage();

      expect(
        await screen.findByText("Не удалось загрузить очередь проверки."),
      ).toBeTruthy();
      expect(screen.queryByText("Failed to fetch")).toBeNull();
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("shows a localized decision failure once in a toast", async () => {
    vi.spyOn(api, "contentReviews").mockResolvedValue({
      required: true,
      items: [pending],
    });
    vi.spyOn(api, "decideContentReview").mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    const addToast = vi.spyOn(toast, "add");
    renderPage();
    const user = userEvent.setup();
    await user.click(
      (await screen.findAllByRole("button", { name: "Review" }))[0]!,
    );
    await user.click(await screen.findByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith({
        title: "Could not record the decision.",
        type: "error",
      }),
    );
    expect(screen.queryByText("Failed to fetch")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("flags content that is already on screens as the urgent case", async () => {
    vi.spyOn(api, "contentReviews").mockResolvedValue({
      required: true,
      items: [pending],
    });
    renderPage();
    expect(
      (await screen.findAllByText("Cafeteria Menu")).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/Already on 3 screens/).length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText(/revision 7/).length).toBeGreaterThan(0);
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
    await user.click(
      (await screen.findAllByRole("button", { name: "Review" }))[0]!,
    );
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
    await user.click(
      (await screen.findAllByRole("button", { name: "Review" }))[0]!,
    );
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
    expect(
      (await screen.findAllByText("Cafeteria Menu")).length,
    ).toBeGreaterThan(0);
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
});
