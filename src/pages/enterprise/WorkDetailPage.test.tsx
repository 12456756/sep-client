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
import { MediaArtifactsPanel } from '../../components/workspace/MediaArtifactsPanel';
import type { WorkItem } from '../../features/enterprise/types';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import * as workProcess from '../../features/enterprise/work-process';
import { usePrefersReducedMotion } from '../../features/enterprise/use-reduced-motion';
import * as vocabulary from '../../features/enterprise/vocabulary';

// Isolate the CSS-importing drawer modules, but render the real page and media panel.
const dependencies: Record<string, unknown> = {
  'lucide-react': icons,
  react: React,
  'react/jsx-runtime': jsxRuntime,
  '../../components/enterprise/atoms': atoms,
  '../../components/enterprise/EmployeeFace': { EmployeeFace },
  '../../components/enterprise/WorkPlanDrawer': { WorkPlanDrawer: () => null },
  '../../components/enterprise/WorkTalkDrawer': { WorkConversation: () => null, WorkTalkDrawer: () => null },
  '../../components/workspace/MediaArtifactsPanel': { MediaArtifactsPanel },
  '../../features/enterprise/work-process': workProcess,
  '../../features/enterprise/use-reduced-motion': { usePrefersReducedMotion },
  '../../features/enterprise/vocabulary': vocabulary,
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
  createdAt: 1, updatedAt: 2, participants: [], deliverables: [], timeline: [], messages: [], activities: [],
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

describe('WorkDetailPage media entry', () => {
  it('mounts the shared media panel exactly once on the actual conversation route', () => {
    const html = renderDetail(work);
    assert.equal((html.match(/aria-label="图片创作与成果"/g) ?? []).length, 1);
    assert.match(html, /正在读取图片能力/);
    assert.match(html, /产出结果/);
  });

  it('does not introduce conversation media operations into flow work', () => {
    assert.doesNotMatch(renderDetail({ ...work, kind: 'flow', workType: { state: 'resolved', kind: 'arrangement' } }), /aria-label="图片创作与成果"/);
  });
});
