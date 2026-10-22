/**
 * recipe-extractor.v1 — turns a successful bounded run into a reusable recipe
 * proposal. It never hard-codes historical answers as a general transform.
 */
import { hashPromptTemplate, renderTemplate, PROMPT_GUARDRAILS } from './render';

export const RECIPE_EXTRACTOR_V1_ID = 'recipe-extractor.v1';
export const RECIPE_EXTRACTOR_V1_VERSION = 'recipe-extractor.v1';

export const RECIPE_EXTRACTOR_V1_SYSTEM_TEMPLATE = `你是 Cognitive Atrium 的“配方提取”角色（recipe-extractor.v1）。
输入是一段成功支线的步骤、工具调用、校验器与输入输出 Schema。请输出可参数化的配方提案。

${PROMPT_GUARDRAILS}

配方硬性要求：
1. 只提取可重放的步骤：输入参数、步骤顺序、工具范围、验证器、适用范围必须明确。
2. 不得把历史答案硬编码成通用处理结果；不能参数化的内容只能作为适用范围说明。
3. 不得包含任意代码、shell、网络抓取、外部写入或提高权限的操作。
4. 配方必须带测试候选用例：原始输入、新有效输入、无效输入拒绝；没有验证器的配方必须明确原因。
5. 只输出一个 JSON 对象，不要代码围栏。

DSL 版本：1；可用步骤 kind：source.read、source.search、data.profile、data.transform、artifact.read、llm.step、validate、emit_artifact。`;

export const RECIPE_EXTRACTOR_V1_USER_TEMPLATE = `运行信息：
- 任务：{{taskTitle}}
- 目标模块类型：{{moduleKind}}
- 输入资料：{{sourceSummary}}
- 工具调用：{{toolSummary}}
- 校验器：{{validatorSummary}}
- 预算：{{budgetSummary}}

输出 JSON（RecipeProposalInput 结构）：
{
  "name": "string",
  "description": "string",
  "kind": "deterministic|llm_assisted|cached_snapshot",
  "inputParameters": [{"name": "param", "type": "string|number|boolean|source|object", "required": true, "description": "", "pattern": null, "enumValues": [], "acceptsMime": []}],
  "steps": [{"id": "s1", "kind": "data.transform", "...": "见 DSL"}],
  "testCases": [{"id": "t1", "label": "原始输入", "kind": "original", "inputs": {}, "expectation": "accept", "status": "untested", "detail": ""}],
  "applicability": "适用范围与前置条件"
}`;

export const RECIPE_EXTRACTOR_V1_HASH = hashPromptTemplate(RECIPE_EXTRACTOR_V1_SYSTEM_TEMPLATE);

export function renderRecipeExtractorPrompt(vars: {
  taskTitle: string;
  moduleKind: string;
  sourceSummary: string;
  toolSummary: string;
  validatorSummary: string;
  budgetSummary: string;
}): { system: string; user: string } {
  return {
    system: renderTemplate(RECIPE_EXTRACTOR_V1_SYSTEM_TEMPLATE, {}),
    user: renderTemplate(RECIPE_EXTRACTOR_V1_USER_TEMPLATE, vars),
  };
}
