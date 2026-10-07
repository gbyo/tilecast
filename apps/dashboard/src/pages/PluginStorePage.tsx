import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert, Plus, SearchIcon, SearchX } from "lucide-react";
import type { PluginMarketplaceStatus } from "../api/types";
import { apiErrorMessage } from "../i18n";
import { useAuth } from "../auth/AuthProvider";
import { PageHeader } from "../components/PageHeader";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "../components/ui/carousel";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "../components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { AddCustomRepositoryDialog } from "../plugins/AddCustomRepositoryDialog";
import {
  filterStoreEntries,
  pluginCategories,
  usePluginStore,
  useRefreshMarketplaceCatalog,
  type PluginsT,
  type StoreCategoryFilter,
  type StoreSourceFilter,
} from "../plugins/pluginCatalog";
import { canManage } from "../plugins/shared";
import {
  StorePluginCard,
  StorePluginCardSkeleton,
} from "../plugins/StorePluginCard";
import { storeCardView, type StoreCardView } from "../plugins/storeCardView";

const categoryLabelKeys = {
  All: "catalog.categories.all",
  Display: "catalog.categories.display",
  Automation: "catalog.categories.automation",
  Workflow: "catalog.categories.workflow",
  Hardware: "catalog.categories.hardware",
} as const satisfies Record<
  StoreCategoryFilter,
  `catalog.categories.${string}`
>;

/**
 * Explore: the searchable plugin store. Release-owned, marketplace, and
 * custom entries share one card grid. Featured marketplace listings lead
 * in a carousel until the person searches or narrows the filters.
 */
export function PluginStorePage() {
  const { t } = useTranslation("plugins");
  const auth = useAuth();
  const store = usePluginStore();
  const refresh = useRefreshMarketplaceCatalog(auth.status?.csrfToken ?? "");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<StoreCategoryFilter>("All");
  const [source, setSource] = useState<StoreSourceFilter>("all");
  const [addOpen, setAddOpen] = useState(false);
  const canRefresh = canManage(auth.status?.user?.role);

  const entries = useMemo(() => store.data?.items ?? [], [store.data]);
  const sourceKinds = useMemo(
    () => [...new Set(entries.map((entry) => entry.source.kind))].sort(),
    [entries],
  );
  const results = useMemo(
    () => filterStoreEntries(entries, query, category, source),
    [entries, query, category, source],
  );
  const views = useMemo(
    () =>
      results.flatMap((entry) => {
        const view = storeCardView(entry);
        return view ? [view] : [];
      }),
    [results],
  );
  const filtered = Boolean(
    query.trim() || category !== "All" || source !== "all",
  );
  // A narrowed view answers a question; unrelated featured cards would
  // dilute it. Featured always draws from the unfiltered store.
  const featured = useMemo(
    () =>
      filtered
        ? []
        : entries.flatMap((entry) => {
            const view = storeCardView(entry);
            return view?.featured ? [view] : [];
          }),
    [entries, filtered],
  );

  return (
    <main className="grid gap-4">
      <PageHeader
        title={t("store.title")}
        description={t("store.description")}
        actions={
          canRefresh ? (
            <Button variant="default" onClick={() => setAddOpen(true)}>
              <Plus data-icon="inline-start" aria-hidden="true" />
              {t("store.add.action")}
            </Button>
          ) : undefined
        }
      />
      <AddCustomRepositoryDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        csrfToken={auth.status?.csrfToken ?? ""}
      />

      {store.isError && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{t("list.loadError")}</AlertDescription>
        </Alert>
      )}

      <MarketplaceStatusNotice
        marketplace={store.data?.marketplace}
        canRefresh={canManage(auth.status?.user?.role)}
        refreshing={refresh.isPending}
        refreshError={refresh.error}
        onRefresh={() => refresh.mutate()}
      />

      <StoreFilters
        query={query}
        category={category}
        source={source}
        sourceKinds={sourceKinds}
        onQueryChange={setQuery}
        onCategoryChange={setCategory}
        onSourceChange={setSource}
      />

      <StoreResults
        loading={store.isLoading}
        views={views}
        featured={featured}
        filtered={filtered}
      />
    </main>
  );
}

function MarketplaceStatusNotice({
  marketplace,
  canRefresh,
  refreshing,
  refreshError,
  onRefresh,
}: {
  marketplace?: PluginMarketplaceStatus;
  canRefresh: boolean;
  refreshing: boolean;
  refreshError: unknown;
  onRefresh: () => void;
}) {
  const { t } = useTranslation("plugins");
  if (!marketplace?.error && !marketplace?.stale) {
    return null;
  }

  const failed = Boolean(marketplace.error);
  return (
    <Alert variant={failed ? "destructive" : "default"}>
      <CircleAlert aria-hidden="true" />
      <AlertTitle>
        {failed
          ? t("store.marketplace.errorTitle")
          : t("store.marketplace.staleTitle")}
      </AlertTitle>
      <AlertDescription>
        {marketplace.error ?? t("store.marketplace.staleDescription")}
        {refreshError ? ` ${apiErrorMessage(refreshError)}` : ""}
      </AlertDescription>
      {canRefresh && (
        <AlertAction>
          <Button
            variant="outline"
            size="sm"
            disabled={refreshing}
            onClick={onRefresh}
          >
            {refreshing
              ? t("store.marketplace.refreshing")
              : t("store.marketplace.refresh")}
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}

function StoreFilters({
  query,
  category,
  source,
  sourceKinds,
  onQueryChange,
  onCategoryChange,
  onSourceChange,
}: {
  query: string;
  category: StoreCategoryFilter;
  source: StoreSourceFilter;
  sourceKinds: string[];
  onQueryChange: (value: string) => void;
  onCategoryChange: (value: StoreCategoryFilter) => void;
  onSourceChange: (value: StoreSourceFilter) => void;
}) {
  const { t } = useTranslation("plugins");
  return (
    <div className="grid gap-3">
      <InputGroup>
        <InputGroupAddon>
          <SearchIcon aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          aria-label={t("catalog.searchLabel")}
          placeholder={t("catalog.searchPlaceholder")}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </InputGroup>

      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup
          aria-label={t("catalog.categoryLabel")}
          variant="outline"
          size="sm"
          className="flex-wrap"
          value={[category]}
          onValueChange={(value) => {
            const next = value[0] as StoreCategoryFilter | undefined;
            if (next) onCategoryChange(next);
          }}
        >
          {(["All", ...pluginCategories] as StoreCategoryFilter[]).map(
            (name) => (
              <ToggleGroupItem key={name} value={name}>
                {t(categoryLabelKeys[name])}
              </ToggleGroupItem>
            ),
          )}
        </ToggleGroup>

        <Select
          items={[
            { value: "all", label: t("store.sources.all") },
            ...sourceKinds.map((kind) => ({
              value: kind,
              label: sourceLabel(kind, t),
            })),
          ]}
          value={source}
          onValueChange={(next) => {
            if (typeof next === "string") onSourceChange(next);
          }}
        >
          <SelectTrigger aria-label={t("store.sourceLabel")} className="w-fit">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("store.sources.all")}</SelectItem>
            {sourceKinds.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {sourceLabel(kind, t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function sourceLabel(kind: string, t: PluginsT) {
  if (kind === "included") return t("store.sources.included");
  if (kind === "marketplace") return t("store.sources.marketplace");
  if (kind === "custom") return t("store.sources.custom");
  return kind;
}

function StoreResults({
  loading,
  views,
  featured,
  filtered,
}: {
  loading: boolean;
  views: StoreCardView[];
  featured: StoreCardView[];
  filtered: boolean;
}) {
  const { t } = useTranslation("plugins");
  if (loading) {
    return (
      <div className="@container">
        <div
          role="status"
          aria-busy="true"
          aria-label={t("list.loading")}
          className={cardGridClass}
        >
          {[0, 1, 2, 3, 4, 5].map((key) => (
            <StorePluginCardSkeleton key={key} />
          ))}
        </div>
      </div>
    );
  }
  if (views.length === 0) {
    return (
      <Empty className="py-8">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchX aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>
            {filtered ? t("catalog.emptySearchTitle") : t("store.emptyTitle")}
          </EmptyTitle>
          <EmptyDescription>
            {filtered
              ? t("catalog.emptySearchDescription")
              : t("store.emptyDescription")}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="@container grid gap-6">
      {featured.length > 0 && <FeaturedPlugins views={featured} />}
      <section
        aria-label={featured.length > 0 ? t("store.allPlugins") : undefined}
        className="grid gap-3"
      >
        {featured.length > 0 && (
          <h2 className="text-sm font-medium">{t("store.allPlugins")}</h2>
        )}
        <ul className={cardGridClass}>
          {views.map((view) => (
            <li key={view.packageId} className="min-w-0">
              <StorePluginCard view={view} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/**
 * The grid sizes by the space the page leaves it, not by the viewport,
 * because the Studio sidebar takes a variable share of the width: one
 * column when narrow, two when medium, three when wide.
 */
const cardGridClass = "grid gap-4 @lg:grid-cols-2 @4xl:grid-cols-3";

function FeaturedPlugins({ views }: { views: StoreCardView[] }) {
  const { t } = useTranslation("plugins");
  return (
    <Carousel
      opts={{ align: "start", containScroll: "trimSnaps" }}
      aria-label={t("store.featured.label")}
      // The viewport clips at its edge; a little padding keeps each card's
      // ring and shadow from being cut off.
      className="grid gap-3 [&_[data-slot=carousel-content]]:-m-1 [&_[data-slot=carousel-content]]:p-1"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">{t("store.featured.title")}</h2>
        <div className="flex gap-2">
          <CarouselPrevious className="static translate-y-0" />
          <CarouselNext className="static translate-y-0" />
        </div>
      </div>
      <CarouselContent>
        {views.map((view) => (
          <CarouselItem
            key={view.packageId}
            className="basis-full @lg:basis-1/2 @4xl:basis-1/3"
          >
            <StorePluginCard view={view} variant="featured" />
          </CarouselItem>
        ))}
      </CarouselContent>
    </Carousel>
  );
}
