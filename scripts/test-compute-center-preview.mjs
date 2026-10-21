/* global window, document, NodeFilter, getComputedStyle */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const base = process.env.SEP_PREVIEW_URL ?? 'http://127.0.0.1:5174'
const output = process.env.SEP_PREVIEW_OUTPUT_DIR ?? join(process.cwd(), 'output', 'playwright', 'compute-center')
const executablePath = [process.env.SEP_PREVIEW_BROWSER, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/usr/bin/chromium'].filter(Boolean).find(existsSync)
assert.ok(executablePath, 'Set SEP_PREVIEW_BROWSER to an installed Chromium browser')
const originalEntry = await (await fetch(`${base}/main.tsx`)).text()
const imports = originalEntry.slice(0, originalEntry.indexOf('import App from'))
assert.ok(imports.includes('ReactDOM'), 'Vite renderer entry must include ReactDOM imports')
const browser = await chromium.launch({ executablePath, headless: true })
mkdirSync(output, { recursive: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  // The real page and hook run against isolated IPC fixtures; the application has no mock route.
  await page.route(/\/main\.tsx(?:\?.*)?$/, route => route.fulfill({ contentType: 'text/javascript', body: `${imports}
    import { ComputeCenterPage } from '/pages/enterprise/ComputeCenterPage.tsx';
    import { AppSideNav } from '/components/enterprise/AppSideNav.tsx';
    import { AppTopBar } from '/components/enterprise/AppTopBar.tsx';
    import { Bell, Command, Download, LayoutGrid, Moon, Network } from '/@fs${join(process.cwd(), 'node_modules/.vite/deps/lucide-react.js')}';
    import '/index.css'; import '/styles/enterprise.css'; import '/styles/compute-center.css';
    const h = React.createElement;
    function Shell() {
      const [collapsed, setCollapsed] = React.useState(false);
      return h('div', {className:'ent-shell'},
        h(AppSideNav, {enterpriseName:'常州数易网络科技有限公司', enterpriseMark:'常', current:'compute-center', needsMeCount:0, canManage:false, userName:'测试成员', collapsed, onToggleCollapse:() => setCollapsed(!collapsed), onNavigate:() => {}, onOpenSettings:() => {}, onLogout:() => {}}),
        h('div', {className:'ent-shell-main'},
          h(AppTopBar, {title:'算力中心', subtitle:'企业额度、个人钱包与消费情况', actions:h('div', {className:'ent-top-actions-group'},
            h('div', {className:'ent-view-switch'}, h('button', {className:'active'}, h(LayoutGrid, {size:14}), '个人'), h('button', null, h(Network, {size:14}), '企业')),
            h('button', {className:'ent-top-command', title:'打开命令入口'}, h(Command, {size:14}), h('span', null, '⌘K')),
            h('button', {className:'ent-top-icon', title:'切换主题'}, h(Moon, {size:16})),
            h('button', {className:'ent-top-command', title:'客户端更新'}, h(Download, {size:14}), h('span', null, '客户端更新')),
            h('button', {className:'ent-top-icon', title:'通知中心'}, h(Bell, {size:16}))) }),
          h('div', {className:'ent-scroll'}, h(ComputeCenterPage))));
    }
    ReactDOM.createRoot(document.getElementById('root')).render(h(React.StrictMode, null, h(Shell)));` }))
  await page.addInitScript(() => {
    const fixture = window.computeFixture = { usageCalls: [], walletCalls: [], breakdownCalls: [], failUsage: false, failWallet: false, failOverview: false, shrink: false }
    const ok = data => ({ success: true, data })
    const fail = () => ({ success: false, error: { message: '测试网络故障' } })
    const breakdown = days => ({ rangeDays: days, totalCNY: days === 7 ? '7.0000' : days === 90 ? '90.0000' : '30.0000', callCount: 45, inputTokens: 10000, outputTokens: 2400, deltaPct: 20,
      trend: [{ date: '2026-10-10', costCNY: '0.12' }, { date: '2026-10-16', costCNY: '0.30' }],
      byModel: [{ key: 'gpt-image-2', label: 'gpt-image-2', costCNY: '20.0000', callCount: 10, pct: 66.7 }, { key: 'media-real', label: 'media-real', costCNY: '10.0000', callCount: 35, pct: 33.3 }],
      byEmployee: [{ key: 'e1', label: '商品视觉员工', costCNY: '30.0000', callCount: 45, pct: 100 }], byMember: [], byDepartment: [] })
    window.electronAPI = {
      platform: 'darwin', windowChrome: { height: 44, rightInset: 0 },
      getComputeCenterOverview: async () => fixture.failOverview ? fail() : ok({ allowance: { userId: 'u1', name: '成员', email: 'test@example.com', limitCNY: '200.00', period: 'MONTH', enabled: true, usedCNY: '30.00', remainingCNY: '170.00', topUpRemainingCNY: '50.00', totalRemainingCNY: '170.00', usedPct: 15 }, wallet: { balanceCNY: '20.00', totalDepositCNY: '50.00', totalConsumeCNY: '30.00' }, breakdown: breakdown(30) }),
      getComputeUsageBreakdown: async days => { fixture.breakdownCalls.push(days); await new Promise(resolve => setTimeout(resolve, days === 7 ? 200 : 20)); return ok(breakdown(days)) },
      getComputeUsageRecords: async query => {
        fixture.usageCalls.push({ ...query })
        await new Promise(resolve => setTimeout(resolve, 30))
        if (fixture.failUsage) return fail()
        const total = fixture.shrink ? 5 : query.startDate ? 3 : 45
        const start = (query.page - 1) * query.pageSize
        return ok({ ...query, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)), records: Array.from({ length: Math.max(0, Math.min(query.pageSize, total - start)) }, (_, i) => ({ id: `usage-${start + i + 1}`, createdAt: '2026-10-16T08:00:00Z', memberName: '测试成员', employeeName: '商品视觉员工', modelId: i % 2 ? 'media-real' : 'gpt-image-2', inputTokens: 0, outputTokens: 0, costCNY: '0.0042', creditPaidCNY: '0.0042', memberWalletPaidCNY: '0', walletPaidCNY: '0', personalPaidCNY: '0', unpaidCNY: '0' })) })
      },
      getPersonalWalletTransactions: async query => {
        fixture.walletCalls.push({ ...query })
        if (fixture.failWallet) return fail()
        const total = 21, start = (query.page - 1) * query.pageSize
        return ok({ ...query, total, totalPages: Math.ceil(total / query.pageSize), records: Array.from({ length: Math.min(query.pageSize, total - start) }, (_, i) => ({ id: `wallet-${start + i + 1}`, type: 'CONSUME', amountCNY: '-0.0042', balanceAfterCNY: '20.00', description: '商品图生成', createdAt: '2026-10-16T08:00:00Z' })) })
      },
    }
  })
  await page.goto(base)
  try {
    await page.getByRole('heading', { name: '用量分析', exact: true }).waitFor({ timeout: 10000 })
  } catch (error) {
    throw new Error(`Compute center preview did not render. Browser errors: ${errors.join(' | ') || 'none'}`, { cause: error })
  }
  async function assertTextLayout(label) {
    const problems = await page.evaluate(() => {
      const problems = []
      for (const root of document.querySelectorAll('.ent-side-brand strong, .ent-top-head, .compute-page')) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) {
          const node = walker.currentNode
          const parent = node.parentElement
          if (!node.textContent.trim() || !parent || parent.closest('svg, select, option')) continue
          const range = document.createRange()
          range.selectNodeContents(node)
          for (const rect of range.getClientRects()) {
            if (!rect.width || !rect.height) continue
            const box = parent.getBoundingClientRect()
            if (rect.left < box.left - 1 || rect.right > box.right + 1 || rect.top < box.top - 2 || rect.bottom > box.bottom + 2) problems.push(`${parent.className || parent.tagName}: ${node.textContent.trim()} exceeds its text container`)
            for (let ancestor = parent; ancestor && !ancestor.matches('.ent-scroll, .compute-table-wrap'); ancestor = ancestor.parentElement) {
              const style = getComputedStyle(ancestor)
              const boundary = ancestor.getBoundingClientRect()
              if (['hidden', 'clip'].includes(style.overflowX) && (rect.left < boundary.left - 1 || rect.right > boundary.right + 1)) problems.push(`${node.textContent.trim()} clipped by ${ancestor.className}`)
            }
          }
        }
      }
      const analysis = document.querySelector('.compute-analysis')
      if (analysis) {
        const boundary = analysis.getBoundingClientRect()
        for (const element of analysis.querySelectorAll('h3, .compute-usage-metrics dt, .compute-usage-metrics dd')) {
          const box = element.getBoundingClientRect()
          if (box.left - boundary.left < 14 || boundary.right - box.right < 14) problems.push(`${element.textContent} lacks analysis inset`)
        }
      }
      return [...new Set(problems)]
    })
    assert.deepEqual(problems, [], `${label}: text must fit without clipping or touching panel edges`)
  }
  await assertTextLayout('full desktop shell')
  await page.getByRole('region', { name: '模型使用情况' }).getByText('gpt-image-2').waitFor()
  assert.equal(await page.getByRole('tab', { name: '部门', exact: true }).count(), 0)
  await page.getByRole('button', { name: '7 天', exact: true }).click()
  await page.getByRole('button', { name: '90 天', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.compute-summary-item:last-child strong')?.textContent === '¥90.00')
  await page.waitForTimeout(250)
  assert.equal(await page.locator('.compute-summary-item:last-child strong').textContent(), '¥90.00', 'stale 7-day result cannot replace 90-day result')
  await page.getByRole('button', { name: '30 天', exact: true }).click()
  await page.screenshot({ path: join(output, 'overview-desktop.png'), fullPage: true })
  await page.evaluate(() => { window.computeFixture.failUsage = true })
  await page.getByRole('tab', { name: '消费明细', exact: true }).click()
  await page.getByRole('alert').getByText('测试网络故障', { exact: true }).waitFor()
  const initialUsageCalls = await page.evaluate(() => window.computeFixture.usageCalls.length)
  await page.waitForTimeout(250)
  assert.equal(await page.evaluate(() => window.computeFixture.usageCalls.length), initialUsageCalls, 'initial usage failure must not retry automatically')
  await page.evaluate(() => { window.computeFixture.failUsage = false })
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await page.getByText('共 45 条', { exact: true }).waitFor()
  await page.getByRole('button', { name: '消费明细下一页', exact: true }).click()
  await page.getByText('第 2 / 3 页', { exact: true }).waitFor()
  await page.getByRole('button', { name: '刷新消费明细', exact: true }).click()
  await page.waitForFunction(() => window.computeFixture.usageCalls.at(-1)?.page === 2 && document.querySelector('[aria-label="消费明细"]')?.getAttribute('aria-busy') === 'false')
  await page.getByRole('button', { name: '详情', exact: true }).first().click()
  await page.getByRole('dialog', { name: '消费记录详情' }).getByText('usage-21', { exact: true }).waitFor()
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('dialog').count(), 0)
  await page.getByLabel('消费明细每页条数', { exact: true }).selectOption('10')
  await page.getByText('第 1 / 5 页', { exact: true }).waitFor()
  await page.getByLabel('开始日期', { exact: true }).fill('2026-10-01')
  await page.getByLabel('结束日期', { exact: true }).fill('2026-10-16')
  await page.getByRole('button', { name: '筛选', exact: true }).click()
  await page.getByText('共 3 条', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.computeFixture.usageCalls.at(-1).startDate), '2026-10-01')
  await page.getByRole('button', { name: '重置', exact: true }).click()
  await page.getByText('共 45 条', { exact: true }).waitFor()
  await page.evaluate(() => { window.computeFixture.failUsage = true })
  await page.getByRole('button', { name: '刷新消费明细', exact: true }).click()
  await page.getByRole('alert').getByText('测试网络故障', { exact: true }).waitFor()
  const calls = await page.evaluate(() => window.computeFixture.usageCalls.length)
  await page.waitForTimeout(250)
  assert.equal(await page.evaluate(() => window.computeFixture.usageCalls.length), calls, 'a failed request must not retry automatically')
  assert.equal(await page.locator('.compute-table tbody tr').count(), 10, 'failed refresh retains rows')
  await page.evaluate(() => { window.computeFixture.failUsage = false })
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await page.getByRole('alert').waitFor({ state: 'detached' })
  await page.getByRole('button', { name: '消费明细末页', exact: true }).click()
  await page.getByText('第 5 / 5 页', { exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelector('[aria-label="消费明细"]')?.getAttribute('aria-busy') === 'false')
  await page.evaluate(() => { window.computeFixture.shrink = true })
  await page.getByRole('button', { name: '刷新消费明细', exact: true }).click()
  await page.getByText('共 5 条', { exact: true }).waitFor()
  await page.getByText('第 1 / 1 页', { exact: true }).waitFor()
  await page.screenshot({ path: join(output, 'usage-desktop.png'), fullPage: true })
  await page.evaluate(() => { window.computeFixture.failWallet = true })
  await page.getByRole('tab', { name: '个人钱包', exact: true }).click()
  await page.getByRole('alert').getByText('测试网络故障', { exact: true }).waitFor()
  const initialWalletCalls = await page.evaluate(() => window.computeFixture.walletCalls.length)
  await page.waitForTimeout(250)
  assert.equal(await page.evaluate(() => window.computeFixture.walletCalls.length), initialWalletCalls, 'initial wallet failure must not retry automatically')
  await page.evaluate(() => { window.computeFixture.failWallet = false })
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await page.getByText('共 21 条', { exact: true }).waitFor()
  await page.getByRole('button', { name: '钱包流水下一页', exact: true }).click()
  await page.getByText('第 2 / 2 页', { exact: true }).waitFor()
  await page.getByRole('button', { name: '详情', exact: true }).click()
  await page.getByRole('dialog').getByText('wallet-21', { exact: true }).waitFor()
  await page.keyboard.press('Escape')
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 })
    for (const tab of ['概览', '消费明细', '个人钱包']) {
      await page.getByRole('tab', { name: tab, exact: true }).click()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${tab} must not overflow at ${width}px`)
      await page.screenshot({ path: join(output, `${tab === '概览' ? 'overview' : tab === '消费明细' ? 'usage' : 'wallet'}-${width}.png`), fullPage: true })
    }
  }
  assert.deepEqual(errors, [])
  console.log('PASS: real compute page with isolated IPC fixtures; models, range races, usage/wallet pagination, refresh, details, filters, retry, shrinking totals and 3 viewport layouts')
} finally {
  await browser.close()
}
