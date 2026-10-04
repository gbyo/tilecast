// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { YouTubeSourceEditor } from "./SourceEditors";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderEditor(editor: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter([{ path: "*", element: editor }]);
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("YouTube editor modal shell", () => {
  it("renders in the shared dialog and closes on Escape when clean", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderEditor(
      <YouTubeSourceEditor csrf="csrf" onClose={onClose} onSaved={vi.fn()} />,
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Create YouTube Widget",
    });
    expect(dialog).toBeInTheDocument();
    await user.click(within(dialog).getByLabelText("Name"));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("confirms before discarding dirty edits on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderEditor(
      <YouTubeSourceEditor csrf="csrf" onClose={onClose} onSaved={vi.fn()} />,
    );

    await user.type(await screen.findByLabelText("Name"), "X");
    await user.keyboard("{Escape}");
    const confirm = await screen.findByRole("alertdialog", {
      name: "Discard unsaved YouTube changes?",
    });
    await user.click(
      within(confirm).getByRole("button", { name: "Discard changes" }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps editing when the discard confirm is cancelled", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderEditor(
      <YouTubeSourceEditor csrf="csrf" onClose={onClose} onSaved={vi.fn()} />,
    );

    await user.type(await screen.findByLabelText("Name"), "X");
    await user.keyboard("{Escape}");
    const confirm = await screen.findByRole("alertdialog", {
      name: "Discard unsaved YouTube changes?",
    });
    await user.click(
      within(confirm).getByRole("button", { name: "Keep editing" }),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "Create YouTube Widget" }),
    ).toBeInTheDocument();
  });
});
