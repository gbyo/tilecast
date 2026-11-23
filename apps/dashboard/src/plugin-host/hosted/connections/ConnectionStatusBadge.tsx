import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import type { PluginConnection } from "./api";

/** A connection's status as text with its color, never color alone. */
export function ConnectionStatusBadge({
  connection,
}: {
  connection: PluginConnection;
}) {
  const { t } = useTranslation("plugins");
  const ready = connection.status === "ready";
  return (
    <Badge variant={ready ? "default" : "secondary"}>
      {t(`hosted.connections.status.${connection.status}`, {
        defaultValue: connection.status,
      })}
    </Badge>
  );
}
