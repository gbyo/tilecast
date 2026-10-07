import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { Button } from "../../components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/ui/collapsible";
import type { TechnicalRow } from "./technicalDetailsModel";

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
