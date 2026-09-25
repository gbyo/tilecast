import { describe, expect, it } from "vitest";
import type { Playlist } from "../../api/types";
import { playlistPublicationState } from "./PlaylistEditorHeader";

function playlist(overrides: Partial<Playlist> = {}): Playlist {
  return {
    id: "playlist-1",
    name: "Main playlist",
    description: "",
    revision: 4,
    draftRevision: 7,
    publishedRevision: 4,
    hasUnpublishedChanges: false,
    createdAt: "2026-09-25T12:00:00Z",
    updatedAt: "2026-09-25T12:00:00Z",
    items: [],
    itemCount: 0,
    warnings: [],
    layoutUsage: [],
    ...overrides,
  };
}

describe("playlistPublicationState", () => {
  it("treats a playlist with no published revision as a draft", () => {
    expect(
      playlistPublicationState(
        playlist({
          publishedRevision: undefined,
          hasUnpublishedChanges: false,
        }),
      ),
    ).toBe("draft");
  });

  it("shows unpublished changes when the server reports them", () => {
    expect(
      playlistPublicationState(
        playlist({
          hasUnpublishedChanges: true,
        }),
      ),
    ).toBe("unpublished-changes");
  });

  it("stays published when independent draft and published revisions differ", () => {
    expect(
      playlistPublicationState(
        playlist({
          draftRevision: 7,
          publishedRevision: 4,
          hasUnpublishedChanges: false,
        }),
      ),
    ).toBe("published");
  });
});
