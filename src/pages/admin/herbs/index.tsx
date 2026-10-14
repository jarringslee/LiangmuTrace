import { lazy, Suspense, useMemo, useRef, useState } from 'react'
import {
  App as AntdApp,
  Breadcrumb,
  Button,
  Card,
  Dropdown,
  Empty,
  Flex,
  Input,
  Layout,
  Modal,
  Select,
  Space,
  Table,
  Typography,
  theme,
  Alert,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  EyeOutlined,
  MedicineBoxOutlined,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined,
  SendOutlined,
  RobotOutlined
} from '@ant-design/icons'
import { Link, useNavigate } from 'react-router-dom'
import {
  AUDIT_LABEL,
  STAGE_LABEL,
  type AuditStatus,
  type HerbBatch,
  type Stage,
} from '../../../types/herb'
import {
  useHerbBatchMutations,
  useHerbBatches,
} from '../../../hooks/useHerbBatches'
import BatchQueryError from '../../../components/herb/BatchQueryError'
import { AuditTag, RiskTag, StageTag } from '../../../components/herb/herbTags'
import { MessageBell } from '../../../components/MessageBell'
import '../../dashboard/index.less'
import './herbs.less'

import type { AuditDecision } from '../../../services/herbDataSource'
import { authMode } from '../../../config/api'

import { useAuth } from '../../../hooks/useAuth'

import RiskAnalysisDrawer from '../../../components/herb/RiskAnalysisDrawer'

import { useDispatchRecipients } from '../../../hooks/useDispatchRecipients'

const { Header, Content } = Layout
const { Text, Title, Paragraph } = Typography
const AccountManager = lazy(() => import('../../../components/account/AccountManager'))

const STAGE_OPTIONS: { value: Stage | 'all'; label: string }[] = [
  { value: 'all', label: '全部阶段' },
  ...(Object.keys(STAGE_LABEL) as Stage[]).map((s) => ({ value: s, label: STAGE_LABEL[s] })),
]

const AUDIT_OPTIONS: { value: AuditStatus | 'all'; label: string }[] = [
  { value: 'all', label: '全部审核' },
  ...(Object.keys(AUDIT_LABEL) as AuditStatus[]).map((s) => ({
    value: s,
    label: AUDIT_LABEL[s],
  })),
]

export default function AdminHerbsPage() {
  const { message, modal } = AntdApp.useApp()
  const { token } = theme.useToken()
  const navigate = useNavigate()
  const { session } = useAuth()
  const { data, loading, error, reload } = useHerbBatches()

  const {
    setAudit: auditMutation,
    dispatch,
  } = useHerbBatchMutations()

  const [keyword, setKeyword] = useState('')
  const [accountsOpen, setAccountsOpen] = useState(false)
  const [stage, setStage] = useState<Stage | 'all'>('all')
  const [audit, setAudit] = useState<AuditStatus | 'all'>('all')

  const [riskBatchId, setRiskBatchId] =
    useState<string | null>(null)

  // 只保存选中 ID，批次内容始终从最新查询结果取得。
  const riskBatch =
    data.find((batch) => batch.id === riskBatchId) ?? null
  const pendingBatches = data.filter((batch) => batch.auditStatus === 'pending')

  const [dispatchBatchId, setDispatchBatchId] =
    useState<string | null>(null)

  const [buyerOrganizationId, setBuyerOrganizationId] =
    useState<string | undefined>(undefined)

  // 同步防重入锁，不承担页面 loading 状态。
  const dispatchLock = useRef(false)

  // 只保存 ID，不再保存一份可能过期的批次对象。
  const dispatchBatch =
    data.find((batch) => batch.id === dispatchBatchId) ?? null

  const recipientsQuery =
    useDispatchRecipients(dispatchBatchId !== null)

  const recipients = recipientsQuery.data ?? []

  const selectedRecipient = recipients.find(
    (recipient) => recipient.id === buyerOrganizationId,
  )

  const recipientsReady =
    recipientsQuery.isSuccess &&
    !recipientsQuery.isFetching &&
    !recipientsQuery.isPaused

  const batchCanDispatch =
    dispatchBatch !== null &&
    dispatchBatch.stage === 'warehousing' &&
    dispatchBatch.auditStatus === 'approved' &&
    !dispatchBatch.buyerId

  const canDispatch =
    session?.role === 'admin' &&
    batchCanDispatch &&
    selectedRecipient !== undefined &&
    recipientsReady &&
    !loading &&
    !error

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return data.filter((b) => {
      if (stage !== 'all' && b.stage !== stage) return false
      if (audit !== 'all' && b.auditStatus !== audit) return false
      if (!kw) return true
      return (
        b.herbName.toLowerCase().includes(kw) ||
        b.batchNo.toLowerCase().includes(kw) ||
        b.traceCode.toLowerCase().includes(kw) ||
        b.growerName.toLowerCase().includes(kw)
      )
    })
  }, [data, keyword, stage, audit])

  const handleAudit = async (
    id: string,
    decision: AuditDecision,
  ) => {
    try {
      await auditMutation.mutateAsync({
        id,
        decision,
      })
      message.success(`已更新为：${AUDIT_LABEL[decision]}`)
    } catch (e) {
      message.error(`更新失败：${(e as Error).message}`)
    }
  }

  const confirmAudit = (
    row: HerbBatch,
    next: AuditDecision,
  ) => {
    if (row.auditStatus === next) {
      message.info(`当前已是「${AUDIT_LABEL[next]}」状态`)
      return
    }
    modal.confirm({
      title: `确认将该批次置为「${AUDIT_LABEL[next]}」？`,
      content: `批次：${row.batchNo} · ${row.herbName}`,
      okText: '确认',
      cancelText: '取消',
      onOk: () => handleAudit(row.id, next),
    })
  }

  const confirmDispatch = (row: HerbBatch) => {
    if (dispatchLock.current || dispatch.isPending) return

    if (
      loading ||
      error ||
      row.stage !== 'warehousing' ||
      row.auditStatus !== 'approved' ||
      row.buyerId
    ) {
      message.warning('仅审核通过且未分配的仓储批次可以出库')
      return
    }

    // 每次打开都重新选择，不默认分配第一个采购组织。
    setBuyerOrganizationId(undefined)
    setDispatchBatchId(row.id)
  }

  const closeDispatch = () => {
    if (dispatchLock.current || dispatch.isPending) return

    setDispatchBatchId(null)
    setBuyerOrganizationId(undefined)
  }

  const handleDispatch = async () => {
    if (dispatchLock.current || dispatch.isPending) return

    if (!dispatchBatch || !selectedRecipient || !canDispatch) {
      message.warning('请等待数据加载完成，并选择有效的采购组织')
      return
    }

    dispatchLock.current = true

    try {
      await dispatch.mutateAsync({
        batchId: dispatchBatch.id,
        input: {
          buyerOrganizationId: selectedRecipient.id,
        },
      })

      message.success(`已出库至「${selectedRecipient.name}」`)
      setDispatchBatchId(null)
      setBuyerOrganizationId(undefined)
    } catch (error) {
      message.error(`出库失败：${(error as Error).message}`)

      // 更新查询信息，不自动重试出库写操作。
      reload()
      void recipientsQuery.refetch()
    } finally {
      dispatchLock.current = false
    }
  }

  const columns: ColumnsType<HerbBatch> = [
    {
      title: '封面',
      key: 'cover',
      width: 80,
      render: (_, row) => (
        <span
          className="herb-admin__thumb"
          aria-label={row.herbName}
          style={{
            backgroundImage: `url(${row.coverImageUrl ?? '/images/herbs/placeholder.svg'})`,
          }}
        />
      ),
    },
    {
      title: '药材',
      key: 'herb',
      render: (_, row) => (
        <div style={{ minWidth: 120 }}>
          <Text strong>{row.herbName}</Text>
        </div>
      ),
    },
    {
      title: '批次号',
      dataIndex: 'batchNo',
      key: 'batchNo',
      width: 200,
      ellipsis: true,
    },
    {
      title: '溯源码',
      dataIndex: 'traceCode',
      key: 'traceCode',
      width: 200,
      ellipsis: true,
      render: (code: string) => <Text copyable={{ text: code }}>{code}</Text>,
    },
    {
      title: '种植商',
      dataIndex: 'growerName',
      key: 'growerName',
      ellipsis: true,
    },
    {
      title: '阶段',
      dataIndex: 'stage',
      key: 'stage',
      width: 100,
      render: (s: HerbBatch['stage']) => <StageTag stage={s} />,
    },
    {
      title: '审核',
      dataIndex: 'auditStatus',
      key: 'auditStatus',
      width: 100,
      render: (s: HerbBatch['auditStatus']) => <AuditTag status={s} />,
    },
    {
      title: '风险',
      dataIndex: 'riskLevel',
      key: 'riskLevel',
      width: 88,
      render: (s: HerbBatch['riskLevel']) => <RiskTag level={s} />,
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 150,
    },
    {
      title: '操作',
      key: 'actions',
      width: 360,
      fixed: 'right',
      render: (_, row) => (
        <Space size={4}>
          <Button
            type="link"
            size="small"
            icon={<EyeOutlined />}
            onClick={() => navigate(`/trace/${row.traceCode}`, { state: { fromInternal: true } })}
          >
            查看
          </Button>
          <Button
            type="link"
            size="small"
            icon={<RobotOutlined />}
            onClick={() => setRiskBatchId(row.id)}
          >
            {row.auditStatus === 'pending' ? 'Agent 审核' : '查看 AI 建议'}
          </Button>
          {row.stage === 'warehousing' ? (
            <Button
              type="link"
              size="small"
              icon={<SendOutlined />}
              loading={
                dispatch.isPending &&
                dispatch.variables?.batchId === row.id
              }
              disabled={
                row.auditStatus !== 'approved' ||
                !!row.buyerId ||
                dispatch.isPending ||
                loading ||
                !!error
              }
              onClick={() => confirmDispatch(row)}
            >
              确认出库
            </Button>
          ) : null}
          <Dropdown
            menu={{
              items: [
                {
                  key: 'approved',
                  icon: <CheckCircleOutlined style={{ color: token.colorSuccess }} />,
                  label: '审核通过',
                },
                {
                  key: 'rejected',
                  icon: <CloseCircleOutlined style={{ color: token.colorError }} />,
                  label: '驳回',
                },
              ],
              onClick: ({ key }) =>
                confirmAudit(row, key as AuditDecision),
            }}
          >
            <Button
              type="text"
              size="small"
              icon={<MoreOutlined />}
              loading={
                auditMutation.isPending &&
                auditMutation.variables?.id === row.id
              }
            >
              审核
            </Button>
          </Dropdown>
        </Space>
      ),
    },
  ]

  return (
    <Layout className="admin-dashboard herb-admin">
      <Header className="admin-dashboard__header">
        <Flex align="center" justify="space-between" style={{ width: '100%' }}>
          <Space size="middle" wrap>
            <MedicineBoxOutlined style={{ fontSize: 22, color: token.colorPrimary }} />
            <Title level={4} style={{ margin: 0 }}>
              药材管理
            </Title>
          </Space>
          <Space size="large">
            {authMode === 'api' && <Button onClick={() => setAccountsOpen(true)}>账号管理</Button>}
            <MessageBell />
            <Link to="/dashboard">
              <Space>
                <ArrowLeftOutlined />
                返回数据概览
              </Space>
            </Link>
          </Space>
        </Flex>
      </Header>

      <Content className="admin-dashboard__content">
        <Breadcrumb
          style={{ marginBottom: 16 }}
          items={[
            { title: <Link to="/dashboard">管理员端</Link> },
            { title: <span style={{ color: token.colorText }}>药材管理</span> },
          ]}
        />

        <BatchQueryError error={error} onRetry={reload} />

        <Card className="herb-admin__workbench" variant="borderless" title="Agent 资料审核工作台">
          <Text>模型调用只读工具核对登记资料、给出风险建议；你查看证据并提交最终结论。</Text>
          <Flex gap={12} wrap align="center" style={{ marginTop: 12 }}>
            <Button
              type="primary"
              icon={<RobotOutlined />}
              disabled={loading || !!error}
              onClick={() => { setKeyword(''); setStage('all'); setAudit('pending') }}
            >
              {loading ? '正在读取待审批次' : error ? '待审数据不可用' : `只看待审核（${pendingBatches.length}）`}
            </Button>
            {!loading && !error && pendingBatches.slice(0, 3).map((item) => (
              <Button key={item.id} onClick={() => setRiskBatchId(item.id)}>
                审核 {item.herbName} · {item.batchNo}
              </Button>
            ))}
          </Flex>
          <Paragraph type="secondary" style={{ marginTop: 10, marginBottom: 0 }}>
            {!loading && !error && pendingBatches.length === 0 ? '当前没有待审核批次。' : ''}
            已审核/已驳回批次只查看已有建议；分析、填入表单都不会自动完成审核。
          </Paragraph>
        </Card>

        <Card variant="borderless">
          <div className="herb-admin__toolbar">
            <Input.Search
              allowClear
              placeholder="搜索 药材 / 批次号 / 溯源码 / 种植商"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onSearch={(v) => setKeyword(v)}
              style={{ width: 320 }}
            />
            <Select
              value={stage}
              options={STAGE_OPTIONS}
              onChange={(v) => setStage(v)}
              style={{ width: 140 }}
            />
            <Select
              value={audit}
              options={AUDIT_OPTIONS}
              onChange={(v) => setAudit(v)}
              style={{ width: 140 }}
            />
            <Button icon={<ReloadOutlined />} onClick={() => reload()}>
              刷新
            </Button>
            <span className="herb-admin__toolbar-spacer" />
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={authMode === 'api'}
              title={authMode === 'api' ? '真实数据模式请由种植商创建待审核批次' : undefined}
              onClick={() => navigate('/admin/herbs/new')}
            >
              新增药材批次
            </Button>
          </div>

          <Table<HerbBatch>
            rowKey="id"
            size="small"
            loading={loading}
            columns={columns}
            dataSource={filtered}
            scroll={{ x: 1360 }}
            pagination={{ pageSize: 8, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
            locale={{
              emptyText: <Empty description="暂无药材批次" image={Empty.PRESENTED_IMAGE_SIMPLE} />,
            }}
          />
        </Card>
      </Content>
      <Modal
        title="选择收货采购组织"
        open={dispatchBatchId !== null}
        onOk={handleDispatch}
        onCancel={closeDispatch}
        okText="确认出库"
        cancelText="取消"
        confirmLoading={dispatch.isPending}
        okButtonProps={{
          disabled: !canDispatch || dispatch.isPending,
        }}
        cancelButtonProps={{
          disabled: dispatch.isPending,
        }}
        closable={!dispatch.isPending}
        keyboard={!dispatch.isPending}
        destroyOnHidden
      >
        <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
          <Text>
            批次：{dispatchBatch?.batchNo ?? '不可用'}
            {' · '}
            {dispatchBatch?.herbName ?? ''}
          </Text>

          <BatchQueryError error={error} onRetry={reload} />

          {loading ? (
            <Text type="secondary">正在刷新批次信息，请稍后……</Text>
          ) : !error && !batchCanDispatch ? (
            <Alert
              showIcon
              type="warning"
              title="该批次当前不可出库"
              description="仅审核通过且未分配的仓储批次可以出库，请关闭弹窗后检查最新状态。"
            />
          ) : null}

          <div>
            <Text strong>收货采购组织</Text>
            <Select<string>
              aria-label="收货采购组织"
              placeholder="请选择采购组织"
              value={selectedRecipient?.id}
              onChange={(value) => setBuyerOrganizationId(value)}
              options={recipients.map((recipient) => ({
                value: recipient.id,
                label: recipient.name,
              }))}
              showSearch={{ optionFilterProp: 'label' }}
              allowClear
              loading={recipientsQuery.isFetching}
              disabled={dispatch.isPending || !recipientsReady}
              notFoundContent="暂无匹配的采购组织"
              style={{ width: '100%', marginTop: 8 }}
            />
          </div>

          {recipientsQuery.isFetching ? (
            <Text type="secondary">正在核验可选采购组织……</Text>
          ) : null}

          {recipientsQuery.isPaused ? (
            <Alert
              showIcon
              type="warning"
              title="网络离线，采购组织查询已暂停"
              description="恢复网络后再继续，当前不能提交出库。"
            />
          ) : null}

          {recipientsQuery.isError ? (
            <Alert
              showIcon
              type="error"
              title="采购组织加载失败"
              description={recipientsQuery.error.message}
              action={
                <Button onClick={() => void recipientsQuery.refetch()}>
                  重试
                </Button>
              }
            />
          ) : null}

          {recipientsReady && recipients.length === 0 ? (
            <Alert
              showIcon
              type="info"
              title="暂无可选采购组织"
              description="需要存在启用且拥有有效采购账号的采购组织，不能直接出库。"
            />
          ) : null}

          <Text type="secondary">
            出库后，只有指定采购组织可以确认收货；其他采购商仍可浏览已审核批次。
          </Text>
        </Space>
      </Modal>
      {riskBatch && (
        <RiskAnalysisDrawer
          key={riskBatch.id}
          batch={riskBatch}
          onClose={() => setRiskBatchId(null)}
        />
      )}
      {accountsOpen && <Suspense fallback={<Text>正在加载账号管理……</Text>}>
        <AccountManager onClose={() => setAccountsOpen(false)} />
      </Suspense>}
    </Layout>
  )
}
