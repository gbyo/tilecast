import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DependencyNode, DependencyNodeType } from "../api/types";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from "../components/ui/combobox";
import { InputGroupAddon } from "../components/ui/input-group";
import { useFormatLocale } from "../i18n";
import { cn } from "cn";
import type { GraphIndex } from "./graphModel";
import { typeOrder, typePresentation } from "./resourceTypes";

/** Enough to find a resource by name without rendering thousands of rows. */
export const SEARCH_RESULT_LIMIT = 50;

type ResultGroup = { value: DependencyNodeType; items: DependencyNode[] };

/**
 * Search is navigation: choosing a result focuses the graph on it, so the
 * field clears afterwards rather than holding a selected value.
 */
export function DependencyResourceSearch({
  index,
  onSelect,
  className,
}: {
  index: GraphIndex;
  onSelect: (node: DependencyNode) => void;
  className?: string;
}) {
  const { t } = useTranslation(["content", "common"]);
  const locale = useFormatLocale();
  const [query, setQuery] = useState("");
  const { groups, truncated } = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(locale);
    const byType = new Map<DependencyNodeType, DependencyNode[]>();
    let shown = 0;
    let truncated = false;
    for (const node of index.nodes) {
      if (needle && !node.name.toLocaleLowerCase(locale).includes(needle))
        continue;
      if (shown === SEARCH_RESULT_LIMIT) {
        truncated = true;
        break;
      }
      shown += 1;
      const list = byType.get(node.type);
      if (list) list.push(node);
      else byType.set(node.type, [node]);
    }
    const groups: ResultGroup[] = typeOrder.flatMap((type) => {
      const items = byType.get(type);
      return items ? [{ value: type, items }] : [];
    });
    return { groups, truncated };
  }, [index.nodes, locale, query]);

  return (
    <Combobox<DependencyNode>
      items={groups}
      filteredItems={groups}
      filter={null}
      value={null}
      inputValue={query}
      // Choosing a result would otherwise write its name into the field.
      onInputValueChange={(value, details) => {
        if (details.reason !== "item-press") setQuery(value);
      }}
      itemToStringLabel={(node) => node.name}
      isItemEqualToValue={(left, right) =>
        left.type === right.type && left.id === right.id
      }
      onValueChange={(node) => {
        if (!node) return;
        setQuery("");
        onSelect(node);
      }}
      autoHighlight
    >
      <ComboboxInput
        aria-label={t("graph.toolbar.searchLabel")}
        placeholder={t("graph.toolbar.searchPlaceholder")}
        className={cn("w-72 max-sm:w-full", className)}
        showTrigger={false}
      >
        <InputGroupAddon>
          <Search aria-hidden="true" />
        </InputGroupAddon>
      </ComboboxInput>
      <ComboboxContent className="min-w-80">
        <ComboboxEmpty>{t("graph.toolbar.noResults")}</ComboboxEmpty>
        <ComboboxList>
          {(group: ResultGroup) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxLabel>
                {t(typePresentation[group.value].pluralKey)}
              </ComboboxLabel>
              <ComboboxCollection>
                {(node: DependencyNode) => {
                  const presentation = typePresentation[node.type];
                  const Icon = presentation.icon;
                  return (
                    <ComboboxItem key={`${node.type}:${node.id}`} value={node}>
                      <Icon
                        aria-hidden="true"
                        className="text-muted-foreground"
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {node.name}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {t(presentation.labelKey)}
                      </span>
                    </ComboboxItem>
                  );
                }}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
        {truncated && (
          <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
            {t("graph.toolbar.moreResults", { count: SEARCH_RESULT_LIMIT })}
          </p>
        )}
      </ComboboxContent>
    </Combobox>
  );
}
