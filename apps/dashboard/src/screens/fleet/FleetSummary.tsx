import { CircleAlert } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Screen } from "../../api/types";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { tallyFleet } from "./fleetModel";

/**
 * What is happening with the fleet, in the page's own voice. The Studio top
 * bar already says "Screens", so this is the first body content, in the same
 * register as the Overview recap. The online and needs-attention counts are
 * real buttons that apply the matching status filter; they are not decoration.
 */
export function FleetSummary({
  screens,
  loading,
  statusFilter,
  onStatusFilter,
  showStatus,
  actions,
}: {
  screens: readonly Screen[];
  loading: boolean;
  statusFilter: string;
  onStatusFilter: (status: string) => void;
  /** The status line describes the live fleet, so it is hidden on Archive. */
  showStatus: boolean;
  actions: ReactNode;
}) {
  const { t } = useTranslation("screens");
  const tally = tallyFleet(screens);
  const toggle = (status: string) =>
    onStatusFilter(statusFilter === status ? "" : status);

  const statusParts: ReactNode[] = [];
  if (showStatus && tally.total > 0) {
    statusParts.push(
      <Button
        key="online"
        type="button"
        variant="link"
        size="xs"
        aria-pressed={statusFilter === "online"}
        className="h-auto px-0 font-normal text-muted-foreground aria-pressed:font-medium aria-pressed:text-foreground aria-pressed:underline"
        onClick={() => toggle("online")}
      >
        {t("list.summaryOnline", { count: tally.online })}
      </Button>,
    );
    if (tally.attention > 0) {
      statusParts.push(
        <Button
          key="attention"
          type="button"
          variant="link"
          size="xs"
          aria-pressed={statusFilter === "attention"}
          className="h-auto px-0 font-medium text-destructive aria-pressed:underline"
          onClick={() => toggle("attention")}
        >
          <CircleAlert aria-hidden="true" />
          {t("list.healthAttention", { count: tally.attention })}
        </Button>,
      );
    }
  }

  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        {loading ? (
          <div role="status" aria-label={t("page.loadingInventory")}>
            <Skeleton className="h-6 w-56" />
            <Skeleton className="mt-2 h-4 w-40" />
          </div>
        ) : (
          <>
            <p className="text-lg leading-7 font-medium tracking-tight">
              {t("page.inventorySummary", {
                count: tally.total,
                locationPart: t("page.locationPart", {
                  count: tally.locations,
                }),
              })}
            </p>
            {statusParts.length > 0 && (
              <div
                role="group"
                className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground"
                aria-label={t("list.summaryGroup")}
              >
                {statusParts.map((part, index) => (
                  <Fragment key={index}>
                    {index > 0 && <span aria-hidden="true">·</span>}
                    {part}
                  </Fragment>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <div className="flex items-center gap-2">{actions}</div>
    </div>
  );
}
