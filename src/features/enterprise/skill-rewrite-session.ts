import type { SkillRewriteInput, SkillRewriteResult } from '../../shared/skill-rewrite';
import type { SkillDraftHistory, SkillManualEdit } from './skill-draft-history';

export type RoundStatus = 'generating' | 'pending' | 'accepted' | 'ignored' | 'superseded' | 'undone' | 'stale' | 'failed' | 'cancelled';
export interface RewriteRound {
  kind: 'rewrite';
  id: string;
  prompt: string;
  source: string;
  revision: number;
  model: string;
  status: RoundStatus;
  result?: SkillRewriteResult;
  error?: string;
}
export type AdjustmentRecord = RewriteRound | (SkillManualEdit & { kind: 'manual' });
interface RewriteState {
  prompt: string;
  modelId: string;
  rounds: AdjustmentRecord[];
  activeRequestId: string | null;
  cancelError: string;
}
export interface SkillEditDraft {
  viewingVersionId: string;
  source: string;
  draftState: SkillDraftHistory;
  editing: boolean;
  name: string;
}

export const effectiveRewriteStatus = (round: RewriteRound, revision: number): RoundStatus =>
  round.status === 'pending' && round.revision !== revision ? 'stale' : round.status;

/** Owned by the signed-in workspace, so navigation only removes the view. */
export class SkillRewriteSession {
  private state: RewriteState = { prompt: '', modelId: '', rounds: [], activeRequestId: null, cancelError: '' };
  private listeners = new Set<() => void>();
  private get valid(): boolean { return this.isActive(); }
  draft?: SkillEditDraft;

  constructor(private readonly isActive: () => boolean = () => true) {}

  getSnapshot = (): RewriteState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  update(patch: Partial<RewriteState>): void {
    if (!this.valid) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  setRounds(update: (rounds: AdjustmentRecord[]) => AdjustmentRecord[]): void {
    this.update({ rounds: update(this.state.rounds) });
  }
  async generate(round: RewriteRound, rewrite: (input: Omit<SkillRewriteInput, 'capabilityId' | 'versionId'>) => Promise<SkillRewriteResult>): Promise<void> {
    if (!this.valid || this.state.activeRequestId) return;
    const history: SkillRewriteInput['history'] = this.state.rounds.flatMap(item => {
      if (item.kind !== 'rewrite') return [];
      const status = effectiveRewriteStatus(item, round.revision);
      return item.result && status !== 'generating' && status !== 'failed' && status !== 'cancelled'
        ? [{ prompt: item.prompt, content: item.result.content, status }] : [];
    }).slice(-3);
    this.update({ activeRequestId: round.id, prompt: '', cancelError: '', rounds: [...this.state.rounds, round] });
    try {
      const result = await rewrite({ requestId: round.id, content: round.source, prompt: round.prompt, modelId: round.model, history });
      if (!this.valid || this.state.activeRequestId !== round.id) return;
      if (result.requestId !== round.id) throw new Error('改写结果与本轮请求不匹配，请重试');
      this.setRounds(rounds => rounds.map(item => item.kind !== 'rewrite' ? item : item.id === round.id ? { ...item, result, status: 'pending' }
        : item.status === 'pending' ? { ...item, status: 'superseded' } : item));
    } catch (cause) {
      if (this.valid && this.state.activeRequestId === round.id) this.setRounds(rounds => rounds.map(item => item.kind === 'rewrite' && item.id === round.id
        ? { ...item, status: 'failed', error: cause instanceof Error ? cause.message : '生成失败，请重试' } : item));
    } finally {
      if (this.valid && this.state.activeRequestId === round.id) this.update({ activeRequestId: null });
    }
  }
  async cancel(cancel: (requestId: string) => Promise<void>): Promise<boolean> {
    const requestId = this.state.activeRequestId;
    if (!this.valid || !requestId) return !requestId;
    try {
      await cancel(requestId);
      if (!this.valid) return false;
      if (this.state.activeRequestId !== requestId) return this.state.activeRequestId === null;
      this.update({ activeRequestId: null, cancelError: '', rounds: this.state.rounds.map(item => item.kind === 'rewrite' && item.id === requestId ? { ...item, status: 'cancelled' } : item) });
      return true;
    } catch (cause) {
      this.update({ cancelError: cause instanceof Error ? cause.message : '停止失败，请重试' });
      return false;
    }
  }
  finishUnchangedEditing(): boolean {
    const draft = this.draft;
    if (!this.valid || this.state.activeRequestId || draft?.draftState.content !== draft?.source) return false;
    const pending = this.state.rounds.some(round => round.kind === 'rewrite' && round.result &&
      effectiveRewriteStatus(round, draft?.draftState.revision ?? round.revision) === 'pending');
    if (pending) return false;
    this.reset();
    return true;
  }
  reset(): void {
    this.update({ prompt: '', modelId: '', rounds: [], activeRequestId: null, cancelError: '' });
    this.draft = undefined;
  }
}
