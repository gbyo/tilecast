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
import { RouterProvider, createMemoryRouter } from "react-router";
import { FormDataSourcePage } from "./FormDataSourcePage";
import { StudioSessionProvider } from "@tilecast/studio/testing";
import { ApprovalsPage } from "./ApprovalsPage";
import { formsApi } from "./api";
import { ApiError } from "@tilecast/studio";

import type {
  FormCapability,
  FormDataSource,
  FormRecord,
  FormRecordDetail,
  FormWorkflow,
} from "./types";

// The page renders a card list for narrow screens and a table for wide ones,
// and hides one with CSS. jsdom applies no CSS, so tests read the table.
const desktop = async () => within(await screen.findByRole("table"));

class RequestWithoutSignal extends globalThis.Request {
  constructor(input: RequestInfo | URL, init: RequestInit = {}) {
    const rest = { ...init };
    delete (rest as { signal?: unknown }).signal;
    super(input, rest);
  }
}
globalThis.Request = RequestWithoutSignal;
globalThis.URL.createObjectURL = vi.fn(() => "blob:mock");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function testSession(role = "viewer") {
  return {
    csrfToken: "tok",
    role,
    canManage: role === "owner" || role === "administrator",
    authenticated: true,
    setupRequired: false,
    isLoading: false,
    isSubmitting: false,
    logout: () => Promise.resolve(),
  };
}

const workflow: FormWorkflow = {
  states: [
    {
      key: "draft",
      label: "Draft",
      position: 0,
      eligibleForOutput: false,
      initial: true,
      terminal: false,
    },
    {
      key: "submitted",
      label: "Submitted",
      position: 1,
      eligibleForOutput: false,
      initial: false,
      terminal: false,
    },
    {
      key: "changes_requested",
      label: "Changes requested",
      position: 2,
      eligibleForOutput: false,
      initial: false,
      terminal: false,
    },
    {
      key: "approved",
      label: "Approved",
      position: 3,
      eligibleForOutput: true,
      initial: false,
      terminal: false,
    },
  ],
  transitions: [
    {
      from: "submitted",
      to: "approved",
      label: "Approve",
      requiredCapability: "approve",
      position: 0,
    },
    {
      from: "submitted",
      to: "changes_requested",
      label: "Request changes",
      requiredCapability: "review",
      position: 1,
    },
  ],
};

const schema = {
  fields: [
    {
      key: "title",
      label: "Title",
      control: "short_text" as const,
      required: true,
    },
  ],
};

function form(capabilities: FormCapability[]): FormDataSource {
  return {
    id: "f1",
    name: "Announcements",
    description: "",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    draftSchema: schema,
    publishedRevision: {
      id: "r1",
      dataSourceId: "f1",
      revisionNumber: 1,
      title: "Announcement",
      description: "",
      schema,
      publishedAt: "2026-01-01T00:00:00Z",
    },
    workflow,
    views: [],
    grantedCapabilities: capabilities,
  };
}

function record(overrides: Partial<FormRecord> = {}): FormRecord {
  return {
    id: "rec1",
    dataSourceId: "f1",
    revisionId: "r1",
    state: "submitted",
    values: { title: "Hello" },
    submittedBy: "u2",
    submitterName: "Sam",
    displayTitle: "Hello",
    priority: 0,
    eligible: false,
    version: 3,
    createdAt: "2026-01-02T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

function detail(overrides: Partial<FormRecordDetail> = {}): FormRecordDetail {
  return {
    ...record(),
    revision: {
      id: "r1",
      dataSourceId: "f1",
      revisionNumber: 1,
      title: "Announcement",
      description: "",
      schema,
      publishedAt: "2026-01-01T00:00:00Z",
    },
    events: [],
    comments: [],
    attachments: [],
    canEdit: false,
    canComment: true,
    canDelete: false,
    availableTransitions: [
      {
        to: "approved",
        toLabel: "Approved",
        label: "Approve",
        requiredCapability: "approve",
        requiresNote: false,
      },
      {
        to: "changes_requested",
        toLabel: "Changes requested",
        label: "Request changes",
        requiredCapability: "review",
        requiresNote: true,
      },
    ],
    ...overrides,
  };
}

function renderReview(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [{ path: "/plugins/forms/:id", element: <FormDataSourcePage /> }],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={client}>
      <StudioSessionProvider session={testSession("editor")}>
        <RouterProvider router={router} />
      </StudioSessionProvider>
    </QueryClientProvider>,
  );
  return router;
}

describe("Responses tab and record review", () => {
  it("lists responses and opens a record for review", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(form(["review"]));
    vi.spyOn(formsApi, "listFormRecords").mockResolvedValue({
      items: [record()],
      total: 1,
      page: 1,
      pageSize: 25,
    });
    const getRecord = vi
      .spyOn(formsApi, "getFormRecord")
      .mockResolvedValue(detail());
    const user = userEvent.setup();
    renderReview("/plugins/forms/f1?tab=responses");

    // The record row links to the review and the state filter defaults to "Needs review".
    const row = await (
      await desktop()
    ).findByRole("link", { name: "Review Hello" });
    await user.click(row);

    await waitFor(() => expect(getRecord).toHaveBeenCalledWith("f1", "rec1"));
    // Server-provided transitions render as buttons.
    expect(
      await screen.findByRole("button", { name: "Approve" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Request changes" }),
    ).toBeInTheDocument();
  });

  it("runs an approve transition with the current version", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(form(["approve"]));
    vi.spyOn(formsApi, "getFormRecord").mockResolvedValue(detail());
    const transition = vi
      .spyOn(formsApi, "transitionFormRecord")
      .mockResolvedValue(record({ state: "approved", version: 4 }));
    const user = userEvent.setup();
    renderReview("/plugins/forms/f1?tab=responses&record=rec1");

    await user.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(transition).toHaveBeenCalled());
    expect(transition.mock.calls[0]![2]).toMatchObject({
      toState: "approved",
      version: 3,
    });
  });

  it("requires a note before requesting changes", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(form(["review"]));
    vi.spyOn(formsApi, "getFormRecord").mockResolvedValue(detail());
    const transition = vi.spyOn(formsApi, "transitionFormRecord");
    const user = userEvent.setup();
    renderReview("/plugins/forms/f1?tab=responses&record=rec1");

    await user.click(
      await screen.findByRole("button", { name: "Request changes" }),
    );
    // The decision dialog states the requirement and keeps confirm disabled
    // until a note is entered.
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/note is required/i);
    const confirm = screen
      .getAllByRole("button", { name: "Request changes" })
      .find((button) => dialog.contains(button));
    expect(confirm).toBeDisabled();
    expect(transition).not.toHaveBeenCalled();
  });

  it("refreshes stale record state on a 409 while preserving the unsent note", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(form(["approve"]));
    const getRecord = vi
      .spyOn(formsApi, "getFormRecord")
      .mockResolvedValueOnce(detail({ displayTitle: "Original title" }))
      // The record changed elsewhere: the recover refetch returns the newer server version.
      .mockResolvedValue(
        detail({ displayTitle: "Changed remotely", version: 9 }),
      );
    vi.spyOn(formsApi, "transitionFormRecord").mockRejectedValue(
      new ApiError("conflict", 409, "conflict"),
    );
    const user = userEvent.setup();
    renderReview("/plugins/forms/f1?tab=responses&record=rec1");

    // Type a note in the decision dialog that must survive conflict recovery.
    await user.click(
      await screen.findByRole("button", { name: "Request changes" }),
    );
    const dialog = await screen.findByRole("dialog");
    const note = await screen.findByLabelText("Note");
    await user.type(note, "Looks good to me");
    const confirm = screen
      .getAllByRole("button", { name: "Request changes" })
      .find((button) => dialog.contains(button));
    await user.click(confirm!);

    expect(
      await screen.findByText(/changed since you opened it/i),
    ).toBeInTheDocument();
    // Stale local state is replaced with the fresh server record...
    await waitFor(() =>
      expect(screen.getByText("Changed remotely")).toBeInTheDocument(),
    );
    await waitFor(() => expect(getRecord.mock.calls.length).toBeGreaterThan(1));
    // ...but the unsent note is preserved for retry.
    expect(screen.getByLabelText("Note")).toHaveValue("Looks good to me");
  });
});

describe("Central approvals inbox", () => {
  it("lists pending items and opens the shared review on click", async () => {
    vi.spyOn(formsApi, "listApprovals").mockResolvedValue({
      items: [
        {
          recordId: "rec1",
          dataSourceId: "f1",
          formName: "Announcements",
          title: "Field trip",
          submitterName: "Sam",
          state: "submitted",
          stateLabel: "Submitted",
          submittedAt: "2026-01-02T00:00:00Z",
        },
      ],
      total: 1,
      page: 1,
      pageSize: 25,
    });
    const user = userEvent.setup();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const router = createMemoryRouter(
      [
        { path: "/approvals", element: <ApprovalsPage /> },
        { path: "/plugins/forms/:id", element: <div>Review route</div> },
      ],
      { initialEntries: ["/approvals"] },
    );
    render(
      <QueryClientProvider client={client}>
        <StudioSessionProvider session={testSession("editor")}>
          <RouterProvider router={router} />
        </StudioSessionProvider>
      </QueryClientProvider>,
    );

    await user.click(
      await (await desktop()).findByRole("link", { name: "Field trip" }),
    );
    expect(await screen.findByText("Review route")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/plugins/forms/f1");
    expect(router.state.location.search).toContain("record=rec1");
  });

  it("confirms before closing the review sheet with unsaved edits", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(form(["review"]));
    vi.spyOn(formsApi, "getFormRecord").mockResolvedValue(
      detail({ canEdit: true }),
    );
    const user = userEvent.setup();
    const router = renderReview("/plugins/forms/f1?tab=responses&record=rec1");

    await user.type(await screen.findByLabelText("Display title"), " updated");
    await user.click(screen.getByRole("button", { name: /Back to responses/ }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Leave without saving?",
    });
    expect(
      within(dialog).getByText("This review has unsaved changes."),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Discard changes" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(router.state.location.search).not.toContain("record="),
    );
  });
});
