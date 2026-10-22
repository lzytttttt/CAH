/**
 * End-to-end acceptance for the deterministic cleaning recipe on the REAL
 * scenario fixtures (read-only). Nothing about row counts is hard-coded in the
 * runtime: these expectations are derived from the synthetic source data itself.
 */
import { describe, expect, it } from 'vitest';
import { ModuleContentSchema, TaskIdSchema } from '@ca/contracts';
import { contentHash } from '@ca/tools';
import {
  FakeRecipeCache,
  LEGACY_SOURCE_ID,
  NEW_SOURCE_ID,
  INVALID_SOURCE_ID,
  PDF_SOURCE_ID,
  TASK_ID,
  makeCleaningRecipe,
  makeHarness,
  makeObserver,
  makeRunContext,
  sourceInputs,
  uuidFromSeed,
} from './helpers';

function decodeCsvContent(stored: Uint8Array): Extract<ReturnType<typeof ModuleContentSchema.parse>, { kind: 'csv' }> {
  const parsed = ModuleContentSchema.parse(JSON.parse(new TextDecoder().decode(stored)));
  if (parsed.kind !== 'csv') throw new Error(`expected csv content, got ${parsed.kind}`);
  return parsed;
}

describe('deterministic cleaning recipe on real fixtures', () => {
  it('folds legacy-systems.csv 24 -> 22 rows with keep=last dedupe and zero model calls', async () => {
    const harness = makeHarness();
    const recipe = makeCleaningRecipe();
    const { steps, observer } = makeObserver();

    const result = await harness.runtime.run(recipe, { ...makeRunContext(sourceInputs(LEGACY_SOURCE_ID)), observer });

    expect(result.cacheState).toBe('executed');
    expect(result.llmCalls).toBe(0);
    expect(harness.modelCalls).toHaveLength(0);
    expect(result.toolCalls).toBe(3); // source.read + data.profile + data.transform
    expect(result.outputs).toHaveLength(1);

    const output = result.outputs[0]!;
    expect(output.moduleKind).toBe('csv');
    expect(output.name).toBe('cleaned.csv');
    expect(output.rowCount).toBe(22);
    expect(output.objectHash).toBe(contentHash(JSON.parse(new TextDecoder().decode(harness.objects.objects.get(output.objectHash)!.bytes))));
    expect(result.normalizedOutputHash).toMatch(/^[0-9a-f]{64}$/);

    // The emitted object is the canonical ModuleContent JSON: object hash === contentHash.
    const stored = harness.objects.objects.get(output.objectHash);
    expect(stored).toBeDefined();
    const content = decodeCsvContent(stored!.bytes);
    expect(content.rows).toHaveLength(22);
    expect(stored!.mime).toBe('application/json');

    const ids = content.rows.map((row) => String(row.system_id));
    expect(ids).toHaveLength(22);
    expect(new Set(ids).size).toBe(22);
    // 2 duplicate primary-key groups were collapsed, keep=last semantics:
    expect(ids).toContain('S-1001');
    expect(ids).toContain('S-1007');
    expect(ids.filter((id) => id === 'S-1001')).toHaveLength(1);
    expect(ids.filter((id) => id === 'S-1007')).toHaveLength(1);

    const keptOldInstance = content.rows.find((row) => row.system_id === 'S-1001')!;
    expect(keptOldInstance.notes).toBe('重复主键的旧实例');
    expect(keptOldInstance.status).toBe('retired');
    const keptQualityRow = content.rows.find((row) => row.system_id === 'S-1007')!;
    expect(keptQualityRow.notes).toBe('重复登记');

    // Whitespace/case normalization actually ran on the new data path too.
    const spaced = content.rows.find((row) => row.system_id === 'S-1016')!;
    expect(spaced.status).toBe('active');

    // The missing-name row is retained in the output table and recorded as an issue.
    const missingName = content.rows.find((row) => row.system_id === 'S-1021');
    expect(missingName).toBeDefined();
    expect(String(missingName!.name ?? '').trim()).toBe('');

    const transformObservation = steps.find((step) => step.kind === 'data.transform');
    expect(transformObservation).toBeDefined();
    expect(transformObservation!.status).toBe('executed');
    expect(transformObservation!.issues.some((issue) => /require: column "name"/.test(issue))).toBe(true);
    expect(transformObservation!.issues.some((issue) => /require: column "system_id"/.test(issue))).toBe(false);
    expect(transformObservation!.rowCount).toBe(22);

    // All steps executed, none skipped, no model step exists.
    expect(steps.map((step) => step.status)).toEqual(['executed', 'executed', 'executed', 'executed', 'executed']);

    // Deterministic: the same input produces exactly the same normalized hash.
    const repeated = await harness.runtime.run(recipe, makeRunContext(sourceInputs(LEGACY_SOURCE_ID)));
    expect(repeated.normalizedOutputHash).toBe(result.normalizedOutputHash);
    expect(repeated.outputs[0]!.objectHash).toBe(output.objectHash);
  });

  it('reuses the same recipe on legacy-systems-new.csv: 8 -> 7 rows with no model calls', async () => {
    const harness = makeHarness();
    const recipe = makeCleaningRecipe();
    const { steps, observer } = makeObserver();

    const result = await harness.runtime.run(recipe, { ...makeRunContext(sourceInputs(NEW_SOURCE_ID)), observer });

    expect(result.llmCalls).toBe(0);
    expect(harness.modelCalls).toHaveLength(0);
    expect(result.outputs[0]!.rowCount).toBe(7);
    const content = decodeCsvContent(harness.objects.objects.get(result.outputs[0]!.objectHash)!.bytes);
    expect(content.rows).toHaveLength(7);
    const duplicateGroup = content.rows.find((row) => row.system_id === 'N-2003')!;
    // keep=last: the later recorded row wins.
    expect(duplicateGroup.name).toBe('费控管理系统（新）');
    expect(content.rows.filter((row) => row.system_id === 'N-2003')).toHaveLength(1);
    const active = content.rows.find((row) => row.system_id === 'N-2001')!;
    expect(active.status).toBe('active');

    const transformObservation = steps.find((step) => step.kind === 'data.transform')!;
    expect(transformObservation.issues.some((issue) => /require: column "name"/.test(issue))).toBe(false);
  });

  it('rejects legacy-systems-invalid.csv as an input error (missing system_id mapping) before writing anything', async () => {
    const harness = makeHarness();
    const recipe = makeCleaningRecipe();

    const preflight = await harness.runtime.preflightInputs(recipe, sourceInputs(INVALID_SOURCE_ID), { taskId: TASK_ID });
    expect(preflight.ok).toBe(false);
    const preflightText = preflight.errors.join(' | ');
    expect(preflightText).toMatch(/system_id/);
    expect(preflightText).toMatch(/unknown column|column/i);
    expect(harness.objects.puts).toHaveLength(0);

    const before = harness.objects.puts.length;
    await expect(harness.runtime.run(recipe, makeRunContext(sourceInputs(INVALID_SOURCE_ID)))).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringMatching(/system_id/),
    });
    expect(harness.objects.puts.length).toBe(before);
    expect(harness.modelCalls).toHaveLength(0);
  });

  it('resolves source bindings, MIME and task ownership at preflight', async () => {
    const harness = makeHarness();
    const recipe = makeCleaningRecipe();

    const resolved = await harness.runtime.preflightInputs(recipe, sourceInputs(LEGACY_SOURCE_ID), { taskId: TASK_ID });
    expect(resolved.ok).toBe(true);
    expect(resolved.sourceBindings.source).toEqual({ sourceId: LEGACY_SOURCE_ID, version: 1 });
    expect(resolved.sourceMeta.source.mime).toBe('text/csv');
    expect(resolved.sourceMeta.source.name).toBe('legacy-systems.csv');

    // MIME mismatch: the parameter only accepts text/csv.
    const pdf = await harness.runtime.preflightInputs(recipe, sourceInputs(PDF_SOURCE_ID), { taskId: TASK_ID });
    expect(pdf.ok).toBe(false);
    expect(pdf.errors.join(' ')).toMatch(/mime "application\/pdf"/);

    // A task without the source cannot resolve it (task-scoped ownership check).
    const emptyTask = TaskIdSchema.parse(uuidFromSeed('task:empty'));
    const foreign = await harness.runtime.preflightInputs(recipe, sourceInputs(LEGACY_SOURCE_ID), { taskId: emptyTask });
    expect(foreign.ok).toBe(false);
    expect(foreign.errors.join(' ')).toMatch(/does not exist in task/);
  });

  it('executes cached_snapshot recipes like a normal run and only reports cache_hit from a real cache port', async () => {
    const recipe = makeCleaningRecipe({ kind: 'cached_snapshot', budget: { maxModelCalls: 1 } });

    const withoutCache = makeHarness();
    const executed = await withoutCache.runtime.run(recipe, makeRunContext(sourceInputs(LEGACY_SOURCE_ID)));
    expect(executed.cacheState).toBe('executed');
    expect(executed.llmCalls).toBe(0);
    expect(executed.outputs[0]!.rowCount).toBe(22);

    const cache = new FakeRecipeCache();
    const harness = makeHarness({ cache });
    const first = await harness.runtime.run(recipe, makeRunContext(sourceInputs(LEGACY_SOURCE_ID)));
    expect(first.cacheState).toBe('executed');
    expect(cache.puts).toBe(1);

    const second = await harness.runtime.run(recipe, makeRunContext(sourceInputs(LEGACY_SOURCE_ID)));
    expect(second.cacheState).toBe('cache_hit');
    expect(second.toolCalls).toBe(0);
    expect(second.llmCalls).toBe(0);
    expect(second.normalizedOutputHash).toBe(first.normalizedOutputHash);
    expect(second.outputs).toEqual(first.outputs);

    // A different input must not hit the cache.
    const changed = await harness.runtime.run(recipe, makeRunContext(sourceInputs(NEW_SOURCE_ID)));
    expect(changed.cacheState).toBe('executed');
  });
});
