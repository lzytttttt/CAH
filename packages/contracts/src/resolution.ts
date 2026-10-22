/**
 * Blocker resolution value shapes (mechanism B).
 *
 * The server and kernel validate every user answer against the declared
 * ResolutionOption kind before accepting it. Unknown shapes are rejected so a
 * repair card can never "succeed" without a real decision.
 */
import type { ResolutionOption } from './entities';

export interface ResolutionValidation {
  ok: boolean;
  error: string | null;
  normalized: unknown;
}

function fail(message: string): ResolutionValidation {
  return { ok: false, error: message, normalized: null };
}

function ok(normalized: unknown): ResolutionValidation {
  return { ok: true, error: null, normalized };
}

export function validateBlockResolution(option: ResolutionOption, value: unknown): ResolutionValidation {
  switch (option.kind) {
    case 'choose': {
      if (typeof value === 'string' && option.options.some((o) => o.value === value)) {
        return ok(value);
      }
      if (value && typeof value === 'object' && 'value' in value) {
        const inner = (value as { value: unknown }).value;
        if (typeof inner === 'string' && option.options.some((o) => o.value === inner)) {
          return ok(inner);
        }
      }
      return fail('请选择一个有效选项');
    }
    case 'text': {
      const text = typeof value === 'string' ? value : null;
      if (text === null) return fail('请输入文本内容');
      const trimmed = text.trim();
      if (option.required && trimmed.length === 0) return fail('该输入不能为空');
      if (trimmed.length > option.maxChars) return fail(`文本长度不能超过 ${option.maxChars}`);
      return ok(trimmed);
    }
    case 'bind_source': {
      if (!value || typeof value !== 'object') return fail('请绑定一个资料版本');
      const record = value as Record<string, unknown>;
      const sourceId = record.sourceId;
      const version = record.version;
      if (typeof sourceId !== 'string' || sourceId.length === 0) return fail('缺少 sourceId');
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return fail('缺少有效的资料版本号');
      return ok({ sourceId, version });
    }
    case 'confirm_mapping': {
      const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
      if (record.confirmed === true) return ok({ confirmed: true });
      return fail('需要明确确认字段映射');
    }
    case 'exclude': {
      const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
      const itemRef = typeof record.itemRef === 'string' && record.itemRef.length > 0 ? record.itemRef : option.itemRef;
      if (!itemRef) return fail('缺少要排除的条目引用');
      return ok({ itemRef });
    }
  }
}
