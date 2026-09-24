import {
  CalendarClock,
  Database,
  FileImage,
  LayoutTemplate,
  ListVideo,
  Megaphone,
  Monitor,
  Users,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";
import type { DependencyNodeType } from "../api/types";

export type DependencyStageId = "sources" | "presentations" | "delivery";

/**
 * The three delivery stages, in the order content flows through them. Every
 * resource type belongs to exactly one stage; the order of `types` is the
 * order a stage lists its types in.
 */
export const dependencyStages: readonly {
  id: DependencyStageId;
  types: readonly DependencyNodeType[];
}[] = [
  { id: "sources", types: ["data_source", "widget", "asset"] },
  { id: "presentations", types: ["layout", "playlist", "campaign"] },
  { id: "delivery", types: ["schedule", "screen_group", "screen"] },
];

export const typeOrder: readonly DependencyNodeType[] =
  dependencyStages.flatMap((stage) => stage.types);

const typeRank = new Map(typeOrder.map((type, index) => [type, index]));

export function compareTypes(
  left: DependencyNodeType,
  right: DependencyNodeType,
) {
  return (typeRank.get(left) ?? 0) - (typeRank.get(right) ?? 0);
}

export function isDependencyNodeType(
  value: string,
): value is DependencyNodeType {
  return typeRank.has(value as DependencyNodeType);
}

// Labels translate at render; the type values matched against the API
// (data_source, screen_group, …) are never translated.
export const typePresentation = {
  data_source: {
    labelKey: "graph.kinds.dataSource",
    pluralKey: "graph.kinds.dataSources",
    countKey: "graph.counts.dataSource",
    viewKey: "graph.fanout.view.dataSource",
    icon: Database,
    path: (id: string) => `/data-sources/${id}`,
  },
  asset: {
    labelKey: "graph.kinds.media",
    pluralKey: "graph.kinds.mediaPlural",
    countKey: "graph.counts.media",
    viewKey: "graph.fanout.view.media",
    icon: FileImage,
    path: () => "/assets",
  },
  widget: {
    labelKey: "graph.kinds.widget",
    pluralKey: "graph.kinds.widgets",
    countKey: "graph.counts.widget",
    viewKey: "graph.fanout.view.widget",
    icon: WandSparkles,
    path: (id: string) => `/widgets/${id}`,
  },
  layout: {
    labelKey: "graph.kinds.layout",
    pluralKey: "graph.kinds.layouts",
    countKey: "graph.counts.layout",
    viewKey: "graph.fanout.view.layout",
    icon: LayoutTemplate,
    path: (id: string) => `/layouts/${id}`,
  },
  playlist: {
    labelKey: "graph.kinds.playlist",
    pluralKey: "graph.kinds.playlists",
    countKey: "graph.counts.playlist",
    viewKey: "graph.fanout.view.playlist",
    icon: ListVideo,
    path: (id: string) => `/playlists/${id}`,
  },
  campaign: {
    labelKey: "graph.kinds.campaign",
    pluralKey: "graph.kinds.campaigns",
    countKey: "graph.counts.campaign",
    viewKey: "graph.fanout.view.campaign",
    icon: Megaphone,
    path: (id: string) => `/campaigns/${id}`,
  },
  schedule: {
    labelKey: "graph.kinds.schedule",
    pluralKey: "graph.kinds.schedules",
    countKey: "graph.counts.schedule",
    viewKey: "graph.fanout.view.schedule",
    icon: CalendarClock,
    path: (id: string) => `/schedules/${id}`,
  },
  screen_group: {
    labelKey: "graph.kinds.screenGroup",
    pluralKey: "graph.kinds.screenGroups",
    countKey: "graph.counts.screenGroup",
    viewKey: "graph.fanout.view.screenGroup",
    icon: Users,
    path: (id: string) => `/groups/${id}`,
  },
  screen: {
    labelKey: "graph.kinds.screen",
    pluralKey: "graph.kinds.screens",
    countKey: "graph.counts.screen",
    viewKey: "graph.fanout.view.screen",
    icon: Monitor,
    path: (id: string) => `/screens/${id}`,
  },
} as const satisfies Record<
  DependencyNodeType,
  {
    labelKey: string;
    pluralKey: string;
    countKey: string;
    viewKey: string;
    icon: LucideIcon;
    path: (id: string) => string;
  }
>;

/**
 * The server sends each relationship as a fixed English phrase. These are
 * the phrases it can send; anything else is shown as received.
 */
const relationshipKeys = {
  // i18n-ignore: server relationship values, matched and never displayed
  "provides data to": "graph.relationships.providesDataTo",
  "included in": "graph.relationships.includedIn",
  "used by": "graph.relationships.usedBy",
  "materialized as": "graph.relationships.materializedAs",
  "scheduled by": "graph.relationships.scheduledBy",
  "assigned to": "graph.relationships.assignedTo",
  targets: "graph.relationships.targets",
  contains: "graph.relationships.contains",
} as const;

export type RelationshipKey =
  (typeof relationshipKeys)[keyof typeof relationshipKeys];

export function relationshipKey(relationship: string) {
  return Object.hasOwn(relationshipKeys, relationship)
    ? relationshipKeys[relationship as keyof typeof relationshipKeys]
    : undefined;
}
