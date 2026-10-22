import { describe, expect, it } from 'vitest';
import {
  HarnessEventSchema,
  makeHarnessEvent,
  parseHarnessEvent,
  TaskIdSchema,
  RunIdSchema,
  StepIdSchema,
  EventIdSchema,
  ModuleIdSchema,
  newEventId,
  newRunId,
  newTaskId,
  newStepId,
  newModuleId,
  EVENT_TYPES,
  EVENT_CATEGORY_BY_TYPE,
  findSeqGaps,
  dedupeEvents,
  planReadyForCommit,
  findPlanCycle,
  findUnknownPlanDependencies,
  PlanSchema,
  utcNow,
} from '../src/index';

const taskId = TaskIdSchema.parse('11111111-1111-4111-8111-111111111111');
const runId = RunIdSchema.parse('22222222-2222-4222-8222-222222222222');
const stepId = StepIdSchema.parse('33333333-3333-4333-8333-333333333333');
const moduleId = ModuleIdSchema.parse('44444444-4444-4444-8444-444444444444');

describe('event contracts', () => {
  it('builds and validates a typed event with derived category', () => {
    const event = makeHarnessEvent({
      taskId,
      runId,
      stepId: null,
      seq: 1,
      causationId: null,
      type: 'run.state_changed',
      payload: { from: 'CREATED', to: 'PLANNING', reason: 'plan command accepted' },
      eventId: newEventId(),
      timestamp: utcNow(),
    });
    expect(event.category).toBe('control');
    expect(parseHarnessEvent(event).type).toBe('run.state_changed');
  });

  it('rejects invalid payloads per event type', () => {
    const bad = {
      schemaVersion: '1',
      eventId: newEventId(),
      taskId,
      runId: null,
      stepId: null,
      seq: 2,
      causationId: null,
      type: 'plan.committed',
      category: 'plan',
      payload: { runId, planVersion: 1 },
      timestamp: utcNow(),
    };
    const result = HarnessEventSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects category/type mismatches', () => {
    const bad = {
      schemaVersion: '1',
      eventId: newEventId(),
      taskId,
      runId: null,
      stepId: null,
      seq: 3,
      causationId: null,
      type: 'run.created',
      category: 'tool',
      payload: {
        runId,
        taskId,
        moduleId,
        origin: 'intent',
        baseVersionId: null,
        budget: { maxModelRequests: 12, maxToolCalls: 20 },
      },
      timestamp: utcNow(),
    };
    expect(HarnessEventSchema.safeParse(bad).success).toBe(false);
  });

  it('declares a category for every event type', () => {
    for (const type of EVENT_TYPES) {
      expect(EVENT_CATEGORY_BY_TYPE[type]).toBeTruthy();
    }
  });

  it('dedupes duplicate event ids and seq numbers', () => {
    const base = {
      taskId,
      runId,
      stepId: null,
      causationId: null,
      type: 'run.paused' as const,
      payload: {
        runId,
        returnState: 'RUNNING' as const,
        completedSteps: 1,
        pendingSteps: 2,
        atSafeBoundary: true,
        note: '',
      },
      timestamp: utcNow(),
    };
    const a = makeHarnessEvent({ ...base, seq: 1, eventId: newEventId() });
    const b = makeHarnessEvent({ ...base, seq: 2, eventId: newEventId() });
    const duplicateOfA = makeHarnessEvent({ ...base, seq: 1, eventId: newEventId() });
    const out = dedupeEvents([b, a, duplicateOfA]);
    expect(out.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('finds gaps in a task stream', () => {
    expect(findSeqGaps([{ seq: 1 }, { seq: 3 }], 1)).toEqual([2]);
    expect(findSeqGaps([{ seq: 1 }, { seq: 2 }], 1)).toEqual([]);
  });
});

describe('plan utilities', () => {
  const plan = PlanSchema.parse({
    runId,
    version: 1,
    goal: '生成架构说明',
    targetModuleId: moduleId,
    artifactSkeleton: [{ moduleId, moduleKind: 'json', sections: [], expectedContentSummary: '架构 JSON' }],
    inputRefs: [],
    constraintRefs: [],
    assumptions: [],
    openQuestions: [],
    steps: [
      { id: 's1', title: '读取资料', kind: 'tool', dependencies: [], toolId: 'source.read' },
      { id: 's2', title: '生成结论', kind: 'model', dependencies: ['s1'] },
      { id: 's3', title: '验证', kind: 'validate', dependencies: ['s2'] },
    ],
    tools: [{ toolId: 'source.read', reason: '读取 brief', effect: 'read' }],
    validators: [{ id: 'json.structure', layer: 'L1', description: '结构校验' }],
    budget: {
      maxModelRequests: 12,
      maxToolCalls: 20,
      maxOutputTokens: 8192,
      firstEventTimeoutMs: 30000,
      idleTimeoutMs: 45000,
      totalModelRequestTimeoutMs: 180000,
      toolTimeoutMs: 30000,
      maxRetries: 2,
      maxStructureRepairs: 2,
      maxRunDurationMs: 600000,
      userCostBudgetUsd: null,
    },
    risks: [],
    promptVersion: 'planner-1',
    modelProfileId: null,
    createdAt: utcNow(),
  });

  it('accepts a well-formed plan and reports it ready', () => {
    expect(planReadyForCommit(plan)).toBe(true);
    expect(findPlanCycle(plan.steps)).toBeNull();
    expect(findUnknownPlanDependencies(plan.steps)).toEqual([]);
  });

  it('detects a dependency cycle', () => {
    const cyclic = [
      { id: 'a', dependencies: ['c'] },
      { id: 'b', dependencies: ['a'] },
      { id: 'c', dependencies: ['b'] },
    ];
    expect(findPlanCycle(cyclic)).not.toBeNull();
  });

  it('detects unknown dependencies', () => {
    expect(findUnknownPlanDependencies([{ id: 'a', dependencies: ['ghost'] }])).toEqual(['a->ghost']);
  });
});
