import {
  Airplay,
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  Copy,
  ListChecks,
  PackageMinus,
  Pencil,
  Play,
  RefreshCw,
  SquarePen,
  Trash2,
  Users,
  type LucideIcon,
} from "lucide-react";
import { navigationIcons } from "../../navigation/NavigationIcon";

/**
 * Lucide icons for the semantic action icon tokens. Native hosts map the
 * same tokens to their own symbols (packages/native-bridge-schema/
 * icon-tokens.json). Several tokens share one icon when they name the
 * same gesture with different words, such as copy and duplicate.
 */
export const actionIcons: Readonly<Record<string, LucideIcon>> = {
  open: ArrowUpRight,
  edit: SquarePen,
  rename: Pencil,
  copy: Copy,
  duplicate: Copy,
  trash: Trash2,
  delete: Trash2,
  archive: Archive,
  restore: ArchiveRestore,
  refresh: RefreshCw,
  restart: RefreshCw,
  play: Play,
  select: ListChecks,
  group: Users,
  remove: PackageMinus,
  details: Pencil,
  airplay: Airplay,
};

/**
 * The icon for an action token. Navigation tokens resolve too, so an
 * action can reuse a destination's icon, such as a screen's. An unknown
 * token renders nothing: unlike navigation, an action menu never shows
 * a misleading generic symbol.
 */
export function ActionIcon({ token }: { token: string }) {
  const Icon = actionIcons[token] ?? navigationIcons[token];
  if (!Icon) return null;
  return <Icon aria-hidden="true" />;
}
