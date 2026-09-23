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
      if (link && href && !href.startsWith(allowPrefix)) {
        event.preventDefault();
        void confirm({ title: message, action: "Discard changes" }).then(
          (ok) => {
            if (!ok) return;
            if (/^https?:\/\//.test(href)) window.location.assign(href);
            else void navigate(href);
          },
        );
      }
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
