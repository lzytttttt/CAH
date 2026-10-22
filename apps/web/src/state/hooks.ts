/** React bindings for the business core store, routing and accessibility hooks. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ApiClient } from '../api/types';
import type { CoreState, Notice, WorkbenchCore } from './coreStore';
import type { ViewStore } from './viewStore';
import { useViewStore } from './viewStore';
import type { Route } from '../lib/routes';
import { navigate, parseHash, routeToHash } from '../lib/routes';

/* ------------------------------- core context ------------------------------- */

export const CoreContext = createContext<WorkbenchCore | null>(null);

export function useCore(): WorkbenchCore {
  const core = useContext(CoreContext);
  if (!core) throw new Error('CoreContext 未初始化：请在 App 中提供 WorkbenchCore');
  return core;
}

export function useApiClient(): ApiClient {
  return useCore().client;
}

export function useCoreState(): CoreState {
  const core = useCore();
  return useSyncExternalStore(core.subscribe, core.getState, core.getState);
}

export function useNotices(): { notices: Notice[]; dismiss: (id: string) => void } {
  const core = useCore();
  const state = useSyncExternalStore(core.subscribe, core.getState, core.getState);
  return { notices: state.notices, dismiss: (id: string) => core.dismissNotice(id) };
}

export function useCommandPending(): { pending: boolean; label: string | null } {
  const state = useCoreState();
  return { pending: state.command != null, label: state.command?.label ?? null };
}

export function useView<T>(selector: (state: ViewStore) => T): T {
  return useViewStore(selector);
}

export function useViewActions(): ViewStore {
  return useViewStore();
}

/* --------------------------------- routing --------------------------------- */

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(typeof window === 'undefined' ? '' : window.location.hash));
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onChange = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    // Normalize an empty hash so the app has a stable addressable route.
    if (!window.location.hash) window.location.hash = routeToHash({ name: 'tasks', taskId: null });
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function useNavigate(): (route: { name: Route['name']; taskId?: string | null }) => void {
  return useCallback((route) => navigate({ name: route.name, taskId: route.taskId ?? null }), []);
}

/* ------------------------------ media queries ------------------------------ */

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(query).matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent): void => setMatches(event.matches);
    setMatches(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}

/** Effective reduced motion: user preference OR workspace policy OR OS setting. */
export function useEffectiveReducedMotion(): boolean {
  const state = useCoreState();
  const localPreference = useViewStore((store) => store.reducedMotion);
  const prefers = usePrefersReducedMotion();
  return localPreference || prefers || Boolean(state.workspace?.workspace.settings.reducedMotion);
}

/** Pause non-essential animation while the window/tab is hidden (design 16.2). */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => (typeof document === 'undefined' ? true : document.visibilityState !== 'hidden'));
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onChange = (): void => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

/* -------------------------------- hotkeys -------------------------------- */

function isEditableElement(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as HTMLElement;
  const tag = element.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable === true;
}

export interface GlobalHotkeysOptions {
  onLayerShift(direction: 'up' | 'down'): void;
  onEscape(): void;
  enabled?: boolean;
}

/** Alt+↑/↓ switches elevation; Escape closes the current panel / focus mode. */
export function useGlobalHotkeys({ onLayerShift, onEscape, enabled = true }: GlobalHotkeysOptions): void {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onEscape();
        return;
      }
      if (!event.altKey || isEditableElement(event.target)) return;
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        onLayerShift('up');
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        onLayerShift('down');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [enabled, onEscape, onLayerShift]);
}

/* ------------------------------ focus restore ------------------------------ */

/**
 * Restore DOM focus after the focus scope is exited (design 14.1). The view
 * store only keeps the entity id; a data attribute maps it back to an element.
 */
export function useFocusRestore(scopeId: string | null): void {
  const previousScope = useRef<string | null>(null);
  useEffect(() => {
    const wasFocused = previousScope.current != null;
    previousScope.current = scopeId;
    if (typeof document === 'undefined') return;
    if (scopeId == null && wasFocused) {
      const target = document.querySelector<HTMLElement>('[data-focus-restored="true"]') ?? document.querySelector<HTMLElement>('[data-selected="true"]');
      target?.focus?.();
    }
  }, [scopeId]);
}

/* -------------------------------- intervals -------------------------------- */

/** Stable tick for relative time labels (view-only; never drives business state). */
export function useNowTicker(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/* ----------------------------- misc utilities ----------------------------- */

export function useDebouncedValue<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function useCopyToClipboard(): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copy = useCallback((text: string) => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    });
  }, []);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return { copied, copy };
}

/** Group helpers used by panels without re-computing on every render. */
export function useMemoized<T>(factory: () => T, deps: unknown[]): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(factory, deps);
}
