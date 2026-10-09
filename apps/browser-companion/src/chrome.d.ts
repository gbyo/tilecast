/**
 * Minimal MV3 ambient surface: only what the Companion uses. A narrow
 * hand declaration beats a dependency for an extension this small, and
 * it keeps the generic chrome.* surface out of reach by construction.
 */

declare namespace chrome {
  namespace storage {
    interface Local {
      get(keys: string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string[]): Promise<void>;
    }
    const local: Local;
  }

  namespace runtime {
    interface MessageSender {
      tab?: tabs.Tab;
      url?: string;
      origin?: string;
    }
    type MessageListener = (
      message: unknown,
      sender: MessageSender,
      sendResponse: (response: unknown) => void,
    ) => boolean | void;
    const onMessage: { addListener(listener: MessageListener): void };
    const lastError: { message?: string } | undefined;
    function sendMessage(message: unknown): Promise<unknown>;
    function getManifest(): { version: string };
  }

  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      active?: boolean;
    }
    function query(query: {
      active?: boolean;
      currentWindow?: boolean;
    }): Promise<Tab[]>;
  }

  namespace permissions {
    function request(permissions: { origins?: string[] }): Promise<boolean>;
    function contains(permissions: { origins?: string[] }): Promise<boolean>;
    function remove(permissions: { origins?: string[] }): Promise<boolean>;
  }

  namespace scripting {
    interface RegisteredContentScript {
      id: string;
      matches: string[];
      js?: string[];
      runAt?: "document_start";
      world?: "ISOLATED";
      allFrames?: boolean;
    }
    function registerContentScripts(
      scripts: RegisteredContentScript[],
    ): Promise<void>;
    function unregisterContentScripts(options?: {
      ids?: string[];
    }): Promise<void>;
    function getRegisteredContentScripts(options?: {
      ids?: string[];
    }): Promise<RegisteredContentScript[]>;
  }

  namespace action {
    function setTitle(options: { title: string }): void;
  }
}
