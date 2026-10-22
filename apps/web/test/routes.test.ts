import { describe, expect, it } from 'vitest';
import { isTaskId, parseHash, routeToHash } from '../src/lib/routes';
import {
  buildModuleUpdates,
  emptyConstraint,
  findModuleDependencyCycle,
  moduleEditStateFromViews,
  nextConstraintId,
  removeConstraint,
  upsertConstraint,
  validateModuleGraphEdit,
} from '../src/lib/taskGraph';

describe('hash routing (no router dependency)', () => {
  it('parses and formats task list, new, task and settings routes', () => {
    expect(parseHash('')).toMatchObject({ name: 'tasks', taskId: null });
    expect(parseHash('#/tasks')).toMatchObject({ name: 'tasks' });
    expect(parseHash('#/tasks/new')).toMatchObject({ name: 'task-new' });
    expect(parseHash('#/settings')).toMatchObject({ name: 'settings' });
    expect(parseHash('#/tasks/00000000-0000-4000-8000-000000000033')).toMatchObject({ name: 'task', taskId: '00000000-0000-4000-8000-000000000033' });
    expect(parseHash('#/unknown').name).toBe('not-found');
    expect(routeToHash({ name: 'task', taskId: 'abc' })).toBe('#/tasks/abc');
    expect(routeToHash({ name: 'tasks' })).toBe('#/tasks');
  });

  it('validates task ids from URLs before calling the API', () => {
    expect(isTaskId('00000000-0000-4000-8000-000000000033')).toBe(true);
    expect(isTaskId('not-a-task')).toBe(false);
    expect(isTaskId(null)).toBe(false);
  });
});

describe('module graph editing guards (no cycles)', () => {
  const m = (id: string, dependencies: string[]) => ({ id, dependencies });

  it('detects dependency cycles and unknown targets', () => {
    expect(findModuleDependencyCycle([m('a', ['b']), m('b', ['a'])])).toEqual(['a', 'b', 'a']);
    expect(findModuleDependencyCycle([m('a', []), m('b', ['a'])])).toBeNull();
    expect(validateModuleGraphEdit([m('a', ['a'])])).toContain('模块不能依赖自身');
    expect(validateModuleGraphEdit([m('a', ['missing'])]).join(' ')).toContain('依赖的模块不存在');
    expect(validateModuleGraphEdit([m('a', ['b']), m('b', ['a'])]).join(' ')).toContain('环路');
  });

  it('builds update payloads and clamps order/empty criteria', () => {
    const views = [
      {
        module: {
          id: 'm1',
          title: '架构',
          order: 0,
          dependencies: [],
          acceptanceCriteria: [{ id: 'ac1', text: '无环', layer: 'L1', validatorId: null }],
        },
      },
    ] as never;
    const edits = moduleEditStateFromViews(views);
    edits[0]!.order = 99;
    const updates = buildModuleUpdates(edits);
    expect(updates[0]!.order).toBe(7);
    expect(updates[0]!.acceptanceCriteria?.[0]).toMatchObject({ id: 'ac1', layer: 'L1' });
  });

  it('upserts and removes constraints with stable ids', () => {
    const base = [emptyConstraint('C-01')];
    const updated = upsertConstraint(base, { ...emptyConstraint('C-01'), text: '更新' });
    expect(updated).toHaveLength(1);
    expect(updated[0]!.text).toBe('更新');
    const added = upsertConstraint(updated, { ...emptyConstraint('C-02'), text: '新增' });
    expect(added).toHaveLength(2);
    expect(removeConstraint(added, 'C-01')).toHaveLength(1);
    expect(nextConstraintId([emptyConstraint('C-01'), emptyConstraint('C-02')])).toBe('C-03');
  });
});
