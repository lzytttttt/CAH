/** Minimal hash router (no router dependency). Pure parse/format helpers. */

export type RouteName = 'tasks' | 'task-new' | 'task' | 'settings' | 'not-found';

export interface Route {
  name: RouteName;
  taskId: string | null;
  raw: string;
}

export function parseHash(hash: string): Route {
  const normalized = hash.replace(/^#\/?/, '').replace(/\/+$/, '');
  const raw = hash;
  if (normalized === '' || normalized === 'tasks') return { name: 'tasks', taskId: null, raw };
  if (normalized === 'tasks/new' || normalized === 'new') return { name: 'task-new', taskId: null, raw };
  if (normalized === 'settings') return { name: 'settings', taskId: null, raw };
  const taskMatch = /^tasks\/([A-Za-z0-9-]+)$/.exec(normalized);
  if (taskMatch) return { name: 'task', taskId: taskMatch[1]!, raw };
  return { name: 'not-found', taskId: null, raw };
}

export function routeToHash(route: { name: RouteName; taskId?: string | null }): string {
  switch (route.name) {
    case 'tasks':
      return '#/tasks';
    case 'task-new':
      return '#/tasks/new';
    case 'task':
      return `#/tasks/${route.taskId ?? ''}`;
    case 'settings':
      return '#/settings';
    case 'not-found':
      return '#/tasks';
  }
}

/** Validate a task id coming from the URL before calling the API. */
export function isTaskId(value: string | null): value is string {
  return value != null && /^[0-9a-fA-F-]{16,64}$/.test(value);
}

export function navigate(route: { name: RouteName; taskId?: string | null }): void {
  if (typeof window === 'undefined') return;
  const hash = routeToHash(route);
  if (window.location.hash !== hash) window.location.hash = hash;
}
