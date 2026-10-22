/**
 * Hand-rolled argument parser (no third-party dependency).
 *
 * Two layers:
 *  - `splitGlobals` pulls the global options (which may appear anywhere on the
 *    command line) and returns the remaining tokens;
 *  - `parseCommandArgs` validates the command-specific flags/positionals from a
 *    declarative spec, so usage errors and help text stay in sync.
 *
 * The parser intentionally rejects unknown flags instead of silently ignoring
 * them: an ignored flag would make a scripted command report the wrong intent.
 */
import { UsageError } from './exit';

export const CLI_VERSION = '0.1.0';
export const CLI_BIN = 'cognitive-atrium';
export const DEFAULT_SERVER_URL = 'http://127.0.0.1:4310';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_TOKEN_FILE_NAME = 'session-token';

export interface Globals {
  serverUrl: string;
  json: boolean;
  timeoutMs: number;
  tokenFile: string | null;
  color: boolean;
  help: boolean;
  version: boolean;
}

export interface GlobalParseOptions {
  env?: NodeJS.ProcessEnv;
  stdoutIsTTY?: boolean;
}

export interface GlobalParseResult {
  globals: Globals;
  rest: string[];
}

/** Parse `<n>`, `<n>ms`, `<n>s`, `<n>m` into milliseconds. Bare numbers are ms. */
export function parseDuration(raw: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/i.exec(raw.trim());
  if (!match) throw new UsageError(`无法解析时间长度：${raw}`, '示例：--timeout 30000 / --timeout 30s / --timeout 2m');
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) throw new UsageError(`时间长度必须为正数：${raw}`);
  const unit = (match[2] ?? 'ms').toLowerCase();
  const factor = unit === 'm' ? 60_000 : unit === 's' ? 1_000 : 1;
  return Math.max(1, Math.round(value * factor));
}

export function envTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.CA_CLI_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  try {
    return parseDuration(raw);
  } catch {
    return DEFAULT_TIMEOUT_MS;
  }
}

/** Default token file: `<CA_DATA_DIR or ./data>/session-token` (repo-root convention). */
export function defaultTokenFile(env: NodeJS.ProcessEnv): string | null {
  const dataDir = env.CA_DATA_DIR && env.CA_DATA_DIR.trim() !== '' ? env.CA_DATA_DIR : null;
  if (!dataDir) return null;
  return dataDir.replace(/[\\/]+$/, '') + '/session-token';
}

export function splitGlobals(argv: readonly string[], options: GlobalParseOptions = {}): GlobalParseResult {
  const env = options.env ?? process.env;
  const stdoutIsTTY = options.stdoutIsTTY ?? Boolean(process.stdout.isTTY);
  const globals: Globals = {
    serverUrl: env.CA_SERVER_URL && env.CA_SERVER_URL.trim() !== '' ? env.CA_SERVER_URL.trim() : DEFAULT_SERVER_URL,
    json: false,
    timeoutMs: envTimeoutMs(env),
    tokenFile: null,
    color: stdoutIsTTY && !env.NO_COLOR && env.FORCE_COLOR !== '0',
    help: false,
    version: false,
  };
  const rest: string[] = [];
  const takeValue = (index: number, token: string): string => {
    const inline = splitInlineValue(token);
    if (inline !== null) return inline;
    const value = argv[index + 1];
    if (value === undefined) throw new UsageError(`选项 ${token} 需要一个值`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    switch (token.split('=')[0]) {
      case '--json':
        requireNoInline(token);
        globals.json = true;
        continue;
      case '--help':
      case '-h':
        globals.help = true;
        continue;
      case '--version':
      case '-v':
        globals.version = true;
        continue;
      case '--no-color':
        globals.color = false;
        continue;
      case '--color':
        globals.color = true;
        continue;
      case '--server':
        globals.serverUrl = takeValue(i, token);
        if (splitInlineValue(token) === null) i += 1;
        continue;
      case '--token-file':
        globals.tokenFile = takeValue(i, token);
        if (splitInlineValue(token) === null) i += 1;
        continue;
      case '--timeout':
        globals.timeoutMs = parseDuration(takeValue(i, token));
        if (splitInlineValue(token) === null) i += 1;
        continue;
      default:
        rest.push(token);
    }
  }
  return { globals, rest };
}

function splitInlineValue(token: string): string | null {
  const eq = token.indexOf('=');
  if (eq < 0) return null;
  return token.slice(eq + 1);
}

function requireNoInline(token: string): void {
  if (splitInlineValue(token) !== null) throw new UsageError(`选项 ${token.split('=')[0]} 不接受值`);
}

/* ------------------------------------------------------------------ */
/* Command flag specs                                                  */
/* ------------------------------------------------------------------ */

export type FlagType = 'boolean' | 'string' | 'number' | 'list';

export interface FlagSpec {
  type: FlagType;
  description: string;
  /** Placeholder shown in help, e.g. `<taskId>`. */
  valueName?: string;
  /** Allowed values for enums; validated before the command runs. */
  choices?: readonly string[];
  /** Default for boolean flags (otherwise false). */
  default?: boolean;
}

export interface PositionalSpec {
  name: string;
  description: string;
  required?: boolean;
  variadic?: boolean;
}

export type CommandFlags = Record<string, FlagSpec>;

/** `--flag` / `--flag value` / `--flag=value` / repeated list flags / boolean `--no-x`. */
export class ParsedCommand {
  readonly help: boolean;
  private readonly stringValues = new Map<string, string>();
  private readonly listValues = new Map<string, string[]>();
  private readonly booleanValues = new Map<string, boolean>();

  constructor(
    readonly path: string,
    readonly positionals: string[],
    private readonly flagSpecs: CommandFlags,
  ) {
    this.help = false;
  }

  static parse(path: string, argv: readonly string[], flagSpecs: CommandFlags, positionals: readonly PositionalSpec[]): ParsedCommand {
    const command = new ParsedCommand(path, [], flagSpecs);
    const positionalBuffer: string[] = [];
    let positionalMode = false;

    for (let i = 0; i < argv.length; i += 1) {
      const token = argv[i]!;
      if (positionalMode) {
        positionalBuffer.push(token);
        continue;
      }
      if (token === '--') {
        positionalMode = true;
        continue;
      }
      if (token === '-h' || token === '--help') {
        (command as Mutable<ParsedCommand>).help = true;
        continue;
      }
      if (token.startsWith('--')) {
        const eq = token.indexOf('=');
        const rawName = eq >= 0 ? token.slice(0, eq) : token;
        let name = rawName;
        let negated = false;
        if (!(name in flagSpecs) && name.startsWith('--no-')) {
          const positive = `--${name.slice('--no-'.length)}`;
          if (flagSpecs[positive]?.type === 'boolean') {
            name = positive;
            negated = true;
          }
        }
        const spec = flagSpecs[name];
        if (!spec) throw new UsageError(`命令 ${path} 不认识选项 ${rawName}`, `可用选项见：${CLI_BIN} ${path} --help`);
        if (spec.type === 'boolean') {
          if (eq >= 0) throw new UsageError(`选项 ${name} 是布尔开关，不接受值`);
          command.booleanValues.set(name, !negated);
          continue;
        }
        if (negated) throw new UsageError(`选项 ${name} 不是布尔开关，不能使用 --no- 形式`);
        let value: string;
        if (eq >= 0) {
          value = token.slice(eq + 1);
        } else {
          const next = argv[i + 1];
          if (next === undefined) throw new UsageError(`选项 ${name} 需要一个值`);
          value = next;
          i += 1;
        }
        if (value === '') throw new UsageError(`选项 ${name} 的值不能为空`);
        if (spec.choices && !spec.choices.includes(value)) {
          throw new UsageError(`选项 ${name} 的值必须是：${spec.choices.join(' / ')}（收到 ${value}）`);
        }
        switch (spec.type) {
          case 'number': {
            const parsed = Number(value);
            if (!Number.isFinite(parsed)) throw new UsageError(`选项 ${name} 需要数字（收到 ${value}）`);
            command.stringValues.set(name, String(parsed));
            break;
          }
          case 'list': {
            const list = command.listValues.get(name) ?? [];
            list.push(value);
            command.listValues.set(name, list);
            break;
          }
          case 'string':
            command.stringValues.set(name, value);
            break;
        }
        continue;
      }
      if (token.startsWith('-') && token !== '-') {
        throw new UsageError(`命令 ${path} 不认识选项 ${token}`, '短选项仅支持 -h/--help。');
      }
      positionalBuffer.push(token);
    }

    // Positional arity/overload validation.
    const requiredCount = positionals.filter((p) => p.required).length;
    if (positionalBuffer.length < requiredCount) {
      const missing = positionals.filter((p) => p.required).slice(positionalBuffer.length);
      throw new UsageError(`命令 ${path} 缺少参数：${missing.map((p) => p.name).join(', ')}`, `用法见：${CLI_BIN} ${path} --help`);
    }
    const variadic = positionals.some((p) => p.variadic);
    if (!variadic && positionalBuffer.length > positionals.length) {
      throw new UsageError(`命令 ${path} 收到多余参数：${positionalBuffer.slice(positionals.length).join(' ')}`);
    }
    command.positionals.push(...positionalBuffer);
    return command;
  }

  has(name: string): boolean {
    return this.stringValues.has(name) || this.listValues.has(name) || this.booleanValues.has(name);
  }

  getString(name: string): string | undefined {
    return this.stringValues.get(name);
  }

  requireString(name: string, description?: string): string {
    const value = this.stringValues.get(name);
    if (value === undefined || value === '') {
      throw new UsageError(`命令 ${this.path} 缺少必填选项 --${name}${description ? `（${description}）` : ''}`, `用法见：${CLI_BIN} ${this.path} --help`);
    }
    return value;
  }

  getBool(name: string, fallback = false): boolean {
    const explicit = this.booleanValues.get(name);
    if (explicit !== undefined) return explicit;
    const spec = this.flagSpecs[name];
    if (spec && spec.type === 'boolean' && spec.default !== undefined) return spec.default;
    return fallback;
  }

  getNumber(name: string): number | undefined {
    const raw = this.stringValues.get(name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  }

  requireNumber(name: string, description?: string): number {
    const value = this.getNumber(name);
    if (value === undefined) {
      throw new UsageError(`命令 ${this.path} 缺少必填数字选项 --${name}${description ? `（${description}）` : ''}`);
    }
    return value;
  }

  getList(name: string): string[] {
    return [...(this.listValues.get(name) ?? [])];
  }

  positional(index: number): string | undefined {
    return this.positionals[index];
  }

  requirePositional(index: number, description?: string): string {
    const value = this.positionals[index];
    if (value === undefined || value === '') {
      throw new UsageError(`命令 ${this.path} 缺少参数 ${description ?? `#${index + 1}`}`, `用法见：${CLI_BIN} ${this.path} --help`);
    }
    return value;
  }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
