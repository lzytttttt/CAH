/**
 * Diff-review gating (design 9.2 / 11.3).
 *
 * - accept-all is possible only with a passing validation report and a patch
 *   whose base version still matches the module's accepted version;
 * - per-section accept is only allowed for markdown patches with stable section
 *   ids and a passing validation report;
 * - a failed validation never becomes "accept anyway": the UI explains what to
 *   fix and keeps the accepted version untouched.
 */
import type { ContentDiff, DiffEntry, PatchProposal, ValidationReport } from '@ca/contracts';
import { isCommitAllowed } from '@ca/contracts';

export interface SectionOption {
  sectionId: string;
  title: string;
  change: DiffEntry['change'];
  allowed: boolean;
  reason: string | null;
}

export interface ReviewGate {
  canAcceptAll: boolean;
  canAcceptSections: boolean;
  reasons: string[];
  sectionOptions: SectionOption[];
  defaultSelectedSectionIds: string[];
  blockingFindings: string[];
}

export interface ReviewGateInput {
  patch: PatchProposal;
  diff: ContentDiff;
  validation: ValidationReport | null;
  /** The module's currently accepted version id (null for the first version). */
  currentAcceptedVersionId: string | null;
  patchStatus?: string;
}

export function computeReviewGate(input: ReviewGateInput): ReviewGate {
  const { patch, diff, validation, currentAcceptedVersionId } = input;
  const reasons: string[] = [];
  const blockingFindings: string[] = [];
  const patchStatus = input.patchStatus ?? patch.status;

  if (patchStatus !== 'proposed') {
    reasons.push(
      patchStatus === 'accepted'
        ? '该候选已被接受，无需重复审阅。'
        : patchStatus === 'rejected'
          ? '该候选已被拒绝；已接受成果未改变。'
          : `该候选当前状态为「${patchStatus}」，不能接受。`,
    );
  }
  if (patch.baseVersionId !== currentAcceptedVersionId) {
    reasons.push('候选基于的基线版本已变化：已接受成果未被覆盖，请重新生成差异或人工合并。');
  }
  if (!validation) {
    reasons.push('缺少校验报告：不能在没有确定性校验结果时接受候选。');
  } else if (!isCommitAllowed(validation)) {
    reasons.push('校验未通过（L0–L3 存在失败或待复核项）：请先处理问题，不能接受当前候选。');
    for (const check of validation.checks) {
      if (check.layer !== 'L4' && (check.status === 'fail' || check.status === 'needs_review')) {
        blockingFindings.push(`[${check.layer}/${check.code}] ${check.title}：${check.detail}`);
      }
    }
  }

  const validationPasses = validation != null && isCommitAllowed(validation);
  const changedEntries = diff.entries.filter((entry) => entry.change !== 'unchanged');
  const sectionEntries = changedEntries.filter((entry): entry is DiffEntry & { sectionId: string } => entry.sectionId != null);
  const missingSectionIds = changedEntries.filter((entry) => entry.sectionId == null);
  const canUseSections = patch.moduleKind === 'markdown' && missingSectionIds.length === 0 && sectionEntries.length > 0;

  const sectionOptions: SectionOption[] = sectionEntries.map((entry) => ({
    sectionId: entry.sectionId,
    title: entry.title,
    change: entry.change,
    allowed: canUseSections && validationPasses && patchStatus === 'proposed',
    reason: canUseSections
      ? validationPasses
        ? null
        : '校验未通过，不能按章节接受。'
      : '该候选没有可用的稳定章节 ID，只能整体接受或拒绝。',
  }));

  const canAcceptAll = patchStatus === 'proposed' && validationPasses && patch.baseVersionId === currentAcceptedVersionId;
  const canAcceptSections = canAcceptAll && canUseSections;

  if (canUseSections && !validationPasses) {
    reasons.push('按章节接受需要先通过确定性校验。');
  }
  if (!canUseSections && changedEntries.length > 0) {
    reasons.push('按章节接受仅限带稳定章节 ID 的 Markdown 候选；JSON/CSV 候选只能整体接受或拒绝。');
  }
  if (canAcceptAll) reasons.length = 0;

  return {
    canAcceptAll,
    canAcceptSections,
    reasons: [...new Set(reasons)],
    sectionOptions,
    defaultSelectedSectionIds: sectionOptions.filter((option) => option.allowed).map((option) => option.sectionId),
    blockingFindings,
  };
}

/** Per-section accept payload hints for the UI checkbox list. */
export function sectionSelectionSummary(options: readonly SectionOption[], selected: readonly string[]): string {
  const selectedCount = options.filter((option) => option.allowed && selected.includes(option.sectionId)).length;
  return `已选择 ${selectedCount}/${options.filter((option) => option.allowed).length} 个可接受章节`;
}

/** Whether a rejected patch may be rejected at all (proposed only). */
export function canRejectPatch(patch: Pick<PatchProposal, 'status'>): boolean {
  return patch.status === 'proposed';
}
