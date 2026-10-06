import { useTranslation } from "react-i18next";
import type { PluginStoreSource } from "../api/types";
import { Badge } from "../components/ui/badge";

/**
 * Where a store entry comes from, as text and not color alone. Unknown
 * source kinds render their raw identifier so a newer server never blanks
 * the label.
 */
export function StoreProvenanceBadge({
  source,
}: {
  source: PluginStoreSource;
}) {
  const { t } = useTranslation("plugins");
  const label =
    source.kind === "included" ? t("store.sources.included") : source.kind;
  return <Badge variant="outline">{label}</Badge>;
}
