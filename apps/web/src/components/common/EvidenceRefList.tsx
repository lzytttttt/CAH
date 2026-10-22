/** Renders typed evidence references (source spans / artifact versions / assumptions / tool results). */
import type { EvidenceRef } from '@ca/contracts';
import { BookOpen, GitCommitHorizontal, HelpCircle, Wrench } from 'lucide-react';
import { truncateText } from '../../lib/format';
import { Chip } from './ui';

export function describeEvidenceRef(ref: EvidenceRef): { kindLabel: string; title: string; detail: string; icon: JSX.Element } {
  switch (ref.kind) {
    case 'source_span':
      return {
        kindLabel: '资料片段',
        title: `${ref.span.locator.kind === 'text_lines' ? `行 ${ref.span.locator.startLine}–${ref.span.locator.endLine}` : ref.span.locator.kind === 'json_pointer' ? ref.span.locator.pointer : ref.span.locator.kind === 'csv_key' ? `主键 ${ref.span.locator.primaryKeyValue}` : `CSV 行 ${ref.span.locator.rowNumbers.join(',')}`}`,
        detail: ref.span.excerpt,
        icon: <BookOpen aria-hidden="true" className="h-3 w-3" />,
      };
    case 'artifact_version':
      return {
        kindLabel: '成果版本',
        title: `版本 ${ref.versionId.slice(0, 8)}`,
        detail: `模块 ${ref.moduleId.slice(0, 8)}`,
        icon: <GitCommitHorizontal aria-hidden="true" className="h-3 w-3" />,
      };
    case 'user_assumption':
      return {
        kindLabel: '用户假设',
        title: ref.assumptionId,
        detail: ref.text,
        icon: <HelpCircle aria-hidden="true" className="h-3 w-3" />,
      };
    case 'tool_result':
      return {
        kindLabel: '工具结果',
        title: ref.toolResult.toolCallId.slice(0, 8),
        detail: ref.toolResult.summary,
        icon: <Wrench aria-hidden="true" className="h-3 w-3" />,
      };
  }
}

export function EvidenceRefList({ refs, emptyLabel = '没有绑定证据' }: { refs: readonly EvidenceRef[]; emptyLabel?: string }): JSX.Element {
  if (refs.length === 0) return <p className="text-[11px] text-ink-secondary">{emptyLabel}</p>;
  return (
    <ul className="space-y-1">
      {refs.map((ref, index) => {
        const described = describeEvidenceRef(ref);
        return (
          <li key={`${ref.kind}-${index}`} className="rounded border border-white/10 bg-black/20 px-1.5 py-1 text-[11px]">
            <div className="flex items-center gap-1.5 text-ink-secondary">
              {described.icon}
              <Chip>{described.kindLabel}</Chip>
              <span className="text-ink-primary">{truncateText(described.title, 80)}</span>
            </div>
            {described.detail && <p className="mt-0.5 leading-4 text-ink-secondary">{truncateText(described.detail, 220)}</p>}
          </li>
        );
      })}
    </ul>
  );
}
