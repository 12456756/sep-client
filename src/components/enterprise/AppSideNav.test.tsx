import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compileFunction } from 'node:vm';
import * as icons from 'lucide-react';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as ts from 'typescript';

const dependencies: Record<string, unknown> = {
  'lucide-react': icons,
  react: React,
  'react/jsx-runtime': jsxRuntime,
  './EmployeeFace': { EmployeeFace: () => React.createElement('span', { className: 'ent-face' }) },
  './IconHint': { IconHint: ({ label, children }: { label: string; children: React.ReactElement }) => React.createElement('span', { 'data-hint': label }, children) },
  './icon-navigation.css': {},
};
const filename = fileURLToPath(new URL('./AppSideNav.tsx', import.meta.url));
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
const { AppSideNav } = pageModule.exports as typeof import('./AppSideNav');

function render(current: 'home' | 'arrange' | 'records' | 'work' = 'home', needsMeCount = 0): string {
  const previousReact = Reflect.get(globalThis, 'React');
  Reflect.set(globalThis, 'React', React);
  try {
    return renderToStaticMarkup(React.createElement(AppSideNav, {
      enterpriseName: '龙硅科技', enterpriseMark: '龙', enterpriseLogo: null,
      current, needsMeCount, canManage: false, userName: '测试用户',
      onNavigate: () => undefined, onOpenSettings: () => undefined, onLogout: () => undefined,
    }));
  } finally {
    if (previousReact === undefined) Reflect.deleteProperty(globalThis, 'React');
    else Reflect.set(globalThis, 'React', previousReact);
  }
}

test('renders icon-only company branding with one unified work entry', () => {
  const html = render('home', 2);
  assert.match(html, /role="img" aria-label="龙硅科技"/);
  assert.match(html, /<svg[^>]*aria-hidden="true"/);
  assert.doesNotMatch(html, /<strong[^>]*>龙硅科技<\/strong>/);
  assert.equal((html.match(/aria-label="工作，2 项待处理"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /aria-label="安排工作|aria-label="工作记录/);
});

test('keeps the unified work entry active for existing work routes', () => {
  for (const route of ['arrange', 'records', 'work'] as const) {
    const html = render(route, 2);
    assert.match(html, /aria-label="工作，2 项待处理" aria-current="page"/);
  }
});
