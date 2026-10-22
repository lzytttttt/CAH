/**
 * High-ledge composite prospects (top-right).
 *
 * Shows candidates produced from accepted upstream modules, their required /
 * missing inputs and the real next action. Never overlays the hub, run controls
 * or status bar; no simulated final content is rendered.
 */
import type { ModuleView, ProspectProjection } from '@ca/contracts';
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { moduleStateLabel, moduleStateTone, prospectStateLabel, prospectStateTone, trustLevelLabel } from '../../lib/labels';
import { Button, Card, StatusBadge, cn } from '../common/ui';

export interface HighLedgeAttractorProps {
  prospects: ProspectProjection[];
  modules: ModuleView[];
  collapsed: boolean;
  onToggleCollapsed: (collapsed: boolean) => void;
  onGenerate: (prospect: ProspectProjection) => void;
  onSelectModule: (moduleId: string) => void;
  onOpenSources: () => void;
  onOpenProspectsNote: () => void;
  busy: boolean;
}

export function HighLedgeAttractor({ prospects, modules, collapsed, onToggleCollapsed, onGenerate, onSelectModule, onOpenSources, busy }: HighLedgeAttractorProps): JSX.Element {
  return (
    <Card
      as="section"
      className="min-w-0"
      ariaLabel="综合成果预览区"
      title={
        <span className="flex items-center gap-1.5">
          <Sparkles aria-hidden="true" className="h-4 w-4 text-prospect" />
          综合成果（高台）
          <span className="rounded border border-prospect/30 bg-prospect/10 px-1 text-[10px] text-prospect">候选</span>
        </span>
      }
      subtitle="依赖满足只代表允许生成，不代表成果已完成；生成后仍需验证与人工接受。"
      actions={
        <Button size="sm" variant="quiet" onClick={() => onToggleCollapsed(!collapsed)} aria-expanded={!collapsed}>
          {collapsed ? <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" /> : <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />}
          {collapsed ? '展开' : '收起'}
        </Button>
      }
    >
      {collapsed ? (
        <p className="text-[11px] text-ink-secondary">
          {prospects.length} 个候选 · 缺少输入 {prospects.filter((prospect) => prospect.missingInputs.length > 0).length} 个 · 可生成 {prospects.filter((prospect) => prospect.state === 'ready').length} 个
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {prospects.length === 0 && <li className="text-xs text-ink-secondary">当前没有综合成果候选。上游成果被接受后，这里会显示可产生的综合成果及其输入要求。</li>}
          {prospects.map((prospect) => {
            const ready = prospect.state === 'ready';
            const missing = prospect.missingInputs;
            return (
              <li key={prospect.id} className={cn('rounded border px-2 py-1.5', ready ? 'border-prospect/40 bg-prospect/[0.05]' : 'border-white/10 bg-black/20')}>
                <div className="flex items-start justify-between gap-1.5">
                  <p className="min-w-0 text-xs font-medium text-ink-primary">{prospect.title}</p>
                  <StatusBadge label={prospectStateLabel(prospect.state)} tone={prospectStateTone(prospect.state)} ariaLabel="综合成果候选状态" />
                </div>
                {prospect.valueStatement && <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-ink-secondary">{prospect.valueStatement}</p>}
                <ul className="mt-1 space-y-0.5">
                  {prospect.requiredInputs.map((input) => {
                    const module = modules.find((view) => view.module.id === input.moduleId);
                    return (
                      <li key={`${prospect.id}-${input.moduleId}`} className="flex items-center gap-1 text-[11px]">
                        <span aria-hidden="true" className={cn('inline-block h-1 w-1 rounded-full', input.satisfied ? 'bg-accepted' : 'bg-pending')} />
                        <span className="text-ink-secondary">{input.satisfied ? '已满足' : '缺少'}：</span>
                        <button
                          type="button"
                          className="ca-focus-ring min-h-6 rounded px-0.5 text-left text-ink-primary underline decoration-white/20 underline-offset-2 hover:decoration-white/50"
                          onClick={() => onSelectModule(input.moduleId)}
                          aria-label={`定位输入模块：${input.label}`}
                        >
                          {input.label}
                        </button>
                        <StatusBadge label={moduleStateLabel(module?.module.status ?? input.moduleStatus)} tone={moduleStateTone(module?.module.status ?? input.moduleStatus)} ariaLabel="输入模块状态" />
                      </li>
                    );
                  })}
                </ul>
                {missing.length > 0 && (
                  <p className="mt-1 text-[11px] leading-4 text-pending">缺少条件：{missing.join('、')}</p>
                )}
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {ready ? (
                    <Button size="sm" variant="primary" busy={busy} onClick={() => onGenerate(prospect)} aria-label={`生成综合成果：${prospect.title}`}>
                      生成综合成果
                    </Button>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => onSelectModule(prospect.targetModuleId ?? prospect.requiredInputs.find((input) => !input.satisfied)?.moduleId ?? prospect.sourceModuleId ?? '')} disabled={!prospect.targetModuleId && prospect.requiredInputs.every((input) => input.satisfied)}>
                      补齐输入
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={onOpenSources}>
                    绑定资料
                  </Button>
                  {prospect.candidateUnverified && <span className="text-[10px] text-pending">候选摘要未验证</span>}
                  {prospect.note && <span className="text-[10px] text-ink-secondary" title={prospect.note}>· {prospect.note}</span>}
                </div>
              </li>
            );
          })}
          <li className="text-[10px] text-ink-secondary">数值/名称来自服务端投影；不显示未生成的仿真最终内容。信任级别：{trustLevelLabel('synthetic_demo')}。</li>
        </ul>
      )}
    </Card>
  );
}
