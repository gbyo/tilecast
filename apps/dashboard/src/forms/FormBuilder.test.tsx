// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FormDataSource } from "../api/types";
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
});
