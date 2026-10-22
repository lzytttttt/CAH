import { describe, expect, it } from 'vitest';
import { createViewStore, DEFAULT_VIEW_STATE, readIntentDraft } from '../src/state/viewStore';

describe('ViewState store', () => {
  it('contains no business state fields (only view state is persisted)', () => {
    const keys = Object.keys(DEFAULT_VIEW_STATE);
    for (const forbidden of ['snapshot', 'plan', 'patches', 'runs', 'blockers', 'recipes', 'validations', 'usage', 'events', 'session']) {
      expect(keys).not.toContain(forbidden);
    }
    expect(keys).toContain('layer');
    expect(keys).toContain('focusScopeId');
    expect(keys).toContain('intentDrafts');
  });

  it('switches elevation layers without side effects beyond view state', () => {
    const store = createViewStore();
    expect(store.getState().layer).toBe('execution');
    store.getState().setLayer('global');
    expect(store.getState().layer).toBe('global');
    store.getState().shiftLayer('down');
    expect(store.getState().layer).toBe('execution');
    store.getState().shiftLayer('down');
    expect(store.getState().layer).toBe('evidence');
    store.getState().shiftLayer('down');
    expect(store.getState().layer).toBe('evidence');
    store.getState().shiftLayer('up');
    expect(store.getState().layer).toBe('execution');
  });

  it('keeps at most 3 expanded branches and rotates out the oldest', () => {
    const store = createViewStore();
    store.getState().setExpandedBranches(['a', 'b', 'c', 'd']);
    expect(store.getState().expandedBranches).toEqual(['a', 'b', 'c']);
    store.getState().toggleBranch('d', 3);
    expect(store.getState().expandedBranches).toEqual(['b', 'c', 'd']);
    store.getState().toggleBranch('c', 3);
    expect(store.getState().expandedBranches).toEqual(['b', 'd']);
  });

  it('enters focus mode and restores the previously selected entity on exit', () => {
    const store = createViewStore();
    store.getState().selectEntity('node-a', 'module-a');
    store.getState().enterFocus('node-b', 'module-b');
    expect(store.getState().focusScopeId).toBe('node-b');
    expect(store.getState().selectedEntityId).toBe('node-b');
    expect(store.getState().selectedModuleId).toBe('module-b');
    expect(store.getState().focusReturnEntityId).toBe('node-a');
    store.getState().exitFocus();
    expect(store.getState().focusScopeId).toBeNull();
    expect(store.getState().selectedEntityId).toBe('node-a');
  });

  it('stores per task/module intent drafts and source selections without submitting', () => {
    const store = createViewStore();
    store.getState().setIntentDraft('task-1', 'module-1', '更新状态表');
    expect(readIntentDraft(store.getState(), 'task-1', 'module-1')).toBe('更新状态表');
    expect(readIntentDraft(store.getState(), 'task-2', 'module-1')).toBe('');
    store.getState().toggleIntentSource('source-a');
    store.getState().toggleIntentSource('source-b');
    store.getState().toggleIntentSource('source-a');
    expect(store.getState().intentSourceIds).toEqual(['source-b']);
    store.getState().clearIntentSources();
    expect(store.getState().intentSourceIds).toEqual([]);
    store.getState().clearIntentDraft('task-1', 'module-1');
    expect(readIntentDraft(store.getState(), 'task-1', 'module-1')).toBe('');
  });

  it('tracks panels, paging, filters and replay cursor', () => {
    const store = createViewStore();
    store.getState().openPanel('review', { patchId: 'p1' });
    expect(store.getState().panel).toBe('review');
    expect(store.getState().panelContext).toEqual({ patchId: 'p1' });
    store.getState().closePanel();
    expect(store.getState().panel).toBeNull();
    store.getState().setModulePage(2);
    expect(store.getState().modulePage).toBe(2);
    store.getState().setFilters({ eventCategory: 'tool' });
    expect(store.getState().filters.eventCategory).toBe('tool');
    store.getState().setReplay({ enabled: true, cursorSeq: 12 });
    expect(store.getState().replay).toEqual({ enabled: true, cursorSeq: 12 });
    store.getState().resetView();
    expect(store.getState().layer).toBe('execution');
    expect(store.getState().panel).toBeNull();
  });
});
