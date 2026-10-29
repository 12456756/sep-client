import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { GENERAL_ASSISTANT_ID } from './general-assistant';
import { createHomeViewModel } from './home-view-model';
import type { SiliconEmployee, WorkItem } from './types';

const employee = (id: string, patch: Partial<SiliconEmployee> = {}): SiliconEmployee => ({
  id, name: id, avatar: null, avatarAsset: null, mark: id, roleName: '员工', department: null,
  availability: 'ready', assignedToMe: true, intro: '', goodAt: [], cannotDo: [], lastWorkedAt: null,
  allowedModels: [], skillIds: [], permissions: [], templateVersion: '1', ...patch,
});

const work = (id: string, updatedAt: number, patch: Partial<WorkItem> = {}): WorkItem => ({
  id, title: id, goal: '', kind: 'conversation', workType: { state: 'loading' }, status: 'completed',
  isActive: false, progress: 100, currentEmployeeId: '', currentEmployeeName: '', steps: [], nextUserAction: null,
  createdAt: updatedAt, startedAt: null, completedAt: updatedAt, updatedAt, participants: [], deliverables: [],
  timeline: [], messages: [], activities: [], sharedContext: { goal: '', confirmedInputs: [], previousResults: [], userNotes: [] },
  stopReason: null, workDir: null, ...patch,
});

describe('createHomeViewModel', () => {
  it('counts the full authorized roster and excludes unassigned and general assistant employees', () => {
    const employees = Array.from({ length: 27 }, (_, index) => employee(`e${index}`));
    employees.push(employee('outside', { assignedToMe: false }), employee(GENERAL_ASSISTANT_ID));
    const model = createHomeViewModel(employees, []);
    assert.equal(model.stats.total, 27);
    assert.equal(model.roster.length, 27);
    assert.equal(model.recommendedEmployees.length, 5);
    assert.equal(model.allRecommendedEmployees.length, 27);
    assert.equal(model.stats.idle, 27);
  });

  it('counts only explicitly active work and ignores employee ids outside the authorized roster', () => {
    const employees = [employee('working', { availability: 'working' }), employee('active'), employee('arranging'), employee('unassigned', { assignedToMe: false })];
    const works = [
      work('running', 20, { isActive: true, currentEmployeeId: 'active', participants: ['missing', 'unassigned'] }),
      work('draft', 30, { isActive: false, status: 'arranging', currentEmployeeId: 'arranging' }),
    ];
    const model = createHomeViewModel(employees, works);
    assert.deepEqual(model.stats, { total: 3, working: 2, idle: 1 });
  });

  it('sorts work recency stably and does not mutate inputs', () => {
    const employees = [employee('a', { lastWorkedAt: 40 }), employee('b', { lastWorkedAt: 40 }), employee('c', { lastWorkedAt: 10 }), employee('never')];
    const works = [work('older', 5), work('first-tie', 20, { participants: ['c'] }), work('second-tie', 20, { participants: ['b'] })];
    const originalEmployees = [...employees];
    const originalWorks = [...works];
    const model = createHomeViewModel(employees, works);
    assert.deepEqual(model.recentWorks.map(item => item.id), ['first-tie', 'second-tie', 'older']);
    assert.deepEqual(model.recentEmployees.map(item => item.id), ['a', 'b', 'c']);
    assert.deepEqual(employees, originalEmployees);
    assert.deepEqual(works, originalWorks);
  });

  it('does not include employees with no work participation and no last-work timestamp', () => {
    const model = createHomeViewModel([employee('used', { lastWorkedAt: 20 }), employee('never')], []);
    assert.deepEqual(model.recentEmployees.map(item => item.id), ['used']);
  });
});
