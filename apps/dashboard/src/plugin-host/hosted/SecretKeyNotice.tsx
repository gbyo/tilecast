import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/i18n";
import { useStudioSession } from "../session";

/** The shell command that writes the keys to a file; it is not translated. */
const EXPORT_COMMAND = "tilecast-server secrets export-kek <file>";

export const pluginSecretStatusKey = ["plugin-secret-status"] as const;

/**
 * Warns Owners and Administrators who may export keys until one confirms an
 * export of the current key set. A rotation changes the set, so the warning
 * returns. It also says when restored secrets need new values. Shown only
 * when the installation stores a secret, so an installation that uses none is
 * never nagged.
 */
export function SecretKeyNotice() {
  const { t } = useTranslation("plugins");
  const session = useStudioSession();
  const queryClient = useQueryClient();
  const allowed = session.can("system.backups");
  const status = useQuery({
    queryKey: pluginSecretStatusKey,
    queryFn: api.pluginSecretStatus,
    enabled: allowed,
    retry: false,
  });
  const confirm = useMutation({
    mutationFn: () => api.confirmPluginSecretExport(session.csrfToken),
    onSuccess: (next) => queryClient.setQueryData(pluginSecretStatusKey, next),
  });
  const data = status.data;
  if (!allowed || !data || data.secrets === 0) return null;
  return (
    <>
      {data.unreadable > 0 && (
        <Alert variant="destructive">
          <KeyRound aria-hidden="true" />
          <AlertTitle>{t("secretKeys.unreadableTitle")}</AlertTitle>
          <AlertDescription>
            {t("secretKeys.unreadableBody", { count: data.unreadable })}
          </AlertDescription>
        </Alert>
      )}
      {!data.exportAcknowledged && (
        <Alert>
          <KeyRound aria-hidden="true" />
          <AlertTitle>{t("secretKeys.exportTitle")}</AlertTitle>
          <AlertDescription>
            <p>{t("secretKeys.exportBody")}</p>
            <code className="mt-2 block text-xs">{EXPORT_COMMAND}</code>
            {confirm.isError && (
              <p className="mt-2 text-destructive" role="alert">
                {apiErrorMessage(confirm.error)}
              </p>
            )}
            <Button
              type="button"
              size="sm"
              className="mt-3"
              disabled={confirm.isPending}
              onClick={() => confirm.mutate()}
            >
              {t("secretKeys.confirm")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}
