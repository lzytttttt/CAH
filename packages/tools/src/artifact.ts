/**
 * Artifact tools: read modules/versions, propose isolated draft patches and run
 * deterministic validation.
 *
 * Safety rules enforced here:
 * - a proposal's `baseVersionId` must equal the module's current accepted
 *   version (when supplied) or the operation is rejected as a version conflict;
 * - draft tools never write an accepted version — only `saveProposal` /
 *   `saveValidationReport` are called, and the stored proposal must come back in
 *   `proposed` status;
 * - every evidence reference is checked against real stored sources/versions
 *   before it can be attached to a proposal (no fabricated evidence);
 * - patch application is delegated to the frozen `applyPatchOperations` contract
 *   so wrong module kinds, unknown sections and unknown JSON paths fail.
 */
import {
  EvidenceRefSchema,
  ModuleContentSchema,
  applyPatchOperations,
  emptyContentForKind,
  PatchApplyError,
  type ArtifactModule,
  type ArtifactVersion,
  type EvidenceRef,
  type JsonValue,
  type ModuleContent,
  type ModuleId,
  type PatchOperation,
  type PatchProposal,
  type SourceSpan,
  type ValidationReport,
  type ArtifactReadArgs,
  type ArtifactProposePatchArgs,
  type ArtifactValidateArgs,
  type ArtifactReadResult,
  type ProposePatchResult,
  type ValidateToolResult,
} from '@ca/contracts';
import { ToolRuntimeError, wrapPortError } from './errors';
import { contentHash, sha256Hex } from './hash';
import { readSourceVersion, resolveLocatorRegion } from './source';
import type { ToolContext } from './types';

function requireValidator(ctx: ToolContext): NonNullable<ToolContext['validator']> {
  if (!ctx.validator) {
    throw new ToolRuntimeError(
      'validator_unavailable',
      'no artifact validator is configured for this run; candidates cannot be validated or proposed',
    );
  }
  return ctx.validator;
}

async function getModuleOrThrow(ctx: ToolContext, moduleId: ModuleId): Promise<ArtifactModule> {
  let module: ArtifactModule | null;
  try {
    module = await ctx.artifacts.getModule(moduleId);
  } catch (error) {
    throw wrapPortError(error, 'module_not_found', `could not load module ${moduleId}`);
  }
  if (!module) {
    throw new ToolRuntimeError('module_not_found', `module ${moduleId} was not found`, { details: { moduleId } });
  }
  return module;
}

async function getVersionOrThrow(ctx: ToolContext, versionId: string): Promise<ArtifactVersion> {
  let version: ArtifactVersion | null;
  try {
    version = await ctx.artifacts.getVersion(versionId);
  } catch (error) {
    throw wrapPortError(error, 'version_not_found', `could not load artifact version ${versionId}`);
  }
  if (!version) {
    throw new ToolRuntimeError('version_not_found', `artifact version ${versionId} was not found`, {
      details: { versionId },
    });
  }
  return version;
}

function assertVersionBelongsToModule(version: ArtifactVersion, module: ArtifactModule): void {
  if (version.moduleId !== module.id) {
    throw new ToolRuntimeError('version_not_found', `artifact version ${version.id} does not belong to module ${module.id}`);
  }
  if (version.moduleKind !== module.kind) {
    throw new ToolRuntimeError(
      'module_kind_mismatch',
      `artifact version ${version.id} kind ${version.moduleKind} does not match module kind ${module.kind}`,
    );
  }
}

/** Load the accepted version (or the explicitly requested one) for a patch base. */
async function loadPatchBaseVersion(
  ctx: ToolContext,
  module: ArtifactModule,
  baseVersionId: string | null,
): Promise<ArtifactVersion | null> {
  if (baseVersionId !== null) {
    if (module.acceptedVersionId !== baseVersionId) {
      throw new ToolRuntimeError(
        'version_conflict',
        `baseVersionId ${baseVersionId} is not the module's current accepted version (${module.acceptedVersionId ?? 'none'})`,
        { details: { baseVersionId, acceptedVersionId: module.acceptedVersionId } },
      );
    }
    const version = await getVersionOrThrow(ctx, baseVersionId);
    assertVersionBelongsToModule(version, module);
    return version;
  }
  if (!module.acceptedVersionId) return null;
  const accepted = await getVersionOrThrow(ctx, module.acceptedVersionId);
  assertVersionBelongsToModule(accepted, module);
  return accepted;
}

/* ----------------------------- evidence checks ----------------------------- */

function describeEvidencePath(index: number): string {
  return `evidenceRefs[${index}]`;
}

async function loadSpansForVerification(ctx: ToolContext): Promise<SourceSpan[]> {
  try {
    return await ctx.sources.listSpans(ctx.taskId, 1000);
  } catch {
    // Losing the span listing only turns exact-span matching off; the quote is
    // still re-verified against the source itself below.
    return [];
  }
}

/**
 * Parse and verify typed evidence references.
 * A `source_span` ref is only accepted when its excerpt really occurs at the
 * claimed locator AND sha256(excerpt) equals the persisted quoteHash.
 */
export async function verifyEvidenceRefs(
  ctx: ToolContext,
  rawRefs: ReadonlyArray<Record<string, JsonValue>>,
): Promise<EvidenceRef[]> {
  const evidence: EvidenceRef[] = [];
  let spans: SourceSpan[] | null = null;
  const cachedSpans = async (): Promise<SourceSpan[]> => {
    if (!spans) spans = await loadSpansForVerification(ctx);
    return spans;
  };

  for (let index = 0; index < rawRefs.length; index += 1) {
    const raw = rawRefs[index]!;
    const parsed = EvidenceRefSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ToolRuntimeError(
        'evidence_invalid',
        `${describeEvidencePath(index)} is not a valid evidence reference: ${
          issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'schema violation'
        }`,
        { details: { index } },
      );
    }
    const ref = parsed.data;
    if (ref.kind === 'source_span') {
      const span = ref.span;
      let loaded;
      try {
        loaded = await readSourceVersion(ctx, span.sourceId, span.version);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ToolRuntimeError(
          'evidence_invalid',
          `${describeEvidencePath(index)} references a source span that cannot be verified: ${message}`,
          { details: { index, spanId: span.spanId } },
        );
      }
      let region: string;
      try {
        region = resolveLocatorRegion({ text: loaded.text, format: loaded.format, locator: span.locator }).region;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ToolRuntimeError(
          'evidence_invalid',
          `${describeEvidencePath(index)} references an unresolvable locator: ${message}`,
          { details: { index, spanId: span.spanId } },
        );
      }
      if (sha256Hex(span.excerpt) !== span.quoteHash) {
        throw new ToolRuntimeError(
          'evidence_invalid',
          `${describeEvidencePath(index)} quoteHash does not match the sha256 of its excerpt`,
          { details: { index, spanId: span.spanId } },
        );
      }
      if (!region.includes(span.excerpt)) {
        throw new ToolRuntimeError(
          'evidence_invalid',
          `${describeEvidencePath(index)} excerpt does not occur at the claimed source locator`,
          { details: { index, spanId: span.spanId } },
        );
      }
      const known = (await cachedSpans()).find((candidate) => candidate.id === span.spanId);
      if (known) {
        if (
          known.sourceId !== span.sourceId ||
          known.version !== span.version ||
          known.quoteHash !== span.quoteHash ||
          known.excerpt !== span.excerpt
        ) {
          throw new ToolRuntimeError(
            'evidence_invalid',
            `${describeEvidencePath(index)} contradicts the persisted source span ${span.spanId}`,
            { details: { index, spanId: span.spanId } },
          );
        }
      }
      evidence.push(ref);
      continue;
    }
    if (ref.kind === 'artifact_version') {
      let version: ArtifactVersion | null;
      try {
        version = await ctx.artifacts.getVersion(ref.versionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ToolRuntimeError('evidence_invalid', `${describeEvidencePath(index)} cannot be verified: ${message}`, {
          details: { index, versionId: ref.versionId },
        });
      }
      if (!version) {
        throw new ToolRuntimeError(
          'evidence_invalid',
          `${describeEvidencePath(index)} references an artifact version that does not exist`,
          { details: { index, versionId: ref.versionId } },
        );
      }
      if (version.moduleId !== ref.moduleId) {
        throw new ToolRuntimeError(
          'evidence_invalid',
          `${describeEvidencePath(index)} artifact_version moduleId does not match the referenced version`,
          { details: { index, versionId: ref.versionId } },
        );
      }
      evidence.push(ref);
      continue;
    }
    // user_assumption is the only explicit non-observed evidence; tool_result is
    // addressed by tool call id and verified by the harness ledger.
    evidence.push(ref);
  }
  return evidence;
}

/* --------------------------------- tools --------------------------------- */

export async function executeArtifactRead(
  ctx: ToolContext,
  args: ArtifactReadArgs,
): Promise<ArtifactReadResult> {
  const module = await getModuleOrThrow(ctx, args.moduleId);

  let version: ArtifactVersion | null = null;
  if (args.versionId !== null) {
    version = await getVersionOrThrow(ctx, args.versionId);
    assertVersionBelongsToModule(version, module);
  } else if (module.acceptedVersionId) {
    version = await getVersionOrThrow(ctx, module.acceptedVersionId);
    assertVersionBelongsToModule(version, module);
  }

  const content: ModuleContent = version ? version.content : emptyContentForKind(module.kind);
  return {
    moduleId: module.id,
    versionId: version ? version.id : null,
    content,
    contentHash: version ? version.contentHash : null,
    moduleKind: module.kind,
    dependencies: [...module.dependencies],
  };
}

function zodIssuesToText(error: unknown, max = 4): string {
  const issues = (error as { issues?: Array<{ path?: PropertyKey[]; message?: string }> }).issues ?? [];
  return issues
    .slice(0, max)
    .map((issue) => `${(issue.path ?? []).map(String).join('.') || '(root)'}: ${issue.message ?? 'invalid'}`)
    .join('; ');
}

function applyPatchOrThrow(
  base: ModuleContent | null,
  moduleKind: ArtifactModule['kind'],
  operations: readonly PatchOperation[],
): ModuleContent {
  let candidate: ModuleContent;
  try {
    candidate = applyPatchOperations(base, moduleKind, operations);
  } catch (error) {
    if (error instanceof PatchApplyError) {
      throw new ToolRuntimeError('patch_invalid', `patch rejected (${error.code}): ${error.message}`, {
        details: { patchCode: error.code },
      });
    }
    throw error;
  }
  const parsed = ModuleContentSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ToolRuntimeError('patch_invalid', `patched content violates the module content schema: ${zodIssuesToText(parsed.error)}`);
  }
  if (parsed.data.kind !== moduleKind) {
    throw new ToolRuntimeError(
      'module_kind_mismatch',
      `patch produced ${parsed.data.kind} content but the module is ${moduleKind}`,
    );
  }
  return parsed.data;
}

export async function executeArtifactProposePatch(
  ctx: ToolContext,
  args: ArtifactProposePatchArgs,
): Promise<ProposePatchResult> {
  const module = await getModuleOrThrow(ctx, args.moduleId);
  const baseVersion = await loadPatchBaseVersion(ctx, module, args.baseVersionId);
  const candidate = applyPatchOrThrow(baseVersion?.content ?? null, module.kind, args.operations);
  const candidateHash = contentHash(candidate);

  const evidenceRefs = await verifyEvidenceRefs(ctx, args.evidenceRefs);
  const validator = requireValidator(ctx);

  const report = await validator.validate({
    taskId: ctx.taskId,
    runId: ctx.runId,
    moduleId: module.id,
    candidate,
    evidenceRefs,
    baseVersion,
  });
  assertValidationMatchesCandidate(report, module.id, baseVersion?.id ?? null, candidateHash);

  let saved: { patch: PatchProposal };
  try {
    saved = await ctx.artifacts.saveProposal({
      taskId: ctx.taskId,
      runId: ctx.runId,
      moduleId: module.id,
      baseVersionId: baseVersion?.id ?? null,
      operations: [...args.operations],
      evidenceRefs,
      description: args.description,
      candidate,
      validation: report,
    });
  } catch (error) {
    throw wrapPortError(error, 'internal_error', 'could not persist the patch proposal');
  }

  const patch = saved.patch;
  if (patch.moduleId !== module.id) {
    throw new ToolRuntimeError('validation_mismatch', 'artifact store returned a proposal for a different module');
  }
  if (patch.baseVersionId !== (baseVersion?.id ?? null)) {
    throw new ToolRuntimeError('validation_mismatch', 'artifact store returned a proposal with a different base version');
  }
  if (patch.status !== 'proposed') {
    throw new ToolRuntimeError(
      'patch_invalid',
      `draft tool must not create accepted patches (status ${patch.status})`,
    );
  }
  if (patch.candidateHash !== candidateHash) {
    throw new ToolRuntimeError(
      'validation_mismatch',
      'proposal candidateHash does not match sha256(canonicalJson(candidate)); the artifact store must hash the exact candidate content',
    );
  }
  return { patch, validation: report };
}

function assertValidationMatchesCandidate(
  report: ValidationReport,
  moduleId: ModuleId,
  baseVersionId: string | null,
  candidateHash: string,
): void {
  if (report.moduleId !== moduleId) {
    throw new ToolRuntimeError('validation_mismatch', 'validator returned a report for a different module');
  }
  if ((report.baseVersionId ?? null) !== baseVersionId) {
    throw new ToolRuntimeError('validation_mismatch', 'validator returned a report for a different base version');
  }
  if (report.candidateHash !== candidateHash) {
    throw new ToolRuntimeError(
      'validation_mismatch',
      'validator candidateHash does not match sha256(canonicalJson(candidate)); the validator must hash the exact candidate content',
    );
  }
}

export async function executeArtifactValidate(
  ctx: ToolContext,
  args: ArtifactValidateArgs,
): Promise<ValidateToolResult> {
  const module = await getModuleOrThrow(ctx, args.moduleId);

  let baseVersion: ArtifactVersion | null = null;
  if (args.baseVersionId !== null) {
    baseVersion = await getVersionOrThrow(ctx, args.baseVersionId);
    assertVersionBelongsToModule(baseVersion, module);
  } else if (module.acceptedVersionId) {
    baseVersion = await getVersionOrThrow(ctx, module.acceptedVersionId);
    assertVersionBelongsToModule(baseVersion, module);
  }

  const evidenceRefs = await verifyEvidenceRefs(ctx, args.evidenceRefs);
  const validator = requireValidator(ctx);
  const candidateHash = contentHash(args.candidate);
  const report = await validator.validate({
    taskId: ctx.taskId,
    runId: ctx.runId,
    moduleId: module.id,
    candidate: args.candidate,
    evidenceRefs,
    baseVersion,
  });
  assertValidationMatchesCandidate(report, module.id, baseVersion?.id ?? null, candidateHash);

  try {
    await ctx.artifacts.saveValidationReport(report);
  } catch (error) {
    throw wrapPortError(error, 'internal_error', 'could not persist the validation report');
  }
  return { validation: report, status: report.status, reportId: report.id };
}
