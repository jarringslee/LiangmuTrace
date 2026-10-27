import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { createServer } from 'vite'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

let vite, source, parse, storage, auth, queryClient
const realFetch = globalThis.fetch
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
const reply = { id: 'reply', scope: 'general', batchId: null, question: '你好', status: 'answered',
  answer: '你好，可以从药材列表进入详情。', citations: [], mode: 'api', modelName: 'mock-model', createdAt: '2026-10-06T00:00:00Z' }
const batch = { id: 'batch-A', batchNo: 'YM-A', herbName: '丹参' }
const batchReply = { id: 'batch-reply', batchId: batch.id, question: '产地在哪里？', status: 'answered',
  answer: '登记产地为陕西。[batch:origin]', mode: 'api', modelName: 'mock-model', retrieval: 'bm25', knowledgeVersion: 'v1',
  createdAt: reply.createdAt, citations: [{ id: 'batch:origin', kind: 'batch', title: '登记产地', excerpt: '陕西', publisher: '批次档案', url: null }] }
const makeVite = (mode = 'api') => createServer({ cacheDir: `node_modules/.vite-tests/assistant-${mode}`,
  mode: 'development', server: { middlewareMode: true, hmr: false, watch: null },
  define: { 'import.meta.env.VITE_AUTH_MODE': JSON.stringify(mode), 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api') },
  optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'silent' })
beforeEach(async () => {
  const values = new Map()
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key),
  } })
  vite = await makeVite()
  source = await vite.ssrLoadModule('/src/services/assistantDataSource.ts')
  parse = (await vite.ssrLoadModule('/src/services/assistantContract.ts')).parseGeneralAssistantReply
  storage = await vite.ssrLoadModule('/src/utils/auth.ts')
  storage.advanceAuthRevision('user-A')
})
afterEach(async () => {
  auth?.invalidateAuth(); auth = undefined
  queryClient?.clear(); queryClient = undefined
  await vite.close()
  globalThis.fetch = realFetch
  if (previousStorage) Object.defineProperty(globalThis, 'sessionStorage', previousStorage); else delete globalThis.sessionStorage
})

test('普通回复按问题/模式/来源/批次/模型/日期校验，白名单不暴露额外字段', () => {
  assert.deepEqual(parse({ ...reply, secret: 'not-public' }, '你好', 'api'), reply)
  for (const invalid of [{ ...reply, question: '旧问题' }, { ...reply, mode: 'demo' }, { ...reply, batchId: 'other' },
    { ...reply, scope: 'batch' }, { ...reply, status: 'safe' }, { ...reply, modelName: null },
    { ...reply, citations: batchReply.citations }, { ...reply, createdAt: '2026-10-06' }]) {
    assert.throws(() => parse(invalid, '你好', 'api'), { code: 'INVALID_RESPONSE' })
  }
})

test('批次候选白名单保留查询码，不接受重复/非法候选或额外私有字段', () => {
  const candidate = { ...batch, traceCode: 'YM-TRACE-A', internal: 'secret' }
  const value = { ...reply, status: 'insufficient', modelName: null, candidates: [candidate] }
  assert.deepEqual(parse(value, '你好', 'api').candidates, [{ ...batch, traceCode: 'YM-TRACE-A' }])
  for (const candidates of [[candidate, candidate], [{ ...candidate, id: '' }], [null], Array(6).fill(candidate)])
    assert.throws(() => parse({ ...value, candidates }, '你好', 'api'), { code: 'INVALID_RESPONSE' })
})

test('知识库/联网来源使用统一契约，可信来源域名不放行伪装站点或重定向', async () => {
  const { isKnowledgeSourceUrl } = await vite.ssrLoadModule('/src/services/knowledgeSourceUrl.ts')
  for (const url of ['https://www.iplant.cn/bk/ABCDEF',
    'https://www.cmro.gov.hk/html/gb/useful_information/public_health/pamphlet/Adverse_Reactions_of_CM.html',
    'https://embracehealth.hkbu.edu.hk/html/eclassroom_book_detail.php?bookid=37']) assert.equal(isKnowledgeSourceUrl(url), true)
  for (const url of ['http://www.iplant.cn/bk/ABCDEF', 'https://www.iplant.cn.evil.test/bk/ABCDEF',
    'https://embracehealth.hkbu.edu.hk/redirect?to=https://evil.test', 'https://www.cmro.gov.hk:8888/html/a'])
    assert.equal(isKnowledgeSourceUrl(url), false)
})

test('无批次请求只发送本轮问题，Cookie/取消复用，不上传 UI 历史', async () => {
  let calls = 0
  globalThis.fetch = async (url, options) => {
    calls++
    assert.equal(url, '/api/assistant/chat')
    assert.equal(options.method, 'POST')
    assert.equal(options.credentials, 'include'); assert.equal(options.headers.Authorization, undefined)
    assert.deepEqual(JSON.parse(options.body), { question: '你好' })
    assert.equal(options.signal.aborted, false)
    return new Response(JSON.stringify({ reply }))
  }
  assert.deepEqual(await source.askAssistant({ question: '  你好  ', batch: null }, new AbortController().signal), reply)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(source.askAssistant({ question: '你好', batch: null }, controller.signal), { name: 'AbortError' })
  assert.equal(calls, 1)
})

test('带批次复用原单轮 RAG，按 ID 发请求而非前端标签，不接受错问题', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/batches/batch-A/questions')
    assert.deepEqual(JSON.parse(options.body), { question: '产地在哪里？' })
    return new Response(JSON.stringify({ reply: batchReply }))
  }
  const result = await source.askAssistant({ question: '产地在哪里？', batch }, new AbortController().signal)
  assert.equal(result.scope, 'batch'); assert.equal(result.batchId, batch.id)
  assert.deepEqual(result.citations, batchReply.citations)
  globalThis.fetch = async () => new Response(JSON.stringify({ reply: { ...batchReply, question: '迟到的旧问题' } }))
  await assert.rejects(source.askAssistant({ question: '产地在哪里？', batch }, new AbortController().signal), /不匹配/)
})

test('普通聊天失败不自动重试或清除登录，切账号的迟到回复被丢弃', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: { code: 'AI_UPSTREAM_ERROR', message: 'fixture' } }), { status: 502 }) }
  await assert.rejects(source.askAssistant({ question: '你好', batch: null }, new AbortController().signal), { code: 'AI_UPSTREAM_ERROR' })
  assert.equal(calls, 1); assert.equal(storage.getAuthUserId(), 'user-A')
  globalThis.fetch = async () => { storage.advanceAuthRevision('user-B'); return new Response(JSON.stringify({ reply })) }
  await assert.rejects(source.askAssistant({ question: '你好', batch: null }, new AbortController().signal), { name: 'AbortError' })
})

test('真实回答流使用 Cookie/UUID，增量先到达；仅校验后的终态构建 reply', async () => {
  const previews = []
  const final = { id: 'stream-request', question: '你好', batch: null, status: 'done', createdAt: reply.createdAt, reply }
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/assistant/conversation/messages/stream')
    assert.equal(options.credentials, 'include'); assert.equal(options.headers.Authorization, undefined)
    assert.equal(options.headers.Accept, 'text/event-stream')
    assert.deepEqual(JSON.parse(options.body), { requestId: final.id, question: '你好', batchIdentifier: null })
    return new Response(`: heartbeat\n\nevent: delta\ndata: ${JSON.stringify({ requestId: final.id, seq: 1, text: '你好' })}\n\nevent: result\ndata: ${JSON.stringify({ turn: final })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
  }
  const saved = await source.streamAssistantMessage(final.id, { question: '你好', batch: null }, new AbortController().signal, text => previews.push(text))
  assert.deepEqual(previews, ['你好']); assert.deepEqual(saved, final)
})
test('问答流断流、序号跳跃、错请求、错终态及错误事件不自动重试', async () => {
  const cases = [
    ['event: delta\ndata: {"requestId":"x","seq":1,"text":"一半"}\n\n', 'STREAM_INCOMPLETE'],
    ['event: delta\ndata: {"requestId":"x","seq":2,"text":"一半"}\n\n', 'STREAM_INVALID'],
    ['event: delta\ndata: {"requestId":"other","seq":1,"text":"一半"}\n\n', 'STREAM_INVALID'],
    ['event: error\ndata: {"status":502,"code":"AI_RESULT_CITATIONS_INVALID","message":"依据错误"}\n\n', 'AI_RESULT_CITATIONS_INVALID'],
  ]
  let calls = 0
  for (const [frames, code] of cases) {
    globalThis.fetch = async () => { calls++; return new Response(frames, { headers: { 'Content-Type': 'text/event-stream' } }) }
    await assert.rejects(source.streamAssistantMessage('x', { question: '你好', batch: null }, new AbortController().signal, () => undefined), { code })
  }
  assert.equal(calls, cases.length); assert.equal(storage.getAuthUserId(), 'user-A')
})
test('流式期间切账号，旧正文和终态均不能进入新账号', async () => {
  let shown = 0
  globalThis.fetch = async () => new Response('event: delta\ndata: {"requestId":"x","seq":1,"text":"第一段"}\n\nevent: delta\ndata: {"requestId":"x","seq":2,"text":"第二段"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  await assert.rejects(source.streamAssistantMessage('x', { question: '你好', batch: null }, new AbortController().signal, () => {
    shown++; storage.advanceAuthRevision('user-B')
  }), { name: 'AbortError' })
  assert.equal(shown, 1)
})
test('独立知识契约允许受信植物智来源，但拒绝混入批次来源与危险 URL', async () => {
  const { parseAssistantTurn } = await vite.ssrLoadModule('/src/services/assistantHistoryContract.ts')
  const value = { id: 'knowledge-request', question: '铁皮石斛是什么', batch: null, status: 'done', createdAt: reply.createdAt,
    reply: { ...reply, scope: 'knowledge', herbName: '铁皮石斛', question: '铁皮石斛是什么',
      citations: [{ id: 'knowledge:iplant:铁皮石斛:origin', kind: 'knowledge', title: '铁皮石斛 · 来源植物', publisher: '中科院植物智', url: 'https://www.iplant.cn/info/%E9%93%81%E7%9A%AE%E7%9F%B3%E6%96%9B?t=z' }] } }
  assert.equal(parseAssistantTurn(value).reply.scope, 'knowledge')
  const mutate = source => ({ ...value, reply: { ...value.reply, citations: [source] } })
  for (const source of [{ ...value.reply.citations[0], kind: 'batch', url: null },
    { ...value.reply.citations[0], url: 'https://www.iplant.cn/redirect?url=evil' },
    { ...value.reply.citations[0], url: 'https://www.iplant.cn.evil.test/info/铁皮石斛' }]) {
    assert.throws(() => parseAssistantTurn(mutate(source)), { code: 'INVALID_RESPONSE' })
  }
})
test('生成中使用客户文案，不暴露校验状态或复制来源；停止后不展示半成品', async () => {
  const { default: AssistantMessages } = await vite.ssrLoadModule('/src/components/assistant/AssistantMessages.tsx')
  const pending = { id: 'generating', question: '你好', batch: null, status: 'pending', preview: '第一段正文' }
  const html = renderToString(createElement(AssistantMessages, { turns: [pending], busy: true, retry: () => undefined }))
  assert.match(html, /第一段正文|正在整理回答/)
  assert.match(html, /正在整理回答/)
  assert.doesNotMatch(html, /尚未校验|未校验|后台校验/)
  assert.doesNotMatch(html, /复制回答|查看依据/)
  const stopped = renderToString(createElement(AssistantMessages, { turns: [{ ...pending, status: 'stopped' }], busy: false, retry: () => undefined }))
  assert.match(stopped, /已停止回答/); assert.doesNotMatch(stopped, /第一段正文/)
})
test('流中账号禁用与普通 HTTP 一样触发失效，AI 上游失败不退出登录', async () => {
  const api = await vite.ssrLoadModule('/src/services/api.ts')
  const invalidations = []
  api.setAuthFailureHandler(message => invalidations.push(message))
  try {
    for (const [code, status] of [['AI_UPSTREAM_ERROR', 502], ['ACCOUNT_DISABLED', 403]]) {
      globalThis.fetch = async () => new Response(`event: error\ndata: ${JSON.stringify({ code, status, message: code })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
      await assert.rejects(source.streamAssistantMessage('x', { question: '你好', batch: null }, new AbortController().signal, () => undefined), { code })
    }
    assert.deepEqual(invalidations, ['ACCOUNT_DISABLED'])
  } finally { api.setAuthFailureHandler(() => undefined) }
})

test('demo 无批次不调用模型/后端，明确标识静态演示', async () => {
  await vite.close(); vite = await makeVite('demo')
  const demo = await vite.ssrLoadModule('/src/services/assistantDataSource.ts')
  globalThis.fetch = async () => { throw new Error('must not call') }
  const result = await demo.askAssistant({ question: '你好', batch: null }, new AbortController().signal)
  assert.equal(result.mode, 'demo'); assert.equal(result.modelName, null); assert.equal(result.scope, 'general')
  assert.match(result.answer, /未调用 AI/)
})

test('共享会话 key 不包含 Token，同账号重新登录也分隔，旧身份检查失效', async () => {
  auth = await vite.ssrLoadModule('/src/services/auth.ts')
  const session = await vite.ssrLoadModule('/src/services/assistantSession.ts')
  globalThis.fetch = async () => new Response(JSON.stringify({ user: {
    id: 'user-A', username: 'fixture', email: 'fixture@example.test', displayName: 'fixture', role: 'buyer', organizationId: null, organization: null,
  } }))
  const first = await auth.login({ account: 'fixture', password: 'fixture', role: 'buyer' })
  const key = session.assistantSessionKey(first)
  assert.equal(session.assistantSessionKey(first), key)
  assert.equal(key.includes('fixture-token'), false)
  assert.equal(session.isCurrentAssistantSession(first), true)
  auth.invalidateAuth()
  const second = await auth.login({ account: 'fixture', password: 'fixture', role: 'buyer' })
  assert.notEqual(session.assistantSessionKey(second), key)
  assert.equal(session.isCurrentAssistantSession(first), false)
  assert.equal(session.isCurrentAssistantSession(second), true)
})

test('批次前缀与友好引用编号，不展示内部来源 ID 或篡改原回复', async () => {
  const { assistantBatchPrefix, formatAssistantAnswer } = await vite.ssrLoadModule('/src/utils/assistant.ts')
  assert.equal(assistantBatchPrefix(batch), '对于丹参批次 YM-A，')
  const before = structuredClone(batchReply)
  assert.equal(formatAssistantAnswer({ ...batchReply, scope: 'batch' }), '登记产地为陕西。[1]')
  assert.deepEqual(batchReply, before)
  assert.equal(formatAssistantAnswer(reply), reply.answer)
})

async function conversationHookHarness() {
  auth = await vite.ssrLoadModule('/src/services/auth.ts')
  globalThis.fetch = async () => new Response(JSON.stringify({ user: {
    id: 'user-A', username: 'fixture', email: 'fixture@example.test', displayName: 'fixture', role: 'buyer', organizationId: null, organization: null,
  } }))
  const session = await auth.login({ account: 'fixture', password: 'fixture', role: 'buyer' })
  const { QueryClient, QueryClientProvider } = await vite.ssrLoadModule('@tanstack/react-query')
  const { useAssistantConversation } = await vite.ssrLoadModule('/src/hooks/useAssistantConversation.ts')
  const { assistantSessionKey } = await vite.ssrLoadModule('/src/services/assistantSession.ts')
  queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } })
  // SSR 不运行浏览器 Effect；先放入服务端历史 fixture，模拟首次 GET 已成功。
  queryClient.setQueryData(['assistant-history', session.userId, assistantSessionKey(session)], {
    conversationId: 'conversation-A', mode: 'api', turns: [],
  })
  let hook
  function Harness() {
    hook = useAssistantConversation(session)
    return null
  }
  // SSR 仅合法调用 Hook，验证请求/锁/取消；不冒充浏览器状态更新或 Effect 验收。
  renderToString(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)))
  return hook
}

const turnResponse = (options, responseReply = reply, selected = null) => {
  const input = JSON.parse(options.body)
  return new Response(`event: result\ndata: ${JSON.stringify({ turn: { id: input.requestId, question: input.question,
    batch: selected, status: 'done', createdAt: responseReply.createdAt,
    reply: { ...responseReply, question: input.question } } })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
}

test('共享 Hook 拦截同一轮连续发送，保存发送时批次，完成后释放锁', async () => {
  const hook = await conversationHookHarness()
  const selected = { ...batch }
  let calls = 0, started, release
  const entered = new Promise((resolve) => { started = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  globalThis.fetch = async (url, options) => {
    calls++
    assert.equal(url, '/api/assistant/conversation/messages/stream')
    const input = JSON.parse(options.body)
    assert.match(input.requestId, /^[0-9a-f-]{36}$/)
    assert.equal(input.question, batchReply.question)
    assert.equal(input.batchIdentifier, batch.id)
    assert.deepEqual(Object.keys(input).sort(), ['batchIdentifier', 'question', 'requestId'])
    started()
    await gate
    return turnResponse(options, { ...batchReply, scope: 'batch' }, batch)
  }
  const pending = hook.send({ question: batchReply.question, batch: selected })
  selected.id = 'batch-B'
  await hook.send({ question: '你好', batch: null })
  await entered
  assert.equal(calls, 1)
  release()
  await pending
  const cached = queryClient.getQueryCache().getAll()[0].state.data.turns
  assert.equal(cached.length, 1)
  assert.equal(cached[0].status, 'done')
  assert.equal(cached[0].batch.id, batch.id)
  await hook.send({ question: batchReply.question, batch })
  assert.equal(calls, 2)
})

test('共享 Hook 停止/关闭取消延迟请求，不自动重试，再发使用全新信号', async () => {
  const hook = await conversationHookHarness()
  const signals = []
  let started
  let entered = new Promise((resolve) => { started = resolve })
  globalThis.fetch = async (_url, options) => {
    signals.push(options.signal)
    started()
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    })
  }
  const first = hook.send({ question: reply.question, batch: null })
  await entered
  hook.stop()
  await first
  assert.equal(signals.length, 1)
  assert.equal(signals[0].aborted, true)
  entered = new Promise((resolve) => { started = resolve })
  const second = hook.send({ question: reply.question, batch: null })
  await entered
  hook.closeAssistant()
  await second
  assert.equal(signals.length, 2)
  assert.equal(signals[1].aborted, true)
  assert.notEqual(signals[0], signals[1])
  globalThis.fetch = async (_url, options) => {
    signals.push(options.signal)
    return turnResponse(options)
  }
  await hook.send({ question: reply.question, batch: null })
  assert.equal(signals.length, 3)
  assert.equal(signals[2].aborted, false)
})

test('共享 Hook 上游失败释放锁，登出后旧 Hook 不再发送请求', async () => {
  const hook = await conversationHookHarness()
  let calls = 0
  globalThis.fetch = async (_url, options) => {
    calls++
    return calls === 1
      ? new Response(JSON.stringify({ error: { code: 'AI_UPSTREAM_ERROR', message: 'fixture' } }), { status: 502 })
      : turnResponse(options)
  }
  await hook.send({ question: reply.question, batch: null })
  assert.equal(calls, 1)
  await hook.send({ question: reply.question, batch: null })
  assert.equal(calls, 2)
  auth.invalidateAuth()
  await hook.send({ question: reply.question, batch: null })
  assert.equal(calls, 2)
})

test('正常拒答不标红或挂失败提示，纯文本转义模型 HTML，原始资料不直接展示', async () => {
  const { default: AssistantMessages } = await vite.ssrLoadModule('/src/components/assistant/AssistantMessages.tsx')
  const html = renderToString(createElement(AssistantMessages, {
    turns: [{ id: 'turn', question: reply.question, batch: null, status: 'done',
      reply: { ...reply, status: 'insufficient', answer: '<script>not executable</script>' } }],
    busy: false, retry: () => undefined,
  }))
  assert.doesNotMatch(html, /资料不足 \/ 暂无法回答|ant-typography-danger|重新提问/)
  assert.ok(html.includes('&lt;script&gt;not executable&lt;/script&gt;'))
  assert.ok(!html.includes('<script>not executable</script>'))
})

const turn = { id: 'request-A', question: '你好', batch: null, status: 'done', createdAt: reply.createdAt, reply }
const history = { conversationId: 'conversation-A', mode: 'api', turns: [turn] }

test('持久化历史契约白名单：删除账号/内部快照/引用片段，校验消息关联', async () => {
  const { parseAssistantHistory, parseAssistantTurn } = await vite.ssrLoadModule('/src/services/assistantHistoryContract.ts')
  assert.deepEqual(parseAssistantHistory({ ...history, userId: 'secret' }), history)
  const batchTurn = { ...turn, question: batchReply.question, batch: { ...batch, private: 'secret' },
    reply: { ...batchReply, scope: 'batch', rawContext: 'secret' }, actorRole: 'admin' }
  const parsed = parseAssistantTurn(batchTurn)
  assert.ok(!JSON.stringify(parsed).includes('secret'))
  assert.equal('excerpt' in parsed.reply.citations[0], false)
  for (const invalid of [{ ...turn, id: 'wrong' }, { ...turn, question: 'wrong' }]) {
    assert.throws(() => parseAssistantTurn(invalid, { id: turn.id, question: turn.question }), { code: 'INVALID_RESPONSE' })
  }
})

test('历史拒绝重复 ID/非法状态/非终态回复/日期/危险来源 URL/批次错配', async () => {
  const { parseAssistantHistory, parseAssistantTurn } = await vite.ssrLoadModule('/src/services/assistantHistoryContract.ts')
  for (const invalid of [{ ...history, turns: [turn, turn] }, { ...history, mode: 'demo' },
    { ...history, turns: Array.from({ length: 41 }, (_, index) => ({ ...turn, id: `${index}` })) }])
    assert.throws(() => parseAssistantHistory(invalid), { code: 'INVALID_RESPONSE' })
  const batchTurn = { ...turn, question: batchReply.question, batch, reply: { ...batchReply, scope: 'batch' } }
  for (const invalid of [{ ...turn, status: 'unknown' }, { ...turn, status: 'pending' }, { ...turn, createdAt: '2026-10-06' },
    { ...batchTurn, reply: { ...batchTurn.reply, batchId: 'other' } },
    { ...batchTurn, reply: { ...batchTurn.reply, citations: [{ ...batchReply.citations[0], kind: 'knowledge', url: 'javascript:alert(1)' }] } }])
    assert.throws(() => parseAssistantTurn(invalid), { code: 'INVALID_RESPONSE' })
})

test('会话 GET 只取本人历史；POST 只提交 UUID/本轮问题/编号，不上传 UI 历史', async () => {
  const sent = { ...turn, question: batchReply.question, batch, reply: { ...batchReply, scope: 'batch' } }
  let calls = 0
  globalThis.fetch = async (url, options) => {
    calls++
    assert.equal(options.credentials, 'include'); assert.equal(options.headers.Authorization, undefined)
    if (options.method === 'GET') {
      assert.equal(url, '/api/assistant/conversation')
      return new Response(JSON.stringify(history))
    }
    assert.equal(url, '/api/assistant/conversation/messages')
    assert.deepEqual(JSON.parse(options.body), { requestId: turn.id, question: batchReply.question, batchIdentifier: batch.id })
    return new Response(JSON.stringify({ turn: sent }))
  }
  assert.deepEqual(await source.getAssistantHistory(new AbortController().signal), history)
  const result = await source.sendAssistantMessage(turn.id, { question: batchReply.question, batch: { ...batch, herbName: '伪造药材' } }, new AbortController().signal)
  assert.equal(result.batch.herbName, batch.herbName)
  assert.equal(calls, 2)
})

test('服务端可按明确编号切换批次，不使用前端旧标签强行绑定回复', async () => {
  const next = { id: 'B', herbName: '黄精', batchNo: 'YM-B' }, question = 'YM-B 这是什么'
  globalThis.fetch = async () => new Response(JSON.stringify({ turn: { ...turn, question, batch: next,
    reply: { ...batchReply, scope: 'batch', question, batchId: next.id } } }))
  const result = await source.sendAssistantMessage(turn.id, { question, batch }, new AbortController().signal)
  assert.deepEqual(result.batch, next)
})

test('会话取消/换账号丢弃结果，503 不自动重试或伪造本地恢复', async () => {
  let calls = 0
  const controller = new AbortController(); controller.abort()
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify(history)) }
  await assert.rejects(source.getAssistantHistory(controller.signal), { name: 'AbortError' })
  assert.equal(calls, 0)
  globalThis.fetch = async () => { calls++; storage.advanceAuthRevision('user-B'); return new Response(JSON.stringify(history)) }
  await assert.rejects(source.getAssistantHistory(new AbortController().signal), { name: 'AbortError' })
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: {
    code: 'ASSISTANT_STORAGE_NOT_READY', message: '迁移尚未应用',
  } }), { status: 503 }) }
  await assert.rejects(source.getAssistantHistory(new AbortController().signal), { code: 'ASSISTANT_STORAGE_NOT_READY' })
  assert.equal(calls, 2)
})

test('消息合并服务端终态优先，pending 可显示本地停止；保留最多 40 轮且不改输入', async () => {
  const { mergeAssistantTurns } = await vite.ssrLoadModule('/src/utils/assistant.ts')
  const stopped = { ...turn, status: 'stopped', reply: undefined }
  assert.deepEqual(mergeAssistantTurns([turn], [stopped]), [turn])
  const pending = { ...stopped, status: 'pending' }
  assert.deepEqual(mergeAssistantTurns([pending], [stopped]), [stopped])
  assert.equal(pending.status, 'pending')
  const rows = Array.from({ length: 45 }, (_, index) => ({ ...turn, id: `request-${index}` }))
  assert.equal(mergeAssistantTurns(rows, []).length, 40)
})

test('demo 会话明确不持久化/不调用后端，保留静态展示接口', async () => {
  await vite.close(); vite = await makeVite('demo')
  const demo = await vite.ssrLoadModule('/src/services/assistantDataSource.ts')
  globalThis.fetch = async () => { throw new Error('must not call') }
  assert.deepEqual(await demo.getAssistantHistory(new AbortController().signal), { conversationId: null, mode: 'demo', turns: [] })
  const result = await demo.sendAssistantMessage(turn.id, { question: '你好', batch: null }, new AbortController().signal)
  assert.equal(result.reply.mode, 'demo'); assert.equal(result.id, turn.id)
})
