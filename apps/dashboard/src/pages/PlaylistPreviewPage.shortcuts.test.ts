// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isInteractiveShortcutTarget } from "../lib/keyboard";

describe("global keyboard shortcut target detection", () => {
  it("defers to interactive controls and editable content", () => {
    const button = document.createElement("button");
    const icon = document.createElement("span");
    button.append(icon);

    expect(isInteractiveShortcutTarget(button)).toBe(true);
    expect(isInteractiveShortcutTarget(icon)).toBe(true);

    const link = document.createElement("a");
    link.href = "/playlists";
    expect(isInteractiveShortcutTarget(link)).toBe(true);

    const input = document.createElement("input");
    expect(isInteractiveShortcutTarget(input)).toBe(true);
    expect(
      isInteractiveShortcutTarget(document.createElement("textarea")),
    ).toBe(true);

    const customControl = document.createElement("div");
    customControl.setAttribute("role", "slider");
    expect(isInteractiveShortcutTarget(customControl)).toBe(true);

    const checkbox = document.createElement("div");
    checkbox.setAttribute("role", "checkbox");
    expect(isInteractiveShortcutTarget(checkbox)).toBe(true);

    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "");
    expect(isInteractiveShortcutTarget(editable)).toBe(true);
    const editableText = document.createElement("span");
    editable.append(editableText);
    expect(isInteractiveShortcutTarget(editableText)).toBe(true);
    editable.setAttribute("contenteditable", "plaintext-only");
    expect(isInteractiveShortcutTarget(editable)).toBe(true);
    editable.setAttribute("contenteditable", "false");
    expect(isInteractiveShortcutTarget(editable)).toBe(false);
  });

  it("keeps global shortcuts available on non-interactive preview content", () => {
    const stage = document.createElement("section");
    const media = document.createElement("img");
    stage.append(media);

    expect(isInteractiveShortcutTarget(stage)).toBe(false);
    expect(isInteractiveShortcutTarget(media)).toBe(false);
    expect(isInteractiveShortcutTarget(window)).toBe(false);
  });
});
