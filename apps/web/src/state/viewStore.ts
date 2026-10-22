/**
 * ViewState store (Zustand) — the ONLY locally persisted state.
 *
 * It holds elevation, selection, focus scope, expanded branches, drafts,
 * open panels, paging and local filters. It never holds business results:
 * no snapshots, runs, patches, recipes or command acks. Layer switching and
 * focus changes only write here, so they can never issue commands (design 10.2
 * / 14.1).
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type ElevationLayer = 'global' | 'execution' | 'evidence';

export type PanelId =
  | 'plan'
  | 'repair'
  | 'review'
  | 'versions'
  | 'sources'
  | 'settings'
  | 'export'
  | 'events'
  | 'recipes'
  | 'constraints';

export interface PanelContext {
  patchId?: string;
  moduleId?: string;
  runId?: string;
  recipeId?: string;
  blockerId?: string;
  initialTab?: string;
}

export type EvidenceFilterKind = 'all' | 'sources' | 'spans' | 'tools' | 'validation';
export type EvidenceTab = 'sources' | 'spans' | 'tools' | 'validation';

export interface ViewFilters {
  evidenceKind: EvidenceFilterKind;
  evidenceQuery: string;
  eventCategory: string;
  eventQuery: string;
}

export interface ReplayView {
  enabled: boolean;
  cursorSeq: number | null;
}

export interface ViewState {
  layer: ElevationLayer;
  selectedModuleId: string | null;
  selectedEntityId: string | null;
  focusScopeId: string | null;
  /** Entity selected before entering focus mode; restored on exit (keyboard focus too). */
  focusReturnEntityId: string | null;
  expandedBranches: string[];
  reducedMotion: boolean;
  /** Module intent drafts keyed by `${taskId}:${moduleId}`; never submitted automatically. */
  intentDrafts: Record<string, string>;
  /** Sources checked for the next run (view-only until the command is sent). */
  intentSourceIds: string[];
  /** Form preference for the next run; not business state. */
  planFirst: boolean;
  evidenceTab: EvidenceTab;
  panel: PanelId | null;
  panelContext: PanelContext | null;
  modulePage: number;
  filters: ViewFilters;
  canopyOpen: boolean;
  evidenceOpen: boolean;
  highLedgeCollapsed: boolean;
  planPreviewCollapsed: boolean;
  repairBatch: number;
  replay: ReplayView;
}

export interface ViewActions {
  setLayer(layer: ElevationLayer): void;
  shiftLayer(direction: 'up' | 'down'): void;
  selectModule(moduleId: string | null): void;
  selectEntity(entityId: string | null, moduleId?: string | null): void;
  enterFocus(entityId: string, moduleId?: string | null): void;
  exitFocus(): void;
  setExpandedBranches(ids: readonly string[]): void;
  toggleBranch(branchId: string, max?: number): void;
  setReducedMotion(value: boolean): void;
  setIntentDraft(taskId: string, moduleId: string, text: string): void;
  clearIntentDraft(taskId: string, moduleId: string): void;
  toggleIntentSource(sourceId: string): void;
  clearIntentSources(): void;
  setPlanFirst(value: boolean): void;
  setEvidenceTab(tab: EvidenceTab): void;
  openPanel(panel: PanelId, context?: PanelContext | null): void;
  closePanel(): void;
  setModulePage(page: number): void;
  setFilters(patch: Partial<ViewFilters>): void;
  setCanopyOpen(value: boolean): void;
  setEvidenceOpen(value: boolean): void;
  setHighLedgeCollapsed(value: boolean): void;
  setPlanPreviewCollapsed(value: boolean): void;
  setRepairBatch(index: number): void;
  setReplay(patch: Partial<ReplayView>): void;
  resetView(): void;
}

export type ViewStore = ViewState & ViewActions;

export const DEFAULT_VIEW_STATE: ViewState = {
  layer: 'execution',
  selectedModuleId: null,
  selectedEntityId: null,
  focusScopeId: null,
  focusReturnEntityId: null,
  expandedBranches: [],
  reducedMotion: false,
  intentDrafts: {},
  intentSourceIds: [],
  planFirst: true,
  evidenceTab: 'sources',
  panel: null,
  panelContext: null,
  modulePage: 0,
  filters: { evidenceKind: 'all', evidenceQuery: '', eventCategory: 'all', eventQuery: '' },
  canopyOpen: true,
  evidenceOpen: false,
  highLedgeCollapsed: false,
  planPreviewCollapsed: false,
  repairBatch: 0,
  replay: { enabled: false, cursorSeq: null },
};

export const VIEW_STORAGE_KEY = 'ca.view.v1';

/** Storage fallback for tests / non-browser execution (no business data ever stored). */
export function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  } as Storage;
}

function resolveStorage(): Storage {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    // Access can throw in privacy modes; fall through to memory.
  }
  return createMemoryStorage();
}

export function createViewStore(initial?: Partial<ViewState>): UseBoundStore<StoreApi<ViewStore>> {
  return create<ViewStore>()(
    persist(
      (set) => ({
        ...DEFAULT_VIEW_STATE,
        ...initial,
        setLayer: (layer) => set({ layer }),
        shiftLayer: (direction) =>
          set((state) => {
            const order: ElevationLayer[] = ['global', 'execution', 'evidence'];
            const index = order.indexOf(state.layer);
            const nextIndex = direction === 'up' ? Math.max(0, index - 1) : Math.min(order.length - 1, index + 1);
            return { layer: order[nextIndex]! };
          }),
        selectModule: (moduleId) => set({ selectedModuleId: moduleId }),
        selectEntity: (entityId, moduleId = null) =>
          set((state) => ({ selectedEntityId: entityId, selectedModuleId: moduleId ?? state.selectedModuleId })),
        enterFocus: (entityId, moduleId = null) =>
          set((state) => ({
            focusScopeId: entityId,
            focusReturnEntityId: state.selectedEntityId,
            selectedEntityId: entityId,
            selectedModuleId: moduleId ?? state.selectedModuleId,
            planPreviewCollapsed: true,
          })),
        exitFocus: () =>
          set((state) => ({ focusScopeId: null, selectedEntityId: state.focusReturnEntityId, focusReturnEntityId: null })),
        setExpandedBranches: (ids) => set({ expandedBranches: [...new Set(ids)].slice(0, 3) }),
        toggleBranch: (branchId, max = 3) =>
          set((state) => {
            const exists = state.expandedBranches.includes(branchId);
            if (exists) return { expandedBranches: state.expandedBranches.filter((id) => id !== branchId) };
            const next = [...state.expandedBranches, branchId];
            while (next.length > max) next.shift();
            return { expandedBranches: next };
          }),
        setReducedMotion: (value) => set({ reducedMotion: value }),
        setIntentDraft: (taskId, moduleId, text) =>
          set((state) => ({ intentDrafts: { ...state.intentDrafts, [`${taskId}:${moduleId}`]: text } })),
        clearIntentDraft: (taskId, moduleId) =>
          set((state) => {
            const drafts = { ...state.intentDrafts };
            delete drafts[`${taskId}:${moduleId}`];
            return { intentDrafts: drafts };
          }),
        toggleIntentSource: (sourceId) =>
          set((state) => ({
            intentSourceIds: state.intentSourceIds.includes(sourceId)
              ? state.intentSourceIds.filter((id) => id !== sourceId)
              : [...state.intentSourceIds, sourceId],
          })),
        clearIntentSources: () => set({ intentSourceIds: [] }),
        setPlanFirst: (value) => set({ planFirst: value }),
        setEvidenceTab: (tab) => set({ evidenceTab: tab }),
        openPanel: (panel, context = null) => set({ panel, panelContext: context }),
        closePanel: () => set({ panel: null }),
        setModulePage: (page) => set({ modulePage: Math.max(0, Math.floor(page)) }),
        setFilters: (patch) => set((state) => ({ filters: { ...state.filters, ...patch } })),
        setCanopyOpen: (value) => set({ canopyOpen: value }),
        setEvidenceOpen: (value) => set({ evidenceOpen: value }),
        setHighLedgeCollapsed: (value) => set({ highLedgeCollapsed: value }),
        setPlanPreviewCollapsed: (value) => set({ planPreviewCollapsed: value }),
        setRepairBatch: (index) => set({ repairBatch: Math.max(0, Math.floor(index)) }),
        setReplay: (patch) => set((state) => ({ replay: { ...state.replay, ...patch } })),
        resetView: () => set({ ...DEFAULT_VIEW_STATE }),
      }),
      {
        name: VIEW_STORAGE_KEY,
        version: 1,
        storage: createJSONStorage(resolveStorage),
        // Only view fields are persisted; business state never reaches localStorage.
        partialize: (state) => ({
          layer: state.layer,
          selectedModuleId: state.selectedModuleId,
          selectedEntityId: state.selectedEntityId,
          focusScopeId: state.focusScopeId,
          focusReturnEntityId: state.focusReturnEntityId,
          expandedBranches: state.expandedBranches,
          reducedMotion: state.reducedMotion,
          intentDrafts: state.intentDrafts,
          intentSourceIds: state.intentSourceIds,
          planFirst: state.planFirst,
          evidenceTab: state.evidenceTab,
          modulePage: state.modulePage,
          filters: state.filters,
          canopyOpen: state.canopyOpen,
          evidenceOpen: state.evidenceOpen,
          highLedgeCollapsed: state.highLedgeCollapsed,
          planPreviewCollapsed: state.planPreviewCollapsed,
          repairBatch: state.repairBatch,
          replay: state.replay,
        }),
      },
    ),
  );
}

/** Default browser store (persisted to localStorage when available). */
export const useViewStore: UseBoundStore<StoreApi<ViewStore>> = createViewStore();

/** Draft key helper shared by the intent pill. */
export function intentDraftKey(taskId: string, moduleId: string): string {
  return `${taskId}:${moduleId}`;
}

export function readIntentDraft(state: ViewState, taskId: string | null, moduleId: string | null): string {
  if (!taskId || !moduleId) return '';
  return state.intentDrafts[intentDraftKey(taskId, moduleId)] ?? '';
}
