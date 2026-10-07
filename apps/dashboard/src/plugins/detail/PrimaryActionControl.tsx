import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Button, buttonVariants } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { cn } from "cn";
import type { PrimaryAction } from "./detailView";

/**
 * The one install, review, or open control of a store entry. An installed
 * package renders nothing here: its status badge and status row already say
 * so, and a disabled "Installed" button would only look broken.
 */
export function PrimaryActionControl({
  action,
  name,
  pending,
  onRun,
  describedBy,
  className,
}: {
  action: PrimaryAction;
  name: string;
  pending: boolean;
  onRun: () => void;
  /** Names the element that explains a disabled action. */
  describedBy?: string;
  className?: string;
}) {
  const { t } = useTranslation("plugins");
  if (action.kind === "none" || action.kind === "installed") return null;
  if (action.kind === "open") {
    return (
      <Link
        to={action.to}
        aria-label={t("list.openLabel", { name })}
        className={cn(buttonVariants({ variant: "default" }), className)}
      >
        {t("list.openAction")}
      </Link>
    );
  }
  return (
    <Button
      className={className}
      disabled={action.disabled || pending}
      aria-describedby={action.disabled ? describedBy : undefined}
      onClick={onRun}
    >
      {pending && <Spinner data-icon="inline-start" aria-hidden="true" />}
      {action.kind === "review"
        ? t("catalog.reviewInstall")
        : t("catalog.install")}
    </Button>
  );
}
