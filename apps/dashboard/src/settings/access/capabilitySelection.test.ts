import { describe, expect, it } from "vitest";
import type { CapabilityDefinition } from "../../api/types";
import {
  canSelect,
  capabilityGroupOf,
  grantableSubset,
  groupCatalog,
  toggleCapability,
} from "./capabilitySelection";

const definition = (
  key: string,
  group: CapabilityDefinition["group"],
  extra: Partial<CapabilityDefinition> = {},
): CapabilityDefinition => ({
  key,
  group,
  requires: [],
  ownerReserved: false,
  delegable: true,
  grantable: true,
  ...extra,
});

const catalog: CapabilityDefinition[] = [
  definition("media.read", "media"),
  definition("media.upload", "media", { requires: ["media.read"] }),
  definition("media.edit", "media", { requires: ["media.read"] }),
  definition("media.tags.assign", "media", { requires: ["media.read"] }),
  definition("playlist.read", "playlists"),
  definition("playlist.edit", "playlists", { requires: ["playlist.read"] }),
  definition("users.manage", "administration", {
    requires: ["media.read"],
    delegable: false,
    grantable: false,
  }),
  definition("system.backups", "administration", {
    ownerReserved: true,
    delegable: false,
    grantable: false,
  }),
];

describe("role capability selection", () => {
  it("turns on what a capability requires", () => {
    const next = toggleCapability(
      catalog,
      new Set(),
      "media.tags.assign",
      true,
    );
    expect([...next].sort()).toEqual(["media.read", "media.tags.assign"]);
  });

  it("turns off everything that depends on a capability", () => {
    const start = new Set(["media.read", "media.upload", "playlist.read"]);
    const next = toggleCapability(catalog, start, "media.read", false);
    expect([...next]).toEqual(["playlist.read"]);
  });

  it("keeps the selection consistent through any sequence of toggles", () => {
    let selected = new Set<string>();
    for (const [key, on] of [
      ["media.upload", true],
      ["media.edit", true],
      ["media.read", false],
      ["media.edit", true],
      ["playlist.edit", true],
      ["playlist.read", false],
    ] as const) {
      selected = toggleCapability(catalog, selected, key, on);
      for (const held of selected) {
        const required = catalog.find((item) => item.key === held)!.requires;
        for (const need of required) expect(selected.has(need)).toBe(true);
      }
    }
  });

  it("does not mutate the selection it was given", () => {
    const start = new Set(["media.read"]);
    toggleCapability(catalog, start, "media.upload", true);
    expect([...start]).toEqual(["media.read"]);
  });

  it("cannot select what the signed-in account cannot grant", () => {
    expect(canSelect(catalog, "media.upload")).toBe(true);
    expect(canSelect(catalog, "users.manage")).toBe(false);
    expect(canSelect(catalog, "system.backups")).toBe(false);
    expect(canSelect(catalog, "unknown.thing")).toBe(false);
  });

  it("cannot select a capability that pulls in one that is not grantable", () => {
    const withLockedRequirement = [
      definition("a.read", "media", { grantable: false }),
      definition("a.edit", "media", { requires: ["a.read"] }),
    ];
    expect(canSelect(withLockedRequirement, "a.edit")).toBe(false);
  });

  it("copies only the grantable part of another role", () => {
    const copied = grantableSubset(catalog, [
      "media.read",
      "media.upload",
      "users.manage",
      "system.backups",
    ]);
    expect([...copied].sort()).toEqual(["media.read", "media.upload"]);
  });

  it("groups the catalog in the editor's order and drops empty groups", () => {
    expect(groupCatalog(catalog).map((entry) => entry.group)).toEqual([
      "media",
      "playlists",
      "administration",
    ]);
  });

  it("maps a capability key to its area for summaries", () => {
    expect(capabilityGroupOf("media.tags.assign")).toBe("media");
    expect(capabilityGroupOf("datasource.edit")).toBe("dataSources");
    expect(capabilityGroupOf("content.review")).toBe("review");
    expect(capabilityGroupOf("roles.manage")).toBe("administration");
  });
});
