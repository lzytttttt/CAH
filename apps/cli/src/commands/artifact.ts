/** `artifact` commands: review (patch + validation + evidence), accept, restore. */
import {
  API_ROUTES,
  AcceptPatchRequestSchema,
  AcceptPatchResponseSchema,
  ArtifactIdSchema,
  ArtifactVersionIdSchema,
  PatchIdSchema,
  RestoreVersionRequestSchema,
  RestoreVersionResponseSchema,
  TaskIdSchema,
  summarizeValidationFailures,
  type AcceptPatchResponse,
  type PatchReviewResponse,
  type RestoreVersionResponse,
} from '@ca/contracts';
import { UsageError } from '../exit';
import { heading, renderPatchReview, truncate } from '../format';
import type { CliOutcome, CommandSpec } from './types';
import {
  businessOutcome,
  commandId,
  getPatchReview,
  getSnapshot,
  okOutcome,
  parseId,
  resolveModuleId,
  stateError,
  validateRequest,
} from './shared';

/* ------------------------------------------------------------------ */
/* artifact review                                                     */
/* ------------------------------------------------------------------ */

export const artifactReviewCommand: CommandSpec = {
  path: 'artifact review',
  summary: '审阅候选补丁：差异摘要、验证结论与证据引用',
  flags: {
    '--full': { type: 'boolean', description: '显示完整差异摘录（默认截断为 160 字）' },
  },
  positionals: [{ name: 'patchId', description: '补丁 ID', required: true }],
  examples: ['cognitive-atrium artifact review <patchId>', 'cognitive-atrium artifact review <patchId> --full --json'],
  notes: ['验证失败（fail）的候选会以退出码 4 结束，避免脚本误判可接受。'],
  execute: async (command, ctx) => {
    const patchId = parseId(command.requirePositional(0, 'patchId'), PatchIdSchema, 'patchId');
    const review = await getPatchReview(ctx, patchId);
    return reviewOutcome(review, command.getBool('--full'));
  },
};

function reviewOutcome(review: PatchReviewResponse, full: boolean): CliOutcome {
  const human = renderPatchReview(review, { full });
  const validation = review.validation;
  if (validation && validation.status === 'fail') {
    const findings = summarizeValidationFailures(validation.checks);
    human.push('  结论：候选未通过验证，不能接受（artifact accept 会拒绝）。');
    return businessOutcome('artifact review', review, human, {
      exitCode: 4,
      status: 'failed',
      error: {
        kind: 'api',
        code: 'validation_failed',
        message: findings[0] ?? '候选未通过验证',
        details: findings,
      },
    });
  }
  if (!validation) human.push('  结论：该补丁尚无验证报告；接受时必须提供 validationReportId。');
  return okOutcome('artifact review', review, human);
}

/* ------------------------------------------------------------------ */
/* artifact accept                                                     */
/* ------------------------------------------------------------------ */

export const artifactAcceptCommand: CommandSpec = {
  path: 'artifact accept',
  summary: '接受候选补丁产生新版本（必须绑定验证报告，并校验基础版本未过期）',
  flags: {
    '--validation-report': { type: 'string', valueName: '<validationReportId>', description: '验证报告 ID（默认取补丁/审阅结果中的报告）' },
    '--mode': { type: 'string', valueName: '<all|sections>', choices: ['all', 'sections'], description: '接受全部或指定章节（默认 all）' },
    '--section': { type: 'list', valueName: '<sectionId>', description: '按章节接受时指定章节 ID，可重复' },
    '--note': { type: 'string', valueName: '<说明>', description: '接受备注（写入版本历史）' },
    '--base-version': { type: 'string', valueName: '<versionId>', description: '显式指定期望的基础版本 ID（默认取补丁声明）' },
    '--expected-revision': { type: 'number', valueName: '<n>', description: '显式指定期望的任务修订号' },
  },
  positionals: [{ name: 'patchId', description: '补丁 ID', required: true }],
  examples: [
    'cognitive-atrium artifact accept <patchId> --validation-report <validationReportId>',
    'cognitive-atrium artifact accept <patchId> --validation-report <id> --mode sections --section summary --section risks',
  ],
  notes: [
    '基础版本与当前已接受版本不一致时，CLI 本地即拒绝（不会覆盖他人成果）。',
    '验证结果为 fail 的候选不能接受；验证服务端仍会做同样检查。',
  ],
  execute: async (command, ctx) => {
    const patchId = parseId(command.requirePositional(0, 'patchId'), PatchIdSchema, 'patchId');
    const review = await getPatchReview(ctx, patchId);
    const patch = review.patch;
    if (patch.status === 'accepted') {
      throw stateError(
        `补丁 ${patchId} 已被接受，不能重复接受`,
        patch.acceptedVersionId ? `已产生的版本：${patch.acceptedVersionId}` : '请用 task status 查看当前版本。',
      );
    }
    if (patch.status !== 'proposed') {
      throw stateError(`补丁 ${patchId} 当前状态为 ${patch.status}，不能接受`, '请用 artifact review 查看最新状态。');
    }
    const validationReportId =
      command.getString('--validation-report') ?? patch.validationReportId ?? review.validation?.id ?? null;
    if (!validationReportId) {
      throw stateError(
        `补丁 ${patchId} 没有验证报告，不能接受`,
        '先执行 cognitive-atrium artifact review <patchId> 获取服务端验证结果；接受必须绑定 validationReportId。',
      );
    }
    if (review.validation && review.validation.status === 'fail') {
      const findings = summarizeValidationFailures(review.validation.checks);
      throw stateError(
        `候选未通过验证（validationReportId=${validationReportId}），不能接受`,
        findings.length ? `阻断项：\n${findings.map((finding) => `  - ${truncate(finding, 300)}`).join('\n')}` : '请重新生成候选后再审阅。',
        'validation_failed',
      );
    }
    const snapshot = await getSnapshot(ctx, patch.taskId);
    const moduleView = snapshot.modules.find((view) => view.module.id === patch.moduleId);
    if (!moduleView) {
      throw stateError(`任务投影中找不到补丁模块 ${patch.moduleId}，不能接受`, '请用 task status 检查任务结构是否已变化。');
    }
    const currentBase = moduleView.module.acceptedVersionId;
    if (patch.baseVersionId !== currentBase) {
      throw stateError(
        '补丁基于的基础版本已经变化（存在并发提交），本次接受被拒绝，未覆盖任何数据',
        `补丁基础版本：${patch.baseVersionId ?? '（无）'}；当前已接受版本：${currentBase ?? '（无）'}。请重新生成或审阅差异后重试。`,
        'version_conflict',
      );
    }
    const explicitBase = command.getString('--base-version');
    if (explicitBase !== undefined && explicitBase !== (patch.baseVersionId ?? '')) {
      throw stateError(
        `--base-version ${explicitBase} 与补丁声明的基础版本 ${patch.baseVersionId ?? '（无）'} 不一致`,
        '不接受基于未知版本的提交。',
        'version_conflict',
      );
    }
    const sectionIds = command.getList('--section');
    const acceptMode = (command.getString('--mode') ?? (sectionIds.length > 0 ? 'sections' : 'all')) as 'all' | 'sections';
    if (acceptMode === 'sections') {
      if (sectionIds.length === 0) throw new UsageError('--mode sections 需要至少一个 --section <sectionId>');
      const available = new Set(review.diff.entries.map((entry) => entry.sectionId).filter((id): id is string => Boolean(id)));
      const unknown = sectionIds.filter((id) => !available.has(id));
      if (unknown.length > 0) {
        throw new UsageError(`差异中不存在章节：${unknown.join(', ')}`, `可用章节：${[...available].join(', ') || '（该模块没有章节级差异）'}`);
      }
    }
    const expectedRevision = command.getNumber('--expected-revision') ?? snapshot.task.revision;
    const request = validateRequest(
      AcceptPatchRequestSchema,
      {
        commandId: commandId(ctx),
        expectedRevision,
        validationReportId,
        acceptMode,
        sectionIds: acceptMode === 'sections' ? sectionIds : [],
        note: command.getString('--note') ?? '',
      },
      '接受补丁请求',
    );
    const response = await ctx.client.post(AcceptPatchResponseSchema, API_ROUTES.patchAccept(patchId), request);
    const human = renderAcceptResult(response);
    return okOutcome('artifact accept', { accept: response, patch: review.patch, runState: response.runState }, human);
  },
};

function renderAcceptResult(response: AcceptPatchResponse): string[] {
  return [
    heading('补丁已接受'),
    `  补丁：${response.patchId}`,
    `  新版本：${response.versionId}`,
    `  模块：${response.moduleId}   成果修订：${response.artifactRevision}`,
    `  运行状态：${response.runState ?? '-'}${response.duplicate ? '（该命令此前已执行，服务端返回同一结果）' : ''}`,
    '  下一步：',
    `    cognitive-atrium task status <taskId>`,
    `    cognitive-atrium task export <taskId> --format markdown --out ./out`,
  ];
}

/* ------------------------------------------------------------------ */
/* artifact restore                                                    */
/* ------------------------------------------------------------------ */

export const artifactRestoreCommand: CommandSpec = {
  path: 'artifact restore',
  summary: '把历史版本恢复为新版本（历史不丢失，下游标记过期）',
  flags: {
    '--module': { type: 'string', valueName: '<moduleId|标题>', description: '要恢复的模块（必填）' },
    '--to-version': { type: 'string', valueName: '<versionId>', description: '要恢复到的历史版本 ID（必填）' },
    '--artifact': { type: 'string', valueName: '<artifactId>', description: '交付物 ID（默认取任务快照）' },
    '--note': { type: 'string', valueName: '<说明>', description: '恢复备注（写入版本历史）' },
    '--expected-revision': { type: 'number', valueName: '<n>', description: '显式指定期望的任务修订号' },
  },
  positionals: [{ name: 'taskId', description: '任务 ID', required: true }],
  examples: ['cognitive-atrium artifact restore <taskId> --module <moduleId> --to-version <versionId>'],
  notes: ['恢复不会删除历史版本；当前版本会作为旧版本保留在版本链中。'],
  execute: async (command, ctx) => {
    const taskId = parseId(command.requirePositional(0, 'taskId'), TaskIdSchema, 'taskId');
    const versionId = parseId(command.requireString('--to-version', '历史版本 ID'), ArtifactVersionIdSchema, 'versionId');
    const snapshot = await getSnapshot(ctx, taskId);
    const artifactId = parseId(
      command.getString('--artifact') ?? snapshot.artifact.id,
      ArtifactIdSchema,
      'artifactId',
    );
    const moduleId = resolveModuleId(
      snapshot.modules.map((view) => ({ id: view.module.id, title: view.module.title })),
      command.getString('--module'),
    );
    const expectedRevision = command.getNumber('--expected-revision') ?? snapshot.task.revision;
    const request = validateRequest(
      RestoreVersionRequestSchema,
      {
        commandId: commandId(ctx),
        expectedRevision,
        moduleId,
        versionId,
        note: command.getString('--note') ?? '',
      },
      '版本恢复请求',
    );
    const response = await ctx.client.post(RestoreVersionResponseSchema, API_ROUTES.artifactRestore(artifactId), request);
    const human = renderRestoreResult(response, versionId);
    return okOutcome('artifact restore', { restore: response, restoredFrom: versionId }, human);
  },
};

function renderRestoreResult(response: RestoreVersionResponse, restoredFrom: string): string[] {
  return [
    heading('版本已恢复'),
    `  模块：${response.moduleId}`,
    `  来源版本：${restoredFrom}`,
    `  新版本：${response.versionId}`,
    `  成果修订：${response.artifactRevision}${response.duplicate ? '（该命令此前已执行，服务端返回同一结果）' : ''}`,
    '  说明：恢复生成了新版本，历史版本仍然保留；依赖该模块的成果可能被标记为过期。',
  ];
}

/* Re-exported for main's command registry. */
export const artifactCommands: CommandSpec[] = [artifactReviewCommand, artifactAcceptCommand, artifactRestoreCommand];
