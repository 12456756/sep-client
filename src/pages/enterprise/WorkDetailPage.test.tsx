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
import { FeedbackProvider } from '../../components/feedback/FeedbackProvider';
import { useOperationFeedback } from '../../components/feedback/use-operation-feedback';
import * as atoms from '../../components/enterprise/atoms';
import { EmployeeFace } from '../../components/enterprise/EmployeeFace';
import { ArrangementSteps } from '../../components/enterprise/arrange/ArrangementSteps';
import { ArrangementTranscriptView } from '../../components/enterprise/arrange/ArrangementTranscript';
import { buildArrangementTranscript } from '../../features/enterprise/arrangement-transcript';
import { MediaArtifactsPanel } from '../../components/workspace/MediaArtifactsPanel';
import { ArrangementMediaPanel } from '../../components/workspace/ArrangementMediaPanel';
import { DocumentPreviewButton } from '../../components/workspace/DocumentPreviewButton';
import { useResultFilePreview } from '../../features/enterprise/use-result-file-preview';
import type { WorkItem } from '../../features/enterprise/types';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import * as workProcess from '../../features/enterprise/work-process';
import * as vocabulary from '../../features/enterprise/vocabulary';
import * as generalAssistant from '../../features/enterprise/general-assistant';

const cardFilename = fileURLToPath(new URL('../../components/workspace/ResultFileCard.tsx', import.meta.url));
const cardSource = ts.transpileModule(readFileSync(cardFilename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const cardModule = { exports: {} };
const cardDependencies: Record<string, unknown> = { react: React, 'react/jsx-runtime': jsxRuntime, 'lucide-react': icons,
  '../../features/enterprise/use-result-file-preview': { useResultFilePreview }, './DocumentPreviewButton': { DocumentPreviewButton }, './result-file-card.css': {} };
compileFunction(cardSource, ['require', 'exports', 'module'], { filename: cardFilename })((id: string) => { assert.ok(Object.hasOwn(cardDependencies, id), `unexpected card import: ${id}`); return cardDependencies[id] }, cardModule.exports, cardModule);
const { ResultFileCard, ResultFileMedia, resultFileRequest } = cardModule.exports as typeof import('../../components/workspace/ResultFileCard');

// Isolate CSS drawers and the browser-only motion hook; render the real page and media panel.
const dependencies: Record<string, unknown> = {
  'lucide-react': icons,
  react: React,
  'react/jsx-runtime': jsxRuntime,
  '../../components/enterprise/atoms': atoms,
  '../../components/enterprise/EmployeeFace': { EmployeeFace },
  '../../components/enterprise/arrange/ArrangementSteps': { ArrangementSteps },
  '../../components/enterprise/arrange/ArrangementTranscript': { ArrangementTranscript: (props: React.ComponentProps<typeof ArrangementTranscriptView>) =>
    React.createElement(ArrangementTranscriptView, { ...props, nodes: buildArrangementTranscript(props.work.steps, []) }) },
  '../../components/enterprise/WorkPlanDrawer': { WorkPlanDrawer: () => null },
  '../../components/enterprise/WorkTalkDrawer': { WorkConversation: () => null, WorkTalkDrawer: () => null },
  '../../components/enterprise/IconHint': { IconHint: ({ children, label }: { children: React.ReactNode; label: string }) => React.createElement('span', { 'data-hint': label }, children) },
  '../../components/enterprise/WorkIndicators': { WorkStatusIcon: () => null, WorkTypeTag: () => null },
  '../../components/workspace/MediaArtifactsPanel': { MediaArtifactsPanel },
  '../../components/workspace/ArrangementMediaPanel': { ArrangementMediaPanel },
  '../../components/workspace/DocumentPreviewButton': { DocumentPreviewButton },
  '../../components/workspace/ResultFileCard': { ResultFileCard },
  '../../components/feedback/use-operation-feedback': { useOperationFeedback },
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

function renderDetail(item: WorkItem, overrides: Partial<EnterpriseWorkspace> = {}): string {
  const workspace = { works: [item], employees: [], myEmployees: [], busy: false, canGoBack: false, ...overrides } as unknown as EnterpriseWorkspace;
  const previousReact = Reflect.get(globalThis, 'React');
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React });
  try {
    return renderToStaticMarkup(React.createElement(FeedbackProvider, null, React.createElement(WorkDetailPage, { workspace, workId: item.id })));
  } finally {
    if (previousReact === undefined) Reflect.deleteProperty(globalThis, 'React');
    else Object.defineProperty(globalThis, 'React', { configurable: true, value: previousReact });
  }
}

it('renders actual image and video elements with direct media interaction', () => {
  const image = renderToStaticMarkup(React.createElement(ResultFileMedia, { preview: { url: 'sep-result://preview/image', mime: 'image/png', kind: 'image' }, name: 'mug.png', onZoom() {}, onError() {} }));
  assert.match(image, /<img[^>]+src="sep-result:\/\/preview\/image"/);
  assert.match(image, /aria-label="放大查看 mug.png"/);
  const video = renderToStaticMarkup(React.createElement(ResultFileMedia, { preview: { url: 'sep-result://preview/video', mime: 'video/mp4', kind: 'video' }, name: 'mug.mp4', onZoom() {}, onError() {} }));
  assert.match(video, /<video[^>]+controls=""[^>]+preload="auto"[^>]+playsinline=""/);
  assert.doesNotMatch(image + video, /预览图片|预览视频|复制路径/);
});

it('associates each final media file with its original delivery identity only once', () => {
  const file = { id: 'node-a:mug', name: 'mug.png', path: '/work/mug.png', note: '', nodeId: 'node-a', deliverableId: 'mug', format: 'png', sourceArtifact: { kind: 'image' as const, artifactId: 'asset-a', sha256: 'a'.repeat(64) } };
  assert.deepEqual(resultFileRequest('task-a', file), { taskId: 'task-a', nodeId: 'node-a', deliverableId: 'mug' });
  const html = renderDetail({ ...work, kind: 'flow', deliverables: [file] });
  assert.equal((html.match(/aria-label="产物 mug.png"/g) ?? []).length, 1);
  assert.match(html, /打开 mug.png 所在文件夹/);
  assert.doesNotMatch(html, /正在读取媒体|预览图片|复制路径/);
});

it('keeps pending media visible but removes delivery status after final acceptance including historical files', () => {
  const previousReact = Reflect.get(globalThis, 'React');
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React });
  try {
  const media = [{ nodeId: 'node-a', nodeRunId: 'run-a', kind: 'image' as const, operation: 'generate' as const, phase: 'ready' as const, jobId: 'job-a', outputs: [{ artifactId: 'asset-a', status: 'saved' as const }], inputs: [], pendingActions: [] }];
  const pending = renderToStaticMarkup(React.createElement(ArrangementMediaPanel, { media, deliverables: [] }));
  assert.match(pending, /正在整理交付/);
  const done = renderToStaticMarkup(React.createElement(ArrangementMediaPanel, { media, deliverables: [{ id: 'final', nodeId: 'node-a', name: 'mug.png', path: '/work/mug.png', note: '' }] }));
  assert.equal(done, '');
  assert.equal(renderToStaticMarkup(React.createElement(ArrangementMediaPanel, { media: [{ ...media[0], outputs: [] }], deliverables: [] })), '');
  } finally {
    if (previousReact === undefined) Reflect.deleteProperty(globalThis, 'React');
    else Object.defineProperty(globalThis, 'React', { configurable: true, value: previousReact });
  }
});

it('renders a media question and an empty reply form instead of an approval action', () => {
  const html = renderDetail({ ...work, kind: 'flow', status: 'waiting-user',
    arrangementExecution: { activeRunId: null, status: 'waiting-user', updatedAt: 3,
      nodes: [{ nodeId: 'video', status: 'interrupted', finalFiles: [], inputRequest: {
        requestId: 'question-a', kind: 'media-spec', question: '需要多长的视频？', requirements: [{ id: 'video', specRevision: 1 }],
      } }] } })
  assert.match(html, /需要多长的视频？/)
  assert.match(html, /<textarea[^>]*><\/textarea>/)
  assert.match(html, /提交补充并继续/)
  assert.doesNotMatch(html, /确认，继续/)
})

it('shows each missing employee alongside parallel questions and application status', () => {
  const execution: NonNullable<WorkItem['arrangementExecution']> = { activeRunId: null, status: 'waiting-user', updatedAt: 3,
    nodes: [{ nodeId: 'missing', status: 'waiting-employee', finalFiles: [], employeeReplacement: {
      nodeId: 'missing', originalSubscriptionId: 'old', reason: '原员工已不可用', status: 'waiting', updatedAt: 3,
      candidates: [{ stepId: 'missing', employeeId: 'new', subscriptionId: null, source: 'platform', name: '市场分析员工',
        rationale: '具备市场分析技能', canExecute: false, canApply: true }],
    } }, { nodeId: 'video', status: 'interrupted', finalFiles: [], inputRequest: {
      requestId: 'question-a', kind: 'media-spec', question: '需要多长的视频？', requirements: [],
    } }] }
  const item: WorkItem = { ...work, kind: 'flow', status: 'waiting-user', arrangementExecution: execution }
  const html = renderDetail(item)
  assert.match(html, /市场分析员工/)
  assert.match(html, /申请员工/)
  assert.match(html, /重新查找/)
  assert.match(html, /提交补充并继续/)
  execution.nodes[0]!.employeeReplacement!.accessRequests = [{ requestId: 'req', stepId: 'missing', employeeId: 'new', subscriptionId: null,
    source: 'platform', name: '市场分析员工', status: 'PENDING', requestedCapabilities: [], createdAt: '2026-11-02', updatedAt: '2026-11-02' }]
  assert.match(renderDetail(item), /已申请，等待审批/)
  assert.doesNotMatch(renderDetail(item), />申请员工</)
})

it('keeps parallel questions available only while the arrangement can accept replies', () => {
  const inputRequest = { requestId: 'question-a', kind: 'media-spec' as const, question: '需要多长的视频？', requirements: [] }
  const pending = { ...work, kind: 'flow' as const, status: 'running' as const,
    arrangementExecution: { activeRunId: 'run', status: 'running' as const, updatedAt: 3,
      nodes: [{ nodeId: 'video', status: 'interrupted' as const, finalFiles: [], inputRequest },
        { nodeId: 'peer', status: 'running' as const, finalFiles: [] }] } }
  assert.match(renderDetail(pending), /提交补充并继续/)
  for (const status of ['paused', 'failed', 'completed'] as const) {
    const html = renderDetail({ ...pending, status })
    assert.doesNotMatch(html, /提交补充并继续|<textarea/)
    if (status === 'paused') assert.match(html, /这项工作已终止/)
    if (status === 'failed') assert.match(html, /任务执行失败/)
  }
  for (const status of ['stopped', 'interrupted', 'completed', 'failed'] as const) {
    const html = renderDetail({ ...pending, arrangementExecution: { ...pending.arrangementExecution, status } })
    assert.doesNotMatch(html, /提交补充并继续|<textarea/)
  }
  const stoppedNode = renderDetail({ ...pending, arrangementExecution: { ...pending.arrangementExecution,
    nodes: [{ ...pending.arrangementExecution.nodes[0]!, status: 'stopped' }] } })
  assert.doesNotMatch(stoppedNode, /提交补充并继续|<textarea/)
  assert.deepEqual(pending.arrangementExecution.nodes[0]?.inputRequest, inputRequest)
})

// Check handlers and effect ownership; native focus behavior still needs window verification.
function mountDetail(item: WorkItem = work, overrides: Partial<EnterpriseWorkspace> = {}) {
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
    (id: string) => id === 'react' ? hooks : id === '../../components/feedback/use-operation-feedback'
      ? { useOperationFeedback: () => ({ capture: () => ({ show() {} }) }) } : requireStub(id), loaded.exports, loaded,
  );
  const Page = (loaded.exports as typeof import('./WorkDetailPage')).WorkDetailPage;
  let navigated = false;
  const workspace = { works: [item], employees: [], myEmployees: [], busy: false,
    navigate: () => { navigated = true; }, ...overrides } as unknown as EnterpriseWorkspace;
  const root = Page({ workspace, workId: item.id });
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

describe('compact failure notice', () => {
  it('uses the same reason and icon-only retry for conversation and flow failures', () => {
    for (const kind of ['conversation', 'flow'] as const) {
      const html = renderDetail({ ...work, kind, status: 'failed', stopReason: '视频服务暂时不可用' });
      assert.equal((html.match(/aria-label="任务失败"/g) ?? []).length, 1);
      assert.match(html, /class="ent-failure-reason" title="视频服务暂时不可用">视频服务暂时不可用<\/p>/);
      assert.match(html, /data-hint="重试任务"/);
      assert.match(html, /<button[^>]*aria-label="重试任务"[^>]*><svg/);
      assert.doesNotMatch(html, /重新试一次|中断原因：/);
    }
  });

  it('retains the complete long reason and falls back to the next user action', () => {
    const reason = '视频提交超时，'.repeat(80);
    assert.match(renderDetail({ ...work, status: 'failed', stopReason: reason }), new RegExp(`title="${reason}"`));
    assert.match(renderDetail({ ...work, status: 'failed', nextUserAction: '请检查视频服务连接' }), /class="ent-failure-reason"[^>]*>请检查视频服务连接<\/p>/);
    assert.match(renderDetail({ ...work, status: 'failed' }), /class="ent-failure-reason"[^>]*>任务执行失败<\/p>/);
  });

  it('combines failed nodes into one frame without a duplicate task-failure banner', () => {
    const flow: WorkItem = { ...work, kind: 'flow', status: 'failed', stopReason: '供应商连接超时',
      steps: ['video', 'audio'].map(id => ({ id, title: id, employeeId: 'employee-a', employeeName: '员工',
        input: '', output: '', dependsOn: [], needsConfirm: false, state: 'failed' })),
      arrangementExecution: { activeRunId: null, status: 'failed', updatedAt: 1,
        nodes: ['video', 'audio'].map(nodeId => ({ nodeId, status: 'failed', finalFiles: [] })) } };
    const html = renderDetail(flow);
    assert.equal((html.match(/class="ent-flow-act danger ent-failure-notice/g) ?? []).length, 1);
    assert.doesNotMatch(html, /aria-label="任务失败"|有节点执行失败|可单独重试失败节点|>重试 video</);
    for (const id of ['video', 'audio']) {
      assert.match(html, new RegExp(`title="${id}：供应商连接超时"`));
      assert.match(html, new RegExp(`aria-label="重试此节点：${id}"`));
      assert.match(html, new RegExp(`data-hint="重试任务：${id}"`));
    }
  });

  it('preserves task and node retry targets and disables retry while busy', () => {
    const calls: unknown[][] = [];
    const retryWork = async (...args: unknown[]) => { calls.push(args); };
    for (const kind of ['conversation', 'flow'] as const) {
      const item: WorkItem = { ...work, kind, status: 'failed', arrangementExecution: kind === 'flow'
        ? { activeRunId: null, status: 'failed', updatedAt: 1, nodes: [{ nodeId: 'video', status: 'failed', finalFiles: [] }] }
        : undefined };
      const mounted = mountDetail(item, { retryWork });
      const actions = mounted.find(element => typeof element.type === 'function' && element.type.name === (kind === 'flow' ? 'FailedNodeActions' : 'NeedsYou'));
      const buttons: React.ReactElement<Record<string, unknown>>[] = [];
      const visit = (nodes: React.ReactNode) => React.Children.forEach(nodes, child => {
        if (!React.isValidElement<Record<string, unknown>>(child)) return;
        if (typeof child.type === 'function' && ['NeedsYou', 'FailedNodeActions', 'FailureRetryRow'].includes(child.type.name)) {
          visit((child.type as (props: unknown) => React.ReactNode)(child.props));
          return;
        }
        if (child.type === 'button') buttons.push(child);
        visit(child.props.children as React.ReactNode);
      });
      visit(actions);
      assert.equal(buttons.length, 1);
      (buttons[0]!.props.onClick as () => void)();
      assert.deepEqual(calls.at(-1), kind === 'flow' ? [work.id, 'video'] : [work.id]);
      mounted.unmount();
      assert.match(renderDetail(item, { busy: true }), /aria-label="重试(?:任务|此节点：video)"[^>]*disabled=""/);
    }
  });
});

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
      assert.equal(media.props.presentation, 'results');
      (page.find(element => element.props['aria-label'] === '关闭详情面板').props.onClick as () => void)();
      page.render();
      assert.equal(page.dialog.open, false);
    }
    page.unmount();
  });

  it('passes registered output identities to result cards for conversations and arrangements', () => {
    const conversationFile = { id: `${work.id}-file-0`, name: 'report.zip', path: 'C:\\work\\report.zip', note: '' };
    const conversationPage = mountDetail({ ...work, deliverables: [conversationFile] });
    const conversationCard = conversationPage.find(element => element.type === ResultFileCard);
    assert.equal(conversationCard.props.taskId, work.id);
    assert.equal(conversationCard.props.file, conversationFile);
    assert.equal(conversationCard.props.conversation, true);
    conversationPage.unmount();

    const arrangementFile = { id: 'node-a:report', name: 'report.docx', path: 'C:\\work\\report.docx', note: '', nodeId: 'node-a', deliverableId: 'report' };
    const arrangementPage = mountDetail({ ...work, kind: 'flow', deliverables: [arrangementFile] });
    const arrangementCard = arrangementPage.find(element => element.type === ResultFileCard);
    assert.equal(arrangementCard.props.taskId, work.id);
    assert.equal(arrangementCard.props.file, arrangementFile);
    assert.equal(arrangementCard.props.conversation, false);
    arrangementPage.unmount();
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
    assert.match(html, /aria-label="编排执行过程"/);
    assert.doesNotMatch(html, /查看工作过程|aria-label="工作对话"/);
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
    assert.doesNotMatch(html, /查看工作过程|aria-label="工作过程"|aria-label="工作对话"|补充说明/);
    assert.ok(html.indexOf('ent-failed-node-actions') < html.indexOf('aria-label="编排执行过程"'));
    assert.doesNotMatch(html, /重试此节点：peer/);
    assert.doesNotMatch(html, /编排媒体成果/);
    assert.match(html, /正在处理/);
  });

  it('offers previews for supported conversation documents without node delivery identities', () => {
    const html = renderDetail({ ...work, deliverables: ['docx', 'xlsx', 'pptx', 'pdf', 'md', 'txt', 'zip'].map((format, index) => ({
      id: `${work.id}-file-${index}`, name: `report.${format}`, path: `C:\\work\\report.${format}`, note: '对话成果', format,
    })) })
    for (const format of ['docx', 'xlsx', 'pptx', 'pdf', 'md', 'txt']) assert.match(html, new RegExp(`aria-label="预览文档：report\\.${format}"`))
    assert.doesNotMatch(html, /aria-label="预览文档：report\.zip"/)
    assert.match(html, /打开所在文件夹/)
    assert.doesNotMatch(html, /复制路径/)
  });

  it('keeps file results to the name and actions without notes or premature empty copy', () => {
    const html = renderDetail({ ...work, deliverables: [{ id: 'report', name: 'report.docx', path: 'C:\\work\\report.docx', note: '内部节点交付说明', format: 'docx' }] });
    assert.match(html, /report\.docx/);
    assert.doesNotMatch(html, /内部节点交付说明|暂无产出结果|员工还没有产出文件/);
  });

  it('shows one short empty state for an arrangement with no file or media results', () => {
    const flow = { ...work, kind: 'flow' as const, workType: { state: 'resolved' as const, kind: 'arrangement' as const },
      arrangementExecution: { activeRunId: null, status: 'completed' as const, nodes: [], updatedAt: 1, media: [] } };
    const html = renderDetail(flow);
    assert.match(html, /暂无产出结果/);
    assert.doesNotMatch(html, /员工还没有产出文件|尚无视频任务/);
  });

  it('offers accepted node documents while parallel arrangement nodes are still running', () => {
    const flow = { ...work, kind: 'flow' as const, status: 'running' as const,
      workType: { state: 'resolved' as const, kind: 'arrangement' as const },
      deliverables: [{ id: 'node-a:report', name: 'report.docx', path: 'C:\\work\\report.docx', note: '节点最终交付物 · A',
        category: 'final' as const, nodeId: 'node-a', nodeTitle: 'A', deliverableId: 'report', format: 'docx' }],
      arrangementExecution: { activeRunId: 'run', status: 'running' as const, updatedAt: 1,
        nodes: [{ nodeId: 'node-a', status: 'completed' as const, finalFiles: [{ id: 'report', path: 'report.docx', format: 'docx', size: 5,
          sha256: 'a'.repeat(64), nodeRunId: 'node-run-a', validatedAt: 1, snapshot: { sha256: 'a'.repeat(64), size: 5, source: 'confirmed' as const } }] },
        { nodeId: 'node-b', status: 'running' as const, finalFiles: [] }] } };
    const html = renderDetail(flow);
    assert.match(html, /最终产物/);
    assert.match(html, /aria-label="预览文档：report\.docx"/);
    assert.match(html, /打开所在文件夹/);
  });
});
