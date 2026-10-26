import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compileFunction } from 'node:vm';
import * as icons from 'lucide-react';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as ts from 'typescript';
import * as atoms from '../../components/enterprise/atoms';
import { EmployeeFace } from '../../components/enterprise/EmployeeFace';
import { ArrangementSteps } from '../../components/enterprise/arrange/ArrangementSteps';
import { MediaArtifactsPanel } from '../../components/workspace/MediaArtifactsPanel';
import { ArrangementMediaPanel } from '../../components/workspace/ArrangementMediaPanel';
import { DocumentPreviewButton } from '../../components/workspace/DocumentPreviewButton';
import type { WorkItem } from '../../features/enterprise/types';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import * as workProcess from '../../features/enterprise/work-process';
import * as vocabulary from '../../features/enterprise/vocabulary';
import * as generalAssistant from '../../features/enterprise/general-assistant';

// Isolate CSS drawers and the browser-only motion hook; render the real page and media panel.
const dependencies: Record<string, unknown> = {
  'lucide-react': icons,
  react: React,
  'react/jsx-runtime': jsxRuntime,
  '../../components/enterprise/atoms': atoms,
  '../../components/enterprise/EmployeeFace': { EmployeeFace },
  '../../components/enterprise/arrange/ArrangementSteps': { ArrangementSteps },
  '../../components/enterprise/WorkPlanDrawer': { WorkPlanDrawer: () => null },
  '../../components/enterprise/WorkTalkDrawer': { WorkConversation: () => null, WorkTalkDrawer: () => null },
  '../../components/enterprise/IconHint': { IconHint: ({ children }: { children: React.ReactNode }) => children },
  '../../components/enterprise/WorkIndicators': { WorkStatusIcon: () => null, WorkTypeTag: () => null },
  '../../components/workspace/MediaArtifactsPanel': { MediaArtifactsPanel },
  '../../components/workspace/ArrangementMediaPanel': { ArrangementMediaPanel },
  '../../components/workspace/DocumentPreviewButton': { DocumentPreviewButton },
  '../../features/enterprise/work-process': workProcess,
  '../../features/enterprise/use-reduced-motion': { usePrefersReducedMotion: () => false },
  '../../features/enterprise/vocabulary': vocabulary,
  '../../styles/work-detail.css': {},
  '../../features/enterprise/general-assistant': generalAssistant,
};
const filename = fileURLToPath(new URL('./WorkDetailPage.tsx', import.meta.url));
const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  fileName: filename,
}).outputText;
const pageModule = { exports: {} };
const requireStub = (id: string): unknown => {
  assert.ok(Object.hasOwn(dependencies, id), `unexpected runtime import: ${id}`);
  return dependencies[id];
};
compileFunction(compiled, ['require', 'exports', 'module'], { filename })(requireStub, pageModule.exports, pageModule);
const { WorkDetailPage } = pageModule.exports as typeof import('./WorkDetailPage');

const work: WorkItem = {
  id: 'work-media', title: '商品图片', goal: '制作商品图片', kind: 'conversation',
  workType: { state: 'resolved', kind: 'conversation' }, status: 'completed', progress: 100,
  currentEmployeeId: 'employee-a', currentEmployeeName: '电商员工', steps: [], nextUserAction: null,
  createdAt: 1, startedAt: 1, completedAt: 2, updatedAt: 2, isActive: false, participants: [], deliverables: [], timeline: [], messages: [], activities: [],
  sharedContext: { goal: '制作商品图片', confirmedInputs: [], previousResults: [], userNotes: [] },
  stopReason: null, workDir: null,
};

function renderDetail(item: WorkItem): string {
  const workspace = { works: [item], employees: [], myEmployees: [], busy: false, canGoBack: false } as unknown as EnterpriseWorkspace;
  const previousReact = Reflect.get(globalThis, 'React');
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React });
  try {
    return renderToStaticMarkup(React.createElement(WorkDetailPage, { workspace, workId: item.id }));
  } finally {
    if (previousReact === undefined) Reflect.deleteProperty(globalThis, 'React');
    else Object.defineProperty(globalThis, 'React', { configurable: true, value: previousReact });
  }
}

// Check handlers and effect ownership; native focus behavior still needs window verification.
function mountDetail() {
  const cells: unknown[] = [];
  const effects = new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>();
  let cursor = 0;
  let pending: Array<() => void> = [];
  const hooks = {
    ...React,
    useMemo: (factory: () => unknown) => factory(),
    useCallback: (callback: unknown) => callback,
    useRef: (initial: unknown) => { const index = cursor++; return cells[index] ??= { current: initial }; },
    useState: (initial: unknown) => {
      const index = cursor++;
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
      return [cells[index], (next: unknown) => { cells[index] = typeof next === 'function' ? next(cells[index]) : next; }];
    },
    useEffect: (run: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = cursor++;
      const previous = effects.get(index);
      if (previous?.deps && deps && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps?.[i]))) return;
      pending.push(() => { previous?.cleanup?.(); effects.set(index, { deps, cleanup: run() || undefined }); });
    },
  };
  const loaded = { exports: {} };
  compileFunction(compiled, ['require', 'exports', 'module'], { filename })(
    (id: string) => id === 'react' ? hooks : requireStub(id), loaded.exports, loaded,
  );
  const Page = (loaded.exports as typeof import('./WorkDetailPage')).WorkDetailPage;
  let navigated = false;
  const workspace = { works: [work], employees: [], myEmployees: [], busy: false,
    navigate: () => { navigated = true; } } as unknown as EnterpriseWorkspace;
  const root = Page({ workspace, workId: work.id });
  const renderBody = root.type as (props: unknown) => React.ReactElement;
  let elements: React.ReactElement<Record<string, unknown>>[] = [];
  const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; },
    getBoundingClientRect: () => ({ left: 100, right: 860, top: 100, bottom: 700 }) };
  function find(predicate: (element: React.ReactElement<Record<string, unknown>>) => boolean) {
    const element = elements.find(predicate);
    assert.ok(element);
    return element;
  }
  function render() {
    cursor = 0; pending = []; elements = [];
    const visit = (nodes: React.ReactNode) => React.Children.forEach(nodes, child => {
      if (!React.isValidElement<Record<string, unknown>>(child)) return;
      elements.push(child); visit(child.props.children as React.ReactNode);
    });
    visit(renderBody(root.props));
    (Reflect.get(find(element => element.type === 'dialog'), 'ref') as { current: unknown }).current = dialog;
    (Reflect.get(find(element => element.props['aria-label'] === '关闭详情面板'), 'ref') as { current: unknown }).current = { focus() {} };
    pending.forEach(run => run());
  }
  render();
  return { render, dialog, find, navigated: () => navigated, unmount: () => effects.forEach(effect => effect.cleanup?.()) };
}

describe('WorkDetailPage media entry', () => {
  it('shows a pending task as waiting to start, not running time', () => {
    const pending = { ...work, status: 'arranging' as const, isActive: false, createdAt: Date.now() - 7 * 24 * 60 * 60 * 1000, updatedAt: Date.now(), startedAt: null, completedAt: null }
    const html = renderDetail(pending)
    assert.match(html, /排队等待/)
    assert.doesNotMatch(html, /已运行/)
    assert.match(html, />尚未开始</)
  })

  it('does not use an older run start as the current duration while a retry is pending', () => {
    const pendingRetry = { ...work, status: 'arranging' as const, isActive: false, createdAt: 1, startedAt: null, completedAt: null,
      lastRunId: 'run-old', lastRunStartedAt: 2, lastRunEndedAt: 3, updatedAt: 3 }
    const html = renderDetail(pendingRetry)
    assert.match(html, />尚未开始</)
    assert.doesNotMatch(html, /本轮已运行/)
  })

  it('shows the queue state when a run is admitted but has not reached a worker', () => {
    const queued = { ...work, status: 'arranging' as const, isActive: true, queuedAt: Date.now() - 5_000, currentRunStartedAt: null,
      createdAt: 1, startedAt: 1, completedAt: null, lastRunId: 'run-old', lastRunStartedAt: 2 }
    const html = renderDetail(queued)
    assert.match(html, /正在排队/)
    assert.match(html, /排队等待/)
    assert.doesNotMatch(html, /本轮已运行/)
  })

  it('keeps the results inspector closed until requested', () => {
    const html = renderDetail(work);
    assert.match(html, /查看产出结果/);
    assert.match(html, /aria-label="工作对话"/);
    assert.doesNotMatch(html, /aria-label="图片创作与成果"/);
    assert.match(html, /<dialog[^>]+class="ent-wk-inspector"/);
    assert.doesNotMatch(html, /<dialog[^>]*\bopen(?:=|[ >])/);
    assert.doesNotMatch(html, /分享|把这项工作的摘要复制到剪贴板/);
  });

  it('opens every detail as a modal without navigation and keeps the media controller mounted', () => {
    const page = mountDetail();
    for (const label of ['查看产出结果', '查看工作过程', '查看工作信息']) {
      (page.find(element => element.props['aria-label'] === label).props.onClick as () => void)();
      page.render();
      assert.equal(page.dialog.open, true);
      assert.equal(page.navigated(), false);
      const media = page.find(element => element.type === MediaArtifactsPanel);
      assert.equal(media.props.visible, label === '查看产出结果');
      (page.find(element => element.props['aria-label'] === '关闭详情面板').props.onClick as () => void)();
      page.render();
      assert.equal(page.dialog.open, false);
    }
    page.unmount();
  });

  it('ignores nested preview cancellation and inside clicks, and closes on its own Escape or backdrop', () => {
    const page = mountDetail();
    const open = () => { (page.find(element => element.props['aria-label'] === '查看工作过程').props.onClick as () => void)(); page.render(); };
    const props = () => page.find(element => element.type === 'dialog').props;
    open();
    let prevented = false;
    const cancel = () => { prevented = true; };
    (props().onCancel as (event: unknown) => void)({ target: {}, currentTarget: page.dialog, preventDefault: cancel });
    (props().onClick as (event: unknown) => void)({ target: page.dialog, currentTarget: page.dialog, clientX: 150, clientY: 150 });
    page.render();
    assert.equal(prevented, false);
    assert.equal(page.dialog.open, true);
    (props().onCancel as (event: unknown) => void)({ target: page.dialog, currentTarget: page.dialog, preventDefault: cancel });
    page.render();
    assert.equal(prevented, true);
    assert.equal(page.dialog.open, false);
    open();
    (props().onClick as (event: unknown) => void)({ target: page.dialog, currentTarget: page.dialog, clientX: 20, clientY: 20 });
    page.render();
    assert.equal(page.dialog.open, false);
    open(); page.unmount();
    assert.equal(page.dialog.open, false);
  });

  it('does not infer type-specific operations while authoritative classification is unavailable', () => {
    for (const state of ['loading', 'unavailable'] as const) {
      const html = renderDetail({ ...work, workType: { state } });
      assert.match(html, /工作类型/);
      assert.doesNotMatch(html, /aria-label="工作对话"/);
      assert.doesNotMatch(html, /查看产出结果/);
      if (state === 'unavailable') assert.match(html, /重新读取工作类型/);
    }
  });

  it('keeps deletion behind work information and an explicit confirmation', () => {
    const html = renderDetail(work);
    const info = html.indexOf('aria-label="工作信息"');
    assert.ok(info > 0);
    assert.ok(html.indexOf('删除记录', info) > info);
    assert.doesNotMatch(html, />确认删除</);
  });

  it('does not introduce conversation media operations into flow work', () => {
    assert.doesNotMatch(renderDetail({ ...work, kind: 'flow', workType: { state: 'resolved', kind: 'arrangement' } }), /aria-label="图片创作与成果"/);
  });

  it('keeps arrangement media previews unmounted until the results inspector opens', () => {
    const flow = { ...work, kind: 'flow' as const, workType: { state: 'resolved' as const, kind: 'arrangement' as const },
      arrangementExecution: { activeRunId: null, status: 'completed' as const, nodes: [], updatedAt: 1, media: [{ nodeId: 'image', nodeRunId: 'run-1', kind: 'image' as const, operation: 'generate' as const,
        inputs: [], pendingActions: [],
        phase: 'ready' as const, jobId: 'job-1', outputs: [{ artifactId: 'asset-1', status: 'saved' as const }] }] } };
    assert.match(renderDetail(flow), /查看产出结果/);
    assert.doesNotMatch(renderDetail(flow), /编排媒体成果/);
  });

  it('shows the real media waiting stage instead of a fabricated percentage', () => {
    const flow: WorkItem = { ...work, kind: 'flow', status: 'running', progress: 50,
      workType: { state: 'resolved', kind: 'arrangement' },
      steps: [{ id: 'image', title: '生成媒体', employeeId: 'employee-a', employeeName: '员工', input: '', output: '', dependsOn: [], needsConfirm: false, state: 'running' }],
      arrangementExecution: { activeRunId: 'run-1', status: 'running', updatedAt: 1,
        nodes: [{ nodeId: 'image', status: 'running', finalFiles: [] }],
        media: [{ nodeId: 'image', nodeRunId: 'run-1', kind: 'video', operation: 'text-to-video', inputs: [], pendingActions: [],
          phase: 'tracking', jobId: 'job-1', outputs: [{ artifactId: 'video-1', status: 'pending' }] }] } };
    const html = renderDetail(flow);
    assert.match(html, /供应商正在生成媒体/);
    assert.doesNotMatch(html, />50%<\/b>/);
    assert.match(html, /media-waiting/);
    assert.match(html, /当前：供应商正在生成媒体/);
  });

  it('keeps the failed-node retry visible alongside running peers and saved media', () => {
    const flow: WorkItem = { ...work, kind: 'flow', status: 'running',
      workType: { state: 'resolved', kind: 'arrangement' },
      steps: ['failed', 'peer'].map(id => ({ id, title: id, employeeId: 'employee-a', employeeName: '员工',
        input: '', output: '', dependsOn: [], needsConfirm: false, state: id === 'failed' ? 'failed' : 'running' })),
      arrangementExecution: { activeRunId: 'parent', status: 'running', updatedAt: 1,
        nodes: [{ nodeId: 'failed', status: 'failed', finalFiles: [] }, { nodeId: 'peer', status: 'running', finalFiles: [] }],
        media: [{ nodeId: 'peer', nodeRunId: 'run-1', kind: 'image', operation: 'generate', inputs: [], pendingActions: [],
          phase: 'ready', jobId: 'job-1', outputs: [{ artifactId: 'asset-1', status: 'saved' }] }] } };
    const html = renderDetail(flow);
    assert.equal((html.match(/aria-label="重试此节点：failed"/g) ?? []).length, 1);
    assert.ok(html.indexOf('ent-failed-node-actions') < html.indexOf('aria-label="工作对话"'));
    assert.doesNotMatch(html, /重试此节点：peer/);
    assert.doesNotMatch(html, /编排媒体成果/);
    assert.match(html, /进行中/);
  });

  it('offers accepted node documents while parallel arrangement nodes are still running', () => {
    const flow = { ...work, kind: 'flow' as const, status: 'running' as const,
      workType: { state: 'resolved' as const, kind: 'arrangement' as const },
      deliverables: [{ id: 'node-a:report', name: 'report.docx', path: 'C:\\work\\report.docx', note: '节点最终交付物 · A',
        nodeId: 'node-a', nodeTitle: 'A', deliverableId: 'report', format: 'docx' }],
      arrangementExecution: { activeRunId: 'run', status: 'running' as const, updatedAt: 1,
        nodes: [{ nodeId: 'node-a', status: 'completed' as const, finalFiles: [{ id: 'report', path: 'report.docx', format: 'docx', size: 5,
          sha256: 'a'.repeat(64), nodeRunId: 'node-run-a', validatedAt: 1, snapshot: { sha256: 'a'.repeat(64), size: 5, source: 'confirmed' as const } }] },
        { nodeId: 'node-b', status: 'running' as const, finalFiles: [] }] } };
    const html = renderDetail(flow);
    assert.match(html, /aria-label="预览文档：report\.docx"/);
    assert.match(html, /复制路径/);
  });
});
