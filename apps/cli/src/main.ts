/**
 * CLI entry point.
 *
 * The CLI talks to the same command API / execution kernel as the spatial UI
 * (HTTP client), so both entries produce identical business state. It never
 * depends on a browser or DOM. Human-input states are returned as structured
 * JSON with exit code 2 instead of being reported as failures.
 */
const VERSION = '0.1.0';

function usage(): string {
  return [
    `cognitive-atrium CLI v${VERSION}`,
    '',
    'Usage: cognitive-atrium <group> <command> [options]',
    '',
    'Commands (implemented in later phases):',
    '  provider test        Test provider credentials and capabilities',
    '  task create          Create a task with an artifact skeleton',
    '  task status          Show task projection',
    '  task export          Export artifact or task package',
    '  run start            Create a run and request a plan',
    '  run commit           Commit a reviewed plan',
    '  run status           Show run state',
    '  run resolve          Resolve a pending blocker',
    '  run pause|resume|cancel',
    '  artifact review      Show patch + validation report',
    '  artifact accept      Accept a patch proposal',
    '  recipe save|validate|run',
    '',
    'Options:',
    '  --server <url>       Server base URL (default http://127.0.0.1:4310)',
    '  --json               Machine readable output',
    '  --help               Show help',
  ].join('\n');
}

function main(argv: string[]): number {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    return 0;
  }
  const command = argv.filter((a) => !a.startsWith('-')).slice(0, 2).join(' ');
  console.error(`command not implemented yet: ${command}`);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
