import { ArrowLeft, ArrowRight, ExternalLink, Network } from "lucide-react";
import { useMemo } from "react";
import { Link, type To } from "react-router";
import { useTranslation } from "react-i18next";
import { cn } from "cn";
import type { DependencyNode, DependencyNodeType } from "../api/types";
import { Badge } from "../components/ui/badge";
import { Button, buttonVariants } from "../components/ui/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../components/ui/item";
import { Separator } from "../components/ui/separator";
import {
  directLinks,
  nodeKey,
  traverse,
  type FanoutGroup,
  type GraphIndex,
  type GraphLink,
  type NodeKey,
  type OverviewGraph,
} from "./graphModel";
import { relationshipKey, typeOrder, typePresentation } from "./resourceTypes";

export type InspectorSubject =
  | { kind: "overview" }
  | { kind: "type"; type: DependencyNodeType }
  | { kind: "resource"; key: NodeKey }
  | { kind: "group"; group: FanoutGroup };

/** Builds the link that makes a resource the root, keeping view options. */
export type NodeHref = (key: NodeKey) => To;
export type TypeHref = (type: DependencyNodeType) => To;

function useRelationshipLabel() {
  const { t } = useTranslation(["content", "common"]);
  return (relationship: string) => {
    const key = relationshipKey(relationship);
    return key ? t(key) : relationship;
  };
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-2">
      <h3 className="flex items-center gap-2 text-[13px] font-semibold">
        {title}
        {count !== undefined && (
          <Badge variant="secondary" className="tabular-nums">
            {count}
          </Badge>
        )}
      </h3>
      {children}
    </section>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function ResourceRow({
  node,
  detail,
  href,
}: {
  node: DependencyNode;
  detail: string;
  href: To;
}) {
  const Icon = typePresentation[node.type].icon;
  return (
    <div role="listitem">
      <Item size="xs" render={<Link to={href} />} className="hover:bg-muted">
        <ItemMedia variant="icon">
          <Icon aria-hidden="true" className="text-muted-foreground" />
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle className="w-full truncate">{node.name}</ItemTitle>
          <ItemDescription className="truncate">{detail}</ItemDescription>
        </ItemContent>
      </Item>
    </div>
  );
}

function RelationshipRows({
  index,
  links,
  side,
  nodeHref,
}: {
  index: GraphIndex;
  links: readonly GraphLink[];
  side: "dependencies" | "consumers";
  nodeHref: NodeHref;
}) {
  const { t } = useTranslation(["content", "common"]);
  const relationshipLabel = useRelationshipLabel();
  if (links.length === 0)
    return (
      <EmptyNote>
        {t(
          side === "dependencies"
            ? "graph.inspector.emptyDependencies"
            : "graph.inspector.emptyConsumers",
        )}
      </EmptyNote>
    );
  return (
    <ItemGroup className="gap-0.5">
      {links.map((link) => {
        const key = side === "dependencies" ? link.from : link.to;
        const node = index.nodesByKey.get(key)!;
        return (
          <ResourceRow
            key={`${key}:${link.relationship}`}
            node={node}
            href={nodeHref(key)}
            detail={`${t(typePresentation[node.type].labelKey)} · ${relationshipLabel(link.relationship)}`}
          />
        );
      })}
    </ItemGroup>
  );
}

function Heading({
  type,
  title,
  action,
}: {
  type?: DependencyNodeType;
  title: string;
  action?: React.ReactNode;
}) {
  const { t } = useTranslation(["content", "common"]);
  const Icon = type ? typePresentation[type].icon : Network;
  return (
    <header className="grid gap-3">
      <div className="grid gap-1">
        {type && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Icon aria-hidden="true" className="size-3.5" />
            {t(typePresentation[type].labelKey)}
          </p>
        )}
        <h2 className="text-base font-semibold break-words">{title}</h2>
      </div>
      {action}
    </header>
  );
}

function ResourceInspector({
  index,
  resourceKey,
  nodeHref,
}: {
  index: GraphIndex;
  resourceKey: NodeKey;
  nodeHref: NodeHref;
}) {
  const { t } = useTranslation(["content", "common"]);
  const node = index.nodesByKey.get(resourceKey)!;
  const direct = useMemo(
    () => directLinks(index, resourceKey),
    [index, resourceKey],
  );
  const totals = useMemo(
    () => ({
      dependencies: traverse(index, resourceKey, "dependencies").size,
      consumers: traverse(index, resourceKey, "consumers").size,
    }),
    [index, resourceKey],
  );
  return (
    <>
      <Heading
        type={node.type}
        title={node.name}
        action={
          <Link
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              "w-fit",
            )}
            to={typePresentation[node.type].path(node.id)}
          >
            {t("graph.inspector.open")}
            <ExternalLink aria-hidden="true" />
          </Link>
        }
      />
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        {(
          [
            ["graph.inspector.allDependencies", totals.dependencies],
            ["graph.inspector.allConsumers", totals.consumers],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="grid gap-0.5">
            <dt className="text-xs text-muted-foreground">{t(label)}</dt>
            <dd className="font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <Separator />
      <Section
        title={t("graph.inspector.directDependencies")}
        count={direct.dependencies.length}
      >
        <RelationshipRows
          index={index}
          links={direct.dependencies}
          side="dependencies"
          nodeHref={nodeHref}
        />
      </Section>
      <Section
        title={t("graph.inspector.directConsumers")}
        count={direct.consumers.length}
      >
        <RelationshipRows
          index={index}
          links={direct.consumers}
          side="consumers"
          nodeHref={nodeHref}
        />
      </Section>
    </>
  );
}

function TypeRelations({
  overview,
  type,
  side,
  typeHref,
}: {
  overview: OverviewGraph;
  type: DependencyNodeType;
  side: "dependencies" | "consumers";
  typeHref: TypeHref;
}) {
  const { t } = useTranslation(["content", "common"]);
  const edges = overview.edges.filter((edge) =>
    side === "dependencies" ? edge.toType === type : edge.fromType === type,
  );
  if (edges.length === 0)
    return (
      <EmptyNote>
        {t(
          side === "dependencies"
            ? "graph.inspector.noTypeDependencies"
            : "graph.inspector.noTypeConsumers",
        )}
      </EmptyNote>
    );
  return (
    <ItemGroup className="gap-0.5">
      {edges.map((edge) => {
        const other = side === "dependencies" ? edge.fromType : edge.toType;
        const presentation = typePresentation[other];
        const Icon = presentation.icon;
        return (
          <div role="listitem" key={other}>
            <Item
              size="xs"
              render={<Link to={typeHref(other)} />}
              className="hover:bg-muted"
            >
              <ItemMedia variant="icon">
                <Icon aria-hidden="true" className="text-muted-foreground" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{t(presentation.pluralKey)}</ItemTitle>
                <ItemDescription>
                  {t("graph.inspector.relationships", { count: edge.count })}
                </ItemDescription>
              </ItemContent>
            </Item>
          </div>
        );
      })}
    </ItemGroup>
  );
}

function TypeInspector({
  index,
  overview,
  type,
  nodeHref,
  typeHref,
}: {
  index: GraphIndex;
  overview: OverviewGraph;
  type: DependencyNodeType;
  nodeHref: NodeHref;
  typeHref: TypeHref;
}) {
  const { t } = useTranslation(["content", "common"]);
  const nodes = useMemo(
    () => index.nodes.filter((node) => node.type === type),
    [index.nodes, type],
  );
  const presentation = typePresentation[type];
  return (
    <>
      <Heading title={t(presentation.pluralKey)} />
      <p className="text-sm text-muted-foreground">
        {t(presentation.countKey, { count: nodes.length })}
      </p>
      <Section title={t("graph.inspector.fedBy")}>
        <TypeRelations
          overview={overview}
          type={type}
          side="dependencies"
          typeHref={typeHref}
        />
      </Section>
      <Section title={t("graph.inspector.feeds")}>
        <TypeRelations
          overview={overview}
          type={type}
          side="consumers"
          typeHref={typeHref}
        />
      </Section>
      <Separator />
      <Section title={t("graph.inspector.resources")} count={nodes.length}>
        {nodes.length === 0 ? (
          <EmptyNote>{t("graph.inspector.emptyType")}</EmptyNote>
        ) : (
          <ResourceList
            nodes={nodes}
            nodeHref={nodeHref}
            describe={(node) => {
              const key = nodeKey(node.type, node.id);
              return t("graph.inspector.rowCounts", {
                dependencies: index.incomingByKey.get(key)?.length ?? 0,
                consumers: index.outgoingByKey.get(key)?.length ?? 0,
              });
            }}
          />
        )}
      </Section>
    </>
  );
}

function ResourceList({
  nodes,
  nodeHref,
  describe,
}: {
  nodes: readonly DependencyNode[];
  nodeHref: NodeHref;
  describe: (node: DependencyNode) => string;
}) {
  return (
    <ItemGroup className="gap-0.5">
      {nodes.map((node) => {
        const key = nodeKey(node.type, node.id);
        return (
          <ResourceRow
            key={key}
            node={node}
            href={nodeHref(key)}
            detail={describe(node)}
          />
        );
      })}
    </ItemGroup>
  );
}

function GroupInspector({
  index,
  group,
  nodeHref,
  onExpand,
}: {
  index: GraphIndex;
  group: FanoutGroup;
  nodeHref: NodeHref;
  onExpand: (group: FanoutGroup) => void;
}) {
  const { t } = useTranslation(["content", "common"]);
  const relationshipLabel = useRelationshipLabel();
  const presentation = typePresentation[group.type];
  const anchor = index.nodesByKey.get(group.anchorKey)!;
  const relationshipFor = (node: DependencyNode) => {
    const key = nodeKey(node.type, node.id);
    const link = (
      group.side === "consumers"
        ? index.incomingByKey.get(key)
        : index.outgoingByKey.get(key)
    )?.find((candidate) =>
      group.side === "consumers"
        ? candidate.from === group.anchorKey
        : candidate.to === group.anchorKey,
    );
    return link ? relationshipLabel(link.relationship) : "";
  };
  return (
    <>
      <Heading
        type={group.type}
        title={t(presentation.countKey, { count: group.members.length })}
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => onExpand(group)}
          >
            {t("graph.fanout.expand")}
          </Button>
        }
      />
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        {group.side === "consumers" ? (
          <ArrowRight aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        ) : (
          <ArrowLeft aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        )}
        {t(
          group.side === "consumers"
            ? "graph.fanout.fedBy"
            : "graph.fanout.feeds",
          { name: anchor.name },
        )}
      </p>
      <Separator />
      <Section title={t(presentation.pluralKey)} count={group.members.length}>
        <ResourceList
          nodes={group.members}
          nodeHref={nodeHref}
          describe={(node) =>
            [t(presentation.labelKey), relationshipFor(node)]
              .filter(Boolean)
              .join(" · ")
          }
        />
      </Section>
    </>
  );
}

function OverviewInspector({
  overview,
  typeHref,
}: {
  overview: OverviewGraph;
  typeHref: TypeHref;
}) {
  const { t } = useTranslation(["content", "common"]);
  const counts = new Map(overview.nodes.map((node) => [node.type, node.count]));
  return (
    <>
      <Heading title={t("graph.overview")} />
      <p className="text-sm text-muted-foreground">
        {t("graph.inspector.overviewDescription")}
      </p>
      <Section title={t("graph.inspector.resourceTypes")}>
        <ItemGroup className="gap-0.5">
          {typeOrder.map((type) => {
            const presentation = typePresentation[type];
            const Icon = presentation.icon;
            return (
              <div role="listitem" key={type}>
                <Item
                  size="xs"
                  render={<Link to={typeHref(type)} />}
                  className="hover:bg-muted"
                >
                  <ItemMedia variant="icon">
                    <Icon
                      aria-hidden="true"
                      className="text-muted-foreground"
                    />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{t(presentation.pluralKey)}</ItemTitle>
                  </ItemContent>
                  <Badge variant="secondary" className="tabular-nums">
                    {counts.get(type) ?? 0}
                  </Badge>
                </Item>
              </div>
            );
          })}
        </ItemGroup>
      </Section>
    </>
  );
}

/**
 * Detail for whatever the graph is centred on or has selected. It is plain
 * content: the desktop pane and the narrow Sheet each supply the container.
 */
export function DependencyInspector({
  index,
  overview,
  subject,
  nodeHref,
  typeHref,
  onExpandGroup,
}: {
  index: GraphIndex;
  overview: OverviewGraph;
  subject: InspectorSubject;
  nodeHref: NodeHref;
  typeHref: TypeHref;
  onExpandGroup: (group: FanoutGroup) => void;
}) {
  return (
    <div className="grid content-start gap-4 p-4">
      {subject.kind === "overview" && (
        <OverviewInspector overview={overview} typeHref={typeHref} />
      )}
      {subject.kind === "type" && (
        <TypeInspector
          index={index}
          overview={overview}
          type={subject.type}
          nodeHref={nodeHref}
          typeHref={typeHref}
        />
      )}
      {subject.kind === "resource" && (
        <ResourceInspector
          index={index}
          resourceKey={subject.key}
          nodeHref={nodeHref}
        />
      )}
      {subject.kind === "group" && (
        <GroupInspector
          index={index}
          group={subject.group}
          nodeHref={nodeHref}
          onExpand={onExpandGroup}
        />
      )}
    </div>
  );
}
