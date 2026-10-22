import { describe, expect, it } from 'vitest';
import { LIMITS, type SpatialEdge, type SpatialNode, type SpatialProjection } from '@ca/contracts';
import {
  buildSpatialLayout,
  focusRelatedModuleIds,
  focusRelatedNodeIds,
  hiddenCountsSummary,
  pageForModule,
  paginateModules,
  spatialBranchId,
  SPATIAL_LIMITS,
} from '../src/lib/layout';

function node(partial: Partial<Record<keyof SpatialNode, unknown>> & Pick<SpatialNode, 'id' | 'kind'>): SpatialNode {
  return {
    layer: 'execution',
    title: partial.id,
    status: 'draft',
    summary: '',
    moduleId: null,
    runId: null,
    stepId: null,
    refId: null,
    badgeCount: null,
    laneHint: 0,
    ...partial,
  } as unknown as SpatialNode;
}

function projection(nodes: SpatialNode[], edges: SpatialEdge[] = [], activeBranchId: string | null = null): SpatialProjection {
  return {
    nodes,
    edges,
    stage: { phase: 'executing', label: '执行中', completedSteps: 1, totalSteps: 3, activeStepTitle: '步骤', note: '' },
    counts: { branchCount: 0, nodeCount: 0, edgeCount: 0, collapsedNodes: 0, byKind: {} },
    activeBranchId,
    focusHint: '',
  };
}

describe('buildSpatialLayout — view limits (3 branches / 12 nodes / 16 edges)', () => {
  it('caps expanded branches at 3 and aggregates the overflow instead of dropping it', () => {
    const nodes: SpatialNode[] = [];
    const branchSuffix = (index: number): string => String(index).padStart(12, '0');
    for (let branch = 0; branch < 5; branch += 1) {
      nodes.push(node({ id: `run-${branch}`, kind: 'run', runId: `00000000-0000-4000-8000-${branchSuffix(branch)}` as never, laneHint: 0 }));
      nodes.push(node({ id: `step-${branch}`, kind: 'step', runId: `00000000-0000-4000-8000-${branchSuffix(branch)}` as never, laneHint: 1 }));
    }
    const expanded = nodes.filter((entry) => entry.kind === 'run').map((entry) => spatialBranchId(entry));
    const layout = buildSpatialLayout(projection(nodes), { expandedBranchIds: expanded });
    expect(layout.branches.length).toBe(SPATIAL_LIMITS.maxBranches);
    expect(layout.overflowBranches.length).toBe(2);
    expect(layout.hidden.branches).toBe(2);
    // 3 expanded lanes keep 12 nodes; the 4 nodes of the 2 overflow branches are aggregated.
    expect(layout.hidden.nodes).toBe(4);
  });

  it('prioritises the active branch first and keeps it expanded', () => {
    const activeRun = '00000000-0000-4000-8000-000000000001';
    const nodes = [
      node({ id: 'a', kind: 'run', runId: activeRun, status: 'blocked', laneHint: 0 }),
      node({ id: 'b', kind: 'step', runId: activeRun, laneHint: 1 }),
      node({ id: 'c', kind: 'run', runId: '00000000-0000-4000-8000-000000000002', laneHint: 5 }),
    ];
    const layout = buildSpatialLayout(projection(nodes, [], `run:${activeRun}`));
    expect(layout.branches[0]!.active).toBe(true);
    expect(layout.branches[0]!.expanded).toBe(true);
    expect(layout.branches[0]!.id).toBe(`run:${activeRun}`);
  });

  it('never renders more than 12 working nodes; leftovers are counted by kind', () => {
    const nodes: SpatialNode[] = [];
    for (let index = 0; index < 20; index += 1) {
      nodes.push(node({ id: `n-${index}`, kind: 'step', runId: '00000000-0000-4000-8000-0000000000aa', laneHint: index }));
    }
    const layout = buildSpatialLayout(projection(nodes), { expandedBranchIds: ['run:00000000-0000-4000-8000-0000000000aa'] });
    expect(layout.visibleNodeCount).toBeLessThanOrEqual(LIMITS.maxSpatialNodes);
    expect(layout.hidden.nodes).toBe(8);
    expect(layout.hidden.byKind.step).toBe(8);
  });

  it('caps visible edges at 16 and counts the rest', () => {
    const nodes = [node({ id: 'x', kind: 'run', runId: '00000000-0000-4000-8000-0000000000bb' }), node({ id: 'y', kind: 'step', runId: '00000000-0000-4000-8000-0000000000bb' })];
    const edges: SpatialEdge[] = Array.from({ length: 20 }, (_, index) => ({
      id: `e-${index}`,
      from: 'x',
      to: 'y',
      kind: 'flow',
      label: '',
    }));
    const layout = buildSpatialLayout(projection(nodes, edges), { expandedBranchIds: ['run:00000000-0000-4000-8000-0000000000bb'] });
    expect(layout.visibleEdges.length).toBe(LIMITS.maxSpatialEdges);
    expect(layout.hidden.edges).toBe(4);
  });

  it('routes fixed regions separately (hub / constraints / evidence / prospects)', () => {
    const nodes = [
      node({ id: 'hub', kind: 'hub', layer: 'global' }),
      node({ id: 'c', kind: 'constraint', layer: 'global' }),
      node({ id: 's', kind: 'source', layer: 'evidence' }),
      node({ id: 'p', kind: 'prospect', layer: 'prospect' }),
      node({ id: 'v', kind: 'validation', layer: 'evidence' }),
    ];
    const layout = buildSpatialLayout(projection(nodes));
    expect(layout.hubNodes.map((view) => view.node.id)).toEqual(['hub']);
    expect(layout.canopyNodes.map((view) => view.node.id)).toEqual(['c']);
    expect(layout.evidenceNodes.map((view) => view.node.id).sort()).toEqual(['s', 'v']);
    expect(layout.prospectNodes.map((view) => view.node.id)).toEqual(['p']);
    expect(layout.visibleNodeCount).toBe(0);
  });

  it('dims unrelated nodes in focus mode but keeps blockers pinned', () => {
    const nodes = [
      node({ id: 'focus', kind: 'step', moduleId: 'm1' as never }),
      node({ id: 'related', kind: 'tool', moduleId: 'm1' as never }),
      node({ id: 'unrelated', kind: 'step', moduleId: 'm2' as never }),
      node({ id: 'blocker', kind: 'blocker', moduleId: 'm3' as never, status: 'blocked' }),
    ];
    const layout = buildSpatialLayout(projection(nodes), {
      focusScopeId: 'focus',
      expandedBranchIds: ['module:m1', 'module:m2', 'module:m3'],
    });
    const byId = new Map(layout.visibleNodes.map((visible) => [visible.id, visible]));
    expect(byId.has('focus')).toBe(true);
    // Branch membership differs per module, so check dimming through branch views.
    const allViews = layout.branches.flatMap((branch) => branch.nodes);
    expect(allViews.find((view) => view.node.id === 'unrelated')?.dimmed).toBe(true);
    expect(allViews.find((view) => view.node.id === 'blocker')?.dimmed).toBe(false);
  });

  it('summarises aggregated hidden counts as text', () => {
    expect(hiddenCountsSummary({ branches: 1, nodes: 4, edges: 2, byKind: {} }, { branchCount: 1, nodeCount: 0, edgeCount: 0, collapsedNodes: 0, byKind: {} })).toBe(
      '已折叠 2 条支线 · 4 个节点 · 2 条连线',
    );
    expect(hiddenCountsSummary({ branches: 0, nodes: 0, edges: 0, byKind: {} }, { branchCount: 0, nodeCount: 0, edgeCount: 0, collapsedNodes: 0, byKind: {} })).toBeNull();
  });
});

describe('module paging (central hub 4 slots per page)', () => {
  const modules = Array.from({ length: 6 }, (_, index) => ({ module: { id: `m-${index}`, title: `模块 ${index}` } })) as never[];

  it('computes pages and clamps out-of-range values', () => {
    expect(paginateModules(modules, 0, 4)).toMatchObject({ page: 0, pageCount: 2, startIndex: 0, endIndex: 4 });
    expect(paginateModules(modules, 5, 4)).toMatchObject({ page: 1, startIndex: 4, endIndex: 6 });
    expect(paginateModules(modules, -3, 4).page).toBe(0);
  });

  it('finds the page containing a module', () => {
    expect(pageForModule(modules, 'm-0', 4)).toBe(0);
    expect(pageForModule(modules, 'm-5', 4)).toBe(1);
    expect(pageForModule(modules, 'missing', 4)).toBe(0);
  });
});

describe('focus helpers', () => {
  const spatial = projection([
    node({ id: 'focus', kind: 'blocker', moduleId: 'm1' as never, runId: 'r1' as never }),
    node({ id: 'same-module', kind: 'patch', moduleId: 'm1' as never }),
    node({ id: 'same-run', kind: 'step', runId: 'r1' as never, moduleId: 'm2' as never }),
    node({ id: 'neighbour', kind: 'tool' }),
  ], [{ id: 'e1', from: 'focus', to: 'neighbour', kind: 'trace', label: '' }]);

  it('includes the focused entity, module/run siblings and edge neighbours', () => {
    const related = focusRelatedNodeIds(spatial, 'focus');
    expect(related.has('focus')).toBe(true);
    expect(related.has('same-module')).toBe(true);
    expect(related.has('same-run')).toBe(true);
    expect(related.has('neighbour')).toBe(true);
  });

  it('derives related module ids from spatial nodes', () => {
    const snapshot = {
      spatial,
      modules: [],
    } as never;
    const related = focusRelatedModuleIds(snapshot, 'focus');
    expect(related.has('m1')).toBe(true);
    expect(related.has('m2')).toBe(true);
  });
});

describe('spatialBranchId', () => {
  it('prefers business ids over canvas coordinates', () => {
    expect(spatialBranchId(node({ id: 'n', kind: 'step', runId: 'r1' as never }))).toBe('run:r1');
    expect(spatialBranchId(node({ id: 'n', kind: 'step', moduleId: 'm1' as never }))).toBe('module:m1');
    expect(spatialBranchId(node({ id: 'n', kind: 'step' }))).toBe('kind:step');
  });
});
