// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("../components/ConfirmDialog", () => ({
  useConfirm: () => ({ confirm: mocks.confirm, dialog: null }),
}));

vi.mock("react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

import { useNavigationWarning } from "./useNavigationWarning";

function Harness() {
  useNavigationWarning(true, "/settings", "Leave with unsaved changes?");
  return (
    <div>
      <a href="/outside">Same tab</a>
      <a href="/outside" target="_blank">
        New tab
      </a>
      <a href="/download" download>
        Download
      </a>
    </div>
  );
}

afterEach(() => {
  cleanup();
  mocks.confirm.mockReset();
  mocks.navigate.mockReset();
});

describe("useNavigationWarning", () => {
  it("does not warn when the current page will remain open", () => {
    const { getByRole } = render(<Harness />);

    getByRole("link", { name: "New tab" }).dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    getByRole("link", { name: "Download" }).dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    getByRole("link", { name: "Same tab" }).dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
      }),
    );

    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("still guards same-tab navigation and preserves the destination", async () => {
    mocks.confirm.mockResolvedValue(true);
    const { getByRole } = render(<Harness />);
    const link = getByRole("link", { name: "Same tab" });

    const allowed = link.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();

    expect(allowed).toBe(false);
    expect(mocks.confirm).toHaveBeenCalledWith({
      title: "Leave with unsaved changes?",
      action: "Discard changes",
    });
    expect(mocks.navigate).toHaveBeenCalledWith("/outside");
  });
});
