import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Prisma } from '@prisma/client'
import type { AuditModel, ChatMessage } from '../src/lib/deepseek.js'
import type { AuthUser } from '../src/services/auth.js'
import type { BatchDetailRecord } from '../src/services/batches.js'
import type { AssistantStore, StoredAssistantTurn } from '../src/services/assistantStore.js'

// 这里验证协议/编排/CAS 查询条件，不连接真实数据库、不调用付费模型。
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-only-conversation-secret-0123456789abcdef'
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test'
const { createAssistantConversationService, conversationMessageSchema } = await import('../src/services/assistantConversation.js')
const { createAssistantStore } = await import('../src/services/assistantStore.js')
const { createAssistantService } = await import('../src/services/assistant.js')
const { createAssistantRouter } = await import('../src/routes/assistant.js')
const { HttpError, errorHandler } = await import('../src/middleware/error.js')
const { signAccessToken } = await import('../src/lib/token.js')

const user: AuthUser = { id: 'buyer', role: 'buyer', username: 'buyer', email: 'buyer@example.test',
  displayName: '采购商', organizationId: null, organization: null }
function fixture(id = 'A', herbName = '甘草'): BatchDetailRecord & { canConfirmReceipt: boolean } {
  const now = new Date('2026-10-06T00:00:00Z')
  return { id, herbName, batchNo: `YM-${id}`, traceCode: `YM-TRACE-${id}`, category: 'root',
    plantingStartDate: now, origin: { province: '陕西省', city: '西安市' }, environment: null,
    description: null, coverImageUrl: null, requiresProcessing: true, stage: 'planting',
    auditStatus: 'approved', riskLevel: 'normal', version: 1, createdAt: now, updatedAt: now,
    createdBy: { id: 'grower', displayName: '种植商', role: 'grower' },
    growerOrganization: { id: 'grower-org', name: '测试组织', code: 'TEST', type: 'grower', province: null, city: null },
    processorOrganization: null, buyerOrganization: null, canConfirmReceipt: false, attachments: [], audits: [], events: [] }
}
function memoryStore() {
  const users = new Map<string, StoredAssistantTurn[]>()
  const store: AssistantStore = {
    read: async (id) => ({ conversationId: users.has(id) ? `conversation-${id}` : null, turns: users.get(id)?.slice(-40) ?? [] }),
    find: async (id, requestId) => users.get(id)?.find((turn) => turn.requestId === requestId) ?? null,
    async begin(actor, input) {
      const rows = users.get(actor.id) ?? []
      const previous = rows.find((turn) => turn.requestId === input.requestId)
      if (previous) return { turn: previous, claimed: false }
      if (rows.some((turn) => turn.status === 'pending' && Date.now() - turn.createdAt.getTime() <= 65_000))
        throw new HttpError(409, 'AI_QUESTION_RUNNING', 'running')
      for (const turn of rows) if (turn.status === 'pending') turn.status = 'stopped'
      const now = new Date()
      const turn: StoredAssistantTurn = { id: randomUUID(), conversationId: `conversation-${actor.id}`,
        sequence: rows.length + 1, requestId: input.requestId, question: input.question,
        requestedIdentifier: input.requestedIdentifier, actorRole: actor.role, actorOrganizationId: actor.organizationId,
        batchId: input.batch?.id ?? null, batchVersion: input.batch?.version ?? null,
        batchLabel: input.batch ? { id: input.batch.id, herbName: input.batch.herbName, batchNo: input.batch.batchNo } : null,
        status: 'pending', reply: null, errorCode: null, createdAt: now, updatedAt: now }
      rows.push(turn); users.set(actor.id, rows)
      return { turn, claimed: true }
    },
    async finish(id, turn, result) {
      const rows = users.get(id) ?? []
      if (rows.at(-1) !== turn || turn.status !== 'pending' || Date.now() - turn.createdAt.getTime() > 65_000) return null
      Object.assign(turn, { ...result, reply: result.reply ?? null, errorCode: result.errorCode ?? null })
      return turn
    },
  }
  return { store, users }
}
function setup() {
  const memory = memoryStore(), batches = new Map([['A', fixture()], ['B', fixture('B', '黄精')]])
  const actors = new Map([[user.id, { ...user }]])
  const requests: ChatMessage[][] = [], lookups: string[] = []
  const denied = new Set<string>()
  const model: AuditModel = { name: 'mock-conversation', async complete(input) {
    requests.push(input.messages)
    const last = input.messages.at(-1)!.content!
    if (last.startsWith('{')) {
      const sources = JSON.parse(last).sources as { id: string }[]
      const id = sources[0].id
      return { content: JSON.stringify({ status: 'answered', answer: `本轮依据 [${id}]`, sourceIds: [id] }), toolCalls: [] }
    }
    return { content: JSON.stringify({ status: 'answered', answer: '普通回答' }), toolCalls: [] }
  } }
  const options = { store: memory.store, model,
    auth: { currentUser: async (id: string) => actors.get(id)! },
    batches: { detail: async (_actor: AuthUser, id: string) => {
      lookups.push(id)
      const batch = [...batches.values()].find((item) => [item.id, item.batchNo, item.traceCode].includes(id))
      if (!batch || denied.has(batch.id)) throw new HttpError(404, 'BATCH_NOT_FOUND', '不存在或无权查看')
      return structuredClone(batch)
    } } }
  return { ...memory, batches, actors, requests, lookups, denied, options,
    service: createAssistantConversationService(options) }
}
const input = (question = '你好', batchIdentifier: string | null = null) => ({ requestId: randomUUID(), question, batchIdentifier })

test('请求严格校验，身份/历史/上下文不能由客户端提交', () => {
  for (const body of [{ ...input(), userId: 'other' }, { ...input(), messages: [] }, { ...input(), sources: [] },
    { ...input(), requestId: 'not-uuid' }, { ...input(), question: ' ' }, { ...input(), question: 'x'.repeat(501) }])
    assert.equal(conversationMessageSchema.safeParse(body).success, false)
})
test('同账号新服务实例恢复历史，另一个账号隔离；同 UUID 不再次调用模型', async () => {
  const h = setup(), request = input()
  const first = await h.service.send(user, request)
  const other = { ...user, id: 'other' }; h.actors.set(other.id, other)
  const reloaded = createAssistantConversationService(h.options)
  assert.equal((await reloaded.read(user)).turns.length, 1)
  assert.deepEqual((await reloaded.read(other)).turns, [])
  assert.deepEqual(await reloaded.send(user, request), first)
  assert.equal(h.requests.length, 1)
  await assert.rejects(h.service.send(user, { ...request, question: '别的问题' }), { code: 'AI_REQUEST_CONFLICT' })
})
test('查重与占用间的竞态仍不重复生成（begin claimed=false）', async () => {
  const h = setup(), request = input()
  await h.service.send(user, request)
  const raced = createAssistantConversationService({ ...h.options, store: { ...h.store, find: async () => null } })
  await raced.send(user, request)
  assert.equal(h.requests.length, 1)
})
test('带标签也能普通交流，多轮最多 4 轮，不把旧批次答案放进普通上下文', async () => {
  const h = setup()
  await h.service.send(user, input('登记产地在哪里？', 'A'))
  h.lookups.length = 0
  for (let index = 0; index < 6; index++) await h.service.send(user, input('你好', 'A'))
  const messages = h.requests.at(-1)!
  assert.equal(messages.length, 10) // system + 8 history + current
  assert.equal(h.lookups.length, 0)
  assert.ok(messages.every((message) => !message.content?.includes('本轮依据')))
  assert.match(messages[0].content!, /实际提供的历史/)
  assert.doesNotThrow(() => JSON.parse(messages[2].content!))
})

test('普通聊天追问“刚才/是什么”继承普通模式，带标签也不误转 RAG；明确批次主题仍查询', async () => {
  const h = setup()
  await h.service.send(user, input('你好', 'A'))
  h.lookups.length = 0
  const result = await h.service.send(user, input('刚才说的内容是什么？', 'A'))
  assert.equal(result.reply!.scope, 'general')
  assert.equal(h.requests.at(-1)!.length, 4)
  assert.match(h.requests.at(-1)![0].content!, /不是每轮互不相干/)
  assert.equal(JSON.parse(h.requests.at(-1)![2].content!).answer, '普通回答')
  assert.equal(h.lookups.length, 0)
  assert.equal((await h.service.send(user, input('本批次来源是什么？', 'A'))).reply!.scope, 'batch')
})
test('出现平台/系统不应覆盖具体批次事实意图，功能帮助仍走普通模式', async () => {
  const h = setup()
  for (const question of ['平台登记的本批次产地在哪里？', '系统中的这个批次现在是什么阶段？']) {
    const result = await h.service.send(user, input(question, 'A'))
    assert.equal(result.reply!.scope, 'batch', question)
    const payload = JSON.parse(h.requests.at(-1)!.at(-1)!.content!)
    assert.ok(payload.sources.some((source: { id: string }) => source.id.startsWith('batch:')))
  }
  for (const question of ['平台有哪些药材相关功能？', '系统怎么使用？', '平台客服聊天现在可以使用吗？']) {
    assert.equal((await h.service.send(user, input(question, 'A'))).reply!.scope, 'general', question)
  }
})

test('明确批次号/溯源码覆盖旧标签，多个编号澄清，无权限不入库不调用模型', async () => {
  const h = setup()
  const result = await h.service.send(user, input('对于 YM-B，这是什么', 'A'))
  assert.equal(result.batch!.id, 'B')
  assert.equal(result.reply!.scope, 'batch')
  assert.ok(result.reply!.citations.every((item) => !('excerpt' in item)))
  assert.equal((await h.service.send(user, input('YM-TRACE-A 登记产地？'))).batch!.id, 'A')
  const before = h.requests.length, reads = h.lookups.length
  const clarification = await h.service.send(user, input('比较 YM-A 和 YM-B'))
  assert.match(clarification.reply!.answer, /一次先查询一个/)
  assert.equal(h.requests.length, before); assert.equal(h.lookups.length, reads)
  h.denied.add('B')
  const count = (await h.store.read(user.id)).turns.length
  await assert.rejects(h.service.send(user, input('YM-B 的来源？')), { status: 404 })
  assert.equal((await h.store.read(user.id)).turns.length, count)
  assert.equal(h.requests.length, before)
})
test('同批次追问传真实历史但重新检索；不同批次/新版本不带旧历史', async () => {
  const h = setup()
  await h.service.send(user, input('登记产地在哪里？', 'A'))
  await h.service.send(user, input('详细说一下', 'A'))
  const followup = h.requests.at(-1)!
  assert.equal(followup.length, 4)
  assert.equal(followup[1].content, '登记产地在哪里？')
  assert.match(followup[0].content!, /事实与引用只能来自本轮 sources/)
  assert.ok(Array.isArray(JSON.parse(followup[2].content!).sourceIds))
  assert.ok(JSON.parse(followup.at(-1)!.content!).sources.some((source: { id: string }) => source.id === 'batch:origin'))
  await h.service.send(user, input('这是什么', 'B'))
  assert.equal(h.requests.at(-1)!.length, 2)
  h.batches.get('A')!.version++
  await h.service.send(user, input('登记产地在哪里？', 'A'))
  assert.equal(h.requests.at(-1)!.length, 2)
})
test('无标签批次事实先澄清；药材知识不借用旧标签，编号与药名矛盾仍澄清', async () => {
  const h = setup()
  assert.match((await h.service.send(user, input('产地在哪里？'))).reply!.answer, /提供完整批次号/)
  const knowledge = await h.service.send(user, input('介绍黄精', 'A'))
  assert.equal(knowledge.reply!.scope, 'knowledge')
  assert.equal(knowledge.batch, null)
  assert.ok(knowledge.reply!.citations.every(source => source.kind === 'knowledge'))
  assert.match((await h.service.send(user, input('YM-A 的黄精是什么'))).reply!.answer, /切换对应批次/)
  assert.equal(h.requests.length, 1)
})
test('权限撤销、组织/角色变化或批次删除，历史问题/回答/来源/标签全部隐藏', async () => {
  for (const change of ['permission', 'organization', 'role', 'deleted']) {
    const h = setup()
    await h.service.send(user, input('登记产地在哪里？', 'A'))
    const actor = { ...user }
    if (change === 'permission') h.denied.add('A')
    if (change === 'organization') actor.organizationId = 'new-org'
    if (change === 'role') actor.role = 'admin'
    if (change === 'deleted') h.users.get(user.id)![0].batchId = null
    h.actors.set(user.id, actor)
    const hidden = (await h.service.read(actor)).turns[0]
    assert.match(hidden.question, /不可查看/)
    assert.equal(hidden.batch, null); assert.deepEqual(hidden.reply!.citations, [])
    assert.ok(!JSON.stringify(hidden).includes('登记产地在哪里'))
    if (change === 'deleted') {
      await h.service.send(user, input())
      assert.equal(h.requests.at(-1)!.length, 2)
    }
  }
})
test('生成期间权限/版本改变，不能保存为成功回答', async () => {
  for (const kind of ['identity', 'version']) {
    const h = setup(), model = h.options.model
    const service = createAssistantConversationService({ ...h.options, model: { ...model, async complete(request) {
      const result = await model.complete(request)
      if (kind === 'identity') h.actors.set(user.id, { ...user, role: 'admin' })
      else h.batches.get('A')!.version++
      return result
    } } })
    await assert.rejects(service.send(user, input('登记产地在哪里？', 'A')), { code: kind === 'identity' ? 'FORBIDDEN' : 'AI_QUESTION_STALE' })
    assert.equal(h.users.get(user.id)![0].status, 'error')
    assert.equal(h.users.get(user.id)![0].reply, null)
  }
})
test('并发拒绝/取消留痕/失败不自动重试；过期 pending 不自动重新调用', async () => {
  const h = setup()
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const service = createAssistantConversationService({ ...h.options, model: { ...h.options.model, async complete(request) {
    enter(); await gate; return h.options.model.complete(request)
  } } })
  const controller = new AbortController(), request = input()
  const pending = assert.rejects(service.send(user, request, controller.signal), { code: 'AI_CANCELLED' })
  await entered
  await assert.rejects(service.send(user, input()), { code: 'AI_QUESTION_RUNNING' })
  controller.abort(); release(); await pending
  assert.equal(h.users.get(user.id)![0].status, 'stopped')
  await service.send(user, request) // replay stopped, no new model
  assert.equal(h.requests.length, 1)
  const failure = createAssistantConversationService({ ...h.options, model: { name: 'broken', async complete() {
    throw new HttpError(502, 'AI_UPSTREAM_ERROR', 'fixture')
  } } })
  await assert.rejects(failure.send(user, input()), { code: 'AI_UPSTREAM_ERROR' })
  assert.equal(h.users.get(user.id)!.at(-1)!.status, 'error')
  const expired = input()
  const { turn } = await h.store.begin(user, { ...expired, requestedIdentifier: null, batch: null })
  turn.createdAt = new Date(Date.now() - 66_000)
  assert.equal((await service.read(user)).turns.at(-1)!.status, 'stopped')
  assert.equal((await service.send(user, expired)).status, 'stopped')
  assert.equal(h.requests.length, 1)
  await service.send(user, input())
  assert.equal(h.requests.length, 2)
})

test('真实 Store 使用账号过滤与事务条件更新；过期 lease 不写旧回答', async () => {
  const calls: { operation: string; args: unknown }[] = []
  let count = 1
  const db = { assistantConversation: { findUnique: async (args: unknown) => {
    calls.push({ operation: 'read', args }); return null
  } }, assistantTurn: { findFirst: async (args: unknown) => { calls.push({ operation: 'find', args }); return null } },
    $transaction: async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => work({
      assistantConversation: { upsert: async () => ({ id: 'conversation-buyer', version: 2 }),
        updateMany: async (args: unknown) => { calls.push({ operation: 'cas', args }); return { count } } },
      assistantTurn: { findUnique: async () => null, updateMany: async () => ({ count: 0 }),
        create: async ({ data }: { data: Partial<StoredAssistantTurn> }) => ({ ...data, id: 'turn', createdAt: new Date() }),
        update: async (args: unknown) => { calls.push({ operation: 'update', args }); return {} } },
    } as unknown as Prisma.TransactionClient) } as unknown as NonNullable<Parameters<typeof createAssistantStore>[0]>
  const store = createAssistantStore(db)
  await store.read(user.id); await store.find(user.id, 'request')
  assert.deepEqual(calls[0].args, { where: { userId: user.id }, select: { id: true, turns: { orderBy: { sequence: 'desc' }, take: 40 } } })
  assert.deepEqual(calls[1].args, { where: { requestId: 'request', conversation: { userId: user.id } } })
  const { turn } = await store.begin(user, { requestId: randomUUID(), question: '你好', requestedIdentifier: null, batch: fixture() })
  assert.equal(turn.sequence, 3); assert.equal(turn.actorRole, user.role)
  const claim = calls.find((item) => item.operation === 'cas')!.args as { where: { version: number }; data: { runningUntil: Date } }
  assert.equal(claim.where.version, 2); assert.ok(claim.data.runningUntil > new Date())
  count = 0
  assert.equal(await store.finish(user.id, turn, { status: 'done', reply: {} }), null)
  assert.equal(calls.some((item) => item.operation === 'update'), false)
  const finish = calls.at(-1)!.args as { where: { userId: string; version: number; runningRequestId: string } }
  assert.equal(finish.where.userId, user.id); assert.equal(finish.where.version, 3)
  assert.equal(finish.where.runningRequestId, turn.requestId)
  await assert.rejects(store.begin(user, { requestId: randomUUID(), question: '你好', requestedIdentifier: null, batch: null }), { code: 'AI_QUESTION_RUNNING' })
})

test('会话 HTTP 认证/严格请求/no-store/表缺失提示，拒绝指定其他账号读历史', async () => {
  const h = setup(), app = express()
  app.use(express.json())
  app.use('/api/assistant', createAssistantRouter({ ...h.options.auth, login: async () => user }, createAssistantService(h.options.model), h.service))
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/assistant`
  const headers = { Authorization: `Bearer ${await signAccessToken(user.id)}`, 'Content-Type': 'application/json' }
  try {
    assert.equal((await fetch(`${base}/conversation`)).status, 401)
    assert.equal((await fetch(`${base}/conversation?userId=other`, { headers })).status, 400)
    const read = await fetch(`${base}/conversation`, { headers })
    assert.equal(read.headers.get('cache-control'), 'no-store')
    assert.deepEqual((await read.json()).turns, [])
    assert.equal((await fetch(`${base}/conversation/messages`, { headers, method: 'POST', body: JSON.stringify({ ...input(), messages: [] }) })).status, 400)
    const sent = await fetch(`${base}/conversation/messages`, { headers, method: 'POST', body: JSON.stringify(input()) })
    assert.equal(sent.status, 200); assert.equal((await sent.json()).turn.status, 'done')
    h.store.read = async () => { throw Object.assign(new Error('table missing'), { code: 'P2021' }) }
    const missing = await fetch(`${base}/conversation`, { headers })
    assert.equal(missing.status, 503); assert.equal((await missing.json()).error.code, 'ASSISTANT_STORAGE_NOT_READY')
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
})

test('新会话 HTTP 断开取消模型并持久化 stopped，不保存迟到成功结果', async () => {
  const h = setup(), app = express()
  let enter!: () => void, end!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const ended = new Promise<void>((resolve) => { end = resolve })
  const service = createAssistantConversationService({ ...h.options, model: { name: 'delayed', async complete(request) {
    enter()
    return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }))
  } } })
  const wrapped = { ...service, async send(...args: Parameters<typeof service.send>) {
    try { return await service.send(...args) } finally { end() }
  } }
  app.use(express.json())
  app.use('/api/assistant', createAssistantRouter({ ...h.options.auth, login: async () => user }, createAssistantService(h.options.model), wrapped))
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const controller = new AbortController()
    const pending = assert.rejects(fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/assistant/conversation/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${await signAccessToken(user.id)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input()), signal: controller.signal,
    }), { name: 'AbortError' })
    await entered; controller.abort(); await pending; await ended
    assert.equal(h.users.get(user.id)![0].status, 'stopped')
    assert.equal(h.users.get(user.id)![0].reply, null)
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
})

test('无关技术/命令是正常拒答，不调用模型；旧 React 历史不影响问候', async () => {
  const h = setup()
  for (const question of ['tcp和udp的区别', '/model', 'React useEffect 是什么']) {
    const result = await h.service.send(user, input(question, 'A'))
    assert.equal(result.status, 'done')
    assert.equal(result.reply!.status, 'insufficient')
    assert.match(result.reply!.answer, /很抱歉.*中药材/)
  }
  assert.equal(h.requests.length, 0)
  const old = h.users.get(user.id)![0]
  old.question = 'React 是什么'
  old.reply = { scope: 'general', answer: '继续聊 React', status: 'answered', citations: [] }
  await h.service.send(user, input('hi'))
  assert.equal(h.requests.at(-1)!.length, 2)
  assert.equal(h.users.get(user.id)!.length, 4) // 历史没有被删除。
})
test('独立知识只使用同药材历史，切药材不借用别的知识或批次来源', async () => {
  const h = setup()
  const first = await h.service.send(user, input('甘草是什么'))
  assert.equal(first.reply!.scope, 'knowledge'); assert.equal(first.batch, null)
  await h.service.send(user, input('详细说一下'))
  assert.equal(h.requests.at(-1)!.length, 4)
  await h.service.send(user, input('黄精是什么'))
  assert.equal(h.requests.at(-1)!.length, 2)
  assert.equal(h.lookups.length, 0)
})
test('山茱萸无批次与铁皮石斛带错药标签均走独立知识，不读取无关批次', async () => {
  const h = setup()
  for (const [question, identifier, name] of [['山茱萸是什么', null, '山茱萸'], ['铁皮石斛是什么', 'A', '铁皮石斛']]) {
    const result = await h.service.send(user, input(question!, identifier))
    assert.equal(result.reply!.scope, 'knowledge')
    assert.equal(result.reply!.herbName, name)
    assert.equal(result.batch, null)
    assert.ok(result.reply!.citations.every(source => source.kind === 'knowledge'))
  }
  assert.equal(h.lookups.length, 0)
})
test('知识问答之后的平台帮助含“详细”或“审核”也不能继承旧药材上下文', async () => {
  const h = setup()
  await h.service.send(user, input('山茱萸是什么'))
  for (const question of ['系统怎么使用？请详细说明角色、AI问答和通知区别。', '平台的审核功能怎么使用？']) {
    const result = await h.service.send(user, input(question))
    assert.equal(result.reply!.scope, 'general')
    assert.equal(h.requests.at(-1)!.at(-1)!.content, question)
    assert.ok(!h.requests.at(-1)!.some(message => message.content?.includes('本轮依据')))
  }
})
test('每个生成帧先复核身份；撤权后不发送正文或保存成功结果', async () => {
  const h = setup(), updates: string[] = []
  const service = createAssistantConversationService({ ...h.options, model: { ...h.options.model, async complete(request) {
    await request.onAnswer?.('允许的第一段')
    h.actors.set(user.id, { ...user, role: 'admin' })
    await request.onAnswer?.('不应泄露的第二段')
    return h.options.model.complete(request)
  } } })
  await assert.rejects(service.send(user, input('本批次登记产地', 'A'), undefined, text => { updates.push(text) }), { code: 'FORBIDDEN' })
  assert.deepEqual(updates, ['允许的第一段'])
  assert.equal(h.users.get(user.id)![0].status, 'error')
  assert.equal(h.users.get(user.id)![0].reply, null)
})
test('HTTP 真实问答 SSE 在模型结束前推正文，校验落库后才有 result；错误不伪装完成', async () => {
  const h = setup(), app = express()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const service = createAssistantConversationService({ ...h.options, model: { ...h.options.model, async complete(request) {
    await request.onAnswer?.('正在生成的正文')
    await gate
    return h.options.model.complete(request)
  } } })
  app.use(express.json()); app.use('/api/assistant', createAssistantRouter({ ...h.options.auth, login: async () => user }, createAssistantService(h.options.model), service)); app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/assistant/conversation/messages/stream`
  const headers = { Authorization: `Bearer ${await signAccessToken(user.id)}`, 'Content-Type': 'application/json' }
  try {
    const request = input('你好')
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(request) })
    assert.match(response.headers.get('content-type')!, /text\/event-stream/)
    const reader = response.body!.getReader(), decoder = new TextDecoder()
    const first = decoder.decode((await reader.read()).value)
    assert.match(first, /event: delta/); assert.doesNotMatch(first, /event: result/)
    assert.equal(h.users.get(user.id)![0].status, 'pending')
    release()
    let rest = ''
    while (true) { const part = await reader.read(); if (part.done) break; rest += decoder.decode(part.value, { stream: true }) }
    assert.match(rest, /event: result/)
    assert.equal(h.users.get(user.id)![0].status, 'done')
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...input(), messages: [] }) })).status, 400)
  } finally { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
