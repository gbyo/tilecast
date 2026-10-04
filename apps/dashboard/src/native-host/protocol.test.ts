import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import corpus from "@tilecast/native-bridge-schema/fixtures/messages-v1.json";
import iconTokens from "@tilecast/native-bridge-schema/icon-tokens.json";
import schema from "@tilecast/native-bridge-schema/schema-v1.json";
import { navigationIcons } from "@/navigation/NavigationIcon";
import {
  decodeHostConfig,
  decodeNativeMessage,
  decodeNativeReply,
  frontendMessage,
  hapticFeedbacks,
  isDeepLinkPath,
  isHapticFeedback,
  isPresentationPath,
  isStudioPath,
  studioCapabilities,
  validateSystemShare,
} from "./protocol";

type FixtureCase = {
  name: string;
  direction: "frontendToNative" | "nativeToFrontend" | "reply";
  outcome: "accept" | "malformed" | "unknownType" | "unsupportedVersion";
  schemaValid?: boolean;
  studioEncodes?: string;
  hostContext?: string | null;
  hostCapabilities?: Record<string, boolean>;
  hapticFeedback?: string | null;
  share?: { title: string | null; text: string | null; url: string | null };
  message: unknown;
};

const cases = corpus.cases as FixtureCase[];
// strictTypes would demand a type beside every conditional subschema.
const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
ajv.addSchema(schema);
const validator = (definition: string) => {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${definition}`);
  if (!validate) throw new Error(`schema has no ${definition}`);
  return (value: unknown) => validate(value) as boolean;
};
const valid = {
  frontendToNative: validator("frontendToNative"),
  nativeToFrontend: validator("nativeToFrontend"),
  reply: validator("reply"),
};
const envelope = validator("envelope");
const versionProbe = validator("versionProbe");

describe("the shared native bridge fixtures", () => {
  it("covers every direction and outcome", () => {
    const seen = new Set(cases.map((entry) => entry.direction + entry.outcome));
    for (const direction of ["frontendToNative", "nativeToFrontend", "reply"]) {
      for (const outcome of ["accept", "malformed", "unsupportedVersion"]) {
        expect(seen, `${direction} ${outcome}`).toContain(direction + outcome);
      }
    }
    expect(seen).toContain("frontendToNativeunknownType");
    expect(seen).toContain("nativeToFrontendunknownType");
  });

  // The JSON Schema and the corpus must agree, so the schema stays the
  // portable definition for implementations in other languages.
  it.each(cases.map((entry) => [entry.name, entry] as const))(
    "schema agrees: %s",
    (_, entry) => {
      const known = valid[entry.direction](entry.message);
      switch (entry.outcome) {
        case "accept":
          expect(known).toBe(true);
          break;
        case "malformed":
          expect(known).toBe(entry.schemaValid === true);
          break;
        case "unknownType":
          expect(envelope(entry.message)).toBe(true);
          expect(known).toBe(false);
          break;
        case "unsupportedVersion":
          expect(versionProbe(entry.message)).toBe(true);
          expect(known).toBe(false);
          break;
      }
    },
  );

  const studioDecodes = cases.filter(
    (entry) => entry.direction !== "frontendToNative",
  );
  it.each(studioDecodes.map((entry) => [entry.name, entry] as const))(
    "Studio decodes: %s",
    (_, entry) => {
      const decode =
        entry.direction === "reply" ? decodeNativeReply : decodeNativeMessage;
      expect(decode(entry.message).outcome).toBe(entry.outcome);
    },
  );

  const configReplies = cases.filter((entry) => "hostContext" in entry);
  it.each(configReplies.map((entry) => [entry.name, entry] as const))(
    "Studio reads the bridge context: %s",
    (_, entry) => {
      const reply = decodeNativeReply(entry.message);
      if (reply.outcome !== "accept" || !reply.message.ok) {
        throw new Error("expected a successful reply");
      }
      expect(decodeHostConfig(reply.message.payload)?.context ?? null).toBe(
        entry.hostContext,
      );
    },
  );
});

describe("system messages Studio sends", () => {
  const sends = (type: string) =>
    cases.filter(
      (entry) =>
        entry.direction === "frontendToNative" &&
        (entry.message as { type?: string } | null)?.type === type,
    );
  const payloadOf = (entry: FixtureCase) =>
    (entry.message as { payload: Record<string, unknown> }).payload;

  // Studio validates what it sends with the same rules the host applies, so
  // it never sends a request a host would refuse.
  it.each(sends("system/haptic").map((entry) => [entry.name, entry] as const))(
    "haptic: %s",
    (_, entry) => {
      const known = isHapticFeedback(payloadOf(entry).feedback);
      expect(known).toBe(
        typeof entry.hapticFeedback === "string" &&
          hapticFeedbacks.includes(
            entry.hapticFeedback as (typeof hapticFeedbacks)[number],
          ),
      );
    },
  );

  it.each(sends("system/share").map((entry) => [entry.name, entry] as const))(
    "share: %s",
    (_, entry) => {
      const validated = validateSystemShare(payloadOf(entry));
      if (entry.outcome === "accept") {
        expect(validated).not.toBeNull();
        expect(validated?.url ?? null).toBe(entry.share?.url);
        expect(validated?.text ?? null).toBe(entry.share?.text);
        expect(validated?.title ?? null).toBe(entry.share?.title);
      } else {
        expect(validated).toBeNull();
      }
    },
  );

  it("reads what a host offers from its config/get reply", () => {
    const replies = cases.filter((entry) => entry.hostCapabilities);
    expect(replies.length).toBeGreaterThan(0);
    for (const entry of replies) {
      const reply = decodeNativeReply(entry.message);
      if (reply.outcome !== "accept" || !reply.message.ok) {
        throw new Error("expected a successful reply");
      }
      expect(
        decodeHostConfig(reply.message.payload)?.capabilities,
        entry.name,
      ).toMatchObject(entry.hostCapabilities!);
    }
  });

  it("lists a semantic vocabulary and no page-specific effect", () => {
    expect([...hapticFeedbacks]).toEqual([
      "selection",
      "success",
      "warning",
      "error",
      "start",
      "stop",
    ]);
  });
});

describe("deep link paths", () => {
  const paths = corpus.deepLinkPaths as { accept: string[]; refuse: string[] };
  it.each(paths.accept)("accepts %j", (path) => {
    expect(isDeepLinkPath(path)).toBe(true);
  });
  it.each(paths.refuse)("refuses %j", (path) => {
    expect(isDeepLinkPath(path)).toBe(false);
  });
});

const presentationId = "p-4f1c2a9e-6b1d-4c1e-8f7a-2d3e4b5c6d7e";

describe("messages Studio sends", () => {
  // Studio's encoder must match the corpus exactly, so a native decoder,
  // tested against the same cases, accepts what Studio sends.
  const goldens: Record<string, unknown> = {
    frontendReady: frontendMessage("frontend/ready", {
      capabilities: studioCapabilities,
    }),
    signedOut: frontendMessage("auth/signed-out", {}),
    presentationOpen: frontendMessage("presentation/open", {
      presentationId,
      path: "/__native/modal/live-stream/screen-1",
      title: "Live stream · Lobby",
      subtitle: "Lobby",
      size: "full",
      dismissible: true,
    }),
    presentationReady: frontendMessage("presentation/ready", {}),
    alertPresent: frontendMessage("alert/present", {
      alertId: "a-4f1c2a9e-6b1d-4c1e-8f7a-2d3e4b5c6d7e",
      title: "Delete this schedule?",
      message: "Screens stop following it at once.",
      actions: [
        { id: "cancel", label: "Cancel", role: "cancel" },
        { id: "confirm", label: "Delete", role: "destructive" },
      ],
    }),
    navigationChrome: frontendMessage("navigation/chrome", {
      title: "Lobby north",
      back: { label: "Fleet" },
    }),
    alertCancel: frontendMessage("alert/cancel", {
      alertId: "a-4f1c2a9e-6b1d-4c1e-8f7a-2d3e4b5c6d7e",
    }),
    presentationUpdate: frontendMessage("presentation/update", {
      presentationId,
      header: {
        title: "Lobby",
        subtitle: "Screen",
        navigation: "close",
        navigationLabel: "Close",
        actions: [{ id: "refresh", label: "Refresh", icon: "activity" }],
        menuLabel: "More",
        menu: [
          { id: "open-screen", label: "Open screen", icon: "screens" },
          { id: "history", label: "History", disabled: true },
        ],
      },
      size: "full",
      dismissible: true,
    }),
    presentationClose: frontendMessage("presentation/close", {
      presentationId,
    }),
    hapticSuccess: frontendMessage("system/haptic", { feedback: "success" }),
    shareUrl: frontendMessage("system/share", {
      title: "Lobby display",
      url: "https://signage.example.org/preview/lobby",
    }),
    mediaIntake: frontendMessage("system/media-intake", {
      requestId: "mi-7c1e2a94-3b6d-4c1e-8f7a-2d3e4b5c6d7e",
      accept: ["image", "video"],
      multiple: true,
    }),
    scanQr: frontendMessage("system/scan-qr", {
      requestId: "qr-7c1e2a94-3b6d-4c1e-8f7a-2d3e4b5c6d7e",
    }),
    presentationNavigate: frontendMessage("presentation/navigate", {
      presentationId,
      path: "/screens/screen-1?tab=activity",
    }),
  };
  const encoded = cases.filter((entry) => entry.studioEncodes !== undefined);
  it.each(encoded.map((entry) => [entry.name, entry] as const))(
    "encodes like the corpus: %s",
    (_, entry) => {
      expect(goldens[entry.studioEncodes!]).toEqual(entry.message);
    },
  );
  it("has a corpus case for every message it encodes", () => {
    expect(new Set(encoded.map((entry) => entry.studioEncodes))).toEqual(
      new Set(Object.keys(goldens)),
    );
  });

  it("builds valid version 1 envelopes", () => {
    const messages = [
      frontendMessage("config/get", {}),
      frontendMessage("frontend/ready", {}, "ready-1"),
      frontendMessage("frontend/ready", { capabilities: studioCapabilities }),
      frontendMessage("auth/signed-out", {}),
      frontendMessage("navigation/state", {
        activeDestinationId: null,
        path: "/account",
      }),
      frontendMessage("navigation/catalog", {
        groups: [
          {
            id: "operations",
            title: "Operations",
            items: [
              {
                id: "room-bookings",
                title: "Room Bookings",
                icon: "door-calendar",
                mobilePlacement: "more",
              },
            ],
          },
        ],
      }),
    ];
    for (const message of messages) {
      expect(valid.frontendToNative(message), message.type).toBe(true);
    }
  });

  it("reads capabilities, treating anything but true as unavailable", () => {
    expect(
      decodeHostConfig({
        protocolVersion: 1,
        capabilities: { nativeNavigation: true, nativeShare: true },
      }),
    ).toEqual({
      context: "main",
      capabilities: {
        nativeNavigation: true,
        authLifecycle: false,
        nativePresentations: false,
        systemShare: false,
        systemHaptics: false,
        systemQrScanner: false,
        nativeMediaIntake: false,
        deepLinks: false,
        nativeAlerts: false,
      },
    });
    expect(
      decodeHostConfig({
        protocolVersion: 1,
        context: "presentation",
        capabilities: {
          nativeNavigation: "yes",
          authLifecycle: true,
          nativePresentations: 1,
          systemHaptics: true,
          systemShare: "true",
          nativeAlerts: "true",
        },
      }),
    ).toEqual({
      context: "presentation",
      capabilities: {
        nativeNavigation: false,
        authLifecycle: true,
        nativePresentations: false,
        systemShare: false,
        systemHaptics: true,
        systemQrScanner: false,
        nativeMediaIntake: false,
        deepLinks: false,
        nativeAlerts: false,
      },
    });
    expect(decodeHostConfig({ capabilities: {} })).toBeNull();
    expect(decodeHostConfig({ protocolVersion: 1 })).toBeNull();
    expect(
      decodeHostConfig({ protocolVersion: 1, context: 7, capabilities: {} }),
    ).toBeNull();
  });
});

describe("navigation icon tokens", () => {
  it("maps every token hosts recognize to a Lucide icon", () => {
    for (const token of iconTokens.tokens) {
      expect(Object.hasOwn(navigationIcons, token), token).toBe(true);
    }
  });
});

describe("presentation paths", () => {
  it.each([
    "/__native/modal",
    "/__native/modal/live-stream/screen-1",
    "/__native/modal/fixture?step=2#top",
  ])("accepts %s inside the presentation tree", (path) => {
    expect(isPresentationPath(path)).toBe(true);
    expect(isStudioPath(path)).toBe(false);
  });

  it.each([
    "",
    "/__native/modals",
    "/__native",
    "/screens/screen-1",
    "__native/modal",
    "//evil.example/__native/modal",
    "https://evil.example/__native/modal",
    "javascript:alert(1)",
    "/__native/modal/../screens",
    "/__native/modal/%2E%2e/screens",
    "/__native/modal/%2e",
    "/__native/modal/\\evil.example",
    "/__native/modal/a b",
    "/__native/modal/\u0000",
    `/__native/modal/${"a".repeat(1010)}`,
  ])("refuses %j as a presentation path", (path) => {
    expect(isPresentationPath(path)).toBe(false);
  });

  it.each(["/", "/screens/screen-1?tab=activity", "/settings/general#x"])(
    "accepts %s as a Studio path",
    (path) => {
      expect(isStudioPath(path)).toBe(true);
    },
  );

  it.each([
    "screens",
    "//evil.example",
    "/\\evil.example",
    "https://evil.example/",
    "javascript:alert(1)",
    "/screens/../../settings",
    "/__native/modal",
    "/__native/other",
    "/screens?a=1 b",
  ])("refuses %j as a Studio path", (path) => {
    expect(isStudioPath(path)).toBe(false);
  });
});
