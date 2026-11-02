import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ContentFolder, MyAccess } from "../api/types";
import { useCapabilities, type Capabilities } from "../auth/capabilities";

export const myAccessQueryKey = ["my-access"] as const;

/**
 * What the signed-in account may do in the Media library. Capabilities say
 * which actions its role allows; content access says where. The library
 * restructuring actions also need the whole library (folders, collections)
 * or every tag (tag management), because they change things other people
 * are scoped to. The server makes each of these decisions again.
 */
export type MediaPermissions = {
  upload: boolean;
  edit: boolean;
  /** Move between folders and in or out of collections. */
  organize: boolean;
  /** Apply and remove tags (only assignable ones). */
  tag: boolean;
  archive: boolean;
  remove: boolean;
  createFolders: boolean;
  createCollections: boolean;
  createTags: boolean;
  /** Collection membership needs the whole library. */
  collect: boolean;
  libraryAll: boolean;
  tagsAll: boolean;
  /** Folders the account may upload into; undefined for the whole library. */
  writableFolderIds?: ReadonlySet<string>;
};

export function mediaPermissionsFrom(
  capabilities: Pick<Capabilities, "can">,
  access?: MyAccess,
): MediaPermissions {
  const { can } = capabilities;
  // Until the access summary loads, assume the narrowest reach so nothing
  // offers a destination or structure change the server would refuse.
  const libraryAll = access?.content.libraryMode === "all";
  const tagsAll = access?.content.tagMode === "all";
  const writable = access?.content.writableFolderIds;
  return {
    upload: can("media.upload"),
    edit: can("media.edit"),
    organize: can("media.organize"),
    tag: can("media.tags.assign"),
    archive: can("media.archive"),
    remove: can("media.delete"),
    createFolders: can("media.folders.manage") && libraryAll,
    createCollections: can("media.collections.manage") && libraryAll,
    createTags: can("media.tags.manage") && tagsAll,
    collect: can("media.organize") && libraryAll,
    libraryAll,
    tagsAll,
    writableFolderIds: libraryAll ? undefined : new Set(writable ?? []),
  };
}

export function useMyAccess() {
  return useQuery({ queryKey: myAccessQueryKey, queryFn: api.myAccess });
}

export function useMediaPermissions(): MediaPermissions {
  const capabilities = useCapabilities();
  const access = useMyAccess();
  return useMemo(
    () => mediaPermissionsFrom(capabilities, access.data),
    [capabilities, access.data],
  );
}

/** Whether content can be placed in folder (undefined is the root). */
export function folderWritable(
  permissions: Pick<MediaPermissions, "libraryAll" | "writableFolderIds">,
  folderId: string | undefined,
): boolean {
  if (permissions.libraryAll) return true;
  return Boolean(folderId && permissions.writableFolderIds?.has(folderId));
}

/** The folders an upload may land in, in the order the list shows them. */
export function uploadFolders(
  permissions: Pick<MediaPermissions, "libraryAll" | "writableFolderIds">,
  folders: readonly ContentFolder[],
): ContentFolder[] {
  return folders.filter((folder) => folderWritable(permissions, folder.id));
}

/**
 * Where an upload lands. The folder being viewed wins when the account may
 * write there, so uploading while looking at a folder puts the file in it.
 * Otherwise an account with the whole library uses the root, and a
 * restricted account uses the folder it chose, or its only folder. Null
 * means a restricted account has no folder to upload into yet.
 */
export function uploadDestination(
  permissions: Pick<MediaPermissions, "libraryAll" | "writableFolderIds">,
  options: {
    viewing?: string;
    chosen?: string;
    folders: readonly ContentFolder[];
  },
): string | undefined | null {
  if (options.viewing && folderWritable(permissions, options.viewing))
    return options.viewing;
  if (permissions.libraryAll) return undefined;
  if (options.chosen && folderWritable(permissions, options.chosen))
    return options.chosen;
  const candidates = uploadFolders(permissions, options.folders);
  return candidates.length === 1 ? (candidates[0]?.id ?? null) : null;
}
