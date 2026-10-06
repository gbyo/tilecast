/**
 * The pieces of the Data Source control: the chooser, the one-line summary
 * of a source, and its sample record. They only present; the control owns
 * which source is selected and how a new one is connected.
 */
import { useQuery } from "@tanstack/react-query";
import { Database } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/api/client";
import type { DataSource } from "@/api/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Collapsible,
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/studio/StudioCollapsible";
import {
  providerLabel,
  recordCountLabel,
  sourceIcon,
  statusLabel,
} from "@/content/dataSourceProviderMeta";
import { previewRecordMaps } from "@/content/previewRecords";

const SAMPLE_FIELD_LIMIT = 6;

/** What the control says about the current choice: connected, gone, or none yet. */
export function SelectedSource({
  labelId,
  selected,
  missing,
  loading,
  compatibleCount,
  chooser,
}: {
  labelId: string;
  selected: DataSource | undefined;
  missing: boolean;
  loading: boolean;
  compatibleCount: number;
  chooser: ReactNode;
}) {
  const { t } = useTranslation("content");
  if (selected)
    return (
      <Item variant="outline" size="sm" aria-labelledby={labelId}>
        <ItemMedia variant="icon" aria-hidden="true">
          {sourceIcon(selected.provider, undefined, 18)}
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle className="truncate">{selected.name}</ItemTitle>
          <ItemDescription>{sourceSummary(selected, t)}</ItemDescription>
        </ItemContent>
        {chooser && <ItemActions>{chooser}</ItemActions>}
      </Item>
    );
  if (missing)
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
          <span>{t("widgets.editor.data.missing")}</span>
          {chooser}
        </AlertDescription>
      </Alert>
    );
  return (
    <Item variant="muted" size="sm">
      <ItemMedia variant="icon" aria-hidden="true">
        <Database size={18} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{t("widgets.editor.data.none")}</ItemTitle>
        <ItemDescription>
          {loading
            ? t("widgets.editor.data.loading")
            : compatibleCount > 0
              ? t("widgets.editor.data.compatible", { count: compatibleCount })
              : t("widgets.editor.data.noneCompatible")}
        </ItemDescription>
      </ItemContent>
      {chooser && <ItemActions>{chooser}</ItemActions>}
    </Item>
  );
}

function sourceSummary(
  source: DataSource,
  t: ReturnType<typeof useTranslation<["content", "common"]>>["t"],
) {
  return [
    providerLabel(source.provider, t),
    statusLabel(source.status, t),
    recordCountLabel(source.cachedRecordCount, t),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function SourceChooser({
  label,
  sources,
  value,
  onChange,
  triggerId,
  describedBy,
  firstChoice,
}: {
  label: string;
  sources: readonly DataSource[];
  value: string;
  onChange: (id: string) => void;
  triggerId: string;
  describedBy: string | undefined;
  firstChoice: boolean;
}) {
  const { t } = useTranslation(["content", "common"]);
  const names = new Map(sources.map((source) => [source.id, source]));
  return (
    <Combobox
      items={sources.map((source) => source.id)}
      value={value || null}
      itemToStringLabel={(id: string) => names.get(id)?.name ?? id}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next);
      }}
    >
      <ComboboxTrigger
        id={triggerId}
        aria-label={
          firstChoice
            ? t("widgets.editor.data.chooseLabel", { label })
            : t("widgets.editor.data.changeLabel", { label })
        }
        aria-describedby={describedBy}
        render={<Button type="button" variant="outline" size="sm" />}
      >
        {firstChoice
          ? t("widgets.editor.data.choose")
          : t("widgets.editor.data.change")}
      </ComboboxTrigger>
      <ComboboxContent align="end" className="w-80">
        <ComboboxInput
          showTrigger={false}
          aria-label={t("widgets.editor.data.search")}
          placeholder={t("widgets.editor.data.search")}
        />
        <ComboboxEmpty>{t("widgets.editor.data.noMatch")}</ComboboxEmpty>
        <ComboboxList>
          {(id: string) => {
            const source = names.get(id);
            return (
              <ComboboxItem key={id} value={id}>
                <span aria-hidden="true">
                  {source ? sourceIcon(source.provider, undefined, 16) : null}
                </span>
                <span className="grid min-w-0">
                  <span className="truncate">{source?.name ?? id}</span>
                  {source && (
                    <span className="truncate text-xs text-muted-foreground">
                      {sourceSummary(source, t)}
                    </span>
                  )}
                </span>
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

export function SampleData({ sourceId }: { sourceId: string }) {
  const { t } = useTranslation("content");
  const [open, setOpen] = useState(false);
  const preview = useQuery({
    queryKey: ["widget-data-source-preview", sourceId],
    queryFn: () => api.previewSavedDataSource(sourceId),
    enabled: open,
    retry: false,
  });
  const record = previewRecordMaps(preview.data)[0];
  const entries = Object.entries(record ?? {})
    .filter(([key, entry]) => key !== "id" && entry !== "")
    .slice(0, SAMPLE_FIELD_LIMIT);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        {t("widgets.editor.data.sample")}
        <CollapsibleChevron size={14} />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        {preview.isLoading ? (
          <p className="text-sm text-muted-foreground">
            {t("widgets.editor.data.sampleLoading")}
          </p>
        ) : entries.length > 0 ? (
          <dl className="grid gap-1 rounded-md bg-muted p-2.5 text-sm">
            {entries.map(([key, entry]) => (
              <div key={key} className="flex min-w-0 gap-2">
                <dt className="shrink-0 font-medium">{key}</dt>
                <dd className="truncate text-muted-foreground">{entry}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">
            {preview.isError
              ? t("widgets.editor.data.sampleFailed")
              : t("widgets.editor.data.sampleEmpty")}
          </p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
