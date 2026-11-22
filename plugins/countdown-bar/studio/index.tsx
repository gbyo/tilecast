import { Clock3 } from "lucide-react";
import { defineStudioPlugin } from "@tilecast/studio";

// The host generates this plugin's list, editor, and settings pages from its
// manifest. This module only gives the plugin its icon.
export default defineStudioPlugin({ id: "countdown_bar", icon: Clock3 });
