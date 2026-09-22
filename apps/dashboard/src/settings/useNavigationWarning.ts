import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { useSpectrumDialogs } from "../dialogs/SpectrumDialogs";

export function useNavigationWarning(
  dirty: boolean,
  allowPrefix: string,
  message: string,
) {
  const navigate = useNavigate();
  const { confirm } = useSpectrumDialogs();
  const asking = useRef(false);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const click = (event: MouseEvent) => {
      if (
        !dirty ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) return;
      const link = (event.target as Element | null)?.closest("a");
      const href = link?.href;
      const rawHref = link?.getAttribute("href");
      if (!link || !href || !rawHref || rawHref.startsWith(allowPrefix)) return;
      if (link.target && link.target !== "_self") return;
      event.preventDefault();
      if (asking.current) return;
      asking.current = true;
      void confirm({
        title: "Leave without saving?",
        description: message,
        confirmLabel: "Leave page",
      }).then((approved) => {
        if (!approved) return;
        const target = new URL(href, window.location.href);
        if (target.origin === window.location.origin) {
          navigate(`${target.pathname}${target.search}${target.hash}`);
        } else {
          window.location.assign(target.href);
        }
      }).finally(() => {
        asking.current = false;
      });
    };
    addEventListener("beforeunload", unload);
    document.addEventListener("click", click, true);
    return () => {
      removeEventListener("beforeunload", unload);
      document.removeEventListener("click", click, true);
    };
  }, [dirty, allowPrefix, message, confirm, navigate]);
}
