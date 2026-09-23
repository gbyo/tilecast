// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { ContentSubmissionInboxPage } from "./ContentSubmissionInboxPage";
import { api } from "../api/client";
import type { ContentSubmission } from "../api/types";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: {
      csrfToken: "csrf",
      user: { role: "editor", id: "u1", username: "ed" },
    },
  }),
}));

const submission: ContentSubmission = {
  id: "s1",
  contentType: "playlist",
  contentId: "p1",
  contentName: "Lobby Loop",
  workingRevision: 4,
  snapshot: { items: [] },
  snapshotSha256: "abc123",
  submitterName: "Sam",
  submittedAt: "2026-03-04T12:00:00Z",
  status: "in_review",
  reviewRequired: true,
  allowSelfApproval: false,
  newerWorkingDraft: false,
  affectedScreenCount: 2,
  affectedLocationCount: 1,
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ContentSubmissionInboxPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Content submission inbox", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("lists submissions in a table and approves from the review sheet", async () => {
    vi.spyOn(api, "contentSubmissions").mockResolvedValue({
      policy: "everyone",
      allowSelfApproval: false,
      autoPublishOnApproval: false,
      items: [submission],
    });
    const approve = vi
      .spyOn(api, "approveContentSubmission")
      .mockResolvedValue(submission);
    renderPage();
    const user = userEvent.setup();

    expect(
      await screen.findByRole("link", { name: /Lobby Loop/ }),
    ).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "Review" }));
    const sheet = await screen.findByRole("dialog");
    expect(sheet).toHaveTextContent("Draft revision 4");
    const approveButton = screen
      .getAllByRole("button", { name: "Approve" })
      .find((button) => sheet.contains(button));
    await user.click(approveButton!);

    await waitFor(() => expect(approve).toHaveBeenCalled());
    expect(approve.mock.calls[0]).toMatchObject(["s1", "", "csrf"]);
  });

  it("requires a reason before sending a submission back", async () => {
    vi.spyOn(api, "contentSubmissions").mockResolvedValue({
      policy: "everyone",
      allowSelfApproval: false,
      autoPublishOnApproval: false,
      items: [submission],
    });
    const requestChanges = vi.spyOn(api, "requestContentChanges");
    renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Review" }));
    const sheet = await screen.findByRole("dialog");
    const openReject = screen
      .getAllByRole("button", { name: "Request changes" })
      .find((button) => sheet.contains(button));
    await user.click(openReject!);

    const dialogs = await screen.findAllByRole("dialog");
    const rejectDialog = dialogs[dialogs.length - 1]!;
    const confirm = screen
      .getAllByRole("button", { name: "Send back" })
      .find((button) => rejectDialog.contains(button));
    expect(confirm).toBeDisabled();
    const reason = await screen.findByLabelText("Reason for sending back");
    await user.type(reason, "Fix the closing slide");
    await user.click(confirm!);

    await waitFor(() => expect(requestChanges).toHaveBeenCalled());
    expect(requestChanges.mock.calls[0]).toMatchObject([
      "s1",
      "Fix the closing slide",
      "csrf",
    ]);
  });

  it("shows an empty state when nothing matches the filter", async () => {
    vi.spyOn(api, "contentSubmissions").mockResolvedValue({
      policy: "everyone",
      allowSelfApproval: false,
      autoPublishOnApproval: false,
      items: [],
    });
    renderPage();
    expect(
      await screen.findByText("No submissions match this view"),
    ).toBeTruthy();
  });
});
