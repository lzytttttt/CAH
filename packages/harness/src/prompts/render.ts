/**
 * Minimal, deterministic prompt template rendering.
 *
 * Templates use `{{variable}}` placeholders. Rendering is a pure string
 * operation; hashes are SHA-256 of the template *source* so a template change
 * always changes the recorded hash (design section 7.4).
 */
import { sha256Hex } from '../hashing';

export function renderTemplate(template: string, variables: Readonly<Record<string, string | number | boolean | null | undefined>>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = variables[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

export function hashPromptTemplate(template: string): string {
  return sha256Hex(template);
}

/** Shared prohibitions pasted into every role prompt (never optional). */
export const PROMPT_GUARDRAILS = [
  '硬性规则（任何情况下不得违反）：',
  '1. 不得编造来源、引用、证据、数据、市场规模、客户采纳率、营收或访谈结论。',
  '2. 不得为了凑数量捏造风险；没有证据的担忧只能标为“明确未知（explicit_unknown）”。',
  '3. 不得输出隐藏思维链；只给结论、依据摘要与可核验的步骤。',
  '4. 不得在正文里伪造工具调用 JSON；工具请求只能通过原生 tool call 发起。',
  '5. 不得自行提高预算、扩大权限、读取未授权资料、执行任意代码或写入外部系统。',
  '6. 不得声称任何成果已通过校验或已提交；是否通过只由确定性校验器与用户决定。',
  '7. 所有事实性陈述必须引用真实来源片段，或明确标记为“待验证假设”。',
].join('\n');
