import { useEffect } from "react";
import { useNavigate } from "react-router";
import { useConfirm } from "../components/ConfirmDialog";

export function useNavigationWarning(
  dirty: boolean,
  allowPrefix: string,
  message: string,
) {
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();

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
      )
        return;

      event.preventDefault();
      void confirm({ title: message, action: "Discard changes" }).then(
        (ok) => {
          if (!ok) return;
          const url = new URL(link.href, window.location.href);
          if (
            url.origin === window.location.origin &&
            (url.protocol === "http:" || url.protocol === "https:")
          ) {
            void navigate(`${url.pathname}${url.search}${url.hash}`);
          } else {
            window.location.assign(link.href);
          }
        },
      );
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
