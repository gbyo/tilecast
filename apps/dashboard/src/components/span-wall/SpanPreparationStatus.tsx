import { useTranslation } from "react-i18next";
import type { SpanPanel, SpanStatus } from "../../api/types";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../ui/item";
import { Progress, ProgressValue } from "../ui/progress";
import { preparationStatusLabel } from "./spanWallModel";

/** Per-panel video preparation, with a progress bar while one is processing. */
export function SpanPreparationStatus({
  panels,
  preparations,
  screenNames,
}: {
  panels: readonly SpanPanel[];
  preparations: SpanStatus["preparations"];
  screenNames: ReadonlyMap<string, string>;
}) {
  const { t } = useTranslation("layouts");
  const byScreen = new Map(preparations.map((item) => [item.screenId, item]));
  return (
    <section className="grid gap-2" aria-live="polite">
      <h3 className="text-sm font-semibold">
        {t("spanWall.preparationTitle")}
      </h3>
      <ItemGroup render={<ul />} className="gap-1">
        {panels.map((panel) => {
          const item = byScreen.get(panel.screenId);
          const name = screenNames.get(panel.screenId) ?? panel.screenId;
          const percent =
            item?.progress != null ? Math.round(item.progress * 100) : null;
          return (
            <li key={panel.screenId}>
              <Item size="xs" variant="outline">
                <ItemContent>
                  <ItemTitle>{name}</ItemTitle>
                  {percent !== null && item?.status === "processing" && (
                    <Progress
                      value={percent}
                      aria-label={t("spanWall.preparationProgress", { name })}
                      className="w-full max-w-xs"
                    >
                      <ProgressValue>{() => `${percent}%`}</ProgressValue>
                    </Progress>
                  )}
                </ItemContent>
                <ItemDescription className="m-0 line-clamp-none">
                  {preparationStatusLabel(item?.status, t)}
                </ItemDescription>
              </Item>
            </li>
          );
        })}
      </ItemGroup>
    </section>
  );
}
