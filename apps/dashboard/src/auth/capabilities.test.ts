import { describe, expect, it } from "vitest";
import {
  capabilitiesFrom,
  capabilityKeys,
  capabilitySet,
  hasCapability,
  requirementMet,
} from "./capabilities";
import { authStatusFor, builtinCapabilities } from "../test/capabilities";
import builtin from "../test/builtin-capabilities.json";

describe("capabilities", () => {
  it("reads authority from the reported capabilities, never from a role name", () => {
    // A custom role that happens to be called "owner" of nothing: the name
    // grants no authority, and "viewer" with extra capabilities gets them.
    const named = authStatusFor("owner", ["media.read"]);
    expect(hasCapability(named, "media.read")).toBe(true);
    expect(hasCapability(named, "users.manage")).toBe(false);

    const custom = authStatusFor("front_office", [
      "media.read",
      "playlist.read",
    ]);
    expect(capabilitiesFrom(custom).can("playlist.read")).toBe(true);
    expect(capabilitiesFrom(custom).can("playlist.edit")).toBe(false);
  });

  it("grants nothing to a signed-out or incomplete status", () => {
    expect(capabilitySet(undefined).size).toBe(0);
    expect(
      capabilitySet({ authenticated: false, setupRequired: false }).size,
    ).toBe(0);
    expect(
      capabilitySet({
        authenticated: false,
        setupRequired: false,
        capabilities: ["media.read"],
      }).size,
    ).toBe(0);
    expect(
      capabilitiesFrom({ authenticated: true, setupRequired: false }).can(
        "media.read",
      ),
    ).toBe(false);
  });

  it("treats only the built-in Owner as the Owner for identity checks", () => {
    expect(capabilitiesFrom(authStatusFor("owner")).isOwner).toBe(true);
    expect(capabilitiesFrom(authStatusFor("administrator")).isOwner).toBe(
      false,
    );
    expect(capabilitiesFrom(authStatusFor("classroom_media", [])).isOwner).toBe(
      false,
    );
  });

  it("needs every requirement group, and any capability inside a group", () => {
    const media = capabilitiesFrom(
      authStatusFor("classroom_media", ["media.read", "media.upload"]),
    );
    expect(requirementMet([], media)).toBe(true);
    expect(requirementMet([["media.read"]], media)).toBe(true);
    expect(requirementMet([["playlist.read", "media.read"]], media)).toBe(true);
    expect(requirementMet([["playlist.read"]], media)).toBe(false);
    // A child route never escapes its parent's requirement.
    expect(
      requirementMet([["media.read"], ["media.folders.manage"]], media),
    ).toBe(false);
    expect(requirementMet([[], ["media.read"]], media)).toBe(true);
  });

  it("only names capabilities the built-in roles can hold", () => {
    const known = new Set<string>(capabilityKeys);
    for (const granted of Object.values(builtin)) {
      for (const capability of granted) {
        expect(known.has(capability), capability).toBe(true);
      }
    }
  });

  it("keeps the built-in roles' authority ordered", () => {
    const owner = new Set(builtinCapabilities("owner"));
    const administrator = new Set(builtinCapabilities("administrator"));
    const editor = new Set(builtinCapabilities("editor"));
    const contributor = new Set(builtinCapabilities("contributor"));
    const viewer = new Set(builtinCapabilities("viewer"));
    const within = (small: Set<string>, large: Set<string>) =>
      [...small].every((capability) => large.has(capability));
    expect(within(administrator, owner)).toBe(true);
    expect(within(editor, administrator)).toBe(true);
    expect(within(viewer, editor)).toBe(true);
    // A Viewer reads and opens plugin pages, which every signed-in account
    // could always do, but changes nothing.
    expect(
      [...viewer].filter((capability) => !capability.endsWith(".read")),
    ).toEqual(["plugins.use"]);
    // A Contributor drafts content but cannot publish, review, or delete it.
    expect(contributor.has("playlist.edit")).toBe(true);
    expect(contributor.has("playlist.publish")).toBe(false);
    expect(contributor.has("content.review")).toBe(false);
    expect(contributor.has("media.delete")).toBe(false);
    expect(contributor.has("screen.manage")).toBe(false);
    expect(builtinCapabilities("not-a-role")).toEqual([]);
  });
});
