/**
 * Z-1 Evidence Depth: sources, spans, tool traces and deterministic validation
 * details. Text-first, internally scrollable, with incremental rendering so a
 * large evidence set never blocks the workbench.
 */
import { useMemo, useState } from 'react';
import type { SourceSpan, TaskSnapshot } from '@ca/contracts';
import { ChevronDown, ChevronRight, Database, FileText, FlaskConical, ListTree, ShieldCheck } from 'lucide-react';
import { formatTimestamp, safeJsonPreview, truncateText } from '../../lib/format';
import {
  availabilityLabel,
  availabilityTone,
  checkStatusLabel,
  checkStatusTone,
  eventTypeLabel,
  trustLevelLabel,
  trustLevelTone,
  validationLayerLabel,
  validationStatusLabel,
  validationStatusTone,
} from '../../lib/labels';
import type { ElevationLayer, EvidenceTab } from '../../state/viewStore';
import { Button, Card, Chip, EmptyState, StatusBadge, Tabs, TextInput, cn } from '../common/ui';

const CHUNK = 20;

export interface EvidenceDepthProps {
  snapshot: TaskSnapshot;
  layer: ElevationLayer;
  open: boolean;
  tab: EvidenceTab;
  intentSourceIds: readonly string[];
  onToggleOpen: (open: boolean) => void;
  onTabChange: (tab: EvidenceTab) => void;
  onOpenSourcesPanel: () => void;
  onOpenVersions: (moduleId: string) => void;
  onToggleIntentSource: (sourceId: string) => void;
  onFocusSpan: (span: SourceSpan) => void;
  onFocusEntity: (entityId: string) => void;
}

export function EvidenceDepth(props: EvidenceDepthProps): JSX.Element {
  const { snapshot, layer, open, tab, intentSourceIds, onToggleOpen, onTabChange, onOpenSourcesPanel, onOpenVersions, onToggleIntentSource, onFocusSpan, onFocusEntity } = props;
  const expanded = open || layer === 'evidence';
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(CHUNK);
  const sources = snapshot.sources;
  const spans = snapshot.spans;
  const validations = snapshot.validations;
  const toolEvents = useMemo(
    () => snapshot.events.filter((event) => event.category === 'tool' || event.category === 'execution').slice().reverse(),
    [snapshot.events],
  );
  const queryLower = query.trim().toLowerCase();
  const filteredSources = sources.filter((source) => (queryLower ? source.name.toLowerCase().includes(queryLower) : true));
  const filteredSpans = spans.filter((span) => (queryLower ? span.excerpt.toLowerCase().includes(queryLower) : true));

  return (
    <section className={cn('ca-solid border-t border-white/10', layer === 'evidence' && 'ring-1 ring-inset ring-anchor/20')} aria-label="Z-1 证据区">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5">
        <button
          type="button"
          className="ca-focus-ring flex min-h-8 items-center gap-1.5 rounded px-1 text-xs font-medium text-ink-primary"
          aria-expanded={expanded}
          aria-controls="evidence-depth-body"
          onClick={() => onToggleOpen(!expanded)}
        >
          {expanded ? <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" /> : <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />}
          <Database aria-hidden="true" className="h-3.5 w-3.5 text-prospect" />
          证据区（Z-1）
        </button>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip>资料 {sources.length}</Chip>
          <Chip>片段 {spans.length}</Chip>
          <Chip>验证 {validations.length}</Chip>
          {snapshot.spans.length > 0 && <Chip>工具轨迹 {toolEvents.length} 条事件</Chip>}
          {layer === 'evidence' && <StatusBadge label="当前层级：Z-1 证据" tone="prospect" />}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {sources.some((source) => source.availability !== 'available') && (
            <StatusBadge label="有资料版本不可用" tone="pending" ariaLabel="资料可用性" />
          )}
          <Button size="sm" variant="ghost" onClick={onOpenSourcesPanel}>
            资料面板
          </Button>
        </div>
      </div>

      {expanded && (
        <div id="evidence-depth-body" className="ca-fade-in border-t border-white/10 px-2.5 pb-2.5">
          <div className="flex flex-wrap items-center gap-2 py-1.5">
            <Tabs
              ariaLabel="证据分类"
              value={tab}
              onChange={(next) => {
                onTabChange(next);
                setLimit(CHUNK);
              }}
              tabs={[
                { id: 'sources', label: '资料', count: sources.length },
                { id: 'spans', label: '检索片段', count: spans.length },
                { id: 'tools', label: '工具与运行轨迹', count: toolEvents.length },
                { id: 'validation', label: '验证报告', count: validations.length },
              ]}
            />
            <div className="ml-auto w-56">
              <TextInput
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setLimit(CHUNK);
                }}
                placeholder="按名称或片段内容过滤…"
                aria-label="过滤证据"
              />
            </div>
          </div>

          <div className="ca-scroll max-h-[38vh] overflow-y-auto pr-1">
            {tab === 'sources' && (
              <div className="grid gap-1.5 md:grid-cols-2 xl:grid-cols-3">
                {filteredSources.slice(0, limit).map((source) => (
                  <Card key={source.sourceId} className="min-w-0 !bg-black/20">
                    <div className="flex items-start justify-between gap-1.5">
                      <p className="flex min-w-0 items-center gap-1 text-xs font-medium text-ink-primary">
                        <FileText aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-ink-secondary" />
                        <span className="truncate">{source.name}</span>
                      </p>
                      <StatusBadge label={availabilityLabel(source.availability)} tone={availabilityTone(source.availability)} ariaLabel="资料可用性" />
                    </div>
                    <p className="mt-1 text-[11px] text-ink-secondary">
                      v{source.version} · {source.spanCount} 个片段 · {truncateText(source.sourceId, 8)}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <StatusBadge label={`信任：${trustLevelLabel(source.trustLevel)}`} tone={trustLevelTone(source.trustLevel)} ariaLabel="资料信任级别" />
                      <Button size="sm" variant="ghost" onClick={() => onFocusEntity(`node-source-${source.sourceId}`)}>
                        定位节点
                      </Button>
                      <Button
                        size="sm"
                        variant={intentSourceIds.includes(source.sourceId) ? 'secondary' : 'ghost'}
                        aria-pressed={intentSourceIds.includes(source.sourceId)}
                        onClick={() => onToggleIntentSource(source.sourceId)}
                      >
                        {intentSourceIds.includes(source.sourceId) ? '已选为本次输入' : '选为本次输入'}
                      </Button>
                    </div>
                  </Card>
                ))}
                {filteredSources.length === 0 && <div className="col-span-full"><EmptyState compact title="没有匹配的资料" description="导入 TXT / Markdown / JSON / CSV 资料后会显示在这里。" /></div>}
              </div>
            )}

            {tab === 'spans' && (
              <div className="flex flex-col gap-1.5">
                {filteredSpans.slice(0, limit).map((span) => {
                  const source = sources.find((candidate) => candidate.sourceId === span.sourceId);
                  return (
                    <div key={span.id} className="rounded border border-white/10 bg-black/20 px-2 py-1.5">
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink-secondary">
                        <Chip>{source?.name ?? span.sourceId}</Chip>
                        <Chip>v{span.version}</Chip>
                        <Chip>{describeLocator(span)}</Chip>
                        <StatusBadge label={`信任：${trustLevelLabel(source?.trustLevel ?? 'unknown')}`} tone={trustLevelTone(source?.trustLevel ?? 'unknown')} ariaLabel="片段信任级别" />
                        <span className="ml-auto">{formatTimestamp(span.createdAt)}</span>
                      </div>
                      <p className="mt-1 text-xs leading-5 text-ink-primary">{span.excerpt}</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <Button size="sm" variant="ghost" onClick={() => onFocusSpan(span)}>
                          聚焦片段
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => onToggleIntentSource(span.sourceId)}>
                          {intentSourceIds.includes(span.sourceId) ? '已选为本次输入' : '选为本次输入'}
                        </Button>
                      </div>
                    </div>
                  );
                })}
                {filteredSpans.length === 0 && <EmptyState compact title="没有匹配的检索片段" description="片段来自真实资料检索；搜索摘要不会被伪装成全文证据。" />}
              </div>
            )}

            {tab === 'tools' && (
              <div className="flex flex-col gap-1.5">
                {toolEvents.slice(0, limit).map((event) => (
                  <div key={event.eventId} className="rounded border border-white/10 bg-black/20 px-2 py-1.5">
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink-secondary">
                      <Chip>{eventTypeLabel(event.type)}</Chip>
                      <Chip>seq {event.seq}</Chip>
                      <Chip>{event.category}</Chip>
                      <span className="ml-auto">{formatTimestamp(event.timestamp)}</span>
                    </div>
                    <pre className="ca-scroll mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-ink-secondary">
                      {safeJsonPreview(event.payload, 600)}
                    </pre>
                  </div>
                ))}
                {toolEvents.length === 0 && <EmptyState compact title="还没有工具或执行轨迹" description="真实执行开始后，模型请求、工具入参与结果会记录在这里。" />}
              </div>
            )}

            {tab === 'validation' && (
              <div className="flex flex-col gap-1.5">
                {validations.length === 0 && <EmptyState compact title="还没有验证报告" description="候选成果产生后，确定性校验（L0–L4）会显示在这里。" />}
                {validations.map((validation) => {
                  const module = snapshot.modules.find((view) => view.module.id === validation.moduleId);
                  const checksEvent = snapshot.events
                    .filter((event) => event.type === 'validation.completed')
                    .find((event) => (event.payload as { validationReportId?: string }).validationReportId === validation.validationReportId);
                  const rawChecks = checksEvent ? ((checksEvent.payload as { checks?: unknown }).checks as Array<Record<string, unknown>> | undefined) ?? [] : [];
                  return (
                    <div key={validation.validationReportId} className="rounded border border-white/10 bg-black/20 px-2 py-1.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <StatusBadge label={`验证：${validationStatusLabel(validation.status)}`} tone={validationStatusTone(validation.status)} ariaLabel="验证报告状态" />
                        <span className="text-xs text-ink-primary">{module?.module.title ?? validation.moduleId}</span>
                        <span className="text-[11px] text-ink-secondary">
                          通过 {validation.checkCounts.pass} · 失败 {validation.checkCounts.fail} · 待复核 {validation.checkCounts.needsReview} · 不适用 {validation.checkCounts.notApplicable}
                        </span>
                        <span className="ml-auto text-[11px] text-ink-secondary">{formatTimestamp(validation.createdAt)}</span>
                        <Button size="sm" variant="ghost" onClick={() => module && onOpenVersions(module.module.id)}>
                          版本历史
                        </Button>
                      </div>
                      {validation.blockingFindings.length > 0 && (
                        <ul className="mt-1 list-inside list-disc space-y-0.5 text-[11px] leading-4 text-failed">
                          {validation.blockingFindings.map((finding) => (
                            <li key={finding}>{finding}</li>
                          ))}
                        </ul>
                      )}
                      {rawChecks.length > 0 && (
                        <ul className="mt-1 space-y-0.5">
                          {rawChecks.slice(0, 12).map((check, index) => {
                            const layerValue = String(check.layer ?? '—');
                            const statusValue = String(check.status ?? '—');
                            return (
                              <li key={`${validation.validationReportId}-${index}`} className="flex flex-wrap items-center gap-1.5 text-[11px]">
                                <StatusBadge label={checkStatusLabel(statusValue)} tone={checkStatusTone(statusValue)} ariaLabel="检查项状态" />
                                <Chip>{validationLayerLabel(layerValue)}</Chip>
                                <span className="text-ink-primary">{String(check.title ?? check.code ?? '检查项')}</span>
                                <span className="text-ink-secondary">{truncateText(String(check.detail ?? ''), 120)}</span>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {((tab === 'sources' && filteredSources.length > limit) ||
              (tab === 'spans' && filteredSpans.length > limit) ||
              (tab === 'tools' && toolEvents.length > limit)) && (
              <div className="mt-2">
                <Button size="sm" variant="quiet" onClick={() => setLimit((current) => current + CHUNK)} icon={<ListTree aria-hidden="true" className="h-3 w-3" />}>
                  继续显示（已渲染 {limit} 项）
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function describeLocator(span: SourceSpan): string {
  const locator = span.locator;
  switch (locator.kind) {
    case 'text_lines':
      return `行 ${locator.startLine}–${locator.endLine}`;
    case 'csv_rows':
      return `CSV 行 ${locator.rowNumbers.slice(0, 3).join(',')}${locator.rowNumbers.length > 3 ? '…' : ''}`;
    case 'csv_key':
      return `主键 ${locator.primaryKeyColumn}=${locator.primaryKeyValue}`;
    case 'json_pointer':
      return `JSON ${locator.pointer}`;
  }
}

export { FlaskConical, ShieldCheck };
