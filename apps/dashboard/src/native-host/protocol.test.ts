import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import corpus from "@tilecast/native-bridge-schema/fixtures/messages-v1.json";
import iconTokens from "@tilecast/native-bridge-schema/icon-tokens.json";
import schema from "@tilecast/native-bridge-schema/schema-v1.json";
import { navigationIcons } from "@/navigation/NavigationIcon";
import {
  decodeCapabilities,
  decodeNativeMessage,
  decodeNativeReply,
  frontendMessage,
  studioCapabilities,
} from "./protocol";

type FixtureCase = {
  name: string;
  direction: "frontendToNative" | "nativeToFrontend" | "reply";
  outcome: "accept" | "malformed" | "unknownType" | "unsupportedVersion";
  schemaValid?: boolean;
  studioEncodes?: string;
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
});

describe("messages Studio sends", () => {
  // Studio's encoder must match the corpus exactly, so a native decoder,
  // tested against the same cases, accepts what Studio sends.
  const goldens: Record<string, unknown> = {
    frontendReady: frontendMessage("frontend/ready", {
      capabilities: studioCapabilities,
    }),
    signedOut: frontendMessage("auth/signed-out", {}),
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
      decodeCapabilities({
        protocolVersion: 1,
        capabilities: { nativeNavigation: true, nativePresentation: true },
      }),
    ).toEqual({ nativeNavigation: true, authLifecycle: false });
    expect(
      decodeCapabilities({
        protocolVersion: 1,
        capabilities: { nativeNavigation: "yes", authLifecycle: true },
      }),
    ).toEqual({ nativeNavigation: false, authLifecycle: true });
    expect(decodeCapabilities({ capabilities: {} })).toBeNull();
    expect(decodeCapabilities({ protocolVersion: 1 })).toBeNull();
  });
});

describe("navigation icon tokens", () => {
  it("maps every token hosts recognize to a Lucide icon", () => {
    for (const token of iconTokens.tokens) {
      expect(Object.hasOwn(navigationIcons, token), token).toBe(true);
    }
  });
});
