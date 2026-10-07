import type { GitHubInstallReview } from "../api/types";
import { ReviewBody } from "./detail/ReviewBody";

/**
 * The install review body, for the add-from-GitHub dialog. The store detail
 * page hosts the same body in its review dialog; see
 * `detail/PackageReviewDialog`.
 */
export function InstallReview({
  review,
  updatePlane = "repository",
}: {
  review: GitHubInstallReview;
  updatePlane?: "repository" | "catalog";
}) {
  return <ReviewBody review={review} updatePlane={updatePlane} />;
}
