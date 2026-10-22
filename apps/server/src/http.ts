import { z } from 'zod';
import type { TaskId } from '@ca/contracts';
import type { StoragePort } from '@ca/storage';
import { fail, ApiFailure } from './errors';
import { z as zod } from 'zod';

export const zHelpers = zod;

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw fail.schemaInvalid('请求体校验失败', {
      issues: result.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return result.data;
}

export function parseQuery<T>(schema: z.ZodType<T>, query: unknown): T {
  const result = schema.safeParse(query ?? {});
  if (!result.success) {
    throw fail.schemaInvalid('查询参数校验失败', {
      issues: result.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return result.data;
}

export function requireParam(params: Record<string, string | undefined>, name: string): string {
  const value = params[name];
  if (!value || value.length === 0) throw fail.badRequest(`缺少路径参数 ${name}`);
  return value;
}

export function requireRevision(value: number | undefined, actual: number): void {
  if (typeof value === 'number' && Number.isFinite(value) && value !== actual) {
    throw fail.revisionConflict(value, actual);
  }
}

export function uuidOrFail(value: string | undefined, what: string): string {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw fail.badRequest(`${what} 不是合法 ID`);
  }
  return value;
}

/**
 * Command idempotency: repeated commandId returns the original response with
 * duplicate=true; concurrent duplicates share one in-flight execution.
 */
export class CommandRunner {
  private readonly getStorage: () => StoragePort;
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(getStorage: () => StoragePort) {
    this.getStorage = getStorage;
  }

  async run<T extends { commandId: string }>(
    commandId: string,
    commandType: string,
    taskId: TaskId | null,
    fn: () => Promise<T>,
  ): Promise<T & { duplicate: boolean }> {
    const storage = this.getStorage();
    const existing = await storage.getCommandResult(commandId as never);
    if (existing) {
      return { ...(existing as T), duplicate: true };
    }
    const inFlight = this.inflight.get(commandId);
    if (inFlight) {
      const shared = (await inFlight) as T;
      return { ...shared, duplicate: true };
    }
    const promise = (async () => {
      const result = await fn();
      await storage.saveCommandResult(
        commandId as never,
        commandType,
        taskId,
        result as unknown as Record<string, unknown>,
      );
      return result;
    })();
    this.inflight.set(commandId, promise as Promise<unknown>);
    try {
      const result = await promise;
      return { ...result, duplicate: false };
    } finally {
      this.inflight.delete(commandId);
    }
  }
}

export async function loadTask(storage: StoragePort, taskId: string) {
  const task = await storage.getTask(taskId as TaskId);
  if (!task) throw fail.notFound('任务');
  return task;
}

export async function loadRun(storage: StoragePort, runId: string) {
  const run = await storage.getRun(runId);
  if (!run) throw fail.notFound('运行');
  return run;
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function decodeBase64(value: string, maxBytes: number, label: string): Uint8Array {
  if (!/^[A-Za-z0-9+/=\s]*$/.test(value)) throw fail.schemaInvalid(`${label} 不是合法 base64`);
  const estimated = Math.floor((value.replace(/\s/g, '').length * 3) / 4);
  if (estimated > maxBytes + 1024) throw fail.payloadTooLarge(`${label} 超过 ${Math.round(maxBytes / 1024 / 1024)}MiB 限制`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxBytes) throw fail.payloadTooLarge(`${label} 超过 ${Math.round(maxBytes / 1024 / 1024)}MiB 限制`);
  return new Uint8Array(bytes);
}

export interface PageQuery {
  afterSeq: number;
  limit: number;
}

export const PageQuerySchema = z.object({
  afterSeq: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(500).default(200),
});

export function isApiFailure(error: unknown): error is ApiFailure {
  return error instanceof ApiFailure;
}
