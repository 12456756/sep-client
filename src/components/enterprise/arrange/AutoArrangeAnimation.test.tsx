import * as assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ArrangementDraft, ArrangementPlanningProgress } from '../../../shared/types';
import type { SiliconEmployee } from '../../../features/enterprise/types';
import { AutoArrangeAnimation, AutoArrangeEmployees, getTeamAnimationTiming } from './AutoArrangeAnimation';

describe('AutoArrangeEmployees', () => {
  let previousReact: unknown;
  beforeEach(() => {
    previousReact = Reflect.get(globalThis, 'React');
    Object.defineProperty(globalThis, 'React', { configurable: true, value: React });
  });
  afterEach(() => {
    if (previousReact === undefined) Reflect.deleteProperty(globalThis, 'React');
    else Object.defineProperty(globalThis, 'React', { configurable: true, value: previousReact });
  });

  const employees = [
    { id: 'research', name: 'Research employee', roleName: 'Researcher' },
    { id: 'writer', name: 'Writing employee', roleName: 'Writer' },
    { id: 'unused', name: 'Unselected employee', roleName: 'Designer' },
  ] as SiliconEmployee[];
  const nodes = [
    { subscriptionId: 'writer' }, { subscriptionId: 'research' }, { subscriptionId: 'writer' },
  ] as ArrangementDraft['nodes'];

  it('shows no employee identities or result box until the final draft is ready', () => {
    const html = renderToStaticMarkup(React.createElement(AutoArrangeEmployees, { nodes, employees, ready: false }));
    assert.doesNotMatch(html, /employee|ent-aa-team/);
  });

  it('shows only selected employees once, in one shared box and in first-step order', () => {
    const html = renderToStaticMarkup(React.createElement(AutoArrangeEmployees, { nodes, employees, ready: true }));
    assert.equal((html.match(/class="ent-aa-team"/g) ?? []).length, 1);
    assert.equal((html.match(/Writing employee/g) ?? []).length, 1);
    assert.equal((html.match(/Research employee/g) ?? []).length, 1);
    assert.match(html, /Writer/);
    assert.match(html, /Researcher/);
    assert.equal((html.match(/ent-face md round/g) ?? []).length, 2);
    assert.doesNotMatch(html, /Unselected employee|scanning|picked|passed|gone|ent-aa-card/);
    assert.ok(html.indexOf('Writing employee') < html.indexOf('Research employee'));
  });

  it('preserves selected identities when an employee is missing from the directory', () => {
    const html = renderToStaticMarkup(React.createElement(AutoArrangeEmployees, {
      nodes: [{ subscriptionId: 'missing-employee' }] as ArrangementDraft['nodes'], employees: [], ready: true,
    }));
    assert.match(html, /missing-employee/);
    assert.match(html, /placeholder/);
  });

  it('does not render an empty result box', () => {
    const html = renderToStaticMarkup(React.createElement(AutoArrangeEmployees, { nodes: [], employees, ready: true }));
    assert.equal(html, '');
  });

  it('reserves every selected slot and staggers entries after the frame appears', () => {
    const html = renderToStaticMarkup(React.createElement(AutoArrangeEmployees, { nodes, employees, ready: true }));
    assert.equal((html.match(/class="ent-aa-team-member"/g) ?? []).length, 2);
    assert.match(html, /--aa-entry-delay:300ms/);
    assert.match(html, /--aa-entry-delay:900ms/);
    assert.match(html, /--aa-entry-duration:500ms/);
    assert.doesNotMatch(html, /--aa-entry-delay:1500ms/);
  });

  it('fades out the frame only when requested by the presentation timeline', () => {
    const html = renderToStaticMarkup(React.createElement(AutoArrangeEmployees, {
      nodes, employees, ready: true, exiting: true,
    }));
    assert.match(html, /class="ent-aa-team exiting"/);
    assert.match(html, /--aa-exit-duration:220ms/);
  });

  it('removes entry delays for reduced motion without removing employees', () => {
    const html = renderToStaticMarkup(React.createElement(AutoArrangeEmployees, {
      nodes, employees, ready: true, reducedMotion: true,
    }));
    assert.equal((html.match(/--aa-entry-delay:0ms/g) ?? []).length, 2);
    assert.match(html, /--aa-entry-duration:0ms/);
    assert.match(html, /Writing employee/);
    assert.match(html, /Research employee/);
  });
});

describe('employee presentation timeline', () => {
  it('waits for the final employee to arrive, holds for 1.5 seconds, then fades out', () => {
    for (const count of [1, 2, 3, 6]) {
      const timing = getTeamAnimationTiming(count);
      assert.equal(timing.frameMs, 300);
      assert.equal(timing.entryMs, 500);
      assert.equal(timing.staggerMs, 600);
      assert.equal(timing.leaveAtMs, 300 + (count - 1) * 600 + 500 + 1500);
      assert.equal(timing.flowAtMs, timing.leaveAtMs + 220);
    }
  });

  it('keeps a readable hold even when motion is reduced', () => {
    const timing = getTeamAnimationTiming(6, true);
    assert.equal(timing.frameMs, 0);
    assert.equal(timing.entryMs, 0);
    assert.equal(timing.staggerMs, 0);
    assert.equal(timing.leaveAtMs, 1500);
    assert.equal(timing.flowAtMs, 1500);
  });
});

describe('AutoArrangeAnimation', () => {
  it('uses the upper-middle layout only for the analyzing screen', () => {
    const previousWindow = Reflect.get(globalThis, 'window');
    const previousReact = Reflect.get(globalThis, 'React');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { matchMedia: () => ({ matches: false }) },
    });
    Object.defineProperty(globalThis, 'React', { configurable: true, value: React });
    try {
      const render = (status: ArrangementDraft['status'], terminalType?: 'arrangement_planning_failed' | 'arrangement_planning_cancelled'): string =>
        renderToStaticMarkup(React.createElement(AutoArrangeAnimation, {
          draft: { id: 'draft-a', status, nodes: [] } as unknown as ArrangementDraft,
          employees: [],
          planning: !terminalType,
          planningEvents: terminalType ? [{
            planningId: 'planning-a', draftId: 'draft-a', draftRevision: 2,
            type: terminalType, occurredAt: 1, data: {},
          }] : [],
          children: null,
        }));

      assert.ok(render('planning').includes('ent-arr-auto ent-aa-analyzing'));
      assert.doesNotMatch(render('awaiting-employee'), /ent-aa-analyzing/);
      assert.doesNotMatch(render('planning', 'arrangement_planning_failed'), /ent-aa-analyzing/);
      assert.doesNotMatch(render('planning', 'arrangement_planning_cancelled'), /ent-aa-analyzing/);
    } finally {
      if (previousWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
      else Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
      if (previousReact === undefined) Reflect.deleteProperty(globalThis, 'React');
      else Object.defineProperty(globalThis, 'React', { configurable: true, value: previousReact });
    }
  });

  it('renders a terminal failure instead of staying on the analyzing phase', () => {
    const draft = { id: 'draft-a', status: 'planning', nodes: [] } as unknown as ArrangementDraft;
    const failure: ArrangementPlanningProgress = {
      planningId: 'planning-a',
      draftId: 'draft-a',
      draftRevision: 2,
      type: 'arrangement_planning_failed',
      occurredAt: 1,
      data: { message: '自动编排失败' },
    };
    const previousWindow = Reflect.get(globalThis, 'window');
    const previousReact = Reflect.get(globalThis, 'React');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { matchMedia: () => ({ matches: false }) },
    });
    Object.defineProperty(globalThis, 'React', { configurable: true, value: React });
    try {
      const html = renderToStaticMarkup(React.createElement(AutoArrangeAnimation, {
        draft,
        employees: [],
        planning: false,
        planningEvents: [failure],
        children: React.createElement('button', null, '重新编排'),
      }));

      assert.match(html, /自动编排未能完成/);
      assert.doesNotMatch(html, /正在分析你的工作目标/);
      assert.match(html, /重新编排/);
    } finally {
      if (previousWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
      else Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
      if (previousReact === undefined) Reflect.deleteProperty(globalThis, 'React');
      else Object.defineProperty(globalThis, 'React', { configurable: true, value: previousReact });
    }
  });
});
