import assert from 'node:assert/strict'
import { env } from '../src/config/env.js'
import { prisma } from '../src/lib/prisma.js'

// 独立演示资料，不是正式 seed：只新增三条固定 ID，不覆盖、删除或重置业务记录。
// 没有 --write-local 时仅打印计划，不查询/修改数据库，也不调用模型。
const target = new URL(env.DATABASE_URL)
assert.ok(env.NODE_ENV !== 'production'
  && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
  && (target.port === '' || target.port === '5432')
  && target.pathname === '/liangmu_medicine', '演示准备仅限本机 liangmu_medicine 开发库，禁止公网或其他数据库')
const description = '第37刀 Agent 合成演示资料，非真实药材记录；用于完整/缺失/矛盾资料审核，不代表质量认证。'
const cases = [
  { key: 'complete', label: '资料完整', environment: '合成环境登记：种植区域与管理方式已有文字记录。',
    record: '合成建档：登记产地为甘肃省定西市，省市与基础档案一致。' },
  { key: 'missing', label: '缺少环境', environment: null,
    record: '合成建档：登记产地为甘肃省定西市，省市与基础档案一致。' },
  { key: 'conflict', label: '产地矛盾', environment: '合成环境登记：种植区域与管理方式已有文字记录。',
    record: '合成建档：该批次产地登记为陕西省宝鸡市，与基础档案的甘肃省定西市相矛盾，请核对。' },
].map((item, index) => ({ ...item, id: `risk-demo-37-${item.key}`,
  batchNo: `YM-2026-DEMO-37-${index + 1}`, traceCode: `YM-TRACE-2026-DEMO-37-${index + 1}` }))

console.log(JSON.stringify({ target: 'localhost:5432/liangmu_medicine',
  write: process.argv.includes('--write-local'), cases: cases.map(({ id, batchNo, label }) => ({ id, batchNo, label })) }))
try {
  if (process.argv.includes('--write-local')) {
    const result = await prisma.$transaction(async (tx) => {
      // 使用现有有效种植账号与组织，不创建账号，不把管理员伪装为建档种植商。
      const grower = await tx.user.findUniqueOrThrow({ where: { username: 'yuanyuhang' }, include: { organization: true } })
      assert.ok(grower.role === 'grower' && grower.status === 'active'
        && grower.organization?.type === 'grower' && grower.organization.enabled)
      const existing = await tx.herbBatch.findMany({ where: { OR: [
        { id: { in: cases.map(item => item.id) } }, { batchNo: { in: cases.map(item => item.batchNo) } },
        { traceCode: { in: cases.map(item => item.traceCode) } },
      ] } })
      // 编号撞车则整笔回滚；已存在的演示批次保留所有用户审核/编辑，不“恢复”初始值。
      for (const batch of existing) {
        const item = cases.find(item => item.id === batch.id)
        assert.ok(item && batch.batchNo === item.batchNo && batch.traceCode === item.traceCode
          && batch.description === description && batch.createdById === grower.id
          && batch.growerOrganizationId === grower.organizationId, '已有编号归属不符，禁止覆盖')
      }
      const added: string[] = []
      for (const item of cases) {
        if (existing.some(batch => batch.id === item.id)) continue
        await tx.herbBatch.create({ data: {
          id: item.id, batchNo: item.batchNo, traceCode: item.traceCode,
          herbName: `甘草（合成演示：${item.label}）`, category: 'root',
          plantingStartDate: new Date('2026-10-01T00:00:00+08:00'),
          origin: { province: '甘肃省', city: '定西市' }, environment: item.environment,
          description, requiresProcessing: true, stage: 'planting', auditStatus: 'pending', riskLevel: 'normal',
          growerOrganizationId: grower.organization!.id, createdById: grower.id,
          events: { create: { id: `${item.id}-create`, type: 'create', title: '合成演示建档',
            description: item.record, occurredAt: new Date(), operatorId: grower.id,
            operatorName: grower.displayName, operatorRole: 'grower', visibleRoles: [] } },
        } })
        added.push(item.id)
      }
      return { added, preserved: existing.map(batch => batch.id) }
    })
    console.log(JSON.stringify({ ...result, note: '直接准备的合成资料，不作为建档接口/通知业务验收；未调用 AI 或提交审核。' }))
  }
} finally {
  await prisma.$disconnect()
}
