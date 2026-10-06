import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { DashboardSearch } from "../../components/DashboardListToolbar";
import { Button } from "../../components/ui/button";

/** The count line with the create action, then the search field. */
export function DisplayGroupsToolbar({
  summary,
  search,
  onSearchChange,
  onSearchBlur,
  onCreate,
}: {
  summary: string;
  search: string;
  onSearchChange: (value: string) => void;
  onSearchBlur: () => void;
  /** Omit when the person cannot create groups. */
  onCreate?: () => void;
}) {
  const { t } = useTranslation("screens");
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-sm text-muted-foreground tabular-nums">{summary}</p>
        {onCreate && (
          <Button type="button" size="sm" onClick={onCreate}>
            <Plus aria-hidden="true" /> {t("groups.createShort")}
          </Button>
        )}
      </div>
      <div onBlur={onSearchBlur}>
        <DashboardSearch
          value={search}
          onValueChange={onSearchChange}
          label={t("groups.search.label")}
          placeholder={t("groups.search.placeholder")}
          clearLabel={t("groups.search.clearInput")}
          className="max-w-none"
        />
      </div>
    </>
  );
}
