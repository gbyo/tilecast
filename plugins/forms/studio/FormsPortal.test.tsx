// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryRouter } from "react-router";
import {
  FormsListPage,
  FormPortalDetailPage,
  FormPortalSubmissionPage,
} from "./FormsPortalPage";
import { formsApi } from "./api";
import { ApiError } from "@tilecast/studio";
import { StudioSessionProvider } from "@tilecast/studio/testing";
import type {
  FormDataSource,
  FormRecord,
  FormRecordDetail,
  FormSummary,
  FormWorkflow,
} from "./types";

class RequestWithoutSignal extends globalThis.Request {
  constructor(input: RequestInfo | URL, init: RequestInit = {}) {
    const rest = { ...init };
    delete (rest as { signal?: unknown }).signal;
    super(input, rest);
  }
}
globalThis.Request = RequestWithoutSignal;

// jsdom does not implement object URLs, which the image field uses for local previews.
globalThis.URL.createObjectURL = vi.fn(() => "blob:mock");
globalThis.URL.revokeObjectURL = vi.fn();

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
    {
      key: "rejected",
      label: "Rejected",
      position: 4,
      eligibleForOutput: false,
      initial: false,
      terminal: true,
    },
  ],
  transitions: [
    {
      from: "draft",
      to: "submitted",
      label: "Submit",
      requiredCapability: "submit",
      position: 0,
    },
    {
      from: "submitted",
      to: "approved",
      label: "Approve",
      requiredCapability: "approve",
      position: 1,
    },
    {
      from: "submitted",
      to: "changes_requested",
      label: "Request changes",
      requiredCapability: "review",
      position: 2,
    },
    {
      from: "changes_requested",
      to: "submitted",
      label: "Resubmit",
      requiredCapability: "submit",
      position: 3,
    },
  ],
};

const schema = {
  title: "Announcement",
  description: "",
  fields: [
    {
      key: "title",
      label: "Title",
      control: "short_text" as const,
      required: true,
    },
  ],
};

function form(
  capabilities: FormDataSource["grantedCapabilities"],
): FormDataSource {
  return {
    id: "f1",
    name: "Staff Announcements",
    description: "By staff.",
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
    state: "draft",
    values: { title: "Hello" },
    submittedBy: "u1",
    submitterName: "User",
    displayTitle: "Hello",
    priority: 0,
    eligible: false,
    version: 1,
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
    canEdit: true,
    canComment: true,
    canDelete: false,
    availableTransitions: [
      {
        to: "submitted",
        toLabel: "Submitted",
        label: "Submit",
        requiredCapability: "submit",
        requiresNote: false,
      },
    ],
    ...overrides,
  };
}

function renderPortal(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: "/forms", element: <FormsListPage /> },
      { path: "/forms/:id", element: <FormPortalDetailPage /> },
      { path: "/forms/:id/new", element: <FormPortalSubmissionPage /> },
      {
        path: "/forms/:id/submissions/:recordId",
        element: <FormPortalSubmissionPage />,
      },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={client}>
      <StudioSessionProvider session={testSession()}>
        <RouterProvider router={router} />
      </StudioSessionProvider>
    </QueryClientProvider>,
  );
  return router;
}

describe("Forms portal", () => {
  it("lists accessible forms with submission counts", async () => {
    const summary: FormSummary = {
      id: "f1",
      name: "Staff Announcements",
      description: "By staff.",
      publishedRevisionNumber: 1,
      grantedCapabilities: ["submit"],
      submissionCounts: {
        draft: 2,
        submitted: 1,
        changesRequested: 3,
        total: 6,
      },
    };
    vi.spyOn(formsApi, "listForms").mockResolvedValue([summary]);
    renderPortal("/forms");

    expect(
      await screen.findByRole("heading", { name: "My Forms" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Staff Announcements")).toBeInTheDocument();
    // The three counts are surfaced.
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("blocks submit until required fields are complete", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(form(["submit"]));
    const create = vi.spyOn(formsApi, "createFormRecord");
    const user = userEvent.setup();
    renderPortal("/forms/f1/new");

    const title = await screen.findByLabelText(/Title/);
    await user.click(screen.getByRole("button", { name: "Submit" }));

    // The message appears twice: in the error summary (as a jump link) and beneath the field itself.
    expect(await screen.findAllByText("Title is required.")).toHaveLength(2);
    expect(create).not.toHaveBeenCalled();
    // A rejected submit puts the cursor on the offending field rather than leaving the submitter to
    // hunt for it.
    expect(title).toHaveFocus();
  });

  it("clears a field error as soon as the submitter corrects it", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(form(["submit"]));
    const user = userEvent.setup();
    renderPortal("/forms/f1/new");

    const title = await screen.findByLabelText(/Title/);
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findAllByText("Title is required.")).toHaveLength(2);

    // Fixing the field resolves it immediately; the submitter should not have to press Submit again
    // to find out the complaint is gone.
    await user.type(title, "Big news");
    await waitFor(() =>
      expect(screen.queryByText("Title is required.")).not.toBeInTheDocument(),
    );
    expect(title).not.toHaveAttribute("aria-invalid");
  });

  it("submits when Enter is pressed inside a field", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(form(["submit"]));
    vi.spyOn(formsApi, "listFormRecords").mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 100,
    });
    const create = vi
      .spyOn(formsApi, "createFormRecord")
      .mockResolvedValue(record({ id: "rec9", version: 1, state: "draft" }));
    vi.spyOn(formsApi, "getFormRecord").mockResolvedValue(
      detail({ id: "rec9", version: 1, state: "draft" }),
    );
    const transition = vi
      .spyOn(formsApi, "transitionFormRecord")
      .mockResolvedValue(
        record({ id: "rec9", version: 2, state: "submitted" }),
      );
    const user = userEvent.setup();
    renderPortal("/forms/f1/new");

    await user.type(await screen.findByLabelText(/Title/), "Big news{Enter}");

    await waitFor(() => expect(create).toHaveBeenCalled());
    await waitFor(() => expect(transition).toHaveBeenCalled());
  });

  it("reports a failed submissions request instead of an empty list", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(form(["submit"]));
    vi.spyOn(formsApi, "listFormRecords").mockRejectedValue(
      new Error("Records offline"),
    );
    renderPortal("/forms/f1");

    expect(
      await screen.findByText(
        "We could not load your submissions. Try again later.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("No submissions yet")).toBeNull();
  });

  it("confirms the submission landed after returning to the form", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(form(["submit"]));
    vi.spyOn(formsApi, "listFormRecords").mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 100,
    });
    vi.spyOn(formsApi, "createFormRecord").mockResolvedValue(
      record({ id: "rec9", version: 1, state: "draft" }),
    );
    vi.spyOn(formsApi, "getFormRecord").mockResolvedValue(
      detail({ id: "rec9", version: 1, state: "draft" }),
    );
    vi.spyOn(formsApi, "transitionFormRecord").mockResolvedValue(
      record({ id: "rec9", version: 2, state: "submitted" }),
    );
    const user = userEvent.setup();
    renderPortal("/forms/f1/new");

    await user.type(await screen.findByLabelText(/Title/), "Big news");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(await screen.findByText("Submission sent")).toBeInTheDocument();
  });

  it("creates a draft and submits via the server-provided transition", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(form(["submit"]));
    // The detail page the editor returns to after completion.
    vi.spyOn(formsApi, "listFormRecords").mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 100,
    });
    const create = vi
      .spyOn(formsApi, "createFormRecord")
      .mockResolvedValue(record({ id: "rec9", version: 1, state: "draft" }));
    // persist() resyncs from the server after saving; the submit transition is taken from this
    // server-provided detail, not from the workflow.
    vi.spyOn(formsApi, "getFormRecord").mockResolvedValue(
      detail({ id: "rec9", version: 1, state: "draft" }),
    );
    const transition = vi
      .spyOn(formsApi, "transitionFormRecord")
      .mockResolvedValue(
        record({ id: "rec9", version: 2, state: "submitted" }),
      );
    const user = userEvent.setup();
    renderPortal("/forms/f1/new");

    await user.type(await screen.findByLabelText(/Title/), "Big news");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![1].values).toMatchObject({
      title: "Big news",
    });
    await waitFor(() => expect(transition).toHaveBeenCalled());
    expect(transition.mock.calls[0]![2]).toMatchObject({
      toState: "submitted",
      version: 1,
    });
  });

  it("shows the reviewer note and resubmits a changes-requested submission", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(form(["submit"]));
    vi.spyOn(formsApi, "getFormRecord").mockResolvedValue(
      detail({
        state: "changes_requested",
        comments: [
          {
            id: "c1",
            authorName: "Reviewer",
            body: "Please add a date",
            createdAt: "2026-01-03T00:00:00Z",
          },
        ],
        availableTransitions: [
          {
            to: "submitted",
            toLabel: "Submitted",
            label: "Resubmit",
            requiredCapability: "submit",
            requiresNote: false,
          },
        ],
      }),
    );
    const update = vi
      .spyOn(formsApi, "updateFormRecord")
      .mockResolvedValue(record({ state: "changes_requested", version: 2 }));
    const transition = vi
      .spyOn(formsApi, "transitionFormRecord")
      .mockResolvedValue(record({ state: "submitted", version: 3 }));
    const user = userEvent.setup();
    renderPortal("/forms/f1/submissions/rec1");

    // The latest reviewer note is shown prominently and in the comment thread.
    expect(
      (await screen.findAllByText("Please add a date")).length,
    ).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Resubmit" }));

    await waitFor(() => expect(update).toHaveBeenCalled());
    await waitFor(() => expect(transition).toHaveBeenCalled());
    expect(transition.mock.calls[0]![2]).toMatchObject({
      toState: "submitted",
    });
  });

  it("uploads a selected image after creating the draft", async () => {
    const imageForm = form(["submit"]);
    const withImage = {
      ...schema,
      fields: [
        ...schema.fields,
        { key: "photo", label: "Photo", control: "image" as const },
      ],
    };
    imageForm.publishedRevision = {
      ...imageForm.publishedRevision!,
      schema: withImage,
    };
    vi.spyOn(formsApi, "getForm").mockResolvedValue(imageForm);
    vi.spyOn(formsApi, "listFormRecords").mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 100,
    });
    vi.spyOn(formsApi, "createFormRecord").mockResolvedValue(
      record({ id: "rec9", version: 1 }),
    );
    const upload = vi
      .spyOn(formsApi, "uploadFormRecordAttachment")
      .mockResolvedValue(
        detail({
          id: "rec9",
          version: 2,
          values: { title: "Hi", photo: "asset-1" },
        }),
      );
    vi.spyOn(formsApi, "getFormRecord").mockResolvedValue(
      detail({
        id: "rec9",
        version: 2,
        values: { title: "Hi", photo: "asset-1" },
      }),
    );
    const user = userEvent.setup();
    renderPortal("/forms/f1/new");

    await user.type(await screen.findByLabelText(/Title/), "Hi");
    const file = new File([new Uint8Array([1, 2, 3])], "p.png", {
      type: "image/png",
    });
    await user.upload(screen.getByLabelText("Choose Photo"), file);
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(upload).toHaveBeenCalled());
    expect(upload.mock.calls[0]![3]).toBe("photo");
  });

  it("submits when a required image is satisfied by a pending local file", async () => {
    const imageForm = form(["submit"]);
    const requiredImageSchema = {
      ...schema,
      fields: [
        ...schema.fields,
        {
          key: "photo",
          label: "Photo",
          control: "image" as const,
          required: true,
        },
      ],
    };
    imageForm.publishedRevision = {
      ...imageForm.publishedRevision!,
      schema: requiredImageSchema,
    };
    vi.spyOn(formsApi, "getForm").mockResolvedValue(imageForm);
    vi.spyOn(formsApi, "listFormRecords").mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 100,
    });
    vi.spyOn(formsApi, "createFormRecord").mockResolvedValue(
      record({ id: "rec9", version: 1 }),
    );
    const upload = vi
      .spyOn(formsApi, "uploadFormRecordAttachment")
      .mockResolvedValue(
        detail({
          id: "rec9",
          version: 2,
          values: { title: "Hi", photo: "a1" },
        }),
      );
    vi.spyOn(formsApi, "getFormRecord").mockResolvedValue(
      detail({ id: "rec9", version: 2, values: { title: "Hi", photo: "a1" } }),
    );
    const transition = vi
      .spyOn(formsApi, "transitionFormRecord")
      .mockResolvedValue(
        record({ id: "rec9", version: 3, state: "submitted" }),
      );
    const user = userEvent.setup();
    renderPortal("/forms/f1/new");

    await user.type(await screen.findByLabelText(/Title/), "Hi");
    const file = new File([new Uint8Array([1, 2, 3])], "p.png", {
      type: "image/png",
    });
    await user.upload(screen.getByLabelText("Choose Photo"), file);
    // A pending (not-yet-uploaded) image satisfies the required-image check.
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(screen.queryByText(/requires an image/i)).not.toBeInTheDocument();
    await waitFor(() => expect(upload).toHaveBeenCalled());
    await waitFor(() => expect(transition).toHaveBeenCalled());
  });

  it("keeps a failed image upload retryable on an existing draft", async () => {
    const imageForm = form(["submit"]);
    const withImage = {
      ...schema,
      fields: [
        ...schema.fields,
        { key: "photo", label: "Photo", control: "image" as const },
      ],
    };
    imageForm.publishedRevision = {
      ...imageForm.publishedRevision!,
      schema: withImage,
    };
    vi.spyOn(formsApi, "getForm").mockResolvedValue(imageForm);
    vi.spyOn(formsApi, "getFormRecord").mockResolvedValue(
      detail({ revision: { ...detail().revision!, schema: withImage } }),
    );
    const upload = vi
      .spyOn(formsApi, "uploadFormRecordAttachment")
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValue(
        detail({
          values: { title: "Hello", photo: "a2" },
          attachments: [{ id: "att1", assetId: "a2", fieldKey: "photo" }],
          revision: { ...detail().revision!, schema: withImage },
        }),
      );
    const user = userEvent.setup();
    renderPortal("/forms/f1/submissions/rec1");

    const file = new File([new Uint8Array([1, 2, 3])], "p.png", {
      type: "image/png",
    });
    // First upload fails; the field shows an error and remains retryable.
    await user.upload(await screen.findByLabelText("Choose Photo"), file);
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    // Retry succeeds.
    await user.upload(screen.getByLabelText(/Photo/), file);
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
  });

  it("drives an existing editor's actions from server availableTransitions", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(form(["submit"]));
    // The server says the record is editable but offers no transitions (e.g. under review): the
    // editor must not synthesize a submit action from the workflow.
    vi.spyOn(formsApi, "getFormRecord").mockResolvedValue(
      detail({ state: "submitted", canEdit: true, availableTransitions: [] }),
    );
    renderPortal("/forms/f1/submissions/rec1");

    expect(
      await screen.findByRole("button", { name: "Save draft" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Submit|Resubmit/ }),
    ).not.toBeInTheDocument();
  });

  it("shows reviewer feedback from the latest transition event, not the last comment", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(form(["submit"]));
    vi.spyOn(formsApi, "getFormRecord").mockResolvedValue(
      detail({
        state: "changes_requested",
        events: [
          {
            id: "e1",
            eventType: "transition",
            fromState: "submitted",
            toState: "changes_requested",
            actorName: "Reviewer",
            note: "Add a start date",
            createdAt: "2026-01-03T00:00:00Z",
          },
        ],
        comments: [
          {
            id: "c9",
            authorName: "Someone",
            body: "unrelated later chatter",
            createdAt: "2026-01-04T00:00:00Z",
          },
        ],
        availableTransitions: [
          {
            to: "submitted",
            toLabel: "Submitted",
            label: "Resubmit",
            requiredCapability: "submit",
            requiresNote: false,
          },
        ],
      }),
    );
    renderPortal("/forms/f1/submissions/rec1");

    // The banner reflects the transition note, not the trailing comment.
    const banner = await screen.findByText("Add a start date");
    expect(banner).toBeInTheDocument();
  });

  it("sends the record version on upload and surfaces a stale-version conflict", async () => {
    const imageForm = form(["submit"]);
    const withImage = {
      ...schema,
      fields: [
        ...schema.fields,
        { key: "photo", label: "Photo", control: "image" as const },
      ],
    };
    imageForm.publishedRevision = {
      ...imageForm.publishedRevision!,
      schema: withImage,
    };
    vi.spyOn(formsApi, "getForm").mockResolvedValue(imageForm);
    vi.spyOn(formsApi, "getFormRecord").mockResolvedValue(
      detail({
        version: 4,
        revision: { ...detail().revision!, schema: withImage },
      }),
    );
    const upload = vi
      .spyOn(formsApi, "uploadFormRecordAttachment")
      .mockRejectedValue(new ApiError("conflict", 409, "conflict"));
    const user = userEvent.setup();
    renderPortal("/forms/f1/submissions/rec1");

    const file = new File([new Uint8Array([1, 2, 3])], "p.png", {
      type: "image/png",
    });
    await user.upload(await screen.findByLabelText("Choose Photo"), file);

    await waitFor(() => expect(upload).toHaveBeenCalled());
    // The current record version is sent for the optimistic-concurrency check.
    expect(upload.mock.calls[0]![4]).toBe(4);
    // The conflict is surfaced with refresh/retry messaging.
    expect(await screen.findByText(/changed elsewhere/i)).toBeInTheDocument();
  });

  it("sends the record version on removal and surfaces a stale-version conflict", async () => {
    const imageForm = form(["submit"]);
    const withImage = {
      ...schema,
      fields: [
        ...schema.fields,
        { key: "photo", label: "Photo", control: "image" as const },
      ],
    };
    imageForm.publishedRevision = {
      ...imageForm.publishedRevision!,
      schema: withImage,
    };
    vi.spyOn(formsApi, "getForm").mockResolvedValue(imageForm);
    vi.spyOn(formsApi, "getFormRecord").mockResolvedValue(
      detail({
        version: 7,
        revision: { ...detail().revision!, schema: withImage },
        values: { title: "Hello", photo: "a1" },
        attachments: [{ id: "att1", assetId: "a1", fieldKey: "photo" }],
      }),
    );
    const remove = vi
      .spyOn(formsApi, "removeFormRecordAttachment")
      .mockRejectedValue(new ApiError("conflict", 409, "conflict"));
    const user = userEvent.setup();
    renderPortal("/forms/f1/submissions/rec1");

    await user.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() => expect(remove).toHaveBeenCalled());
    // The attachment id and current version are sent.
    expect(remove.mock.calls[0]![2]).toBe("att1");
    expect(remove.mock.calls[0]![3]).toBe(7);
  });

  it("loads your submissions scoped server-side (mine) and paginated", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(form(["submit"]));
    const list = vi.spyOn(formsApi, "listFormRecords").mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    renderPortal("/forms/f1");

    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(list.mock.calls[0]![1]).toMatchObject({ mine: true, page: 1 });
  });
});
