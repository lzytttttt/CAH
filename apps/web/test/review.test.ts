import { describe, expect, it } from 'vitest';
import { diffModuleContent } from '@ca/contracts';
import { computeReviewGate, canRejectPatch, sectionSelectionSummary } from '../src/lib/review';
import { IDS, loadFixtureBundle } from '../src/api/fixture/data';

const bundle = loadFixtureBundle('review');
const interactionPatch = bundle.patches.find((patch) => patch.moduleId === IDS.modules.interaction)!;
const cleanupPatch = bundle.patches.find((patch) => patch.moduleId === IDS.modules.cleanup)!;

function diffFor(patch: typeof interactionPatch) {
  const base = bundle.baseContents[patch.id] ?? null;
  return diffModuleContent(patch.moduleId, patch.moduleKind, base, patch.candidate, {
    baseVersionId: patch.baseVersionId,
    candidateHash: patch.candidateHash,
  });
}

describe('diff review gating (design 9.2) — no accepting failed validation', () => {
  it('allows accept-all and per-section accept for a passing markdown patch on the current base', () => {
    const diff = diffFor(interactionPatch);
    const gate = computeReviewGate({
      patch: interactionPatch,
      diff,
      validation: bundle.validations[IDS.validations.interaction]!,
      currentAcceptedVersionId: IDS.versions.interactionV2,
    });
    expect(gate.canAcceptAll).toBe(true);
    expect(gate.canAcceptSections).toBe(true);
    expect(gate.reasons).toEqual([]);
    expect(gate.blockingFindings).toEqual([]);
    expect(gate.defaultSelectedSectionIds.length).toBeGreaterThan(0);
    expect(gate.sectionOptions.every((option) => option.allowed)).toBe(true);
  });

  it('blocks acceptance when the deterministic validation fails and lists the findings', () => {
    const diff = diffFor(cleanupPatch);
    const gate = computeReviewGate({
      patch: cleanupPatch,
      diff,
      validation: bundle.validations[IDS.validations.cleanup]!,
      currentAcceptedVersionId: null,
    });
    expect(gate.canAcceptAll).toBe(false);
    expect(gate.canAcceptSections).toBe(false);
    expect(gate.blockingFindings.length).toBeGreaterThan(0);
    expect(gate.blockingFindings.join(' ')).toContain('L3');
    expect(gate.reasons.join(' ')).toContain('校验未通过');
  });

  it('rejects acceptance when the base version moved on', () => {
    const diff = diffFor(interactionPatch);
    const gate = computeReviewGate({
      patch: interactionPatch,
      diff,
      validation: bundle.validations[IDS.validations.interaction]!,
      currentAcceptedVersionId: '00000000-0000-4000-8000-000000000999',
    });
    expect(gate.canAcceptAll).toBe(false);
    expect(gate.reasons.join(' ')).toContain('基线版本已变化');
  });

  it('rejects acceptance without a validation report (no free pass)', () => {
    const gate = computeReviewGate({
      patch: interactionPatch,
      diff: diffFor(interactionPatch),
      validation: null,
      currentAcceptedVersionId: IDS.versions.interactionV2,
    });
    expect(gate.canAcceptAll).toBe(false);
    expect(gate.reasons.join(' ')).toContain('缺少校验报告');
  });

  it('does not accept an already accepted/rejected patch', () => {
    const gate = computeReviewGate({
      patch: interactionPatch,
      diff: diffFor(interactionPatch),
      validation: bundle.validations[IDS.validations.interaction]!,
      currentAcceptedVersionId: IDS.versions.interactionV2,
      patchStatus: 'accepted',
    });
    expect(gate.canAcceptAll).toBe(false);
    expect(canRejectPatch({ status: 'accepted' })).toBe(false);
    expect(canRejectPatch({ status: 'proposed' })).toBe(true);
  });

  it('summarises section selection for the UI', () => {
    const diff = diffFor(interactionPatch);
    const gate = computeReviewGate({
      patch: interactionPatch,
      diff,
      validation: bundle.validations[IDS.validations.interaction]!,
      currentAcceptedVersionId: IDS.versions.interactionV2,
    });
    expect(sectionSelectionSummary(gate.sectionOptions, gate.defaultSelectedSectionIds)).toBe(
      `已选择 ${gate.defaultSelectedSectionIds.length}/${gate.sectionOptions.length} 个可接受章节`,
    );
  });
});
