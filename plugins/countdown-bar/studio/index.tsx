import { Clock3 } from "lucide-react";
import { defineStudioPlugin } from "@tilecast/studio";
import { countdownApi, countdownBarQueryKey } from "./api";
import {
  CountdownBarEditorPage,
  CountdownBarsPage,
  PLUGIN_ID,
} from "./CountdownBarsPage";

export default defineStudioPlugin({
  id: PLUGIN_ID,
  icon: Clock3,
  routes: [
    { index: true, element: <CountdownBarsPage /> },
    {
      path: "new",
      element: <CountdownBarEditorPage />,
      handle: { breadcrumb: "New instance" },
    },
    {
      path: ":id",
      element: <CountdownBarEditorPage />,
      handle: {
        breadcrumb: "Instance",
        resource: { queryKey: countdownBarQueryKey, load: countdownApi.get },
      },
    },
  ],
});
