import { CalendarClock } from "lucide-react";
import { defineStudioPlugin } from "@tilecast/studio";

// The host generates this plugin's rooms, connections, and feed pages from
// its manifest. This module only gives the plugin its icon.
export default defineStudioPlugin({ id: "room_sign", icon: CalendarClock });
