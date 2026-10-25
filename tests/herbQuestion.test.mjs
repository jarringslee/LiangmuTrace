import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { createServer } from 'vite'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

const realFetch = globalThis.fetch
const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
let vite, source, parse, storage, queryClient
const reply = {
  id: 'reply-test', batchId: 'batch-test', question: '当前批次名称？', status: 'answered',
  answer: '当前药材名称为丹参。[batch:identity]', mode: 'api', modelName: 'mock-model',
  retrieval: 'bm25', knowledgeVersion: 'herb-knowledge-v1', createdAt: '2026-10-05T00:00:00Z',
  citations: [{ id: 'batch:identity', kind: 'batch', title: '批次名称', excerpt: '丹参', publisher: '批次档案', url: null }],
}
beforeEach(async () => {
  const values = new Map()
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  } })
  vite = await createServer({
    cacheDir: 'node_modules/.vite-tests/herb-question',
    mode: 'development', server: { middlewareMode: true, hmr: false, watch: null },
    define: { 'import.meta.env.VITE_AUTH_MODE': JSON.stringify('api'), 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api') },
    optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'silent',
  })
  source = await vite.ssrLoadModule('/src/services/herbDataSource.ts')
  parse = (await vite.ssrLoadModule('/src/services/herbQuestionContract.ts')).parseHerbQuestionReply
  storage = await vite.ssrLoadModule('/src/utils/auth.ts')
  const { QueryClient } = await vite.ssrLoadModule('@tanstack/react-query')
  queryClient = new QueryClient({ defaultOptions: {
    queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 },
  } })
  storage.advanceAuthRevision('user-A')
})
afterEach(async () => {
  queryClient?.clear()
  await vite.close()
  globalThis.fetch = realFetch
  if (oldStorage) Object.defineProperty(globalThis, 'sessionStorage', oldStorage)
  else delete globalThis.sessionStorage
})

test('问答数据源编码路径、只提交问题并携带认证与取消信号，不修改批次', async () => {
  const controller = new AbortController()
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/batches/batch-test/questions')
    assert.equal(options.method, 'POST')
    assert.equal(options.credentials, 'include'); assert.equal(options.headers.Authorization, undefined)
    assert.deepEqual(JSON.parse(options.body), { question: '当前批次名称？' })
    assert.equal(options.signal.aborted, false)
    return new Response(JSON.stringify({ reply }))
  }
  assert.deepEqual(await source.askHerbQuestion('batch-test', '  当前批次名称？  ', controller.signal), reply)
  controller.abort()
  await assert.rejects(source.askHerbQuestion('batch-test', '当前批次名称？', controller.signal), { name: 'AbortError' })
  globalThis.fetch = async (url) => {
    assert.equal(url, '/api/batches/id%2Fencoded/questions')
    return new Response(JSON.stringify({ reply: { ...reply, batchId: 'id/encoded' } }))
  }
  await source.askHerbQuestion('id/encoded', '当前批次名称？', new AbortController().signal)
})

test('网络结果检查批次、枚举、引用和安全链接；TS 类型不能替代运行时校验', () => {
  assert.deepEqual(parse(reply, 'batch-test'), reply)
  for (const invalid of [
    { ...reply, batchId: 'another-batch' }, { ...reply, status: 'safe' },
    { ...reply, citations: [] }, { ...reply, modelName: undefined },
    { ...reply, citations: [{ ...reply.citations[0], kind: 'knowledge', url: 'javascript:alert(1)' }] },
    { ...reply, citations: [{ ...reply.citations[0], kind: 'knowledge', url: 'https://example.test/' }] },
  ]) assert.throws(() => parse(invalid, 'batch-test'), { code: 'INVALID_RESPONSE' })
})

test('单轮问答上游失败不自动重试、普通业务失败不清除登录；切账号丢弃旧结果', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: { code: 'AI_INVALID_RESULT', message: '模型格式错误' } }), { status: 502 }) }
  await assert.rejects(source.askHerbQuestion('batch-test', '当前批次名称？', new AbortController().signal), { code: 'AI_INVALID_RESULT' })
  assert.equal(calls, 1)
  assert.equal(storage.getAuthUserId(), 'user-A')
  globalThis.fetch = async () => {
    storage.advanceAuthRevision('user-B')
    return new Response(JSON.stringify({ reply }))
  }
  await assert.rejects(source.askHerbQuestion('batch-test', '当前批次名称？', new AbortController().signal), { name: 'AbortError' })
})

test('demo 只摘录本地批次，不冒充 RAG/DeepSeek，并能拒绝医疗请求', async () => {
  const { answerDemoHerbQuestion } = await vite.ssrLoadModule('/src/services/herbQuestionDemo.ts')
  const batch = {
    id: 'batch-test', herbName: '丹参', origin: { province: '陕西省', city: '西安市' },
    stage: 'planting', auditStatus: 'approved', riskLevel: 'normal',
  }
  const result = parse(answerDemoHerbQuestion(batch, '本批次产地在哪里？'), batch.id)
  assert.equal(result.mode, 'demo')
  assert.equal(result.retrieval, 'demo')
  assert.equal(result.modelName, null)
  assert.match(result.answer, /未调用 AI/)
  assert.equal(answerDemoHerbQuestion(batch, '丹参一般主产哪里？').status, 'insufficient')
  assert.equal(answerDemoHerbQuestion(batch, '孕妇能吃多少丹参？').status, 'insufficient')
})

async function questionHookHarness() {
  const { QueryClientProvider } = await vite.ssrLoadModule('@tanstack/react-query')
  const { useHerbQuestion } = await vite.ssrLoadModule('/src/hooks/useHerbQuestion.ts')
  let hook
  function Harness() {
    hook = useHerbQuestion('batch-test')
    return null
  }
  // SSR 只用于合法调用 Hook；卸载 Effect 与弹窗交互由浏览器另行验收。
  renderToString(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)))
  return hook
}

test('问答 Hook 阻止同一轮重复点击，完成后释放控制器且不刷新只读批次缓存', async () => {
  const hook = await questionHookHarness()
  const batchKey = ['herb-batches', 'api']
  queryClient.setQueryData(batchKey, ['unchanged-batches'])
  let calls = 0, release, started
  const entered = new Promise((resolve) => { started = resolve })
  globalThis.fetch = async () => {
    calls++
    started()
    await new Promise((resolve) => { release = resolve })
    return new Response(JSON.stringify({ reply }))
  }
  const pending = hook.ask(reply.question)
  assert.equal(await hook.ask(reply.question), undefined)
  await entered
  assert.equal(calls, 1)
  release()
  assert.deepEqual(await pending, reply)
  assert.equal(calls, 1)
  assert.deepEqual(queryClient.getQueryData(batchKey), ['unchanged-batches'])
  assert.equal(queryClient.getQueryState(batchKey).isInvalidated, false)
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ reply })) }
  await hook.ask(reply.question)
  assert.equal(calls, 2)
})

test('问答 Hook 停止不自动重试；手动重试使用新控制器', async () => {
  const hook = await questionHookHarness()
  const signals = []
  let started
  const entered = new Promise((resolve) => { started = resolve })
  globalThis.fetch = async (_url, options) => {
    signals.push(options.signal)
    started()
    if (signals.length > 1) return new Response(JSON.stringify({ reply }))
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    })
  }
  const pending = assert.rejects(hook.ask(reply.question), { name: 'AbortError' })
  await entered
  hook.stop()
  await pending
  assert.equal(signals.length, 1)
  assert.equal(signals[0].aborted, true)
  assert.deepEqual(await hook.ask(reply.question), reply)
  assert.equal(signals.length, 2)
  assert.notEqual(signals[0], signals[1])
  assert.equal(signals[1].aborted, false)
})

test('问答 Hook 上游失败不自动重跑，finally 释放控制器后允许手动再次提问', async () => {
  const hook = await questionHookHarness()
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return calls === 1
      ? new Response(JSON.stringify({ error: { code: 'AI_INVALID_RESULT', message: '模拟格式错误' } }), { status: 502 })
      : new Response(JSON.stringify({ reply }))
  }
  await assert.rejects(hook.ask(reply.question), { code: 'AI_INVALID_RESULT' })
  assert.equal(calls, 1)
  assert.equal(storage.getAuthUserId(), 'user-A')
  assert.deepEqual(await hook.ask(reply.question), reply)
  assert.equal(calls, 2)
})
