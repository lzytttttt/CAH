/** Shared command-layer types (kept separate from the parser to avoid cycles). */
import type { Blocker, ResolutionOption } from '@ca/contracts';
import type { CommandFlags, Globals, ParsedCommand, PositionalSpec } from '../args';
import type { ApiClient } from '../client';
import type { ErrorInfo } from '../exit';

export interface CommandContext {
  client: ApiClient;
  globals: Globals;
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Progress/warnings always go to stderr so --json stdout stays parseable. */
  log: (line: string) => void;
}

export type OutcomeStatus = 'ok' | 'waiting_for_input' | 'failed' | 'cancelled' | 'interrupted' | 'incomplete';

export interface WaitingForInputInfo {
  taskId: string | null;
  runId: string | null;
  blockerId: string;
  blockers: Blocker[];
  resolutions: ResolutionOption[];
  nextCommands: string[];
}

export interface CliOutcome {
  /** Command path, e.g. `run status`. */
  command: string;
  /** Typed response data for `--json`. */
  data: unknown;
  /** Human-readable text for default output. */
  human: string;
  exitCode?: number;
  status?: OutcomeStatus;
  waitingForInput?: WaitingForInputInfo;
  /** Structured record for non-zero business states (failed/cancelled/...). */
  error?: ErrorInfo;
  /** True when the command already wrote its output (streaming commands). */
  alreadyEmitted?: boolean;
}

export interface CommandSpec {
  path: string;
  summary: string;
  flags: CommandFlags;
  positionals: PositionalSpec[];
  examples?: string[];
  notes?: string[];
  execute: (command: ParsedCommand, ctx: CommandContext) => Promise<CliOutcome>;
}
