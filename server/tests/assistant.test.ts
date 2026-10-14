import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { AuditModel } from '../src/lib/deepseek.js'
import type { AuthUser } from '../src/services/auth.js'

process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-only-assistant-secret-0123456789abcdef'
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test'
const { createAssistantService, assistantQuestionSchema } = await import('../src/services/assistant.js')
const { createAssistantRouter } = await import('../src/routes/assistant.js')
const { errorHandler, HttpError } = await import('../src/middleware/error.js')
const { signAccessToken } = await import('../src/lib/token.js')

const user: AuthUser = { id: 'buyer', role: 'buyer', username: 'buyer', email: 'buyer@example.test',
  displayName: '采购商', organizationId: null, organization: null }
const output = { status: 'answered', answer: '你好，可以从药材列表进入溯源详情。' }
const mockModel = (): AuditModel => ({ name: 'mock-general-model',
  complete: async () => ({ content: JSON.stringify(output), toolCalls: [] }) })

test('普通聊天只有系统/本轮问题，不传历史、工具或批次，不冒充 RAG', async () => {
  let calls = 0
  const service = createAssistantService({ ...mockModel(), async complete(input) {
    calls++
    assert.equal(input.json, true)
    assert.equal(input.tools, undefined)
    assert.equal(input.messages.length, 2)
    assert.equal(input.messages[1].content, '你好，怎么查看溯源？')
    assert.match(input.messages[0].content!, /没有批次档案/)
    assert.match(input.messages[0].content!, /不提供订单\/支付/)
    return mockModel().complete(input)
  } })
  const reply = await service.ask(user, { question: '  你好，怎么查看溯源？  ' })
  assert.equal(calls, 1)
  assert.equal(reply.scope, 'general')
  assert.equal(reply.batchId, null)
  assert.deepEqual(reply.citations, [])
  assert.equal(reply.modelName, 'mock-general-model')
  assert.equal(reply.question, '你好，怎么查看溯源？')
  assert.equal('userId' in reply, false)
})

test('功能提示不再错报聊天室未实现，单轮/持久化历史能力明确区分', async () => {
  const prompts: string[] = []
  const service = createAssistantService({ ...mockModel(), async complete(request) {
    prompts.push(request.messages[0].content!)
    return mockModel().complete(request)
  } })
  await service.ask(user, { question: '平台客服聊天现在可以使用吗？' })
  await service.ask(user, { question: '平台客服聊天现在可以使用吗？' }, undefined, [], true)
  for (const prompt of prompts) {
    assert.match(prompt, /人工聊天已实现/)
    assert.match(prompt, /采购商仅联系平台客服/)
    assert.doesNotMatch(prompt, /人工聊天室尚在开发/)
    assert.match(prompt, /不提供订单\/支付/)
    assert.match(prompt, /注册会新建独立采购组织/)
    assert.match(prompt, /不管理其他管理员或删除历史记录/)
    assert.match(prompt, /改密和找回密码仍未实现/)
  }
  assert.match(prompts[0], /单轮聊天.*没有历史消息/)
  assert.match(prompts[1], /最多4轮相关历史/)
  assert.match(prompts[1], /实际提供的历史/)
  assert.doesNotMatch(prompts[1], /本接口为单轮聊天/)
})

test('问题严格校验，不接受伪造身份/批次/历史，医疗问题直接拒答', async () => {
  for (const body of [{ question: ' ' }, { question: 'a'.repeat(501) }, { question: '你好', role: 'admin' },
    { question: '你好', batchId: 'other' }, { question: '你好', messages: [] }]) {
    assert.equal(assistantQuestionSchema.safeParse(body).success, false)
  }
  const service = createAssistantService({ ...mockModel(), async complete() { throw new Error('must not call') } })
  const reply = await service.ask(user, { question: '孕妇能吃多少丹参？' })
  assert.equal(reply.status, 'insufficient')
  assert.equal(reply.modelName, null)
  assert.deepEqual(reply.citations, [])
})

test('错误 JSON/枚举/超长/额外字段/工具调用均不能作为普通回复', async () => {
  for (const content of ['bad-json', JSON.stringify({ ...output, status: 'safe' }),
    JSON.stringify({ ...output, answer: '' }), JSON.stringify({ ...output, answer: 'x'.repeat(3_001) }),
    JSON.stringify({ ...output, sourceIds: ['invented'] })]) {
    const service = createAssistantService({ ...mockModel(), complete: async () => ({ content, toolCalls: [] }) })
    await assert.rejects(service.ask(user, { question: '你好' }), {
      code: content === 'bad-json' ? 'AI_RESULT_JSON_INVALID' : 'AI_RESULT_SCHEMA_INVALID',
    })
  }
  const tools = createAssistantService({ ...mockModel(), complete: async () => ({ content: JSON.stringify(output),
    toolCalls: [{ id: 'fake', type: 'function', function: { name: 'write', arguments: '{}' } }] }) })
  await assert.rejects(tools.ask(user, { question: '你好' }), { code: 'AI_INVALID_RESULT' })
})

test('取消/单用户并发保护，忽略取消的模型结果仍丢弃，结束后可再次提问', async () => {
  let calls = 0, release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  const service = createAssistantService({ ...mockModel(), async complete(input) {
    calls++; entered(); await gate; return mockModel().complete(input)
  } })
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(service.ask(user, { question: '你好' }, cancelled.signal), { code: 'AI_CANCELLED' })
  assert.equal(calls, 0)
  const controller = new AbortController()
  const pending = assert.rejects(service.ask(user, { question: '你好' }, controller.signal), { code: 'AI_CANCELLED' })
  await started
  await assert.rejects(service.ask(user, { question: '你好' }), { code: 'AI_QUESTION_RUNNING' })
  controller.abort(); release(); await pending
  assert.equal((await service.ask(user, { question: '你好' })).status, 'answered')
  assert.equal(calls, 2)
})

test('上游失败不自动重试且释放运行锁，手动新提问可以成功', async () => {
  let calls = 0
  const service = createAssistantService({ ...mockModel(), async complete(input) {
    if (++calls === 1) throw new HttpError(502, 'AI_UPSTREAM_ERROR', 'fixture failure')
    return mockModel().complete(input)
  } })
  await assert.rejects(service.ask(user, { question: '你好' }), { code: 'AI_UPSTREAM_ERROR' })
  assert.equal(calls, 1)
  assert.equal((await service.ask(user, { question: '你好' })).status, 'answered')
})

test('DeepSeek 普通请求不强制工具，Agent 与 JSON 请求的既有参数不变', async () => {
  const { deepseekAuditModel } = await import('../src/lib/deepseek.js')
  const { env } = await import('../src/config/env.js')
  const previousKey = env.DEEPSEEK_API_KEY, previousFetch = globalThis.fetch
  const bodies: Record<string, unknown>[] = []
  try {
    env.DEEPSEEK_API_KEY = 'test-only-key'
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string))
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'fixture' } }] }))
    }
    const request = { messages: [{ role: 'user' as const, content: 'fixture' }], signal: new AbortController().signal }
    await deepseekAuditModel.complete({ ...request, json: false })
    await deepseekAuditModel.complete({ ...request, json: false, tools: [{ type: 'function', function: {
      name: 'readonly', description: 'fixture', parameters: { type: 'object', properties: {}, additionalProperties: false },
    } }] })
    await deepseekAuditModel.complete({ ...request, json: true })
    assert.equal('tools' in bodies[0], false)
    assert.equal('tool_choice' in bodies[0], false)
    assert.equal(bodies[1].tool_choice, 'required')
    assert.deepEqual(bodies[2].response_format, { type: 'json_object' })
    assert.equal('tools' in bodies[2], false)
  } finally { env.DEEPSEEK_API_KEY = previousKey; globalThis.fetch = previousFetch }
})
test('DeepSeek 真流请求保留 JSON 模式，只转发 answer 增量而非原始 JSON/推理', async () => {
  const { env } = await import('../src/config/env.js')
  const { deepseekAuditModel } = await import('../src/lib/deepseek.js')
  const previousKey = env.DEEPSEEK_API_KEY, previousFetch = globalThis.fetch
  env.DEEPSEEK_API_KEY = 'test-key'
  const seen: string[] = []
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init!.body))
    assert.equal(body.stream, true)
    assert.deepEqual(body.response_format, { type: 'json_object' })
    assert.equal('tools' in body, false)
    const parts = ['{"status":"answered","answer":"你好', '，良木药谷。"}']
    return new Response(parts.map(content => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`).join('')
      + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  }
  try {
    const result = await deepseekAuditModel.complete({ messages: [{ role: 'user', content: '你好' }], json: true,
      signal: new AbortController().signal, onAnswer: text => { seen.push(text) } })
    assert.deepEqual(seen, ['你好', '你好，良木药谷。'])
    assert.equal(JSON.parse(result.content!).answer, seen.at(-1))
  } finally { env.DEEPSEEK_API_KEY = previousKey; globalThis.fetch = previousFetch }
})

async function httpHarness(service = createAssistantService()) {
  const users = new Map(['admin', 'grower', 'processor', 'buyer'].map((role) => [role, { ...user, id: role, role } as AuthUser]))
  const app = express()
  app.use(express.json())
  app.use('/api/assistant', createAssistantRouter({ login: async () => user, currentUser: async (id) => users.get(id)! }, service))
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/assistant/chat`
  const send = (token?: string, body: unknown = { question: '你好' }, signal?: AbortSignal) => fetch(base, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body), signal,
  })
  return { users, send, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) } }
}

test('普通聊天 HTTP 支持四角色、认证、no-store、严格请求与用户级限流', async () => {
  const h = await httpHarness(createAssistantService(mockModel()))
  try {
    const anonymous = await h.send()
    assert.equal(anonymous.status, 401)
    assert.equal(anonymous.headers.get('cache-control'), 'no-store')
    for (const role of h.users.keys()) assert.equal((await h.send(await signAccessToken(role))).status, 200)
    const token = await signAccessToken('buyer')
    assert.equal((await h.send(token, { question: '你好', messages: [] })).status, 400)
    for (let i = 0; i < 8; i++) assert.equal((await h.send(token)).status, 200)
    const limited = await h.send(token)
    assert.equal(limited.status, 429)
    assert.ok(limited.headers.get('retry-after'))
    assert.equal((await limited.json()).error.code, 'AI_RATE_LIMITED')
  } finally { await h.close() }
})

test('普通聊天模型等待期间角色变化，返回前再次检查并拒绝旧身份结果', async () => {
  const h = await httpHarness(createAssistantService({ ...mockModel(), async complete(input) {
    h.users.set('buyer', { ...user, role: 'admin' })
    return mockModel().complete(input)
  } }))
  try {
    const response = await h.send(await signAccessToken('buyer'))
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error.code, 'FORBIDDEN')
  } finally { await h.close() }
})

test('HTTP 断开会传递取消至模型，不让隐藏请求继续等待', async () => {
  let entered!: () => void, aborted!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const ended = new Promise<void>((resolve) => { aborted = resolve })
  const h = await httpHarness(createAssistantService({ ...mockModel(), async complete(input) {
    entered()
    return new Promise((_resolve, reject) => { input.signal.addEventListener('abort', () => {
      aborted(); reject(input.signal.reason)
    }, { once: true }) })
  } }))
  try {
    const controller = new AbortController()
    const pending = assert.rejects(h.send(await signAccessToken('buyer'), { question: '你好' }, controller.signal), { name: 'AbortError' })
    await started; controller.abort(); await pending; await ended
  } finally { await h.close() }
})
