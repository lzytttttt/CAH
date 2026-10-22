/** Command registry (single source of truth for dispatch + help). */
import type { CommandSpec } from './types';
import { providerTestCommand } from './provider';
import { sessionCommand } from './session';
import { taskCreateCommand, taskExportCommand, taskListCommand, taskStatusCommand } from './task';
import { runCommands } from './run';
import { artifactCommands } from './artifact';
import { recipeCommands } from './recipe';
import { importCommands } from './import';
import { eventsTailCommand } from './events';

export const COMMANDS: readonly CommandSpec[] = [
  providerTestCommand,
  sessionCommand,
  taskCreateCommand,
  taskListCommand,
  taskStatusCommand,
  taskExportCommand,
  ...runCommands,
  ...artifactCommands,
  ...recipeCommands,
  ...importCommands,
  eventsTailCommand,
];

export interface CommandGroup {
  name: string;
  title: string;
  commands: readonly CommandSpec[];
}

export const COMMAND_GROUPS: readonly CommandGroup[] = [
  {
    name: 'provider',
    title: '模型连接',
    commands: COMMANDS.filter((command) => command.path.startsWith('provider ')),
  },
  {
    name: 'task',
    title: '任务与成果',
    commands: COMMANDS.filter((command) => command.path.startsWith('task ')),
  },
  {
    name: 'run',
    title: '运行控制',
    commands: COMMANDS.filter((command) => command.path.startsWith('run ')),
  },
  {
    name: 'artifact',
    title: '审阅与版本',
    commands: COMMANDS.filter((command) => command.path.startsWith('artifact ')),
  },
  {
    name: 'recipe',
    title: '配方',
    commands: COMMANDS.filter((command) => command.path.startsWith('recipe ')),
  },
  {
    name: 'source',
    title: '资料',
    commands: COMMANDS.filter((command) => command.path.startsWith('source ')),
  },
  {
    name: 'events',
    title: '事件与诊断',
    commands: COMMANDS.filter((command) => command.path.startsWith('events ') || command.path === 'import' || command.path === 'session'),
  },
];

export function findCommand(path: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.path === path);
}

export function groupFor(token: string): CommandGroup | undefined {
  return COMMAND_GROUPS.find((group) => group.name === token);
}

/** Longest-match command resolution (two tokens before one). */
export function resolveCommand(tokens: readonly string[]): { spec: CommandSpec; consumed: number } | null {
  const two = tokens.slice(0, 2).join(' ');
  const twoSpec = findCommand(two);
  if (twoSpec) return { spec: twoSpec, consumed: 2 };
  const oneSpec = tokens.length > 0 ? findCommand(tokens[0]!) : undefined;
  if (oneSpec) return { spec: oneSpec, consumed: 1 };
  return null;
}
