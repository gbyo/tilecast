import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "../components/ui/alert";
import {
  useNativePresentation,
  usePresentationChrome,
} from "../native-presentation/presentationContext";
import { apiErrorMessage } from "../i18n";
import {
  IncidentDetailsContent,
  incidentDetailQuery,
} from "./ActivityIncidentsTab";
import {
  useCanActOnIncidents,
  useIncidentAction,
} from "./ActivityIncidentShared";
import { Loading } from "./ActivityShared";

/**
 * An incident's evidence and actions in a native presentation, at
 * /__native/modal/activity-incident/:id. It loads the incident by id and
 * renders the same body as the web Sheet and Drawer. Applying an action
 * closes the sheet, as it closes the Drawer, and the host tells the main
 * page to refetch the list.
 */
export function ActivityIncidentPresentation() {
  const { id = "" } = useParams();
  const { t } = useTranslation(["common"]);
  const presentation = useNativePresentation();
  const canAct = useCanActOnIncidents();
  const act = useIncidentAction();
  const query = useQuery({ ...incidentDetailQuery(id), enabled: Boolean(id) });
  usePresentationChrome({
    header: query.data
      ? {
          title: query.data.title,
          navigation: "close",
          navigationLabel: t("common:actions.close"),
        }
      : undefined,
    size: "full",
  });

  if (query.isError) {
    return (
      <div className="p-4">
        <Alert variant="destructive">
          <AlertDescription>{apiErrorMessage(query.error)}</AlertDescription>
        </Alert>
      </div>
    );
  }
  if (!query.data) return <Loading />;
  const incident = query.data;
  return (
    <div className="grid gap-4 p-4 pb-8">
      <p className="m-0 text-sm text-muted-foreground">
        {incident.description}
      </p>
      <IncidentDetailsContent
        incident={incident}
        canAct={canAct}
        onAct={(action) =>
          act.mutate(
            { id: incident.id, action },
            { onSuccess: () => presentation?.close() },
          )
        }
        pending={act.isPending}
        error={act.error?.message}
        className="grid gap-6"
      />
    </div>
  );
}
