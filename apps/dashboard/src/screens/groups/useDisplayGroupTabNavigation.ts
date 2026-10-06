import { useCallback, useState } from "react";
import { useSearchParams } from "react-router";
import {
  groupDetailTabs,
  normalizeGroupDetailTab,
  type GroupDetailTab,
} from "./displayGroupModel";

/** Tabs that can hold work the person has not saved. */
export type DirtySection = "display" | "policy";

const sectionTab: Record<DirtySection, GroupDetailTab> = {
  display: "display",
  policy: "policy",
};

/**
 * URL-backed tab selection with one discard guard. A section reports whether
 * it holds unsaved work; leaving its tab then waits for the person to keep
 * editing or discard. Only the visible tab can be dirty, because the others
 * are not mounted.
 */
export function useDisplayGroupTabNavigation() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = normalizeGroupDetailTab(searchParams.get("tab"));
  const [dirty, setDirty] = useState<Record<DirtySection, boolean>>({
    display: false,
    policy: false,
  });
  const [pending, setPending] = useState<GroupDetailTab | null>(null);

  const reportDisplayDirty = useCallback(
    (value: boolean) => setDirty((current) => ({ ...current, display: value })),
    [],
  );
  const reportPolicyDirty = useCallback(
    (value: boolean) => setDirty((current) => ({ ...current, policy: value })),
    [],
  );

  const dirtySection: DirtySection | null =
    (["display", "policy"] as const).find(
      (section) => sectionTab[section] === tab && dirty[section],
    ) ?? null;

  const commit = (destination: GroupDetailTab) => {
    const next = new URLSearchParams(searchParams);
    if (destination === "overview") next.delete("tab");
    else next.set("tab", destination);
    setSearchParams(next);
    setPending(null);
    setDirty({ display: false, policy: false });
  };

  const selectTab = (requested: string) => {
    if (!groupDetailTabs.includes(requested as GroupDetailTab)) return;
    if (requested === tab) return;
    if (dirtySection) {
      setPending(requested as GroupDetailTab);
      return;
    }
    commit(requested as GroupDetailTab);
  };

  return {
    tab,
    selectTab,
    reportDisplayDirty,
    reportPolicyDirty,
    /** For the "Unsaved" badge on the Player policy tab. */
    policyUnsaved: dirty.policy,
    /** The section whose discard prompt is showing, if any. */
    promptSection: pending ? dirtySection : null,
    keepEditing: () => setPending(null),
    discard: () => {
      if (pending) commit(pending);
    },
  };
}
