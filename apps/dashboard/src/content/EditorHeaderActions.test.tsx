// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { WebsiteEditor } from "../pages/ContentPage";
import { YouTubeSourceEditor } from "./SourceEditors";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderEditor(editor: ReactNode) {
  vi.spyOn(api, "assets").mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 100,
  });
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {editor}
    </QueryClientProvider>,
  );
}

const noop = () => {};

describe("page-mode editor header actions", () => {
  it("keeps the website save action in the header", () => {
    renderEditor(
      <WebsiteEditor csrf="csrf" page onClose={noop} onSaved={noop} />,
    );
    const saves = screen.getAllByRole("button", { name: "Save website" });
    expect(saves).toHaveLength(1);
    const nameField = document.getElementById("website-name");
    expect(nameField).not.toBeNull();
    // Header placement: save precedes the form fields in DOM order.
    expect(
      saves[0]!.compareDocumentPosition(nameField!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    fireEvent.change(nameField!, { target: { value: "Status page" } });
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(saves[0]!.parentElement).toHaveTextContent("Unsaved changes");
  });

  it("keeps the YouTube save action in the header", () => {
    renderEditor(
      <YouTubeSourceEditor csrf="csrf" page onClose={noop} onSaved={noop} />,
    );
    const saves = screen.getAllByRole("button", { name: "Save Widget" });
    expect(saves).toHaveLength(1);
    const nameField = document.getElementById("name");
    expect(nameField).not.toBeNull();
    expect(
      saves[0]!.compareDocumentPosition(nameField!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    fireEvent.change(nameField!, { target: { value: "Lobby reel" } });
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(saves[0]!.parentElement).toHaveTextContent("Unsaved changes");
  });

  it("keeps the YouTube dialog save action in its footer", () => {
    renderEditor(
      <YouTubeSourceEditor csrf="csrf" onClose={noop} onSaved={noop} />,
    );
    const saves = screen.getAllByRole("button", { name: "Save Widget" });
    expect(saves).toHaveLength(1);
    const nameField = document.getElementById("name");
    expect(nameField).not.toBeNull();
    // Dialog mode is unchanged: save still follows the form fields.
    expect(
      saves[0]!.compareDocumentPosition(nameField!) &
        Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
  });
});
