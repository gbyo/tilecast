// @vitest-environment jsdom
// Immersive editors are declared by their routes, not by pathname checks.
import { describe, expect, it } from "vitest";
import { studioRoutes } from "../App";
import { isImmersiveEditorRoute } from "./studioRoutes";

describe("immersive editor routes", () => {
  it.each([
    ["/layouts/layout-1", true],
    ["/widgets/new/countdown", true],
    ["/widgets/widget-1", true],
    ["/widgets/new", false],
    ["/widgets", false],
    ["/layouts", false],
    ["/playlists/playlist-1", false],
  ])("%s → %s", (path, immersive) => {
    expect(isImmersiveEditorRoute(studioRoutes, path)).toBe(immersive);
  });
});
