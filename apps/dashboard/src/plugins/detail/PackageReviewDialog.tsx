import { useTranslation } from "react-i18next";
import { CircleAlert } from "lucide-react";
import { apiErrorMessage } from "../../i18n";
import type { GitHubInstallReview, InstalledPackage } from "../../api/types";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { ResponsiveDialog } from "./ResponsiveDialog";
import { ReviewBody } from "./ReviewBody";

/**
 * The install review and the update review in one shell: a dialog on wide
 * viewports, a drawer on phones, with Cancel and the confirming action kept
 * in view while the body scrolls. Confirming installs or updates exactly the
 * digest the review resolved, as before.
 */
export function PackageReviewDialog({
  open,
  onOpenChange,
  review,
  installed,
  updatePlane,
  canConfirm,
  confirming,
  onConfirm,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  review: GitHubInstallReview;
  /** Present for an update: the installed package being replaced. */
  installed?: InstalledPackage;
  updatePlane?: "repository" | "catalog";
  canConfirm: boolean;
  confirming: boolean;
  onConfirm: () => void;
  /** A failure of the confirming operation, shown beside the action. */
  error?: unknown;
}) {
  const { t } = useTranslation(["plugins", "common"]);
  const updating = installed !== undefined;
  const name = review.manifest.name;
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        updating
          ? t("plugins:storeDetail.review.updateTitle", { name })
          : t("plugins:storeDetail.review.installTitle", { name })
      }
      description={
        updating
          ? t("plugins:storeDetail.review.updateDescription", {
              version: review.version,
            })
          : t("plugins:storeDetail.review.installDescription")
      }
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          {canConfirm && (
            <Button
              disabled={confirming || !review.compatible}
              onClick={onConfirm}
            >
              {confirming && (
                <Spinner data-icon="inline-start" aria-hidden="true" />
              )}
              {updating
                ? t("plugins:packages.updateTo", { version: review.version })
                : t("plugins:storeDetail.review.confirmInstall")}
            </Button>
          )}
        </>
      }
    >
      <div className="grid gap-5">
        {error ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertDescription>{apiErrorMessage(error)}</AlertDescription>
          </Alert>
        ) : null}
        <ReviewBody
          review={review}
          installed={installed}
          updatePlane={updatePlane}
        />
      </div>
    </ResponsiveDialog>
  );
}
