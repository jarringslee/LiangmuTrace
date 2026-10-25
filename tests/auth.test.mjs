import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { createServer } from 'vite'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

// Vite 负责转换 TS/import.meta.env，Node 内置测试器负责断言；无需安装第二套构建工具。
let vite, auth, api, storage, navigation, queryClient
const realFetch = globalThis.fetch
const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
const user = (role = 'admin') => ({
  id: `user-${role}`, username: role, displayName: '测试用户', email: `${role}@example.com`, role,
  organizationId: `org-${role}`, organization: { id: `org-${role}`, name: '测试组织', type: role === 'admin' ? 'platform' : role },
})
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers })
const failure = (status, code) => json({ error: { code, message: `测试错误 ${code}` } }, status)
const credentials = { account: 'admin', password: 'password', role: 'admin' }

async function setup(mode = 'development') {
  vite = await createServer({
    // 不与其他测试文件或正在运行的开发服务器争用 Vite 缓存。
    cacheDir: 'node_modules/.vite-tests/auth',
    mode, server: { middlewareMode: true, hmr: false, watch: null },
    define: {
      'import.meta.env.VITE_AUTH_MODE': JSON.stringify(mode === 'production' ? 'demo' : 'api'),
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'),
    },
    optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'silent',
  })
  auth = await vite.ssrLoadModule('/src/services/auth.ts')
  api = await vite.ssrLoadModule('/src/services/api.ts')
  storage = await vite.ssrLoadModule('/src/utils/auth.ts')
  navigation = await vite.ssrLoadModule('/src/utils/roleNavigation.ts')
  queryClient = (await vite.ssrLoadModule('/src/services/queryClient.ts')).queryClient
  queryClient.setDefaultOptions({ queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } })
}

const oldLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
beforeEach(async () => {
  for (const name of ['sessionStorage', 'localStorage']) {
    const values = new Map()
    Object.defineProperty(globalThis, name, { configurable: true, value: {
      getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key),
    } })
  }
  await setup()
})
afterEach(async () => {
  auth.invalidateAuth()
  queryClient.clear()
  await vite.close()
  globalThis.fetch = realFetch
  for (const [name, descriptor] of [['sessionStorage', oldStorage], ['localStorage', oldLocalStorage]]) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]
  }
})
async function loginAs(role = 'admin') {
  globalThis.fetch = async () => json({ expiresIn: 3600, user: user(role) })
  return auth.login({ ...credentials, role })
}

test('Cookie 登录后再用 /me 核实身份，不读取或写入 token，Storage 禁用仍能登录', async () => {
  const calls = []
  sessionStorage.setItem = localStorage.setItem = () => { throw new Error('blocked') }
  globalThis.fetch = async (url, options) => {
    calls.push(url)
    assert.equal(options.credentials, 'include')
    assert.equal(options.headers.Authorization, undefined)
    if (url.endsWith('/login')) assert.equal(options.headers['X-Liangmu-CSRF'], '1')
    return json({ user: user('grower'), expiresIn: 3600 })
  }
  const session = await auth.login({ ...credentials, role: 'grower' })
  assert.deepEqual(calls, ['/api/auth/login', '/api/auth/me'])
  assert.equal(session.growerId, 'org-grower')
  assert.equal(session.organizationName, '测试组织')
  assert.equal(auth.getAuthSnapshot().status, 'authenticated')
  assert.equal(storage.getAuthUserId(), 'user-grower')
  assert.equal(storage.getAuthSession(), null)
  assert.equal(storage.getAccessToken, undefined)
})

test('登录响应成功但浏览器未接受 Cookie 时，不能显示登录成功', async () => {
  globalThis.fetch = async url => url.endsWith('/login') ? json({ user: user() }) : failure(401, 'UNAUTHENTICATED')
  await assert.rejects(auth.login(credentials), { status: 401 })
  assert.equal(auth.getAuthSnapshot().status, 'error')
  assert.equal(auth.getAuthSnapshot().session, null)
})

test('刷新无需探测本地 token；checking 期间重复 /me 恢复只发一次', async () => {
  const result = deferred(); let calls = 0
  globalThis.fetch = (url, options) => { calls++; assert.equal(url, '/api/auth/me'); assert.equal(options.credentials, 'include'); return result.promise }
  const first = auth.restoreAuth(), second = auth.restoreAuth()
  assert.equal(first, second)
  assert.equal(auth.getAuthSnapshot().status, 'checking')
  result.resolve(json({ user: user('processor') })); await first
  assert.equal(calls, 1)
  assert.equal(auth.getAuthSnapshot().session.processorId, 'org-processor')
})

test('清理两个 Storage 的旧登录键，不信任残留 Mock 用户，正常未登录不显示错误', async () => {
  for (const store of [sessionStorage, localStorage]) {
    for (const key of ['liangmu_auth', 'liangmu_api_token_v1', 'liangmu_demo_auth_v2']) store.setItem(key, 'old-private-value')
    store.setItem('unrelated-preference', 'keep')
  }
  globalThis.fetch = async () => failure(401, 'UNAUTHENTICATED')
  await auth.restoreAuth()
  assert.equal(auth.getAuthSnapshot().status, 'anonymous'); assert.equal(auth.getAuthSnapshot().message, null)
  for (const store of [sessionStorage, localStorage]) {
    assert.equal(store.getItem('liangmu_api_token_v1'), null); assert.equal(store.getItem('liangmu_auth'), null)
    assert.equal(store.getItem('unrelated-preference'), 'keep')
  }
})

test('401 只清本地登录和私有缓存，不发送退出请求；登录错误不清其他登录状态', async () => {
  await loginAs(); queryClient.setQueryData(['private'], 'old')
  const calls = []
  globalThis.fetch = async url => { calls.push(url); return failure(401, 'INVALID_TOKEN') }
  await assert.rejects(api.apiRequest('/auth/login', { auth: false }), { status: 401 })
  assert.equal(auth.getAuthSnapshot().status, 'authenticated')
  await assert.rejects(api.apiRequest('/private'), { status: 401 })
  assert.equal(auth.getAuthSnapshot().status, 'anonymous'); assert.equal(storage.getAuthUserId(), null)
  assert.equal(queryClient.getQueryData(['private']), undefined)
  assert.deepEqual(calls, ['/api/auth/login', '/api/private'])
})

test('业务/CSRF 的403保留登录；账号停用和共享Cookie身份不匹配时失效', async () => {
  for (const code of ['FORBIDDEN', 'CSRF_REJECTED']) {
    await loginAs(); globalThis.fetch = async () => failure(403, code)
    await assert.rejects(api.apiRequest('/private'), { code }); assert.equal(auth.getAuthSnapshot().status, 'authenticated')
  }
  for (const [status, code] of [[403, 'ACCOUNT_DISABLED'], [409, 'SESSION_CHANGED']]) {
    await loginAs(); globalThis.fetch = async () => failure(status, code)
    await assert.rejects(api.apiRequest('/private'), { code }); assert.equal(auth.getAuthSnapshot().status, 'anonymous')
  }
})

test('恢复遇到网络错误保留验证入口，重试 /me 可以恢复', async () => {
  globalThis.fetch = async () => { throw new TypeError('offline') }
  await auth.restoreAuth(); assert.equal(auth.getAuthSnapshot().status, 'error')
  globalThis.fetch = async () => json({ user: user() })
  await auth.restoreAuth(); assert.equal(auth.getAuthSnapshot().status, 'authenticated')
})

test('恢复期间退出，迟到的 /me 不能重新登录', async () => {
  const old = deferred()
  globalThis.fetch = url => url.endsWith('/logout') ? Promise.resolve(new Response(null, { status: 204 })) : old.promise
  const pending = auth.restoreAuth(), exiting = auth.logout()
  old.resolve(json({ user: user() })); await pending
  assert.equal(await exiting, true); assert.equal(auth.getAuthSnapshot().status, 'anonymous')
})

test('已发出的登录先收尾，再执行退出；迟到 Set-Cookie 不覆盖退出', async () => {
  const entered = deferred(), old = deferred(), calls = []
  globalThis.fetch = (url, options) => {
    calls.push(url); assert.equal(options.credentials, 'include')
    if (url.endsWith('/login')) { entered.resolve(); return old.promise }
    return Promise.resolve(new Response(null, { status: 204 }))
  }
  const pending = auth.login(credentials), observed = assert.rejects(pending, { name: 'AbortError' })
  await entered.promise
  const exiting = auth.logout(); assert.equal(auth.getAuthSnapshot().status, 'checking')
  assert.deepEqual(calls, ['/api/auth/login'])
  old.resolve(json({ user: user() })); await observed
  assert.equal(await exiting, true)
  assert.deepEqual(calls, ['/api/auth/login', '/api/auth/logout'])
  assert.equal(auth.getAuthSnapshot().status, 'anonymous')
})

test('退出失败不假装成功，支持重试清 Cookie，退出请求无需现有身份', async () => {
  await loginAs(); queryClient.setQueryData(['private'], 'old')
  globalThis.fetch = async () => { throw new TypeError('offline') }
  assert.equal(await auth.logout(), false)
  assert.equal(auth.getAuthSnapshot().errorAction, 'logout')
  assert.equal(queryClient.getQueryData(['private']), undefined)
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/auth/logout'); assert.equal(options.credentials, 'include')
    assert.equal(options.headers['X-Liangmu-CSRF'], '1')
    return new Response(null, { status: 204 })
  }
  assert.equal(await auth.logout(), true); assert.equal(auth.getAuthSnapshot().status, 'anonymous')
})

test('切账号后旧401与旧成功响应均丢弃，同账号重登也产生新身份版本', async () => {
  for (const response of [failure(401, 'INVALID_TOKEN'), json({ data: 'old' })]) {
    await loginAs(); const old = deferred(); globalThis.fetch = () => old.promise
    const pending = api.apiRequest('/private')
    await loginAs('buyer'); old.resolve(response)
    await assert.rejects(pending, { name: 'AbortError' })
    assert.equal(auth.getAuthSnapshot().session.role, 'buyer')
  }
  const before = storage.getAuthRevision(); await loginAs('buyer')
  assert.ok(storage.getAuthRevision() > before)
})

test('私有请求发送期待的用户ID；公开请求不携带Cookie或身份，写请求即使无body也带CSRF头', async () => {
  await loginAs()
  globalThis.fetch = async (_url, options) => {
    if (options.credentials === 'omit') assert.equal(options.headers['X-Liangmu-User'], undefined)
    else assert.equal(options.headers['X-Liangmu-User'], 'user-admin')
    if (options.method === 'POST') assert.equal(options.headers['X-Liangmu-CSRF'], '1')
    return json({ ok: true })
  }
  await api.apiRequest('/private'); await api.apiRequest('/public', { auth: false })
  await api.apiRequest('/write', { method: 'POST' })
})

test('本地身份失效清空查询及mutation缓存，迟到查询不能重新填入', async () => {
  await loginAs(); const old = deferred()
  const pending = queryClient.fetchQuery({ queryKey: ['private'], queryFn: () => old.promise }).catch(() => undefined)
  queryClient.getMutationCache().build(queryClient, { mutationKey: ['old'] })
  auth.invalidateAuth(); old.resolve('old'); await pending
  assert.equal(queryClient.getQueryCache().getAll().length, 0); assert.equal(queryClient.getMutationCache().getAll().length, 0)
})

test('429保留Retry-After；无效JSON、取消和超时能够区分', async context => {
  globalThis.fetch = async () => json({ error: { code: 'LIMITED', message: '稍后重试' } }, 429, { 'Retry-After': '60' })
  await assert.rejects(api.apiRequest('/public', { auth: false }), { status: 429, retryAfter: '60' })
  globalThis.fetch = async () => new Response('<html>wrong upstream</html>')
  await assert.rejects(api.apiRequest('/public', { auth: false }), { code: 'INVALID_RESPONSE' })
  const controller = new AbortController(); controller.abort()
  await assert.rejects(api.apiRequest('/public', { auth: false, signal: controller.signal }), { name: 'AbortError' })
  context.mock.timers.enable({ apis: ['setTimeout'] })
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)))
  const timed = api.apiRequest('/public', { auth: false }); context.mock.timers.tick(15_000)
  await assert.rejects(timed, { code: 'TIMEOUT' }); context.mock.timers.reset()
})

test('跨标签广播仅提示重新核实身份；焦点验证身份不变时保留页面和缓存，清理后不再响应', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const target = new EventTarget(), channels = []
  target.BroadcastChannel = class { messages = []; onmessage = null; closed = false
    constructor() { channels.push(this) } postMessage(value) { this.messages.push(value) } close() { this.closed = true } }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target })
  const cleanup = auth.startAuthSync()
  try {
    await loginAs(); assert.deepEqual(channels[0].messages, ['changed'])
    const snapshot = auth.getAuthSnapshot(); queryClient.setQueryData(['private'], 'keep')
    window.dispatchEvent(new Event('focus')); await auth.restoreAuth(true)
    assert.equal(auth.getAuthSnapshot(), snapshot); assert.equal(queryClient.getQueryData(['private']), 'keep')
    globalThis.fetch = async () => json({ user: user('buyer') })
    channels[0].onmessage({ data: 'changed' }); await auth.restoreAuth(true)
    assert.equal(auth.getAuthSnapshot().session.role, 'buyer'); assert.equal(queryClient.getQueryData(['private']), undefined)
    cleanup(); assert.equal(channels[0].closed, true)
    channels[0].onmessage({ data: 'changed' }); assert.equal(auth.getAuthSnapshot().session.role, 'buyer')
  } finally { cleanup(); if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window }
})

test('redirect 拒绝外链、反斜杠、控制字符和登录循环，允许内部详情链接', () => {
  for (const path of ['https://evil.test', '//evil.test', '/\\evil.test', '/\nevil', '/login?redirect=/profile', '/']) {
    assert.equal(storage.sanitizeRedirectPath(path), null)
  }
  assert.equal(storage.sanitizeRedirectPath('/trace/code?from=list'), '/trace/code?from=list')
})

test('四角色导航集中映射到真实工作台和业务列表', () => {
  const expected = {
    admin: ['/dashboard', '管理员端', '/admin/herbs', '药材管理'],
    grower: ['/grower/dashboard', '种植商端', '/grower/batches', '我的批次'],
    processor: ['/processor/dashboard', '加工商端', '/processor/batches', '加工批次'],
    buyer: ['/buyer/herbs', '采购商端', '/buyer/herbs', '药材列表'],
  }
  for (const [role, values] of Object.entries(expected)) {
    const result = navigation.getRoleNavigation(role)
    assert.deepEqual(
      [result.homePath, result.homeLabel, result.resourcePath, result.resourceLabel],
      values,
    )
    assert.equal(navigation.getDefaultHome(role), values[0])
  }
})

test('显式 demo 模式完全不请求后端，仍支持四角色演示', async () => {
  auth.invalidateAuth()
  await vite.close()
  await setup('production')
  globalThis.fetch = () => { throw new Error('演示模式不得请求 API') }
  for (const [account, role] of [['lijialin', 'admin'], ['yuanyuhang', 'grower'], ['haorunyuan', 'processor'], ['chenjingxuan', 'buyer']]) {
    await auth.login({ account, role, password: `${account}123` })
    const session = auth.getAuthSnapshot().session
    assert.equal(session.role, role)
    assert.equal(session.username, account)
    assert.equal(typeof session.organizationName, 'string')
    assert.equal(sessionStorage.getItem('liangmu_api_token_v1'), null)
    assert.equal(storage.getAuthSession().role, role)
    auth.invalidateAuth()
  }
})

test('风险分析统一数据源正确编码 ID、携带认证、透传取消信号并提交人工结论', async () => {
  await loginAs()
  const source = await vite.ssrLoadModule('/src/services/herbDataSource.ts')
  const batchId = 'batch/with space'
  const analysisId = 'analysis/with space'
  const path = `/api/batches/${encodeURIComponent(batchId)}/risk-analysis`
  const controller = new AbortController()
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options })
    assert.equal(options.credentials, 'include'); assert.equal(options.headers.Authorization, undefined)
    if (url.endsWith('/review')) return json({ batchId, decision: 'approved' })
    return json({ analysis: options.method === 'POST' ? { id: analysisId } : null })
  }
  assert.equal(await source.getLatestRiskAnalysis(batchId, controller.signal), null)
  assert.deepEqual(await source.analyzeBatchRisk(batchId), { id: analysisId })
  const input = { decision: 'approved', riskLevel: 'low', reason: '人工核对' }
  assert.deepEqual(await source.submitRiskReview(batchId, analysisId, input), { batchId, decision: 'approved' })
  assert.deepEqual(requests.map(({ url, options }) => [url, options.method]), [
    [path, 'GET'], [path, 'POST'], [`${path}/${encodeURIComponent(analysisId)}/review`, 'POST'],
  ])
  assert.equal(requests[1].options.body, undefined)
  assert.deepEqual(JSON.parse(requests[2].options.body), input)
  controller.abort()
  assert.equal(requests[0].options.signal.aborted, true)
})

test('AI 分析独立使用 70 秒超时，不沿用普通请求的 15 秒且超时不退出登录', async (context) => {
  await loginAs()
  const source = await vite.ssrLoadModule('/src/services/herbDataSource.ts')
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let signal
  globalThis.fetch = (_url, options) => {
    signal = options.signal
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
  }
  const pending = source.analyzeBatchRisk('batch-test')
  context.mock.timers.tick(15_000)
  assert.equal(signal.aborted, false)
  context.mock.timers.tick(55_000)
  await assert.rejects(pending, { code: 'TIMEOUT' })
  assert.equal(auth.getAuthSnapshot().status, 'authenticated')
  context.mock.timers.reset()
})

const riskAnalysis = (id = 'new-analysis') => ({
  id, batchId: 'batch-test', basedOnVersion: 1, reviewVersion: 2,
  modelName: 'mock-model', promptVersion: 'audit-risk-v1', createdAt: '2026-10-04T08:00:00Z',
  mode: 'api', riskLevel: 'low', recommendation: 'manualReview', summary: '请人工核对资料。',
  missingInformation: [], evidence: [{ sourceId: 'batch:identity', note: '已读取批次' }], toolCalls: [], stale: false,
})
const riskFrame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const riskResponse = (text) => new Response(text, { headers: { 'Content-Type': 'text/event-stream' } })
async function createRiskHookHarness() {
  const { QueryClientProvider, QueryObserver } = await vite.ssrLoadModule('@tanstack/react-query')
  await loginAs()
  const { useBatchRiskAnalysis } = await vite.ssrLoadModule('/src/hooks/useBatchRiskAnalysis.ts')
  const { herbQueryKeys } = await vite.ssrLoadModule('/src/hooks/useHerbBatches.ts')
  const queryKey = ['batch-risk-analysis', 'api', 'batch-test']
  let hook
  function Harness() {
    hook = useBatchRiskAnalysis('batch-test')
    return null
  }
  // SSR 只用于合法调用 React Hook，不声称覆盖浏览器 UI 交互。
  renderToString(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)))
  return { hook, queryKey, herbQueryKeys, QueryObserver }
}

test('风险 Hook 重开即使缓存新鲜也 GET 已保存建议，读取失败保留旧数据显示但不伪装成功', async () => {
  const { queryKey, QueryObserver } = await createRiskHookHarness()
  const query = queryClient.getQueryCache().find({ queryKey })
  // 从实际 Hook 创建的 Query 取得选项，避免测试自行写 always 而漏掉代码接入。
  const options = { ...query.options, staleTime: 30_000, gcTime: Infinity }
  assert.equal(options.refetchOnMount, 'always')
  queryClient.setQueryData(queryKey, riskAnalysis('old-but-fresh'))
  let reads = 0
  globalThis.fetch = async (url, request) => {
    assert.match(url, /\/risk-analysis$/)
    assert.equal(request.method, 'GET')
    reads++
    return reads === 3 ? failure(502, 'AI_UPSTREAM_ERROR') : json({ analysis: riskAnalysis(`saved-${reads}`) })
  }
  const observer = new QueryObserver(queryClient, options)
  try {
    for (let opening = 1; opening <= 4; opening++) {
      const unsubscribe = observer.subscribe(() => undefined)
      try {
        assert.equal(observer.getCurrentResult().isFetching, true)
        await query.promise.catch(() => undefined)
        const result = observer.getCurrentResult()
        assert.equal(reads, opening)
        assert.equal(result.isFetching, false)
        assert.equal(result.isSuccess, opening !== 3)
        assert.equal(result.isError, opening === 3)
        assert.equal(result.data.id, opening === 3 ? 'saved-2' : `saved-${opening}`)
      } finally { unsubscribe() }
    }
  } finally { observer.destroy() }
})

test('风险分析 Hook 在写入新建议前取消旧读取，迟到响应不会覆盖新缓存', async () => {
  const { hook, queryKey, herbQueryKeys } = await createRiskHookHarness()
  let resolveOld
  queryClient.setQueryData(herbQueryKeys.all, ['old-batch-list'])
  const oldRequest = queryClient.fetchQuery({
    queryKey, queryFn: () => new Promise((resolve) => { resolveOld = resolve }),
  })
  // 立即捕获取消，防止测试器将预期的取消视为未处理拒绝。
  const oldOutcome = oldRequest.then(() => 'completed', () => 'cancelled')
  const analysis = riskAnalysis()
  globalThis.fetch = async (url) => {
    assert.match(url, /risk-analysis\/stream$/)
    return riskResponse(riskFrame('result', { analysis }))
  }
  await hook.startAnalyze()
  assert.equal(await oldOutcome, 'cancelled')
  assert.deepEqual(queryClient.getQueryData(queryKey), analysis)
  assert.equal(queryClient.getQueryState(herbQueryKeys.all).isInvalidated, true)
  resolveOld(null)
  await Promise.resolve()
  assert.deepEqual(queryClient.getQueryData(queryKey), analysis)
})

test('Hook 停止后重新读取已保存建议，不自动重跑，手动重试使用全新控制器', async () => {
  const { hook, queryKey, herbQueryKeys, QueryObserver } = await createRiskHookHarness()
  const saved = riskAnalysis('saved-before-disconnect')
  const retry = riskAnalysis('manual-retry')
  const signals = []
  let reads = 0, cancelled = false
  globalThis.fetch = async (url, request) => {
    if (!url.endsWith('/stream')) { reads += 1; return json({ analysis: saved }) }
    signals.push(request.signal)
    if (signals.length > 1) return riskResponse(riskFrame('result', { analysis: retry }))
    return new Response(new ReadableStream({ cancel() { cancelled = true } }), {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }
  queryClient.setQueryData(queryKey, null)
  queryClient.setQueryData(herbQueryKeys.all, ['old-list'])
  const observer = new QueryObserver(queryClient, {
    queryKey, staleTime: Infinity,
    queryFn: () => vite.ssrLoadModule('/src/services/herbDataSource.ts').then((source) => source.getLatestRiskAnalysis('batch-test')),
  })
  const unsubscribe = observer.subscribe(() => undefined)
  try {
    const rejected = assert.rejects(hook.startAnalyze(), { name: 'AbortError' })
    assert.equal(await hook.startAnalyze(), undefined) // controller ref 阻止同步连点。
    await new Promise((resolve) => setImmediate(resolve))
    hook.stopAnalyze()
    hook.stopAnalyze()
    await rejected
    assert.equal(cancelled, true)
    assert.equal(signals.length, 1)
    assert.equal(reads, 1)
    assert.deepEqual(queryClient.getQueryData(queryKey), saved)
    assert.equal(queryClient.getQueryState(herbQueryKeys.all).isInvalidated, true)
    assert.deepEqual(await hook.startAnalyze(), retry)
    assert.equal(signals.length, 2)
    assert.notEqual(signals[0], signals[1])
    assert.equal(signals[0].aborted, true)
    assert.equal(signals[1].aborted, false)
  } finally { unsubscribe() }
})

test('Hook 流中失败后读取旧建议并释放控制器，下一次手动分析可以成功', async () => {
  const { hook, queryKey, QueryObserver } = await createRiskHookHarness()
  const saved = riskAnalysis('previous-saved')
  let analyses = 0, reads = 0
  globalThis.fetch = async (url) => {
    if (!url.endsWith('/stream')) { reads += 1; return json({ analysis: saved }) }
    analyses += 1
    return riskResponse(analyses === 1
      ? riskFrame('error', { status: 502, code: 'AI_UPSTREAM_ERROR', message: '模拟模型不可用' })
      : riskFrame('result', { analysis: riskAnalysis() }))
  }
  queryClient.setQueryData(queryKey, null)
  const observer = new QueryObserver(queryClient, {
    queryKey, staleTime: Infinity,
    queryFn: () => vite.ssrLoadModule('/src/services/herbDataSource.ts').then((source) => source.getLatestRiskAnalysis('batch-test')),
  })
  const unsubscribe = observer.subscribe(() => undefined)
  try {
    await assert.rejects(hook.startAnalyze(), { code: 'AI_UPSTREAM_ERROR' })
    assert.equal(analyses, 1)
    assert.equal(reads, 1)
    assert.deepEqual(queryClient.getQueryData(queryKey), saved)
    await hook.startAnalyze()
    assert.equal(analyses, 2)
    assert.equal(queryClient.getQueryData(queryKey).id, 'new-analysis')
  } finally { unsubscribe() }
})

test('Hook 成功回调的 await 期间切换身份，也不能写入旧分析缓存', async (context) => {
  const { hook, queryKey } = await createRiskHookHarness()
  globalThis.fetch = async () => riskResponse(riskFrame('result', { analysis: riskAnalysis() }))
  context.mock.method(queryClient, 'cancelQueries', async () => {
    storage.advanceAuthRevision('user-B')
    queryClient.clear()
  })
  await hook.startAnalyze()
  assert.equal(queryClient.getQueryData(queryKey), undefined)
  assert.equal(storage.getAuthUserId(), 'user-B')
})
