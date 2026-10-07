import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, CircleAlert, SearchIcon, SearchX } from "lucide-react";
import { Link } from "react-router";
import { PageHeader } from "../components/PageHeader";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
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
  type StoreCategoryFilter,
  type StoreSourceFilter,
} from "../plugins/pluginCatalog";
import { PluginIcon } from "../plugins/PluginIcon";
import { StoreProvenanceBadge } from "../plugins/StoreProvenance";

// Catalog category filters are translation keys; the raw category value stays
// the filter value so it keeps matching the server's category strings.
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
 * Explore: the searchable plugin store. First-party and marketplace entries
 * share one list once the package system exists; in this release every
 * entry is included with Tilecast.
 */
export function PluginStorePage() {
  const { t } = useTranslation(["plugins", "common"]);
  const store = usePluginStore();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<StoreCategoryFilter>("All");
  const [source, setSource] = useState<StoreSourceFilter>("all");

  const entries = useMemo(() => store.data?.items ?? [], [store.data]);
  const sources = useMemo(() => {
    const kinds = [...new Set(entries.map((entry) => entry.source.kind))];
    kinds.sort();
    return kinds;
  }, [entries]);
  const results = useMemo(
    () => filterStoreEntries(entries, query, category, source),
    [entries, query, category, source],
  );

  return (
    <main className="grid gap-4">
      <PageHeader
        title={t("store.title")}
        description={t("store.description")}
      />

      {store.isError && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{t("list.loadError")}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-3">
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            aria-label={t("catalog.searchLabel")}
            placeholder={t("catalog.searchPlaceholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
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
              if (next) setCategory(next);
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
              ...sources.map((kind) => ({
                value: kind,
                label: kind === "included" ? t("store.sources.included") : kind,
              })),
            ]}
            value={source}
            onValueChange={(next) => {
              if (typeof next === "string") setSource(next);
            }}
          >
            <SelectTrigger
              aria-label={t("store.sourceLabel")}
              className="w-fit"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("store.sources.all")}</SelectItem>
              {sources.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {kind === "included" ? t("store.sources.included") : kind}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {store.isLoading ? (
        <ItemGroup className="gap-2" aria-label={t("list.loading")}>
          {[0, 1, 2].map((key) => (
            <Skeleton key={key} className="h-20 rounded-xl" />
          ))}
        </ItemGroup>
      ) : results.length === 0 ? (
        <Empty className="py-8">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchX aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>
              {query || category !== "All" || source !== "all"
                ? t("catalog.emptySearchTitle")
                : t("store.emptyTitle")}
            </EmptyTitle>
            <EmptyDescription>
              {query || category !== "All" || source !== "all"
                ? t("catalog.emptySearchDescription")
                : t("store.emptyDescription")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup className="gap-1">
          {results.map((entry) => {
            const plugin = entry.plugin;
            const headline = headlineRequirements(plugin);
            return (
              <Item
                key={entry.packageId}
                size="sm"
                render={
                  <Link
                    to={`/plugins/store/${encodeURIComponent(entry.packageId)}`}
                  />
                }
                className="text-left hover:bg-muted"
              >
                <ItemMedia variant="image" className="bg-muted">
                  <PluginIcon pluginId={plugin.id} />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    {plugin.name}
                    {plugin.installed && (
                      <Badge variant="secondary">
                        {t("catalog.installed")}
                      </Badge>
                    )}
                  </ItemTitle>
                  <ItemDescription>{plugin.description}</ItemDescription>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StoreProvenanceBadge source={entry.source} />
                    {headline.length > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {t("catalog.requires", {
                          list: headline
                            .map((requirement) => requirement.label)
                            .join(" + "),
                        })}
                      </span>
                    )}
                  </div>
                </ItemContent>
                <ItemActions>
                  <ChevronRight
                    className="text-muted-foreground"
                    aria-hidden="true"
                  />
                </ItemActions>
              </Item>
            );
          })}
        </ItemGroup>
      )}
    </main>
  );
}
