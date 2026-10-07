import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Puzzle, TriangleAlert } from "lucide-react";
import { Link } from "react-router";
import { cn } from "cn";
import { Badge } from "../components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { PluginIcon } from "./PluginIcon";
import { StoreProvenanceBadge } from "./StoreProvenance";
import { storeCategoryLabel, type StoreCardView } from "./storeCardView";

/** Categories shown on a card; the rest collapse into a count. */
const visibleCategories = 2;

export type StorePluginCardVariant = "default" | "featured";

const sizing = {
  default: {
    card: "sm",
    icon: "size-12",
    glyph: "size-6",
    title: "text-sm",
    clamp: "line-clamp-2 min-h-10",
  },
  featured: {
    card: "default",
    icon: "size-14",
    glyph: "size-7",
    title: "text-base",
    clamp: "line-clamp-3 min-h-[3.75rem]",
  },
} as const;

/**
 * One plugin in Explore, for every source. The title link stretches over
 * the whole card, so the card is a single navigation target with one
 * focus stop and an accessible name that is just the plugin name.
 */
export function StorePluginCard({
  view,
  variant = "default",
}: {
  view: StoreCardView;
  variant?: StorePluginCardVariant;
}) {
  const { t } = useTranslation("plugins");
  const size = sizing[variant];
  const categories = view.categories.slice(0, visibleCategories);
  const hiddenCategories = view.categories.length - categories.length;

  return (
    <Card
      size={size.card}
      data-variant={variant}
      data-source={view.source.kind}
      className={cn(
        "relative h-full transition-colors",
        "hover:bg-muted/40 hover:ring-foreground/25",
        "has-focus-visible:ring-2 has-focus-visible:ring-ring",
      )}
    >
      <CardHeader>
        <div className="flex min-w-0 items-center gap-3">
          <StoreCardIcon view={view} className={size.icon} glyph={size.glyph} />
          <div className="min-w-0">
            <CardTitle className={cn("line-clamp-2", size.title)}>
              <Link
                to={view.to}
                className="outline-none after:absolute after:inset-0 after:content-['']"
              >
                {view.name}
              </Link>
            </CardTitle>
            {view.publisher && (
              <CardDescription className="truncate text-xs">
                {t("storeDetail.by", { publisher: view.publisher })}
              </CardDescription>
            )}
          </div>
        </div>
        {(view.installed || view.updateAvailable || !view.compatible) && (
          <CardAction className="flex flex-col items-end gap-1">
            {view.updateAvailable && (
              <Badge variant="secondary">
                {t("store.detail.updateAvailable")}
              </Badge>
            )}
            {view.installed && (
              <Badge variant="secondary">{t("catalog.installed")}</Badge>
            )}
            {!view.compatible && (
              <Badge variant="destructive">
                <TriangleAlert aria-hidden="true" data-icon="inline-start" />
                {t("store.card.incompatible")}
              </Badge>
            )}
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex-1">
        <p className={cn("text-sm text-muted-foreground", size.clamp)}>
          {view.description}
        </p>
      </CardContent>
      <CardFooter className="flex-wrap gap-1.5">
        <StoreProvenanceBadge source={view.source} />
        {categories.map((category) => (
          <Badge key={category} variant="secondary" className="capitalize">
            {storeCategoryLabel(category, t)}
          </Badge>
        ))}
        {hiddenCategories > 0 && (
          <Badge variant="secondary">
            {t("store.card.moreCategories", { count: hiddenCategories })}
          </Badge>
        )}
        <ChevronRight
          className="ml-auto size-4 text-muted-foreground"
          aria-hidden="true"
        />
      </CardFooter>
    </Card>
  );
}

/**
 * The plugin's mark. Store artwork loads from the server's own path. On any
 * failure, or without artwork, an included plugin shows the glyph Studio
 * ships and every other entry shows the generic icon, so a broken image
 * never leaves a hole.
 */
function StoreCardIcon({
  view,
  className,
  glyph,
}: {
  view: StoreCardView;
  className: string;
  glyph: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const artwork =
    view.iconUrl && view.iconUrl !== failedUrl ? view.iconUrl : null;

  return (
    <div
      data-slot="store-card-icon"
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted text-muted-foreground",
        className,
      )}
    >
      {artwork ? (
        <img
          src={artwork}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          className="size-full object-contain"
          onError={() => setFailedUrl(artwork)}
        />
      ) : view.pluginId ? (
        <PluginIcon pluginId={view.pluginId} className={glyph} />
      ) : (
        <Puzzle className={glyph} aria-hidden="true" />
      )}
    </div>
  );
}

/** A card-shaped placeholder with the real card's rhythm, to avoid layout shift. */
export function StorePluginCardSkeleton({
  variant = "default",
}: {
  variant?: StorePluginCardVariant;
}) {
  const size = sizing[variant];
  return (
    <Card size={size.card} className="h-full" aria-hidden="true">
      <CardHeader>
        <div className="flex items-center gap-3">
          <Skeleton className={cn("shrink-0 rounded-xl", size.icon)} />
          <div className="grid gap-1.5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1">
        <div className={cn("grid content-start gap-2", size.clamp)}>
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-4/5" />
        </div>
      </CardContent>
      <CardFooter className="gap-1.5">
        <Skeleton className="h-5 w-24 rounded-4xl" />
        <Skeleton className="h-5 w-16 rounded-4xl" />
      </CardFooter>
    </Card>
  );
}
