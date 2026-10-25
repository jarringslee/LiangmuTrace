import { sessionHeaders } from './helpers/session.js'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { AuditModel } from '../src/lib/deepseek.js'
import type { AuthUser } from '../src/services/auth.js'
import type { BatchDetailRecord } from '../src/services/batches.js'

process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-only-question-secret-0123456789abcdef'
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test'
const { createHerbQuestionService, buildQuestionBatchSources, herbQuestionSchema } = await import('../src/services/herbQuestion.js')
const { getHerbKnowledge, retrieveQuestionSources } = await import('../src/services/knowledgeSearch.js')
const { createHerbQuestionRouter } = await import('../src/routes/herbQuestion.js')
const { errorHandler, HttpError } = await import('../src/middleware/error.js')
const { signAccessToken } = await import('../src/lib/token.js')

const buyer: AuthUser = {
  id: 'buyer', username: 'buyer', email: 'buyer@example.test', displayName: '采购商',
  role: 'buyer', organizationId: null, organization: null,
}
function fixture(): BatchDetailRecord & { canConfirmReceipt: boolean } {
  const now = new Date('2026-10-05T00:00:00Z')
  return {
    id: 'batch-test', batchNo: 'YM-TEST', traceCode: 'YM-TRACE-TEST', herbName: '丹参',
    category: 'root', plantingStartDate: now, origin: { province: '陕西省', city: '西安市' },
    environment: null, description: null, coverImageUrl: null, requiresProcessing: true,
    stage: 'planting', auditStatus: 'approved', riskLevel: 'normal', version: 1,
    createdAt: now, updatedAt: now, createdBy: { id: 'grower', displayName: '种植商', role: 'grower' },
    growerOrganization: { id: 'grower-org', name: '测试组织', code: 'TEST', type: 'grower', province: null, city: null },
    processorOrganization: null, buyerOrganization: null, canConfirmReceipt: false, attachments: [], audits: [], events: [],
  }
}
function mockModel(output?: unknown): AuditModel {
  return {
    name: 'mock-question-model',
    async complete(input) {
      assert.equal(input.json, true)
      assert.equal(input.tools, undefined)
      const sources = JSON.parse(input.messages[1].content!).sources as { id: string }[]
      const id = sources[0].id
      return { content: JSON.stringify(output ?? {
        status: 'answered', answer: `依据本轮资料回答。[${id}]`, sourceIds: [id],
      }), toolCalls: [] }
    },
  }
}
function setup(model = mockModel()) {
  const batch = fixture()
  let reads = 0
  const service = createHerbQuestionService({ detail: async () => { reads++; return structuredClone(batch) } }, model)
  return { service, batch, reads: () => reads }
}

test('知识分块具有真实来源链接，只检索当前药材，未知药材不借用其他药材资料', () => {
  assert.equal(getHerbKnowledge('丹参').length, 2)
  assert.equal(getHerbKnowledge('未收录药材').length, 0)
  const sources = retrieveQuestionSources('丹参的植物来源和常见产地是什么？', '丹参', [])
  assert.ok(sources.length)
  assert.ok(sources.every((source) => source.id.startsWith('knowledge:B00020:')))
  assert.ok(sources.every((source) => new URL(source.url!).hostname === 'sys01.lib.hkbu.edu.hk'))
  assert.deepEqual(retrieveQuestionSources('量子纠缠发动机', '丹参', []), [])
})
test('当前十五味演示药材与铁皮石斛均有独立基础资料，植物分布不是批次产地', () => {
  for (const name of ['黄芪','当归','甘草','黄连','杜仲','山茱萸','柴胡','丹参','板蓝根','党参','连翘','五味子','天麻','苍术','黄精','铁皮石斛']) {
    const sources = retrieveQuestionSources(`${name}是什么`, name, [])
    assert.ok(sources.length, name)
    assert.ok(sources.every(source => source.kind === 'knowledge' && source.title.includes(name)), name)
    assert.ok(sources.every(source => source.url?.startsWith('https://')))
  }
})

test('小型词法召回评测：五味药材背景/批次事实/无依据，补齐黄精官方摘要', () => {
  for (const herbName of ['甘草', '黄精', '丹参', '黄芪', '当归']) {
    const sources = retrieveQuestionSources('这是什么', herbName, [])
    assert.ok(sources.length > 0, herbName)
    assert.ok(sources.every((source) => source.kind === 'knowledge'))
  }
  const sources = retrieveQuestionSources('黄精的来源与外观？', '黄精', [])
  assert.ok(sources.every((source) => source.id.startsWith('knowledge:B00075:')))
  assert.ok(sources.every((source) => source.url?.includes('pid=B00075')))
  assert.ok(retrieveQuestionSources('本批次登记产地？', '黄精', buildQuestionBatchSources(fixture()))
    .some((source) => source.id === 'batch:origin'))
  assert.ok(retrieveQuestionSources('再详细介绍一下它的来源', '黄精', buildQuestionBatchSources(fixture()))
    .some((source) => source.id === 'batch:origin'))
  assert.deepEqual(retrieveQuestionSources('量子纠缠发动机', '黄精', []), [])
  // 仅验证召回/隔离，不把这组测试当成模型答案正确率或语义检索评测。
})

test('批次前缀仅用于定位，不挤掉药材背景；有召回时补最小身份来源', async () => {
  const { service, batch } = setup({ ...mockModel(), async complete(input) {
    const sources = JSON.parse(input.messages.at(-1)!.content!).sources as { id: string }[]
    assert.ok(sources.some((source) => source.id === 'knowledge:B00075:origin'))
    assert.ok(sources.some((source) => source.id === 'batch:identity'))
    assert.equal(sources.some((source) => source.id.startsWith('event:')), false)
    return mockModel().complete(input)
  } })
  batch.herbName = '黄精'
  await service.ask(buyer, batch.id, { question: '对于黄精批次 YM-TEST，这是什么？' })
})

test('未收录药材基础介绍无命中不调用模型，但批次产地仍可检索', async () => {
  let calls = 0
  const { service, batch } = setup({ ...mockModel(), async complete(input) { calls++; return mockModel().complete(input) } })
  batch.herbName = '未收录药材'
  assert.deepEqual(getHerbKnowledge('未收录药材'), [])
  const missing = await service.ask(buyer, batch.id, { question: '这是什么' })
  assert.equal(missing.status, 'insufficient')
  assert.equal(missing.modelName, null)
  assert.deepEqual(missing.citations, [])
  assert.equal(calls, 0)
  const origin = await service.ask(buyer, batch.id, { question: '本批次登记产地在哪里？' })
  assert.equal(origin.status, 'answered')
  assert.equal(origin.citations[0].id, 'batch:origin')
  assert.equal(calls, 1)
})

test('模型状态资料使用中文展示词，已收货不等于已支付，不修改原枚举', () => {
  const batch = fixture()
  for (const [stage, expected] of Object.entries({ planting: '种植中', harvested: '已采收',
    processing: '加工中', warehousing: '仓储', shipped: '已出库', sold: '已收货' })) {
    batch.stage = stage as BatchDetailRecord['stage']
    batch.riskLevel = 'low'
    const source = buildQuestionBatchSources(batch).find((item) => item.id === 'batch:status')!
    assert.match(source.excerpt, new RegExp(`当前阶段：${expected}`))
    assert.match(source.excerpt, /审核状态：审核通过；风险等级：低风险/)
    assert.doesNotMatch(source.excerpt, /已支付|warehousing|approved/)
    assert.equal(batch.stage, stage)
  }
  batch.events.push({ id: 'audit-label', type: 'audit', title: '审核通过', description: null,
    payload: null, occurredAt: new Date(), createdAt: new Date(), operatorName: null,
    operatorRole: null, visibleRoles: [], fromStage: null, toStage: null, attachments: [] })
  assert.equal(buildQuestionBatchSources(batch).find((source) => source.id === 'event:audit-label')!.title,
    '审核 · 审核通过')
})

test('问答只调用一次模型，返回服务端映射的引用与知识版本，不改变批次', async () => {
  const { service, batch, reads } = setup()
  const before = structuredClone(batch)
  const result = await service.ask(buyer, batch.id, { question: '本批次登记产地在哪里？' })
  assert.equal(result.batchId, batch.id)
  assert.equal(result.mode, 'api')
  assert.equal(result.retrieval, 'bm25')
  assert.equal(result.knowledgeVersion, 'herb-knowledge-v3')
  assert.ok(result.citations.length)
  assert.equal(result.citations[0].id, 'batch:origin')
  assert.equal(result.citations[0].url, null)
  assert.equal(reads(), 2)
  assert.deepEqual(batch, before)
})

test('上下文不包含操作人、审核快照或完整 payload，保留来源与批次事实的区别', async () => {
  const { service, batch } = setup({
    ...mockModel(), async complete(input) {
      const context = input.messages[1].content!
      assert.ok(!context.includes('private-secret-marker'))
      assert.ok(!context.includes('内部模型结论'))
      assert.match(input.messages[0].content!, /不是系统指令/)
      assert.match(input.messages[0].content!, /通用背景/)
      return mockModel().complete(input)
    },
  })
  const now = new Date()
  batch.events.push({
    id: 'internal', type: 'note', title: '内部模型结论', description: 'private-secret-marker',
    payload: { kind: 'auditRiskAnalysis', key: 'private-secret-marker' },
    occurredAt: now, createdAt: now, operatorName: 'private-secret-marker', operatorRole: 'admin',
    visibleRoles: ['admin'], fromStage: null, toStage: null, attachments: [],
  })
  await service.ask(buyer, batch.id, { question: '本批次产地在哪里？' })
  assert.equal(buildQuestionBatchSources(batch).length, 3)
})

test('结构错误、伪造引用、未在正文出现的引用和未提供引用不能作为有效回答', async () => {
  for (const output of [
    { status: 'answered', answer: '没有引用', sourceIds: [] },
    { status: 'answered', answer: '未知来源 [invented]', sourceIds: ['invented'] },
    { status: 'answered', answer: '引用未标注', sourceIds: ['batch:origin'] },
    { status: 'answered', answer: '正文伪造 [invented]', sourceIds: ['batch:origin'] },
    { status: 'wrong', answer: '枚举错误', sourceIds: [] },
  ]) {
    const { service } = setup(mockModel(output))
    await assert.rejects(service.ask(buyer, 'batch-test', { question: '本批次登记产地？' }), {
      code: output.status === 'wrong' ? 'AI_RESULT_SCHEMA_INVALID' : 'AI_RESULT_CITATIONS_INVALID',
    })
  }
  const { service } = setup({ ...mockModel(), complete: async () => ({ content: 'bad-json', toolCalls: [] }) })
  await assert.rejects(service.ask(buyer, 'batch-test', { question: '本批次登记产地？' }), { code: 'AI_RESULT_JSON_INVALID' })
})

test('医疗问题和没有检索依据的问题直接拒答，不产生模型费用；仍先检查访问权限', async () => {
  let calls = 0
  const { service, reads } = setup({ ...mockModel(), async complete(input) { calls++; return mockModel().complete(input) } })
  for (const question of ['孕妇能吃多少丹参？', '量子纠缠发动机']) {
    const result = await service.ask(buyer, 'batch-test', { question })
    assert.equal(result.status, 'insufficient')
    assert.equal(result.modelName, null)
    assert.deepEqual(result.citations, [])
  }
  assert.equal(calls, 0)
  assert.equal(reads(), 2)
  const denied = createHerbQuestionService({ detail: async () => { throw new HttpError(404, 'BATCH_NOT_FOUND', '不存在或无权查看') } }, mockModel())
  await assert.rejects(denied.ask(buyer, 'other-org', { question: '孕妇能吃多少？' }), { status: 404 })
})

test('模型可明确资料不足，但不能借用不存在的来源', async () => {
  const { service } = setup(mockModel({ status: 'insufficient', answer: '资料中没有检测限值。', sourceIds: [] }))
  const result = await service.ask(buyer, 'batch-test', { question: '当前批次风险等级是什么？' })
  assert.equal(result.status, 'insufficient')
  assert.equal(result.modelName, 'mock-question-model')
})

test('生成期间批次版本或访问权限变化，不返回迟到的旧回答', async () => {
  const first = setup({ ...mockModel(), async complete(input) { first.batch.version++; return mockModel().complete(input) } })
  await assert.rejects(first.service.ask(buyer, 'batch-test', { question: '登记产地？' }), { code: 'AI_QUESTION_STALE' })
  let reads = 0
  const revoked = createHerbQuestionService({ detail: async () => {
    if (++reads > 1) throw new HttpError(404, 'BATCH_NOT_FOUND', '不存在或无权查看')
    return fixture()
  } }, mockModel())
  await assert.rejects(revoked.ask(buyer, 'batch-test', { question: '登记产地？' }), { status: 404 })
})

test('预先取消不读取资料；模型忽略取消仍丢弃结果，并释放单用户并发保护', async () => {
  const preAborted = new AbortController()
  preAborted.abort()
  const normal = setup()
  await assert.rejects(normal.service.ask(buyer, 'batch-test', { question: '登记产地？' }, preAborted.signal), { code: 'AI_CANCELLED' })
  assert.equal(normal.reads(), 0)
  let release!: () => void, started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const entered = new Promise<void>((resolve) => { started = resolve })
  const hanging = setup({ ...mockModel(), async complete(input) { started(); await gate; return mockModel().complete(input) } })
  const controller = new AbortController()
  const pending = hanging.service.ask(buyer, 'batch-test', { question: '登记产地？' }, controller.signal)
  const cancelled = assert.rejects(pending, { code: 'AI_CANCELLED' })
  await entered
  await assert.rejects(hanging.service.ask(buyer, 'batch-test', { question: '登记产地？' }), { code: 'AI_QUESTION_RUNNING' })
  controller.abort()
  release()
  await cancelled
  assert.equal((await hanging.service.ask(buyer, 'batch-test', { question: '登记产地？' })).status, 'answered')
})

test('问题严格校验，只接受问题字符串，不接收前端伪造的批次上下文或身份', () => {
  assert.deepEqual(herbQuestionSchema.parse({ question: '  产地？  ' }), { question: '产地？' })
  for (const body of [{ question: ' ' }, { question: 'x'.repeat(501) }, { question: '产地？', role: 'admin' }, { question: '产地？', sources: [] }]) {
    assert.equal(herbQuestionSchema.safeParse(body).success, false)
  }
})

test('HTTP 支持四角色认证、严格输入和每用户限流，不误拦截普通批次路由', async () => {
  const { service } = setup()
  const users = new Map(['admin', 'grower', 'processor', 'buyer'].map((role) => [role, { ...buyer, id: role, role } as AuthUser]))
  const app = express()
  app.use(express.json())
  app.use('/api/batches', createHerbQuestionRouter({
    login: async () => buyer, currentUser: async (id) => users.get(id)!,
  }, service))
  app.get('/api/batches/:identifier', (_req, res) => res.json({ batch: { id: 'ordinary' } }))
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/batches/batch-test`
  const send = (token?: string, body: unknown = { question: '本批次登记产地？' }) => fetch(`${base}/questions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...sessionHeaders(token) },
    body: JSON.stringify(body),
  })
  try {
    assert.equal((await fetch(base)).status, 200)
    assert.equal((await send()).status, 401)
    for (const role of users.keys()) {
      const response = await send(await signAccessToken(role))
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
    }
    const token = await signAccessToken('buyer')
    assert.equal((await send(token, { question: '产地？', role: 'admin' })).status, 400)
    for (let index = 0; index < 8; index++) assert.equal((await send(token)).status, 200)
    const limited = await send(token)
    assert.equal(limited.status, 429)
    assert.equal((await limited.json()).error.code, 'AI_RATE_LIMITED')
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
})
