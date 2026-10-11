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
beforeEach(async () => {
  const values = new Map()
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  } })
  await setup()
})
afterEach(async () => {
  auth.logout()
  await vite.close()
  globalThis.fetch = realFetch
  if (oldStorage) Object.defineProperty(globalThis, 'sessionStorage', oldStorage)
  else delete globalThis.sessionStorage
})
async function loginAs(role = 'admin', token = `token-${role}`) {
  globalThis.fetch = async () => json({ accessToken: token, user: user(role) })
  return auth.login({ ...credentials, role })
}

test('API 登录只保存 Token，角色/组织映射到现有页面字段', async () => {
  let request
  globalThis.fetch = async (url, options) => {
    request = { url, options }
    return json({ accessToken: 'new-token', user: user('grower') })
  }
  const session = await auth.login({ ...credentials, role: 'grower' })
  assert.equal(request.url, '/api/auth/login')
  assert.equal(request.options.headers.Authorization, undefined)
  assert.equal(session.username, 'grower')
  assert.equal(session.growerId, 'org-grower')
  assert.equal(session.organizationName, '测试组织')
  assert.equal(storage.getAccessToken(), 'new-token')
  assert.equal(storage.getAuthSession(), null)
  assert.equal(auth.getAuthSnapshot().status, 'authenticated')
})

test('刷新时先 checking，/me 成功才认证；重复恢复只请求一次', async () => {
  storage.setAccessToken('stored-token')
  let resolveResponse, count = 0
  globalThis.fetch = (_url, options) => {
    count++
    assert.equal(options.headers.Authorization, 'Bearer stored-token')
    return new Promise((resolve) => { resolveResponse = resolve })
  }
  const first = auth.restoreAuth()
  const second = auth.restoreAuth()
  assert.equal(first, second)
  assert.equal(auth.getAuthSnapshot().session, null)
  resolveResponse(json({ user: user('processor') }))
  await first
  assert.equal(count, 1)
  assert.equal(auth.getAuthSnapshot().session.processorId, 'org-processor')
})

test('API 模式不会信任旧 Mock 登录资料', async () => {
  sessionStorage.setItem('liangmu_auth', JSON.stringify({ role: 'admin' }))
  globalThis.fetch = () => { throw new Error('不应请求') }
  await auth.restoreAuth()
  assert.equal(auth.getAuthSnapshot().status, 'anonymous')
})

test('401 清除登录和缓存，登录接口的 401 只作为表单错误', async () => {
  await loginAs()
  queryClient.setQueryData(['private'], ['old-user-data'])
  globalThis.fetch = async () => failure(401, 'INVALID_CREDENTIALS')
  await assert.rejects(api.apiRequest('/auth/login', { auth: false }), { status: 401 })
  assert.equal(auth.getAuthSnapshot().status, 'authenticated')
  await assert.rejects(api.apiRequest('/auth/me'), { status: 401 })
  assert.equal(auth.getAuthSnapshot().status, 'anonymous')
  assert.equal(storage.getAccessToken(), null)
  assert.equal(queryClient.getQueryData(['private']), undefined)
})

test('普通 403 保留登录，账号被禁用的 403 清理登录', async () => {
  await loginAs()
  globalThis.fetch = async () => failure(403, 'FORBIDDEN')
  await assert.rejects(api.apiRequest('/restricted'), { status: 403 })
  assert.equal(auth.getAuthSnapshot().status, 'authenticated')
  globalThis.fetch = async () => failure(403, 'ACCOUNT_DISABLED')
  await assert.rejects(api.apiRequest('/auth/me'), { status: 403 })
  assert.equal(auth.getAuthSnapshot().status, 'anonymous')
})

test('网络错误保留 Token 和恢复入口，重试成功后登录', async () => {
  storage.setAccessToken('stored')
  globalThis.fetch = async () => { throw new TypeError('offline') }
  await auth.restoreAuth()
  assert.equal(auth.getAuthSnapshot().status, 'error')
  assert.equal(storage.getAccessToken(), 'stored')
  globalThis.fetch = async () => json({ user: user() })
  await auth.restoreAuth()
  assert.equal(auth.getAuthSnapshot().status, 'authenticated')
})

test('恢复期间退出，迟到的 /me 不能重新登录', async () => {
  storage.setAccessToken('stored')
  let resolveResponse
  globalThis.fetch = () => new Promise((resolve) => { resolveResponse = resolve })
  const pending = auth.restoreAuth()
  auth.logout()
  resolveResponse(json({ user: user() }))
  await pending
  assert.equal(auth.getAuthSnapshot().status, 'anonymous')
})

test('登录期间退出，迟到的成功响应不能覆盖退出状态', async () => {
  let resolveResponse
  globalThis.fetch = () => new Promise((resolve) => { resolveResponse = resolve })
  const pending = auth.login(credentials)
  auth.logout()
  resolveResponse(json({ accessToken: 'late', user: user() }))
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(storage.getAccessToken(), null)
})

test('切账号后旧 401 不能踢出新账号，旧成功响应也被丢弃', async () => {
  for (const response of [failure(401, 'INVALID_TOKEN'), json({ data: 'old' })]) {
    await loginAs('admin', 'token-A')
    let resolveResponse
    globalThis.fetch = () => new Promise((resolve) => { resolveResponse = resolve })
    const oldRequest = api.apiRequest('/private')
    auth.logout()
    await loginAs('buyer', 'token-B')
    resolveResponse(response)
    await assert.rejects(oldRequest, { name: 'AbortError' })
    assert.equal(auth.getAuthSnapshot().session.role, 'buyer')
    assert.equal(storage.getAccessToken(), 'token-B')
  }
})

test('退出清除查询和 mutation 缓存，迟到查询不重新填入缓存', async () => {
  await loginAs()
  let resolveQuery
  const pending = queryClient.fetchQuery({ queryKey: ['pending'], queryFn: () => new Promise((resolve) => { resolveQuery = resolve }) })
  const observed = pending.catch(() => undefined)
  queryClient.getMutationCache().build(queryClient, { mutationKey: ['old'] })
  auth.logout()
  resolveQuery('old-account')
  await observed
  assert.equal(queryClient.getQueryCache().getAll().length, 0)
  assert.equal(queryClient.getMutationCache().getAll().length, 0)
})

test('429 保留 Retry-After；无效 JSON、调用方取消和超时能区分', async (context) => {
  globalThis.fetch = async () => json({ error: { code: 'TOO_MANY_ATTEMPTS', message: '请稍后重试' } }, 429, { 'Retry-After': '60' })
  await assert.rejects(api.apiRequest('/auth/login', { auth: false }), { status: 429, retryAfter: '60' })
  globalThis.fetch = async () => new Response('<html>wrong upstream</html>')
  await assert.rejects(api.apiRequest('/auth/login', { auth: false }), { code: 'INVALID_RESPONSE' })
  const controller = new AbortController()
  controller.abort()
  globalThis.fetch = async (_url, options) => { options.signal.throwIfAborted() }
  await assert.rejects(api.apiRequest('/auth/login', { auth: false, signal: controller.signal }), { name: 'AbortError' })
  context.mock.timers.enable({ apis: ['setTimeout'] })
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)))
  const timeout = api.apiRequest('/auth/login', { auth: false })
  context.mock.timers.tick(15_000)
  await assert.rejects(timeout, { code: 'TIMEOUT' })
  context.mock.timers.reset()
})

test('Token 到期自动清理；存储被禁止时不假装登录成功', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const token = `header.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 10 }))}.signature`
  await loginAs('admin', token)
  context.mock.timers.tick(11_000)
  assert.equal(auth.getAuthSnapshot().status, 'anonymous')
  context.mock.timers.reset()
  sessionStorage.setItem = () => { throw new Error('blocked') }
  await assert.rejects(loginAs(), { code: 'STORAGE_UNAVAILABLE' })
  assert.equal(auth.getAuthSnapshot().status, 'anonymous')
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
  auth.logout()
  await vite.close()
  await setup('production')
  globalThis.fetch = () => { throw new Error('演示模式不得请求 API') }
  for (const [account, role] of [['lijialin', 'admin'], ['yuanyuhang', 'grower'], ['haorunyuan', 'processor'], ['chenjingxuan', 'buyer']]) {
    await auth.login({ account, role, password: `${account}123` })
    const session = auth.getAuthSnapshot().session
    assert.equal(session.role, role)
    assert.equal(session.username, account)
    assert.equal(typeof session.organizationName, 'string')
    assert.equal(storage.getAccessToken(), null)
    assert.equal(storage.getAuthSession().role, role)
    auth.logout()
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
    assert.equal(options.headers.Authorization, 'Bearer token-admin')
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
    storage.setAccessToken('token-B')
    queryClient.clear()
  })
  await hook.startAnalyze()
  assert.equal(queryClient.getQueryData(queryKey), undefined)
  assert.equal(storage.getAccessToken(), 'token-B')
})
