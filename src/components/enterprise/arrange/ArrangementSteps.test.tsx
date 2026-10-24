import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkItem } from '../../../features/enterprise/types';
import { ArrangementSteps } from './ArrangementSteps';

const states = ['failed', 'running', 'blocked', 'done', 'interrupted', 'stopped'] as const;
function work(): Pick<WorkItem, 'id' | 'steps' | 'arrangementExecution'> {
  return { id: 'task', steps: states.map(state => ({ id: state, state, employeeId: 'employee', employeeName: '员工',
    title: state, input: '', output: '', dependsOn: [], needsConfirm: false })),
  arrangementExecution: { activeRunId: 'parent', status: 'running', updatedAt: 1,
    nodes: states.map(state => ({ nodeId: state, status: state === 'done' ? 'completed' : state, finalFiles: [] })) } };
}

function withReact<T>(operation: () => T): T {
  const previous = Reflect.get(globalThis, 'React');
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React });
  try { return operation(); }
  finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'React');
    else Object.defineProperty(globalThis, 'React', { configurable: true, value: previous });
  }
}

test('shows one retry action for the failed node while its peer is running', () => withReact(() => {
  const calls: string[][] = [];
  const tree = ArrangementSteps({ work: work(), busy: false, onRetry: async (...args) => { calls.push(args); } });
  const html = renderToStaticMarkup(tree);
  assert.equal((html.match(/<button/g) ?? []).length, 1);
  assert.match(html, /重试此节点：failed/);
  assert.match(html, /等待前置节点/);
  assert.match(html, /进行中/);
  const visit = (children: React.ReactNode): void => React.Children.forEach(children, child => {
    if (!React.isValidElement<{ children?: React.ReactNode; onClick?: () => void }>(child)) return;
    if (child.type === 'button') child.props.onClick?.();
    visit(child.props.children);
  });
  visit(tree);
  assert.deepEqual(calls, [['task', 'failed']]);
}));

test('disables retry during submission and hides it for stopped or interrupted arrangements', () => withReact(() => {
  const item = work();
  const render = (busy: boolean) => renderToStaticMarkup(React.createElement(ArrangementSteps, { work: item, busy, onRetry: async () => {} }));
  assert.match(render(true), /<button[^>]*disabled=""/);
  for (const status of ['stopped', 'interrupted', 'completed'] as const) {
    item.arrangementExecution!.status = status;
    assert.doesNotMatch(render(false), /<button/);
  }
}));

test('does not offer a node retry from a stale display-only failure', () => withReact(() => {
  const item = work();
  item.arrangementExecution!.nodes[0]!.status = 'running';
  const html = renderToStaticMarkup(React.createElement(ArrangementSteps, { work: item, busy: false, onRetry: async () => {} }));
  assert.doesNotMatch(html, /<button/);
}));
