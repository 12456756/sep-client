export interface SkillDraftChange {
  id: string;
  kind: 'rewrite' | 'manual';
  before: string;
  after: string;
}

export interface SkillDraftHistory {
  content: string;
  revision: number;
  changes: SkillDraftChange[];
  manualEdits: SkillManualEdit[];
}

export interface SkillManualEdit {
  id: string;
  before: string;
  after: string;
  status: 'applied' | 'undone';
}

export function createSkillDraftHistory(content = ''): SkillDraftHistory {
  return { content, revision: 0, changes: [], manualEdits: [] };
}

export function resetSkillDraft(state: SkillDraftHistory, content: string): SkillDraftHistory {
  if (state.content === content && !state.changes.length && !state.manualEdits.length) return state;
  return { content, revision: state.revision + 1, changes: [], manualEdits: [] };
}

export function changeSkillDraft(state: SkillDraftHistory, expectedRevision: number, id: string, kind: SkillDraftChange['kind'], content: string): SkillDraftHistory {
  if (state.revision !== expectedRevision || state.content === content) return state;
  const last = state.changes.at(-1);
  const coalesce = kind === 'manual' && last?.kind === 'manual' && last.id === id;
  if (!coalesce && state.changes.some(change => change.id === id)) return state;
  const change: SkillDraftChange = { id, kind, before: coalesce ? last.before : state.content, after: content };
  const previous = coalesce ? state.changes.slice(0, -1) : state.changes;
  const manualEdits = kind !== 'manual' ? state.manualEdits : change.before === change.after
    ? state.manualEdits.filter(edit => edit.id !== id)
    : state.manualEdits.some(edit => edit.id === id)
      ? state.manualEdits.map(edit => edit.id === id ? { id, before: change.before, after: content, status: 'applied' as const } : edit)
      : [...state.manualEdits, { id, before: change.before, after: content, status: 'applied' as const }];
  return {
    content, revision: state.revision + 1,
    changes: change.before === change.after ? previous : [...previous, change],
    manualEdits,
  };
}

export function undoSkillDraft(state: SkillDraftHistory, id: string): SkillDraftHistory {
  const last = state.changes.at(-1);
  if (!last || last.id !== id || state.content !== last.after) return state;
  return {
    content: last.before, revision: state.revision + 1, changes: state.changes.slice(0, -1),
    manualEdits: last.kind === 'manual' ? state.manualEdits.map(edit => edit.id === id ? { ...edit, status: 'undone' } : edit) : state.manualEdits,
  };
}
