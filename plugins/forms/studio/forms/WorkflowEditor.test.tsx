// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formsApi } from "../api";
import type { FormDataSource } from "../types";
import { WorkflowEditor } from "./WorkflowEditor";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function form(): FormDataSource {
  return {
    id: "form-1",
    name: "Signup",
    description: "",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    draftSchema: { title: "Signup", fields: [] },
    workflow: {
      states: [
        {
          key: "submitted",
          label: "Submitted",
          position: 0,
          eligibleForOutput: false,
          initial: true,
          terminal: false,
          removable: false,
        },
        {
          key: "approved",
          label: "Approved",
          position: 1,
          eligibleForOutput: true,
          initial: false,
          terminal: true,
          removable: false,
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
      ],
    },
    views: [],
    grantedCapabilities: ["manage"],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("WorkflowEditor saving", () => {
  it("disables state editing while a workflow save is in flight", async () => {
    const pending = deferred<FormDataSource>();
    const configure = vi
      .spyOn(formsApi, "configureFormWorkflow")
      .mockReturnValue(pending.promise);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // The editor's navigation guard needs a data router.
    const router = createMemoryRouter(
      [{ path: "/", element: <WorkflowEditor form={form()} csrf="token" /> }],
      { initialEntries: ["/"] },
    );
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    const label = document.getElementById("workflow-state-label-0");
    expect(label).toBeInstanceOf(HTMLInputElement);
    fireEvent.change(label!, { target: { value: "Submitted!" } });
    fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
    const saveAnyway = screen.queryByRole("button", { name: "Save anyway" });
    if (saveAnyway) fireEvent.click(saveAnyway);
    await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
    expect(document.getElementById("workflow-state-label-0")).toBeDisabled();
    pending.resolve({ ...form(), workflow: form().workflow });
    await waitFor(() =>
      expect(document.getElementById("workflow-state-label-0")).toBeEnabled(),
    );
  });
});
