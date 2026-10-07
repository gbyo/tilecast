import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronRight,
  CircleAlert,
  Puzzle,
  SearchIcon,
  SearchX,
} from "lucide-react";
import { Link } from "react-router";
import type {
  PluginMarketplaceStatus,
  PluginStoreEntry,
  PluginSummary,
} from "../api/types";
import { apiErrorMessage } from "../i18n";
import { useAuth } from "../auth/AuthProvider";
import { PageHeader } from "../components/PageHeader";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
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
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import {
  filterStoreEntries,
  headlineRequirements,
  pluginCategories,
  usePluginStore,
  useRefreshMarketplaceCatalog,
  type PluginsT,
  type StoreCategoryFilter,
  type StoreSourceFilter,
} from "../plugins/pluginCatalog";
import { PluginIcon } from "../plugins/PluginIcon";
import { canManage } from "../plugins/shared";
import { StoreProvenanceBadge } from "../plugins/StoreProvenance";

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

export function PluginStorePage() {
  const { t } = useTranslation("plugins");
  const auth = useAuth();
  const store = usePluginStore();
  const refresh = useRefreshMarketplaceCatalog(auth.status?.csrfToken ?? "");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<StoreCategoryFilter>("All");
  const [source, setSource] = useState<StoreSourceFilter>("all");

  const entries = useMemo(() => store.data?.items ?? [], [store.data]);
  const sourceKinds = useMemo(
    () => [...new Set(entries.map((entry) => entry.source.kind))].sort(),
    [entries],
  );
  const results = useMemo(
    () => filterStoreEntries(entries, query, category, source),
    [entries, query, category, source],
  );

  return (
    <main className="grid gap-4">
      <PageHeader
        title={t("store.title")}
        description={
          store.data?.marketplace.configured
            ? t("store.description")
            : t("catalog.description")
        }
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
        results={results}
        filtered={Boolean(query || category !== "All" || source !== "all")}
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
  if (!marketplace?.configured || (!marketplace.error && !marketplace.stale)) {
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
  return kind;
}

function StoreResults({
  loading,
  results,
  filtered,
}: {
  loading: boolean;
  results: PluginStoreEntry[];
  filtered: boolean;
}) {
  const { t } = useTranslation("plugins");
  if (loading) {
    return (
      <ItemGroup className="gap-2" aria-label={t("list.loading")}>
        {[0, 1, 2].map((key) => (
          <Skeleton key={key} className="h-20 rounded-xl" />
        ))}
      </ItemGroup>
    );
  }
  if (results.length === 0) {
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
    <ItemGroup className="gap-1">
      {results.map((entry) => (
        <StoreRow key={entry.packageId} entry={entry} />
      ))}
    </ItemGroup>
  );
}

function StoreRow({ entry }: { entry: PluginStoreEntry }) {
  const { t } = useTranslation("plugins");
  const view = storeRowView(entry);
  if (!view) return null;

  return (
    <Item
      size="sm"
      render={
        <Link to={`/plugins/store/${encodeURIComponent(entry.packageId)}`} />
      }
      className="text-left hover:bg-muted"
    >
      <ItemMedia variant="image" className="bg-muted">
        {view.plugin ? (
          <PluginIcon pluginId={view.plugin.id} />
        ) : (
          <Puzzle aria-hidden="true" />
        )}
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {view.name}
          {view.installed && (
            <Badge variant="secondary">{t("catalog.installed")}</Badge>
          )}
          {view.updateAvailable && (
            <Badge variant="secondary">
              {t("store.detail.updateAvailable")}
            </Badge>
          )}
        </ItemTitle>
        <ItemDescription>{view.description}</ItemDescription>
        <div className="flex flex-wrap items-center gap-1.5">
          <StoreProvenanceBadge source={entry.source} />
          {view.marketplaceMeta && (
            <span className="text-xs text-muted-foreground">
              {view.marketplaceMeta.publisher}
              {" · "}
              {t("store.detail.version", {
                version: view.marketplaceMeta.version,
              })}
            </span>
          )}
          {view.requirementLabels.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {t("catalog.requires", {
                list: view.requirementLabels.join(" + "),
              })}
            </span>
          )}
        </div>
      </ItemContent>
      <ItemActions>
        <ChevronRight className="text-muted-foreground" aria-hidden="true" />
      </ItemActions>
    </Item>
  );
}

function storeRowView(entry: PluginStoreEntry) {
  const plugin = entry.plugin;
  const listing = entry.marketplace;
  if (!plugin && !listing) return null;

  return {
    plugin,
    name: plugin?.name ?? listing?.name ?? entry.packageId,
    description: plugin?.description ?? listing?.description ?? "",
    installed: plugin?.installed ?? listing?.installed ?? false,
    updateAvailable: listing?.updateAvailable ?? false,
    requirementLabels: plugin
      ? headlineRequirements(plugin).map((requirement) => requirement.label)
      : [],
    marketplaceMeta: listing
      ? { publisher: listing.publisherName, version: listing.version }
      : null,
  };
}
