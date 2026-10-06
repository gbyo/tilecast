/**
 * Editor-local identity for the rows of a list control (a repeating group
 * or a string list).
 *
 * Saved configuration holds plain arrays, so rows have no identity of their
 * own. React still needs one to keep an Accordion item's open state, an
 * input's focus, and its caret with the right row when another row is added
 * or removed. These ids exist only in the editor session: they are never
 * part of the draft, never saved, and never compared.
 *
 * Rows are added and removed through this hook so the ids move with them.
 * A list replaced from outside (Discard) arrives with a new epoch and gets
 * fresh ids; a list that merely changes length is resized to fit.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

/** Changes when the draft is replaced wholesale, so row ids start over. */
export const RowIdentityEpoch = createContext(0);

let issued = 0;
const issueRowId = () => `row-${++issued}`;

const createRowIds = (length: number) =>
  Array.from({ length }, issueRowId) as readonly string[];

function fitRowIds(ids: readonly string[], length: number) {
  if (ids.length >= length) return ids.slice(0, length);
  return [...ids, ...createRowIds(length - ids.length)];
}

export function useStableRowIds(length: number) {
  const epoch = useContext(RowIdentityEpoch);
  const [state, setState] = useState(() => ({
    epoch,
    ids: createRowIds(length),
  }));
  let ids = state.ids;
  // Adjusting state while rendering is React's pattern for state derived
  // from props: the component re-renders at once, before anything commits.
  if (state.epoch !== epoch || ids.length !== length) {
    ids = state.epoch !== epoch ? createRowIds(length) : fitRowIds(ids, length);
    setState({ epoch, ids });
  }
  const append = useCallback(() => {
    const id = issueRowId();
    setState((current) => ({ ...current, ids: [...current.ids, id] }));
    return id;
  }, []);
  const removeAt = useCallback(
    (index: number) =>
      setState((current) => ({
        ...current,
        ids: current.ids.filter((_, position) => position !== index),
      })),
    [],
  );
  return { ids, append, removeAt };
}

/**
 * Move keyboard focus to an element once the next render has committed it,
 * for when the control that had focus just disappeared (a removed row) or a
 * new row should be ready to type in.
 */
export function useDeferredFocus() {
  const [target, setTarget] = useState<{ id: string } | null>(null);
  useEffect(() => {
    if (target) document.getElementById(target.id)?.focus();
  }, [target]);
  return useCallback((id: string) => setTarget({ id }), []);
}
