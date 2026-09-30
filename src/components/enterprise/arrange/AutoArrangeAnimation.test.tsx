import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ArrangementDraft, ArrangementPlanningProgress } from '../../../shared/types';
import { AutoArrangeAnimation } from './AutoArrangeAnimation';

describe('AutoArrangeAnimation', () => {
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
