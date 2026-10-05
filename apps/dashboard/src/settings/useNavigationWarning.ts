import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useBlocker, useNavigate } from "react-router";
import { useConfirm } from "../components/ConfirmDialog";

export type NavigationLocation = {
  pathname: string;
  search: string;
  hash: string;
};

/**
 * Shared unsaved-changes policy: in-app departures from dirty state confirm
 * through one modal dialog, and closing or reloading the browser keeps the
 * native beforeunload warning. `useBlocker` stays authoritative for in-app
 * navigation; link clicks are intercepted first because a native confirm
 * cannot wait for the dialog, then replayed when the user confirms.
 *
 * Destination control is either a path prefix (warn unless the destination
 * starts with it) or a live `shouldBlock` predicate over current and next
 * locations. The predicate runs on every navigation, so it can consult refs
 * for intentional departures such as a post-save redirect.
 */
export function useNavigationWarning({
  dirty,
  title,
  body,
  allowPrefix,
  shouldBlock,
}: {
  dirty: boolean;
  title: string;
  body?: string;
  /** Warn unless the destination starts with this prefix. Ignored when shouldBlock is given. */
  allowPrefix?: string;
  /** Full control over which destinations warn; evaluated live on every navigation. */
  shouldBlock?: (
    current: NavigationLocation,
    next: NavigationLocation,
  ) => boolean;
}) {
  const { t } = useTranslation("common");
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();
  const discardAction = t("actions.discardChanges");
  // Set while a confirmed link replays, so the blocker below lets it pass.
  const confirmed = useRef(false);
  const latest = useRef({ dirty, allowPrefix, shouldBlock });
  latest.current = { dirty, allowPrefix, shouldBlock };

  const warnsFor = (current: NavigationLocation, next: NavigationLocation) => {
    const state = latest.current;
    if (!state.dirty || confirmed.current) return false;
    if (state.shouldBlock) return state.shouldBlock(current, next);
    if (state.allowPrefix !== undefined)
      return !next.pathname.startsWith(state.allowPrefix);
    return true;
  };
  const warnsRef = useRef(warnsFor);
  warnsRef.current = warnsFor;

  // Navigation that does not start from a link click, such as a native
  // host's navigation request or the command palette, reaches React Router
  // directly; the blocker gives it the same confirmation.
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    warnsRef.current(currentLocation, nextLocation),
  );
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;
  const asking = useRef(false);

  useEffect(() => {
    if (blocker.state !== "blocked" || asking.current) return;
    asking.current = true;
    void confirm({ title, body, action: discardAction }).then((ok) => {
      asking.current = false;
      const current = blockerRef.current;
      if (current.state !== "blocked") return;
      if (ok) current.proceed();
      else current.reset();
    });
  }, [blocker.state, body, confirm, discardAction, title]);

  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (latest.current.dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    // A native confirm cannot wait for a dialog, so the click is stopped
    // first and the navigation only replays when the user confirms it.
    const click = (event: MouseEvent) => {
      if (!latest.current.dirty || event.defaultPrevented) return;
      const link = (event.target as Element | null)?.closest("a");
      const href = link?.getAttribute("href");
      if (!link || !href) return;

      // Links that leave this page open do not discard the unsaved state.
      // Preserve their native behavior instead of warning or replaying them.
      const target = link.getAttribute("target");
      if (
        link.hasAttribute("download") ||
        (target !== null && target !== "_self") ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      const url = new URL(link.href, window.location.href);
      if (
        !warnsRef.current(window.location, {
          pathname: url.pathname,
          search: url.search,
          hash: url.hash,
        })
      ) {
        return;
      }
      event.preventDefault();
      void confirm({ title, body, action: discardAction }).then((ok) => {
        if (!ok) return;
        if (
          url.origin === window.location.origin &&
          (url.protocol === "http:" || url.protocol === "https:")
        ) {
          confirmed.current = true;
          void Promise.resolve(
            navigate(`${url.pathname}${url.search}${url.hash}`),
          ).finally(() => {
            confirmed.current = false;
          });
        } else {
          window.location.assign(link.href);
        }
      });
    };
    addEventListener("beforeunload", unload);
    document.addEventListener("click", click, true);
    return () => {
      removeEventListener("beforeunload", unload);
      document.removeEventListener("click", click, true);
    };
  }, [body, confirm, discardAction, navigate, title]);

  return dialog;
}
