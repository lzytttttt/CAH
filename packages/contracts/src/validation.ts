/** Deterministic validation results (L0-L4). */
import { z } from 'zod';
import {
  ArtifactVersionIdSchema,
  ModuleIdSchema,
  RunIdSchema,
  Sha256HexSchema,
  TaskIdSchema,
  UtcTimestampSchema,
  ValidationReportIdSchema,
} from './primitives';
import { CheckStatusSchema, ValidationLayerSchema, type CheckStatus, type ValidationLayer } from './states';
import { EvidenceRefSchema } from './refs';

export const ValidationCheckSchema = z.object({
  id: z.string().min(1).max(128),
  layer: ValidationLayerSchema,
  code: z.string().min(1).max(128),
  title: z.string().min(1).max(300),
  status: CheckStatusSchema,
  detail: z.string().max(4000),
  evidenceRefs: z.array(EvidenceRefSchema).max(64).default([]),
  affectedPaths: z.array(z.string().max(512)).max(64).default([]),
});
export type ValidationCheck = z.infer<typeof ValidationCheckSchema>;

export const VALIDATION_REPORT_STATUSES = ['pass', 'fail', 'needs_review'] as const;
export const ValidationReportStatusSchema = z.enum(VALIDATION_REPORT_STATUSES);
export type ValidationReportStatus = z.infer<typeof ValidationReportStatusSchema>;

export const ValidationReportSchema = z.object({
  id: ValidationReportIdSchema,
  taskId: TaskIdSchema,
  runId: RunIdSchema,
  moduleId: ModuleIdSchema,
  baseVersionId: ArtifactVersionIdSchema.nullable(),
  candidateHash: Sha256HexSchema,
  checks: z.array(ValidationCheckSchema).max(500),
  status: ValidationReportStatusSchema,
  summary: z.string().max(4000),
  validatorVersion: z.string().min(1).max(64),
  createdAt: UtcTimestampSchema,
});
export type ValidationReport = z.infer<typeof ValidationReportSchema>;

/**
 * Roll deterministic checks up into a report status.
 * L4 (human review) never passes automatically: it only makes the report
 * `needs_review` when it fails, and is otherwise not part of the pass gate.
 */
export function rollupValidationStatus(checks: readonly ValidationCheck[]): ValidationReportStatus {
  let needsReview = false;
  let failed = false;
  for (const check of checks) {
    if (check.status === 'not_applicable' || check.status === 'pass') continue;
    if (check.layer === 'L4') {
      needsReview = true;
      continue;
    }
    if (check.status === 'fail') failed = true;
    if (check.status === 'needs_review') needsReview = true;
  }
  if (failed) return 'fail';
  if (needsReview) return 'needs_review';
  return 'pass';
}

/** A commit is allowed only when there are no failed/needs_review L0-L3 checks. */
export function isCommitAllowed(report: Pick<ValidationReport, 'checks' | 'status'>): boolean {
  if (report.status === 'fail') return false;
  return !report.checks.some(
    (check) => check.layer !== 'L4' && (check.status === 'fail' || check.status === 'needs_review'),
  );
}

/** Human-readable summary of blocking findings, used for repair prompts and repair cards. */
export function summarizeValidationFailures(checks: readonly ValidationCheck[], maxItems = 5): string[] {
  return checks
    .filter((c) => c.layer !== 'L4' && (c.status === 'fail' || c.status === 'needs_review'))
    .slice(0, maxItems)
    .map((c) => `[${c.layer}/${c.code}] ${c.title}: ${c.detail}`);
}

export function layerLabel(layer: ValidationLayer): string {
  switch (layer) {
    case 'L0':
      return '协议';
    case 'L1':
      return '结构';
    case 'L2':
      return '证据';
    case 'L3':
      return '业务规则';
    case 'L4':
      return '人工审阅';
  }
}

export function statusLabel(status: CheckStatus): string {
  switch (status) {
    case 'pass':
      return '通过';
    case 'fail':
      return '失败';
    case 'needs_review':
      return '待复核';
    case 'not_applicable':
      return '不适用';
  }
}
