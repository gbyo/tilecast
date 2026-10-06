import { useEffect, useState } from "react";

/**
 * A value that follows its input after the input has stopped changing for
 * `delay` milliseconds. The first value is available immediately, so a screen
 * that opens with a value does not wait to act on it.
 */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
