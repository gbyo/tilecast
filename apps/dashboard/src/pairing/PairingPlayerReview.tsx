import { useTranslation } from "react-i18next";
import type { PairingRequest } from "../api/types";
import {
  Collapsible,
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/studio/StudioCollapsible";
import { Badge } from "../components/ui/badge";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "../components/ui/item";
import { useFormatLocale } from "../i18n";
import { deviceLabel, formatPairingExpiry, platformLabel } from "./pairingFlow";

/**
 * The security review: is this the physical player the operator intended to
 * pair? Identity first, verification metadata behind a disclosure.
 */
export function PairingPlayerReview({ request }: { request: PairingRequest }) {
  const { t } = useTranslation("screens");
  const formatLocale = useFormatLocale();
  const metadata = request.metadata;
  const showOs =
    metadata.androidVersion !== "" &&
    metadata.androidVersion.toLowerCase() !== "none";

  return (
    <div className="space-y-3">
      <Item variant="outline">
        <ItemContent>
          <ItemTitle className="text-base">{deviceLabel(request)}</ItemTitle>
          <ItemDescription>
            {platformLabel(metadata.platform, t)} · {metadata.screenWidth} ×{" "}
            {metadata.screenHeight}
          </ItemDescription>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {request.previouslyPaired && (
              <Badge variant="secondary">{t("review.previouslyPaired")}</Badge>
            )}
            <Badge variant="outline">
              {t("approval.expires", {
                time: formatPairingExpiry(request.expiresAt, formatLocale),
              })}
            </Badge>
          </div>
        </ItemContent>
      </Item>
      <p className="text-sm text-muted-foreground">{t("review.compareHint")}</p>
      <Collapsible>
        <CollapsibleTrigger className="flex w-fit cursor-pointer items-center gap-1.5 rounded-md text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {t("review.technicalDetails")}
          <CollapsibleChevron />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <dl className="grid gap-1 pt-2">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-sm text-muted-foreground">
                {t("approval.platform")}
              </dt>
              <dd className="text-right text-sm font-medium">
                {platformLabel(metadata.platform, t)}
              </dd>
            </div>
            {showOs && (
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-sm text-muted-foreground">
                  {t("approval.android")}
                </dt>
                <dd className="text-right text-sm font-medium">
                  {metadata.androidVersion}
                </dd>
              </div>
            )}
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-sm text-muted-foreground">
                {t("approval.player")}
              </dt>
              <dd className="text-right text-sm font-medium">
                {metadata.playerVersion}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-sm text-muted-foreground">
                {t("approval.resolution")}
              </dt>
              <dd className="text-right text-sm font-medium">
                {metadata.screenWidth} × {metadata.screenHeight}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-sm text-muted-foreground">
                {t("approval.locale")}
              </dt>
              <dd className="text-right text-sm font-medium">
                {metadata.locale} · {metadata.timezone}
              </dd>
            </div>
            {metadata.approximateAddress && (
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-sm text-muted-foreground">
                  {t("approval.network")}
                </dt>
                <dd className="text-right text-sm font-medium">
                  {metadata.approximateAddress}
                </dd>
              </div>
            )}
          </dl>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
