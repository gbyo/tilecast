/**
 * What the preview pane says about the preview. A healthy preview says
 * nothing: the Widget itself is the status.
 */
export type PreviewStatus =
  | { readonly kind: "ready" }
  | { readonly kind: "loading" }
  | { readonly kind: "waiting" }
  | { readonly kind: "empty"; readonly message: string }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly detail?: string;
    }
  | {
      /** No live preview is possible here; the pane explains why. */
      readonly kind: "unavailable";
      readonly message: string;
    };
