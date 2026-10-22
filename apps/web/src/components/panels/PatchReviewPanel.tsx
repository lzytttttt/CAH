/**
 * Diff review (accept / reject, per-section where allowed), evidence display and
 * L0–L4 validation findings. Acceptance is gated by the deterministic validator:
 * a failed validation never becomes "accept anyway".
 */
import { useEffect, useMemo, useState } from 'react';
import type { PatchReviewResponse, TaskSnapshot } from '@ca/contracts';
import { AlertTriangle, CheckCheck, ClipboardCheck, History, ShieldCheck, X } from 'lucide-react';
import { formatTimestamp, safeJsonPreview, truncateText } from '../../lib/format';
import {
  changeKindLabel,
  checkStatusLabel,
  checkStatusTone,
  diffStatsLabel,
  validationLayerLabel,
  validationStatusLabel,
  validationStatusTone,
} from '../../lib/labels';
import { commandEnvelope } from '../../lib/ids';
import { computeReviewGate, sectionSelectionSummary } from '../../lib/review';
import { useCommandPending, useCore, useCoreState } from '../../state/hooks';
import { EvidenceRefList } from '../common/EvidenceRefList';
import { Button, Card, Checkbox, Chip, EmptyState, ErrorNotice, LoadingBlock, SectionHeading, StatusBadge, TextArea, cn } from '../common/ui';

export interface PatchReviewPanelProps {
  snapshot: TaskSnapshot;
  initialPatchId: string | null;
  onClose: () => void;
  onOpenVersions: (moduleId: string) => void;
  onOpenRepair: () => void;
}

export function PatchReviewPanel({ snapshot, initialPatchId, onClose, onOpenVersions, onOpenRepair }: PatchReviewPanelProps): JSX.Element {
  const core = useCore();
  const state = useCoreState();
  const { pending } = useCommandPending();
  const pendingPatches = snapshot.patches.filter((patch) => patch.status === 'proposed');
  const fallbackPatchId = pendingPatches[0]?.patchId ?? null;
  const patchId = initialPatchId ?? fallbackPatchId;
  const [review, setReview] = useState<PatchReviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [acceptMode, setAcceptMode] = useState<'all' | 'sections'>('all');
  const [selectedSections, setSelectedSections] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [showReject, setShowReject] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReview(null);
    setLoadError(null);
    if (!patchId) return () => undefined;
    setLoading(true);
    void core
      .read('读取差异审阅', (client) => client.getPatchReview(patchId))
      .then((result) => {
        if (cancelled) return;
        if (!result) {
          setLoadError('差异读取失败；请检查连接或稍后重试。');
          return;
        }
        setReview(result);
        setSelectedSections([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [core, patchId]);

  const currentAcceptedVersionId = useMemo(() => {
    if (!review) return null;
    const moduleView = snapshot.modules.find((view) => view.module.id === review.patch.moduleId);
    return moduleView?.acceptance.acceptedVersionId ?? null;
  }, [review, snapshot.modules]);

  const gate = useMemo(() => {
    if (!review) return null;
    return computeReviewGate({
      patch: review.patch,
      diff: review.diff,
      validation: review.validation,
      currentAcceptedVersionId,
    });
  }, [review, currentAcceptedVersionId]);

  useEffect(() => {
    if (gate && selectedSections.length === 0) setSelectedSections(gate.defaultSelectedSectionIds);
  }, [gate, selectedSections.length]);

  if (!patchId) {
    return <EmptyState title="没有待接受的变更" description="候选修改只有在真实运行产生并通过校验后才会出现在这里；已拒绝或已接受的差异会保留在版本历史与事件中。" icon={<ClipboardCheck aria-hidden="true" className="h-6 w-6" />} />;
  }

  const accept = async (mode: 'all' | 'sections'): Promise<void> => {
    if (!review || !gate) return;
    const validationId = review.validation?.id;
    if (!validationId) return;
    const sections = mode === 'sections' ? selectedSections : [];
    const envelope = commandEnvelope(snapshot.task.revision);
    const result = await core.runCommand(
      mode === 'sections' ? '按章节接受变更' : '接受变更',
      (client) =>
        client.acceptPatch(review.patch.id, {
          ...envelope,
          expectedRevision: snapshot.task.revision,
          validationReportId: validationId,
          acceptMode: mode,
          sectionIds: sections,
          note: note.trim(),
        }),
      { successNotice: '候选已接受：新版本由后端事务提交。' },
    );
    if (result) onClose();
  };

  const reject = async (): Promise<void> => {
    if (!review) return;
    const reason = rejectReason.trim();
    if (reason.length === 0) return;
    const envelope = commandEnvelope(snapshot.task.revision);
    const result = await core.runCommand(
      '拒绝变更',
      (client) => client.rejectPatch(review.patch.id, { ...envelope, expectedRevision: snapshot.task.revision, reason }),
      { successNotice: '已拒绝该候选；已接受成果未改变。' },
    );
    if (result) onClose();
  };

  return (
    <div className="flex flex-col gap-2.5">
      {loading && <LoadingBlock label="正在读取差异与校验报告…" />}
      {loadError && <ErrorNotice compact title="差异读取失败" message={loadError} guidance={['已接受成果不受影响。可以刷新后重试。']} onRetry={() => { setReview(null); setLoadError(null); }} />}

      {review && (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge label={`候选状态：${review.patch.status === 'proposed' ? '待审阅' : review.patch.status}`} tone={review.patch.status === 'proposed' ? 'pending' : 'neutral'} ariaLabel="候选状态" />
            <StatusBadge label={`验证：${validationStatusLabel(review.validation?.status)}`} tone={validationStatusTone(review.validation?.status)} ariaLabel="校验状态" />
            <Chip>模块：{snapshot.modules.find((view) => view.module.id === review.patch.moduleId)?.module.title ?? review.patch.moduleId.slice(0, 8)}</Chip>
            <Chip>类型：{review.patch.moduleKind}</Chip>
            <Chip>基线：{review.patch.baseVersionId ? review.patch.baseVersionId.slice(0, 8) : '首次版本'}</Chip>
            <Chip>候选哈希：{review.patch.candidateHash.slice(0, 8)}</Chip>
            <span className="ml-auto text-[11px] text-ink-secondary">创建于 {formatTimestamp(review.patch.createdAt)}</span>
          </div>

          <Card title="候选说明" subtitle={review.patch.description}>
            <p className="text-[11px] text-ink-secondary">{diffStatsLabel(review.diff.stats)} · 变更摘要：{review.patch.changeSummary.note || '无补充说明'}</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {review.patch.changeSummary.changedSections.map((section) => (
                <Chip key={section}>修改：{section}</Chip>
              ))}
              {review.patch.changeSummary.addedSections.map((section) => (
                <Chip key={section}>新增：{section}</Chip>
              ))}
              {review.patch.changeSummary.removedSections.map((section) => (
                <Chip key={section}>删除：{section}</Chip>
              ))}
              {review.patch.changeSummary.affectedRows > 0 && <Chip>影响 {review.patch.changeSummary.affectedRows} 行</Chip>}
            </div>
            <div className="mt-1.5">
              <p className="text-[11px] font-medium text-ink-secondary">证据引用</p>
              <EvidenceRefList refs={review.patch.evidenceRefs} emptyLabel="该候选未绑定证据引用；涉及事实的陈述应标记为待验证" />
            </div>
            <details className="mt-1.5">
              <summary className="ca-focus-ring min-h-8 cursor-pointer rounded text-[11px] text-ink-secondary">查看候选内容预览</summary>
              <pre className="ca-scroll mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-white/10 bg-black/25 p-2 font-mono text-[11px] leading-4 text-ink-secondary">
                {safeJsonPreview(review.patch.candidate, 2000)}
              </pre>
            </details>
          </Card>

          <Card title={`差异（${review.diff.entries.length} 个章节 / 区域）`} subtitle="文本差异用于审阅，不直接作为无校验执行脚本。">
            <ul className="space-y-1.5">
              {review.diff.entries.map((entry, index) => (
                <li key={`${entry.sectionId ?? 'entry'}-${index}`} className="rounded border border-white/10 bg-black/20 px-2 py-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge label={changeKindLabel(entry.change)} tone={entry.change === 'added' ? 'success' : entry.change === 'removed' ? 'danger' : entry.change === 'changed' ? 'pending' : 'muted'} ariaLabel="差异类型" />
                    <span className="text-xs text-ink-primary">{entry.title}</span>
                    {entry.sectionId && <Chip>章节 ID：{entry.sectionId}</Chip>}
                    <span className="text-[11px] text-ink-secondary">{entry.summary}</span>
                  </div>
                  {(entry.beforeExcerpt || entry.afterExcerpt) && (
                    <div className="mt-1 grid gap-1 md:grid-cols-2">
                      <div className="rounded border border-failed/20 bg-failed/[0.04] p-1.5">
                        <p className="text-[10px] text-ink-secondary">接受前（基线）</p>
                        <pre className="ca-scroll mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-ink-secondary">{truncateText(entry.beforeExcerpt, 1200) || '—'}</pre>
                      </div>
                      <div className="rounded border border-accepted/20 bg-accepted/[0.04] p-1.5">
                        <p className="text-[10px] text-ink-secondary">候选内容</p>
                        <pre className="ca-scroll mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-ink-primary">{truncateText(entry.afterExcerpt, 1200) || '—'}</pre>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </Card>

          <Card title="确定性校验报告（L0–L4）" subtitle="只有 L0–L3 的失败/待复核阻止提交；L4 由用户人工接受。">
            {!review.validation && <p className="text-xs text-pending">缺少验证报告：不能接受该候选。</p>}
            {review.validation && (
              <>
                <div className="flex flex-wrap items-center gap-1.5">
                  <StatusBadge label={validationStatusLabel(review.validation.status)} tone={validationStatusTone(review.validation.status)} ariaLabel="校验报告状态" />
                  <Chip>验证器 {review.validation.validatorVersion}</Chip>
                  <Chip>{review.validation.checks.length} 项检查</Chip>
                </div>
                <p className="mt-1 text-[11px] leading-4 text-ink-secondary">{review.validation.summary}</p>
                <ul className="mt-1.5 space-y-1">
                  {review.validation.checks.map((check) => (
                    <li key={check.id} className="rounded border border-white/10 bg-black/20 px-2 py-1">
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                        <StatusBadge label={checkStatusLabel(check.status)} tone={checkStatusTone(check.status)} ariaLabel="检查项状态" />
                        <Chip>{validationLayerLabel(check.layer)}</Chip>
                        <Chip>{check.code}</Chip>
                        <span className="text-ink-primary">{check.title}</span>
                      </div>
                      <p className="mt-0.5 text-[11px] leading-4 text-ink-secondary">{check.detail}</p>
                      {check.affectedPaths.length > 0 && <p className="font-mono text-[10px] text-ink-secondary">路径：{check.affectedPaths.join('、')}</p>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>

          {gate && (
            <Card title="接受与拒绝" subtitle="接受会创建不可变版本；拒绝保留运行记录与草稿。">
              <div className="flex flex-col gap-2">
                {gate.reasons.length > 0 && (
                  <ul className="list-inside list-disc space-y-0.5 rounded border border-pending/30 bg-pending/[0.04] px-2 py-1.5 text-[11px] text-ink-primary">
                    {gate.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                )}
                {gate.blockingFindings.length > 0 && (
                  <ul className="space-y-0.5 rounded border border-failed/40 bg-failed/[0.05] px-2 py-1.5 text-[11px] text-failed">
                    {gate.blockingFindings.map((finding) => (
                      <li key={finding}>{finding}</li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button size="sm" variant={acceptMode === 'all' ? 'secondary' : 'ghost'} onClick={() => setAcceptMode('all')} aria-pressed={acceptMode === 'all'}>
                    整体接受
                  </Button>
                  <Button size="sm" variant={acceptMode === 'sections' ? 'secondary' : 'ghost'} onClick={() => setAcceptMode('sections')} aria-pressed={acceptMode === 'sections'} disabledReason={!gate.canAcceptSections ? '按章节接受只限通过校验的 Markdown 候选。' : null}>
                    按章节接受
                  </Button>
                  <Chip>{sectionSelectionSummary(gate.sectionOptions, selectedSections)}</Chip>
                </div>

                {acceptMode === 'sections' && (
                  <ul className="space-y-1">
                    {gate.sectionOptions.map((section) => (
                      <li key={section.sectionId}>
                        <Checkbox
                          label={
                            <span className="flex flex-wrap items-center gap-1.5">
                              <span>{section.title}</span>
                              <StatusBadge label={changeKindLabel(section.change)} tone={section.change === 'removed' ? 'danger' : section.change === 'added' ? 'success' : 'pending'} ariaLabel="差异类型" />
                              <Chip>{section.sectionId}</Chip>
                              {section.reason && <span className="text-[11px] text-ink-secondary">{section.reason}</span>}
                            </span>
                          }
                          checked={selectedSections.includes(section.sectionId)}
                          disabled={!section.allowed}
                          onChange={(event) =>
                            setSelectedSections((current) =>
                              event.target.checked ? [...current, section.sectionId] : current.filter((id) => id !== section.sectionId),
                            )
                          }
                        />
                      </li>
                    ))}
                  </ul>
                )}

                <div>
                  <label htmlFor="review-note" className="text-[11px] text-ink-secondary">
                    接受备注（可选，写入版本记录）
                  </label>
                  <TextArea id="review-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} className="min-h-[56px]" placeholder="例如：已核对角色需求证据，确认状态表更新。" />
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    size="md"
                    variant="primary"
                    busy={pending}
                    disabledReason={acceptMode === 'all' ? (!gate.canAcceptAll ? gate.reasons[0] ?? '当前不能接受' : null) : !gate.canAcceptSections ? gate.reasons[0] ?? '当前不能按章节接受' : selectedSections.length === 0 ? '请选择至少一个章节。' : null}
                    onClick={() => void accept(acceptMode)}
                    icon={<CheckCheck aria-hidden="true" className="h-4 w-4" />}
                  >
                    {acceptMode === 'all' ? '接受全部' : `接受所选章节（${selectedSections.length}）`}
                  </Button>
                  <Button size="md" variant="ghost" onClick={() => setShowReject((value) => !value)} aria-expanded={showReject} icon={<X aria-hidden="true" className="h-4 w-4" />}>
                    拒绝候选
                  </Button>
                  <Button size="md" variant="ghost" onClick={() => onOpenVersions(review.patch.moduleId)} icon={<History aria-hidden="true" className="h-4 w-4" />}>
                    版本历史
                  </Button>
                  <Button size="md" variant="ghost" onClick={onOpenRepair} icon={<AlertTriangle aria-hidden="true" className="h-4 w-4" />}>
                    待处理问题
                  </Button>
                </div>

                {showReject && (
                  <div className="rounded border border-failed/30 bg-failed/[0.05] p-2">
                    <label htmlFor="reject-reason" className="text-[11px] text-ink-primary">
                      拒绝原因（必填，记录到运行与事件）
                    </label>
                    <TextArea id="reject-reason" value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} maxLength={2000} className="mt-1 min-h-[56px]" placeholder="例如：状态表缺少取消路径，需要重新生成。" />
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Button size="sm" variant="danger" busy={pending} disabledReason={rejectReason.trim().length === 0 ? '请填写拒绝原因。' : null} onClick={() => void reject()}>
                        确认拒绝
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setShowReject(false)}>
                        取消
                      </Button>
                      <span className="text-[11px] text-ink-secondary">拒绝不会播放成功动画，也不会清空草稿。</span>
                    </div>
                  </div>
                )}
                {state.lastError && <p className="text-[11px] text-failed">最近错误：{state.lastError.message}</p>}
              </div>
            </Card>
          )}

          <p className="text-[11px] leading-4 text-ink-secondary">
            <ShieldCheck aria-hidden="true" className="mr-1 inline h-3 w-3" />
            版本冲突（baseVersionId 与当前已接受版本不一致）时后端会拒绝提交，双方内容保留；需要重新生成差异或人工合并。
          </p>
        </>
      )}
    </div>
  );
}

export { X };
