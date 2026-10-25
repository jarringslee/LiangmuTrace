import { sessionHeaders, loginToken } from './helpers/session.js'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { after, test } from 'node:test'
import type { Express } from 'express'
import { hash } from 'bcryptjs'
import type { Prisma } from '@prisma/client'
import type { AuthRecord } from '../src/services/auth.js'
import type {
  BatchDetailRecord,
  BatchRepository,
  BatchSummaryRecord,
} from '../src/services/batches.js'

// 测试只使用内存数据，不连接或修改真实 PostgreSQL。
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-only-secret-not-for-production-0123456789abcdef'
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test'

const { createApp } = await import('../src/app.js')
const { createAuthService } = await import('../src/services/auth.js')
const { createBatchService } = await import('../src/services/batches.js')
const { prisma } = await import('../src/lib/prisma.js')

const password = 'example-password'
const passwordHash = await hash(password, 4)
const roles = ['admin', 'grower', 'processor', 'buyer'] as const

const users = new Map<string, AuthRecord>(roles.map((role) => [role, {
  id: role,
  username: role,
  email: `${role}@example.com`,
  displayName: `${role} 测试用户`,
  role,
  status: 'active',
  passwordHash,
  organizationId: `org-${role}`,
  organization: {
    id: `org-${role}`,
    name: `${role} 组织`,
    type: role === 'admin' ? 'platform' : role,
    enabled: true,
  },
}]))

const authService = createAuthService({
  findByAccount: async (account) => [...users.values()].find(
    (user) => user.username === account || user.email.toLowerCase() === account.toLowerCase(),
  ) ?? null,
  findById: async (id) => users.get(id) ?? null,
})

function organization(id: string, type: 'grower' | 'processor') {
  return {
    id,
    code: id.toUpperCase(),
    name: `${id} 名称`,
    type,
    province: '陕西省',
    city: '西安市',
  }
}

function detailFixture(input: {
  id: string
  herbName: string
  auditStatus: 'pending' | 'approved' | 'rejected'
  stage: 'planting' | 'harvested' | 'processing' | 'warehousing' | 'shipped' | 'sold'
  growerId: string
  processorId: string | null
}): BatchDetailRecord {
  const createdAt = new Date('2026-01-01T00:00:00.000Z')
  return {
    id: input.id,
    batchNo: `BATCH-${input.id}`,
    traceCode: `TRACE-${input.id}`,
    herbName: input.herbName,
    category: 'root',
    plantingStartDate: createdAt,
    origin: { province: '陕西省', city: '西安市' },
    environment: null,
    coverImageUrl: null,
    description: null,
    requiresProcessing: true,
    stage: input.stage,
    auditStatus: input.auditStatus,
    riskLevel: 'normal',
    version: 1,
    createdAt,
    updatedAt: createdAt,
    growerOrganization: organization(input.growerId, 'grower'),
    processorOrganization: input.processorId
      ? organization(input.processorId, 'processor')
      : null,
    buyerOrganization: null,
    createdBy: {
      id: 'creator',
      displayName: '创建人',
      role: 'grower',
    },
    events: [
      {
        id: `${input.id}-public-event`,
        type: 'create',
        title: '公开建档事件',
        description: null,
        payload: null,
        occurredAt: createdAt,
        operatorName: '创建人',
        operatorRole: 'grower',
        visibleRoles: [],
        fromStage: null,
        toStage: null,
        createdAt,
        attachments: [],
      },
      {
        id: `${input.id}-admin-event`,
        type: 'audit',
        title: '管理员内部事件',
        description: null,
        payload: null,
        occurredAt: createdAt,
        operatorName: '管理员',
        operatorRole: 'admin',
        visibleRoles: ['admin'],
        fromStage: null,
        toStage: null,
        createdAt,
        attachments: [],
      },
    ],
    audits: [{
      id: `${input.id}-audit`,
      reviewerName: '管理员',
      decision: 'approved',
      source: 'manual',
      riskLevel: 'normal',
      reason: '测试审核记录',
      evidence: null,
      modelName: null,
      createdAt,
    }],
    attachments: [],
  }
}

const batches = [
  detailFixture({
    id: 'one', herbName: '黄芪', auditStatus: 'pending', stage: 'planting',
    growerId: 'org-grower', processorId: null,
  }),
  detailFixture({
    id: 'two', herbName: '当归', auditStatus: 'approved', stage: 'harvested',
    growerId: 'org-grower', processorId: null,
  }),
  detailFixture({
    id: 'three', herbName: '甘草', auditStatus: 'approved', stage: 'processing',
    growerId: 'other-grower', processorId: 'other-processor',
  }),
]

function summaryOf(batch: BatchDetailRecord): BatchSummaryRecord {
          const summary = { ...batch }
          delete (summary as Partial<typeof batch>).events
          delete (summary as Partial<typeof batch>).audits
          delete (summary as Partial<typeof batch>).attachments
  return summary
}

function scalarMatches(value: unknown, condition: unknown): boolean {
  if (condition && typeof condition === 'object' && 'contains' in condition) {
    const contains = String((condition as { contains: unknown }).contains).toLowerCase()
    return String(value).toLowerCase().includes(contains)
  }
  return value === condition
}

/** 只实现本 service 会生成的 Prisma where 子集，用于验证权限条件。 */
function matches(batch: BatchDetailRecord, where: Prisma.HerbBatchWhereInput): boolean {
  const input = where as Record<string, unknown>
  const and = input.AND
  if (Array.isArray(and) && !and.every((item) => matches(batch, item as Prisma.HerbBatchWhereInput))) return false
  const or = input.OR
  if (Array.isArray(or) && !or.some((item) => matches(batch, item as Prisma.HerbBatchWhereInput))) return false

  const values: Record<string, unknown> = {
    id: batch.id,
    traceCode: batch.traceCode,
    batchNo: batch.batchNo,
    herbName: batch.herbName,
    stage: batch.stage,
    auditStatus: batch.auditStatus,
    riskLevel: batch.riskLevel,
    growerOrganizationId: batch.growerOrganization.id,
    processorOrganizationId: batch.processorOrganization?.id ?? null,
    buyerOrganizationId: batch.buyerOrganization?.id ?? null,
  }

  return Object.entries(input).every(([key, condition]) => {
    if (key === 'AND' || key === 'OR') return true
    return scalarMatches(values[key], condition)
  })
}

const batchRepository: BatchRepository = {
  listDispatchRecipients: async () => [{ id: 'org-buyer', name: 'buyer 组织' }],
  count: async (where) => batches.filter((batch) => matches(batch, where)).length,
  list: async ({ where, skip, take }) => batches
    .filter((batch) => matches(batch, where))
    .slice(skip, skip + take)
    .map(summaryOf),
  findOne: async (where) => batches.find((batch) => matches(batch, where)) ?? null,
  create: async (input) => {
    const createdAt = new Date('2026-09-28T00:00:00.000Z')
    const batch = detailFixture({
      id: `created-${batches.length + 1}`,
      herbName: input.herbName,
      auditStatus: 'pending',
      stage: 'planting',
      growerId: input.growerOrganizationId,
      processorId: null,
    })
    batch.batchNo = input.batchNo
    batch.traceCode = input.traceCode
    batch.category = input.category
    batch.plantingStartDate = input.plantingStartDateValue
    batch.origin = input.origin
    batch.environment = input.environment ?? null
    batch.description = input.description ?? null
    batch.createdAt = createdAt
    batch.updatedAt = createdAt
    batch.createdBy = {
      id: input.creatorId,
      displayName: input.creatorName,
      role: 'grower',
    }
    batch.events = [{
      id: `${batch.id}-create-event`,
      type: 'create',
      title: '批次建档',
      description: null,
      payload: null,
      occurredAt: createdAt,
      operatorName: input.creatorName,
      operatorRole: 'grower',
      visibleRoles: [],
      fromStage: null,
      toStage: null,
      createdAt,
      attachments: [],
    }]
    batch.audits = []
    batches.push(batch)
    return batch
  },
  audit: async (input) => {
    const batch = batches.find((item) => item.id === input.batchId)
    if (!batch) throw new Error('test batch not found')
    const createdAt = new Date('2026-09-28T01:00:00.000Z')
    batch.auditStatus = input.decision
    batch.riskLevel = input.riskLevel
    batch.version += 1
    batch.updatedAt = createdAt
    batch.audits.unshift({
      id: `${batch.id}-audit-${batch.version}`,
      reviewerName: input.reviewerName,
      decision: input.decision,
      source: 'manual',
      riskLevel: input.riskLevel,
      reason: input.reason ?? null,
      evidence: null,
      modelName: null,
      createdAt,
    })
    batch.events.push({
      id: `${batch.id}-audit-event-${batch.version}`,
      type: 'audit',
      title: input.decision === 'approved' ? '管理员审核通过' : '管理员审核驳回',
      description: input.reason ?? null,
      payload: null,
      occurredAt: createdAt,
      operatorName: input.reviewerName,
      operatorRole: 'admin',
      visibleRoles: [],
      fromStage: null,
      toStage: null,
      createdAt,
      attachments: [],
    })
    return batch
  },
  appendEvent: async (input) => {
    const batch = batches.find((item) => item.id === input.batchId)
    if (!batch) throw new Error('test batch not found')
    batch.version += 1
    batch.updatedAt = input.occurredAt
    batch.events.push({
      id: `${batch.id}-note-${batch.version}`,
      type: 'note',
      title: input.title,
      description: input.description,
      payload: null,
      occurredAt: input.occurredAt,
      operatorName: input.operatorName,
      operatorRole: 'grower',
      visibleRoles: [],
      fromStage: null,
      toStage: null,
      createdAt: input.occurredAt,
      attachments: [],
    })
    return batch
  },
  harvest: async (input) => {
    const batch = batches.find((item) => item.id === input.batchId)
    if (!batch) throw new Error('test batch not found')
    const changedAt = new Date('2026-09-28T02:00:00.000Z')
    batch.stage = 'harvested'
    batch.version += 1
    batch.updatedAt = changedAt
    batch.events.push(
      {
        id: `${batch.id}-harvest-${batch.version}`,
        type: 'note',
        title: '采收登记',
        description: `采收日期：${input.harvestDate}\n采收数量：${input.yieldKg.toFixed(2)} kg`,
        payload: null,
        occurredAt: input.harvestDateValue,
        operatorName: input.operatorName,
        operatorRole: 'grower',
        visibleRoles: [],
        fromStage: null,
        toStage: null,
        createdAt: changedAt,
        attachments: [],
      },
      {
        id: `${batch.id}-stage-${batch.version}`,
        type: 'stageChange',
        title: '阶段变更：种植中 → 已采收',
        description: `采收完成：${input.yieldKg.toFixed(2)} kg`,
        payload: null,
        occurredAt: changedAt,
        operatorName: input.operatorName,
        operatorRole: 'grower',
        visibleRoles: [],
        fromStage: 'planting',
        toStage: 'harvested',
        createdAt: changedAt,
        attachments: [],
      },
    )
    return batch
  },
  receiveProcessing: async (input) => {
    const batch = batches.find((item) => item.id === input.batchId)
    if (
      !batch ||
      batch.version !== input.expectedVersion ||
      batch.stage !== 'harvested' ||
      batch.auditStatus !== 'approved' ||
      (batch.processorOrganization &&
        batch.processorOrganization.id !== input.processorOrganizationId)
    ) return null

    const changedAt = new Date('2026-09-28T03:00:00.000Z')
    batch.processorOrganization = organization(
      input.processorOrganizationId,
      'processor',
    )
    batch.stage = 'processing'
    batch.version += 1
    batch.updatedAt = changedAt
    batch.events.push({
      id: `${batch.id}-receive-${batch.version}`,
      type: 'stageChange',
      title: '阶段变更：已采收 → 加工中',
      description: '加工商已接收该批次。',
      payload: null,
      occurredAt: changedAt,
      operatorName: input.operatorName,
      operatorRole: 'processor',
      visibleRoles: [],
      fromStage: 'harvested',
      toStage: 'processing',
      createdAt: changedAt,
      attachments: [],
    })
    return batch
  },
  completeProcessing: async (input) => {
    const batch = batches.find((item) => item.id === input.batchId)
    if (
      !batch ||
      batch.version !== input.expectedVersion ||
      batch.stage !== 'processing' ||
      batch.auditStatus !== 'approved' ||
      batch.processorOrganization?.id !== input.processorOrganizationId
    ) return null

    const changedAt = new Date('2026-09-28T04:00:00.000Z')
    batch.stage = 'warehousing'
    batch.version += 1
    batch.updatedAt = changedAt
    batch.events.push(
      {
        id: `${batch.id}-processing-note-${batch.version}`,
        type: 'note',
        title: '加工完成记录',
        description: input.note,
        payload: null,
        occurredAt: changedAt,
        operatorName: input.operatorName,
        operatorRole: 'processor',
        visibleRoles: [],
        fromStage: null,
        toStage: null,
        createdAt: changedAt,
        attachments: [],
      },
      {
        id: `${batch.id}-warehousing-${batch.version}`,
        type: 'stageChange',
        title: '阶段变更：加工中 → 仓储',
        description: '加工完成，批次进入仓储阶段。',
        payload: null,
        occurredAt: changedAt,
        operatorName: input.operatorName,
        operatorRole: 'processor',
        visibleRoles: [],
        fromStage: 'processing',
        toStage: 'warehousing',
        createdAt: changedAt,
        attachments: [],
      },
    )
    return batch
  },
  saveProcessingQualityReport: async (input) => {
    const batch = batches.find((item) => item.id === input.batchId)
    if (
      !batch ||
      batch.version !== input.expectedVersion ||
      !['processing', 'warehousing'].includes(batch.stage) ||
      batch.auditStatus !== 'approved' ||
      batch.processorOrganization?.id !== input.processorOrganizationId
    ) return null

    const changedAt = new Date('2026-09-28T05:00:00.000Z')
    batch.version += 1
    batch.updatedAt = changedAt
    batch.events.push({
      id: `${batch.id}-qc-${batch.version}`,
      type: 'qcReport',
      title: '加工质检报告',
      description: input.summary,
      payload: null,
      occurredAt: changedAt,
      operatorName: input.operatorName,
      operatorRole: 'processor',
      visibleRoles: [],
      fromStage: null,
      toStage: null,
      createdAt: changedAt,
      attachments: [],
    })
    return batch
  },
  dispatch: async (input) => {
    if (input.buyerOrganizationId !== 'org-buyer') {
      const { HttpError } = await import('../src/middleware/error.js')
      throw new HttpError(400, 'INVALID_DISPATCH_RECIPIENT', '请选择有效的采购组织')
    }
    const batch = batches.find((item) => item.id === input.batchId)
    if (
      !batch ||
      batch.version !== input.expectedVersion ||
      batch.stage !== 'warehousing' ||
      batch.auditStatus !== 'approved' || batch.buyerOrganization !== null
    ) return null

    const changedAt = new Date('2026-09-28T06:00:00.000Z')
    batch.stage = 'shipped'
    batch.buyerOrganization = { id: input.buyerOrganizationId, name: 'buyer 组织' }
    batch.version += 1
    batch.updatedAt = changedAt
    batch.events.push({
      id: `${batch.id}-dispatch-${batch.version}`,
      type: 'stageChange',
      title: '阶段变更：仓储 → 已出库',
      description: '管理员已确认出库，批次进入运输环节。',
      payload: null,
      occurredAt: changedAt,
      operatorName: input.operatorName,
      operatorRole: 'admin',
      visibleRoles: [],
      fromStage: 'warehousing',
      toStage: 'shipped',
      createdAt: changedAt,
      attachments: [],
    })
    return batch
  },
  confirmReceipt: async (input) => {
    const batch = batches.find((item) => item.id === input.batchId)
    if (
      !batch ||
      batch.version !== input.expectedVersion ||
      batch.stage !== 'shipped' ||
      batch.auditStatus !== 'approved' || batch.buyerOrganization?.id !== input.buyerOrganizationId
    ) return null

    const changedAt = new Date('2026-09-28T07:00:00.000Z')
    batch.stage = 'sold'
    batch.version += 1
    batch.updatedAt = changedAt
    batch.events.push({
      id: `${batch.id}-receipt-${batch.version}`,
      type: 'stageChange',
      title: '阶段变更：已出库 → 已售',
      description: '采购商已确认收货，批次完成本次流转。',
      payload: null,
      occurredAt: changedAt,
      operatorName: input.operatorName,
      operatorRole: 'buyer',
      visibleRoles: [],
      fromStage: 'shipped',
      toStage: 'sold',
      createdAt: changedAt,
      attachments: [],
    })
    return batch
  },
}

const batchService = createBatchService(batchRepository)

async function start(app: Express) {
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

const api = await start(createApp(authService, batchService))

after(async () => {
  await api.close()
  await prisma.$disconnect()
})

async function tokenFor(account: string) {
  const role = users.get(account)!.role
  const response = await fetch(`${api.base}/api/auth/login`, {
    method: 'POST',
    headers: { ...sessionHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password, role }),
  })
  assert.equal(response.status, 200)
  return loginToken(response)
}

async function get(path: string, role?: string) {
  const token = role ? await tokenFor(role) : null
  return fetch(`${api.base}${path}`, {
    headers: sessionHeaders(token),
  })
}

async function send(
  path: string,
  role: string,
  method: 'POST' | 'PATCH',
  body: unknown,
) {
  const token = await tokenFor(role)
  return fetch(`${api.base}${path}`, {
    method,
    headers: {
      ...sessionHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

test('批次接口必须登录，并设置 no-store', async () => {
  assert.equal((await get('/api/batches')).status, 401)
  const response = await get('/api/batches', 'admin')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('四角色列表遵守数据范围', async () => {
  const expected = { admin: 3, grower: 2, processor: 1, buyer: 2 } as const
  for (const role of roles) {
    const response = await get('/api/batches?pageSize=100', role)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.items.length, expected[role])
    assert.equal(body.pagination.total, expected[role])
  }
})

test('列表支持搜索、状态筛选和分页', async () => {
  const searched = await get('/api/batches?search=当归', 'admin')
  assert.equal(searched.status, 200)
  assert.deepEqual((await searched.json()).items.map((item: { id: string }) => item.id), ['two'])

  const filtered = await get('/api/batches?auditStatus=approved&stage=processing', 'admin')
  assert.deepEqual((await filtered.json()).items.map((item: { id: string }) => item.id), ['three'])

  const paged = await get('/api/batches?page=2&pageSize=1', 'admin')
  const pageBody = await paged.json()
  assert.equal(pageBody.items.length, 1)
  assert.deepEqual(pageBody.pagination, { page: 2, pageSize: 1, total: 3, totalPages: 3 })
})

test('详情支持 ID、溯源码和批次号，并按角色过滤事件与审核记录', async () => {
  const adminResponse = await get('/api/batches/two', 'admin')
  assert.equal(adminResponse.status, 200)
  const adminBatch = (await adminResponse.json()).batch
  assert.equal(adminBatch.events.length, 2)
  assert.equal(adminBatch.audits.length, 1)
  assert.equal('createdById' in adminBatch, false)

  const buyerResponse = await get('/api/batches/TRACE-two', 'buyer')
  assert.equal(buyerResponse.status, 200)
  const buyerBatch = (await buyerResponse.json()).batch
  assert.deepEqual(buyerBatch.events.map((event: { id: string }) => event.id), ['two-public-event'])
  assert.deepEqual(buyerBatch.audits, [])
  const byBatchNo = await get('/api/batches/BATCH-two', 'buyer')
  assert.equal(byBatchNo.status, 200)
  assert.equal((await byBatchNo.json()).batch.id, 'two')
})

test('不可见批次和不存在批次统一返回 404', async () => {
  const otherOrganization = await get('/api/batches/three', 'grower')
  assert.equal(otherOrganization.status, 404)
  assert.equal((await otherOrganization.json()).error.code, 'BATCH_NOT_FOUND')
  assert.equal((await get('/api/batches/BATCH-three', 'grower')).status, 404)

  const pendingForBuyer = await get('/api/batches/one', 'buyer')
  assert.equal(pendingForBuyer.status, 404)
  assert.equal((await get('/api/batches/BATCH-one', 'buyer')).status, 404)

  const missing = await get('/api/batches/absent', 'admin')
  assert.equal(missing.status, 404)
})

test('非法分页、枚举、多余参数和非法标识返回 400', async () => {
  for (const path of [
    '/api/batches?page=0',
    '/api/batches?pageSize=101',
    '/api/batches?stage=unknown',
    '/api/batches?organizationId=other-grower',
    '/api/batches/%20',
  ]) {
    const response = await get(path, 'admin')
    assert.equal(response.status, 400, path)
    assert.equal((await response.json()).error.code, 'VALIDATION_ERROR')
  }
})

test('种植商创建待审核批次，组织与初始状态由服务端身份决定', async () => {
  const input = {
    herbName: '丹参',
    category: 'root',
    plantingStartDate: '2026-09-20',
    origin: {
      province: '陕西省',
      city: '西安市',
      district: '长安区',
    },
    environment: '测试种植环境',
    description: '测试批次',
  }
  const response = await send('/api/batches', 'grower', 'POST', input)
  assert.equal(response.status, 201)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const batch = (await response.json()).batch
  assert.equal(batch.herbName, '丹参')
  assert.equal(batch.auditStatus, 'pending')
  assert.equal(batch.stage, 'planting')
  assert.equal(batch.riskLevel, 'normal')
  assert.equal(batch.growerOrganization.id, 'org-grower')
  assert.equal(batch.createdBy.id, 'grower')
  assert.equal(batch.events[0].type, 'create')
  assert.match(batch.batchNo, /^YM-\d{4}-[A-Z0-9]{10}$/)
  assert.match(batch.traceCode, /^YM-TRACE-\d{4}-[A-Z0-9]{10}$/)

  const forbidden = await send('/api/batches', 'buyer', 'POST', input)
  assert.equal(forbidden.status, 403)

  const injected = await send('/api/batches', 'grower', 'POST', {
    ...input,
    growerOrganizationId: 'other-grower',
    auditStatus: 'approved',
  })
  assert.equal(injected.status, 400)
})

test('只有管理员可以审核，审核同时写入状态、记录和事件', async () => {
  const created = batches.at(-1)!
  const forbidden = await send(
    `/api/batches/${created.id}/audit`,
    'grower',
    'PATCH',
    { decision: 'approved' },
  )
  assert.equal(forbidden.status, 403)

  const response = await send(
    `/api/batches/${created.id}/audit`,
    'admin',
    'PATCH',
    {
      decision: 'approved',
      reason: '资料完整，人工复核通过',
      riskLevel: 'normal',
    },
  )
  assert.equal(response.status, 200)
  const batch = (await response.json()).batch
  assert.equal(batch.auditStatus, 'approved')
  assert.equal(batch.version, 2)
  assert.equal(batch.audits[0].reviewerName, 'admin 测试用户')
  assert.equal(batch.audits[0].reason, '资料完整，人工复核通过')
  assert.equal(batch.events.at(-1).type, 'audit')

  const unchanged = await send(
    `/api/batches/${created.id}/audit`,
    'admin',
    'PATCH',
    { decision: 'approved' },
  )
  assert.equal(unchanged.status, 409)
  assert.equal((await unchanged.json()).error.code, 'AUDIT_STATUS_UNCHANGED')

  const buyerCanRead = await get(`/api/batches/${created.traceCode}`, 'buyer')
  assert.equal(buyerCanRead.status, 200)
})

test('种植商只能给自己的种植中批次追加日志', async () => {
  const before = batches[0]!.events.filter(
    (event) => event.visibleRoles.length === 0 || event.visibleRoles.includes('grower'),
  ).length
  const response = await send(
    '/api/batches/one/events',
    'grower',
    'POST',
    {
      title: '苗期巡查',
      description: '长势正常，无明显病虫害。',
      occurredAt: '2026-09-27T08:30:00.000Z',
    },
  )
  assert.equal(response.status, 201)
  const batch = (await response.json()).batch
  assert.equal(batch.events.length, before + 1)
  assert.equal(batch.events.at(-1).operatorName, 'grower 测试用户')

  const otherOrganization = await send(
    '/api/batches/three/events',
    'grower',
    'POST',
    {
      title: '越权日志',
      description: '不应写入',
      occurredAt: '2026-09-27T08:30:00.000Z',
    },
  )
  assert.equal(otherOrganization.status, 404)

  const adminForbidden = await send(
    '/api/batches/one/events',
    'admin',
    'POST',
    {
      title: '管理员日志',
      description: '不应写入',
      occurredAt: '2026-09-27T08:30:00.000Z',
    },
  )
  assert.equal(adminForbidden.status, 403)
})

test('采收登记原子生成两条事件并推进阶段，重复采收被拒绝', async () => {
  const before = batches[0]!.events.filter(
    (event) => event.visibleRoles.length === 0 || event.visibleRoles.includes('grower'),
  ).length
  const response = await send(
    '/api/batches/one/harvest',
    'grower',
    'POST',
    {
      harvestDate: '2026-09-28',
      yieldKg: 128.5,
      plotArea: '一号地块',
      harvesterName: '测试采收员',
      note: '天气晴朗',
    },
  )
  assert.equal(response.status, 200)
  const batch = (await response.json()).batch
  assert.equal(batch.stage, 'harvested')
  assert.equal(batch.events.length, before + 2)
  assert.equal(batch.events.at(-2).title, '采收登记')
  assert.equal(batch.events.at(-1).type, 'stageChange')
  assert.equal(batch.events.at(-1).fromStage, 'planting')
  assert.equal(batch.events.at(-1).toStage, 'harvested')

  const repeated = await send(
    '/api/batches/one/harvest',
    'grower',
    'POST',
    { harvestDate: '2026-09-28', yieldKg: 1 },
  )
  assert.equal(repeated.status, 409)
  assert.equal((await repeated.json()).error.code, 'INVALID_BATCH_STAGE')
})

test('加工商可以认领未分配批次，并绑定当前加工组织', async () => {
  const response = await send(
    '/api/batches/two/processing/receive',
    'processor',
    'POST',
    {},
  )
  assert.equal(response.status, 200)
  const batch = (await response.json()).batch
  assert.equal(batch.stage, 'processing')
  assert.equal(batch.processorOrganization.id, 'org-processor')
  assert.equal(batch.events.at(-1).type, 'stageChange')
  assert.equal(batch.events.at(-1).fromStage, 'harvested')
  assert.equal(batch.events.at(-1).toStage, 'processing')

  const repeated = await send(
    '/api/batches/two/processing/receive',
    'processor',
    'POST',
    {},
  )
  assert.equal(repeated.status, 409)
  assert.equal((await repeated.json()).error.code, 'INVALID_BATCH_STAGE')
})

test('加工完成会写入加工记录和阶段事件，并进入仓储', async () => {
  const response = await send(
    '/api/batches/two/processing/complete',
    'processor',
    'POST',
    { note: '完成净选、切制和干燥。' },
  )
  assert.equal(response.status, 200)
  const batch = (await response.json()).batch
  assert.equal(batch.stage, 'warehousing')
  assert.equal(batch.events.at(-2).title, '加工完成记录')
  assert.equal(batch.events.at(-1).fromStage, 'processing')
  assert.equal(batch.events.at(-1).toStage, 'warehousing')

  const repeated = await send(
    '/api/batches/two/processing/complete',
    'processor',
    'POST',
    { note: '重复加工' },
  )
  assert.equal(repeated.status, 409)
  assert.equal((await repeated.json()).error.code, 'INVALID_BATCH_STAGE')
})

test('加工商可以保存质检摘要，但不能操作其他组织批次', async () => {
  const response = await send(
    '/api/batches/two/processing/quality-report',
    'processor',
    'POST',
    { summary: '水分、灰分和外观性状符合内部入库标准。' },
  )
  assert.equal(response.status, 201)
  const batch = (await response.json()).batch
  assert.equal(batch.events.at(-1).type, 'qcReport')
  assert.equal(batch.events.at(-1).operatorRole, 'processor')

  const otherOrganization = await send(
    '/api/batches/three/processing/quality-report',
    'processor',
    'POST',
    { summary: '不应写入' },
  )
  assert.equal(otherOrganization.status, 404)

  const growerForbidden = await send(
    '/api/batches/two/processing/quality-report',
    'grower',
    'POST',
    { summary: '不应写入' },
  )
  assert.equal(growerForbidden.status, 403)
})

test('只有管理员可以将仓储批次确认出库', async () => {
  const buyerForbidden = await send(
    '/api/batches/two/shipping/dispatch',
    'buyer',
    'POST',
    {},
  )
  assert.equal(buyerForbidden.status, 403)

  const response = await send(
    '/api/batches/two/shipping/dispatch',
    'admin',
    'POST',
    { buyerOrganizationId: 'org-buyer' },
  )
  assert.equal(response.status, 200)
  const batch = (await response.json()).batch
  assert.equal(batch.stage, 'shipped')
  assert.deepEqual(batch.buyerOrganization, { id: 'org-buyer', name: 'buyer 组织' })
  assert.equal(batch.events.at(-1).operatorRole, 'admin')
  assert.equal(batch.events.at(-1).fromStage, 'warehousing')
  assert.equal(batch.events.at(-1).toStage, 'shipped')

  const repeated = await send(
    '/api/batches/two/shipping/dispatch',
    'admin',
    'POST',
    { buyerOrganizationId: 'org-buyer' },
  )
  assert.equal(repeated.status, 409)
  assert.equal((await repeated.json()).error.code, 'INVALID_BATCH_STAGE')
})

test('只有采购商可以确认已出库批次收货', async () => {
  const adminForbidden = await send(
    '/api/batches/two/receipt/confirm',
    'admin',
    'POST',
    {},
  )
  assert.equal(adminForbidden.status, 403)

  const response = await send(
    '/api/batches/two/receipt/confirm',
    'buyer',
    'POST',
    {},
  )
  assert.equal(response.status, 200)
  const batch = (await response.json()).batch
  assert.equal(batch.stage, 'sold')
  assert.equal(batch.events.at(-1).operatorRole, 'buyer')
  assert.equal(batch.events.at(-1).fromStage, 'shipped')
  assert.equal(batch.events.at(-1).toStage, 'sold')

  const repeated = await send(
    '/api/batches/two/receipt/confirm',
    'buyer',
    'POST',
    {},
  )
  assert.equal(repeated.status, 409)
  assert.equal((await repeated.json()).error.code, 'INVALID_BATCH_STAGE')
})

test('出库采购组织仅管理员可查询，无额外参数，返回最小字段', async () => {
  assert.equal((await get('/api/batches/dispatch-recipients')).status, 401)
  for (const role of ['buyer', 'grower', 'processor']) {
    assert.equal((await get('/api/batches/dispatch-recipients', role)).status, 403)
  }
  const response = await get('/api/batches/dispatch-recipients', 'admin')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { items: [{ id: 'org-buyer', name: 'buyer 组织' }] })
  assert.equal((await get('/api/batches/dispatch-recipients?organizationId=other', 'admin')).status, 400)
})

test('出库必填合法收货组织，拒绝身份/状态字段注入，不改变批次或事件', async () => {
  const batch = detailFixture({ id: 'dispatch-validation', herbName: '黄芪', auditStatus: 'approved',
    stage: 'warehousing', growerId: 'org-grower', processorId: null })
  batches.push(batch)
  for (const body of [{}, { buyerOrganizationId: '' }, { buyerOrganizationId: 'not-eligible' },
    { buyerOrganizationId: 'org-buyer', operatorId: 'fake-user' },
    { buyerOrganizationId: 'org-buyer', stage: 'sold' }]) {
    assert.equal((await send(`/api/batches/${batch.id}/shipping/dispatch`, 'admin', 'POST', body)).status, 400)
    assert.equal(batch.stage, 'warehousing'); assert.equal(batch.version, 1)
    assert.equal(batch.events.length, 2); assert.equal(batch.buyerOrganization, null)
  }
})

test('他组织与历史未分配收货统一 404，浏览权限保留但收货方身份隐藏', async () => {
  const owner = users.get('buyer')!
  users.set('buyer-other', { ...owner, id: 'buyer-other', username: 'buyer-other',
    email: 'other@example.com', organizationId: 'org-other-buyer',
    organization: { ...owner.organization!, id: 'org-other-buyer' } })
  const batch = detailFixture({ id: 'receipt-scope', herbName: '黄芪', auditStatus: 'approved',
    stage: 'shipped', growerId: 'org-grower', processorId: null })
  batch.buyerOrganization = { id: 'org-buyer', name: 'buyer 组织' }
  batches.push(batch)
  const own = await (await get(`/api/batches/${batch.id}`, 'buyer')).json()
  assert.equal(own.batch.canConfirmReceipt, true)
  const other = await (await get(`/api/batches/${batch.id}`, 'buyer-other')).json()
  assert.equal(other.batch.canConfirmReceipt, false); assert.equal(other.batch.buyerOrganization, null)
  const listed = await (await get('/api/batches?pageSize=100', 'buyer-other')).json()
  assert.equal(listed.items.find((item: { id: string }) => item.id === batch.id).buyerOrganization, null)
  assert.equal((await send(`/api/batches/${batch.id}/receipt/confirm`, 'buyer-other', 'POST', {})).status, 404)
  assert.equal((await send('/api/batches/unknown/receipt/confirm', 'buyer-other', 'POST', {})).status, 404)
  assert.equal(batch.stage, 'shipped'); assert.equal(batch.version, 1)
  batch.buyerOrganization = null
  assert.equal((await send(`/api/batches/${batch.id}/receipt/confirm`, 'buyer', 'POST', {})).status, 404)
})

test('收货拒绝伪造组织；归属合法但版本竞争只返回 409，不生成第二条事件', async () => {
  const batch = batches.find((item) => item.id === 'receipt-scope')!
  batch.buyerOrganization = { id: 'org-buyer', name: 'buyer 组织' }
  assert.equal((await send(`/api/batches/${batch.id}/receipt/confirm`, 'buyer', 'POST',
    { buyerOrganizationId: 'org-buyer' })).status, 400)
  const conflictService = createBatchService({ ...batchRepository, confirmReceipt: async () => null })
  const user = await authService.currentUser('buyer')
  await assert.rejects(conflictService.confirmReceipt(user, batch.id), { status: 409, code: 'BATCH_STATE_CHANGED' })
  assert.equal(batch.stage, 'shipped'); assert.equal(batch.version, 1)
  assert.equal(batch.events.length, 2)
})
