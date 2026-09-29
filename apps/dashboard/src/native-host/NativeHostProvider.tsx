import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createNativeBridge,
  tilecastNativeHandler,
  type NativeBridge,
} from "./bridge";
import {
  decodeCapabilities,
  decodeNativeMessage,
  noNativeCapabilities,
  NATIVE_RECEIVER_NAME,
  studioCapabilities,
  type FrontendToNativePayloads,
  type FrontendToNativeType,
  type NativeCapabilities,
  type NativeReply,
  type NativeToFrontendPayloads,
  type NativeToFrontendType,
} from "./protocol";

/**
 * unavailable: an ordinary browser, or a host that failed negotiation.
 * negotiating: a Tilecast host exists and has not answered config/get yet.
 * ready: the host answered; its capabilities are known.
 */
export type NativeHostStatus = "unavailable" | "negotiating" | "ready";

type NativeMessageHandler<Type extends NativeToFrontendType> = (
  payload: NativeToFrontendPayloads[Type],
) => boolean;

export type NativeHost = {
  status: NativeHostStatus;
  capabilities: NativeCapabilities;
  /** Resolves with the reply, or null when there is no usable host. */
  send<Type extends FrontendToNativeType>(
    type: Type,
    payload: FrontendToNativePayloads[Type],
  ): Promise<NativeReply | null>;
  /** Receives one native message type; returns an unsubscribe function. */
  subscribe<Type extends NativeToFrontendType>(
    type: Type,
    handler: NativeMessageHandler<Type>,
  ): () => void;
};

const browserHost: NativeHost = {
  status: "unavailable",
  capabilities: noNativeCapabilities,
  send: () => Promise.resolve(null),
  subscribe: () => () => undefined,
};

const NativeHostContext = createContext<NativeHost>(browserHost);

async function negotiate(bridge: NativeBridge) {
  try {
    const reply = await bridge.send("config/get", {});
    return reply.ok ? decodeCapabilities(reply.payload) : null;
  } catch {
    return null;
  }
}

/**
 * Detects the Tilecast native host and negotiates its capabilities. In an
 * ordinary browser this is inert: no message is sent, and every capability
 * is false from the first render. Negotiation never blocks Studio; a host
 * that fails or does not answer leaves Studio exactly as a browser sees it.
 */
export function NativeHostProvider({ children }: { children: ReactNode }) {
  const [bridge] = useState(() => {
    const handler = tilecastNativeHandler();
    return handler ? createNativeBridge(handler) : null;
  });
  const [negotiated, setNegotiated] = useState<{
    status: NativeHostStatus;
    capabilities: NativeCapabilities;
  }>(() => ({
    status: bridge ? "negotiating" : "unavailable",
    capabilities: noNativeCapabilities,
  }));
  const subscribers = useRef(
    new Map<
      NativeToFrontendType,
      Set<NativeMessageHandler<NativeToFrontendType>>
    >(),
  );

  // The one receiver the host calls. It accepts only valid version 1
  // messages that some part of Studio is listening for.
  useEffect(() => {
    if (!bridge) return;
    const receive = (message: unknown) => {
      const decoded = decodeNativeMessage(message);
      if (decoded.outcome !== "accept") return false;
      let handled = false;
      for (const handler of subscribers.current.get(decoded.message.type) ??
        []) {
        handled =
          (handler as (payload: unknown) => boolean)(decoded.message.payload) ||
          handled;
      }
      return handled;
    };
    window[NATIVE_RECEIVER_NAME] = receive;
    return () => {
      if (window[NATIVE_RECEIVER_NAME] === receive) {
        delete window[NATIVE_RECEIVER_NAME];
      }
    };
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    let current = true;
    void negotiate(bridge).then((capabilities) => {
      if (!current) return;
      setNegotiated(
        capabilities
          ? { status: "ready", capabilities }
          : { status: "unavailable", capabilities: noNativeCapabilities },
      );
      // The host treats ready as idempotent, so a remount may repeat it.
      // It carries what this Studio supports, so a host never sends a
      // message an older Studio would not understand.
      if (capabilities) {
        void bridge
          .send("frontend/ready", { capabilities: studioCapabilities })
          .catch(() => {});
      }
    });
    return () => {
      current = false;
    };
  }, [bridge]);

  const send = useCallback<NativeHost["send"]>(
    async (type, payload) => {
      if (!bridge || negotiated.status !== "ready") return null;
      try {
        return await bridge.send(type, payload);
      } catch {
        return null;
      }
    },
    [bridge, negotiated.status],
  );

  const subscribe = useCallback<NativeHost["subscribe"]>((type, handler) => {
    const handlers = subscribers.current.get(type) ?? new Set();
    const erased = handler as NativeMessageHandler<NativeToFrontendType>;
    handlers.add(erased);
    subscribers.current.set(type, handlers);
    return () => handlers.delete(erased);
  }, []);

  const host = useMemo<NativeHost>(
    () => (bridge ? { ...negotiated, send, subscribe } : browserHost),
    [bridge, negotiated, send, subscribe],
  );

  return (
    <NativeHostContext.Provider value={host}>
      {children}
    </NativeHostContext.Provider>
  );
}

export function useNativeHost(): NativeHost {
  return useContext(NativeHostContext);
}
