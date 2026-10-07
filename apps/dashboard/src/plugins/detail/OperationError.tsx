import { useTranslation } from "react-i18next";
import { CircleAlert } from "lucide-react";
import { apiErrorMessage } from "../../i18n";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { inUseResources } from "../pluginCatalog";

/**
 * A failed package operation. A blocked one names the content that remains
 * and what to do about it; anything else is a plain message.
 */
export function OperationError({ error }: { error: unknown }) {
  const { t } = useTranslation("plugins");
  if (error === undefined || error === null) return null;
  const blockers = inUseResources(error);
  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden="true" />
      <AlertDescription className="grid gap-2">
        <p>{apiErrorMessage(error)}</p>
        {blockers !== null && (
          <>
            <ul className="list-disc pl-5">
              {blockers.map((blocker) => (
                <li key={blocker.kind}>
                  {t("packages.blockedResource", {
                    count: blocker.count,
                    label: blocker.label,
                  })}
                </li>
              ))}
            </ul>
            <p>{t("packages.blockedInstruction")}</p>
          </>
        )}
      </AlertDescription>
    </Alert>
  );
}
