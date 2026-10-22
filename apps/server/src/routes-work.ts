import type { FastifyInstance } from 'fastify';
import {
  API_ROUTES,
  AcceptPatchRequestSchema,
  CommitPlanRequestSchema,
  CreateRecipeRequestSchema,
  DisableRecipeRequestSchema,
  PatchReviewResponseSchema,
  ProposeRecipeRequestSchema,
  RejectPatchRequestSchema,
  ResolveInputRequestSchema,
  RestoreVersionRequestSchema,
  RunControlRequestSchema,
  ValidateRecipeRequestSchema,
  RunRecipeRequestSchema,
  diffModuleContent,
  utcNow,
  type PatchProposal,
  type RunDetailResponse,
} from '@ca/contracts';
import type { RuntimeManager, ModeRuntime } from './runtime-manager';
import { fail } from './errors';
import { CommandRunner, loadRun, loadTask, parseBody, requireParam } from './http';
import { proposeRecipe, registerRecipe, RecipeService } from './recipe-service';

export interface WorkRouteDeps {
  manager: RuntimeManager;
  commands: CommandRunner;
  log: (message: string, details?: Record<string, unknown>) => void;
}

export async function registerWorkRoutes(app: FastifyInstance, deps: WorkRouteDeps): Promise<void> {
  const { manager } = deps;
  const runtime = (): ModeRuntime => manager.runtime();

  /* ---------------------------------- runs ---------------------------------- */
  app.get(`${API_ROUTES.runBase}/:id`, async (request) => {
    const runId = requireParam(request.params as Record<string, string>, 'id');
    const rt = runtime();
    const detail = await rt.harness.getRunDetail(runId as never);
    if (!detail) throw fail.notFound('运行');
    const run = detail.run;
    const validations = await rt.storage.listValidationReports(run.taskId);
    const runValidation = validations.filter((v) => v.runId === run.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
    const response: RunDetailResponse = {
      run: {
        runId: run.id,
        taskId: run.taskId,
        moduleId: run.moduleId,
        state: run.state,
        revision: run.revision,
        attempt: run.attempt,
        planVersion: run.planVersion,
        contextSnapshotId: run.contextSnapshotId,
        budgetUsage: run.budgetUsage,
        error: run.error,
        interrupted: run.interrupted,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      },
      plan: detail.plan,
      steps: detail.steps.map((step) => ({
        stepId: step.id,
        kind: step.kind,
        title: step.title,
        status: step.status,
        summary: step.summary,
        startedAt: step.startedAt,
        finishedAt: step.finishedAt,
      })),
      blockers: detail.blockers,
      contextSnapshot: detail.contextSnapshot,
      validationReport: runValidation,
    };
    return response;
  });

  app.post(`${API_ROUTES.runBase}/:id/commit`, async (request) => {
    const runId = requireParam(request.params as Record<string, string>, 'id');
    const body = parseBody(CommitPlanRequestSchema, request.body);
    const rt = runtime();
    return deps.commands.run(body.commandId, 'run.commit', null, async () => {
      const run = await loadRun(rt.storage, runId);
      const task = await loadTask(rt.storage, run.taskId);
      if (body.expectedRevision !== task.revision) {
        throw fail.revisionConflict(body.expectedRevision, task.revision);
      }
      const handle = await rt.harness.commit({
        commandId: body.commandId,
        runId: run.id,
        expectedRevision: task.revision,
        planVersion: body.planVersion,
        contextSnapshotId: body.contextSnapshotId,
        actor: 'local-user',
      });
      const submission = await rt.scheduler.submit(run.id);
      const latest = await loadRun(rt.storage, run.id);
      deps.log('run committed', { runId: run.id, queued: submission.queued, state: latest.state });
      return {
        commandId: body.commandId,
        duplicate: false,
        runId: run.id,
        state: latest.state ?? handle.state,
        revision: task.revision,
      };
    });
  });

  app.post(`${API_ROUTES.runBase}/:id/resolve`, async (request) => {
    const runId = requireParam(request.params as Record<string, string>, 'id');
    const body = parseBody(ResolveInputRequestSchema, request.body);
    const rt = runtime();
    return deps.commands.run(body.commandId, 'run.resolve', null, async () => {
      const run = await loadRun(rt.storage, runId);
      const task = await loadTask(rt.storage, run.taskId);
      if (body.expectedRevision !== task.revision) {
        throw fail.revisionConflict(body.expectedRevision, task.revision);
      }
      const handle = await rt.harness.resolve({
        commandId: body.commandId,
        runId: run.id,
        expectedRevision: task.revision,
        blockerId: body.blockerId,
        optionId: body.optionId,
        value: body.value,
        note: body.note,
        actor: 'local-user',
      });
      if (handle.state === 'RUNNING' || handle.state === 'READY') {
        await rt.scheduler.submit(run.id);
      }
      const latest = await loadRun(rt.storage, run.id);
      return {
        commandId: body.commandId,
        duplicate: false,
        runId: run.id,
        state: latest.state ?? handle.state,
        revision: task.revision,
      };
    });
  });

  for (const [action, method] of [
    ['pause', 'pause'],
    ['resume', 'resume'],
    ['cancel', 'cancel'],
  ] as const) {
    app.post(`${API_ROUTES.runBase}/:id/${action}`, async (request) => {
      const runId = requireParam(request.params as Record<string, string>, 'id');
      const body = parseBody(RunControlRequestSchema, request.body);
      const rt = runtime();
      return deps.commands.run(body.commandId, `run.${action}`, null, async () => {
        const run = await loadRun(rt.storage, runId);
        const task = await loadTask(rt.storage, run.taskId);
        if (body.expectedRevision !== task.revision) {
          throw fail.revisionConflict(body.expectedRevision, task.revision);
        }
        if (method === 'pause') {
          await rt.harness.pause({ commandId: body.commandId, runId: run.id, expectedRevision: task.revision, actor: 'local-user' });
        } else if (method === 'resume') {
          await rt.harness.resume({ commandId: body.commandId, runId: run.id, expectedRevision: task.revision, actor: 'local-user' });
          await rt.scheduler.submit(run.id);
        } else {
          await rt.harness.cancel({ commandId: body.commandId, runId: run.id, expectedRevision: task.revision, reason: body.reason, actor: 'local-user' });
        }
        const latest = await loadRun(rt.storage, run.id);
        return {
          commandId: body.commandId,
          duplicate: false,
          runId: run.id,
          state: latest.state ?? run.state,
          revision: task.revision,
        };
      });
    });
  }

  /* --------------------------------- patches --------------------------------- */
  app.get(`${API_ROUTES.patches}/:id`, async (request) => {
    const patchId = requireParam(request.params as Record<string, string>, 'id');
    const rt = runtime();
    const patch = await rt.storage.getPatch(patchId);
    if (!patch) throw fail.notFound('补丁');
    const module = await rt.storage.getModule(patch.moduleId);
    if (!module) throw fail.notFound('模块');
    const validation = patch.validationReportId ? await rt.storage.getValidationReport(patch.validationReportId) : null;
    const baseVersion = patch.baseVersionId ? await rt.storage.getVersion(patch.baseVersionId) : null;
    const diff = diffModuleContent(module.id, module.kind, baseVersion?.content ?? null, patch.candidate, {
      baseVersionId: patch.baseVersionId,
      candidateHash: patch.candidateHash,
    });
    return PatchReviewResponseSchema.parse({
      patch,
      diff,
      validation,
      baseContent: baseVersion?.content ?? null,
    });
  });

  app.post(`${API_ROUTES.patches}/:id/accept`, async (request) => {
    const patchId = requireParam(request.params as Record<string, string>, 'id');
    const body = parseBody(AcceptPatchRequestSchema, request.body);
    const rt = runtime();
    return deps.commands.run(body.commandId, 'patch.accept', null, async () => {
      const patch = await rt.storage.getPatch(patchId);
      if (!patch) throw fail.notFound('补丁');
      const task = await loadTask(rt.storage, patch.taskId);
      if (body.expectedRevision !== task.revision) {
        throw fail.revisionConflict(body.expectedRevision, task.revision);
      }
      const result = await rt.harness.accept({
        commandId: body.commandId,
        patchId,
        expectedRevision: task.revision,
        validationReportId: body.validationReportId,
        acceptMode: body.acceptMode,
        sectionIds: body.sectionIds,
        note: body.note,
        actor: 'local-user',
      });
      return {
        commandId: body.commandId,
        duplicate: false,
        patchId: patch.id,
        versionId: result.versionId,
        moduleId: result.moduleId,
        runState: result.runState,
        artifactRevision: result.artifactRevision,
      };
    });
  });

  app.post(`${API_ROUTES.patches}/:id/reject`, async (request) => {
    const patchId = requireParam(request.params as Record<string, string>, 'id');
    const body = parseBody(RejectPatchRequestSchema, request.body);
    const rt = runtime();
    return deps.commands.run(body.commandId, 'patch.reject', null, async () => {
      const patch = await rt.storage.getPatch(patchId);
      if (!patch) throw fail.notFound('补丁');
      const result = await rt.harness.reject({
        commandId: body.commandId,
        patchId,
        reason: body.reason,
        actor: 'local-user',
      });
      return { commandId: body.commandId, duplicate: false, patchId: result.patchId, status: result.status };
    });
  });

  /* -------------------------------- artifacts -------------------------------- */
  app.post(`${API_ROUTES.artifactBase}/:id/restore`, async (request) => {
    const artifactId = requireParam(request.params as Record<string, string>, 'id');
    const body = parseBody(RestoreVersionRequestSchema, request.body);
    const rt = runtime();
    return deps.commands.run(body.commandId, 'artifact.restore', null, async () => {
      const artifact = await rt.storage.getArtifact(artifactId);
      if (!artifact) throw fail.notFound('交付物');
      const task = await loadTask(rt.storage, artifact.taskId);
      if (body.expectedRevision !== task.revision) {
        throw fail.revisionConflict(body.expectedRevision, task.revision);
      }
      const result = await rt.harness.restore({
        commandId: body.commandId,
        taskId: task.id,
        moduleId: body.moduleId,
        versionId: body.versionId,
        expectedRevision: task.revision,
        note: body.note,
        actor: 'local-user',
      });
      return {
        commandId: body.commandId,
        duplicate: false,
        versionId: result.versionId,
        moduleId: body.moduleId,
        artifactRevision: result.artifactRevision,
      };
    });
  });

  /* --------------------------------- recipes --------------------------------- */
  app.post(API_ROUTES.recipePropose, async (request) => {
    const body = parseBody(ProposeRecipeRequestSchema, request.body);
    const rt = runtime();
    return deps.commands.run(body.commandId, 'recipe.propose', null, async () => {
      const run = await loadRun(rt.storage, body.runId);
      const result = await proposeRecipe(rt, {
        runId: run.id,
        name: body.name,
        description: body.description,
        kind: body.kind,
        applicability: body.applicability,
      });
      return { commandId: body.commandId, duplicate: false, proposal: result.proposal, sourceRunId: run.id, traceStepCount: result.traceStepCount };
    });
  });

  app.post(API_ROUTES.recipes, async (request) => {
    const body = parseBody(CreateRecipeRequestSchema, request.body);
    const rt = runtime();
    return deps.commands.run(body.commandId, 'recipe.create', null, async () => {
      const { recipe, events } = await registerRecipe(rt, body.proposal);
      await rt.storage.appendEvents(recipe.sourceTaskId, events);
      return {
        commandId: body.commandId,
        duplicate: false,
        recipeId: recipe.id,
        version: recipe.version,
        status: recipe.status,
        recipe,
      };
    });
  });

  app.get(API_ROUTES.recipes, async (request) => {
    const rt = runtime();
    const query = request.query as { taskId?: string };
    const taskId = query.taskId ?? null;
    const recipes = await rt.storage.listRecipes(taskId as never);
    return { recipes };
  });

  app.get(`${API_ROUTES.recipes}/:id`, async (request) => {
    const recipeId = requireParam(request.params as Record<string, string>, 'id');
    const rt = runtime();
    const recipe = await rt.storage.getRecipe(recipeId);
    if (!recipe) throw fail.notFound('配方');
    return { recipe };
  });

  app.post(`${API_ROUTES.recipes}/:id/validate`, async (request) => {
    const recipeId = requireParam(request.params as Record<string, string>, 'id');
    const body = parseBody(ValidateRecipeRequestSchema, request.body);
    const rt = runtime();
    return deps.commands.run(body.commandId, 'recipe.validate', null, async () => {
      const recipe = await rt.storage.getRecipe(recipeId);
      if (!recipe) throw fail.notFound('配方');
      const service = new RecipeService(rt);
      const { recipe: updated, events } = await service.validate(recipe, body.testInputs);
      if (events.length) await rt.storage.appendEvents(updated.sourceTaskId, events);
      return {
        commandId: body.commandId,
        duplicate: false,
        recipeId: updated.id,
        version: updated.version,
        status: updated.status,
        testCases: updated.testCases,
      };
    });
  });

  app.post(`${API_ROUTES.recipes}/:id/run`, async (request) => {
    const recipeId = requireParam(request.params as Record<string, string>, 'id');
    const body = parseBody(RunRecipeRequestSchema, request.body);
    const rt = runtime();
    return deps.commands.run(body.commandId, 'recipe.run', null, async () => {
      const recipe = await rt.storage.getRecipe(recipeId);
      if (!recipe) throw fail.notFound('配方');
      const service = new RecipeService(rt);
      const outcome = await service.run(recipe, body.inputs, body.commandId);
      await rt.storage.appendEvents(outcome.run.taskId, outcome.events);
      return {
        commandId: body.commandId,
        duplicate: false,
        recipeId: recipe.id,
        runId: outcome.run.id,
        cacheState: 'executed' as const,
        result: outcome.result,
      };
    });
  });

  app.post(`${API_ROUTES.recipes}/:id/disable`, async (request) => {
    const recipeId = requireParam(request.params as Record<string, string>, 'id');
    const body = parseBody(DisableRecipeRequestSchema, request.body);
    const rt = runtime();
    return deps.commands.run(body.commandId, 'recipe.disable', null, async () => {
      const recipe = await rt.storage.getRecipe(recipeId);
      if (!recipe) throw fail.notFound('配方');
      const updated = { ...recipe, status: 'disabled' as const, updatedAt: utcNow() };
      await rt.storage.updateRecipe(updated);
      await rt.storage.appendEvents(recipe.sourceTaskId, [
        {
          runId: null,
          stepId: null,
          causationId: body.commandId,
          type: 'recipe.disabled',
          payload: { recipeId: recipe.id, version: recipe.version, reason: body.reason },
        },
      ]);
      return { commandId: body.commandId, duplicate: false, recipe: updated };
    });
  });
}

/** Exposed for tests: pure checks used by the route layer. */
export function patchBaseMatchesAccepted(patch: PatchProposal, acceptedVersionId: string | null): boolean {
  return (patch.baseVersionId ?? null) === (acceptedVersionId ?? null);
}
