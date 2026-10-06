import type { Asset } from "@/api/types";

/** How many playlists and Layouts a save would change. */
export function widgetUsageCount(asset: Asset | undefined) {
  if (!asset) return 0;
  return (
    (asset.playlistsUsing?.length ?? asset.playlistUsage ?? 0) +
    (asset.layoutUsage?.length ?? 0)
  );
}
