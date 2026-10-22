import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  API_ROUTES,
  CreateProviderProfileRequestSchema,
  CreateTaskRequestSchema,
  DemoTemplateSchema,
  ExportRequestSchema,
  HarnessEventSchema,
  ImportRequestSchema,
  LIMITS,
  ModuleContentResponseSchema,
  ProviderProfileListResponseSchema,
  SessionInfoSchema,
  SnapshotQuerySchema,
  SourceImportRequestSchema,
  SwitchModeRequestSchema,
  TestProviderRequestSchema,
  UpdateTaskRequestSchema,
  UpdateWorkspaceRequestSchema,
  VersionListResponseSchema,
  WorkspaceViewSchema,
  findPlanCycle,
  newArtifactId,
  newModuleId,
  newProviderProfileId,
  newSourceId,
  newTaskId,
  utcNow,
  type Artifact,
  type ArtifactId,
  type ArtifactModule,
  type HarnessEvent,
  type ModuleId,
  type ProviderProfile,
  type Task,
  type TaskModuleInput,
  type TaskTemplate,
} from '@ca/contracts';
import { runCapabilityTests, assertProviderUrlAllowed } from '@ca/providers';
import { urlPolicyFor, type ServerConfig } from './config';
import { fail, ApiFailure } from './errors';
import {
  CommandRunner,
  decodeBase64,
  loadTask,
  parseBody,
  parseQuery,
  requireParam,
  requireRevision,
  toBase64,
  uuidOrFail,
} from './http';
import type { RuntimeManager, ModeRuntime } from './runtime-manager';
import type { SessionManager } from './session';
import { exportTask, importTaskPackage } from './export-service';
import { ensureDemoSeeded } from './seed-demo';
import { findBuiltInTemplate, type TemplateCatalog } from './templates';

export interface CoreRouteDeps {
  config: ServerConfig;
  session: SessionManager;
  manager: RuntimeManager;
  commands: CommandRunner;
  catalog: TemplateCatalog;
  startedAt: number;
  log: (message: string, details?: Record<string, unknown>) => void;
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function registerCoreRoutes(app: FastifyInstance, deps: CoreRouteDeps): Promise<void> {
  const { manager, session } = deps;
  const runtime = (): ModeRuntime => manager.runtime();
  const liveRuntime = (): ModeRuntime => {
    const live = manager.live();
    if (!live) throw fail.stateNotAllowed('Live 模式不可用');
    if (live.mode !== manager.currentMode) throw fail.stateNotAllowed('请先切换到 Live 模式');
    return live;
  };

  /* ------------------------------- health ------------------------------- */
  app.get(API_ROUTES.health, async () => ({
    ok: true,
    service: 'cognitive-atrium',
    version: manager.appVersion,
    modes: manager.availableModes(),
    mode: manager.currentMode,
    time: utcNow(),
    uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000),
  }));

  /* ------------------------------- session ------------------------------- */
  app.get(API_ROUTES.session, async (_request, reply) => {
    const rt = runtime();
    let liveProviderConfigured = false;
    const live = manager.live();
    if (live?.liveProviders) {
      try {
        const profiles = await live.liveProviders.publicProfiles();
        liveProviderConfigured = profiles.some((p) => p.enabled && p.credentialConfigured);
      } catch {
        liveProviderConfigured = false;
      }
    }
    const info = SessionInfoSchema.parse({
      authenticated: true,
      mode: manager.currentMode,
      availableModes: manager.availableModes(),
      csrfToken: session.csrfToken,
      serverVersion: manager.appVersion,
      policyVersion: rt.storage ? 'p0-policy-1' : 'p0-policy-1',
      liveProviderConfigured,
      demoAvailable: manager.availableModes().includes('demo'),
      serverTime: utcNow(),
      uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000),
    });
    reply.header('set-cookie', session.cookieHeader());
    reply.header('cache-control', 'no-store');
    return info;
  });

  /* ------------------------------ workspace ------------------------------ */
  app.get(API_ROUTES.workspace, async () => {
    const rt = runtime();
    const workspace = await rt.storage.getWorkspace();
    let profiles: Awaited<ReturnType<NonNullable<ModeRuntime['liveProviders']>['publicProfiles']>> = [];
    if (rt.liveProviders) {
      try {
        profiles = await rt.liveProviders.publicProfiles();
      } catch {
        profiles = [];
      }
    }
    return WorkspaceViewSchema.parse({
      workspace,
      providerProfiles: profiles,
      demoAvailable: manager.availableModes().includes('demo'),
      liveAvailable: manager.availableModes().includes('live'),
      appVersion: manager.appVersion,
      policyVersion: workspace.policyVersion,
      limits: {
        maxSourceFileBytes: LIMITS.maxSourceFileBytes,
        maxTaskSourceBytes: LIMITS.maxTaskSourceBytes,
        maxSourcesPerTask: LIMITS.maxSourcesPerTask,
        maxModulesPerArtifact: LIMITS.maxModulesPerArtifact,
        maxSpatialBranches: LIMITS.maxSpatialBranches,
        maxSpatialNodes: LIMITS.maxSpatialNodes,
        maxSpatialEdges: LIMITS.maxSpatialEdges,
      },
    });
  });

  app.put(API_ROUTES.workspace, async (request) => {
    const body = parseBody(UpdateWorkspaceRequestSchema, request.body);
    const rt = runtime();
    return deps.commands.run(body.commandId, 'workspace.update', null, async () => {
      const workspace = await rt.storage.updateWorkspaceSettings(body.settings);
      return { commandId: body.commandId, duplicate: false, workspace };
    });
  });

  app.post(API_ROUTES.workspaceMode, async (request) => {
    const body = parseBody(SwitchModeRequestSchema, request.body);
    return deps.commands.run(body.commandId, 'workspace.mode', null, async () => {
      await manager.switchMode(body.mode);
      return { commandId: body.commandId, duplicate: false, mode: body.mode, redirected: false };
    });
  });

  /* --------------------------- provider profiles --------------------------- */
  app.get(API_ROUTES.providerProfiles, async () => {
    const rt = runtime();
    const profiles = rt.liveProviders ? await rt.liveProviders.publicProfiles() : [];
    return ProviderProfileListResponseSchema.parse({ profiles });
  });

  app.post(API_ROUTES.providerProfiles, async (request) => {
    const body = parseBody(CreateProviderProfileRequestSchema, request.body);
    const rt = liveRuntime();
    if (!rt.liveProviders) throw fail.stateNotAllowed('Live 模式不可用');
    return deps.commands.run(body.commandId, 'provider.create', null, async () => {
      assertProviderUrlAllowed(body.baseURL, urlPolicyFor(deps.config));
      const existing = await rt.storage.listProviderProfiles();
      if (existing.some((p) => p.profileName === body.profileName)) {
        throw fail.conflict(`连接配置名称已存在：${body.profileName}`);
      }
      const credentialRef = normalizeCredentialRef(body.credentialRef);
      const now = utcNow();
      const profile: ProviderProfile = {
        id: newProviderProfileId(),
        profileName: body.profileName,
        adapterType: body.adapterType,
        baseURL: body.baseURL.replace(/\/+$/, ''),
        model: body.model,
        credentialRef,
        enabled: body.enabled,
        timeouts: body.timeouts ?? {},
        contextWindowOverride: body.contextWindowOverride ?? null,
        priceTable: body.priceTable ?? null,
        capabilities: {
          streaming: 'unknown',
          toolCalling: 'unknown',
          structuredOutput: 'unknown',
          vision: 'unknown',
          usageReporting: 'unknown',
        },
        createdAt: now,
        updatedAt: now,
      };
      await rt.storage.upsertProviderProfile(profile);
      if (body.credentialValue && body.credentialValue.trim().length > 0) {
        await rt.credentials.set(credentialRef, body.credentialValue.trim());
      }
      const profiles = await rt.liveProviders!.publicProfiles();
      const created = profiles.find((p) => p.id === profile.id);
      if (!created) throw fail.internal('连接配置已保存但无法读取');
      return { commandId: body.commandId, duplicate: false, profileId: profile.id, profile: created };
    });
  });

  app.put(`${API_ROUTES.providerProfiles}/:id`, async (request) => {
    const body = parseBody(CreateProviderProfileRequestSchema, request.body);
    const profileId = requireParam(request.params as Record<string, string>, 'id');
    const rt = liveRuntime();
    return deps.commands.run(body.commandId, 'provider.update', null, async () => {
      const existing = await rt.storage.getProviderProfile(profileId);
      if (!existing) throw fail.notFound('模型连接配置');
      assertProviderUrlAllowed(body.baseURL, urlPolicyFor(deps.config));
      const credentialRef = normalizeCredentialRef(body.credentialRef);
      const profile: ProviderProfile = {
        ...existing,
        profileName: body.profileName,
        adapterType: body.adapterType,
        baseURL: body.baseURL.replace(/\/+$/, ''),
        model: body.model,
        credentialRef,
        enabled: body.enabled,
        timeouts: body.timeouts ?? existing.timeouts,
        contextWindowOverride: body.contextWindowOverride ?? null,
        priceTable: body.priceTable ?? null,
        updatedAt: utcNow(),
      };
      await rt.storage.upsertProviderProfile(profile);
      if (body.credentialValue !== undefined && body.credentialValue.trim().length > 0) {
        await rt.credentials.set(credentialRef, body.credentialValue.trim());
      }
      const profiles = await rt.liveProviders!.publicProfiles();
      const updated = profiles.find((p) => p.id === profile.id);
      if (!updated) throw fail.internal('连接配置已保存但无法读取');
      return { commandId: body.commandId, duplicate: false, profileId: profile.id, profile: updated };
    });
  });

  app.delete(`${API_ROUTES.providerProfiles}/:id`, async (request) => {
    const profileId = requireParam(request.params as Record<string, string>, 'id');
    const rt = liveRuntime();
    const existing = await rt.storage.getProviderProfile(profileId);
    if (!existing) throw fail.notFound('模型连接配置');
    await rt.storage.deleteProviderProfile(profileId);
    return { ok: true };
  });

  app.post(`${API_ROUTES.providerProfiles}/:id/test`, async (request) => {
    const profileId = requireParam(request.params as Record<string, string>, 'id');
    const body = parseBody(TestProviderRequestSchema, request.body);
    const rt = liveRuntime();
    return deps.commands.run(body.commandId, 'provider.test', null, async () => {
      const profile = await rt.storage.getProviderProfile(profileId);
      if (!profile) throw fail.notFound('模型连接配置');
      assertProviderUrlAllowed(profile.baseURL, urlPolicyFor(deps.config));
      const beyondAuth = body.probes.some((probe) => probe !== 'auth_and_text');
      if (beyondAuth && !body.confirmCharges) {
        throw fail.validationFailed('能力探测会产生少量真实模型调用费用，请确认后再执行（confirmCharges=true）');
      }
      const credential = await rt.credentials.get(profile.credentialRef);
      if (!credential) {
        throw fail.provider(`凭据 ${profile.credentialRef} 未配置，无法测试连接`);
      }
      let report;
      try {
        report = (
          await runCapabilityTests({
            profile,
            credential: credential.value,
            probes: body.probes,
          })
        ).report;
      } catch (error) {
        if (error instanceof ApiFailure) throw error;
        throw fail.provider(`能力测试失败：${error instanceof Error ? error.message : String(error)}`);
      }
      await rt.storage.upsertProviderProfile({ ...profile, capabilities: report.capabilities, updatedAt: utcNow() });
      return { commandId: body.commandId, duplicate: false, report };
    });
  });

  /* --------------------------------- tasks --------------------------------- */
  app.post(API_ROUTES.tasks, async (request) => {
    const body = parseBody(CreateTaskRequestSchema, request.body);
    const rt = runtime();
    return deps.commands.run(body.commandId, 'task.create', null, async () => {
      const now = utcNow();
      const taskId = newTaskId();
      const artifactId = newArtifactId();
      const modules = buildModules(body.modules, body.templateId, deps.catalog, artifactId, now);
      const task: Task = {
        id: taskId,
        workspaceId: (await rt.storage.getWorkspace()).id,
        title: body.title,
        intent: body.intent,
        constraints: body.constraints.map((constraint) => ({
          ...constraint,
          status: 'open' as const,
        })),
        artifactId,
        revision: 0,
        templateId: body.templateId ?? null,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
      const artifact: Artifact = {
        id: artifactId,
        taskId,
        title: body.artifactTitle,
        moduleIds: modules.map((m) => m.id),
        acceptedVersionId: null,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
      await rt.storage.insertTaskBundle({ task, artifact, modules });
      return {
        commandId: body.commandId,
        duplicate: false,
        taskId,
        artifactId,
        revision: 0,
        moduleIds: modules.map((m) => m.id),
      };
    });
  });

  app.get(API_ROUTES.tasks, async () => {
    const rt = runtime();
    const tasks = await rt.storage.listTasks();
    const items = [];
    for (const task of tasks) {
      const aggregate = await rt.storage.getTaskAggregate(task.id);
      const runs = await rt.storage.listRuns(task.id);
      const activeRun = runs
        .filter((r) => !['COMPLETED', 'CANCELLED', 'FAILED'].includes(r.state))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      items.push({
        taskId: task.id,
        artifactId: task.artifactId,
        title: task.title,
        status: task.status,
        revision: task.revision,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        moduleCount: aggregate?.modules.length ?? 0,
        activeRunState: activeRun?.state ?? null,
        acceptedCount: aggregate?.modules.filter((m) => m.acceptedVersionId).length ?? 0,
      });
    }
    return { tasks: items };
  });

  app.get(`${API_ROUTES.tasks}/:id`, async (request) => {
    const taskId = requireParam(request.params as Record<string, string>, 'id');
    const snapshot = await runtime().snapshot({ taskId, afterSeq: 0, includeEvents: true });
    if (!snapshot) throw fail.notFound('任务');
    return snapshot;
  });

  app.patch(`${API_ROUTES.tasks}/:id`, async (request) => {
    const taskId = requireParam(request.params as Record<string, string>, 'id');
    const body = parseBody(UpdateTaskRequestSchema, request.body);
    const rt = runtime();
    return deps.commands.run(body.commandId, 'task.update', taskId as never, async () => {
      const task = await loadTask(rt.storage, taskId);
      requireRevision(body.expectedRevision, task.revision);
      const updatedTask: Task = {
        ...task,
        title: body.title ?? task.title,
        intent: body.intent ?? task.intent,
        constraints: body.constraints ?? task.constraints,
        revision: task.revision + 1,
        updatedAt: utcNow(),
      };
      if (body.modules && body.modules.length > 0) {
        const aggregate = await rt.storage.getTaskAggregate(taskId as never);
        if (!aggregate) throw fail.notFound('任务');
        const updatedModules = aggregate.modules.map((module) => {
          const patch = body.modules!.find((m) => m.moduleId === module.id);
          if (!patch) return module;
          return {
            ...module,
            title: patch.title ?? module.title,
            order: patch.order ?? module.order,
            dependencies: (patch.dependencies ?? module.dependencies) as ModuleId[],
            acceptanceCriteria: patch.acceptanceCriteria
              ? patch.acceptanceCriteria.map((criterion, index) => ({
                  id: criterion.id ?? `${module.id}-ac-${index + 1}`,
                  text: criterion.text,
                  layer: criterion.layer,
                  validatorId: null,
                }))
              : module.acceptanceCriteria,
            updatedAt: utcNow(),
          } satisfies ArtifactModule;
        });
        const cycle = findPlanCycle(updatedModules.map((m) => ({ id: m.id, dependencies: m.dependencies })));
        if (cycle) throw fail.validationFailed('模块依赖存在环', { cycle });
        await rt.storage.transaction(async () => {
          await rt.storage.updateTask(updatedTask);
          await rt.storage.updateModules(updatedModules);
        });
        return { commandId: body.commandId, duplicate: false, task: updatedTask };
      }
      await rt.storage.updateTask(updatedTask);
      return { commandId: body.commandId, duplicate: false, task: updatedTask };
    });
  });

  app.post(`${API_ROUTES.tasks}/:id/sources`, { bodyLimit: Math.ceil((LIMITS.maxSourceFileBytes * 4) / 3) + 64 * 1024 }, async (request) => {
    const taskId = requireParam(request.params as Record<string, string>, 'id');
    const body = parseBody(SourceImportRequestSchema, request.body);
    const rt = runtime();
    return deps.commands.run(body.commandId, 'source.import', taskId as never, async () => {
      const task = await loadTask(rt.storage, taskId);
      const existing = await rt.storage.listSources(task.id);
      if (existing.length >= LIMITS.maxSourcesPerTask) {
        throw fail.validationFailed(`单个任务最多导入 ${LIMITS.maxSourcesPerTask} 份资料`);
      }
      const bytes = decodeBase64(body.contentBase64, LIMITS.maxSourceFileBytes, '资料文件');
      const fileName = sanitizeFileName(body.fileName);
      const ext = path.extname(fileName).toLowerCase();
      const supported = new Set(['.txt', '.md', '.markdown', '.json', '.csv']);
      if (!supported.has(ext)) {
        throw fail.unsupportedMedia(`暂不支持 ${ext || '该'} 类型文件；首版支持 UTF-8 TXT、Markdown、JSON、CSV`);
      }
      const parse = inspectContent(bytes, ext);
      const hash = createHash('sha256').update(bytes).digest('hex');
      const sourceId = newSourceId();
      const totalBytes = existing.reduce((sum, source) => sum + source.sizeBytes, 0) + bytes.length;
      if (totalBytes > LIMITS.maxTaskSourceBytes) {
        throw fail.payloadTooLarge(`任务资料总量超过 ${Math.round(LIMITS.maxTaskSourceBytes / 1024 / 1024)}MiB 限制`);
      }
      await rt.storage.insertSource(
        {
          id: sourceId,
          taskId: task.id,
          name: fileName,
          mime: body.mime,
          version: 1,
          sizeBytes: bytes.length,
          hash,
          origin: body.origin,
          trustLevel: 'user_provided',
          availability: 'available',
          parseStatus: parse.status,
          parseNote: parse.note,
          createdAt: utcNow(),
        },
        bytes,
      );
      return {
        commandId: body.commandId,
        duplicate: false,
        sourceId,
        version: 1,
        parseStatus: parse.status,
        parseNote: parse.note,
        warnings: parse.status === 'parsed' ? [] : [parse.note],
      };
    });
  });

  app.get(`${API_ROUTES.tasks}/:id/snapshot`, async (request) => {
    const taskId = requireParam(request.params as Record<string, string>, 'id');
    const query = parseQuery(SnapshotQuerySchema, request.query);
    const snapshot = await runtime().snapshot({ taskId, afterSeq: query.afterSeq, includeEvents: query.includeEvents });
    if (!snapshot) throw fail.notFound('任务');
    return snapshot;
  });

  app.get(`${API_ROUTES.tasks}/:id/events`, async (request, reply) => {
    const taskId = requireParam(request.params as Record<string, string>, 'id');
    const rt = runtime();
    const task = await rt.storage.getTask(taskId as never);
    if (!task) throw fail.notFound('任务');
    const query = request.query as { afterSeq?: string };
    const lastEventId = request.headers['last-event-id'];
    const startSeq = Math.max(
      0,
      Number(query.afterSeq ?? (Array.isArray(lastEventId) ? lastEventId[0] : lastEventId) ?? 0) || 0,
    );
    await streamEvents(reply, rt, taskId, startSeq);
  });

  /* ------------------------------ export/import ------------------------------ */
  app.post(`${API_ROUTES.tasks}/:id/export`, { bodyLimit: 1024 * 1024 }, async (request) => {
    const taskId = requireParam(request.params as Record<string, string>, 'id');
    const body = parseBody(ExportRequestSchema, request.body);
    const rt = runtime();
    return deps.commands.run(body.commandId, 'task.export', taskId as never, async () => {
      const result = await exportTask({ storage: rt.storage, appVersion: manager.appVersion }, taskId as never, body.format, body.moduleIds, body.includeSources);
      return { commandId: body.commandId, ...result };
    });
  });

  app.post(API_ROUTES.imports, { bodyLimit: 64 * 1024 * 1024 }, async (request) => {
    const body = parseBody(ImportRequestSchema, request.body);
    const rt = runtime();
    return deps.commands.run(body.commandId, 'task.import', null, async () => {
      const bytes = decodeBase64(body.contentBase64, LIMITS.maxImportPackageBytes, '任务包');
      const result = await importTaskPackage({ storage: rt.storage, appVersion: manager.appVersion }, bytes);
      return { commandId: body.commandId, duplicate: false, ...result };
    });
  });

  /* ------------------------------ module views ------------------------------ */
  app.get(`${API_ROUTES.tasks}/:id/modules/:moduleId/content`, async (request) => {
    const taskId = requireParam(request.params as Record<string, string>, 'id');
    const moduleId = requireParam(request.params as Record<string, string>, 'moduleId');
    const query = request.query as { versionId?: string };
    const rt = runtime();
    const aggregate = await rt.storage.getTaskAggregate(taskId as never);
    if (!aggregate) throw fail.notFound('任务');
    const module = aggregate.modules.find((m) => m.id === moduleId);
    if (!module) throw fail.notFound('模块');
    const version = query.versionId ? await rt.storage.getVersion(query.versionId) : module.acceptedVersionId ? await rt.storage.getVersion(module.acceptedVersionId) : null;
    if (version && version.moduleId !== module.id) throw fail.validationFailed('版本不属于该模块');
    return ModuleContentResponseSchema.parse({
      moduleId: module.id,
      versionId: version?.id ?? null,
      contentHash: version?.contentHash ?? null,
      moduleKind: module.kind,
      content: version?.content ?? null,
      acceptedAt: version?.acceptedAt ?? null,
      acceptedBy: version?.acceptedBy ?? null,
    });
  });

  app.get(`${API_ROUTES.tasks}/:id/modules/:moduleId/versions`, async (request) => {
    const taskId = requireParam(request.params as Record<string, string>, 'id');
    const moduleId = requireParam(request.params as Record<string, string>, 'moduleId');
    const rt = runtime();
    const aggregate = await rt.storage.getTaskAggregate(taskId as never);
    if (!aggregate) throw fail.notFound('任务');
    const module = aggregate.modules.find((m) => m.id === moduleId);
    if (!module) throw fail.notFound('模块');
    const versions = await rt.storage.listVersions(moduleId);
    return VersionListResponseSchema.parse({
      moduleId: module.id,
      versions: versions.map((version) => ({
        versionId: version.id,
        contentHash: version.contentHash,
        acceptedAt: version.acceptedAt,
        acceptedBy: version.acceptedBy,
        parentId: version.parentId,
        sourceRunId: version.sourceRunId,
        note: version.note,
        isCurrent: version.id === module.acceptedVersionId,
      })),
    });
  });

  /* ---------------------------------- demo ---------------------------------- */
  app.get(API_ROUTES.demoScenario, async () => {
    const builtIn = deps.catalog.builtIn;
    return DemoTemplateSchema.parse({
      templateId: builtIn.id,
      name: builtIn.name,
      description: builtIn.description,
      modules: builtIn.modules.map((module) => ({ key: module.key, title: module.title, kind: module.kind, status: 'empty' })),
      seedSourceNames: deps.catalog.scenarioSources.map((source) => source.name),
      fixtureVersion: '1',
    });
  });

  app.post(API_ROUTES.demoReset, async (request) => {
    const body = request.body as { commandId?: string };
    if (manager.currentMode !== 'demo') throw fail.stateNotAllowed('仅演示模式可以重置演示数据');
    const rt = manager.runtime('demo');
    const commandId = body?.commandId;
    if (!commandId) throw fail.badRequest('缺少 commandId');
    return deps.commands.run(commandId, 'demo.reset', null, async () => {
      if ((await rt.storage.countActiveRuns()) > 0) throw fail.stateNotAllowed('存在运行中的演示任务，不能重置');
      await rt.storage.resetDemoData();
      await ensureDemoSeeded({ storage: rt.storage, config: deps.config, log: deps.log });
      const tasks = await rt.storage.listTasks();
      return {
        commandId,
        duplicate: false,
        taskId: tasks[0]?.id ?? null,
        template: DemoTemplateSchema.parse({
          templateId: deps.catalog.builtIn.id,
          name: deps.catalog.builtIn.name,
          description: deps.catalog.builtIn.description,
          modules: deps.catalog.builtIn.modules.map((module) => ({ key: module.key, title: module.title, kind: module.kind, status: 'empty' })),
          seedSourceNames: deps.catalog.scenarioSources.map((source) => source.name),
          fixtureVersion: '1',
        }),
      };
    });
  });
}

/* -------------------------------- helpers -------------------------------- */

function normalizeCredentialRef(ref: string): string {
  const normalized = ref.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  if (!/^[A-Z][A-Z0-9_]{1,99}$/.test(normalized)) {
    throw fail.validationFailed('credentialRef 必须是环境变量风格的名称（例如 CA_OPENAI_API_KEY）');
  }
  return normalized;
}

function sanitizeFileName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"|?*]/g, '_');
  const trimmed = base.trim().slice(0, 240);
  if (!trimmed || trimmed === '.' || trimmed === '..') throw fail.validationFailed('文件名无效');
  return trimmed;
}

function inspectContent(bytes: Uint8Array, ext: string): { status: 'parsed' | 'failed'; note: string } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.trim().length === 0) return { status: 'failed', note: '文件内容为空，已登记但不可用于检索' };
    if (ext === '.json') {
      JSON.parse(text);
      return { status: 'parsed', note: '' };
    }
    if (ext === '.csv') {
      const firstLine = text.split(/\r?\n/)[0] ?? '';
      if (!firstLine.includes(',')) return { status: 'failed', note: 'CSV 表头缺少逗号分隔字段，无法作为表格解析' };
      return { status: 'parsed', note: '' };
    }
    return { status: 'parsed', note: '' };
  } catch {
    return { status: 'failed', note: '文件不是有效 UTF-8 文本；首版仅支持 UTF-8 编码' };
  }
}

function buildModules(
  inputs: readonly TaskModuleInput[],
  templateId: string | null,
  catalog: TemplateCatalog,
  artifactId: ArtifactId,
  now: string,
): ArtifactModule[] {
  if (inputs.length === 0) {
    if (!templateId) {
      throw fail.validationFailed('必须提供 modules 或 templateId');
    }
    const template = findBuiltInTemplate(catalog, templateId);
    return buildModulesFromTemplate(template, artifactId, now);
  }
  if (inputs.length > LIMITS.maxModulesPerArtifact) {
    throw fail.validationFailed(`模块数量不能超过 ${LIMITS.maxModulesPerArtifact}`);
  }
  const keyToId = new Map<string, ModuleId>();
  for (const input of inputs) {
    if (keyToId.has(input.key)) throw fail.validationFailed(`模块 key 重复：${input.key}`);
    keyToId.set(input.key, newModuleId());
  }
  const modules: ArtifactModule[] = inputs.map((input, index) => {
    for (const dep of input.dependsOnKeys) {
      if (!keyToId.has(dep)) throw fail.validationFailed(`模块 ${input.key} 依赖了不存在的 key：${dep}`);
      if (dep === input.key) throw fail.validationFailed(`模块 ${input.key} 不能依赖自身`);
    }
    return {
      id: keyToId.get(input.key)!,
      artifactId,
      title: input.title,
      kind: input.kind,
      order: input.order ?? index,
      dependencies: input.dependsOnKeys.map((key) => keyToId.get(key)!),
      acceptanceCriteria: input.acceptanceCriteria.map((criterion, criterionIndex) => ({
        id: `${input.key}-ac-${criterionIndex + 1}`,
        text: criterion.text,
        layer: criterion.layer,
        validatorId: null,
      })),
      status: 'empty',
      blockedFrom: null,
      acceptedVersionId: null,
      createdAt: now,
      updatedAt: now,
    };
  });
  const cycle = findPlanCycle(modules.map((m) => ({ id: m.id, dependencies: m.dependencies })));
  if (cycle) throw fail.validationFailed('模块依赖存在环', { cycle });
  return modules;
}

function buildModulesFromTemplate(template: TaskTemplate, artifactId: ArtifactId, now: string): ArtifactModule[] {
  const keyToId = new Map<string, ModuleId>();
  for (const input of template.modules) keyToId.set(input.key, newModuleId());
  return template.modules.map((input) => ({
    id: keyToId.get(input.key)!,
    artifactId,
    title: input.title,
    kind: input.kind,
    order: input.order,
    dependencies: input.dependsOnKeys.map((key) => {
      const id = keyToId.get(key);
      if (!id) throw fail.validationFailed(`模板模块 ${input.key} 依赖了不存在的 key：${key}`);
      return id;
    }),
    acceptanceCriteria: input.acceptanceCriteria.map((criterion, index) => ({
      id: `${input.key}-ac-${index + 1}`,
      text: criterion.text,
      layer: criterion.layer,
      validatorId: null,
    })),
    status: 'empty',
    blockedFrom: null,
    acceptedVersionId: null,
    createdAt: now,
    updatedAt: now,
  }));
}

/** SSE: only committed events are sent; seq ids allow Last-Event-ID resume. */
async function streamEvents(reply: FastifyReply, rt: ModeRuntime, taskId: string, startSeq: number): Promise<void> {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  raw.write('retry: 3000\n\n');
  let cursor = startSeq;
  let closed = false;
  let polling = false;
  let heartbeat: NodeJS.Timeout | null = null;
  const cleanup = (): void => {
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
    if (heartbeat) clearInterval(heartbeat);
    try {
      raw.end();
    } catch {
      // ignored
    }
  };
  const poll = async (): Promise<void> => {
    if (closed || polling) return;
    polling = true;
    try {
      const events = await rt.storage.eventsAfter(taskId as never, cursor, 200);
      if (events.length === 0) return;
      for (const event of events) {
        if (closed) return;
        const validated = HarnessEventSchema.parse(event) as HarnessEvent;
        raw.write(`id: ${validated.seq}\nevent: ${validated.type}\ndata: ${JSON.stringify(validated)}\n\n`);
        cursor = validated.seq;
      }
    } catch (error) {
      if (!closed) {
        const payload = { code: 'event_stream_error', message: error instanceof Error ? error.message : String(error) };
        raw.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
      }
      cleanup();
    } finally {
      polling = false;
    }
  };
  const pollTimer = setInterval(() => {
    void poll();
  }, 120);
  heartbeat = setInterval(() => {
    if (!closed) raw.write(`: heartbeat ${Date.now()}\n\n`);
  }, 15_000);
  reply.raw.on('close', cleanup);
  reply.raw.on('error', cleanup);
  await poll();
}
