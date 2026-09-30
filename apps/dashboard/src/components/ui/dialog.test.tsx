// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./dialog";

afterEach(cleanup);

function renderDialog(className?: string) {
  render(
    <Dialog open>
      <DialogContent className={className}>
        <DialogHeader>
          <DialogTitle>Dialog title</DialogTitle>
          <DialogDescription>Dialog description</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>,
  );
  return document.body.querySelector<HTMLElement>(
    '[data-slot="dialog-content"]',
  )!;
}

describe("DialogContent sizing", () => {
  it("keeps a compact default width with viewport margins", () => {
    const dialog = renderDialog();

    expect(dialog).toHaveClass("w-[calc(100%-2rem)]", "max-w-md");
    expect(dialog).not.toHaveClass("sm:max-w-md");
  });

  it("lets callers replace the default maximum width", () => {
    const dialog = renderDialog("max-w-2xl");

    expect(dialog).toHaveClass("max-w-2xl", "w-[calc(100%-2rem)]");
    expect(dialog).not.toHaveClass("max-w-md", "sm:max-w-md");
  });
});
