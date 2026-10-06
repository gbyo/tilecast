import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button, buttonVariants } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";

export function DisplayGroupDetailLoading() {
  const { t } = useTranslation("screens");
  return (
    <div className="grid gap-2" aria-label={t("groups.detail.loading")}>
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

/** A real 404 says so; any other failure offers a retry. */
export function DisplayGroupLoadError({
  notFound,
  onRetry,
}: {
  notFound: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation(["screens", "common"]);
  return (
    <section className="grid max-w-xl gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">
        {notFound
          ? t("groups.detail.notFoundTitle")
          : t("groups.detail.loadErrorTitle")}
      </h1>
      <Alert variant="destructive">
        <AlertDescription>
          {notFound
            ? t("groups.detail.notFoundBody")
            : t("groups.detail.loadErrorBody")}
        </AlertDescription>
      </Alert>
      <div className="flex flex-wrap gap-2">
        {!notFound && (
          <Button type="button" onClick={onRetry}>
            {t("common:actions.retry")}
          </Button>
        )}
        <Link to="/groups" className={buttonVariants({ variant: "outline" })}>
          {t("groups.detail.backToGroups")}
        </Link>
      </div>
    </section>
  );
}
