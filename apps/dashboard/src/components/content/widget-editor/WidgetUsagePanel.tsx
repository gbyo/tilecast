import { ChevronRight, LayoutTemplate, ListVideo } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { Asset } from "@/api/types";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { EditorSidePanel } from "./EditorSidePanel";

/**
 * Everything that shows this Widget, so an author sees what a save will
 * change before making it. Links leave the editor through the usual
 * unsaved-changes confirmation.
 */
export function WidgetUsagePanel({
  asset,
  open,
  onOpenChange,
}: {
  asset: Asset;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("content");
  const playlists = asset.playlistsUsing ?? [];
  const layouts = asset.layoutUsage ?? [];
  return (
    <EditorSidePanel
      open={open}
      onOpenChange={onOpenChange}
      title={t("widgets.editor.usage.title")}
      description={t("widgets.editor.usage.description")}
    >
      <div className="grid gap-6">
        {playlists.length > 0 && (
          <section
            aria-labelledby="widget-usage-playlists"
            className="grid gap-2"
          >
            <h3
              id="widget-usage-playlists"
              className="text-xs font-medium text-muted-foreground"
            >
              {t("widgets.editor.usage.playlists")}
            </h3>
            <ItemGroup className="gap-1">
              {playlists.map((playlist) => (
                <Item
                  key={playlist.id}
                  size="sm"
                  render={<Link to={`/playlists/${playlist.id}`} />}
                >
                  <ItemMedia variant="icon" aria-hidden="true">
                    <ListVideo />
                  </ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle className="truncate">{playlist.name}</ItemTitle>
                  </ItemContent>
                  <ItemActions aria-hidden="true">
                    <ChevronRight className="size-4 text-muted-foreground" />
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          </section>
        )}
        {layouts.length > 0 && (
          <section
            aria-labelledby="widget-usage-layouts"
            className="grid gap-2"
          >
            <h3
              id="widget-usage-layouts"
              className="text-xs font-medium text-muted-foreground"
            >
              {t("widgets.editor.usage.layouts")}
            </h3>
            <ItemGroup className="gap-1">
              {layouts.map((layout) => (
                <Item
                  key={layout.id}
                  size="sm"
                  render={<Link to={`/layouts/${layout.id}`} />}
                >
                  <ItemMedia variant="icon" aria-hidden="true">
                    <LayoutTemplate />
                  </ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle className="truncate">{layout.name}</ItemTitle>
                  </ItemContent>
                  <ItemDescription className="shrink-0">
                    {layout.published
                      ? t("widgets.editor.usage.published")
                      : t("widgets.editor.usage.draft")}
                  </ItemDescription>
                  <ItemActions aria-hidden="true">
                    <ChevronRight className="size-4 text-muted-foreground" />
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          </section>
        )}
        {playlists.length === 0 && layouts.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {t("widgets.editor.usage.none")}
          </p>
        )}
      </div>
    </EditorSidePanel>
  );
}
