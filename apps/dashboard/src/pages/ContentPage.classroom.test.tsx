// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { Asset, ContentTag, MyAccess } from "../api/types";
import { capabilitiesFrom } from "../auth/capabilities";
import { mediaPermissionsFrom } from "../content/mediaPermissions";
import { authStatusFor, mockAuthAs } from "../test/capabilities";
import { ContentOrganizer, ContentPage } from "./ContentPage";

// The school scenario: a teacher holds a custom "Classroom Media" role, the
// Room 313 folder, and the Room 313 Signage tag. Studio shows the library
// the server scoped for them and only the actions the role allows. The
// server decides every request again, so none of this is a security
// boundary; these tests pin the experience.
const classroomMedia = [
  "media.read",
  "media.upload",
  "media.edit",
  "media.archive",
  "media.delete",
  "media.tags.assign",
];

const teacherAccess = (writableFolderIds: string[]): MyAccess => ({
  role: { key: "classroom_media", name: "Classroom Media", builtin: false },
  capabilities: classroomMedia,
  content: {
    libraryMode: "restricted",
    tagMode: "restricted",
    writableFolderIds,
  },
});

const room313 = {
  id: "folder-313",
  name: "Room 313",
  description: "",
  assetCount: 2,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
const room314 = { ...room313, id: "folder-314", name: "Room 314" };

const signage: ContentTag = {
  id: "tag-signage",
  name: "Room 313 Signage",
  color: "#3b82f6",
  assetCount: 2,
  assignable: true,
};
const staffNotices: ContentTag = {
  id: "tag-staff",
  name: "Staff Notices",
  color: "#dc2626",
  assetCount: 4,
  assignable: false,
};

function asset(id: string, folderId = "folder-313"): Asset {
  return {
    id,
    name: id,
    description: "",
    type: "image",
    originalFilename: `${id}.png`,
    declaredMimeType: "image/png",
    detectedMimeType: "image/png",
    sha256: "aabbcc",
    originalSize: 2048,
    width: 1920,
    height: 1080,
    metadata: {},
    processingStatus: "ready",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    variants: [],
    playlistUsage: 0,
    layoutUsage: [],
    tags: [],
    collectionIds: [],
    folderId,
  };
}

const withQueryClient = (children: React.ReactNode) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    <MemoryRouter>{children}</MemoryRouter>
  </QueryClientProvider>
);

beforeEach(() => {
  mockAuthAs("classroom_media", classroomMedia);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockServer(access: MyAccess, folders = [room313]) {
  mockAuthAs(access.role.key, access.capabilities);
  vi.spyOn(api, "myAccess").mockResolvedValue(access);
  vi.spyOn(api, "contentFolders").mockResolvedValue(folders);
  vi.spyOn(api, "contentCollections").mockResolvedValue([]);
  vi.spyOn(api, "contentTags").mockResolvedValue([signage]);
  vi.spyOn(api, "assets").mockResolvedValue({
    items: [asset("Poster-1"), asset("Poster-2")],
    total: 2,
    page: 1,
    pageSize: 48,
  });
}

describe("Classroom Media in the library", () => {
  it("shows the teacher the library the server scoped, with upload and no structure controls", async () => {
    mockServer(teacherAccess(["folder-313"]));
    render(withQueryClient(<ContentPage />));

    expect(await screen.findByText("Poster-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Upload/ })).toBeEnabled();
    // Creating folders, collections, and tags is a library-structure change
    // that this role neither has nor could reach.
    expect(screen.queryByRole("button", { name: "Organize" })).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: "Create folder" }),
    ).toBeNull();
  });

  it("uploads straight into the teacher's only folder, never unfiled", async () => {
    mockServer(teacherAccess(["folder-313"]));
    const create = vi.spyOn(api, "createUpload").mockResolvedValue({
      id: "upload-1",
      offset: 0,
    } as never);
    vi.spyOn(api, "uploadChunk").mockResolvedValue(4);
    vi.spyOn(api, "completeUpload").mockResolvedValue(asset("New-1"));
    const { container } = render(withQueryClient(<ContentPage />));
    await screen.findByText("Poster-1");
    // The upload button is enabled only once the destination is known.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Upload/ })).toBeEnabled(),
    );

    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    const file = new File(["data"], "poster.png", { type: "image/png" });
    fireEvent.change(input!, { target: { files: [file] } });

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![0]).toMatchObject({
      filename: "poster.png",
      folderId: "folder-313",
    });
  });

  it("makes a teacher with two folders choose before uploading", async () => {
    mockServer(teacherAccess(["folder-313", "folder-314"]), [room313, room314]);
    render(withQueryClient(<ContentPage />));
    await screen.findByText("Poster-1");

    // Only the folders the teacher may write to are offered.
    const chooser = await screen.findByRole("combobox", { name: "Upload to" });
    expect(screen.getByRole("button", { name: /Upload/ })).toBeDisabled();
    await userEvent.click(chooser);
    expect(
      await screen.findByRole("option", { name: "Upload to Room 313" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Upload to Room 314" }),
    ).toBeInTheDocument();
  });

  it("lets a whole-library account keep the root upload", async () => {
    mockServer({
      role: { key: "editor", name: "Editor", builtin: true },
      capabilities: classroomMedia,
      content: { libraryMode: "all", tagMode: "all" },
    });
    render(withQueryClient(<ContentPage />));
    await screen.findByText("Poster-1");
    expect(screen.getByRole("button", { name: /Upload/ })).toBeEnabled();
    expect(screen.queryByRole("combobox", { name: "Upload to" })).toBeNull();
  });
});

describe("Classroom Media tagging", () => {
  const teacher = mediaPermissionsFrom(
    capabilitiesFrom(authStatusFor("classroom_media", classroomMedia)),
    teacherAccess(["folder-313"]),
  );

  function renderOrganizer(assetIds: string[]) {
    return render(
      withQueryClient(
        <ContentOrganizer
          permissions={teacher}
          csrf="csrf-token"
          folders={[room313]}
          collections={[]}
          tags={[signage, staffNotices]}
          assetIds={assetIds}
          onApplied={vi.fn()}
          onCatalogChanged={vi.fn()}
          onSelectAll={vi.fn()}
          onClear={vi.fn()}
          archiveMode={false}
          onArchive={vi.fn()}
          onRestore={vi.fn()}
          onDelete={vi.fn()}
        />,
      ),
    );
  }

  it("offers no Organize menu when nothing is selected", () => {
    renderOrganizer([]);
    expect(screen.queryByRole("button", { name: "Organize" })).toBeNull();
  });

  it("offers only the granted tag, and no folder move or collections", async () => {
    const user = userEvent.setup();
    renderOrganizer(["Poster-1"]);

    const bar = screen.getByRole("toolbar", { name: "1 selected" });
    await user.click(within(bar).getByRole("button", { name: "Organize" }));
    const dialog = await screen.findByRole("dialog");

    // Tags are metadata the role may apply; folders and collections are
    // structure it may not touch.
    expect(within(dialog).queryByLabelText("Move to folder")).toBeNull();
    expect(within(dialog).queryByLabelText("Collections")).toBeNull();
    await user.click(
      within(dialog).getByRole("combobox", { name: "Tag change" }),
    );
    expect(
      await screen.findByRole("option", { name: "Add Room 313 Signage" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Remove Room 313 Signage" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Staff Notices/ })).toBeNull();
  });

  it("applies the granted tag to the selection in one request", async () => {
    const user = userEvent.setup();
    const bulk = vi
      .spyOn(api, "bulkOrganize")
      .mockResolvedValue(undefined as never);
    renderOrganizer(["Poster-1", "Poster-2"]);

    const bar = screen.getByRole("toolbar", { name: "2 selected" });
    await user.click(within(bar).getByRole("button", { name: "Organize" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("combobox", { name: "Tag change" }),
    );
    await user.click(
      await screen.findByRole("option", { name: "Add Room 313 Signage" }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Apply changes" }),
    );

    await waitFor(() => expect(bulk).toHaveBeenCalledTimes(1));
    expect(bulk.mock.calls[0]![0]).toEqual({
      assetIds: ["Poster-1", "Poster-2"],
      addTagIds: ["tag-signage"],
    });
  });

  it("still offers archive from the selection bar, as the role allows", () => {
    renderOrganizer(["Poster-1"]);
    const bar = screen.getByRole("toolbar", { name: "1 selected" });
    expect(
      within(bar).getByRole("button", { name: "Archive" }),
    ).toBeInTheDocument();
  });
});
