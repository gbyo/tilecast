import { UtensilsCrossed } from "lucide-react";
import { defineStudioPlugin } from "@tilecast/studio";

// The host generates this plugin's menus, connections, and feed pages from
// its manifest. This module only gives the plugin its icon.
export default defineStudioPlugin({ id: "menu_board", icon: UtensilsCrossed });
