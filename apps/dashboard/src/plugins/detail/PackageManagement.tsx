import { useState } from "react";
import { useTranslation } from "react-i18next";
import { History, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../components/ui/alert-dialog";
import { Button } from "../../components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../../components/ui/item";
import { Spinner } from "../../components/ui/spinner";
import { DetailSection } from "./DetailSections";
import { OperationError } from "./OperationError";

const actionsClass = "w-full sm:w-auto [&>button]:w-full sm:[&>button]:w-auto";

/**
 * Recovery that is neither routine nor destructive: going back to the
 * version that was active before the last update. It asks first, and a
 * refusal from the server (content still uses what the newer version added)
 * names that content so the person knows what to clear.
 */
export function PackageManagement({
  name,
  pending,
  error,
  onRollback,
}: {
  name: string;
  pending: boolean;
  error: unknown;
  onRollback: () => void;
}) {
  const { t } = useTranslation(["plugins", "common"]);
  const [open, setOpen] = useState(false);
  return (
    <DetailSection
      id="detail-management"
      title={t("plugins:storeDetail.management.title")}
    >
      <OperationError error={error} />
      <ItemGroup>
        <Item variant="muted" size="sm">
          <ItemMedia variant="icon">
            <History aria-hidden="true" />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{t("plugins:packages.rollback")}</ItemTitle>
            <ItemDescription className="line-clamp-none">
              {t("plugins:storeDetail.management.rollbackBody")}
            </ItemDescription>
          </ItemContent>
          <ItemActions className={actionsClass}>
            <AlertDialog open={open} onOpenChange={setOpen}>
              <AlertDialogTrigger
                render={<Button variant="outline" disabled={pending} />}
              >
                {pending && (
                  <Spinner data-icon="inline-start" aria-hidden="true" />
                )}
                {t("plugins:packages.rollback")}
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {t("plugins:storeDetail.management.confirmTitle")}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("plugins:storeDetail.management.confirmBody", { name })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>
                    {t("common:actions.cancel")}
                  </AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => {
                      setOpen(false);
                      onRollback();
                    }}
                  >
                    {t("plugins:packages.rollback")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </ItemActions>
        </Item>
      </ItemGroup>
    </DetailSection>
  );
}

/**
 * Removal, alone and small. The confirmation is an AlertDialog whose final
 * action is destructive; a blocked removal renders with the content it names
 * right here, where the person just asked for it.
 */
export function PackageDangerZone({
  packageId,
  pending,
  error,
  onRemove,
}: {
  packageId: string;
  pending: boolean;
  error: unknown;
  onRemove: () => void;
}) {
  const { t } = useTranslation(["plugins", "common"]);
  const [open, setOpen] = useState(false);
  return (
    <section aria-labelledby="detail-danger" className="grid gap-3">
      <h2
        id="detail-danger"
        className="text-base font-semibold tracking-tight text-destructive"
      >
        {t("plugins:storeDetail.danger.title")}
      </h2>
      <OperationError error={error} />
      <Item variant="outline" size="sm" className="border-destructive/30">
        <ItemMedia variant="icon">
          <Trash2 className="text-destructive" aria-hidden="true" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{t("plugins:storeDetail.danger.removeTitle")}</ItemTitle>
          <ItemDescription className="line-clamp-none">
            {t("plugins:storeDetail.danger.removeBody")}
          </ItemDescription>
        </ItemContent>
        <ItemActions className={actionsClass}>
          <AlertDialog open={open} onOpenChange={setOpen}>
            <AlertDialogTrigger
              render={<Button variant="destructive" disabled={pending} />}
            >
              {pending && (
                <Spinner data-icon="inline-start" aria-hidden="true" />
              )}
              {t("plugins:packages.remove")}
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("plugins:packages.removeConfirmTitle")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("plugins:packages.removeConfirmBody", { packageId })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  {t("common:actions.cancel")}
                </AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => {
                    setOpen(false);
                    onRemove();
                  }}
                >
                  {t("plugins:packages.remove")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </ItemActions>
      </Item>
    </section>
  );
}
