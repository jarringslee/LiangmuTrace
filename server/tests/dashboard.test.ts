import { sessionHeaders } from './helpers/session.js'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { after, test } from 'node:test'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/services/auth.js'
import type { DashboardSnapshot } from '../src/services/dashboard.js'

process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'dashboard-test-only-secret-0123456789abcdef'
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test'
const { createDashboardService, createDashboardRepository } = await import('../src/services/dashboard.js')
const { createApp } = await import('../src/app.js')
const { createAuthService } = await import('../src/services/auth.js')
const { signAccessToken } = await import('../src/lib/token.js')
const { prisma } = await import('../src/lib/prisma.js')
after(() => prisma.$disconnect())

const admin: AuthUser = { id: 'admin', username: 'admin', email: 'admin@example.test', displayName: '管理员',
  role: 'admin', organizationId: null, organization: null }
const empty: DashboardSnapshot = { groups: [], recent: [], pending: [] }
const row = (id = 'b1') => ({ id, batchNo: `YM-${id}`, traceCode: `TRACE-${id}`, herbName: '黄精',
  growerOrganization: { name: '组织一' }, stage: 'warehousing' as const, auditStatus: 'pending' as const,
  riskLevel: 'low' as const, updatedAt: new Date('2026-10-05T16:30:00Z') })
const snapshot: DashboardSnapshot = {
  groups: [
    { stage: 'warehousing', category: 'root', auditStatus: 'pending', riskLevel: 'low', count: 3 },
    { stage: 'planting', category: 'wholeHerb', auditStatus: 'approved', riskLevel: 'normal', count: 102 },
    { stage: 'processing', category: 'root', auditStatus: 'rejected', riskLevel: 'high', count: 5 },
  ], recent: Array.from({ length: 6 }, (_, index): DashboardSnapshot['recent'][number] => index < 3
    ? row(`b${index}`) : { ...row(`b${index}`), stage: 'planting', auditStatus: 'approved', riskLevel: 'normal' }),
  pending: Array.from({ length: 3 }, (_, index) => row(`b${index}`)),
}

test('全量统计不受最近列表限制；风险含低中高，仓储与审核互相独立', async () => {
  const result = await createDashboardService({ read: async () => snapshot }).overview(admin)
  assert.equal(result.mode, 'api')
  assert.deepEqual(result.summary, { totalBatches: 110, pendingAuditBatches: 3, riskBatches: 8, warehousingBatches: 3 })
  assert.equal(result.recentBatches.length, 6)
  assert.equal(result.stageDistribution.reduce((n, r) => n + r.count, 0), 110)
  assert.equal(result.categoryDistribution.find((r) => r.category === 'root')!.count, 8)
  assert.equal(result.stageDistribution.find((r) => r.stage === 'sold')!.count, 0)
  assert.equal(result.categoryDistribution.length, 7)
  assert.equal(result.recentBatches[0].updatedAt, '2026-10-05T16:30:00.000Z')
  assert.equal(result.recentBatches[0].growerName, '组织一')
  assert.ok(!('growerOrganization' in result.recentBatches[0]))
  assert.ok(!('transactionAmount' in result.summary))
})

test('空数据库返回零统计与空列表，不以固定样例补齐', async () => {
  const result = await createDashboardService({ read: async () => empty }).overview(admin)
  assert.ok(Object.values(result.summary).every((n) => n === 0))
  assert.ok(result.stageDistribution.every((r) => r.count === 0))
  assert.deepEqual(result.recentBatches, []); assert.deepEqual(result.pendingBatches, [])
})

test('业务层独立拒绝非管理员，拒绝前不查询数据；数据库失败不伪造零统计', async () => {
  let calls = 0
  const service = createDashboardService({ read: async () => { calls++; throw new Error('db unavailable') } })
  for (const role of ['buyer', 'grower', 'processor'] as const) {
    await assert.rejects(service.overview({ ...admin, role }), { status: 403, code: 'FORBIDDEN' })
  }
  assert.equal(calls, 0)
  await assert.rejects(service.overview(admin), /db unavailable/)
})

test('Prisma 仓储使用同一只读 RepeatableRead 快照，聚合全量且两列表有固定上限', async () => {
  const calls: { method: string; args: unknown }[] = []
  const db = { $transaction: async (action: (tx: unknown) => Promise<unknown>, options: unknown) => {
    assert.deepEqual(options, { isolationLevel: 'RepeatableRead' })
    return action({ herbBatch: {
      groupBy: async (args: unknown) => { calls.push({ method: 'groupBy', args }); return snapshot.groups.map(({ count, ...g }) => ({ ...g, _count: { _all: count } })) },
      findMany: async (args: unknown) => { calls.push({ method: 'findMany', args }); return [row()] },
    } })
  } } as unknown as PrismaClient
  const result = await createDashboardRepository(db).read()
  assert.deepEqual(result.groups, snapshot.groups)
  assert.deepEqual(calls[0].args, { by: ['stage', 'category', 'auditStatus', 'riskLevel'], _count: { _all: true } })
  const recent = calls[1].args as { take: number; orderBy: unknown; where?: unknown; select: object }
  const pending = calls[2].args as { take: number; where: unknown }
  assert.equal(recent.take, 6); assert.equal(recent.where, undefined)
  assert.deepEqual(recent.orderBy, [{ updatedAt: 'desc' }, { id: 'asc' }])
  assert.equal(pending.take, 5); assert.deepEqual(pending.where, { auditStatus: 'pending' })
  assert.ok(!('events' in recent.select)); assert.ok(!('audits' in recent.select))
})

test('HTTP 认证、四角色拦截、no-store、严格参数和停用账号检查', async () => {
  let disabled = false, reads = 0
  const auth = createAuthService({ findByAccount: async () => null, findById: async (id) => ({
    ...admin, id, username: id, role: id as AuthUser['role'], status: disabled ? 'disabled' : 'active',
    passwordHash: 'unused', organizationId: `org-${id}`,
    organization: { id: `org-${id}`, name: '测试组织', type: id === 'admin' ? 'platform' : id as 'buyer' | 'grower' | 'processor', enabled: true },
  }) })
  const service = createDashboardService({ read: async () => { reads++; return empty } })
  const app = createApp(auth, undefined, undefined, undefined, undefined, undefined, undefined, service)
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/dashboard/overview`
  try {
    assert.equal((await fetch(url)).status, 401)
    for (const role of ['buyer', 'grower', 'processor']) {
      assert.equal((await fetch(url, { headers: { ...sessionHeaders(await signAccessToken(role)) } })).status, 403)
    }
    assert.equal(reads, 0)
    const headers = { ...sessionHeaders(await signAccessToken('admin')) }
    const ok = await fetch(url, { headers })
    assert.equal(ok.status, 200); assert.equal(ok.headers.get('cache-control'), 'no-store')
    assert.equal((await ok.json()).summary.totalBatches, 0)
    assert.equal((await fetch(url + '?organizationId=other', { headers })).status, 400)
    assert.equal(reads, 1)
    disabled = true
    assert.equal((await fetch(url, { headers })).status, 403); assert.equal(reads, 1)
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
})
