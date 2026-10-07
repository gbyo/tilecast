import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert } from "lucide-react";
import { useNavigate } from "react-router";
import { apiErrorMessage } from "../i18n";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Field, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";
import { InstallReview } from "./InstallReview";
import { usePackageLifecycle } from "./pluginCatalog";

/**
 * Add a custom repository: paste a public GitHub URL, review what the
 * latest published release supplies, then install. Resolving persists
 * nothing; installing re-resolves fresh and binds the repository, so the
 * dialog closes onto the new store entry.
 */
export function AddCustomRepositoryDialog({
  open,
  onClose,
  csrfToken,
}: {
  open: boolean;
  onClose: () => void;
  csrfToken: string;
}) {
  const { t } = useTranslation(["plugins", "common"]);
  const navigate = useNavigate();
  const { resolve, install } = usePackageLifecycle(csrfToken);
  const [repository, setRepository] = useState("");
  const review = resolve.data;

  const close = () => {
    resolve.reset();
    install.reset();
    setRepository("");
    onClose();
  };

  const lookUp = () => {
    install.reset();
    resolve.mutate(repository.trim());
  };

  const installReviewed = () => {
    if (!review) return;
    install.mutate(
      { packageId: review.packageId, repository: review.repositoryUrl },
      {
        onSuccess: (installed) => {
          close();
          void navigate(
            `/plugins/store/${encodeURIComponent(installed.packageId)}`,
          );
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("store.add.title")}</DialogTitle>
          <DialogDescription>{t("store.add.description")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field>
            <FieldLabel htmlFor="custom-repository-url">
              {t("store.add.urlLabel")}
            </FieldLabel>
            <div className="flex gap-2">
              <Input
                id="custom-repository-url"
                autoFocus
                inputMode="url"
                autoComplete="url"
                placeholder={t("store.add.urlPlaceholder")}
                value={repository}
                onChange={(event) => setRepository(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Enter" && repository.trim()) lookUp();
                }}
              />
              <Button
                variant="outline"
                disabled={!repository.trim() || resolve.isPending}
                onClick={lookUp}
              >
                {resolve.isPending && (
                  <Spinner data-icon="inline-start" aria-hidden="true" />
                )}
                {resolve.isPending
                  ? t("store.add.resolving")
                  : t("store.add.resolve")}
              </Button>
            </div>
          </Field>
          {resolve.error && (
            <Alert variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertDescription>
                {apiErrorMessage(resolve.error)}
              </AlertDescription>
            </Alert>
          )}
          {review && <InstallReview review={review} />}
          {install.error && (
            <Alert variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertDescription>
                {apiErrorMessage(install.error)}
              </AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" type="button" onClick={close}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            type="button"
            disabled={!review || install.isPending || !review.compatible}
            onClick={installReviewed}
          >
            {install.isPending && (
              <Spinner data-icon="inline-start" aria-hidden="true" />
            )}
            {install.isPending
              ? t("store.add.installing")
              : t("store.add.install")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
