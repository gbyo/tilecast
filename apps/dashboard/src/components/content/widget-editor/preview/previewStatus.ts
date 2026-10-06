/**
 * What the preview pane says about the preview. A healthy preview says
 * nothing: the Widget itself is the status.
 */
import type { TFunction } from "i18next";
import type { WidgetMountState } from "@tilecast/widget-sdk/mount";

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

type ContentT = TFunction<"content">;

/** The status of a component preview, most urgent condition first. */
export function componentPreviewStatus(
  input: {
    ready: boolean;
    sourcesFailed: boolean;
    sourcesLoading: boolean;
    compileProblem?: string;
    mount: WidgetMountState;
  },
  t: ContentT,
): PreviewStatus {
  const { mount } = input;
  if (!input.ready) return { kind: "loading" };
  if (input.sourcesFailed)
    return { kind: "error", message: t("widgets.editor.preview.sourceFailed") };
  if (input.compileProblem)
    return {
      kind: "error",
      message: t("widgets.editor.preview.configurationProblem"),
      detail: input.compileProblem,
    };
  if (input.sourcesLoading) return { kind: "waiting" };
  if (mount.state === "error")
    return {
      kind: "error",
      message: t("widgets.editor.preview.renderFailed"),
      detail: mount.code,
    };
  if (mount.state === "empty")
    return {
      kind: "empty",
      message:
        mount.reason === "no_source"
          ? t("widgets.editor.preview.emptyNoSource")
          : t("widgets.editor.preview.empty"),
    };
  if (mount.state === "pending") return { kind: "loading" };
  return { kind: "ready" };
}

/** The status of a web integration preview. */
export function webPreviewStatus(
  input: {
    canCompile: boolean;
    hasAddress: boolean;
    hasSavedThumbnail: boolean;
    isPending: boolean;
    errorDetail?: string;
    hasPresentation: boolean;
  },
  t: ContentT,
): PreviewStatus {
  if (!input.canCompile)
    return input.hasSavedThumbnail
      ? { kind: "ready" }
      : {
          kind: "unavailable",
          message: t("widgets.editor.preview.webViewOnly"),
        };
  if (!input.hasAddress)
    return {
      kind: "unavailable",
      message: t("widgets.editor.preview.webNoAddress"),
    };
  if (input.errorDetail !== undefined)
    return {
      kind: "error",
      message: t("widgets.editor.preview.webInvalid"),
      detail: input.errorDetail,
    };
  if (input.isPending) return { kind: "loading" };
  if (!input.hasPresentation)
    return {
      kind: "unavailable",
      message: t("widgets.editor.preview.webUnavailable"),
    };
  return { kind: "ready" };
}
