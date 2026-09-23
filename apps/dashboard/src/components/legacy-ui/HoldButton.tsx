import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";

/* A button that only fires after the pointer (or the keyboard) has been held
   down for a while, filling left to right as it counts up. It exists for the
   handful of actions that are both fleet-wide and immediate, where a single
   click is too cheap for what it does. The fill is the whole feedback: the
   person can see how much longer they have to commit, and letting go early
   cancels with nothing sent. */
export function HoldButton({
  holdMs = 3000,
  onHoldComplete,
  children,
  holdingLabel,
  hint,
  className = "",
  disabled,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  /** How long the button must be held, in milliseconds. */
  holdMs?: number;
  onHoldComplete: () => void;
  /** Label shown while the hold is in progress. Defaults to `children`. */
  holdingLabel?: ReactNode;
  /** Instruction rendered beneath the button and used as its description. */
  hint?: ReactNode;
}) {
  const [progress, setProgress] = useState(0);
  const [holding, setHolding] = useState(false);
  const frame = useRef<number | null>(null);
  const hintId = useId();

  const stop = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    setHolding(false);
    setProgress(0);
  }, []);

  // A hold in flight when the button unmounts (the dialog closes under it, say)
  // must not leave its frame loop running.
  useEffect(() => stop, [stop]);

  const start = useCallback(() => {
    if (disabled || frame.current !== null) return;
    const started = performance.now();
    setHolding(true);
    setProgress(0);
    const tick = () => {
      const ratio = Math.min(1, (performance.now() - started) / holdMs);
      setProgress(ratio);
      if (ratio < 1) {
        frame.current = requestAnimationFrame(tick);
        return;
      }
      frame.current = null;
      setHolding(false);
      setProgress(0);
      onHoldComplete();
    };
    frame.current = requestAnimationFrame(tick);
  }, [disabled, holdMs, onHoldComplete]);

  return (
    <div className="hold-button-wrap">
      <button
        {...props}
        type="button"
        className={`button hold-button ${className}`.trim()}
        disabled={disabled}
        aria-describedby={hint ? hintId : props["aria-describedby"]}
        onPointerDown={(event) => {
          // Only a primary press counts; a right-click should not start
          // counting toward a fleet-wide action.
          if (event.button !== 0) return;
          start();
        }}
        onPointerUp={stop}
        onPointerCancel={stop}
        onPointerLeave={stop}
        onBlur={stop}
        onKeyDown={(event) => {
          if (event.key !== " " && event.key !== "Enter") return;
          // Key repeat fires continuously while held; the first one starts the
          // count and the rest are already covered by it.
          event.preventDefault();
          start();
        }}
        onKeyUp={(event) => {
          if (event.key === " " || event.key === "Enter") stop();
        }}
      >
        <span
          className="hold-button__fill"
          style={{ transform: `scaleX(${progress})` }}
          aria-hidden="true"
        />
        <span className="hold-button__label">
          {holding && holdingLabel ? holdingLabel : children}
        </span>
      </button>
      {hint && (
        <p className="hold-button__hint" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  );
}
