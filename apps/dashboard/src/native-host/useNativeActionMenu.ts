import { useCallback, useEffect, useRef } from "react";
import { useNativeHost } from "./NativeHostProvider";
import type {
  ActionMenuDescriptor,
  ActionMenuGroup as WireGroup,
  ActionMenuTriggerRect,
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
  | { outcome: "unavailable" }
  | { outcome: "dismissed" }
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
function toDescriptor(
  menuId: string,
  label: string,
  groups: NativeMenuGroup[],
) {
  const wire: WireGroup[] = [];
  const actions = new Map<string, PendingAction>();
  for (const group of groups) {
    const items: ActionMenuDescriptor["groups"][number]["items"] = [];
    for (const action of group.actions) {
      items.push({
        id: action.id,
        label: action.label,
        ...(action.icon === undefined ? {} : { icon: action.icon }),
        ...(action.disabled === undefined ? {} : { disabled: action.disabled }),
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

const rounded = (value: number) => Math.round(value * 10_000) / 10_000;

/** Visible part of an element, normalized to the current visual viewport. */
function normalizedTriggerRect(element: HTMLElement): ActionMenuTriggerRect | null {
  const bounds = element.getBoundingClientRect();
  const viewport = window.visualViewport;
  const viewportLeft = viewport?.offsetLeft ?? 0;
  const viewportTop = viewport?.offsetTop ?? 0;
  const viewportWidth = viewport?.width ?? window.innerWidth;
  const viewportHeight = viewport?.height ?? window.innerHeight;
  if (viewportWidth <= 0 || viewportHeight <= 0) return null;

  const left = Math.max(bounds.left, viewportLeft);
  const top = Math.max(bounds.top, viewportTop);
  const right = Math.min(bounds.right, viewportLeft + viewportWidth);
  const bottom = Math.min(bounds.bottom, viewportTop + viewportHeight);
  if (right <= left || bottom <= top) return null;

  return {
    x: rounded((left - viewportLeft) / viewportWidth),
    y: rounded((top - viewportTop) / viewportHeight),
    width: rounded((right - left) / viewportWidth),
    height: rounded((bottom - top) / viewportHeight),
  };
}

/**
 * Owns native action menus for one Studio component. Callbacks always stay
 * in React; the host sees only generic menu descriptors and opaque ids.
 */
export function useNativeActionMenu() {
  const host = useNativeHost();
  const hostRef = useRef(host);
  hostRef.current = host;
  const pending = useRef(new Map<string, PendingMenu>());
  const triggerActions = useRef(new Map<string, Map<string, PendingAction>>());
  const armed = useRef<string | null>(null);
  const available =
    host.status === "ready" && host.capabilities.nativeActionMenus;

  useEffect(() => {
    if (!available) return;
    const unsubscribeAction = host.subscribe(
      "action-menu/action",
      ({ menuId, actionId }) => {
        const entry = pending.current.get(menuId);
        const pendingAction = entry?.actions.get(actionId);
        if (entry && pendingAction && !pendingAction.disabled) {
          pending.current.delete(menuId);
          if (armed.current === menuId) armed.current = null;
          entry.settle(actionId);
          return true;
        }

        const registered = triggerActions.current.get(menuId);
        const triggerAction = registered?.get(actionId);
        if (!triggerAction || triggerAction.disabled) return false;
        triggerAction.onSelect();
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
    const triggers = triggerActions.current;
    return () => {
      for (const [menuId, entry] of owned) {
        void hostRef.current.send("action-menu/disarm", { menuId });
        entry.settle(null);
      }
      for (const menuId of triggers.keys()) {
        void hostRef.current.send("action-menu/unregister-trigger", { menuId });
      }
      owned.clear();
      triggers.clear();
      armed.current = null;
    };
  }, []);

  /**
   * Legacy immediate presentation. New Tilecast iOS hosts intentionally
   * refuse this so Studio falls back to its web dropdown; anchored triggers
   * use registerTrigger instead.
   */
  const present = useCallback(
    async (
      label: string,
      groups: NativeMenuGroup[],
    ): Promise<NativeActionMenuResult> => {
      const current = hostRef.current;
      const menuId = newMenuId();
      const { descriptor, actions } = toDescriptor(menuId, label, groups);
      if (descriptor.groups.length === 0) return { outcome: "unavailable" };
      if (
        current.status !== "ready" ||
        !current.capabilities.nativeActionMenus
      ) {
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
      if (
        current.status !== "ready" ||
        !current.capabilities.nativeActionMenus
      ) {
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
        void hostRef.current.send("action-menu/disarm", { menuId });
      };
    },
    [],
  );

  /**
   * Registers an HTML action trigger as an invisible native Menu anchor.
   * Only the trigger's visible viewport rectangle crosses the bridge. The
   * HTML button remains the visual source, while SwiftUI owns hit testing
   * and native menu presentation inside that rectangle.
   */
  const registerTrigger = useCallback(
    (
      label: string,
      groups: NativeMenuGroup[],
      element: HTMLElement,
    ): (() => void) | null => {
      const current = hostRef.current;
      if (
        current.status !== "ready" ||
        !current.capabilities.nativeActionMenuAnchors
      ) {
        return null;
      }
      const menuId = newMenuId();
      const { descriptor, actions } = toDescriptor(menuId, label, groups);
      if (descriptor.groups.length === 0) return null;
      triggerActions.current.set(menuId, actions);

      let registered = false;
      let lastPayload = "";
      let frame: number | null = null;

      const publish = () => {
        frame = null;
        const rect = normalizedTriggerRect(element);
        if (!rect) {
          if (registered) {
            registered = false;
            lastPayload = "";
            void hostRef.current.send("action-menu/unregister-trigger", {
              menuId,
            });
          }
          return;
        }
        const payload = { ...descriptor, rect };
        const serialized = JSON.stringify(payload);
        if (serialized === lastPayload) return;
        lastPayload = serialized;
        registered = true;
        void hostRef.current.send("action-menu/register-trigger", payload);
      };

      const schedule = () => {
        if (frame !== null) return;
        frame = window.requestAnimationFrame(publish);
      };

      const resize = new ResizeObserver(schedule);
      resize.observe(element);
      const intersection = new IntersectionObserver(schedule);
      intersection.observe(element);
      window.addEventListener("scroll", schedule, { capture: true, passive: true });
      window.addEventListener("resize", schedule, { passive: true });
      window.visualViewport?.addEventListener("scroll", schedule, {
        passive: true,
      });
      window.visualViewport?.addEventListener("resize", schedule, {
        passive: true,
      });
      publish();

      return () => {
        if (frame !== null) window.cancelAnimationFrame(frame);
        resize.disconnect();
        intersection.disconnect();
        window.removeEventListener("scroll", schedule, { capture: true });
        window.removeEventListener("resize", schedule);
        window.visualViewport?.removeEventListener("scroll", schedule);
        window.visualViewport?.removeEventListener("resize", schedule);
        triggerActions.current.delete(menuId);
        if (registered) {
          void hostRef.current.send("action-menu/unregister-trigger", {
            menuId,
          });
        }
      };
    },
    [],
  );

  return { present, arm, registerTrigger };
}
