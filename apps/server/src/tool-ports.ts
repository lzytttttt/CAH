import { createHash } from 'node:crypto';
import {
  canonicalJson,
  diffModuleContent,
  newPatchId,
  newValidationReportId,
  utcNow,
  type ArtifactModule,
  type ArtifactVersion,
  type ChangeSummary,
  type EvidenceRef,
  type PatchOperation,
  type PatchProposal,
  type ValidationReport,
} from '@ca/contracts';
import type { StoragePort } from '@ca/storage';
import type {
  ArtifactAccessPort,
  ObjectWriterPort,
  SourceReaderPort,
  ToolContext,
  ValidatorPort,
} from '@ca/tools';
import type { ProviderGateway } from '@ca/harness';

/** sha256 hex of canonical JSON (content addressing for versions/patches). */
export function hashContent(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Storage-backed source access used by tool executions and the context builder. */
export function createSourceReader(storage: StoragePort): SourceReaderPort {
  return {
    async listSources(taskId) {
      return storage.listSources(taskId);
    },
    async getSource(taskId, sourceId, version) {
      const found = await storage.getSource(taskId, sourceId, version);
      if (!found) return null;
      return { source: found.source, bytes: found.content };
    },
    async listLatestContents(taskId) {
      const candidates = await storage.listLatestSourceContents(taskId);
      return candidates.map((c) => ({ source: c.source, bytes: c.bytes }));
    },
    async listSpans(taskId, limit) {
      return storage.listSpans(taskId, limit);
    },
    async saveSpan(span) {
      // Storage performs an idempotent upsert keyed by the deterministic span id.
      await storage.insertSpans([span]);
    },
  };
}

/** Draft-write artifact access: never touches accepted versions. */
export function createArtifactAccess(storage: StoragePort): ArtifactAccessPort {
  return {
    async getModule(moduleId) {
      return storage.getModule(moduleId);
    },
    async getAcceptedVersion(moduleId) {
      return storage.getAcceptedVersion(moduleId);
    },
    async getVersion(versionId) {
      return storage.getVersion(versionId);
    },
    async saveProposal(input) {
      const now = utcNow();
      const candidateHash = hashContent(input.candidate);
      const base = input.baseVersionId ? await storage.getVersion(input.baseVersionId) : null;
      const module = await storage.getModule(input.moduleId);
      if (!module) throw new Error(`module not found: ${input.moduleId}`);
      const diff = diffModuleContent(input.moduleId, module.kind, base?.content ?? null, input.candidate, {
        baseVersionId: input.baseVersionId,
        candidateHash,
      });
      const summary: ChangeSummary = {
        addedLines: diff.entries
          .filter((e) => e.change === 'added')
          .reduce((n, e) => n + (e.afterExcerpt ? e.afterExcerpt.split('\n').length : 0), 0),
        removedLines: diff.entries
          .filter((e) => e.change === 'removed')
          .reduce((n, e) => n + (e.beforeExcerpt ? e.beforeExcerpt.split('\n').length : 0), 0),
        changedSections: diff.entries.filter((e) => e.change === 'changed').map((e) => e.title),
        addedSections: diff.entries.filter((e) => e.change === 'added').map((e) => e.title),
        removedSections: diff.entries.filter((e) => e.change === 'removed').map((e) => e.title),
        affectedRows: module.kind === 'csv' ? (input.candidate.kind === 'csv' ? input.candidate.rows.length : 0) : 0,
        note: '',
      };
      const patch: PatchProposal = {
        id: newPatchId(),
        taskId: input.taskId,
        runId: input.runId,
        moduleId: input.moduleId,
        moduleKind: module.kind,
        baseVersionId: input.baseVersionId as never,
        operations: input.operations,
        evidenceRefs: input.evidenceRefs,
        validationReportId: input.validation.id,
        candidateHash,
        candidate: input.candidate,
        status: 'proposed',
        description: input.description,
        changeSummary: summary,
        createdAt: now,
        acceptedVersionId: null,
      };
      await storage.transaction(async () => {
        await storage.insertPatch(patch);
        await storage.insertValidationReport(input.validation);
      });
      return { patch };
    },
    async saveValidationReport(report) {
      await storage.insertValidationReport(report);
    },
  };
}

export function createObjectWriter(storage: StoragePort): ObjectWriterPort {
  return {
    async put(bytes, mime) {
      const ref = await storage.objects.put(bytes, mime);
      return { hash: ref.hash, sizeBytes: ref.sizeBytes, mime: ref.mime };
    },
  };
}

export interface ToolContextFactoryDeps {
  storage: StoragePort;
  validator: ValidatorPort;
  providers: ProviderGateway;
  profileIdForRun: (runId: string) => Promise<string | null>;
  mode: 'demo' | 'live';
}

/**
 * Build a ToolContext for one call. Scopes are granted by the server policy:
 * P0 allows reads of task sources, artifact reads and draft writes only.
 */
export function createToolContextFactory(deps: ToolContextFactoryDeps) {
  return async (input: {
    taskId: string;
    runId: string;
    stepId: string;
    toolCallId: string;
    grantedScopes: readonly string[];
    signal: AbortSignal;
  }): Promise<ToolContext> => {
    const profileId = await deps.profileIdForRun(input.runId);
    let capabilities = null;
    if (profileId) {
      try {
        const profile = await deps.providers.getProfile(profileId);
        capabilities = profile?.capabilities ?? null;
      } catch {
        capabilities = null;
      }
    }
    return {
      taskId: input.taskId as ToolContext['taskId'],
      runId: input.runId as ToolContext['runId'],
      stepId: input.stepId as ToolContext['stepId'],
      toolCallId: input.toolCallId as ToolContext['toolCallId'],
      grantedScopes: input.grantedScopes as ToolContext['grantedScopes'],
      sources: createSourceReader(deps.storage),
      artifacts: createArtifactAccess(deps.storage),
      validator: deps.validator,
      objects: createObjectWriter(deps.storage),
      capabilities,
      now: () => utcNow(),
      signal: input.signal,
    };
  };
}

/** Deterministic source span id is owned by the tools package; re-exported for adapters. */
export interface StoredArtifactVersionView {
  module: ArtifactModule;
  version: ArtifactVersion | null;
}
