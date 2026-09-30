import { createContext, useContext, useEffect, useRef } from "react";
import type {
  PresentationHeader,
  PresentationSize,
} from "@/native-host/protocol";

/**
 * What a route below /__native/modal can ask of the native presentation that
 * shows it. Every operation is generic: the app never learns what the
 * presentation is.
 */
export type NativePresentation = {
  presentationId: string;
  /** Replaces the native chrome. A header is always a complete snapshot. */
  update(chrome: PresentationChrome): void;
  /** Dismisses the native sheet. */
  close(): void;
  /** Dismisses the sheet, then the main Studio page navigates to path. */
  navigate(path: string): void;
  /** Receives native header actions; returns an unsubscribe function. */
  onAction(handler: (actionId: string) => void): () => void;
  /** A dialog inside the presentation needs the whole sheet. */
  requestFullSize(): void;
};

export type PresentationChrome = {
  header?: PresentationHeader;
  size?: PresentationSize;
  dismissible?: boolean;
};

export const NativePresentationContext =
  createContext<NativePresentation | null>(null);

/** The presentation showing this route, or null outside one. */
export function useNativePresentation() {
  return useContext(NativePresentationContext);
}

/**
 * Describes the native chrome of the presentation showing this route. It
 * sends a new snapshot whenever the description changes, and hands header
 * action ids to onAction. Inert outside a presentation.
 */
export function usePresentationChrome(
  chrome: PresentationChrome,
  onAction?: (actionId: string) => void,
) {
  const presentation = useNativePresentation();
  const json = JSON.stringify(chrome);
  const handler = useRef(onAction);
  handler.current = onAction;

  useEffect(() => {
    presentation?.update(JSON.parse(json) as PresentationChrome);
  }, [presentation, json]);

  useEffect(
    () => presentation?.onAction((actionId) => handler.current?.(actionId)),
    [presentation],
  );
}

/**
 * Rendered inside Studio's dialog popups, which mount only while a dialog
 * is open. A dialog inside a compact presentation would be clipped, so the
 * sheet grows to full height. Presentations do not stack native sheets; the
 * dialog renders in the presentation page, as in a browser.
 */
export function GrowNativePresentation() {
  const presentation = useNativePresentation();
  useEffect(() => {
    presentation?.requestFullSize();
  }, [presentation]);
  return null;
}
