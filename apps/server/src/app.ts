import fs from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ServerConfig } from './config';
import type { SessionManager } from './session';
import type { RuntimeManager } from './runtime-manager';
import type { TemplateCatalog } from './templates';
import { registerCoreRoutes } from './routes-core';
import { registerWorkRoutes } from './routes-work';
import { CommandRunner } from './http';
import { mapError } from './errors';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export interface AppDeps {
  config: ServerConfig;
  manager: RuntimeManager;
  session: SessionManager;
  catalog: TemplateCatalog;
}

export async function createApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, manager, session } = deps;
  const startedAt = Date.now();
  const commands = new CommandRunner(() => manager.runtime().storage);

  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: false,
  });
  const log = (message: string, details?: Record<string, unknown>) => {
    app.log.info({ ...details, message }, 'server');
  };
  void commands;

  app.addHook('onRequest', async (request) => {
    const url = request.url.split('?')[0] ?? request.url;
    if (!url.startsWith('/api/')) return;
    if (url === '/api/health' || url === '/api/session') return;
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    session.requireAuthorized(request, { write });
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    const mapped = mapError(error, request.id);
    if (mapped.status >= 500) request.log.error(error);
    void reply.status(mapped.status).send(mapped.body);
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      void reply.status(404).send({ code: 'not_found', message: '接口不存在', retryable: false, traceId: request.id });
      return;
    }
    // SPA fallback for client-side routes.
    return serveStatic(deps.config, request.url, reply);
  });

  // Core routes resolve the active mode runtime per request, so a mode switch is
  // visible immediately and command results are stored in that mode's database.
  await registerCoreRoutes(app, {
    config,
    session,
    manager,
    commands,
    catalog: deps.catalog,
    startedAt,
    log,
  });
  await registerWorkRoutes(app, { manager, commands, log });

  // Static hosting of the built web app (production mode serves backend + frontend).
  app.get('/assets/*', async (request, reply) => {
    const url = (request.params as { '*': string })['*'];
    return serveStaticFile(deps.config, path.join('assets', url), reply, request.id);
  });
  app.get('/', async (request, reply) => serveStatic(deps.config, '/index.html', reply));
  app.get('/favicon.ico', async (_request, reply) => reply.status(204).send());

  return app;
}

async function serveStatic(config: ServerConfig, urlPath: string, reply: import('fastify').FastifyReply): Promise<void> {
  const dist = config.webDistDir;
  const exists = await fs
    .stat(path.join(dist, 'index.html'))
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    reply
      .header('content-type', 'text/html; charset=utf-8')
      .status(503)
      .send(
        '<!doctype html><html><body style="font-family:system-ui;background:#090A0F;color:#E5E7EB;padding:40px">' +
          '<h1>Cognitive Atrium</h1><p>前端构建产物不存在。开发模式请访问 <code>http://127.0.0.1:5173</code>（Vite），' +
          '生产模式请先运行 <code>pnpm build</code>。</p></body></html>',
      );
    return;
  }
  if (urlPath === '/' || urlPath === '/index.html') {
    await serveStaticFile(config, 'index.html', reply, 'static');
    return;
  }
  const safe = urlPath.replace(/^\/+/, '');
  const direct = await fs
    .stat(path.join(dist, safe))
    .then((stat) => stat.isFile())
    .catch(() => false);
  await serveStaticFile(config, direct ? safe : 'index.html', reply, 'static');
}

async function serveStaticFile(
  config: ServerConfig,
  relative: string,
  reply: import('fastify').FastifyReply,
  traceId: string,
): Promise<void> {
  const dist = path.resolve(config.webDistDir);
  const resolved = path.resolve(dist, relative);
  if (!resolved.startsWith(dist + path.sep) && resolved !== dist) {
    void reply.status(400).send({ code: 'bad_request', message: '非法静态路径', retryable: false, traceId });
    return;
  }
  try {
    const bytes = await fs.readFile(resolved);
    const mime = MIME_TYPES[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream';
    const immutable = relative.startsWith('assets/');
    reply.header('content-type', mime);
    reply.header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    reply.send(bytes);
  } catch {
    void reply.status(404).send({ code: 'not_found', message: '静态资源不存在', retryable: false, traceId });
  }
}
