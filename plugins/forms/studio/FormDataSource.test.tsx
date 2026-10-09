// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryRouter,
  type RouteObject,
} from "react-router";
import { ApiError } from "@tilecast/studio";
import { i18n, StudioSessionProvider } from "@tilecast/studio/testing";
import { formsApi } from "./api";

import type { FormCapability, FormDataSource } from "./types";
import { CreateFormDataSourcePage } from "./CreateFormDataSourcePage";
import { FormDataSourcePage } from "./FormDataSourcePage";

// The page renders a card list for narrow screens and a table for wide ones,
// and hides one with CSS. jsdom applies no CSS, so tests read the table.
const desktop = async () => within(await screen.findByRole("table"));

// The React Router data router creates a Request with an AbortSignal on navigation. Under jsdom the
// global AbortSignal is jsdom's, which Node's undici Request rejects. Since these tests never issue
// real network requests (the api client is spied), drop the signal so in-memory navigation works.
class RequestWithoutSignal extends globalThis.Request {
  constructor(input: RequestInfo | URL, init: RequestInit = {}) {
    const rest = { ...init };
    delete (rest as { signal?: unknown }).signal;
    super(input, rest);
  }
}
globalThis.Request = RequestWithoutSignal;

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

function renderAt(
  path: string,
  role: "owner" | "administrator" | "editor" | "viewer" = "owner",
  extraRoutes: RouteObject[] = [],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // A data router is required so FormBuilder's useBlocker (unsaved-change navigation guard) works.
  const router = createMemoryRouter(
    [
      { path: "/plugins/forms/new", element: <CreateFormDataSourcePage /> },
      { path: "/plugins/forms/:id", element: <FormDataSourcePage /> },
      ...extraRoutes,
    ],
    { initialEntries: [path] },
  );
  const view = render(
    <QueryClientProvider client={client}>
      <StudioSessionProvider session={testSession(role)}>
        <RouterProvider router={router} />
      </StudioSessionProvider>
    </QueryClientProvider>,
  );
  return { ...view, router };
}

const formDetail = (capabilities: FormCapability[]): FormDataSource => ({
  id: "f1",
  name: "Staff Announcements",
  description: "By staff.",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  draftSchema: {
    title: "Announcement",
    description: "",
    fields: [
      { key: "title", label: "Title", control: "short_text", required: true },
    ],
  },
  publishedRevision: {
    id: "r1",
    dataSourceId: "f1",
    revisionNumber: 1,
    title: "Announcement",
    description: "",
    schema: {
      fields: [
        { key: "title", label: "Title", control: "short_text", required: true },
      ],
    },
    publishedAt: "2026-01-01T00:00:00Z",
  },
  workflow: { states: [], transitions: [] },
  views: [],
  grantedCapabilities: capabilities,
});

describe("Form Data Source Studio", () => {
  it("creates a Form with the seeded Title field and navigates to the builder", async () => {
    const createForm = vi
      .spyOn(formsApi, "createForm")
      .mockResolvedValue(formDetail(["manage"]));
    vi.spyOn(formsApi, "getForm").mockResolvedValue(formDetail(["manage"]));
    const user = userEvent.setup();
    renderAt("/plugins/forms/new", "owner");

    // Guided creation: purpose first, then display, then review and create.
    await user.type(
      await screen.findByLabelText(/Form name/),
      "Staff Announcements",
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(
      await screen.findByText("What do submitters see first?"),
    ).toBeInTheDocument();
    // Optional questions are skipped; skipping the last one submits.
    await user.click(await screen.findByRole("button", { name: "Skip" }));
    await user.click(await screen.findByRole("button", { name: "Skip" }));
    await user.click(await screen.findByRole("button", { name: "Skip" }));
    expect(
      await screen.findByRole("heading", { name: "Review and create" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create form" }));

    await waitFor(() => expect(createForm).toHaveBeenCalled());
    const [input] = createForm.mock.calls[0]!;
    expect(input.name).toBe("Staff Announcements");
    expect(input.draftSchema.fields[0]).toMatchObject({
      key: "title",
      control: "short_text",
      required: true,
    });
  });

  it("blocks guided creation until the form has a name", async () => {
    const createForm = vi
      .spyOn(formsApi, "createForm")
      .mockResolvedValue(formDetail(["manage"]));
    const user = userEvent.setup();
    renderAt("/plugins/forms/new", "owner");

    await screen.findByLabelText(/Form name/);
    await user.click(screen.getByRole("button", { name: "Next" }));
    // The required purpose question blocks progress until it is answered.
    expect(await screen.findByText("Question 1 of 4")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Review and create" }),
    ).not.toBeInTheDocument();
    expect(createForm).not.toHaveBeenCalled();
  });

  it("lets a global Viewer with a manage grant edit the form", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(formDetail(["manage"]));
    renderAt("/plugins/forms/f1?tab=form", "viewer");

    expect(
      await screen.findByRole("button", { name: "Save draft" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument();
  });

  it("shows a read-only view to a user without manage", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(formDetail(["submit"]));
    renderAt("/plugins/forms/f1?tab=form", "viewer");

    expect(await screen.findByText("Read-only")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save draft" }),
    ).not.toBeInTheDocument();
  });

  it("blocks internal navigation with unsaved changes; cancel stays and confirm leaves", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(formDetail(["manage"]));
    const user = userEvent.setup();
    const { router } = renderAt("/plugins/forms/f1?tab=form", "owner", [
      { path: "/screens", element: <div>Screens page</div> },
    ]);

    // Make an unsaved schema change.
    await user.type(await screen.findByLabelText("Form title"), "X");

    // Attempt to navigate away -> blocked with a confirmation prompt.
    await act(async () => {
      await router.navigate("/screens");
    });
    expect(
      await screen.findByText("Leave without saving?"),
    ).toBeInTheDocument();

    // Cancel keeps us on the builder.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Screens page")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save draft" }),
    ).toBeInTheDocument();

    // Retry and confirm -> navigation proceeds.
    await act(async () => {
      await router.navigate("/screens");
    });
    await user.click(
      await screen.findByRole("button", { name: "Discard changes" }),
    );
    expect(await screen.findByText("Screens page")).toBeInTheDocument();
  });

  it("disables Publish when the draft matches the published revision", async () => {
    const identicalSchema = {
      title: "Announcement",
      description: "",
      fields: [
        { key: "title", label: "Title", control: "short_text", required: true },
      ],
    };
    const detail = formDetail(["manage"]);
    detail.draftSchema = identicalSchema as never;
    detail.publishedRevision = {
      ...detail.publishedRevision!,
      schema: identicalSchema as never,
    };
    vi.spyOn(formsApi, "getForm").mockResolvedValue(detail);
    const user = userEvent.setup();
    renderAt("/plugins/forms/f1?tab=form", "owner");

    expect(
      await screen.findByRole("button", { name: "Publish" }),
    ).toBeDisabled();

    // Editing the schema makes it publishable again.
    await user.type(screen.getByLabelText("Form title"), "!");
    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();
  });

  it("disables Publish when a differing draft is edited back to match published", async () => {
    const published = {
      title: "Announcement",
      description: "",
      fields: [
        { key: "title", label: "Title", control: "short_text", required: true },
      ],
    };
    const detail = formDetail(["manage"]);
    detail.publishedRevision = {
      ...detail.publishedRevision!,
      schema: published as never,
    };
    // The saved draft differs from published only by its title.
    detail.draftSchema = {
      ...published,
      title: "Announcement CHANGED",
    } as never;
    vi.spyOn(formsApi, "getForm").mockResolvedValue(detail);
    const user = userEvent.setup();
    renderAt("/plugins/forms/f1?tab=form", "owner");

    const title = await screen.findByLabelText("Form title");
    // A differing draft is publishable even before any local edit (not gated on dirty).
    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();

    // Editing the draft back to exactly match the published schema disables Publish.
    await user.clear(title);
    await user.type(title, "Announcement");
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
  });

  it("blocks navigation when only the query string changes with unsaved edits", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(formDetail(["manage"]));
    const user = userEvent.setup();
    const { router } = renderAt("/plugins/forms/f1?tab=form", "owner");

    await user.type(await screen.findByLabelText("Form title"), "X");

    // Same pathname, different query string -> still blocked.
    await act(async () => {
      await router.navigate("/plugins/forms/f1?tab=preview");
    });
    expect(
      await screen.findByText("Leave without saving?"),
    ).toBeInTheDocument();
  });

  it("blocks switching Form tabs while the builder is dirty", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(formDetail(["manage"]));
    const user = userEvent.setup();
    renderAt("/plugins/forms/f1?tab=form", "owner");

    await user.type(await screen.findByLabelText("Form title"), "X");
    await user.click(screen.getByRole("tab", { name: "Workflow" }));

    expect(
      await screen.findByText("Leave without saving?"),
    ).toBeInTheDocument();

    // Cancel keeps us on the builder tab.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("button", { name: "Save draft" }),
    ).toBeInTheDocument();
  });

  it("names a global role in the access table by its label, not its identifier", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(formDetail(["manage"]));
    vi.spyOn(formsApi, "listFormAccess").mockResolvedValue([
      {
        userId: "u2",
        name: "Zoe",
        username: "zoe",
        role: "editor",
        capabilities: ["submit"],
        isCreator: false,
        isGlobalOwner: false,
      },
    ]);
    renderAt("/plugins/forms/f1?tab=access", "owner");

    const table = await screen.findByRole("table");
    expect(within(table).getByText("Editor")).toBeInTheDocument();
    expect(within(table).queryByText("editor")).toBeNull();
  });

  it("shows a search error instead of no-match when the directory fails", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(formDetail(["manage"]));
    vi.spyOn(formsApi, "listFormAccess").mockResolvedValue([]);
    vi.spyOn(formsApi, "searchFormUsers").mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    renderAt("/plugins/forms/f1?tab=access", "owner");

    await user.type(await screen.findByLabelText("Find a user"), "zoe");
    expect(await screen.findByText("User search failed")).toBeInTheDocument();
    expect(screen.queryByText("No matching users")).not.toBeInTheDocument();
  });

  it("confirms before Cancel discards metadata edits", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(formDetail(["manage"]));
    const user = userEvent.setup();
    renderAt("/plugins/forms/f1?tab=form", "owner");

    await user.click(
      await screen.findByRole("button", { name: "Edit details" }),
    );
    await user.type(await screen.findByLabelText("Form name"), "!");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Leave without saving?",
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Discard changes" }),
    );
    expect(
      await screen.findByRole("button", { name: "Edit details" }),
    ).toBeInTheDocument();
  });
});

describe("Form responses table", () => {
  it("opens a response through its title link instead of a clickable row", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(formDetail(["manage"]));
    vi.spyOn(formsApi, "listFormRecords").mockResolvedValue({
      items: [
        {
          id: "r1",
          dataSourceId: "f1",
          revisionId: "r1",
          state: "submitted",
          values: { title: "Field trip" },
          submitterName: "Sam",
          displayTitle: "Field trip",
          priority: 0,
          eligible: true,
          version: 1,
          createdAt: "2026-01-02T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
        },
      ],
      total: 1,
      page: 1,
      pageSize: 25,
    });
    const user = userEvent.setup();
    const { router } = renderAt("/plugins/forms/f1?tab=responses", "owner");

    // The title is a real link; the row itself carries no button role.
    const title = await (
      await desktop()
    ).findByRole("link", { name: "Field trip" });
    expect(title.closest("tr")?.getAttribute("role")).toBeNull();
    await user.click(title);
    expect(router.state.location.search).toContain("record=r1");
  });

  it("shows the newly routed Form's draft, not the previous Form's", async () => {
    const formWith = (id: string, label: string): FormDataSource => ({
      ...formDetail(["manage"]),
      id,
      name: label,
      draftSchema: {
        title: label,
        fields: [{ key: "q", label, control: "short_text" }],
      },
    });
    vi.spyOn(formsApi, "getForm").mockImplementation((id: string) =>
      Promise.resolve(
        formWith(id, id === "f1" ? "Alpha question" : "Beta question"),
      ),
    );
    const { router } = renderAt("/plugins/forms/f1?tab=form", "owner");
    expect(
      await screen.findByRole("button", { name: "Edit Alpha question" }),
    ).toBeInTheDocument();
    // Both Forms are now cached. Moving to Form B and back, without a full
    // load in between, must show Form A's own fields.
    await act(async () => {
      await router.navigate("/plugins/forms/f2?tab=form");
    });
    expect(
      await screen.findByRole("button", { name: "Edit Beta question" }),
    ).toBeInTheDocument();
    await act(async () => {
      await router.navigate("/plugins/forms/f1?tab=form");
    });
    expect(
      await screen.findByRole("button", { name: "Edit Alpha question" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit Beta question" }),
    ).toBeNull();
  });

  it("renders only the error when the records query fails", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(formDetail(["manage"]));
    vi.spyOn(formsApi, "listFormRecords").mockRejectedValue(
      new Error("offline"),
    );
    renderAt("/plugins/forms/f1?tab=responses", "owner");

    expect(
      await screen.findByText("Could not load responses"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("No responses")).not.toBeInTheDocument();
  });
});

describe("Form outputs errors", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("presents output load failures through the localized API error path", async () => {
    await i18n.changeLanguage("ru");
    vi.spyOn(formsApi, "getForm").mockResolvedValue(formDetail(["manage"]));
    vi.spyOn(formsApi, "getFormOutputs").mockRejectedValue(
      new ApiError("Server-provided outputs failure.", 429, "rate_limited"),
    );
    renderAt("/plugins/forms/f1?tab=outputs", "owner");

    expect(
      await screen.findByText(
        "Слишком много попыток. Подождите немного и повторите попытку.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Server-provided outputs failure.")).toBe(null);
  });

  it("presents output rebuild failures through the localized API error path", async () => {
    await i18n.changeLanguage("ru");
    vi.spyOn(formsApi, "getForm").mockResolvedValue(formDetail(["manage"]));
    vi.spyOn(formsApi, "getFormOutputs").mockResolvedValue({
      views: [],
      lastSuccessAt: null,
      nextRefreshAt: null,
      usingCachedData: false,
      errorCode: null,
      stale: false,
    });
    vi.spyOn(formsApi, "rebuildFormOutputs").mockRejectedValue(
      new ApiError("Server-provided rebuild failure.", 429, "rate_limited"),
    );
    const user = userEvent.setup();
    renderAt("/plugins/forms/f1?tab=outputs", "owner");

    await user.click(
      await screen.findByRole("button", {
        name: "Перестроить выходные данные",
      }),
    );

    expect(
      await screen.findByText(
        "Слишком много попыток. Подождите немного и повторите попытку.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Server-provided rebuild failure.")).toBe(null);
  });
});
