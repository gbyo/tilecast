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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formsApi } from "../api";
import type { FormDataSource, FormRecord, FormRecordDetail } from "../types";
import { SubmissionEditor } from "./SubmissionEditor";

let created: string[] = [];
let revoked: string[] = [];

beforeEach(() => {
  created = [];
  revoked = [];
  // jsdom implements neither function.
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:preview-${created.length + 1}`;
    created.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
});

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
    draftSchema: { fields: [] },
    publishedRevision: {
      id: "rev-1",
      dataSourceId: "form-1",
      revisionNumber: 1,
      title: "Signup",
      description: "",
      schema: { fields: [{ key: "photo", label: "Photo", control: "image" }] },
      publishedAt: "2026-01-01T00:00:00Z",
    },
    workflow: { states: [], transitions: [] },
    views: [],
    grantedCapabilities: ["submit"],
  };
}

function record(version: number): FormRecord {
  return {
    id: "rec-1",
    dataSourceId: "form-1",
    revisionId: "rev-1",
    state: "draft",
    values: {},
    submitterName: "Owner",
    displayTitle: "",
    priority: 0,
    eligible: false,
    version,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function detail(version: number, withImage: boolean): FormRecordDetail {
  return {
    ...record(version),
    events: [],
    comments: [],
    attachments: withImage
      ? [{ id: "att-1", assetId: "asset-1", fieldKey: "photo" }]
      : [],
    canEdit: true,
    canComment: false,
    canDelete: false,
    availableTransitions: [],
  };
}

function renderEditor() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: (
          <SubmissionEditor form={form()} csrf="token" onCompleted={() => {}} />
        ),
      },
    ],
    { initialEntries: ["/"] },
  );
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function choose(name: string) {
  const input = document.querySelector<HTMLInputElement>("input[type=file]");
  expect(input).toBeInstanceOf(HTMLInputElement);
  fireEvent.change(input!, {
    target: { files: [new File(["x"], name, { type: "image/png" })] },
  });
}

describe("SubmissionEditor image previews", () => {
  it("revokes the previous preview when an image is replaced", () => {
    renderEditor();
    choose("a.png");
    expect(created).toEqual(["blob:preview-1"]);
    expect(revoked).toEqual([]);
    choose("b.png");
    expect(created).toEqual(["blob:preview-1", "blob:preview-2"]);
    expect(revoked).toEqual(["blob:preview-1"]);
  });

  it("revokes the preview when a pending image is removed", () => {
    renderEditor();
    choose("a.png");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(revoked).toEqual(["blob:preview-1"]);
  });

  it("revokes remaining previews when the editor unmounts", () => {
    const view = renderEditor();
    choose("a.png");
    expect(revoked).toEqual([]);
    view.unmount();
    expect(revoked).toEqual(["blob:preview-1"]);
  });

  it("revokes the preview once the image is committed by a save", async () => {
    vi.spyOn(formsApi, "createFormRecord").mockResolvedValue(record(1));
    vi.spyOn(formsApi, "uploadFormRecordAttachment").mockResolvedValue(
      detail(2, true),
    );
    vi.spyOn(formsApi, "getFormRecord").mockResolvedValue(detail(2, true));
    renderEditor();
    choose("a.png");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(revoked).toEqual(["blob:preview-1"]));
    // Each preview is revoked exactly once, including when the editor later unmounts.
    cleanup();
    expect(revoked).toEqual(["blob:preview-1"]);
  });
});
