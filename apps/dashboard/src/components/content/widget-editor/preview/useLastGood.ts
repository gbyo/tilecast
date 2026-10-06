import { useState } from "react";

/**
 * Remembers the most recent successful value so a transient failure can
 * keep showing it while the problem is reported separately.
 *
 * `candidate` is the outcome of the current attempt: a value when it
 * succeeded, null when it did not. The remembered value changes only on
 * success. Adjusting state while rendering is React's sanctioned way to
 * derive state from a changing input; unlike a ref written during render,
 * React discards it together with any render it abandons.
 */
export function useLastGood<T>(candidate: T | null): T | null {
  const [good, setGood] = useState<T | null>(candidate);
  if (candidate !== null && candidate !== good) setGood(candidate);
  return candidate ?? good;
}
