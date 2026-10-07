import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
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
 * Badges stay few: where it comes from, up to two categories, and the one
 * state worth an eye: an update. Featured is a discovery cue for Explore,
 * and whether a package is installed is the status card's job.
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
  const publisherHref = publisherDestination(view);
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
            <PublisherLine publisher={view.publisher} href={publisherHref} />
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

/**
 * Where a publisher name can lead. The listing names a repository, not a
 * publisher profile, so the name links to the package's own repository and
 * only when that is a plain https address. Included plugins have none.
 */
function publisherDestination(view: PluginDetailViewModel) {
  if (!view.repository) return undefined;
  try {
    return new URL(view.repository).protocol === "https:"
      ? view.repository
      : undefined;
  } catch {
    return undefined;
  }
}

function PublisherLine({
  publisher,
  href,
}: {
  publisher: string;
  href: string | undefined;
}) {
  const { t } = useTranslation("plugins");
  if (!href) return <>{t("storeDetail.by", { publisher })}</>;
  return (
    <Trans
      i18nKey="storeDetail.byLinked"
      ns="plugins"
      values={{ publisher }}
      components={{
        publisher: (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            aria-label={t("storeDetail.publisherLinkLabel", { publisher })}
            className="rounded-sm text-foreground/80 underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
        ),
      }}
    />
  );
}
