/** Pure helpers for editing task constraints and the module dependency graph. */
import type { AcceptanceCriterion, Constraint, ModuleView, UpdateTaskRequest } from '@ca/contracts';

/** DFS cycle check for module dependencies before submitting an edit. */
export function findModuleDependencyCycle(modules: ReadonlyArray<{ id: string; dependencies: readonly string[] }>): string[] | null {
  const byId = new Map(modules.map((module) => [module.id, module]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  function visit(id: string): string[] | null {
    const mark = state.get(id) ?? 0;
    if (mark === 2) return null;
    if (mark === 1) {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    state.set(id, 1);
    stack.push(id);
    const dependencies = byId.get(id)?.dependencies ?? [];
    for (const dependency of dependencies) {
      if (!byId.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  }

  for (const module of modules) {
    const cycle = visit(module.id);
    if (cycle) return cycle;
  }
  return null;
}

/** Only self-dependency-free graphs with existing targets are submittable. */
export function validateModuleGraphEdit(modules: ReadonlyArray<{ id: string; dependencies: readonly string[] }>): string[] {
  const errors: string[] = [];
  const ids = new Set(modules.map((module) => module.id));
  for (const module of modules) {
    for (const dependency of module.dependencies) {
      if (dependency === module.id) errors.push('模块不能依赖自身');
      else if (!ids.has(dependency)) errors.push(`依赖的模块不存在：${dependency}`);
    }
  }
  const cycle = findModuleDependencyCycle(modules);
  if (cycle) errors.push(`依赖关系存在环路：${cycle.join(' → ')}`);
  return [...new Set(errors)];
}

export interface ModuleEditState {
  moduleId: string;
  title: string;
  order: number;
  dependencies: string[];
  acceptanceCriteria: Array<{ id: string; text: string; layer: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' }>;
}

export function moduleEditStateFromViews(modules: readonly ModuleView[]): ModuleEditState[] {
  return modules.map((view) => ({
    moduleId: view.module.id,
    title: view.module.title,
    order: view.module.order,
    dependencies: [...view.module.dependencies],
    acceptanceCriteria: view.module.acceptanceCriteria.map((criterion) => ({
      id: criterion.id,
      text: criterion.text,
      layer: criterion.layer,
    })),
  }));
}

export function buildModuleUpdates(edits: readonly ModuleEditState[]): NonNullable<UpdateTaskRequest['modules']> {
  return edits.map((edit) => ({
    moduleId: edit.moduleId as never,
    title: edit.title.trim().slice(0, 200) || '未命名模块',
    order: Math.max(0, Math.min(7, Math.floor(edit.order))),
    dependencies: edit.dependencies as never[],
    acceptanceCriteria: edit.acceptanceCriteria
      .filter((criterion) => criterion.text.trim().length > 0)
      .slice(0, 32)
      .map((criterion) => ({ id: criterion.id, text: criterion.text.trim().slice(0, 2000), layer: criterion.layer })),
  }));
}

/** Constraints are edited as a full list (ids are stable slugs). */
export function upsertConstraint(constraints: readonly Constraint[], next: Constraint): Constraint[] {
  const exists = constraints.some((constraint) => constraint.id === next.id);
  return exists ? constraints.map((constraint) => (constraint.id === next.id ? next : constraint)) : [...constraints, next];
}

export function removeConstraint(constraints: readonly Constraint[], id: string): Constraint[] {
  return constraints.filter((constraint) => constraint.id !== id);
}

export function nextConstraintId(constraints: readonly Constraint[]): string {
  let index = constraints.length + 1;
  let candidate = `C-${String(index).padStart(2, '0')}`;
  const used = new Set(constraints.map((constraint) => constraint.id));
  while (used.has(candidate)) {
    index += 1;
    candidate = `C-${String(index).padStart(2, '0')}`;
  }
  return candidate;
}

export function emptyConstraint(id: string): Constraint {
  return { id, text: '', kind: 'preference', status: 'open', sourceRefs: [], note: '' };
}

export type { AcceptanceCriterion };
