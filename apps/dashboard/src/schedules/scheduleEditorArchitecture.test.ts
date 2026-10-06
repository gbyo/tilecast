import { describe, expect, it } from "vitest";

// The editor is one cumulative rule, composed from the generated components.
// These checks keep it that way as it changes.
const sources = import.meta.glob("./*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

const editorFiles = Object.entries(sources).filter(
  ([path]) =>
    !path.includes(".test.") &&
    !path.includes("TestKit") &&
    !path.endsWith("scheduleBuilderModel.ts"),
);

describe("Schedule editor architecture", () => {
  it("keeps Presentation, Timing, Targets, and priority in one document, not tabs", () => {
    for (const [path, source] of editorFiles)
      expect(source, path).not.toMatch(/components\/ui\/tabs/);
  });

  it("does not stack Cards or bring back the old section chrome", () => {
    for (const [path, source] of editorFiles) {
      expect(source, path).not.toMatch(/components\/ui\/card/);
      expect(source, path).not.toMatch(/schedule-builder/);
      expect(source, path).not.toMatch(/schedule-playlist-card/);
    }
  });

  it("has no sticky action footer; Save lives in the Studio header", () => {
    for (const [path, source] of editorFiles)
      expect(source, path).not.toMatch(/<footer/);
  });

  it("never resolves recurrence or precedence in the browser", () => {
    for (const [path, source] of editorFiles) {
      expect(source, path).not.toMatch(/\bResolve\b|precedes|intervalAt/);
      // The next run is asked of the server, never computed from the clock.
      expect(source, path).not.toMatch(/schedulePreviewTimestamp/);
    }
  });

  it("mounts one outcome component for every layout", () => {
    const users = editorFiles.filter(([, source]) =>
      /<ScheduleOutcomeContent/.test(source),
    );
    expect(users.map(([path]) => path)).toEqual([
      "./ScheduleEditorWorkspace.tsx",
    ]);
  });

  it("does not grow back into one giant file", () => {
    for (const [path, source] of editorFiles)
      expect(source.split("\n").length, path).toBeLessThan(600);
  });
});
