/**
 * Production bundling for the server and CLI using esbuild.
 *
 * Workspace packages are TypeScript sources referenced via tsconfig paths,
 * so we resolve them explicitly and bundle them, while all third-party
 * packages stay external (they are installed via pnpm in production too).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspacePackages = ['contracts', 'harness', 'providers', 'tools', 'recipes', 'storage'];

const workspaceAlias: Plugin = {
  name: 'ca-workspace-alias',
  setup(b) {
    b.onResolve({ filter: /^@ca\// }, (args) => {
      const name = args.path.slice('@ca/'.length);
      if (!workspacePackages.includes(name)) return null;
      const pkgDir = name === 'server' || name === 'cli' ? path.join(root, 'apps', name) : path.join(root, 'packages', name);
      return { path: path.join(pkgDir, 'src', 'index.ts') };
    });
  },
};

interface Target {
  entry: string;
  outfile: string;
  banner?: { js: string };
}

const targets: Record<string, Target> = {
  server: {
    entry: path.join(root, 'apps/server/src/main.ts'),
    outfile: path.join(root, 'apps/server/dist/server.mjs'),
  },
  cli: {
    entry: path.join(root, 'apps/cli/src/main.ts'),
    outfile: path.join(root, 'apps/cli/dist/cli.mjs'),
    banner: { js: '#!/usr/bin/env node' },
  },
};

const which = process.argv[2];
const target = which ? targets[which] : undefined;
if (!target) {
  console.error(`usage: tsx scripts/build.ts <${Object.keys(targets).join('|')}>`);
  process.exit(1);
}

await build({
  entryPoints: [target.entry],
  outfile: target.outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  plugins: [workspaceAlias],
  sourcemap: true,
  banner: target.banner,
  logLevel: 'info',
  metafile: false,
});

console.log(`built ${path.relative(root, target.outfile)}`);
