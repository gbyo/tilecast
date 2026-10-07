import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { Button } from "../../components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/ui/collapsible";
import type { PluginsT } from "../pluginCatalog";

export type TechnicalRow = {
  key: string;
  label: string;
  /** One value, or several, shown one per line. */
  values: string[];
};

export type TechnicalInput = {
  packageId?: string;
  digest?: string;
  registry?: string;
  signer?: string;
  releaseTag?: string;
  runtimeModule?: string;
  source?: string;
  /** Raw background job ids, which the page shows by friendly name. */
  jobIds?: string[];
  /** Exact contribution identifiers and paths. */
  contributions?: { kind: string; path: string; id?: string }[];
};

/** The low-level facts about a package, labelled; empty ones are dropped. */
export function technicalRows(
  input: TechnicalInput,
  t: PluginsT,
): TechnicalRow[] {
  const rows: TechnicalRow[] = [];
  const add = (key: string, label: string, values: (string | undefined)[]) => {
    const present = values.filter((value): value is string => !!value);
    if (present.length > 0) rows.push({ key, label, values: present });
  };
  add("packageId", t("storeDetail.technical.packageId"), [input.packageId]);
  add("digest", t("store.detail.digestLabel"), [input.digest]);
  add("registry", t("storeDetail.technical.registry"), [input.registry]);
  add("signer", t("storeDetail.technical.signer"), [input.signer]);
  add("releaseTag", t("storeDetail.technical.releaseTag"), [input.releaseTag]);
  add("source", t("storeDetail.technical.source"), [input.source]);
  add("runtime", t("storeDetail.technical.runtime"), [input.runtimeModule]);
  add("jobs", t("storeDetail.technical.jobIds"), input.jobIds ?? []);
  add(
    "contributions",
    t("storeDetail.technical.contributions"),
    (input.contributions ?? []).map((contribution) =>
      [contribution.kind, contribution.id, contribution.path]
        .filter(Boolean)
        .join(" · "),
    ),
  );
  return rows;
}

/**
 * Collapsed by default: identifiers and digests answer an audit, not the
 * question of whether to install, so they sit one click away.
 */
export function TechnicalDetails({ rows }: { rows: TechnicalRow[] }) {
  const { t } = useTranslation("plugins");
  if (rows.length === 0) return null;
  return (
    <Collapsible className="rounded-xl bg-card ring-1 ring-foreground/10">
      <CollapsibleTrigger
        render={
          <Button
            variant="ghost"
            className="h-auto w-full justify-between px-4 py-3 text-sm font-medium"
          />
        }
      >
        {t("storeDetail.technical.title")}
        <ChevronDown
          aria-hidden="true"
          className="text-muted-foreground transition-transform group-data-[panel-open]/button:rotate-180 motion-reduce:transition-none"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="grid gap-3 px-4 pb-4">
          {rows.map((row) => (
            <div key={row.key} className="grid gap-0.5">
              <dt className="text-xs font-medium text-muted-foreground">
                {row.label}
              </dt>
              {row.values.map((value) => (
                <dd key={value} className="font-mono text-xs break-all">
                  {value}
                </dd>
              ))}
            </div>
          ))}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}
