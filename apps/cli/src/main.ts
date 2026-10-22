/**
 * CLI entry point.
 *
 * The CLI is one of the two product entries (design section 1.1): it talks to
 * the same command API / execution kernel as the spatial UI over HTTP, so both
 * entries produce identical business state. It has no DOM dependency.
 *
 * Output contract:
 *  - default: human-readable text on stdout (progress/warnings on stderr);
 *  - `--json`: exactly one JSON document on stdout, everything else on stderr;
 *  - exit codes: 0 success, 1 usage, 2 waiting_for_input, 3 configuration/
 *    connection/auth, 4 command/state error, 5 unexpected.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CLI_BIN, CLI_VERSION, DEFAULT_SERVER_URL, DEFAULT_TIMEOUT_MS, ParsedCommand, splitGlobals, type Globals } from './args';
import { createClient } from './client';
import { COMMAND_GROUPS, resolveCommand, groupFor } from './commands/index';
import type { CliOutcome, CommandContext, CommandSpec } from './commands/types';
import { EXIT, UsageError, toCliError, type CliError, type ErrorInfo } from './exit';
import { renderTable } from './format';

export interface CliContext {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdoutIsTTY?: boolean;
  fetchImpl?: typeof fetch;
  retryBaseDelayMs?: number;
}

export function defaultContext(): CliContext {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    cwd: process.cwd(),
    env: process.env,
    stdoutIsTTY: Boolean(process.stdout.isTTY),
  };
}

/** Run one CLI invocation and return its exit code. Never throws. */
export async function runCli(argv: readonly string[], overrides: Partial<CliContext> = {}): Promise<number> {
  const ctx: CliContext = { ...defaultContext(), ...overrides };
  let globals: Globals | null = null;
  let commandLabel = '';
  try {
    const split = splitGlobals(argv, { env: ctx.env, stdoutIsTTY: ctx.stdoutIsTTY });
    globals = split.globals;
    const tokens = split.rest;

    if (globals.version) {
      ctx.stdout(`${CLI_BIN} ${CLI_VERSION}\n`);
      return EXIT.OK;
    }
    if (tokens.length === 0) {
      ctx.stdout(generalHelp());
      return EXIT.OK;
    }
    const resolved = resolveCommand(tokens);
    if (resolved) {
      commandLabel = resolved.spec.path;
      if (globals.help) {
        ctx.stdout(commandHelp(resolved.spec));
        return EXIT.OK;
      }
      const parsed = ParsedCommand.parse(
        resolved.spec.path,
        tokens.slice(resolved.consumed),
        resolved.spec.flags,
        resolved.spec.positionals,
      );
      if (parsed.help) {
        ctx.stdout(commandHelp(resolved.spec));
        return EXIT.OK;
      }
      const client = createClient({
        globals,
        env: ctx.env,
        cwd: ctx.cwd,
        log: (line) => ctx.stderr(`${line}\n`),
        fetchImpl: ctx.fetchImpl,
        retryBaseDelayMs: ctx.retryBaseDelayMs,
      });
      const commandContext: CommandContext = {
        client,
        globals,
        cwd: ctx.cwd,
        env: ctx.env,
        stdout: ctx.stdout,
        stderr: ctx.stderr,
        log: (line) => ctx.stderr(`${line}\n`),
      };
      const outcome = await resolved.spec.execute(parsed, commandContext);
      emitOutcome(outcome, globals, ctx, client.baseUrl);
      return outcome.exitCode ?? EXIT.OK;
    }

    // Group help: `task --help`, `run --help`, or a bare group name.
    const group = groupFor(tokens[0] ?? '');
    if (group && (tokens.length === 1 || tokens[1] === '--help' || tokens[1] === '-h')) {
      ctx.stdout(groupHelp(group.name));
      return EXIT.OK;
    }
    throw new UsageError(
      `未知命令：${tokens.slice(0, 2).join(' ')}`,
      `运行 ${CLI_BIN} --help 查看全部命令；或 ${CLI_BIN} <group> --help 查看分组。`,
    );
  } catch (error) {
    const cliError = toCliError(error);
    emitError(cliError, globals, ctx, commandLabel);
    return cliError.exitCode;
  }
}

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

function emitOutcome(outcome: CliOutcome, globals: Globals, ctx: CliContext, serverUrl: string): void {
  const exitCode = outcome.exitCode ?? EXIT.OK;
  const status = outcome.status ?? (exitCode === 0 ? 'ok' : 'error');
  const ok = exitCode === EXIT.OK && status === 'ok';
  if (outcome.alreadyEmitted) return;
  if (globals.json) {
    if (outcome.alreadyEmitted) return;
    const document: Record<string, unknown> = {
      ok,
      status,
      command: outcome.command,
      exitCode,
      server: serverUrl,
    };
    if (outcome.waitingForInput) document.waitingForInput = outcome.waitingForInput;
    if (outcome.error) document.error = outcome.error;
    document.data = outcome.data;
    ctx.stdout(`${JSON.stringify(document, null, 2)}\n`);
    return;
  }
  if (outcome.human) {
    ctx.stdout(outcome.human.endsWith('\n') ? outcome.human : `${outcome.human}\n`);
  }
  if (exitCode !== EXIT.OK) {
    const lines = [`退出码 ${exitCode}：${statusDescription(status)}`];
    if (outcome.error) lines.push(`${outcome.error.code}：${outcome.error.message}`);
    ctx.stderr(`${lines.join('\n')}\n`);
  }
}

function emitError(error: CliError, globals: Globals | null, ctx: CliContext, commandLabel: string): void {
  const json = globals?.json ?? false;
  const server = globals?.serverUrl ?? ctx.env.CA_SERVER_URL ?? DEFAULT_SERVER_URL;
  if (json) {
    const document: Record<string, unknown> = {
      ok: false,
      status: 'error',
      command: commandLabel || null,
      exitCode: error.exitCode,
      server,
      error: error.info,
    };
    ctx.stdout(`${JSON.stringify(document, null, 2)}\n`);
    return;
  }
  const lines = [`错误（${error.info.code}）：${error.info.message}`];
  if (error.info.hint) lines.push(error.info.hint);
  for (const line of error.lines) lines.push(line);
  if (error.info.traceId) lines.push(`traceId：${error.info.traceId}`);
  if (error.info.retryable) lines.push('该错误被标记为可重试。');
  lines.push(`退出码 ${error.exitCode}：${statusDescription(statusForExitCode(error.exitCode))}`);
  ctx.stderr(`${lines.join('\n')}\n`);
}

function statusForExitCode(exitCode: number): string {
  switch (exitCode) {
    case EXIT.USAGE:
      return 'usage';
    case EXIT.WAITING_INPUT:
      return 'waiting_for_input';
    case EXIT.CONFIG:
      return 'config';
    case EXIT.STATE:
      return 'state';
    case EXIT.UNEXPECTED:
      return 'unexpected';
    default:
      return 'ok';
  }
}

function statusDescription(status: string): string {
  switch (status) {
    case 'waiting_for_input':
      return '等待人工输入（不是执行失败；按提示解决阻塞后可继续）';
    case 'failed':
      return '业务状态为失败（未产生新成果，正式版本未被修改）';
    case 'cancelled':
      return '运行已取消（草稿保留，正式版本未变）';
    case 'interrupted':
      return '运行已中断（需人工核对后恢复，未自动重放）';
    case 'incomplete':
      return '命令在当前边界停止（已输出真实状态）';
    case 'usage':
      return '用法或本地输入错误';
    case 'config':
      return '配置/连接/鉴权错误';
    case 'state':
      return '命令或状态错误';
    case 'unexpected':
      return '未预期错误';
    default:
      return '成功';
  }
}

/* ------------------------------------------------------------------ */
/* Help                                                                */
/* ------------------------------------------------------------------ */

export function generalHelp(): string {
  const lines: string[] = [
    `${CLI_BIN} ${CLI_VERSION} — Cognitive Atrium 命令行客户端（与 Web 工作台共用同一命令 API）`,
    '',
    '用法：',
    `  ${CLI_BIN} <group> <command> [options]`,
    `  ${CLI_BIN} <command> [options]`,
    '',
    '命令：',
  ];
  for (const group of COMMAND_GROUPS) {
    if (group.commands.length === 0) continue;
    lines.push(`  ${group.title}：`);
    for (const command of group.commands) {
      lines.push(`    ${command.path.padEnd(22)}${command.summary}`);
    }
  }
  lines.push(
    '',
    '全局选项：',
    `  --server <url>       服务地址（默认 ${DEFAULT_SERVER_URL}，或 $CA_SERVER_URL）`,
    '  --json               输出单个机器可读 JSON 文档到 stdout（日志/进度走 stderr）',
    '  --token-file <path>  本地会话令牌文件（默认 <CA_DATA_DIR 或 ./data>/session-token）',
    `  --timeout <时长>     请求超时：毫秒数或带单位，如 30000 / 30s / 2m（默认 ${DEFAULT_TIMEOUT_MS}ms）`,
    '  --help, -h           帮助（可放在任意命令之后）',
    '  --version, -v        版本',
    '',
    '退出码：',
    '  0  成功',
    '  1  用法/本地输入错误（参数、文件或必填字段不合法）',
    '  2  等待人工输入（输出包含 blockerId 与解决方式）',
    '  3  配置/连接/鉴权/模型凭据错误',
    '  4  命令或状态错误（冲突、非法状态、运行失败/取消）',
    '  5  未预期错误',
    '',
    '环境变量：',
    '  CA_SERVER_URL  CA_DATA_DIR  CA_TOKEN_FILE  CA_SESSION_TOKEN  CA_CLI_TIMEOUT_MS',
    '',
    '示例：',
    `  ${CLI_BIN} provider test --profile <profileId> --confirm-charges`,
    `  ${CLI_BIN} task create --title "整理客户反馈" --intent "汇总并分级" --template cognitive-atrium`,
    `  ${CLI_BIN} run start <taskId> --module <moduleId> --intent "补齐交付物" --wait`,
    `  ${CLI_BIN} run status <runId> --watch`,
    `  ${CLI_BIN} artifact review <patchId>`,
    `  ${CLI_BIN} events tail <taskId> --json --limit 20`,
    '',
  );
  return `${lines.join('\n')}\n`;
}

export function groupHelp(name: string): string {
  const group = COMMAND_GROUPS.find((item) => item.name === name);
  if (!group) return generalHelp();
  const lines = [`${CLI_BIN} ${group.name} — ${group.title}`, '', '命令：'];
  for (const command of group.commands) {
    lines.push(`  ${command.path.padEnd(22)}${command.summary}`);
  }
  lines.push('', `查看具体命令：${CLI_BIN} <command> --help`, '');
  return `${lines.join('\n')}\n`;
}

export function commandHelp(spec: CommandSpec): string {
  const positionalPart = spec.positionals.map((positional) => (positional.required ? `<${positional.name}>` : `[${positional.name}]`)).join(' ');
  const usage = `${CLI_BIN} ${spec.path}${positionalPart ? ` ${positionalPart}` : ''} [options]`;
  const lines = [`${CLI_BIN} ${spec.path} — ${spec.summary}`, '', '用法：', `  ${usage}`];
  if (spec.positionals.length > 0) {
    lines.push('', '参数：');
    for (const positional of spec.positionals) {
      lines.push(`  ${positional.required ? `<${positional.name}>` : `[${positional.name}]`}  ${positional.description}`);
    }
  }
  const entries = Object.entries(spec.flags);
  if (entries.length > 0) {
    lines.push('', '选项：');
    const rows = entries.map(([flag, flagSpec]) => {
      const value = flagSpec.type === 'boolean' ? '' : ` ${flagSpec.valueName ?? '<值>'}`;
      const choices = flagSpec.choices ? `（可选：${flagSpec.choices.join(' / ')}）` : '';
      return [`${flag}${value}`, `${flagSpec.description}${choices}`];
    });
    lines.push(renderTable(['选项', '说明'], rows).split('\n').map((line) => `  ${line}`).join('\n'));
  }
  if (spec.examples?.length) {
    lines.push('', '示例：');
    for (const example of spec.examples) lines.push(`  ${example}`);
  }
  if (spec.notes?.length) {
    lines.push('', '注意：');
    for (const note of spec.notes) lines.push(`  - ${note}`);
  }
  lines.push('', '全局选项：--server <url>  --json  --token-file <path>  --timeout <时长>  --help', '');
  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------ */
/* Process entry                                                       */
/* ------------------------------------------------------------------ */

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalized = entry.replace(/\\/g, '/');
  if (normalized.endsWith('/apps/cli/src/main.ts') || normalized.endsWith('/apps/cli/dist/cli.mjs')) return true;
  try {
    const entryReal = fs.realpathSync(entry);
    const moduleReal = fs.realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? entryReal.toLowerCase() === moduleReal.toLowerCase() : entryReal === moduleReal;
  } catch {
    return false;
  }
}

/** Entry used by tsx (`pnpm cli`) and the esbuild bundle. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const code = await runCli(argv);
  process.exitCode = code;
  return code;
}

if (isMainModule()) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`未预期错误：${message}\n`);
    process.exitCode = EXIT.UNEXPECTED;
  });
}

export type { ErrorInfo };
