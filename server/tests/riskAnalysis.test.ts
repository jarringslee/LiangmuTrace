import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Prisma } from '@prisma/client'
import type { AuditModel, ModelRequest } from '../src/lib/deepseek.js'
import type { AuthUser } from '../src/services/auth.js'
import type { BatchDetailRecord } from '../src/services/batches.js'
import type { RiskAnalysisRepository, RiskProgress, RiskAnalysisService } from '../src/services/riskAnalysis.js'

process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-only-risk-secret-0123456789abcdef'
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test'
const { createRiskAnalysisService, buildAuditFacts } = await import('../src/services/riskAnalysis.js')
const { createRiskAnalysisRouter } = await import('../src/routes/riskAnalysis.js')
const { errorHandler } = await import('../src/middleware/error.js')
const { signAccessToken } = await import('../src/lib/token.js')
const { HttpError } = await import('../src/middleware/error.js')

const admin: AuthUser = {
  id: 'admin', username: 'admin', email: 'admin@example.com', displayName: '管理员',
  role: 'admin', organizationId: 'platform',
  organization: { id: 'platform', name: '平台', type: 'platform' },
}
const buyer: AuthUser = { ...admin, id: 'buyer', role: 'buyer' }
const result = {
  riskLevel: 'normal', recommendation: 'approve', summary: '现有项目资料完整，由管理员复核。',
  evidence: [{ sourceId: 'batch:identity', note: '批次建档资料已读取' }],
}

function fixture(): BatchDetailRecord & { canConfirmReceipt: boolean } {
  const now = new Date('2026-10-04T06:00:00Z')
  return {
    id: 'batch-test', batchNo: 'YM-TEST', traceCode: 'YM-TRACE-TEST',
    herbName: '丹参', category: 'root', plantingStartDate: now,
    origin: { province: '陕西省', city: '西安市' }, environment: '种植环境说明',
    coverImageUrl: null, description: '测试批次', requiresProcessing: true,
    stage: 'planting', auditStatus: 'pending', riskLevel: 'normal', version: 1,
    createdAt: now, updatedAt: now,
    growerOrganization: {
      id: 'grower-org', code: 'GROWER', name: '种植组织', type: 'grower', province: '陕西省', city: '西安市',
    },
    processorOrganization: null,
    buyerOrganization: null,
    canConfirmReceipt: false,
    createdBy: { id: 'grower', displayName: '种植商', role: 'grower' },
    events: [{
      id: 'create-event', type: 'create', title: '批次建档', description: '基础信息',
      payload: null, occurredAt: now, createdAt: now, operatorName: '种植商',
      operatorRole: 'grower', visibleRoles: [], fromStage: null, toStage: null, attachments: [],
    }],
    audits: [], attachments: [],
  }
}

function mockModel(output: unknown = result): AuditModel {
  return {
    name: 'mock-audit-model',
    async complete(input) {
      if (input.json) return { content: JSON.stringify(output), toolCalls: [] }
      return {
        content: null,
        toolCalls: ['get_batch_snapshot', 'inspect_trace_records'].map((name) => ({
          id: `call-${name}`, type: 'function' as const, function: { name, arguments: '{}' },
        })),
      }
    },
  }
}

function setup(model = mockModel(), currentUser: () => Promise<AuthUser> = async () => admin) {
  const batch = fixture()
  let saveCount = 0
  let reviewCount = 0
  const repository: RiskAnalysisRepository = {
    async save({ analysis }) {
      if (batch.version !== analysis.basedOnVersion || batch.auditStatus !== 'pending') return false
      saveCount += 1
      batch.version += 1
      batch.events.push({
        ...batch.events[0], id: analysis.id, type: 'note', title: 'AI 风险分析建议',
        visibleRoles: ['admin'], payload: { kind: 'auditRiskAnalysis', analysis } as Prisma.JsonObject,
      })
      return true
    },
    async review({ analysis, review, operatorName }) {
      if (batch.version !== analysis.reviewVersion || batch.auditStatus !== 'pending') return false
      reviewCount += 1
      batch.version += 1
      batch.auditStatus = review.decision
      batch.riskLevel = review.riskLevel
      batch.audits.push({
        id: 'audit-id', reviewerName: operatorName, decision: review.decision,
        source: 'aiAssisted', riskLevel: review.riskLevel, reason: review.reason,
        evidence: { analysisId: analysis.id, analysis } as Prisma.JsonObject,
        modelName: analysis.modelName, createdAt: new Date(),
      })
      return true
    },
  }
  const service = createRiskAnalysisService({ detail: async () => structuredClone(batch) }, repository, model, { currentUser })
  return { service, batch, writes: () => ({ saveCount, reviewCount }) }
}

test('分析执行两个只读工具、记录建议但不改变审核结果，人工提交才审核', async () => {
  const { service, batch, writes } = setup()
  const analysis = await service.analyze(admin, batch.id)
  assert.deepEqual(analysis.toolCalls.map((call) => call.name), ['get_batch_snapshot', 'inspect_trace_records'])
  assert.equal(batch.auditStatus, 'pending')
  assert.equal(batch.riskLevel, 'normal')
  assert.equal(batch.version, 2)
  assert.equal(analysis.promptVersion, 'audit-risk-v2')
  assert.match(analysis.evidence[0]!.sourceText!, /丹参.*种植中/)
  assert.deepEqual(batch.events.at(-1)?.visibleRoles, ['admin'])
  assert.equal((await service.latest(admin, batch.id))?.stale, false)
  await service.review(admin, batch.id, analysis.id, {
    decision: 'approved', riskLevel: 'normal', reason: '管理员核对资料后通过',
  })
  assert.equal(batch.auditStatus, 'approved')
  assert.equal(batch.audits[0].source, 'aiAssisted')
  assert.equal(batch.audits[0].modelName, 'mock-audit-model')
  assert.equal(batch.audits[0].reviewerName, admin.displayName)
  assert.equal((await service.latest(admin, batch.id))?.stale, true)
  assert.deepEqual(writes(), { saveCount: 1, reviewCount: 1 })
})

test('资料缺失与已有风险等级不能被模型降低为正常，种植阶段不要求未发生的质检', async () => {
  const { service, batch } = setup()
  assert.deepEqual(buildAuditFacts(batch).missingInformation, [])
  batch.environment = null
  const analysis = await service.analyze(admin, batch.id)
  assert.equal(analysis.riskLevel, 'low')
  assert.equal(analysis.recommendation, 'manualReview')
  assert.match(analysis.missingInformation.join(), /种植环境/)
  assert.match(analysis.summary, /服务端规则校正/)
  batch.riskLevel = 'high'
  const repeated = await service.analyze(admin, batch.id)
  assert.equal(repeated.riskLevel, 'high')
  assert.equal(repeated.recommendation, 'manualReview')
})

test('当前阶段检查明确排除未来资料；仓储需要非空质检文字，而非占位事件', () => {
  const batch = fixture()
  for (const stage of ['planting', 'harvested', 'processing'] as const) {
    batch.stage = stage
    const facts = buildAuditFacts(batch)
    assert.deepEqual(facts.missingInformation, [])
    assert.ok(facts.reviewPolicy.notRequiredNow.some(item => item.includes('质检')))
    assert.ok(facts.reviewPolicy.excludedChecks.some(item => item.includes('PDF')))
  }
  batch.stage = 'warehousing'
  batch.events.push({ ...batch.events[0]!, id: 'empty-qc', type: 'qcReport', description: '   ' })
  assert.match(buildAuditFacts(batch).missingInformation.join(), /质检文字/)
  batch.events.at(-1)!.description = '已登记质检文字摘要，不代表真实检验认证'
  assert.deepEqual(buildAuditFacts(batch).missingInformation, [])
  batch.events.at(-1)!.title = '检'.repeat(110)
  batch.events.at(-1)!.description = '测'.repeat(600)
  assert.equal(buildAuditFacts(batch).evidence.find(item => item.sourceId === 'event:empty-qc')!.note.length, 600)
})

test('模型等待后管理员撤权/停用/换组织，不保存建议；恢复身份后运行锁可释放', async () => {
  for (const changed of [buyer, { ...admin, organizationId: 'other' }, null]) {
    let current: AuthUser | null = admin
    let revoke = true
    const h = setup({ ...mockModel(), complete: async input => {
      if (input.json && revoke) { current = changed; revoke = false }
      return mockModel().complete(input)
    } }, async () => {
      if (!current) throw new HttpError(403, 'ACCOUNT_DISABLED', '账号已停用')
      return current
    })
    await assert.rejects(h.service.analyze(admin, h.batch.id), { status: 403 })
    assert.equal(h.writes().saveCount, 0)
    current = admin
    await h.service.analyze(admin, h.batch.id)
    assert.equal(h.writes().saveCount, 1)
    current = changed
    await assert.rejects(h.service.review(admin, h.batch.id, h.batch.events.at(-1)!.id, {
      decision: 'approved', riskLevel: 'normal', reason: '不可再由旧身份审核',
    }), { status: 403 })
    assert.equal(h.writes().reviewCount, 0)
  }
})

test('v1 历史建议可读取，新建议保存服务端原文；模型不能覆盖缺失项和原文', async () => {
  const h = setup()
  const analysis = await h.service.analyze(admin, h.batch.id)
  const { stale, ...stored } = analysis
  assert.equal(stale, false)
  const noSnapshot = stored.evidence.map(({ sourceId, note }) => ({ sourceId, note }))
  h.batch.events.at(-1)!.payload = { kind: 'auditRiskAnalysis', analysis: { ...stored, evidence: noSnapshot } }
  assert.equal(await h.service.latest(admin, h.batch.id), null, '不将损坏的 v2 静默降级为无原文报告')
  const old = { ...stored, promptVersion: 'audit-risk-v1',
    evidence: noSnapshot }
  h.batch.events.at(-1)!.payload = { kind: 'auditRiskAnalysis', analysis: old }
  const restored = await h.service.latest(admin, h.batch.id)
  assert.equal(restored?.promptVersion, 'audit-risk-v1')
  assert.equal(restored?.evidence[0]!.sourceText, undefined)
})

test('不存在的引用来源、非法 JSON 和非法风险枚举被拒绝且不写建议', async () => {
  for (const output of [
    { ...result, evidence: [{ sourceId: 'invented:source', note: '伪造来源' }] },
    { ...result, riskLevel: 'safe' },
    { ...result, missingInformation: ['未来运输报告'] },
    { ...result, evidence: [{ sourceId: 'batch:identity', note: '伪造原文', sourceText: '医学安全已证明' }] },
  ]) {
    const { service, batch, writes } = setup(mockModel(output))
    await assert.rejects(service.analyze(admin, batch.id), { code: 'AI_INVALID_RESULT' })
    assert.equal(writes().saveCount, 0)
  }
  const { service, batch } = setup({
    ...mockModel(), complete: async (input) => input.json
      ? { content: 'broken json', toolCalls: [] } : mockModel().complete(input),
  })
  await assert.rejects(service.analyze(admin, batch.id), { code: 'AI_INVALID_RESULT' })
})

test('工具只能读取所选批次，拒绝写工具、额外 ID 参数和未调用工具的直接回答', async () => {
  for (const toolCalls of [
    [{ id: 'call', type: 'function' as const, function: { name: 'submit_audit', arguments: '{}' } }],
    [{ id: 'call', type: 'function' as const, function: { name: 'get_batch_snapshot', arguments: '{"batchId":"other"}' } }],
    [],
  ]) {
    const { service, batch, writes } = setup({
      name: 'invalid-tool-model', complete: async () => ({ content: null, toolCalls }),
    })
    await assert.rejects(service.analyze(admin, batch.id), { code: 'AI_TOOL_PROTOCOL_ERROR' })
    assert.equal(writes().saveCount, 0)
  }
})

test('反复取同一种资料在三轮后终止，不产生无限模型请求', async () => {
  let calls = 0
  const { service, batch } = setup({
    name: 'loop-model',
    complete: async () => {
      calls += 1
      return { content: null, toolCalls: [{
        id: `call-${calls}`, type: 'function', function: { name: 'get_batch_snapshot', arguments: '{}' },
      }] }
    },
  })
  await assert.rejects(service.analyze(admin, batch.id), { code: 'AI_TOOL_LIMIT' })
  assert.equal(calls, 3)
})

test('分析期间数据变化会拒绝保存；建议保存后数据变化会拒绝人工采纳', async () => {
  const first = setup()
  const wrapped: AuditModel = {
    ...mockModel(), complete: async (input) => {
      if (input.json) first.batch.version += 1
      return mockModel().complete(input)
    },
  }
  const service = createRiskAnalysisService(
    { detail: async () => structuredClone(first.batch) },
    { save: async ({ analysis }) => analysis.basedOnVersion === first.batch.version, review: async () => true },
    wrapped,
    { currentUser: async () => admin },
  )
  await assert.rejects(service.analyze(admin, first.batch.id), { code: 'AI_ANALYSIS_STALE' })
  const second = setup()
  const analysis = await second.service.analyze(admin, second.batch.id)
  second.batch.version += 1
  await assert.rejects(second.service.review(admin, second.batch.id, analysis.id, {
    decision: 'approved', riskLevel: 'normal', reason: '人工审核',
  }), { code: 'AI_ANALYSIS_STALE' })
  assert.equal(second.writes().reviewCount, 0)
})

test('同一批次并发请求合并保护，失败后释放锁', async () => {
  let release!: () => void
  let calls = 0
  const pending = new Promise<void>((resolve) => { release = resolve })
  const { service, batch } = setup({
    ...mockModel(), complete: async (input: ModelRequest) => {
      calls += 1
      if (calls === 1) await pending
      return mockModel().complete(input)
    },
  })
  const first = service.analyze(admin, batch.id)
  await new Promise((resolve) => setImmediate(resolve))
  await assert.rejects(service.analyze(admin, batch.id), { code: 'AI_ANALYSIS_RUNNING' })
  release()
  await first
  await service.analyze(admin, batch.id)
})

test('上游失败后释放批次锁，重试可重新发起分析', async () => {
  let failed = false
  const { service, batch } = setup({
    ...mockModel(), complete: async (input) => {
      if (!failed) { failed = true; throw new Error('模拟上游网络异常') }
      return mockModel().complete(input)
    },
  })
  await assert.rejects(service.analyze(admin, batch.id), /模拟上游网络异常/)
  assert.equal((await service.analyze(admin, batch.id)).stale, false)
})

test('未配置 Key 返回 503，上游 401 返回 502，不被误认为本系统登录失效', async () => {
  const { env } = await import('../src/config/env.js')
  const { deepseekAuditModel } = await import('../src/lib/deepseek.js')
  const originalKey = env.DEEPSEEK_API_KEY
  const originalFetch = globalThis.fetch
  const input: ModelRequest = { messages: [], json: true, signal: AbortSignal.timeout(5_000) }
  try {
    env.DEEPSEEK_API_KEY = ''
    await assert.rejects(deepseekAuditModel.complete(input), { status: 503, code: 'AI_NOT_CONFIGURED' })
    env.DEEPSEEK_API_KEY = 'test-only-key'
    globalThis.fetch = async () => new Response('upstream authentication failed', { status: 401 })
    await assert.rejects(deepseekAuditModel.complete(input), { status: 502, code: 'AI_UPSTREAM_ERROR' })
    globalThis.fetch = async () => new Response('{}')
    await assert.rejects(deepseekAuditModel.complete(input), { status: 502, code: 'AI_INVALID_RESPONSE' })
  } finally {
    env.DEEPSEEK_API_KEY = originalKey
    globalThis.fetch = originalFetch
  }
})

test('服务层拒绝非管理员、已审核批次和其他分析 ID', async () => {
  const { service, batch } = setup()
  await assert.rejects(service.analyze(buyer, batch.id), { code: 'FORBIDDEN' })
  await assert.rejects(service.latest(buyer, batch.id), { code: 'FORBIDDEN' })
  await assert.rejects(service.review(admin, batch.id, 'missing', {
    decision: 'approved', riskLevel: 'normal', reason: '人工审核',
  }), { code: 'AI_ANALYSIS_NOT_FOUND' })
  batch.auditStatus = 'approved'
  await assert.rejects(service.analyze(admin, batch.id), { code: 'BATCH_NOT_PENDING' })
})

test('HTTP 权限、严格入参和 AI 限流生效，AI 路由不拦截普通批次读取', async () => {
  const { service } = setup()
  const app = express()
  app.use(express.json())
  app.use('/api/batches', createRiskAnalysisRouter({
    login: async () => admin,
    currentUser: async (id) => id === 'admin' ? admin : buyer,
  }, service))
  app.get('/api/batches/:identifier', (_req, res) => res.json({ batch: { id: 'normal' } }))
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/batches/batch-test`
  const adminToken = await signAccessToken(admin.id)
  const buyerToken = await signAccessToken(buyer.id)
  const send = (path: string, token?: string, body?: unknown) => fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  try {
    assert.equal((await send('')).status, 200)
    assert.equal((await send('/risk-analysis')).status, 401)
    assert.equal((await send('/risk-analysis', buyerToken)).status, 403)
    assert.equal((await send('/risk-analysis', adminToken, { operatorId: 'fake' })).status, 400)
    const latest = await send('/risk-analysis', adminToken)
    assert.equal(latest.headers.get('cache-control'), 'no-store')
    assert.equal((await latest.json()).analysis, null)
    // 非法入参也计入此用户的请求频率，剩余四次可执行。
    for (let index = 0; index < 4; index += 1) {
      assert.equal((await send('/risk-analysis', adminToken, {})).status, 201)
    }
    const limited = await send('/risk-analysis', adminToken, {})
    assert.equal(limited.status, 429)
    assert.equal((await limited.json()).error.code, 'AI_RATE_LIMITED')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('过程事件序号连续，工具前后状态真实，只有校验/保存完成后返回建议', async () => {
  const { service, batch } = setup()
  const progress: RiskProgress[] = []
  await service.analyze(admin, batch.id, { onProgress: (item) => progress.push(item) })
  assert.deepEqual(progress.map((item) => item.seq), progress.map((_item, index) => index + 1))
  assert.equal(progress[0].stage, 'snapshot')
  assert.deepEqual(progress.filter((item) => item.stage === 'tool').map((item) => [item.toolName, item.status]), [
    ['get_batch_snapshot', 'running'], ['get_batch_snapshot', 'completed'],
    ['inspect_trace_records', 'running'], ['inspect_trace_records', 'completed'],
  ])
  assert.equal(progress.at(-1)?.stage, 'save')
  assert.equal(progress.at(-1)?.status, 'completed')
  assert.ok(progress.every((item) => !('analysis' in item) && !('percent' in item)))
})

test('已取消的请求不调用模型；模型忽略取消也不能继续生成或保存，锁会释放', async () => {
  const controller = new AbortController()
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  let calls = 0
  const { service, batch, writes } = setup({
    ...mockModel(), complete: async (input) => {
      calls += 1
      if (calls === 1) await pending
      return mockModel().complete(input)
    },
  })
  const alreadyCancelled = new AbortController()
  alreadyCancelled.abort()
  await assert.rejects(service.analyze(admin, batch.id, { signal: alreadyCancelled.signal }), { code: 'AI_CANCELLED' })
  assert.equal(calls, 0)
  const first = service.analyze(admin, batch.id, { signal: controller.signal })
  const rejected = assert.rejects(first, { status: 499, code: 'AI_CANCELLED' })
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  release()
  await rejected
  assert.equal(calls, 1)
  assert.equal(writes().saveCount, 0)
  await service.analyze(admin, batch.id)
  assert.equal(writes().saveCount, 1)
})

test('保存前取消不会落库；取消不误报为超时，下一次仍可分析', async () => {
  const controller = new AbortController()
  const { service, batch, writes } = setup()
  await assert.rejects(service.analyze(admin, batch.id, {
    signal: controller.signal,
    onProgress: (item) => { if (item.stage === 'save' && item.status === 'running') controller.abort() },
  }), { code: 'AI_CANCELLED' })
  assert.equal(writes().saveCount, 0)
  await service.analyze(admin, batch.id)
  assert.equal(writes().saveCount, 1)
})

async function withRiskApi(service: RiskAnalysisService, run: (base: string, token: string) => Promise<void>) {
  const app = express()
  app.use(express.json())
  app.use('/api/batches', createRiskAnalysisRouter({
    login: async () => admin, currentUser: async (id) => id === admin.id ? admin : buyer,
  }, service))
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/batches/batch-test/risk-analysis`, await signAccessToken(admin.id))
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('SSE 在模型等待时已经推送阶段，完成后以 result 终结', async () => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  let calls = 0
  const { service } = setup({
    ...mockModel(), complete: async (input) => {
      if (++calls === 1) await pending
      return mockModel().complete(input)
    },
  })
  await withRiskApi(service, async (base, token) => {
    const response = await fetch(`${base}/stream`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type')!, /text\/event-stream/)
    assert.match(response.headers.get('cache-control')!, /no-transform/)
    assert.equal(response.headers.get('x-accel-buffering'), 'no')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const first = await reader.read()
    let text = decoder.decode(first.value, { stream: true })
    assert.match(text, /event: progress/)
    assert.doesNotMatch(text, /event: result/)
    assert.equal(calls, 1)
    release()
    while (true) {
      const { value, done } = await reader.read()
      text += decoder.decode(value, { stream: !done })
      if (done) break
    }
    reader.releaseLock()
    assert.match(text, /event: result\ndata: \{"analysis":/)
    assert.doesNotMatch(text, /event: error/)
    assert.equal(calls, 2)
  })
})

test('SSE 开始前权限/入参/阶段错误仍为 HTTP JSON，两种分析接口共享限流', async () => {
  const { service, batch } = setup()
  await withRiskApi(service, async (base, token) => {
    const post = (path: string, tokenValue?: string, body?: unknown) => fetch(`${base}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(tokenValue ? { Authorization: `Bearer ${tokenValue}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    assert.equal((await post('/stream')).status, 401)
    assert.equal((await post('/stream', await signAccessToken(buyer.id))).status, 403)
    assert.equal((await post('/stream', token, { organizationId: 'fake' })).status, 400)
    batch.auditStatus = 'approved'
    const conflict = await post('/stream', token)
    assert.equal(conflict.status, 409)
    assert.match(conflict.headers.get('content-type')!, /application\/json/)
    assert.equal((await conflict.json()).error.code, 'BATCH_NOT_PENDING')
    batch.auditStatus = 'pending'
    for (let index = 0; index < 3; index += 1) {
      const response = await post('/stream', token)
      assert.equal(response.status, 200)
      await response.text()
    }
    const limited = await post('', token)
    assert.equal(limited.status, 429)
    assert.equal((await limited.json()).error.code, 'AI_RATE_LIMITED')
  })
})

test('开始 SSE 后的上游错误变为安全 error 事件，没有 result 或建议写入', async () => {
  for (const failure of [new HttpError(502, 'AI_UPSTREAM_ERROR', 'AI 暂不可用'), new Error('private provider diagnostic')]) {
    const { service, writes } = setup({ ...mockModel(), complete: async () => { throw failure } })
    await withRiskApi(service, async (base, token) => {
      const response = await fetch(`${base}/stream`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      assert.equal(response.status, 200)
      const text = await response.text()
      assert.match(text, /event: error/)
      assert.doesNotMatch(text, /event: result|private provider diagnostic/)
      assert.equal(writes().saveCount, 0)
    })
  }
})

test('浏览器中止 SSE 会取消模型请求，不落库并释放同批次保护', async () => {
  let observed!: () => void
  const aborted = new Promise<void>((resolve) => { observed = resolve })
  let calls = 0
  const { service, batch, writes } = setup({
    ...mockModel(), complete: async (input) => {
      if (++calls === 1) await new Promise<void>((_resolve, reject) => {
        input.signal.addEventListener('abort', () => { observed(); reject(input.signal.reason) }, { once: true })
      })
      return mockModel().complete(input)
    },
  })
  await withRiskApi(service, async (base, token) => {
    const controller = new AbortController()
    const response = await fetch(`${base}/stream`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
    })
    const reader = response.body!.getReader()
    await reader.read()
    controller.abort()
    await Promise.race([aborted, new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('服务端未观察到断线')), 2_000)
      timer.unref()
      void aborted.finally(() => clearTimeout(timer))
    })])
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(writes().saveCount, 0)
    await service.analyze(admin, batch.id)
    assert.equal(writes().saveCount, 1)
  })
})
