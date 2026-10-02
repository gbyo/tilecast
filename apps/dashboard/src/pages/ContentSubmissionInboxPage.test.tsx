// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { ContentSubmissionInboxPage } from "./ContentSubmissionInboxPage";
import { api, ApiError } from "../api/client";
import type { ContentSubmission } from "../api/types";
import { i18n } from "../i18n";
import { formatLocale } from "../i18n/languages";
import { toast } from "../components/ui/toast";

// The page renders a card list for narrow screens and a table for wide ones,
// and hides one with CSS. jsdom applies no CSS, so tests read the table.
const desktop = async () => within(await screen.findByRole("table"));

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
  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await i18n.changeLanguage("en");
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
      await (await desktop()).findByRole("link", { name: /Lobby Loop/ }),
    ).toBeTruthy();
    await user.click(
      await (await desktop()).findByRole("button", { name: "Review" }),
    );
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

    await user.click(
      await (await desktop()).findByRole("button", { name: "Review" }),
    );
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

  it("filters submissions by state with a single pressed toggle", async () => {
    const list = vi.spyOn(api, "contentSubmissions").mockResolvedValue({
      policy: "everyone",
      allowSelfApproval: false,
      autoPublishOnApproval: false,
      items: [],
    });
    const user = userEvent.setup();
    renderPage();

    expect(
      await screen.findByRole("group", { name: "Submission state" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Needs review" }),
    ).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(list).toHaveBeenCalledWith("in_review"));

    await user.click(screen.getByRole("button", { name: "Published" }));
    await waitFor(() => expect(list).toHaveBeenCalledWith("published"));
    expect(screen.getByRole("button", { name: "Published" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Needs review" }),
    ).toHaveAttribute("aria-pressed", "false");

    await user.click(screen.getByRole("button", { name: "All history" }));
    await waitFor(() => expect(list).toHaveBeenCalledWith(""));
  });

  it("formats table and sheet dates in the selected Studio locale", async () => {
    await i18n.changeLanguage("es");
    vi.spyOn(api, "contentSubmissions").mockResolvedValue({
      policy: "everyone",
      allowSelfApproval: false,
      autoPublishOnApproval: false,
      items: [submission],
    });
    renderPage();
    const expected = new Date(submission.submittedAt).toLocaleString(
      formatLocale("es"),
    );
    const table = await screen.findByRole("table");
    expect(table.textContent).toContain(expected);

    const user = userEvent.setup();
    await user.click(
      within(table).getByRole("button", {
        name: i18n.t("review:submissions.table.reviewAction"),
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(expected);
  });

  it("uses localized fallback copy for submission load failures", async () => {
    await i18n.changeLanguage("es");
    vi.spyOn(api, "contentSubmissions").mockRejectedValue(
      new Error("raw transport details"),
    );
    renderPage();

    expect(
      await screen.findByText(
        i18n.t("review:submissions.loadErrorDescription"),
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("raw transport details")).not.toBeInTheDocument();
  });

  it("uses the action fallback instead of exposing unexpected error text", async () => {
    await i18n.changeLanguage("es");
    vi.spyOn(api, "contentSubmissions").mockResolvedValue({
      policy: "everyone",
      allowSelfApproval: false,
      autoPublishOnApproval: false,
      items: [submission],
    });
    vi.spyOn(api, "approveContentSubmission").mockRejectedValue(
      new Error("raw transport details"),
    );
    const addToast = vi.spyOn(toast, "add");
    renderPage();
    const user = userEvent.setup();
    const table = await desktop();
    await user.click(
      await table.findByRole("button", {
        name: i18n.t("review:submissions.table.reviewAction"),
      }),
    );
    const sheet = await screen.findByRole("dialog");
    await user.click(
      within(sheet).getByRole("button", {
        name: i18n.t("review:submissions.reviewForm.approve"),
      }),
    );

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith({
        title: i18n.t("review:submissions.toast.approveFailed"),
        type: "error",
      }),
    );
    expect(addToast).not.toHaveBeenCalledWith({
      title: "raw transport details",
      type: "error",
    });
  });

  it("localizes API error codes for submission actions", async () => {
    await i18n.changeLanguage("es");
    vi.spyOn(api, "contentSubmissions").mockResolvedValue({
      policy: "everyone",
      allowSelfApproval: false,
      autoPublishOnApproval: false,
      items: [submission],
    });
    vi.spyOn(api, "approveContentSubmission").mockRejectedValue(
      new ApiError("English server wording", 429, "rate_limited"),
    );
    const addToast = vi.spyOn(toast, "add");
    renderPage();
    const user = userEvent.setup();
    const table = await desktop();
    await user.click(
      await table.findByRole("button", {
        name: i18n.t("review:submissions.table.reviewAction"),
      }),
    );
    const sheet = await screen.findByRole("dialog");
    await user.click(
      within(sheet).getByRole("button", {
        name: i18n.t("review:submissions.reviewForm.approve"),
      }),
    );

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith({
        title: i18n.t("errors:codes.rate_limited"),
        type: "error",
      }),
    );
    expect(addToast).not.toHaveBeenCalledWith({
      title: "English server wording",
      type: "error",
    });
  });
});
