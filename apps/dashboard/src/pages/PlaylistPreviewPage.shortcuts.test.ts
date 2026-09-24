// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { playlistPreviewShortcutTargetIsInteractive } from "./PlaylistPreviewPage";

describe("playlist preview keyboard shortcuts", () => {
  it("defers to native keyboard behavior for interactive controls", () => {
    const button = document.createElement("button");
    const icon = document.createElement("span");
    button.append(icon);

    expect(playlistPreviewShortcutTargetIsInteractive(button)).toBe(true);
    expect(playlistPreviewShortcutTargetIsInteractive(icon)).toBe(true);

    const link = document.createElement("a");
    link.href = "/playlists";
    expect(playlistPreviewShortcutTargetIsInteractive(link)).toBe(true);

    const input = document.createElement("input");
    expect(playlistPreviewShortcutTargetIsInteractive(input)).toBe(true);

    const customControl = document.createElement("div");
    customControl.setAttribute("role", "slider");
    expect(playlistPreviewShortcutTargetIsInteractive(customControl)).toBe(true);
  });

  it("keeps global shortcuts available on non-interactive preview content", () => {
    const stage = document.createElement("section");
    const media = document.createElement("img");
    stage.append(media);

    expect(playlistPreviewShortcutTargetIsInteractive(stage)).toBe(false);
    expect(playlistPreviewShortcutTargetIsInteractive(media)).toBe(false);
    expect(playlistPreviewShortcutTargetIsInteractive(window)).toBe(false);
  });
});
