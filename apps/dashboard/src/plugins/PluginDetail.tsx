import { useTranslation } from "react-i18next";
import { CircleAlert } from "lucide-react";
import type { PluginSummary } from "../api/types";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "../components/ui/item";
import { Separator } from "../components/ui/separator";
import { pluginDisplayDescription, pluginDisplayName } from "./pluginCatalog";
import { PluginIcon } from "./PluginIcon";

/**
 * What a plugin is, what it needs, and what it touches, shown before it is
 * installed. Everything here comes from the server's registry.
 */
export function PluginDetail({ plugin }: { plugin: PluginSummary }) {
  const { t } = useTranslation("plugins");
  const name = pluginDisplayName(plugin, t);
  return (
    <div className="grid gap-5 pr-2">
      <Item className="px-0 py-0">
        <ItemMedia variant="image" className="size-12 bg-muted">
          <PluginIcon icon={plugin.icon} />
        </ItemMedia>
        <ItemContent>
          <ItemTitle className="text-base">{name}</ItemTitle>
          <ItemDescription className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline">{plugin.category}</Badge>
            <span>{t("detail.builtIn")}</span>
          </ItemDescription>
        </ItemContent>
      </Item>
      <p className="text-sm text-muted-foreground">
        {pluginDisplayDescription(plugin, t)}
      </p>
      {plugin.attention.map((note) => (
        <Alert key={note.code}>
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{note.message}</AlertDescription>
        </Alert>
      ))}
      <Separator />
      <DetailList
        title={t("detail.requirements")}
        empty={t("detail.noRequirements")}
        items={plugin.requirements.map((requirement) => ({
          key: requirement.kind + requirement.label,
          label: requirement.label,
          description: requirement.description,
        }))}
      />
      <DetailList
        title={t("detail.uses")}
        items={plugin.capabilities.map((capability) => ({
          key: capability,
          label: capability,
        }))}
      />
    </div>
  );
}

function DetailList({
  title,
  items,
  empty,
}: {
  title: string;
  items: { key: string; label: string; description?: string }[];
  empty?: string;
}) {
  if (items.length === 0 && !empty) return null;
  return (
    <section className="grid gap-2" aria-label={title}>
      <h3 className="text-sm font-medium">{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="grid gap-1.5 text-sm">
          {items.map((item) => (
            <li key={item.key} className="grid">
              <span>{item.label}</span>
              {item.description && (
                <span className="text-xs text-muted-foreground">
                  {item.description}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
