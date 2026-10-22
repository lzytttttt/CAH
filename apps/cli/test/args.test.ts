import { describe, expect, it } from 'vitest';
import { DEFAULT_SERVER_URL, ParsedCommand, parseDuration, splitGlobals, type CommandFlags, type PositionalSpec } from '../src/args';
import { UsageError } from '../src/exit';

const parse = (argv: readonly string[], flags: CommandFlags, positionals: readonly PositionalSpec[] = []): ParsedCommand =>
  ParsedCommand.parse('test command', argv, flags, positionals);

describe('parseDuration', () => {
  it('parses bare milliseconds and units', () => {
    expect(parseDuration('30000')).toBe(30_000);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('2m')).toBe(120_000);
    expect(parseDuration('1.5s')).toBe(1_500);
    expect(parseDuration('250ms')).toBe(250);
  });

  it('rejects invalid durations', () => {
    expect(() => parseDuration('abc')).toThrow(UsageError);
    expect(() => parseDuration('0')).toThrow(UsageError);
    expect(() => parseDuration('-5s')).toThrow(UsageError);
  });
});

describe('splitGlobals', () => {
  it('pulls global options from anywhere on the command line', () => {
    const { globals, rest } = splitGlobals(['run', 'status', '--json', '--server', 'http://127.0.0.1:9999'], {
      env: {},
      stdoutIsTTY: false,
    });
    expect(globals.json).toBe(true);
    expect(globals.serverUrl).toBe('http://127.0.0.1:9999');
    expect(rest).toEqual(['run', 'status']);
  });

  it('supports inline values, env defaults and duration units', () => {
    const { globals } = splitGlobals(['--server=http://localhost:4311', '--timeout=5s', 'task', 'list'], {
      env: { CA_SERVER_URL: 'http://ignored:1111' },
      stdoutIsTTY: false,
    });
    expect(globals.serverUrl).toBe('http://localhost:4311');
    expect(globals.timeoutMs).toBe(5_000);
  });

  it('falls back to the local default server and env timeout', () => {
    const { globals } = splitGlobals(['session'], { env: { CA_CLI_TIMEOUT_MS: '1234' }, stdoutIsTTY: false });
    expect(globals.serverUrl).toBe(DEFAULT_SERVER_URL);
    expect(globals.timeoutMs).toBe(1234);
    expect(globals.json).toBe(false);
  });

  it('detects version/help/color flags', () => {
    const { globals } = splitGlobals(['--version', '--no-color'], { env: {}, stdoutIsTTY: true });
    expect(globals.version).toBe(true);
    expect(globals.color).toBe(false);
    const help = splitGlobals(['task', 'create', '--help'], { env: {}, stdoutIsTTY: false }).globals;
    expect(help.help).toBe(true);
  });
});

describe('ParsedCommand.parse', () => {
  const flags: CommandFlags = {
    '--title': { type: 'string', valueName: '<标题>', description: '标题' },
    '--plan-first': { type: 'boolean', default: true, description: '先规划' },
    '--type': { type: 'list', valueName: '<type>', description: '类型' },
    '--mode': { type: 'string', valueName: '<mode>', choices: ['all', 'sections'], description: '模式' },
    '--limit': { type: 'number', valueName: '<n>', description: '数量' },
  };
  const positionals: PositionalSpec[] = [{ name: 'taskId', description: '任务', required: true }];

  it('parses flags, repeated lists, numbers and positionals', () => {
    const command = parse(
      ['task-1', '--title', '标题 A', '--type', 'a', '--type', 'b', '--limit', '3', '--mode=all'],
      flags,
      positionals,
    );
    expect(command.positionals).toEqual(['task-1']);
    expect(command.getString('--title')).toBe('标题 A');
    expect(command.getList('--type')).toEqual(['a', 'b']);
    expect(command.getNumber('--limit')).toBe(3);
    expect(command.getBool('--plan-first')).toBe(true);
  });

  it('supports boolean negation and explicit false', () => {
    expect(parse(['x', '--no-plan-first'], flags, positionals).getBool('--plan-first')).toBe(false);
    expect(parse(['x', '--plan-first'], flags, positionals).getBool('--plan-first')).toBe(true);
  });

  it('rejects unknown flags, bad enums, missing values and missing positionals', () => {
    expect(() => parse(['x', '--bogus'], flags, positionals)).toThrow(/不认识选项/);
    expect(() => parse(['x', '--mode', 'other'], flags, positionals)).toThrow(/必须是/);
    expect(() => parse(['x', '--title'], flags, positionals)).toThrow(/需要一个值/);
    expect(() => parse([], flags, positionals)).toThrow(/缺少参数/);
    expect(() => parse(['x', 'extra'], flags, positionals)).toThrow(/多余参数/);
    expect(() => parse(['x', '--limit', 'NaN'], flags, positionals)).toThrow(/需要数字/);
  });

  it('treats tokens after -- as positionals', () => {
    const command = parse(['x', '--', '--not-a-flag'], flags, positionals);
    expect(command.positionals).toEqual(['x', '--not-a-flag']);
  });
});
