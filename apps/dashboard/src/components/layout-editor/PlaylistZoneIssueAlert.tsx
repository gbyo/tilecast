import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import type { PlaylistZoneIssue } from "./playlistZoneIssues";

/** How many offending items an alert names before it counts the rest. */
const NAMED_ITEMS = 5;

/**
 * Names unsupported entries and explains the nested Layout restriction.
 */
export function PlaylistZoneIssueAlert({
  issue,
  className,
}: {
  issue: PlaylistZoneIssue;
  className?: string;
}) {
  const { t } = useTranslation("layouts");
  const shown = issue.items.slice(0, NAMED_ITEMS);
  const hidden = issue.items.length - shown.length;
  return (
    <Alert variant="destructive" className={className}>
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>{t("zoneIssue.title")}</AlertTitle>
      <AlertDescription>
        <p>{t("zoneIssue.intro", { playlist: issue.playlistName })}</p>
        <ul className="my-1 list-disc ps-5">
          {shown.map((item) => (
            <li key={item.id}>
              {t("zoneIssue.item", {
                name: item.name,
                kind: t(`zoneIssue.kind.${item.kind}`),
              })}
            </li>
          ))}
          {hidden > 0 && <li>{t("zoneIssue.more", { count: hidden })}</li>}
        </ul>
        <p>{t("zoneIssue.fix")}</p>
      </AlertDescription>
    </Alert>
  );
}
