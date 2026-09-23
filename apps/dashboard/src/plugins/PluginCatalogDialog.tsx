import { useMemo, useState } from "react";
import { ArrowLeft, ChevronRight, SearchIcon, SearchX } from "lucide-react";
import type { PluginSummary } from "../api/types";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
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
import { ScrollArea } from "../components/ui/scroll-area";
import { Spinner } from "../components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { headlineRequirements, pluginCategories } from "./pluginCatalog";
import { PluginIcon } from "./PluginIcon";
import { PluginDetail } from "./PluginDetail";

type CategoryFilter = "All" | (typeof pluginCategories)[number];

/**
 * Add plugin: a searchable catalog of the plugins this Tilecast release ships,
 * with a detail step before anything is installed. Installed plugins are left
 * out of the default list and reappear, marked, when a search matches them.
 */
export function PluginCatalogDialog({
  open,
  onOpenChange,
  plugins,
  selectedId,
  onSelect,
  canInstall,
  installing,
  installError,
  onInstall,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plugins: PluginSummary[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  canInstall: boolean;
  installing: boolean;
  installError?: string;
  onInstall: (plugin: PluginSummary) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("All");
  const selected = plugins.find((plugin) => plugin.id === selectedId);
  const results = useMemo(
    () => filterCatalog(plugins, query, category),
    [plugins, query, category],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setQuery("");
          setCategory("All");
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="flex max-h-[min(90vh,44rem)] flex-col gap-5 sm:max-w-xl">
        {selected ? (
          <>
            <DialogHeader>
              <Button
                variant="ghost"
                size="sm"
                className="-ml-2 w-fit text-muted-foreground"
                onClick={() => onSelect(null)}
              >
                <ArrowLeft data-icon="inline-start" aria-hidden="true" />
                All plugins
              </Button>
              <DialogTitle className="sr-only">{selected.name}</DialogTitle>
              <DialogDescription className="sr-only">
                Review {selected.name} before installing it.
              </DialogDescription>
            </DialogHeader>
            <ScrollArea className="min-h-0 flex-1">
              <PluginDetail plugin={selected} />
            </ScrollArea>
            {installError && (
              <Alert variant="destructive">
                <AlertDescription>{installError}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              {selected.installed ? (
                <Button disabled>Installed</Button>
              ) : canInstall && selected.installable ? (
                <Button
                  disabled={installing}
                  onClick={() => onInstall(selected)}
                >
                  {installing && (
                    <Spinner data-icon="inline-start" aria-hidden="true" />
                  )}
                  Install
                </Button>
              ) : (
                <p className="self-center text-sm text-muted-foreground">
                  An Owner or Administrator can install plugins.
                </p>
              )}
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Add a plugin</DialogTitle>
              <DialogDescription>
                Optional features built into this Tilecast release. Installing
                one never downloads code.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <InputGroup>
                <InputGroupAddon>
                  <SearchIcon aria-hidden="true" />
                </InputGroupAddon>
                <InputGroupInput
                  aria-label="Search plugins"
                  placeholder="Search plugins…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  autoFocus
                />
              </InputGroup>
              <ToggleGroup
                aria-label="Plugin category"
                variant="outline"
                size="sm"
                className="flex-wrap"
                value={[category]}
                onValueChange={(value) => {
                  const next = value[0] as CategoryFilter | undefined;
                  if (next) setCategory(next);
                }}
              >
                {(["All", ...pluginCategories] as CategoryFilter[]).map(
                  (name) => (
                    <ToggleGroupItem key={name} value={name}>
                      {name}
                    </ToggleGroupItem>
                  ),
                )}
              </ToggleGroup>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              {results.length === 0 ? (
                <Empty className="py-8">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <SearchX aria-hidden="true" />
                    </EmptyMedia>
                    <EmptyTitle>
                      {query || category !== "All"
                        ? "No matching plugins"
                        : "Every plugin is installed"}
                    </EmptyTitle>
                    <EmptyDescription>
                      {query || category !== "All"
                        ? "Try another search or category."
                        : "This installation already uses every plugin this release offers."}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <ItemGroup className="gap-1 pr-2">
                  {results.map((plugin) => {
                    return (
                      <Item
                        key={plugin.id}
                        size="sm"
                        render={<button type="button" />}
                        className="text-left hover:bg-muted"
                        onClick={() => onSelect(plugin.id)}
                      >
                        <ItemMedia variant="image" className="bg-muted">
                          <PluginIcon icon={plugin.icon} />
                        </ItemMedia>
                        <ItemContent>
                          <ItemTitle>
                            {plugin.name}
                            {plugin.installed && (
                              <Badge variant="secondary">Installed</Badge>
                            )}
                          </ItemTitle>
                          <ItemDescription>
                            {plugin.description}
                          </ItemDescription>
                          {headlineRequirements(plugin).length > 0 && (
                            <p className="text-xs text-muted-foreground">
                              Requires{" "}
                              {headlineRequirements(plugin)
                                .map((requirement) => requirement.label)
                                .join(" + ")}
                            </p>
                          )}
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
            </ScrollArea>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function filterCatalog(
  plugins: PluginSummary[],
  query: string,
  category: CategoryFilter,
) {
  const needle = query.trim().toLocaleLowerCase();
  return plugins.filter((plugin) => {
    if (category !== "All" && plugin.category !== category) return false;
    if (!needle) return !plugin.installed;
    return [
      plugin.name,
      plugin.description,
      plugin.category,
      ...plugin.capabilities,
    ]
      .join(" ")
      .toLocaleLowerCase()
      .includes(needle);
  });
}
