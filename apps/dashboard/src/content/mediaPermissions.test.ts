import { describe, expect, it } from "vitest";
import type { ContentFolder, MyAccess } from "../api/types";
import { capabilitiesFrom } from "../auth/capabilities";
import { authStatusFor, builtinMyAccess } from "../test/capabilities";
import {
  folderWritable,
  mediaPermissionsFrom,
  uploadDestination,
  uploadFolders,
} from "./mediaPermissions";

const classroomMedia = [
  "media.read",
  "media.upload",
  "media.edit",
  "media.archive",
  "media.delete",
  "media.tags.assign",
];

const folder = (id: string, name: string): ContentFolder => ({
  id,
  name,
  description: "",
  assetCount: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

const room313 = folder("f-313", "Room 313");
const room314 = folder("f-314", "Room 314");
const library = [room313, room314];

function teacherAccess(writable: string[]): MyAccess {
  return {
    role: { key: "classroom_media", name: "Classroom Media", builtin: false },
    capabilities: classroomMedia,
    content: {
      libraryMode: "restricted",
      tagMode: "restricted",
      writableFolderIds: writable,
    },
  };
}

const permissionsFor = (access: MyAccess) =>
  mediaPermissionsFrom(
    capabilitiesFrom(authStatusFor(access.role.key, access.capabilities)),
    access,
  );

describe("media permissions", () => {
  it("lets a whole-library Editor do everything an Editor does", () => {
    const permissions = permissionsFor(builtinMyAccess("editor"));
    expect(permissions).toMatchObject({
      upload: true,
      edit: true,
      organize: true,
      tag: true,
      archive: true,
      remove: true,
      libraryAll: true,
      tagsAll: true,
    });
    expect(permissions.writableFolderIds).toBeUndefined();
  });

  it("offers a restricted teacher only the actions the role allows", () => {
    const permissions = permissionsFor(teacherAccess(["f-313"]));
    expect(permissions).toMatchObject({
      upload: true,
      edit: true,
      tag: true,
      archive: true,
      remove: true,
      // Restructuring the library or the tag catalog is not theirs.
      organize: false,
      createFolders: false,
      createCollections: false,
      createTags: false,
      collect: false,
      libraryAll: false,
      tagsAll: false,
    });
  });

  it("does not offer structure changes to a role without the capability, even for the whole library", () => {
    const viewer = permissionsFor(builtinMyAccess("viewer"));
    expect(viewer.upload).toBe(false);
    expect(viewer.createFolders).toBe(false);
    expect(viewer.createTags).toBe(false);
    expect(viewer.tag).toBe(false);
  });

  it("assumes the narrowest reach until the access summary arrives", () => {
    const loading = mediaPermissionsFrom(
      capabilitiesFrom(authStatusFor("administrator")),
      undefined,
    );
    expect(loading.libraryAll).toBe(false);
    expect(loading.createFolders).toBe(false);
    expect(loading.createTags).toBe(false);
    expect([...(loading.writableFolderIds ?? [])]).toEqual([]);
  });

  it("only offers structure creation with the whole library, even with the capability", () => {
    const restrictedManager = permissionsFor({
      ...teacherAccess(["f-313"]),
      capabilities: [...classroomMedia, "media.folders.manage"],
    });
    expect(restrictedManager.createFolders).toBe(false);
  });
});

describe("upload destination", () => {
  it("writes only to folders the account holds", () => {
    const permissions = permissionsFor(teacherAccess(["f-313"]));
    expect(folderWritable(permissions, "f-313")).toBe(true);
    expect(folderWritable(permissions, "f-314")).toBe(false);
    expect(folderWritable(permissions, undefined)).toBe(false);
    expect(uploadFolders(permissions, library).map((f) => f.name)).toEqual([
      "Room 313",
    ]);
  });

  it("lets a whole-library account upload to the root or any folder", () => {
    const permissions = permissionsFor(builtinMyAccess("editor"));
    expect(folderWritable(permissions, undefined)).toBe(true);
    expect(
      uploadDestination(permissions, { folders: library }),
    ).toBeUndefined();
    expect(
      uploadDestination(permissions, { viewing: "f-314", folders: library }),
    ).toBe("f-314");
  });

  it("selects a restricted account's only folder automatically", () => {
    const permissions = permissionsFor(teacherAccess(["f-313"]));
    expect(uploadDestination(permissions, { folders: library })).toBe("f-313");
  });

  it("makes a restricted account with several folders choose", () => {
    const permissions = permissionsFor(teacherAccess(["f-313", "f-314"]));
    expect(uploadDestination(permissions, { folders: library })).toBeNull();
    expect(
      uploadDestination(permissions, { chosen: "f-314", folders: library }),
    ).toBe("f-314");
    // A choice outside the grants is ignored rather than trusted.
    expect(
      uploadDestination(permissions, { chosen: "f-999", folders: library }),
    ).toBeNull();
  });

  it("prefers the folder being viewed only when it is writable", () => {
    const permissions = permissionsFor(teacherAccess(["f-313", "f-314"]));
    expect(
      uploadDestination(permissions, { viewing: "f-313", folders: library }),
    ).toBe("f-313");
    const single = permissionsFor(teacherAccess(["f-313"]));
    expect(
      uploadDestination(single, { viewing: "f-314", folders: library }),
    ).toBe("f-313");
  });

  it("has no destination for a restricted account without a folder", () => {
    const permissions = permissionsFor(teacherAccess([]));
    expect(uploadDestination(permissions, { folders: library })).toBeNull();
    expect(uploadFolders(permissions, library)).toEqual([]);
  });
});
