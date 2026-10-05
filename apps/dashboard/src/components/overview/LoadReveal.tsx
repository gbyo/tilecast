import {
  Children,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "cn";

/**
 * Where a slot is in its first load. `idle` never loaded in this mount, so it
 * is plain content. `instant` and `revealed` both resolved from a skeleton;
 * `instant` skipped the motion.
 */
type Phase = "idle" | "loading" | "exiting" | "revealed" | "instant";

function prefersReducedMotion() {
  if (document.documentElement.dataset.reducedMotion === "true") return true;
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * The hand-off from a skeleton to the data it stood in for. Resolved content
 * fades in with a tiny vertical settle while the skeleton, taken out of flow,
 * fades out over it. It plays once, when a slot that began loading first
 * resolves: a slot that mounts with data, and every later background refetch,
 * renders plain content with no motion. Styles live in styles/load-reveal.css.
 *
 * `deliberate` is for the single element that should read as the page having
 * finished evaluating itself. Everything else uses `standard`.
 *
 * The slot must keep a stable position in its parent's tree, or the remount
 * loses the loading state and the content simply appears. When resolved
 * content is empty, the skeleton is removed at once rather than left fading
 * over whatever now sits below it.
 */
export function LoadReveal({
  loading,
  skeleton,
  variant = "standard",
  className,
  children,
}: {
  loading: boolean;
  skeleton?: ReactNode;
  variant?: "standard" | "deliberate";
  /** Classes for the content layer, such as the grid its children lay out in. */
  className?: string;
  children?: ReactNode;
}) {
  const [stored, setStored] = useState<Phase>(loading ? "loading" : "idle");
  const skeletonLayer = useRef<HTMLDivElement>(null);
  const hasContent = Children.toArray(children).length > 0;

  let phase = stored;
  if (loading && phase !== "loading") {
    phase = "loading";
    setStored(phase);
  } else if (!loading && phase === "loading") {
    phase = hasContent && !prefersReducedMotion() ? "exiting" : "instant";
    setStored(phase);
  }

  const showSkeleton = phase === "loading" || phase === "exiting";
  const exiting = phase === "exiting";
  const showContent = phase !== "loading" && hasContent;

  // The outgoing layer is removed when its fade ends. If no fade is running
  // (the stylesheet did not apply, or reduced motion switched on mid-way) or
  // it is cancelled, nothing would ever end it, so it is removed at once
  // instead of being left in the page.
  useLayoutEffect(() => {
    const layer = skeletonLayer.current;
    if (!exiting || !layer) return;
    const finish = () =>
      setStored((current) => (current === "exiting" ? "revealed" : current));
    if (!layer.getAnimations?.().length) {
      finish();
      return;
    }
    const onEnd = (event: Event) => {
      if (event.target === layer) finish();
    };
    layer.addEventListener("animationend", onEnd);
    layer.addEventListener("animationcancel", onEnd);
    return () => {
      layer.removeEventListener("animationend", onEnd);
      layer.removeEventListener("animationcancel", onEnd);
    };
  }, [exiting]);

  if (!showSkeleton && !showContent) return null;

  return (
    <div
      data-slot="load-reveal"
      data-state={
        phase === "loading" ? "loading" : exiting ? "revealing" : "ready"
      }
      className="relative"
    >
      {showSkeleton && (
        <div
          key="skeleton"
          ref={skeletonLayer}
          aria-hidden={exiting || undefined}
          inert={exiting}
          data-load-reveal-exit={exiting ? "" : undefined}
          className={cn(
            exiting && "pointer-events-none absolute inset-x-0 top-0",
          )}
        >
          {skeleton}
        </div>
      )}
      {showContent && (
        <div
          key="content"
          data-load-reveal={
            phase === "exiting" || phase === "revealed" ? variant : undefined
          }
          className={className}
        >
          {children}
        </div>
      )}
    </div>
  );
}
