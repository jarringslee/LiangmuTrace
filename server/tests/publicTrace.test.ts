import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { after, test } from 'node:test'
import express from 'express'
import type { PrismaClient } from '@prisma/client'
import type { PublicTraceRecord } from '../src/services/publicTrace.js'

process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'public-trace-test-only-secret-0123456789abcdef'
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test'
const { createPublicTraceRepository, createPublicTraceService } = await import('../src/services/publicTrace.js')
const { createPublicTraceRouter } = await import('../src/routes/publicTrace.js')
const { createApp } = await import('../src/app.js')
const { errorHandler, HttpError } = await import('../src/middleware/error.js')
const { prisma } = await import('../src/lib/prisma.js')
after(() => prisma.$disconnect())

const code = 'YM-TRACE-2026-0001'
function row(): PublicTraceRecord {
  return {
    traceCode: code, batchNo: 'YM-2026-GS-HQ-0318', herbName: '黄芪', category: 'root',
    origin: { province: '甘肃省', city: '定西市', district: '陇西县', address: 'private-address' },
    plantingStartDate: new Date('2025-03-12T00:00:00Z'),
    stage: 'warehousing', auditStatus: 'approved', riskLevel: 'normal',
    createdAt: new Date('2026-03-18T01:12:00Z'), updatedAt: new Date('2026-04-29T01:12:00Z'),
    growerOrganization: { name: '测试种植机构', type: 'grower', enabled: true },
    processorOrganization: { name: '测试加工机构', type: 'processor', enabled: true },
    events: [{ type: 'stageChange', occurredAt: new Date('2026-04-15T06:08:00Z'),
      fromStage: 'harvested', toStage: 'warehousing', visibleRoles: [] }],
  }
}

test('公开 DTO 逐字段白名单，剔除自由文本、账号、附件、审计与 AI 数据', async () => {
  const batch = { ...row(), id: 'private-id', description: 'private-note',
    createdBy: { email: 'private-email' }, audits: ['private-audit'], assistantTurns: ['private-ai'],
    attachments: ['private-file'] }
  Object.assign(batch.events[0], { title: 'private-title', description: 'private-event', operatorName: 'private-name' })
  const result = await createPublicTraceService({ find: async () => batch }).detail(` ${code.toLowerCase()} `)
  assert.deepEqual(result.origin, { province: '甘肃省', city: '定西市', district: '陇西县' })
  assert.equal(result.plantingStartDate, '2025-03-12')
  assert.equal(result.auditStatus, 'approved'); assert.equal(result.processorName, '测试加工机构')
  assert.deepEqual(result.events, [{ type: 'stageChange', occurredAt: '2026-04-15T06:08:00.000Z',
    fromStage: 'harvested', toStage: 'warehousing' }])
  assert.ok(!JSON.stringify(result).includes('private-'))
  assert.equal(result.eventsTruncated, false)
})

test('未知、未审核、驳回、停用种植机构、编号不匹配统一 404；非法编号不查询', async () => {
  const disabled = row(); disabled.growerOrganization.enabled = false
  const wrongOrg = row(); wrongOrg.growerOrganization.type = 'buyer'
  for (const batch of [null, { ...row(), auditStatus: 'pending' as const },
    { ...row(), auditStatus: 'rejected' as const }, disabled, wrongOrg, { ...row(), traceCode: 'OTHER' }]) {
    await assert.rejects(createPublicTraceService({ find: async () => batch }).detail(code),
      { status: 404, code: 'NOT_FOUND', message: '档案不存在或暂不可公开' })
  }
  let calls = 0
  const service = createPublicTraceService({ find: async () => { calls++; return row() } })
  for (const invalid of ['hb-0001', 'YM-TRACE-2026-', `YM-TRACE-2026-${'A'.repeat(90)}`]) {
    await assert.rejects(service.detail(invalid), { status: 404 })
  }
  assert.equal(calls, 0)
})

test('匿名节点剔除角色专属、审核/备注/交易；倒序并限制 100 条，不返回停用加工机构', async () => {
  const batch = row()
  batch.processorOrganization!.enabled = false
  const event = batch.events[0]
  batch.events = [
    ...Array.from({ length: 101 }, (_, i) => ({ ...event, occurredAt: new Date(1_700_000_000_000 + i * 1000) })),
    { ...event, visibleRoles: ['buyer'] },
    ...(['audit', 'note', 'transaction'] as const).map((type) => ({ ...event, type })),
  ]
  const result = await createPublicTraceService({ find: async () => batch }).detail(code)
  assert.equal(result.events.length, 100); assert.equal(result.eventsTruncated, true)
  assert.equal(result.processorName, undefined)
  assert.equal(result.events[0].occurredAt, new Date(1_700_000_100_000).toISOString())
  assert.ok(result.events.every((e) => e.type === 'stageChange'))
  batch.events = [{ ...event, type: 'qcReport', fromStage: 'planting', toStage: 'harvested' }]
  const qc = (await createPublicTraceService({ find: async () => batch }).detail(code)).events[0]
  assert.ok(!('fromStage' in qc)); assert.ok(!('toStage' in qc))
})

test('缺失产地与仓储失败不能伪造公开数据或静默返回演示数据', async () => {
  await assert.rejects(createPublicTraceService({ find: async () => ({ ...row(), origin: null }) }).detail(code),
    { status: 500, code: 'INVALID_PUBLIC_DATA' })
  await assert.rejects(createPublicTraceService({ find: async () => { throw new Error('db unavailable') } }).detail(code), /db unavailable/)
})

test('真实仓储查询包含公开资格条件、关系同快照、事件上限与最小 select', async () => {
  let called = false
  const db = { $transaction: async (action: (tx: unknown) => Promise<unknown>, options: unknown) => {
    assert.deepEqual(options, { isolationLevel: 'RepeatableRead' })
    return action({ herbBatch: { findFirst: async (args: {
      where: unknown; select: Record<string, unknown> & { events: { take: number; where: unknown; select: object; orderBy: unknown } }
    }) => {
      called = true
      assert.deepEqual(args.where, { traceCode: code, auditStatus: 'approved', growerOrganization: { enabled: true, type: 'grower' } })
      assert.equal(args.select.events.take, 101)
      assert.deepEqual(args.select.events.where, { visibleRoles: { isEmpty: true },
        type: { in: ['create', 'stageChange', 'qcReport', 'storage', 'transport'] } })
      assert.deepEqual(args.select.events.orderBy, [{ occurredAt: 'desc' }, { id: 'asc' }])
      for (const key of ['id', 'createdBy', 'description', 'environment', 'attachments', 'audits', 'assistantTurns']) {
        assert.ok(!(key in args.select))
      }
      for (const key of ['title', 'description', 'payload', 'operatorName', 'operatorId', 'attachments']) {
        assert.ok(!(key in args.select.events.select))
      }
      return row()
    } } })
  } } as unknown as PrismaClient
  assert.equal((await createPublicTraceRepository(db).find(code))!.traceCode, code)
  assert.ok(called)
})

test('HTTP 无登录/坏 Token 仍可读公开数据；完整详情仍 401，参数严格且 no-store', async () => {
  let calls = 0
  const service = createPublicTraceService({ find: async (identifier) => { calls++; return identifier === code ? row() : null } })
  const app = createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service)
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  try {
    const url = `${base}/public/trace/${code}`
    const ok = await fetch(url)
    assert.equal(ok.status, 200); assert.equal(ok.headers.get('cache-control'), 'no-store')
    assert.equal((await ok.json()).batch.traceCode, code)
    assert.equal((await fetch(url, { headers: { Cookie: 'liangmu_session=expired-or-forged' } })).status, 200)
    assert.equal((await fetch(`${base}/batches/${code}`)).status, 401)
    for (const invalidUrl of [url + '?role=admin', url + '?organizationId=other', `${base}/public/trace/hb-0001`]) {
      const response = await fetch(invalidUrl)
      assert.equal(response.status, 400); assert.equal(response.headers.get('cache-control'), 'no-store')
    }
    assert.equal(calls, 2)
    const missing = await fetch(`${base}/public/trace/YM-TRACE-2026-UNKNOWN`)
    assert.equal(missing.status, 404); assert.equal(missing.headers.get('cache-control'), 'no-store')
    assert.equal((await missing.json()).error.message, '档案不存在或暂不可公开')
    assert.equal((await fetch(url, { method: 'POST', headers: { 'X-Liangmu-CSRF': '1' } })).status, 404)
    assert.equal((await fetch(`${base}/public/trace`)).status, 404)
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
})

test('匿名接口按 IP 限流；429、失败响应也 no-store，不提供写入口', async () => {
  let calls = 0
  const service = createPublicTraceService({ find: async () => { calls++; throw new HttpError(503, 'UNAVAILABLE', '稍后重试') } })
  const app = express().use('/api/public/trace', createPublicTraceRouter(service, 2)).use(errorHandler)
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/public/trace/${code}`
  try {
    for (let i = 0; i < 2; i++) assert.equal((await fetch(url)).status, 503)
    const limited = await fetch(url)
    assert.equal(limited.status, 429); assert.equal(limited.headers.get('cache-control'), 'no-store')
    assert.ok(limited.headers.get('retry-after'))
    assert.equal((await limited.json()).error.code, 'PUBLIC_TRACE_RATE_LIMITED')
    assert.equal(calls, 2)
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
})
