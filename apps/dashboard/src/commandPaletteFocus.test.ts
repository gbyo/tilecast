// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { installCommandPaletteFocus } from "./commandPaletteFocus";

afterEach(() => {
  document.body.replaceChildren();
});

describe("installCommandPaletteFocus", () => {
  it("focuses the cmdk input when the palette dialog opens", async () => {
    const dialog = document.createElement("dialog");
    dialog.className = "dialog command-palette-dialog";

    const closeButton = document.createElement("button");
    closeButton.textContent = "Close";
    const input = document.createElement("input");
    input.setAttribute("cmdk-input", "");

    dialog.append(closeButton, input);
    document.body.append(dialog);
    closeButton.focus();

    const uninstall = installCommandPaletteFocus();
    dialog.setAttribute("open", "");

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.activeElement).toBe(input);
    uninstall();
  });

  it("focuses a palette that is inserted already open", async () => {
    const outsideButton = document.createElement("button");
    document.body.append(outsideButton);
    outsideButton.focus();

    const uninstall = installCommandPaletteFocus();

    const dialog = document.createElement("dialog");
    dialog.className = "dialog command-palette-dialog";
    dialog.setAttribute("open", "");
    const input = document.createElement("input");
    input.setAttribute("cmdk-input", "");
    dialog.append(input);
    document.body.append(dialog);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.activeElement).toBe(input);
    uninstall();
  });

  it("does not move focus for unrelated dialogs", async () => {
    const dialog = document.createElement("dialog");
    dialog.className = "dialog";
    const input = document.createElement("input");
    input.setAttribute("cmdk-input", "");
    dialog.append(input);
    document.body.append(dialog);

    const outsideButton = document.createElement("button");
    document.body.append(outsideButton);
    outsideButton.focus();

    const uninstall = installCommandPaletteFocus();
    dialog.setAttribute("open", "");

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.activeElement).toBe(outsideButton);
    uninstall();
  });
});
