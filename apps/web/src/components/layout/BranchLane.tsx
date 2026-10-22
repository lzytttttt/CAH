/**
 * Two-sided local execution lanes (BranchLane).
 *
 * Shows at most 3 expanded branches and 12 working nodes from the server
 * projection, draws at most 16 SVG connectors between visible nodes, and
 * aggregates everything hidden with explicit counts (never silently dropped).
 */
import { useEffect, useRef, useState } from 'react';
import type { SpatialNode, SpatialNodeKind } from '@ca/contracts';
import { Bot, ChevronDown, ChevronRight, CircleDot, CornerDownRight, Crosshair, ExternalLink, FileSearch, Focus, GitBranch, ShieldAlert, Wrench } from 'lucide-react';
import { truncateText } from '../../lib/format';
import { spatialStatusLabel, spatialStatusTone } from '../../lib/labels';
import { hiddenCountsSummary, type SpatialLayout } from '../../lib/layout';
import type { PanelContext, PanelId } from '../../state/viewStore';
import { Button, Chip, EmptyState, StatusBadge, cn } from '../common/ui';

export interface BranchLaneProps {
  layout: SpatialLayout;
  selectedEntityId: string | null;
  focusScopeId: string | null;
  onSelectEntity: (node: SpatialNode) => void;
  onToggleBranch: (branchId: string) => void;
  onFocusEntity: (node: SpatialNode) => void;
  onOpenPanel: (panel: PanelId, context: PanelContext | null) => void;
  onOpenEvidenceTab: (tab: 'sources' | 'spans' | 'tools' | 'validation') => void;
  onSelectModule: (moduleId: string) => void;
}

const NODE_KIND_LABEL: Record<SpatialNodeKind, string> = {
  hub: '中心',
  module: '模块',
  run: '运行',
  step: '步骤',
  tool: '工具',
  patch: '候选变更',
  blocker: '阻塞',
  source: '资料',
  span: '片段',
  validation: '验证',
  recipe: '配方',
  prospect: '综合成果',
  constraint: '约束',
};

function nodeIcon(kind: SpatialNodeKind): JSX.Element {
  switch (kind) {
    case 'run':
      return <CircleDot aria-hidden="true" className="h-3.5 w-3.5" />;
    case 'step':
      return <GitBranch aria-hidden="true" className="h-3.5 w-3.5" />;
    case 'tool':
      return <Wrench aria-hidden="true" className="h-3.5 w-3.5" />;
    case 'patch':
      return <FileSearch aria-hidden="true" className="h-3.5 w-3.5" />;
    case 'blocker':
      return <ShieldAlert aria-hidden="true" className="h-3.5 w-3.5" />;
    case 'recipe':
      return <Bot aria-hidden="true" className="h-3.5 w-3.5" />;
    default:
      return <CornerDownRight aria-hidden="true" className="h-3.5 w-3.5" />;
  }
}

interface EdgePath {
  id: string;
  label: string;
  fromId: string;
  toId: string;
  d: string;
  active: boolean;
}

export function BranchLane(props: BranchLaneProps): JSX.Element {
  const { layout, selectedEntityId, focusScopeId, onSelectEntity, onToggleBranch, onFocusEntity, onOpenPanel, onOpenEvidenceTab, onSelectModule } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [paths, setPaths] = useState<EdgePath[]>([]);
  const hiddenText = hiddenCountsSummary(layout.hidden, layout.backendHidden);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof window === 'undefined') return undefined;
    const measure = (): void => {
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const next: EdgePath[] = [];
      for (const edge of layout.visibleEdges) {
        const fromEl = container.querySelector<HTMLElement>(`[data-node-id="${edge.from}"]`);
        const toEl = container.querySelector<HTMLElement>(`[data-node-id="${edge.to}"]`);
        if (!fromEl || !toEl) continue;
        const a = fromEl.getBoundingClientRect();
        const b = toEl.getBoundingClientRect();
        const fromCenterX = a.left - rect.left + a.width / 2;
        const fromY = a.top - rect.top + a.height / 2;
        const toCenterX = b.left - rect.left + b.width / 2;
        const toY = b.top - rect.top + b.height / 2;
        const fromX = fromCenterX < toCenterX ? a.right - rect.left : a.left - rect.left;
        const toX = fromCenterX < toCenterX ? b.left - rect.left : b.right - rect.left;
        const bend = Math.max(18, Math.min(80, Math.abs(toX - fromX) / 2));
        const d = `M ${fromX.toFixed(1)} ${fromY.toFixed(1)} C ${(fromX + bend).toFixed(1)} ${fromY.toFixed(1)}, ${(toX - bend).toFixed(1)} ${toY.toFixed(1)}, ${toX.toFixed(1)} ${toY.toFixed(1)}`;
        next.push({
          id: edge.id,
          label: edge.label || edge.kind,
          fromId: edge.from,
          toId: edge.to,
          d,
          active: Boolean(layout.branches.find((branch) => branch.active)?.nodes.some((view) => view.node.id === edge.from || view.node.id === edge.to)),
        });
      }
      setPaths(next);
    };
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => measure()) : null;
    observer?.observe(container);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [layout.visibleEdges, layout.branches, hiddenText]);

  return (
    <section className="ca-solid relative flex min-h-0 flex-col rounded-lg border border-white/10" aria-label="执行支线区">
      <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-white/10 px-2.5 py-1.5">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink-primary">
          <GitBranch aria-hidden="true" className="h-4 w-4 text-anchor" />
          执行支线
          <Chip title="最多 3 条展开支线 / 12 个工作节点 / 16 条可见连线（不计中心锚点与固定控制）">
            {layout.branches.filter((branch) => branch.expanded).length} 展开 · {layout.visibleNodeCount}/12 节点 · {layout.visibleEdgeCount}/16 连线
          </Chip>
        </h2>
        <div className="flex items-center gap-1.5">
          {layout.activeBranchId && <StatusBadge label="活动支线优先保留" tone="accent" ariaLabel="支线优先级" />}
          {hiddenText && <span className="text-[11px] text-ink-secondary">{hiddenText}</span>}
        </div>
      </div>

      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2 ca-scroll">
        {paths.length > 0 && (
          <svg aria-hidden="true" className="pointer-events-none absolute inset-0 z-0 h-full w-full">
            {paths.map((path) => (
              <path
                key={path.id}
                d={path.d}
                fill="none"
                stroke={path.active ? 'rgba(245, 158, 11, 0.45)' : 'rgba(167, 176, 192, 0.28)'}
                strokeWidth={path.active ? 1.6 : 1.2}
                strokeDasharray={path.active ? undefined : '4 3'}
              >
                <title>{`${path.label}：${path.fromId} → ${path.toId}`}</title>
              </path>
            ))}
          </svg>
        )}

        {layout.branches.length === 0 && (
          <EmptyState compact title="当前没有执行支线" description="在中心锚点选择一个模块并输入意图后，运行会在这里产生可审阅的步骤节点。" />
        )}

        <div className="relative z-10 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {layout.branches.map((branch) => (
            <div key={branch.id} className="flex min-w-0 flex-col rounded border border-white/10 bg-black/20">
              <div className="flex items-center justify-between gap-1.5 border-b border-white/10 px-2 py-1.5">
                <div className="min-w-0">
                  <p className={cn('truncate text-xs font-medium', branch.active ? 'text-anchor' : 'text-ink-primary')} title={branch.title}>
                    {branch.active ? '● ' : ''}
                    {branch.title}
                  </p>
                  <p className="text-[11px] text-ink-secondary">
                    {branch.summary}
                    {branch.hiddenEdgeCount > 0 ? ` · 折叠 ${branch.hiddenEdgeCount} 条连线` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <StatusBadge label={spatialStatusLabel(branch.status)} tone={spatialStatusTone(branch.status)} ariaLabel="支线状态" />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onToggleBranch(branch.id)}
                    aria-expanded={branch.expanded}
                    disabledReason={branch.active && branch.expanded ? '活动支线始终优先保留；可先切换活动支线再折叠。' : null}
                  >
                    {branch.expanded ? '折叠' : '展开'}
                  </Button>
                </div>
              </div>

              {branch.expanded ? (
                <ul className="flex flex-col gap-1.5 p-1.5">
                  {branch.nodes.map(({ node, dimmed, pinned }) => (
                    <li key={node.id} data-node-id={node.id} className={cn('min-w-0', dimmed && 'ca-dimmed')}>
                      <NodeCard
                        node={node}
                        pinned={pinned}
                        dimmed={dimmed}
                        selected={selectedEntityId === node.id}
                        focused={focusScopeId === node.id}
                        onSelect={() => onSelectEntity(node)}
                        onFocus={() => onFocusEntity(node)}
                        onOpenPanel={onOpenPanel}
                        onOpenEvidenceTab={onOpenEvidenceTab}
                        onSelectModule={onSelectModule}
                      />
                    </li>
                  ))}
                  {branch.nodes.length === 0 && <li className="px-1 py-2 text-[11px] text-ink-secondary">该支线当前没有可见节点（可能受 12 节点上限影响）。</li>}
                </ul>
              ) : (
                <div className="p-1.5">
                  <p className="text-[11px] text-ink-secondary">已折叠 {branch.hiddenNodeCount} 个节点，展开后不超过总节点上限。</p>
                </div>
              )}
            </div>
          ))}
        </div>

        {layout.overflowBranches.length > 0 && (
          <div className="relative z-10 mt-2 rounded border border-white/10 bg-black/20 px-2 py-1.5">
            <p className="text-[11px] text-ink-secondary">
              超出 3 条支线上限的聚合信息（不静默丢弃）：{layout.overflowBranches.map((branch) => `${branch.title}（${branch.hiddenNodeCount} 节点）`).join('、')}
            </p>
            <div className="mt-1 flex flex-wrap gap-1">
              {layout.overflowBranches.map((branch) => (
                <Button key={branch.id} size="sm" variant="quiet" onClick={() => onToggleBranch(branch.id)}>
                  切换到 {branch.title}
                </Button>
              ))}
            </div>
          </div>
        )}

        <ul className="ca-sr-only" aria-label="可见连线列表">
          {layout.visibleEdges.map((edge) => (
            <li key={edge.id}>{`${edge.kind} 连线：${edge.from} → ${edge.to}`}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}

interface NodeCardProps {
  node: SpatialNode;
  pinned: boolean;
  dimmed: boolean;
  selected: boolean;
  focused: boolean;
  onSelect: () => void;
  onFocus: () => void;
  onOpenPanel: (panel: PanelId, context: PanelContext | null) => void;
  onOpenEvidenceTab: (tab: 'sources' | 'spans' | 'tools' | 'validation') => void;
  onSelectModule: (moduleId: string) => void;
}

function NodeCard({ node, pinned, dimmed, selected, focused, onSelect, onFocus, onOpenPanel, onOpenEvidenceTab, onSelectModule }: NodeCardProps): JSX.Element {
  const tabIndex = dimmed ? -1 : undefined;
  const primaryAction = (): void => {
    switch (node.kind) {
      case 'blocker':
        onOpenPanel('repair', { blockerId: node.refId ?? undefined, moduleId: node.moduleId ?? undefined });
        break;
      case 'patch':
        onOpenPanel('review', { patchId: node.refId ?? undefined, moduleId: node.moduleId ?? undefined });
        break;
      case 'run':
      case 'step':
      case 'tool':
        onOpenPanel('events', { runId: node.runId ?? undefined, moduleId: node.moduleId ?? undefined });
        break;
      default:
        onSelect();
    }
  };
  const secondary = (): JSX.Element | null => {
    switch (node.kind) {
      case 'source':
      case 'span':
        return (
          <Button size="sm" variant="ghost" tabIndex={tabIndex} onClick={() => onOpenEvidenceTab('spans')}>
            查看片段
          </Button>
        );
      case 'validation':
        return (
          <Button size="sm" variant="ghost" tabIndex={tabIndex} onClick={() => onOpenEvidenceTab('validation')}>
            校验详情
          </Button>
        );
      case 'recipe':
        return (
          <Button size="sm" variant="ghost" tabIndex={tabIndex} onClick={() => onOpenPanel('recipes', { recipeId: node.refId ?? undefined })}>
            配方详情
          </Button>
        );
      case 'module':
        return (
          <Button size="sm" variant="ghost" tabIndex={tabIndex} onClick={() => node.moduleId && onSelectModule(node.moduleId)}>
            定位模块
          </Button>
        );
      default:
        return (
          <Button size="sm" variant="ghost" tabIndex={tabIndex} onClick={() => onOpenPanel('events', { runId: node.runId ?? undefined })}>
            诊断
          </Button>
        );
    }
  };

  return (
    <div
      className={cn(
        'flex min-h-[84px] flex-col gap-1 rounded border bg-elevated/90 px-2 py-1.5 transition-colors duration-feedback',
        selected ? 'border-anchor/60 bg-anchor/[0.05]' : pinned ? 'border-pending/40' : 'border-white/10 hover:border-white/25',
      )}
      data-node-id={node.id}
    >
      <button
        type="button"
        className="ca-focus-ring flex min-h-10 w-full flex-col items-start gap-0.5 rounded text-left"
        onClick={primaryAction}
        aria-label={`${NODE_KIND_LABEL[node.kind]}：${node.title}，状态 ${spatialStatusLabel(node.status)}`}
        aria-pressed={selected}
        tabIndex={tabIndex}
        aria-hidden={dimmed || undefined}
        data-selected={selected || undefined}
      >
        <span className="flex w-full items-start justify-between gap-1.5">
          <span className="flex min-w-0 items-center gap-1 text-xs font-medium text-ink-primary">
            <span className="text-ink-secondary">{nodeIcon(node.kind)}</span>
            <span className="truncate">{node.title}</span>
            {node.badgeCount != null && node.badgeCount > 0 && (
              <span className="rounded-full border border-pending/40 bg-pending/10 px-1 text-[10px] text-pending" title="待处理数量">
                {node.badgeCount}
              </span>
            )}
          </span>
          <StatusBadge label={spatialStatusLabel(node.status)} tone={spatialStatusTone(node.status)} ariaLabel="节点状态" />
        </span>
        <span className="flex w-full items-center gap-1 text-[11px] text-ink-secondary">
          <span className="rounded border border-white/10 px-1 text-[10px]">{NODE_KIND_LABEL[node.kind]}</span>
          <span className="min-w-0 truncate">{truncateText(node.summary || '—', 60)}</span>
        </span>
      </button>
      <div className="mt-auto flex flex-wrap items-center gap-1">
        {secondary()}
        <Button
          size="sm"
          variant="ghost"
          tabIndex={tabIndex}
          onClick={onFocus}
          icon={<Focus aria-hidden="true" className="h-3 w-3" />}
          aria-label={`聚焦 ${node.title}`}
          aria-pressed={focused}
        >
          聚焦
        </Button>
      </div>
    </div>
  );
}

/** Small helper for evidence nodes that need a direct tab switch. */
export function EvidenceJump({ onOpen }: { onOpen: () => void }): JSX.Element {
  return (
    <Button size="sm" variant="ghost" onClick={onOpen} icon={<ExternalLink aria-hidden="true" className="h-3 w-3" />}>
      打开证据区
    </Button>
  );
}

export { Crosshair, ChevronDown, ChevronRight };
