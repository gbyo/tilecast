import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, Star } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { storeCategoryLabel } from "../storeCardView";
import type { PluginDetailViewModel } from "./detailView";
import { PluginArtwork } from "./PluginArtwork";

/** More than two categories read as noise; the rest live in the listing. */
const maxCategories = 2;

/**
 * The top of a store entry: mark, name, publisher, badges, description, and
 * on a wide viewport the primary action. On narrow viewports the action
 * moves into the package status card, directly below, so exactly one copy of
 * it is ever in the page.
 *
 * Badges stay few: where it comes from, up to two categories, Featured where
 * it applies, and the one state worth an eye: an update. Whether a package
 * is installed is the status card's job.
 */
export function PluginDetailHero({
  view,
  updateAvailable,
  action,
}: {
  view: PluginDetailViewModel;
  updateAvailable: boolean;
  /** Rendered top-right; omitted on narrow viewports. */
  action?: ReactNode;
}) {
  const { t } = useTranslation("plugins");
  return (
    <header
      data-source={view.sourceKind}
      className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-3 xl:grid-cols-[auto_minmax(0,1fr)_auto] xl:items-start xl:gap-x-5"
    >
      <PluginArtwork
        pluginId={view.plugin?.id}
        iconUrl={view.iconUrl}
        className="size-16 sm:size-20"
        glyphClassName="size-8 sm:size-10"
      />
      <div className="grid min-w-0 gap-0.5">
        <h1 className="text-xl font-semibold tracking-tight text-balance sm:text-3xl">
          {view.name}
        </h1>
        {view.publisher && (
          <p className="truncate text-sm text-muted-foreground">
            {t("storeDetail.by", { publisher: view.publisher })}
          </p>
        )}
      </div>
      <div className="col-span-2 grid gap-3 xl:col-span-1 xl:col-start-2 xl:row-start-2">
        <ul
          aria-label={t("storeDetail.badgesLabel")}
          className="flex flex-wrap items-center gap-1.5"
        >
          <li>
            <Badge variant="outline">
              {t(`storeDetail.sourceBadge.${view.sourceKind}`)}
            </Badge>
          </li>
          {view.categories.slice(0, maxCategories).map((category) => (
            <li key={category}>
              <Badge variant="secondary">
                {storeCategoryLabel(category, t)}
              </Badge>
            </li>
          ))}
          {view.featured && (
            <li>
              <Badge variant="secondary">
                <Star aria-hidden="true" data-icon="inline-start" />
                {t("storeDetail.featured")}
              </Badge>
            </li>
          )}
          {updateAvailable && (
            <li>
              <Badge>
                <RefreshCw aria-hidden="true" data-icon="inline-start" />
                {t("store.detail.updateAvailable")}
              </Badge>
            </li>
          )}
        </ul>
        {view.description && (
          <p className="max-w-prose text-sm/relaxed text-muted-foreground sm:text-base/relaxed">
            {view.description}
          </p>
        )}
      </div>
      {action && (
        <div className="col-start-3 row-span-2 row-start-1 flex items-start justify-end">
          {action}
        </div>
      )}
    </header>
  );
}
