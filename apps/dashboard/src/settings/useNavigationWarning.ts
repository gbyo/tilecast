import { useEffect, useRef } from "react";
import { useBlocker, useNavigate } from "react-router";
import { useConfirm } from "../components/ConfirmDialog";

export function useNavigationWarning(
  dirty: boolean,
  allowPrefix: string,
  message: string,
) {
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();
  // Set while a confirmed link replays, so the blocker below lets it pass.
  const confirmed = useRef(false);
  // Navigation that does not start from a link click, such as a native
  // host's navigation request or the command palette, reaches React Router
  // directly; the blocker gives it the same confirmation.
  const blocker = useBlocker(
    ({ nextLocation }) =>
      dirty &&
      !confirmed.current &&
      !nextLocation.pathname.startsWith(allowPrefix),
  );
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;
  const asking = useRef(false);

  useEffect(() => {
    if (blocker.state !== "blocked" || asking.current) return;
    asking.current = true;
    void confirm({ title: message, action: "Discard changes" }).then((ok) => {
      asking.current = false;
      const current = blockerRef.current;
      if (current.state !== "blocked") return;
      if (ok) current.proceed();
      else current.reset();
    });
  }, [blocker.state, confirm, message]);

  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    // A native confirm cannot wait for a dialog, so the click is stopped
    // first and the navigation only replays when the user confirms it.
    const click = (event: MouseEvent) => {
      if (!dirty || event.defaultPrevented) return;
      const link = (event.target as Element | null)?.closest("a");
      const href = link?.getAttribute("href");
      if (!link || !href || href.startsWith(allowPrefix)) return;

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

      event.preventDefault();
      void confirm({ title: message, action: "Discard changes" }).then((ok) => {
        if (!ok) return;
        const url = new URL(link.href, window.location.href);
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
  }, [allowPrefix, confirm, dirty, message, navigate]);

  return dialog;
}
