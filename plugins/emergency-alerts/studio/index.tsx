import { Siren } from "lucide-react";
import { defineStudioPlugin } from "@tilecast/studio";
import { EmergencyAlertsPage } from "./EmergencyAlertsPage";

export default defineStudioPlugin({
  id: "emergency_alerts",
  icon: Siren,
  routes: [{ index: true, element: <EmergencyAlertsPage /> }],
});
