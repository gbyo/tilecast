import * as React from "react";

const DESKTOP_BREAKPOINT = 1024;

// useDesktopLayout reports whether the viewport is wide enough for the
// multi-pane editor layouts (playlist, layout, and form builders). Editors
// render exactly one branch — the Resizable desktop panes or the
// stacked/Sheet narrow fallback — so control ids are never duplicated.
export function useDesktopLayout() {
  const [desktop, setDesktop] = React.useState<boolean>(false);

  React.useEffect(() => {
    const query = window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT}px)`);
    const onChange = () => {
      setDesktop(query.matches);
    };
    query.addEventListener("change", onChange);
    setDesktop(query.matches);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return desktop;
}
