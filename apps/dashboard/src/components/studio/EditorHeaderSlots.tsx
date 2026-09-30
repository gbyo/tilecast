import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

type EditorHeaderState = {
  left: HTMLElement | null;
  right: HTMLElement | null;
  setLeft: (element: HTMLElement | null) => void;
  setRight: (element: HTMLElement | null) => void;
  rename: (() => void) | null;
  setRename: (rename: (() => void) | null) => void;
};

const EditorHeaderContext = createContext<EditorHeaderState | null>(null);

/**
 * The Layout editor shares one header with the app shell. The shell renders the
 * frame; the page portals its menubar and actions into the two slots.
 */
export function EditorHeaderProvider({ children }: { children: ReactNode }) {
  const [left, setLeft] = useState<HTMLElement | null>(null);
  const [right, setRight] = useState<HTMLElement | null>(null);
  const [rename, setRename] = useState<(() => void) | null>(null);
  const value = useMemo(
    () => ({ left, right, setLeft, setRight, rename, setRename }),
    [left, right, rename],
  );
  return (
    <EditorHeaderContext.Provider value={value}>
      {children}
    </EditorHeaderContext.Provider>
  );
}

export function useEditorHeaderSlots() {
  return useContext(EditorHeaderContext);
}

/** Registers what the breadcrumb's last item does when it is clicked. */
export function useEditorHeaderRename(rename: () => void) {
  const context = useContext(EditorHeaderContext);
  const setRename = context?.setRename;
  useEffect(() => {
    if (!setRename) return;
    setRename(() => rename);
    return () => setRename(null);
  }, [rename, setRename]);
}

/**
 * Renders into the shell header when there is one. Without a shell (tests,
 * embedding) it draws its own bar so the controls still exist.
 */
export function EditorHeaderPortal({
  left,
  right,
}: {
  left: ReactNode;
  right: ReactNode;
}) {
  const context = useContext(EditorHeaderContext);
  if (!context) {
    return (
      <div className="flex h-13 shrink-0 items-center gap-2 border-b bg-background pr-2.5 pl-3">
        {left}
        <div className="flex-1" />
        {right}
      </div>
    );
  }
  return (
    <>
      {context.left && createPortal(left, context.left)}
      {context.right && createPortal(right, context.right)}
    </>
  );
}
