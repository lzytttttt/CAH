import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { ServerConfig } from './config';

export interface ServerDeps {
  config: ServerConfig;
}

/**
 * Build the Fastify application. Kept separate from main.ts so integration
 * tests can build an instance without binding a public port.
 */
export async function createApp(deps: ServerDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 2 * 1024 * 1024,
  });

  app.addHook('onRequest', async (request) => {
    // Origin 校验（写命令与浏览器来源）在安全模块接入后扩展；健康检查不受限。
    if (request.url.startsWith('/api/') && request.method !== 'GET' && request.method !== 'HEAD') {
      const origin = request.headers.origin;
      if (origin && !config.allowedOrigins.includes(origin)) {
        throw Object.assign(new Error(`origin not allowed: ${origin}`), {
          statusCode: 403,
          code: 'origin_not_allowed',
        });
      }
    }
  });

  app.get('/api/health', async () => ({
    ok: true,
    service: 'cognitive-atrium',
    mode: 'server',
    time: new Date().toISOString(),
  }));

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = typeof (error as { statusCode?: number }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500;
    if (status >= 500) request.log.error(error);
    void reply.status(status).send({
      code: error.code ?? 'internal_error',
      message: status >= 500 ? 'internal server error' : error.message,
      retryable: false,
      traceId: request.id,
    });
  });

  return app;
}
