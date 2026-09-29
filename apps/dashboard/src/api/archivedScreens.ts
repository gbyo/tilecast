import { apiGet } from "./transport";
import { normalizeScreen } from "./domains/screens";
import type { Screen } from "./types";

export type ArchivedScreen = Screen & {
  archivedAt?: string;
  archivedReason?: string;
};

export async function archivedScreens(): Promise<{
  items: ArchivedScreen[];
  total: number;
}> {
  const result = await apiGet("/api/v1/screens/archive");
  return {
    items: (Array.isArray(result.items) ? result.items : []).map(
      (screen) => normalizeScreen(screen) as ArchivedScreen,
    ),
    total: result.total ?? 0,
  };
}
