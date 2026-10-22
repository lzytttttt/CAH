/** File/stdin/hash helpers for import, export, proposals and input payloads. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ConfigError, UsageError } from './exit';

export function resolvePath(cwd: string, target: string): string {
  return path.isAbsolute(target) ? path.normalize(target) : path.resolve(cwd, target);
}

export function readTextFile(cwd: string, target: string, label: string): string {
  const file = resolvePath(cwd, target);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new UsageError(`${label}不存在：${file}`);
    throw new ConfigError(`读取${label}失败：${file}（${(error as Error).message}）`);
  }
}

export function readBinaryFile(cwd: string, target: string, label: string, maxBytes: number): Buffer {
  const file = resolvePath(cwd, target);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new UsageError(`${label}不存在：${file}`);
    throw new ConfigError(`读取${label}失败：${file}（${(error as Error).message}）`);
  }
  if (!stat.isFile()) throw new UsageError(`${label}不是普通文件：${file}`);
  if (stat.size > maxBytes) {
    throw new UsageError(`${label}过大：${stat.size} 字节，上限 ${maxBytes} 字节`, `文件：${file}`);
  }
  const buffer = fs.readFileSync(file);
  if (buffer.byteLength > maxBytes) {
    throw new UsageError(`${label}读取后超过上限：${buffer.byteLength} 字节，上限 ${maxBytes} 字节`);
  }
  return buffer;
}

/**
 * Accept an inline JSON string (`{"a":1}`, `[...]`), `-` for stdin, or a file
 * path. Label is used in user-facing errors.
 */
export async function readJsonInput(cwd: string, value: string, label: string): Promise<unknown> {
  const trimmed = value.trim();
  if (trimmed === '-') {
    const text = await readAllStdin();
    return parseJsonText(text, label);
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parseJsonText(trimmed, label);
  }
  const text = readTextFile(cwd, value, label);
  return parseJsonText(text, label);
}

export function parseJsonText(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${label}不是合法 JSON：${(error as Error).message}`);
  }
}

export async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function base64Encode(buffer: Buffer | Uint8Array): string {
  return Buffer.from(buffer).toString('base64');
}

export function base64Decode(text: string, label: string): Buffer {
  try {
    return Buffer.from(text, 'base64');
  } catch (error) {
    throw new UsageError(`${label}不是合法的 base64 内容：${(error as Error).message}`);
  }
}

export function sha256Hex(buffer: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Atomic write: temp file in the same directory + rename (no half-written exports). */
export function writeFileAtomic(target: string, data: Buffer | string): void {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const temp = path.join(directory, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temp, data, { mode: 0o600 });
    fs.renameSync(temp, target);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // best effort cleanup
    }
    throw new ConfigError(`写入文件失败：${target}（${(error as Error).message}）`);
  }
}

export function fileExists(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}
