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
  useBlocker: () => ({ state: "unblocked" }),
}));

import { useNavigationWarning } from "./useNavigationWarning";

function Harness() {
  useNavigationWarning({
    dirty: true,
    allowPrefix: "/settings",
    title: "Leave with unsaved changes?",
  });
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
      body: undefined,
      action: "Discard changes",
    });
    expect(mocks.navigate).toHaveBeenCalledWith("/outside");
  });

  it("passes the dialog body through to the confirmation", async () => {
    mocks.confirm.mockResolvedValue(false);
    function BodyHarness() {
      useNavigationWarning({
        dirty: true,
        allowPrefix: "/settings",
        title: "Leave with unsaved changes?",
        body: "The workflow has unsaved changes.",
      });
      return <a href="/outside">Same tab</a>;
    }
    const { getByRole } = render(<BodyHarness />);
    getByRole("link", { name: "Same tab" }).dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();

    expect(mocks.confirm).toHaveBeenCalledWith({
      title: "Leave with unsaved changes?",
      body: "The workflow has unsaved changes.",
      action: "Discard changes",
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("lets destinations the predicate allows pass without asking", () => {
    function PredicateHarness() {
      useNavigationWarning({
        dirty: true,
        title: "Leave with unsaved changes?",
        shouldBlock: (_current, next) => next.search !== "?tab=safe",
      });
      return (
        <div>
          <a href="/forms/1?tab=safe">Safe tab</a>
          <a href="/forms/1?tab=other">Other tab</a>
        </div>
      );
    }
    const { getByRole } = render(<PredicateHarness />);

    const safeAllowed = getByRole("link", { name: "Safe tab" }).dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(safeAllowed).toBe(true);
    expect(mocks.confirm).not.toHaveBeenCalled();

    mocks.confirm.mockResolvedValue(false);
    const otherAllowed = getByRole("link", { name: "Other tab" }).dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(otherAllowed).toBe(false);
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
  });
});
