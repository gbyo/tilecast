import { Navigate, useParams, useSearchParams } from "react-router";
import { LivePreviewPanel } from "../components/LivePreviewPanel";
import { SnapshotHistoryPanel } from "../components/SnapshotHistoryPanel";
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
          <details
            className="border-t border-border pt-4"
            open={searchParams.get("tab") === "snapshots"}
          >
            <summary className="cursor-pointer text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Snapshot history
            </summary>
            <div className="mt-3 space-y-2">
              <p className="text-sm text-muted-foreground">
                Previously captured frames reported by this player.
              </p>
              <SnapshotHistoryPanel screenId={id} />
            </div>
          </details>
        </>
      )}
    </div>
  );
}
