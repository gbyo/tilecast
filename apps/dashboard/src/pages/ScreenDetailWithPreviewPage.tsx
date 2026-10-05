import { Navigate, useParams } from "react-router";
import { ScreenDetailPage } from "./ScreensPage";

export function ScreenDetailWithPreviewPage() {
  const { id } = useParams();
  if (!id) return <Navigate to="/screens" replace />;
  return <ScreenDetailPage />;
}
