import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { createServer } from 'vite'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

let vite, source, contract, utils, storage, queryClient
const realFetch = globalThis.fetch
const previousSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const batches = Array.from({ length: 9 }, (_, index) => ({ id: `b${index}`, batchNo: `YM-${index}`, traceCode: `TRACE-${index}`,
  herbName: '黄精', growerName: '种植组织', category: index % 2 ? 'root' : 'wholeHerb',
  stage: index % 2 ? 'warehousing' : 'planting', auditStatus: index < 7 ? 'pending' : 'approved',
  riskLevel: index % 2 ? 'low' : 'normal', updatedAt: `2026-10-0${index + 1} 00:30:00`, events: [] }))
beforeEach(async () => {
  const sessions = new Map(), local = new Map()
  for (const [key, values] of [['sessionStorage', sessions], ['localStorage', local]]) {
    Object.defineProperty(globalThis, key, { configurable: true, value: {
      getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k),
    } })
  }
  vite = await createServer({ cacheDir: 'node_modules/.vite-tests/dashboard', mode: 'development',
    // SSR 不执行浏览器订阅：只替换身份 Hook，统计 Hook 使用正式文件。
    plugins: [{ name: 'dashboard-auth-fixture', enforce: 'pre',
      resolveId(id, importer) {
        if (id === 'virtual:dashboard-auth-fixture'
          || (id === './useAuth' && importer?.replaceAll('\\', '/').endsWith('/src/hooks/useDashboardOverview.ts'))) {
          return '\0virtual:dashboard-auth-fixture'
        }
      },
      load(id) {
        if (id === '\0virtual:dashboard-auth-fixture') return 'export const authFixture = { current: {} }; export const useAuth = () => authFixture.current'
      },
    }],
    server: { middlewareMode: true, hmr: false, watch: null },
    define: { 'import.meta.env.VITE_AUTH_MODE': JSON.stringify('api'), 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api') },
    optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'silent' })
  contract = await vite.ssrLoadModule('/src/services/dashboardContract.ts')
  utils = await vite.ssrLoadModule('/src/utils/dashboard.ts')
  source = await vite.ssrLoadModule('/src/services/dashboardDataSource.ts')
  storage = await vite.ssrLoadModule('/src/utils/auth.ts')
  storage.advanceAuthRevision('user-A')
})
afterEach(async () => {
  queryClient?.clear(); queryClient = undefined
  await vite.close(); globalThis.fetch = realFetch
  if (previousSessionStorage) Object.defineProperty(globalThis, 'sessionStorage', previousSessionStorage); else delete globalThis.sessionStorage
  if (previousLocalStorage) Object.defineProperty(globalThis, 'localStorage', previousLocalStorage); else delete globalThis.localStorage
})
const overview = () => ({ ...utils.buildDemoDashboardOverview(batches, new Date('2026-10-06T00:00:00Z')), mode: 'api' })

test('离线统计来自全部现有批次，列表上限与零填充分布、上海时区排序正确，不修改输入', () => {
  const before = JSON.stringify(batches), result = utils.buildDemoDashboardOverview(batches)
  assert.deepEqual(result.summary, { totalBatches: 9, pendingAuditBatches: 7, riskBatches: 4, warehousingBatches: 4 })
  assert.equal(result.recentBatches.length, 6); assert.equal(result.pendingBatches.length, 5)
  assert.equal(result.recentBatches[0].id, 'b8')
  assert.equal(result.recentBatches[0].updatedAt, '2026-10-08T16:30:00.000Z')
  assert.match(utils.formatDashboardTime('2026-10-05T16:30:00Z'), /2026\/10\/06.*00:30/)
  assert.equal(JSON.stringify(batches), before)
  const empty = utils.buildDemoDashboardOverview([])
  assert.ok(Object.values(empty.summary).every((n) => n === 0))
  assert.ok(empty.stageDistribution.every((r) => r.count === 0))
  assert.deepEqual(contract.parseDashboardOverview(empty, 'demo'), empty)
})

test('契约按白名单返回，剔除私有字段与旧交易额，不接受模式混用', () => {
  const input = overview()
  assert.deepEqual(contract.parseDashboardOverview({ ...input, internal: 'secret', summary: { ...input.summary, transactionAmount: 999 },
    recentBatches: input.recentBatches.map((r) => ({ ...r, passwordHash: 'secret' })) }, 'api'), input)
  assert.throws(() => contract.parseDashboardOverview(input, 'demo'), { code: 'INVALID_RESPONSE' })
})

test('契约拒绝非法计数、分布缺失/重复/总数不一致、错误待办/日期/重复批次', () => {
  const data = overview()
  for (const input of [
    { ...data, summary: { ...data.summary, totalBatches: -1 } },
    { ...data, summary: { ...data.summary, riskBatches: 10 } },
    { ...data, stageDistribution: data.stageDistribution.slice(1) },
    { ...data, stageDistribution: data.stageDistribution.map((r) => ({ ...r, count: 1 })) },
    { ...data, categoryDistribution: data.categoryDistribution.map((r) => ({ ...r, category: 'root' })) },
    { ...data, pendingBatches: data.pendingBatches.map((r) => ({ ...r, auditStatus: 'approved' })) },
    { ...data, recentBatches: data.recentBatches.map((r) => ({ ...r, id: 'same' })) },
    { ...data, generatedAt: '2026-02-30T00:00:00Z' }, { ...data, generatedAt: '2026-10-06 00:00:00' },
  ]) assert.throws(() => contract.parseDashboardOverview(input, 'api'), { code: 'INVALID_RESPONSE' })
})

test('API 看板只有一个只读请求，携带 Cookie/取消信号，不拉批次详情或上传组织', async () => {
  const data = overview(); let calls = 0
  globalThis.fetch = async (url, options) => {
    calls++; assert.equal(url, '/api/dashboard/overview')
    assert.equal(options.method, 'GET'); assert.equal(options.body, undefined)
    assert.equal(options.credentials, 'include'); assert.equal(options.headers.Authorization, undefined); assert.ok(options.signal)
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
  }
  assert.deepEqual(await source.getDashboardOverview(), data); assert.equal(calls, 1)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(source.getDashboardOverview(controller.signal), { name: 'AbortError' }); assert.equal(calls, 1)
})

test('看板失败不伪造零值、不自动重试，切账号丢弃迟到响应', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: '无权限' } }), { status: 403 }) }
  await assert.rejects(source.getDashboardOverview(), { code: 'FORBIDDEN' }); assert.equal(calls, 1)
  assert.equal(storage.getAuthUserId(), 'user-A')
  let resolve
  globalThis.fetch = () => new Promise((r) => { resolve = r })
  const waiting = source.getDashboardOverview()
  storage.advanceAuthRevision('user-B')
  resolve(new Response(JSON.stringify(overview())))
  await assert.rejects(waiting, { name: 'AbortError' }); assert.equal(storage.getAuthUserId(), 'user-B')
})

test('demo 数据源沿用现有样例与覆盖层，不请求真实后端或返回固定统计', async () => {
  await vite.close()
  vite = await createServer({ cacheDir: 'node_modules/.vite-tests/dashboard-demo', mode: 'development',
    server: { middlewareMode: true, hmr: false, watch: null },
    define: { 'import.meta.env.VITE_AUTH_MODE': JSON.stringify('demo') },
    optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'silent' })
  source = await vite.ssrLoadModule('/src/services/dashboardDataSource.ts')
  let calls = 0
  globalThis.fetch = async (url) => {
    calls++; assert.equal(url, '/data/herb-batches.json')
    return new Response(JSON.stringify({ version: 1, batches }))
  }
  localStorage.setItem('liangmu_herb_overrides', JSON.stringify({ additions: [], updates: { b0: { auditStatus: 'approved' } } }))
  const result = await source.getDashboardOverview()
  assert.equal(result.mode, 'demo'); assert.equal(result.summary.totalBatches, 9)
  assert.equal(result.summary.pendingAuditBatches, 6); assert.equal(calls, 1)
})

async function dashboardHookHarness() {
  const { QueryClient, QueryClientProvider } = await vite.ssrLoadModule('@tanstack/react-query')
  const { useDashboardOverview } = await vite.ssrLoadModule('/src/hooks/useDashboardOverview.ts')
  const { herbQueryKeys } = await vite.ssrLoadModule('/src/hooks/useHerbBatches.ts')
  const { authFixture } = await vite.ssrLoadModule('virtual:dashboard-auth-fixture')
  queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } })
  let hook
  function Harness() { hook = useDashboardOverview(); return null }
  const render = (session, isAuthenticated = true) => {
    authFixture.current = { session, isAuthenticated }
    renderToString(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)))
    return hook
  }
  return { render, herbQueryKeys }
}

test('看板 Hook 按账号/角色/组织隔离缓存，未登录或非管理员禁用，不自动重试', async () => {
  const { render, herbQueryKeys } = await dashboardHookHarness()
  const admin = { userId: 'admin-A', role: 'admin', organizationId: 'platform-A' }
  render(admin)
  const key = [...herbQueryKeys.all, 'overview', admin.userId, admin.role, admin.organizationId]
  const query = queryClient.getQueryCache().find({ queryKey: key, exact: true })
  assert.equal(query.options.enabled, true)
  assert.equal(query.options.retry, false)
  assert.equal(query.options.staleTime, 15_000)
  assert.equal(query.options.refetchOnWindowFocus, true)
  assert.equal(JSON.stringify(key).includes('user-A'), false)
  queryClient.setQueryData(key, overview())
  assert.deepEqual(render(admin).data, overview())
  for (const changed of [{ ...admin, userId: 'admin-B' }, { ...admin, organizationId: 'platform-B' }, { ...admin, role: 'buyer' }]) {
    assert.equal(render(changed).data, undefined)
  }
  const buyer = queryClient.getQueryCache().find({ queryKey: [...herbQueryKeys.all, 'overview', 'admin-A', 'buyer', 'platform-A'], exact: true })
  assert.equal(buyer.options.enabled, false)
  render(null, false)
  const anonymous = queryClient.getQueryCache().find({ queryKey: [...herbQueryKeys.all, 'overview', 'anonymous', undefined, undefined], exact: true })
  assert.equal(anonymous.options.enabled, false)
})

test('看板 Hook 消费 Query 取消信号，批次缓存前缀失效后可重新请求最新统计', async () => {
  const { render, herbQueryKeys } = await dashboardHookHarness()
  render({ userId: 'admin-A', role: 'admin', organizationId: 'platform-A' })
  const query = queryClient.getQueryCache().getAll()[0]
  let calls = 0, signal, entered
  const started = new Promise((resolve) => { entered = resolve })
  globalThis.fetch = (_url, options) => {
    calls++; signal = options.signal; entered()
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  const waiting = queryClient.fetchQuery(query.options)
  await started
  await queryClient.cancelQueries({ queryKey: query.queryKey, exact: true })
  await assert.rejects(waiting)
  assert.equal(signal.aborted, true)
  assert.equal(calls, 1)
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify(overview())) }
  await queryClient.fetchQuery(query.options)
  assert.equal(query.state.isInvalidated, false)
  await queryClient.invalidateQueries({ queryKey: herbQueryKeys.all, refetchType: 'none' })
  assert.equal(query.state.isInvalidated, true)
  await queryClient.fetchQuery(query.options)
  assert.equal(calls, 3)
  assert.equal(query.state.isInvalidated, false)
})
