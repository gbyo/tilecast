import {
  decodeNativeReply,
  frontendMessage,
  NATIVE_HANDLER_NAME,
  type FrontendToNativePayloads,
  type FrontendToNativeType,
  type NativeReply,
} from "./protocol";

type ScriptMessageHandler = { postMessage(message: unknown): unknown };

declare global {
  interface Window {
    webkit?: { messageHandlers?: Record<string, unknown> };
    tilecastNativeReceiver?: (message: unknown) => boolean;
  }
}

/**
 * The Tilecast native host's message handler, when this page runs inside
 * one. Only the exact Tilecast handler counts: another WebKit host, or
 * Safari itself, is an ordinary browser.
 */
export function tilecastNativeHandler(): ScriptMessageHandler | null {
  const handler: unknown =
    window.webkit?.messageHandlers?.[NATIVE_HANDLER_NAME];
  if (
    typeof handler === "object" &&
    handler !== null &&
    typeof (handler as ScriptMessageHandler).postMessage === "function"
  ) {
    return handler as ScriptMessageHandler;
  }
  return null;
}

export class NativeBridgeError extends Error {}

export type NativeBridge = {
  /**
   * Sends one message and resolves with the host's decoded reply. Rejects
   * when the host does not answer in time or answers outside protocol
   * version 1.
   */
  send<Type extends FrontendToNativeType>(
    type: Type,
    payload: FrontendToNativePayloads[Type],
  ): Promise<NativeReply>;
};

const replyTimeoutMs = 3_000;

export function createNativeBridge(
  handler: ScriptMessageHandler,
  timeoutMs = replyTimeoutMs,
): NativeBridge {
  return {
    async send(type, payload) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new NativeBridgeError(`${type}: no reply`)),
          timeoutMs,
        );
      });
      try {
        const raw = await Promise.race([
          Promise.resolve(handler.postMessage(frontendMessage(type, payload))),
          timeout,
        ]);
        const decoded = decodeNativeReply(raw);
        if (decoded.outcome !== "accept") {
          throw new NativeBridgeError(`${type}: ${decoded.outcome} reply`);
        }
        return decoded.message;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
