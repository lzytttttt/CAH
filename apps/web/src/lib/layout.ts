/**
 * Deterministic spatial layout for the workbench.
 *
 * The server ships a spatial projection (nodes/edges/stage/counts); this module
 * only decides which of those nodes are currently visible inside the ViewState
 * limits (design 2.3): at most 3 expanded branches, 12 working nodes and 16
 * visible edges, not counting the central hub and fixed controls. Nothing here
 * reads or mutates business state beyond aggregation.
 */
import {
  LIMITS,
  type HiddenCounts,
  type ModuleView,
  type SpatialEdge,
  type SpatialNode,
  type SpatialNodeKind,
  type SpatialNodeStatus,
  type SpatialProjection,
  type StageSummary,
  type TaskSnapshot,
} from '@ca/contracts';

export const SPATIAL_LIMITS = {
  maxBranches: LIMITS.maxSpatialBranches,
  maxNodes: LIMITS.maxSpatialNodes,
  maxEdges: LIMITS.maxSpatialEdges,
} as const;

/** Fixed spatial regions that never count against the 12 node limit. */
const HUB_KINDS: ReadonlySet<SpatialNodeKind> = new Set(['hub']);
const CANOPY_KINDS: ReadonlySet<SpatialNodeKind> = new Set(['constraint']);
const PROSPECT_KINDS: ReadonlySet<SpatialNodeKind> = new Set(['prospect']);
const EVIDENCE_KINDS: ReadonlySet<SpatialNodeKind> = new Set(['source', 'span', 'validation']);

export interface SpatialNodeView {
  node: SpatialNode;
  /** Dimmed because a focus scope is active and this node is unrelated. */
  dimmed: boolean;
  /** Always-visible safety node (blocker / error / approval). */
  pinned: boolean;
}

export interface BranchLaneView {
  id: string;
  title: string;
  status: SpatialNodeStatus;
  active: boolean;
  expanded: boolean;
  /** Working nodes currently rendered in the lane (subject to the 12-node cap). */
  nodes: SpatialNodeView[];
  /** Nodes hidden by collapsing this branch. */
  hiddenNodeCount: number;
  hiddenEdgeCount: number;
  summary: string;
}

export interface LocalHiddenCounts {
  branches: number;
  nodes: number;
  edges: number;
  byKind: Record<string, number>;
}

export interface SpatialLayout {
  stage: StageSummary;
  focusHint: string;
  activeBranchId: string | null;
  hubNodes: SpatialNodeView[];
  canopyNodes: SpatialNodeView[];
  evidenceNodes: SpatialNodeView[];
  prospectNodes: SpatialNodeView[];
  branches: BranchLaneView[];
  /** Branches beyond the 3-branch limit; only their aggregate counts are shown. */
  overflowBranches: BranchLaneView[];
  collapsedBranchCount: number;
  hiddenNodeCount: number;
  visibleNodes: SpatialNode[];
  visibleEdges: SpatialEdge[];
  hidden: LocalHiddenCounts;
  backendHidden: HiddenCounts;
  visibleNodeCount: number;
  visibleEdgeCount: number;
}

export interface BuildSpatialLayoutOptions {
  expandedBranchIds?: readonly string[];
  selectedEntityId?: string | null;
  focusScopeId?: string | null;
  moduleTitles?: ReadonlyMap<string, string>;
  runLabels?: ReadonlyMap<string, string>;
  maxBranches?: number;
  maxNodes?: number;
  maxEdges?: number;
}

/** Stable branch identity derived from business ids (never from coordinates). */
export function spatialBranchId(node: SpatialNode): string {
  if (node.runId) return `run:${node.runId}`;
  if (node.moduleId) return `module:${node.moduleId}`;
  return `kind:${node.kind}`;
}

function compareNodePriority(status: SpatialNodeStatus): number {
  switch (status) {
    case 'blocked':
      return 0;
    case 'failed':
      return 1;
    case 'running':
      return 2;
    case 'warning':
      return 3;
    case 'ready_for_review':
      return 4;
    case 'paused':
      return 5;
    case 'stale':
      return 6;
    case 'draft':
      return 7;
    case 'completed':
      return 8;
    case 'accepted':
      return 9;
    default:
      return 10;
  }
}

function branchStatus(nodes: readonly SpatialNode[]): SpatialNodeStatus {
  if (nodes.length === 0) return 'idle';
  return [...nodes].sort((a, b) => compareNodePriority(a.status) - compareNodePriority(b.status))[0]!.status;
}

function isPinnedNode(node: SpatialNode): boolean {
  return node.kind === 'blocker' || node.status === 'failed' || node.status === 'blocked';
}

/**
 * Build the visible layout.
 *
 * Rules (deterministic, no DOM):
 * - active branch gets node budget priority and is always expanded;
 * - only the first `maxBranches` branches get a lane (overflow is aggregated);
 * - rendered working nodes stop at `maxNodes`; leftovers are counted, never dropped;
 * - edges are only drawn between rendered nodes and stop at `maxEdges`.
 */
export function buildSpatialLayout(spatial: SpatialProjection, options: BuildSpatialLayoutOptions = {}): SpatialLayout {
  const maxBranches = options.maxBranches ?? SPATIAL_LIMITS.maxBranches;
  const maxNodes = options.maxNodes ?? SPATIAL_LIMITS.maxNodes;
  const maxEdges = options.maxEdges ?? SPATIAL_LIMITS.maxEdges;
  const expandedIds = new Set(options.expandedBranchIds ?? []);
  const focusScopeId = options.focusScopeId ?? null;
  const related = focusScopeId ? focusRelatedNodeIds(spatial, options.selectedEntityId ?? focusScopeId) : null;

  const hubNodes: SpatialNodeView[] = [];
  const canopyNodes: SpatialNodeView[] = [];
  const prospectNodes: SpatialNodeView[] = [];
  const evidenceNodes: SpatialNodeView[] = [];
  const byBranch = new Map<string, SpatialNode[]>();

  for (const node of spatial.nodes) {
    const view: SpatialNodeView = {
      node,
      dimmed: related !== null && !related.has(node.id) && !isPinnedNode(node),
      pinned: isPinnedNode(node),
    };
    if (HUB_KINDS.has(node.kind)) {
      hubNodes.push(view);
      continue;
    }
    if (CANOPY_KINDS.has(node.kind)) {
      canopyNodes.push(view);
      continue;
    }
    if (PROSPECT_KINDS.has(node.kind)) {
      prospectNodes.push(view);
      continue;
    }
    if (EVIDENCE_KINDS.has(node.kind)) {
      evidenceNodes.push(view);
      continue;
    }
    const branchId = spatialBranchId(node);
    const list = byBranch.get(branchId) ?? [];
    list.push(node);
    byBranch.set(branchId, list);
  }

  const activeBranchId = spatial.activeBranchId ?? null;
  const laneEntries = [...byBranch.entries()].map(([id, nodes]) => {
    const sorted = [...nodes].sort((a, b) => a.laneHint - b.laneHint || a.id.localeCompare(b.id));
    const isActive = activeBranchId === id;
    const title =
      (sorted[0]?.runId && options.runLabels?.get(sorted[0].runId)) ||
      (sorted.map((n) => n.moduleId).find((moduleId) => moduleId != null && options.moduleTitles?.has(moduleId)) &&
        options.moduleTitles?.get(sorted.map((n) => n.moduleId).find((moduleId) => moduleId != null && options.moduleTitles?.has(moduleId))!)) ||
      (isActive ? '当前活动支线' : `执行支线`);
    const laneStatus = branchStatus(sorted);
    return {
      id,
      title,
      status: laneStatus,
      active: isActive,
      nodes: sorted,
      summary: `${sorted.length} 个节点${isActive ? ' · 优先保留' : ''}`,
    };
  });

  laneEntries.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    const aMax = Math.max(...a.nodes.map((n) => n.laneHint), 0);
    const bMax = Math.max(...b.nodes.map((n) => n.laneHint), 0);
    return aMax - bMax || a.id.localeCompare(b.id);
  });

  const laneSlice = laneEntries.slice(0, Math.max(1, maxBranches));
  const overflowEntries = laneEntries.slice(Math.max(1, maxBranches));

  // Node budget: active expanded lanes first, then other expanded lanes.
  const orderedForBudget = [
    ...laneSlice.filter((lane) => lane.active || expandedIds.has(lane.id)),
    ...laneSlice.filter((lane) => !(lane.active || expandedIds.has(lane.id))),
  ];
  let remainingNodes = maxNodes;
  const renderedCountByBranch = new Map<string, number>();
  for (const lane of orderedForBudget) {
    const expanded = lane.active || expandedIds.has(lane.id);
    if (!expanded) {
      renderedCountByBranch.set(lane.id, 0);
      continue;
    }
    const take = Math.min(lane.nodes.length, Math.max(0, remainingNodes));
    renderedCountByBranch.set(lane.id, take);
    remainingNodes -= take;
  }

  const branches: BranchLaneView[] = laneSlice.map((lane) => {
    const expanded = lane.active || expandedIds.has(lane.id);
    const take = renderedCountByBranch.get(lane.id) ?? 0;
    const shown = expanded ? lane.nodes.slice(0, take) : [];
    const visibleInBranch = new Set(shown.map((node) => node.id));
    const hiddenIds = new Set(lane.nodes.filter((node) => !visibleInBranch.has(node.id)).map((node) => node.id));
    const hiddenNodeCount = hiddenIds.size;
    return {
      id: lane.id,
      title: lane.title,
      status: lane.status,
      active: lane.active,
      expanded,
      nodes: shown.map((node) => toNodeView(node, related)),
      hiddenNodeCount,
      hiddenEdgeCount: spatial.edges.filter((edge) => hiddenIds.has(edge.from) || hiddenIds.has(edge.to)).length,
      summary: expanded ? `${lane.nodes.length} 个节点` : `${lane.nodes.length} 个节点已折叠`,
    };
  });

  const visibleNodeIds = new Set<string>([
    ...hubNodes.map((view) => view.node.id),
    ...canopyNodes.map((view) => view.node.id),
    ...branches.flatMap((branch) => branch.nodes.map((view) => view.node.id)),
    ...evidenceNodes.map((view) => view.node.id),
    ...prospectNodes.map((view) => view.node.id),
  ]);

  const activeNodeIds = new Set(branches.filter((branch) => branch.active).flatMap((branch) => branch.nodes.map((view) => view.node.id)));
  const edgeCandidates = spatial.edges
    .filter((edge) => visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to))
    .sort((a, b) => {
      const aActive = activeNodeIds.has(a.from) || activeNodeIds.has(a.to) ? 0 : 1;
      const bActive = activeNodeIds.has(b.from) || activeNodeIds.has(b.to) ? 0 : 1;
      return aActive - bActive || a.id.localeCompare(b.id);
    });
  const visibleEdges = edgeCandidates.slice(0, maxEdges);
  const hiddenEdgeCount = edgeCandidates.length - visibleEdges.length;

  const localHidden: LocalHiddenCounts = {
    branches: overflowEntries.length,
    nodes: 0,
    edges: hiddenEdgeCount,
    byKind: {},
  };
  let hiddenNodes = 0;
  for (const overflow of overflowEntries) {
    hiddenNodes += overflow.nodes.length;
    for (const node of overflow.nodes) {
      localHidden.byKind[node.kind] = (localHidden.byKind[node.kind] ?? 0) + 1;
    }
  }
  for (const branch of branches) {
    hiddenNodes += branch.hiddenNodeCount;
    if (branch.hiddenNodeCount > 0) {
      const lane = laneSlice.find((entry) => entry.id === branch.id);
      const shownIds = new Set(branch.nodes.map((view) => view.node.id));
      for (const node of lane?.nodes ?? []) {
        if (shownIds.has(node.id)) continue;
        localHidden.byKind[node.kind] = (localHidden.byKind[node.kind] ?? 0) + 1;
      }
    }
  }
  localHidden.nodes = hiddenNodes;

  const visibleNodes = [...hubNodes, ...canopyNodes, ...branches.flatMap((b) => b.nodes), ...evidenceNodes, ...prospectNodes].map((view) => view.node);

  return {
    stage: spatial.stage,
    focusHint: spatial.focusHint,
    activeBranchId,
    hubNodes,
    canopyNodes,
    evidenceNodes,
    prospectNodes,
    branches,
    overflowBranches: overflowEntries.map((lane) => ({
      id: lane.id,
      title: lane.title,
      status: lane.status,
      active: lane.active,
      expanded: false,
      nodes: [],
      hiddenNodeCount: lane.nodes.length,
      hiddenEdgeCount: 0,
      summary: `${lane.nodes.length} 个节点（超出 ${maxBranches} 条支线上限）`,
    })),
    collapsedBranchCount: branches.filter((branch) => !branch.expanded).length + overflowEntries.length,
    hiddenNodeCount: hiddenNodes,
    visibleNodes,
    visibleEdges,
    hidden: localHidden,
    backendHidden: spatial.counts,
    visibleNodeCount: branches.reduce((sum, branch) => sum + branch.nodes.length, 0),
    visibleEdgeCount: visibleEdges.length,
  };
}

function toNodeView(node: SpatialNode, related: ReadonlySet<string> | null): SpatialNodeView {
  return {
    node,
    dimmed: related !== null && !related.has(node.id) && !isPinnedNode(node),
    pinned: isPinnedNode(node),
  };
}

/** Find the spatial evidence node that represents a source version (for focus jumps). */
export function evidenceNodeId(spatial: SpatialProjection, sourceId: string): string | null {
  const node = spatial.nodes.find(
    (candidate) => (candidate.kind === 'source' || candidate.kind === 'span') && (candidate.refId === sourceId || candidate.id.includes(sourceId)),
  );
  return node?.id ?? null;
}

/** Spatial nodes related to a focused entity: itself, same module/run, edge neighbours. */
export function focusRelatedNodeIds(spatial: SpatialProjection, focusId: string): Set<string> {
  const focusNode = spatial.nodes.find((node) => node.id === focusId) ?? null;
  const related = new Set<string>([focusId]);
  if (!focusNode) return related;
  if (focusNode.moduleId) {
    for (const node of spatial.nodes) {
      if (node.moduleId === focusNode.moduleId) related.add(node.id);
    }
  }
  if (focusNode.runId) {
    for (const node of spatial.nodes) {
      if (node.runId === focusNode.runId) related.add(node.id);
    }
  }
  for (const edge of spatial.edges) {
    if (edge.from === focusId) related.add(edge.to);
    if (edge.to === focusId) related.add(edge.from);
  }
  return related;
}

/** Module ids related to a focused entity (used to dim the hub slots). */
export function focusRelatedModuleIds(snapshot: TaskSnapshot, focusId: string): Set<string> {
  const related = new Set<string>();
  const spatial = snapshot.spatial;
  const focusNode = spatial.nodes.find((node) => node.id === focusId) ?? null;
  if (focusNode?.moduleId) related.add(focusNode.moduleId);
  if (focusNode?.runId) {
    for (const node of spatial.nodes) {
      if (node.runId === focusNode.runId && node.moduleId) related.add(node.moduleId);
    }
  }
  for (const edge of spatial.edges) {
    if (edge.from === focusId) {
      const other = spatial.nodes.find((node) => node.id === edge.to);
      if (other?.moduleId) related.add(other.moduleId);
    }
    if (edge.to === focusId) {
      const other = spatial.nodes.find((node) => node.id === edge.from);
      if (other?.moduleId) related.add(other.moduleId);
    }
  }
  return related;
}

/* ------------------------------ module paging ------------------------------ */

export interface ModulePage<T> {
  items: T[];
  page: number;
  pageSize: number;
  pageCount: number;
  total: number;
  startIndex: number;
  endIndex: number;
}

/** Centre hub shows 4 slots per page (1–8 modules, design 9.1). */
export function paginateModules<T>(items: readonly T[], page: number, pageSize = 4): ModulePage<T> {
  const total = items.length;
  const safeSize = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(total / safeSize));
  const safePage = Math.min(Math.max(0, Math.floor(page)), pageCount - 1);
  const startIndex = safePage * safeSize;
  const endIndex = Math.min(total, startIndex + safeSize);
  return { items: items.slice(startIndex, endIndex), page: safePage, pageSize: safeSize, pageCount, total, startIndex, endIndex };
}

/** Page that contains a module (used when an external action selects a hidden slot). */
export function pageForModule(modules: readonly Pick<ModuleView, 'module'>[], moduleId: string | null, pageSize = 4): number {
  if (!moduleId) return 0;
  const index = modules.findIndex((view) => view.module.id === moduleId);
  if (index < 0) return 0;
  return Math.floor(index / Math.max(1, pageSize));
}

/* ------------------------------ format helpers ----------------------------- */

/** One-line summary of the collapsed/aggregated counts, always text-first. */
export function hiddenCountsSummary(hidden: LocalHiddenCounts, backend: HiddenCounts): string | null {
  const branchCount = hidden.branches + (backend.branchCount ?? 0);
  const nodeCount = hidden.nodes + (backend.nodeCount ?? 0);
  const edgeCount = hidden.edges + (backend.edgeCount ?? 0);
  if (branchCount === 0 && nodeCount === 0 && edgeCount === 0) return null;
  const parts: string[] = [];
  if (branchCount > 0) parts.push(`${branchCount} 条支线`);
  if (nodeCount > 0) parts.push(`${nodeCount} 个节点`);
  if (edgeCount > 0) parts.push(`${edgeCount} 条连线`);
  return `已折叠 ${parts.join(' · ')}`;
}

/** Deterministic lane assignment for up to 3 visible branches (left/right alternating). */
export function laneSide(index: number): 'left' | 'right' {
  return index % 2 === 0 ? 'left' : 'right';
}
