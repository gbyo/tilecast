import { useQuery } from "@tanstack/react-query";
import { Network } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams, type To } from "react-router";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import type { DependencyGraph, DependencyNodeType } from "../api/types";
import { Alert, AlertAction, AlertDescription } from "../components/ui/alert";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../components/ui/breadcrumb";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../components/ui/resizable";
import { ScrollArea } from "../components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet";
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";
import {
  DependencyGraphCanvas,
  useGraphViewport,
} from "../dependency-graph/DependencyGraphCanvas";
import { DependencyGraphToolbar } from "../dependency-graph/DependencyGraphToolbar";
import {
  DependencyInspector,
  type InspectorSubject,
} from "../dependency-graph/DependencyInspector";
import {
  explorerSearch,
  parseExplorerParams,
} from "../dependency-graph/explorerUrlState";
import {
  layoutFocus,
  layoutOverview,
  type LayoutItem,
} from "../dependency-graph/graphLayout";
import {
  buildFocusedSubgraph,
  buildGraphIndex,
  buildOverviewGraph,
  groupTerminalFanout,
  nodeKey,
  type FanoutGroup,
  type NodeKey,
} from "../dependency-graph/graphModel";
import { typePresentation } from "../dependency-graph/resourceTypes";
import { useDesktopLayout } from "../hooks/use-desktop-layout";

const emptyGraph: DependencyGraph = { nodes: [], edges: [] };
const noKeys: ReadonlySet<string> = new Set();

/** Explorer height: the viewport below the Studio header and page title. */
const explorerHeight = "h-[max(28rem,calc(100svh-18rem))]";

/**
 * State that belongs to one root and resets when the root changes: which
 * fan-out groups the operator expanded and which one is being inspected.
 */
type RootState = {
  root?: NodeKey;
  expanded: ReadonlySet<string>;
  group?: string;
};

/**
 * A Studio system tool rather than a plugin: it has no installation and
 * projects nothing to Players. It renders inside Settings, which supplies the
 * page heading.
 */
export function DependencyExplorerPage() {
  const { t } = useTranslation(["content", "common"]);
  const graph = useQuery({
    queryKey: ["dependency-graph"],
    queryFn: api.dependencyGraph,
  });
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const url = parseExplorerParams(searchParams);
  const { direction, depth } = url;
  const index = useMemo(
    () => buildGraphIndex(graph.data ?? emptyGraph),
    [graph.data],
  );
  const overview = useMemo(() => buildOverviewGraph(index), [index]);
  // A node the graph does not contain falls back to the overview.
  const root =
    url.node && index.nodesByKey.has(url.node) ? url.node : undefined;

  const [rootState, setRootState] = useState<RootState>({ expanded: noKeys });
  const expanded = rootState.root === root ? rootState.expanded : noKeys;
  const selectedGroupKey =
    rootState.root === root ? rootState.group : undefined;

  const explorerGraph = useMemo(() => {
    if (!root) return undefined;
    const subgraph = buildFocusedSubgraph(index, root, { direction, depth });
    return subgraph && groupTerminalFanout(index, subgraph, { expanded });
  }, [depth, direction, expanded, index, root]);
  const layout = useMemo(
    () =>
      explorerGraph ? layoutFocus(explorerGraph) : layoutOverview(overview),
    [explorerGraph, overview],
  );
  const viewKey = root
    ? `${root}|${direction}|${depth}|${[...expanded].sort().join(",")}`
    : "overview";
  const view = useGraphViewport(layout, viewKey);

  const selectedGroup = explorerGraph?.groups.find(
    (group) => group.key === selectedGroupKey,
  );
  const subject: InspectorSubject = root
    ? selectedGroup
      ? { kind: "group", group: selectedGroup }
      : { kind: "resource", key: root }
    : url.type
      ? { kind: "type", type: url.type }
      : { kind: "overview" };
  const currentKey =
    subject.kind === "group"
      ? subject.group.key
      : subject.kind === "resource"
        ? subject.key
        : subject.kind === "type"
          ? subject.type
          : undefined;

  const desktop = useDesktopLayout();
  const [sheetOpen, setSheetOpen] = useState(false);

  const nodeHref = useCallback(
    (key: NodeKey) => ({
      search: explorerSearch({ node: key, direction, depth }),
    }),
    [depth, direction],
  );
  const typeHref = useCallback(
    (type: DependencyNodeType) => ({ search: explorerSearch({ type }) }),
    [],
  );
  const go = (to: To) => void navigate(to);

  const inspectGroup = (group?: FanoutGroup) =>
    setRootState({ root, expanded, group: group?.key });

  const activate = (item: LayoutItem) => {
    if (item.kind === "type") {
      go(typeHref(item.type));
      if (!desktop) setSheetOpen(true);
    } else if (item.kind === "group") {
      inspectGroup(item.group);
      if (!desktop) setSheetOpen(true);
    } else if (item.key === root) {
      inspectGroup(undefined);
      if (!desktop) setSheetOpen(true);
    } else {
      go(nodeHref(item.key));
    }
  };

  const expandGroup = (group: FanoutGroup) => {
    setRootState({
      root,
      expanded: new Set([...expanded, group.key]),
      group: undefined,
    });
    setSheetOpen(false);
  };

  if (graph.isError)
    return (
      <Alert variant="destructive">
        <AlertDescription>{t("graph.loadError")}</AlertDescription>
        <AlertAction>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void graph.refetch()}
          >
            {t("common:actions.retry")}
          </Button>
        </AlertAction>
      </Alert>
    );
  if (graph.isLoading)
    return (
      <div className="grid gap-3" aria-busy="true">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner aria-hidden="true" />
          {t("graph.loading")}
        </p>
        <Skeleton className={`${explorerHeight} w-full`} />
      </div>
    );
  if (index.nodes.length === 0)
    return (
      <Empty className="border border-dashed border-border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Network aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>{t("graph.emptyTitle")}</EmptyTitle>
          <EmptyDescription>{t("graph.emptyDescription")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  const rootNode = root ? index.nodesByKey.get(root) : undefined;
  const breadcrumbType = rootNode?.type ?? url.type;
  const inspector = (
    <DependencyInspector
      index={index}
      overview={overview}
      subject={subject}
      nodeHref={nodeHref}
      typeHref={typeHref}
      onExpandGroup={expandGroup}
    />
  );
  const canvas = (
    <DependencyGraphCanvas
      layout={layout}
      view={view}
      currentKey={currentKey}
      showEdgeCounts={!root}
      onActivate={activate}
    />
  );

  return (
    <div className="grid min-w-0 gap-3">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            {breadcrumbType ? (
              <BreadcrumbLink render={<Link to={{ search: "" }} />}>
                {t("graph.overview")}
              </BreadcrumbLink>
            ) : (
              <BreadcrumbPage>{t("graph.overview")}</BreadcrumbPage>
            )}
          </BreadcrumbItem>
          {breadcrumbType && (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                {rootNode ? (
                  <BreadcrumbLink
                    render={<Link to={typeHref(breadcrumbType)} />}
                  >
                    {t(typePresentation[breadcrumbType].pluralKey)}
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage>
                    {t(typePresentation[breadcrumbType].pluralKey)}
                  </BreadcrumbPage>
                )}
              </BreadcrumbItem>
            </>
          )}
          {rootNode && (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem className="min-w-0">
                <BreadcrumbPage className="truncate">
                  {rootNode.name}
                </BreadcrumbPage>
              </BreadcrumbItem>
            </>
          )}
        </BreadcrumbList>
      </Breadcrumb>
      <DependencyGraphToolbar
        index={index}
        focused={Boolean(root)}
        direction={direction}
        depth={depth}
        view={view}
        onSelectResource={(node) => go(nodeHref(nodeKey(node.type, node.id)))}
        onDirectionChange={(next) =>
          go({ search: explorerSearch({ node: root, direction: next, depth }) })
        }
        onDepthChange={(next) =>
          go({ search: explorerSearch({ node: root, direction, depth: next }) })
        }
        onOpenDetails={desktop ? undefined : () => setSheetOpen(true)}
      />
      {desktop ? (
        // The panel group sizes itself to its parent with an inline style.
        <div
          className={`${explorerHeight} overflow-hidden rounded-lg border border-border`}
        >
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel
              id="dependency-graph-canvas"
              minSize={360}
              className="min-h-0 min-w-0"
            >
              {canvas}
            </ResizablePanel>
            <ResizableHandle
              withHandle
              aria-label={t("graph.inspector.resize")}
            />
            <ResizablePanel
              id="dependency-graph-inspector"
              defaultSize={336}
              minSize={280}
              maxSize={480}
              className="min-h-0 min-w-0"
            >
              <aside
                aria-label={t("graph.inspector.label")}
                className="h-full bg-background"
              >
                <ScrollArea className="h-full">{inspector}</ScrollArea>
              </aside>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      ) : (
        <>
          <div
            className={`${explorerHeight} overflow-hidden rounded-lg border border-border`}
          >
            {canvas}
          </div>
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetContent side="right" className="w-full gap-0 sm:max-w-sm">
              <SheetHeader className="border-b border-border">
                <SheetTitle>{t("graph.inspector.label")}</SheetTitle>
              </SheetHeader>
              <ScrollArea className="min-h-0 flex-1">{inspector}</ScrollArea>
            </SheetContent>
          </Sheet>
        </>
      )}
    </div>
  );
}
