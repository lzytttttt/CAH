/** `session` — connection/auth diagnostics without touching business state. */
import { renderTable } from '../format';
import type { CommandSpec } from './types';
import { getSession, okOutcome } from './shared';

export const sessionCommand: CommandSpec = {
  path: 'session',
  summary: '检查服务连接、会话鉴权、运行模式与可用能力（只读）',
  flags: {},
  positionals: [],
  examples: ['cognitive-atrium session --json', 'cognitive-atrium --server http://127.0.0.1:4310 session'],
  execute: async (_command, ctx) => {
    const session = await getSession(ctx);
    const table = renderTable(
      ['项目', '值'],
      [
        ['服务地址', ctx.client.baseUrl],
        ['服务版本', session.serverVersion],
        ['运行模式', session.mode],
        ['可用模式', session.availableModes.join(', ')],
        ['CLI 鉴权', ctx.client.describeAuth()],
        ['会话已鉴权', session.authenticated ? '是' : '否（业务命令会返回 401）'],
        ['策略版本', session.policyVersion],
        ['Live 模型连接', session.liveProviderConfigured ? '已配置' : '未配置'],
        ['Demo 可用', session.demoAvailable ? '是' : '否'],
        ['服务时间', session.serverTime],
        ['运行时长', `${session.uptimeSeconds}s`],
      ],
    );
    const human = ['== 会话信息 ==', ...table.split('\n').map((line) => `  ${line}`)];
    return okOutcome('session', session, human);
  },
};
