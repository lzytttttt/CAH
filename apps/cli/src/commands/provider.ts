/** `provider test` — real capability probes; never infers compatibility from a 200. */
import {
  API_ROUTES,
  CAPABILITY_PROBES,
  TestProviderResponseSchema,
  type CapabilityProbeName,
} from '@ca/contracts';
import { ConfigError, EXIT, UsageError } from '../exit';
import { renderCapabilityReport } from '../format';
import type { CommandSpec } from './types';
import {
  businessOutcome,
  commandId,
  getWorkspace,
  okOutcome,
} from './shared';

const DEFAULT_PROBES: CapabilityProbeName[] = ['auth_and_text'];

export const providerTestCommand: CommandSpec = {
  path: 'provider test',
  summary: '对已保存的模型连接执行逐项能力测试（真实请求，可能计费）',
  flags: {
    '--profile': { type: 'string', valueName: '<profileId>', description: 'provider profile ID；省略时自动选择唯一的 profile' },
    '--probes': {
      type: 'list',
      valueName: '<name>',
      choices: CAPABILITY_PROBES,
      description: `探测项，可重复：${CAPABILITY_PROBES.join(' / ')}（默认 auth_and_text）`,
    },
    '--confirm-charges': { type: 'boolean', description: '确认本次探测会产生真实模型请求（可能产生费用）' },
  },
  positionals: [{ name: 'profileId', description: 'provider profile ID', required: false }],
  examples: [
    'cognitive-atrium provider test --profile <profileId>',
    'cognitive-atrium provider test <profileId> --probes auth_and_text --probes streaming --confirm-charges --json',
  ],
  notes: ['测试结论只代表本次实际服务与模型，不表示对其它服务的兼容性。'],
  execute: async (command, ctx) => {
    const profileId = await resolveProfileId(command.positional(0) ?? command.getString('--profile'), ctx);
    const probesArg = command.getList('--probes');
    const probes = (probesArg.length > 0 ? probesArg : DEFAULT_PROBES) as CapabilityProbeName[];
    const confirmCharges = command.getBool('--confirm-charges');
    if (!confirmCharges && probes.some((probe) => probe !== 'auth_and_text')) {
      throw new UsageError(
        '能力探测会发起真实模型请求（可能产生费用），请加 --confirm-charges 明确确认',
        '例如：--probes auth_and_text --probes streaming --confirm-charges',
      );
    }
    const response = await ctx.client.post(TestProviderResponseSchema, API_ROUTES.providerProfileTest(profileId), {
      commandId: commandId(ctx),
      probes,
      confirmCharges,
    });
    const human = renderCapabilityReport(response.report);
    human.push(`  结论：${response.report.probes.every((probe) => probe.status !== 'error') ? '所有探测项均返回结果' : '存在出错的探测项（见上）'}`);
    const errored = response.report.probes.filter((probe) => probe.status === 'error');
    if (errored.length > 0) {
      return businessOutcome('provider test', response, human, {
        exitCode: EXIT.STATE,
        status: 'failed',
        error: {
          kind: 'api',
          code: 'provider_probe_error',
          message: `${errored.length} 个能力探测项失败：${errored.map((probe) => `${probe.capability}=${probe.error?.code ?? 'error'}`).join(', ')}`,
          retryable: errored.some((probe) => probe.error?.retryable === true),
        },
      });
    }
    return okOutcome('provider test', response, human);
  },
};

async function resolveProfileId(explicit: string | undefined, ctx: Parameters<NonNullable<CommandSpec['execute']>>[1]): Promise<string> {
  if (explicit) return explicit;
  const workspace = await getWorkspace(ctx);
  const profiles = workspace.providerProfiles;
  if (profiles.length === 0) {
    throw new ConfigError(
      '尚未配置任何模型连接（provider profile）',
      '请先在 Web 工作台的连接设置中创建 provider profile（含 baseURL/model/credentialRef），保存后再执行 provider test。',
    );
  }
  if (profiles.length > 1) {
    throw new UsageError(
      `存在 ${profiles.length} 个模型连接，请用 --profile 指定其一`,
      `可选：${profiles.map((profile) => `${profile.id}（${profile.profileName}）`).join('、')}`,
    );
  }
  return profiles[0]!.id;
}
