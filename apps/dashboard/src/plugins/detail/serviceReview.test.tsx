// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "../../i18n";
import type { PackageServiceGrant } from "../../api/types";
import { CapabilitiesSection } from "./DetailSections";
import {
  diffCapabilities,
  serviceAccess,
  type PluginDetailViewModel,
} from "./detailView";

afterEach(cleanup);

const read = (
  id: string,
  version: number,
  contexts: string[],
): PackageServiceGrant => ({
  id,
  version,
  name: version === 2 ? "Content library (version 2)" : "Content library",
  description: "Read the content library.",
  category: "read",
  contexts,
  operations: [
    {
      name: `${id}@${version}/playlists.list`,
      title: "List playlists",
      description: "List playlists.",
      mutating: false,
      contexts,
    },
  ],
});

const v1 = read("content.read", 1, ["studio", "background"]);
const v2 = read("content.read", 2, ["studio", "background", "system"]);
const studioOnly = {
  ...read("targets.resolve", 2, ["studio"]),
  name: "Resolve display targets",
};

describe("service review", () => {
  it("says when a grant works while the plugin runs automatically", () => {
    expect(serviceAccess(v2)).toEqual({
      studio: true,
      background: true,
      system: true,
      unattended: true,
    });
    expect(serviceAccess(studioOnly)?.unattended).toBe(false);
    expect(
      serviceAccess({ ...v2, contexts: undefined, operations: [] }),
    ).toBeNull();
  });

  it("treats content.read@1 to content.read@2 as a permission change", () => {
    const { added, removed, changed } = diffCapabilities(
      { services: [v1] },
      { services: [v2] },
    );
    expect(removed).toEqual([{ kind: "service", grant: v1 }]);
    expect(added).toEqual([{ kind: "service", grant: v2 }]);
    expect(changed).toEqual([]);
  });

  it("renders an included plugin's declared services with where they run", () => {
    const view = {
      sourceKind: "included",
      plugin: { capabilities: [], services: [v2, studioOnly] },
    } as unknown as PluginDetailViewModel;
    render(
      <CapabilitiesSection
        view={view}
        capabilities={undefined}
        loading={false}
      />,
    );
    expect(screen.getByText("Content library (version 2)")).toBeInTheDocument();
    expect(
      screen.getByText(/Can read this while the plugin runs automatically/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Runs in: Studio · Background jobs · System callbacks"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Only while a signed-in person uses it in Studio/),
    ).toBeInTheDocument();
    expect(screen.getByText("Runs in: Studio")).toBeInTheDocument();
    expect(screen.queryByText(/admin/i)).toBeNull();
  });

  it("keeps saying an included plugin without permissions has none", () => {
    const view = {
      sourceKind: "included",
      plugin: { capabilities: [], services: [] },
    } as unknown as PluginDetailViewModel;
    render(
      <CapabilitiesSection
        view={view}
        capabilities={undefined}
        loading={false}
      />,
    );
    expect(screen.getByText(/doesn't request/)).toBeInTheDocument();
  });
});
