import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

// Exercise actual React effects and deferred IPC replies, including A → B → A request keys.
const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useArrangementPlans } from './src/features/enterprise/use-arrangement-plans';
import { AutoArrange } from './src/components/enterprise/arrange/AutoArrange';
window.requests = [];
window.electronAPI = {
  getArrangementPlan: async () => ({ success: true, plan: null }),
  getTaskTimeline: async () => ({ success: true, events: [] }),
  getArrangementExecution: () => new Promise(resolve => window.requests.push(resolve)),
};
const task = { id: 'task', activeRunId: 'run', status: 'running', workType: { state: 'resolved', kind: 'arrangement' } };
function App() {
  const [tasks, setTasks] = useState([task]);
  const [scope, setScope] = useState('scope-a');
  window.setTasks = setTasks;
  window.setScope = setScope;
  window.task = task;
  const state = useArrangementPlans(tasks, scope);
  return <pre id="state">{JSON.stringify(state)}</pre>;
}
const draft = { id: 'draft', status: 'awaiting-employee', nodes: [], unresolvedSteps: [{ stepId: 'step', requiredCapabilities: [] }],
  candidateMatches: [{ stepId: 'step', employeeId: 'employee', name: 'Employee', source: 'enterprise' }] };
window.planningDraft = draft;
function Auto() {
  return <AutoArrange employees={[]} busy={false} onStart={async value => value} settings={{ workDir: '', modelId: 'model', permissions: {} }}
    models={[]} onSettingsChange={() => {}} onChooseFolder={async () => null} />;
}
const root = createRoot(document.getElementById('root'));
window.mount = name => root.render(name === 'auto' ? <Auto /> : <App />);
window.mount('plans');
`;

test('arrangement IPC requests discard stale responses and keep pending draft actions bound', async () => {
  const bundle = await build({
    stdin: { contents: fixture, loader: 'tsx', resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{
      name: 'planning-ipc-fixture',
      setup(builder) {
        builder.onResolve({ filter: /\?url$/ }, args => ({ path: args.path, namespace: 'fixture-url' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture-url' }, () => ({ contents: 'export default "/unused-capture-worklet.js";' }));
        builder.onLoad({ filter: /\/use-auto-planning\.ts$/ }, () => ({ contents: `
          import { useState } from 'react';
          export function useAutoPlanning() {
            const [draft, setDraft] = useState(window.planningDraft);
            const wait = () => new Promise(resolve => { window.finishAccess = () => { setDraft({ ...window.planningDraft, revision: 2 }); resolve(); }; });
            return { draft, setDraft, events: [], planning: false, cancellable: false, error: null, setError: () => {},
              requestEmployeeAccess: wait, refreshEmployeeAccess: wait, recheck: () => {} };
          }
        ` }));
      },
    }],
  });
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', request.url === '/fixture.js' ? 'text/javascript' : 'text/html');
    response.end(request.url === '/fixture.js' ? bundle.outputFiles[0].text : '<div id="root"></div><script src="/fixture.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const url = `http://127.0.0.1:${address.port}`;
    const resolveRequest = async (index, updatedAt) => {
      await page.evaluate(`window.requests[${index}]({ success: true, execution: { activeRunId: 'run', status: 'running', nodes: [], updatedAt: ${updatedAt} } })`);
    };
    await page.goto(url);
    await page.waitForFunction('window.requests.length === 1');
    await page.evaluate("window.setTasks([{ ...window.task, status: 'paused' }])");
    await page.waitForFunction('window.requests.length === 2');
    await page.evaluate('window.setTasks([window.task])');
    await page.waitForFunction('window.requests.length === 3');
    await resolveRequest(2, 30);
    await page.waitForFunction('JSON.parse(document.querySelector("#state").textContent).executions.task?.updatedAt === 30');
    await resolveRequest(0, 10);
    // A browser round-trip after the promise resolves lets React publish a stale update if accepted.
    assert.equal(await page.locator('#state').evaluate(element => JSON.parse(element.textContent).executions.task.updatedAt), 30);

    await page.goto(url);
    await page.waitForFunction('window.requests.length === 1');
    await page.evaluate('window.setTasks([])');
    await page.waitForFunction('!JSON.parse(document.querySelector("#state").textContent).executions.task');
    await resolveRequest(0, 10);
    assert.equal(await page.locator('#state').evaluate(element => JSON.parse(element.textContent).executions.task), undefined);
    await page.evaluate('window.setTasks([window.task])');
    await page.waitForFunction('window.requests.length === 2');
    await page.evaluate("window.setScope('scope-b')");
    await page.waitForFunction('window.requests.length === 3');
    await resolveRequest(1, 20);
    assert.equal(await page.locator('#state').evaluate(element => JSON.parse(element.textContent).executions.task), undefined);
    await resolveRequest(2, 30);
    await page.waitForFunction('JSON.parse(document.querySelector("#state").textContent).executions.task?.updatedAt === 30');

    await page.evaluate("window.mount('auto')");
    await page.getByRole('button', { name: '申请员工', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '重新编排', exact: true }).isDisabled(), true);
    await page.evaluate('window.finishAccess()');
    await page.waitForFunction('!Array.from(document.querySelectorAll("button")).find(button => button.textContent === "重新编排").disabled');
    // Querying an existing request has the same race as submitting a new one.
    await page.goto(url);
    await page.evaluate(`window.planningDraft = { ...window.planningDraft, employeeAccessRequests: [{ stepId: 'step', employeeId: 'employee', requestId: 'request', status: 'PENDING' }] }; window.mount('auto')`);
    await page.getByRole('button', { name: '查询状态', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '重新编排', exact: true }).isDisabled(), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
