import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { PairingRequest } from "../api/types";
import { Badge } from "../components/ui/badge";
import { buttonVariants } from "../components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../components/ui/item";
import { useFormatLocale } from "../i18n";
import { formatPairingExpiry, platformLabel } from "./pairingFlow";
import { useNativePairScreen } from "./useNativePairScreen";

/**
 * The fleet's pending pairing work as a normal operational section: heading,
 * count, and one row per waiting player. Review opens the native pair
 * presentation when one is available, and the browser route otherwise.
 */
export function PendingPairings({
  requests,
  canManage,
}: {
  requests: PairingRequest[];
  canManage: boolean;
}) {
  const { t } = useTranslation("screens");
  const formatLocale = useFormatLocale();
  const openPairScreen = useNativePairScreen();
  if (requests.length === 0) return null;
  return (
    <section className="space-y-2" aria-label={t("pending.section")}>
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold">{t("pending.title")}</h2>
        <Badge variant="secondary">{requests.length}</Badge>
      </div>
      <ItemGroup className="gap-1.5">
        {requests.map((request) => (
          <Item
            key={request.id}
            size="xs"
            variant="outline"
            render={<div role="listitem" />}
          >
            <ItemContent className="min-w-0">
              <ItemTitle>
                {request.metadata.manufacturer} {request.metadata.model}
              </ItemTitle>
              <ItemDescription>
                {platformLabel(request.metadata.platform, t)} ·{" "}
                {request.metadata.screenWidth}×{request.metadata.screenHeight} ·{" "}
                {t("pending.expires", {
                  time: formatPairingExpiry(request.expiresAt, formatLocale),
                })}
              </ItemDescription>
            </ItemContent>
            {canManage && (
              <ItemActions>
                <Link
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                  to={`/screens/pair/request/${request.id}`}
                  onClick={(event) =>
                    void openPairScreen(
                      event,
                      ["pair-screen", request.id],
                      `/screens/pair/request/${request.id}`,
                    )
                  }
                >
                  {t("pending.review")}
                </Link>
              </ItemActions>
            )}
          </Item>
        ))}
      </ItemGroup>
    </section>
  );
}
