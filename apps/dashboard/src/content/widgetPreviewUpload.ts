import type { QueryClient } from "@tanstack/react-query";
import { api } from "../api/client";

/** Upload a saved Widget's preview without changing the result of its save. */
export function uploadWidgetPreviewInBackground(
  assetId: string,
  image: Blob,
  csrf: string,
  queryClient: QueryClient,
  onFailure: () => void,
) {
  void api.uploadWidgetPreview(assetId, image, csrf).then(() => {
    void queryClient.invalidateQueries({ queryKey: ["assets"] });
  }, onFailure);
}
