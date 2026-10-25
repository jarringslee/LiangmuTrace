import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, test } from 'node:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { createServer } from 'vite'

let vite, source, api, storage, queryClient
const realFetch = globalThis.fetch
const oldSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
const oldLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const code = 'YM-TRACE-2026-0001'
const batch = { traceCode: code, batchNo: 'YM-2026-GS-HQ-0318', herbName: '黄芪', category: 'root',
  origin: { province: '甘肃省', city: '定西市', district: '陇西县' }, growerName: '种植机构',
  plantingStartDate: '2025-03-12', stage: 'warehousing', auditStatus: 'approved', riskLevel: 'normal',
  createdAt: '2026-03-18T01:12:00.000Z', updatedAt: '2026-04-29T01:12:00.000Z',
  events: [], eventsTruncated: false }
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers })

async function setup(mode = 'api') {
  vite = await createServer({ cacheDir: `node_modules/.vite-tests/public-trace-query-${mode}`,
    server: { middlewareMode: true, hmr: false, watch: null },
    define: { 'import.meta.env.VITE_AUTH_MODE': JSON.stringify(mode), 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api') },
    optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'silent' })
  source = await vite.ssrLoadModule('/src/services/herbDataSource.ts')
  api = await vite.ssrLoadModule('/src/services/api.ts')
  storage = await vite.ssrLoadModule('/src/utils/auth.ts')
}

beforeEach(async () => {
  for (const name of ['sessionStorage', 'localStorage']) {
    const values = new Map()
    Object.defineProperty(globalThis, name, { configurable: true, value: {
      getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    } })
  }
  await setup()
  storage.advanceAuthRevision('existing-token')
})
afterEach(async () => {
  queryClient?.clear(); queryClient = undefined
  await vite?.close(); globalThis.fetch = realFetch
  for (const [name, descriptor] of [['sessionStorage', oldSessionStorage], ['localStorage', oldLocalStorage]]) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]
  }
})

test('公开数据源规范化编号，只读公开接口、不带 Token，切账号仍可读取相同公开白名单', async () => {
  let calls = 0
  globalThis.fetch = async (url, options) => {
    calls++; assert.equal(url, `/api/public/trace/${code}`)
    assert.equal(options.method, 'GET'); assert.equal(options.body, undefined)
    assert.equal(options.headers.Authorization, undefined); assert.ok(options.signal)
    storage.advanceAuthRevision('another-token')
    return json({ batch: { ...batch, createdBy: 'private-user', origin: { ...batch.origin, address: 'private-address' } } })
  }
  assert.deepEqual(await source.getPublicTraceByCode(` ${code.toLowerCase()} `), batch)
  assert.equal(calls, 1); assert.equal(storage.getAuthUserId(), 'another-token')
})

test('仅 404 转 null；认证/限流/服务和网络故障继续抛出、不清登录、不退回 demo', async () => {
  let calls = 0, authFailures = 0
  api.setAuthFailureHandler(() => { authFailures++ })
  globalThis.fetch = async () => { calls++; return json({ error: { code: 'NOT_FOUND', message: '不可公开' } }, 404) }
  assert.equal(await source.getPublicTraceByCode(code), null)
  for (const status of [401, 403, 429, 503]) {
    globalThis.fetch = async (url) => {
      calls++; assert.equal(url, `/api/public/trace/${code}`)
      return json({ error: { code: `HTTP_${status}`, message: '测试错误' } }, status, { 'Retry-After': '60' })
    }
    await assert.rejects(source.getPublicTraceByCode(code), { status, code: `HTTP_${status}` })
  }
  globalThis.fetch = async () => { calls++; throw new TypeError('network unavailable') }
  await assert.rejects(source.getPublicTraceByCode(code), { code: 'NETWORK_ERROR' })
  assert.equal(calls, 6); assert.equal(authFailures, 0)
  assert.equal(storage.getAuthUserId(), 'existing-token')
})

test('非法编号不请求；错误 JSON、响应外壳或编号不匹配不能绕过运行时校验', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; return json({ batch }) }
  for (const value of ['', 'hb-0001', 'YM-TRACE-2026-', `YM-TRACE-2026-${'A'.repeat(90)}`]) {
    assert.equal(await source.getPublicTraceByCode(value), null)
  }
  assert.equal(calls, 0)
  for (const value of [null, [], {}, { batch: { ...batch, traceCode: 'YM-TRACE-2026-OTHER' } },
    { batch: { ...batch, auditStatus: 'pending' } }]) {
    globalThis.fetch = async () => json(value)
    await assert.rejects(source.getPublicTraceByCode(code), { code: 'INVALID_RESPONSE' })
  }
  globalThis.fetch = async () => new Response('not-json')
  await assert.rejects(source.getPublicTraceByCode(code), { code: 'INVALID_RESPONSE' })
})

test('公开数据源取消：已取消时不请求，等待中 abort 传至 fetch，不伪装成 404/网络失败', async () => {
  let calls = 0, signal, entered
  const alreadyStopped = new AbortController(); alreadyStopped.abort()
  globalThis.fetch = async () => { calls++; return json({ batch }) }
  await assert.rejects(source.getPublicTraceByCode(code, alreadyStopped.signal), { name: 'AbortError' })
  assert.equal(calls, 0)
  const started = new Promise((resolve) => { entered = resolve })
  globalThis.fetch = (_url, options) => {
    calls++; signal = options.signal; entered()
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  const controller = new AbortController()
  const pending = source.getPublicTraceByCode(code, controller.signal)
  await started
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.ok(signal.aborted); assert.equal(calls, 1)
})

async function hookHarness() {
  const { QueryClient, QueryClientProvider } = await vite.ssrLoadModule('@tanstack/react-query')
  const { usePublicTrace } = await vite.ssrLoadModule('/src/hooks/usePublicTrace.ts')
  queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } })
  let hook
  function Harness({ identifier }) { hook = usePublicTrace(identifier); return null }
  return (identifier) => {
    renderToString(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness, { identifier })))
    return hook
  }
}

test('公开 Hook 不要求身份，编号/模式独立 key；无效码禁用，缓存策略/不重试正确', async () => {
  // SSR 只读取 Hook 的真实 Query 配置，不声称验证了浏览器聚焦/卸载 Effect。
  const render = await hookHarness()
  const key = ['public-trace', 'api', code]
  queryClient.setQueryData(['herb-batches', 'api', 'detail', code], { private: 'must-not-be-reused' })
  assert.equal(render(` ${code.toLowerCase()} `).data, undefined)
  const query = queryClient.getQueryCache().find({ queryKey: key, exact: true })
  assert.ok(query); assert.equal(query.options.enabled, true)
  assert.equal(query.options.retry, false); assert.equal(query.options.staleTime, 0)
  assert.equal(query.options.gcTime, 60_000); assert.equal(query.options.refetchOnWindowFocus, true)
  queryClient.setQueryData(key, batch)
  assert.deepEqual(render(code).data, batch)
  assert.equal(render('YM-TRACE-2026-OTHER').data, undefined)
  for (const value of [undefined, 'hb-0001']) {
    render(value)
    const normalized = (value ?? '').trim().toUpperCase()
    const invalid = queryClient.getQueryCache().find({ queryKey: ['public-trace', 'api', normalized], exact: true })
    assert.equal(invalid.options.enabled, false)
  }
})

test('公开 Hook queryFn 真正消费取消信号；再次获取检查公开资格且失败不自动重试', async () => {
  const render = await hookHarness(); render(code)
  const key = ['public-trace', 'api', code]
  const query = queryClient.getQueryCache().find({ queryKey: key, exact: true })
  let signal, entered, calls = 0
  const started = new Promise((resolve) => { entered = resolve })
  globalThis.fetch = (_url, options) => {
    calls++; signal = options.signal; entered()
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  const waiting = queryClient.fetchQuery(query.options)
  await started
  await queryClient.cancelQueries({ queryKey: key, exact: true })
  await assert.rejects(waiting); assert.ok(signal.aborted)
  globalThis.fetch = async () => { calls++; return json({ batch }) }
  assert.deepEqual(await queryClient.fetchQuery(query.options), batch)
  globalThis.fetch = async () => { calls++; return json({ error: { code: 'NOT_FOUND' } }, 404) }
  assert.equal(await queryClient.fetchQuery(query.options), null)
  assert.equal(query.state.data, null)
  globalThis.fetch = async () => { calls++; return json({ error: { code: 'UNAVAILABLE' } }, 503) }
  await assert.rejects(queryClient.fetchQuery(query.options), { status: 503 })
  assert.equal(calls, 4)
})

test('demo 查询使用既有样例/覆盖层，不接真实后端；未审返回 null，key 不混用 API', async () => {
  await vite.close(); await setup('demo')
  const fixture = JSON.parse(await readFile(new URL('../public/data/herb-batches.json', import.meta.url), 'utf8'))
  const sample = fixture.batches.find((item) => item.traceCode === code)
  let calls = 0
  globalThis.fetch = async (url) => {
    calls++; assert.equal(url, '/data/herb-batches.json'); return json(fixture)
  }
  const result = await source.getPublicTraceByCode(code)
  assert.equal(result.traceCode, code); assert.ok(!('createdBy' in result)); assert.equal(calls, 1)
  localStorage.setItem('liangmu_herb_overrides', JSON.stringify({ additions: [], updates: { [sample.id]: { auditStatus: 'pending' } } }))
  assert.equal(await source.getPublicTraceByCode(code), null); assert.equal(calls, 1)
  const render = await hookHarness(); render(code)
  assert.ok(queryClient.getQueryCache().find({ queryKey: ['public-trace', 'demo', code], exact: true }))
  assert.equal(queryClient.getQueryCache().find({ queryKey: ['public-trace', 'api', code], exact: true }), undefined)
})

test('登录过期/退出只清私有缓存，不取消正在读取的匿名档案', async () => {
  const auth = await vite.ssrLoadModule('/src/services/auth.ts')
  queryClient = (await vite.ssrLoadModule('/src/services/queryClient.ts')).queryClient
  const key = ['public-trace', 'api', code]
  queryClient.setQueryData(['herb-batches', 'api', 'private'], { private: 'old-user-data' })
  queryClient.getMutationCache().build(queryClient, { mutationKey: ['private-write'], gcTime: Infinity })
  let signal, entered, complete
  const started = new Promise((resolve) => { entered = resolve })
  globalThis.fetch = (_url, options) => {
    signal = options.signal; entered()
    return new Promise((resolve, reject) => {
      complete = () => resolve(json({ batch }))
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }
  const pending = queryClient.fetchQuery({ queryKey: key,
    queryFn: ({ signal }) => source.getPublicTraceByCode(code, signal), retry: false })
  // 先处理可能的拒绝，避免回归失败时出现未处理 rejection。
  const outcome = pending.then((data) => ({ data }), (error) => ({ error }))
  await started
  auth.invalidateAuth()
  complete()
  const result = await outcome
  assert.equal(signal.aborted, false)
  assert.deepEqual(result.data, batch)
  assert.deepEqual(queryClient.getQueryData(key), batch)
  assert.equal(queryClient.getQueryData(['herb-batches', 'api', 'private']), undefined)
  assert.equal(queryClient.getMutationCache().getAll().length, 0)
  assert.equal(storage.getAuthUserId(), null)
})
