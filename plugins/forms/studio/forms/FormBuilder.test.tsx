// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
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
import { FormBuilder } from "./FormBuilder";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const defaultMatchMedia = window.matchMedia.bind(window);

afterEach(() => {
  window.matchMedia = defaultMatchMedia;
});

function mockDesktop() {
  if (!("ResizeObserver" in window)) {
    (window as unknown as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  window.matchMedia = () => ({
    matches: true,
    media: "(min-width: 1024px)",
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  });
}

function form(): FormDataSource {
  return {
    id: "form-1",
    name: "Signup",
    description: "",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    draftSchema: {
      title: "Signup",
      fields: [
        { key: "a", label: "Alpha", control: "short_text" },
        { key: "b", label: "Beta", control: "short_text" },
        { key: "c", label: "Gamma", control: "short_text" },
      ],
    },
    workflow: { states: [], transitions: [] },
    views: [],
    grantedCapabilities: [],
  };
}

function renderBuilder() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [{ path: "/", element: <FormBuilder form={form()} csrf="token" /> }],
    { initialEntries: ["/"] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function fieldOrder(): string[] {
  return screen
    .getAllByRole("button", { name: /^Edit / })
    .map((button) => button.getAttribute("aria-label") ?? "");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("FormBuilder field list", () => {
  it("renders fields as an item list with an add palette", () => {
    renderBuilder();
    expect(fieldOrder()).toEqual(["Edit Alpha", "Edit Beta", "Edit Gamma"]);
    expect(
      screen.getByRole("heading", { name: "Add a field" }),
    ).toBeInTheDocument();
  });

  it("reorders with Alt+Arrow without leaving the row", () => {
    renderBuilder();
    fireEvent.keyDown(screen.getByRole("button", { name: "Edit Alpha" }), {
      key: "ArrowDown",
      altKey: true,
    });
    expect(fieldOrder()).toEqual(["Edit Beta", "Edit Alpha", "Edit Gamma"]);
  });

  it("keeps focus on a field as it moves", () => {
    renderBuilder();
    const alpha = screen.getByRole("button", { name: "Edit Alpha" });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: "ArrowDown", altKey: true });
    expect(screen.getByRole("button", { name: "Edit Alpha" })).toHaveFocus();
  });

  it("keeps the selected field selected when an earlier field is deleted", async () => {
    mockDesktop();
    renderBuilder();
    fireEvent.click(screen.getByRole("button", { name: "Edit Beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Actions for Alpha" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Delete field/ }),
    );
    expect(fieldOrder()).toEqual(["Edit Beta", "Edit Gamma"]);
    expect(screen.getByRole("button", { name: "Edit Beta" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("moves a field to the top from the row menu", async () => {
    renderBuilder();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Gamma" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Move to top/ }),
    );
    expect(fieldOrder()).toEqual(["Edit Gamma", "Edit Alpha", "Edit Beta"]);
  });

  it("opens the inspector in a Sheet on narrow screens", async () => {
    renderBuilder();
    fireEvent.click(screen.getByRole("button", { name: "Edit Beta" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Beta" })).toBeInTheDocument();
  });

  it("shows fields, preview, and inspector side by side on desktop", async () => {
    mockDesktop();
    renderBuilder();
    expect(
      await screen.findByRole("group", {
        name: "Form fields, preview, and inspector",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Field settings" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps an edit made while a draft save is pending as an unsaved change", async () => {
    const pending = deferred<FormDataSource>();
    const save = vi
      .spyOn(formsApi, "updateFormDraft")
      .mockReturnValue(pending.promise);
    renderBuilder();
    // Move Alpha below Beta, then save the order [Beta, Alpha, Gamma].
    fireEvent.keyDown(screen.getByRole("button", { name: "Edit Alpha" }), {
      key: "ArrowDown",
      altKey: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    // While the save is in flight, move Beta back above Alpha.
    fireEvent.keyDown(screen.getByRole("button", { name: "Edit Beta" }), {
      key: "ArrowDown",
      altKey: true,
    });
    expect(fieldOrder()).toEqual(["Edit Alpha", "Edit Beta", "Edit Gamma"]);
    const [alpha, beta, gamma] = form().draftSchema.fields;
    act(() =>
      pending.resolve({
        ...form(),
        draftSchema: { ...form().draftSchema, fields: [beta!, alpha!, gamma!] },
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save draft" }),
      ).not.toHaveAttribute("aria-busy"),
    );
    // The server copy of the sent order does not replace the newer edit.
    expect(fieldOrder()).toEqual(["Edit Alpha", "Edit Beta", "Edit Gamma"]);
    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
  });
});
