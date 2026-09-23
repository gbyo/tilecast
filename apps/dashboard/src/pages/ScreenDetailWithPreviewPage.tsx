import { Navigate, useParams, useSearchParams } from "react-router";
import { ChevronDown } from "lucide-react";
import { LivePreviewPanel } from "../components/LivePreviewPanel";
import { SnapshotHistoryPanel } from "../components/SnapshotHistoryPanel";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import { ScreenDetailPage, normalizeScreenDetailTab } from "./ScreensPage";

export function ScreenDetailWithPreviewPage() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  if (!id) return <Navigate to="/screens" replace />;

  const tab = normalizeScreenDetailTab(
    searchParams.get("tab"),
    searchParams.get("section"),
  );

  return (
    <div className="w-full min-w-0 space-y-5">
      <ScreenDetailPage />
      {tab === "overview" && (
        <>
          <LivePreviewPanel screenId={id} />
          <Collapsible
            defaultOpen={searchParams.get("tab") === "snapshots"}
            className="border-t border-border pt-4"
          >
            <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between gap-2 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Snapshot history
              <ChevronDown size={16} aria-hidden="true" />
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3 space-y-2">
              <p className="text-sm text-muted-foreground">
                Previously captured frames reported by this player.
              </p>
              <SnapshotHistoryPanel screenId={id} />
            </CollapsibleContent>
          </Collapsible>
        </>
      )}
    </div>
  );
}
