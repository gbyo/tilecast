import { useCallback, useEffect, useRef } from "react";
import { useNativeHost } from "./NativeHostProvider";
import type {
  ActionMenuDescriptor,
  ActionMenuGroup as WireGroup,
} from "./protocol";

/** One action Studio offers. The callback never crosses the bridge. */
export type NativeMenuAction = {
  /** Stable within one menu. Never derived from the label. */
  id: string;
  /** Already localized. */
  label: string;
  /** Semantic icon token. Advisory; unknown tokens show no icon. */
  icon?: string;
  disabled?: boolean;
  role?: "default" | "destructive";
  onSelect: () => void;
};

export type NativeMenuGroup = {
  actions: NativeMenuAction[];
};

export type NativeActionMenuResult =
  /** The host cannot show a menu: Studio shows its own web menu. */
  | { outcome: "unavailable" }
  /** The user dismissed the native menu without choosing. */
  | { outcome: "dismissed" }
  /** The user chose an action. */
  | { outcome: "action"; actionId: string };

type PendingAction = { disabled: boolean; onSelect: () => void };

type PendingMenu = {
  actions: Map<string, PendingAction>;
  settle: (actionId: string | null) => void;
};

/** A fresh opaque menu id. getRandomValues also works on plain HTTP. */
function newMenuId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `m-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Empty groups disappear; callbacks stay in Studio. */
function toDescriptor(menuId: string, label: string, groups: NativeMenuGroup[]) {
  const wire: WireGroup[] = [];
  const actions = new Map<string, PendingAction>();
  for (const group of groups) {
    const items: ActionMenuDescriptor["groups"][number]["items"] = [];
    for (const action of group.actions) {
      items.push({
        id: action.id,
        label: action.label,
        ...(action.icon === undefined ? {} : { icon: action.icon }),
        ...(action.disabled === undefined
          ? {}
          : { disabled: action.disabled }),
        ...(action.role === undefined || action.role === "default"
          ? {}
          : { role: action.role }),
      });
      actions.set(action.id, {
        disabled: action.disabled === true,
        onSelect: action.onSelect,
      });
    }
    if (items.length > 0) wire.push({ items });
  }
  return { descriptor: { menuId, label, groups: wire }, actions };
}

/**
 * Shows a native action menu when the host offers one. Studio keeps the
 * callbacks; the host renders a generic descriptor and reports the chosen
 * opaque action id.
 *
 * present shows a menu at once and resolves with what happened: the
 * chosen action (whose callback has already run), a dismissal, or
 * unavailable, in which case the caller shows its own web menu, which
 * stays the permanent browser path.
 *
 * arm stores a menu for a long press and returns a disarm function, or
 * null when there is no native menu to arm. The returned disarm tells the
 * host to forget the menu; a choice from a menu a long press already
 * built still reaches its callback, because the host answers from what
 * it shows. Each arm supersedes the previous one from this hook.
 *
 * If the component unmounts first, owned menus are withdrawn and a
 * pending present resolves as dismissed. A late response for a menu this
 * hook no longer owns does nothing, so a response for menu A can never
 * execute an action from menu B.
 */
export function useNativeActionMenu() {
  const host = useNativeHost();
  const hostRef = useRef(host);
  hostRef.current = host;
  const pending = useRef(new Map<string, PendingMenu>());
  const armed = useRef<string | null>(null);
  const available = host.status === "ready" && host.capabilities.nativeActionMenus;

  useEffect(() => {
    if (!available) return;
    const unsubscribeAction = host.subscribe(
      "action-menu/action",
      ({ menuId, actionId }) => {
        const entry = pending.current.get(menuId);
        const action = entry?.actions.get(actionId);
        if (!entry || !action || action.disabled) return false;
        pending.current.delete(menuId);
        if (armed.current === menuId) armed.current = null;
        entry.settle(actionId);
        return true;
      },
    );
    const unsubscribeDismissed = host.subscribe(
      "action-menu/dismissed",
      ({ menuId }) => {
        const entry = pending.current.get(menuId);
        if (!entry) return false;
        pending.current.delete(menuId);
        if (armed.current === menuId) armed.current = null;
        entry.settle(null);
        return true;
      },
    );
    return () => {
      unsubscribeAction();
      unsubscribeDismissed();
    };
  }, [available, host]);

  useEffect(() => {
    const owned = pending.current;
    return () => {
      for (const [menuId, entry] of owned) {
        void hostRef.current.send("action-menu/disarm", { menuId });
        entry.settle(null);
      }
      owned.clear();
      armed.current = null;
    };
  }, []);

  const present = useCallback(
    async (
      label: string,
      groups: NativeMenuGroup[],
    ): Promise<NativeActionMenuResult> => {
      const current = hostRef.current;
      const menuId = newMenuId();
      const { descriptor, actions } = toDescriptor(menuId, label, groups);
      if (descriptor.groups.length === 0) return { outcome: "unavailable" };
      if (current.status !== "ready" || !current.capabilities.nativeActionMenus) {
        return { outcome: "unavailable" };
      }
      const decided = new Promise<string | null>((resolve) => {
        pending.current.set(menuId, {
          actions,
          settle: (actionId) => {
            if (actionId !== null) actions.get(actionId)?.onSelect();
            resolve(actionId);
          },
        });
      });
      const reply = await current.send("action-menu/present", descriptor);
      if (reply?.ok !== true) {
        pending.current.delete(menuId);
        return { outcome: "unavailable" };
      }
      const actionId = await decided;
      return actionId === null
        ? { outcome: "dismissed" }
        : { outcome: "action", actionId };
    },
    [],
  );

  const arm = useCallback(
    (label: string, groups: NativeMenuGroup[]): (() => void) | null => {
      const current = hostRef.current;
      if (current.status !== "ready" || !current.capabilities.nativeActionMenus) {
        return null;
      }
      if (armed.current !== null) {
        const previous = armed.current;
        armed.current = null;
        pending.current.delete(previous);
        void current.send("action-menu/disarm", { menuId: previous });
      }
      const menuId = newMenuId();
      const { descriptor, actions } = toDescriptor(menuId, label, groups);
      if (descriptor.groups.length === 0) return null;
      pending.current.set(menuId, {
        actions,
        settle: (actionId) => {
          if (actionId !== null) actions.get(actionId)?.onSelect();
        },
      });
      armed.current = menuId;
      void current
        .send("action-menu/arm", descriptor)
        .then((reply) => {
          if (reply?.ok !== true && armed.current === menuId) {
            armed.current = null;
            pending.current.delete(menuId);
          }
        })
        .catch(() => {
          if (armed.current === menuId) {
            armed.current = null;
            pending.current.delete(menuId);
          }
        });
      return () => {
        if (armed.current !== menuId) return;
        armed.current = null;
        // The entry stays: a choice from a menu a long press already
        // built still counts. A newer arm, an answer, or unmount clears
        // it, and the host never reports a menu it does not show.
        void hostRef.current.send("action-menu/disarm", { menuId });
      };
    },
    [],
  );

  return { present, arm };
}
