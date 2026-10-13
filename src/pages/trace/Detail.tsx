import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Alert,
  App as AntdApp,
  Breadcrumb,
  Button,
  Card,
  Col,
  Descriptions,
  Dropdown,
  Empty,
  Flex,
  Layout,
  Result,
  Row,
  Space,
  Spin,
  Tag,
  Typography,
  theme,
} from 'antd'
import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  EnvironmentOutlined,
  FileDoneOutlined,
  HistoryOutlined,
  HomeOutlined,
  MedicineBoxOutlined,
  MoreOutlined,
  PaperClipOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import {
  useHerbBatchByIdentifier,
  useHerbBatchMutations,
} from '../../hooks/useHerbBatches'
import type { AuditDecision } from '../../services/herbDataSource'
import { filterEventsForRole } from '../../utils/herbEvents'
import { getRoleNavigation } from '../../utils/roleNavigation'
import TraceQrPanel from '../../components/herb/TraceQrPanel'
import TraceTimeline from '../../components/herb/TraceTimeline'
import TraceQuickViewModal from '../../components/herb/TraceQuickViewModal'

import HerbQuestionPanel from '../../components/herb/HerbQuestionPanel'

import { AuditTag, RiskTag, StageTag } from '../../components/herb/herbTags'
import { buildTraceUrl } from '../../utils/traceUrl'
import {
  AUDIT_LABEL,
  EVENT_TYPE_LABEL,
  HERB_CATEGORY_LABEL,
  STAGE_LABEL,
  type BatchEvent,
  type HerbBatch,
} from '../../types/herb'
import type { UserRole } from '../../types/auth'
import '../dashboard/index.less'
import './Detail.less'

import { getAttachmentHref } from '../../utils/attachmentUrl'

const { Header, Content } = Layout
const { Title, Text, Paragraph } = Typography

/** 角色级展示权限 */
const ROLE_VISIBILITY: Record<UserRole, { showInternalFields: boolean; showAuditActions: boolean; showTimeline: boolean }> = {
  /** 管理员：完整字段、审核操作、页面内时间轴 */
  admin: { showInternalFields: true, showAuditActions: true, showTimeline: true },
  /** 种植商：作为生产方可看完整字段与时间轴，但无审核操作 */
  grower: { showInternalFields: true, showAuditActions: false, showTimeline: true },
  /** 加工商：同上（预留） */
  processor: { showInternalFields: true, showAuditActions: false, showTimeline: true },
  /** 采购商：精简字段、无审核、时间轴只在弹窗里看 */
  buyer: { showInternalFields: false, showAuditActions: false, showTimeline: false },
}

function formatOrigin(b: HerbBatch): string {
  return [b.origin.province, b.origin.city, b.origin.district, b.origin.address]
    .filter(Boolean)
    .join(' / ')
}

type AttachmentRow = {
  name: string
  url: string
  eventTitle: string
  eventType: BatchEvent['type']
  occurredAt: string
}

function collectAttachments(batch: HerbBatch, role: UserRole): AttachmentRow[] {
  return filterEventsForRole(batch.events, role).flatMap((e) =>
    (e.attachments ?? []).map<AttachmentRow>((a) => ({
      name: a.name,
      url: a.url,
      eventTitle: e.title,
      eventType: e.type,
      occurredAt: e.occurredAt,
    })),
  )
}


export default function TraceDetailPage() {
  const { message, modal } = AntdApp.useApp()
  const { token } = theme.useToken()
  const navigate = useNavigate()
  const location = useLocation()
  const { traceCode } = useParams<{ traceCode: string }>()
  const { session } = useAuth()
  const role: UserRole = session?.role ?? 'buyer'
  const vis = ROLE_VISIBILITY[role]

  const {
    data: batch,
    loading,
    error,
    reload,
  } = useHerbBatchByIdentifier(traceCode)
  const { setAudit: auditMutation } = useHerbBatchMutations()

  /**
   * 是否首次访问需要自动弹链路弹窗
   * - 站内跳转会带 state.fromInternal=true，跳过自动弹
   * - 外部 URL 直达（手机系统扫码）→ 自动弹一次
   */
  const fromInternal = Boolean((location.state as { fromInternal?: boolean } | null)?.fromInternal)
  const [quickOpen, setQuickOpen] = useState(false)
  const autoTriggeredRef = useRef(false)

  useEffect(() => {
    if (batch && !fromInternal && !autoTriggeredRef.current) {
      autoTriggeredRef.current = true
      setQuickOpen(true)
    }
  }, [batch, fromInternal])

  const navigation = getRoleNavigation(role)

  const handleAudit = async (next: AuditDecision) => {
    if (!batch) return
    modal.confirm({
      title: `确认将该批次置为「${AUDIT_LABEL[next]}」？`,
      content: `${batch.batchNo} · ${batch.herbName}`,
      okText: '确认',
      cancelText: '取消',
      onOk: async () => {
        try {
          await auditMutation.mutateAsync({
            id: batch.id,
            decision: next,
          })
          message.success(`已更新为：${AUDIT_LABEL[next]}`)
        } catch (e) {
          message.error(`更新失败：${(e as Error).message}`)
        }
      },
    })
  }

  return (
    <Layout className="admin-dashboard trace-detail">
      <Header className="admin-dashboard__header">
        <Flex align="center" justify="space-between" style={{ width: '100%' }}>
          <Space size="middle" wrap>
            <MedicineBoxOutlined style={{ fontSize: 22, color: token.colorPrimary }} />
            <Title level={4} style={{ margin: 0 }}>
              药材档案
            </Title>
            {traceCode ? (
              <Text type="secondary" copyable={{ text: traceCode }}>
                {traceCode}
              </Text>
            ) : null}
          </Space>
          <Space>
            <Button
              type="text"
              icon={<ReloadOutlined />}
              onClick={reload}
              aria-label="刷新"
            />
            <Link
              to={navigation.resourcePath}
              className="trace-detail__back"
            >
              <Space>
                <ArrowLeftOutlined />
                返回{navigation.resourceLabel}
              </Space>
            </Link>
          </Space>
        </Flex>
      </Header>

      <Content className="admin-dashboard__content">
        <Breadcrumb
          style={{ marginBottom: 16 }}
          items={[
            {
              title: (
                <Link to={navigation.homePath}>
                  <Space size={4}>
                    <HomeOutlined />
                    {navigation.homeLabel}
                  </Space>
                </Link>
              ),
            },
            {
              title: (
                <Link to={navigation.resourcePath}>
                  {navigation.resourceLabel}
                </Link>
              ),
            },
            {
              title: (
                <span style={{ color: token.colorText }}>
                  药材档案
                </span>
              ),
            },
          ]}
        />

        {loading ? (
          <Card variant="borderless">
            <Flex justify="center" style={{ padding: 48 }}>
              <Spin />
            </Flex>
          </Card>
        ) : error ? (
          <Card
            variant="borderless"
            className="trace-detail__not-found"
          >
            <Result
              status="warning"
              title="暂时无法加载批次"
              subTitle={error.message}
              extra={
                <Space>
                  <Button onClick={() => navigate(navigation.resourcePath)}>
                    返回{navigation.resourceLabel}
                  </Button>
                  <Button type="primary" onClick={reload}>
                    重试
                  </Button>
                </Space>
              }
            />
          </Card>
        ) : !batch ? (
          <Card variant="borderless" className="trace-detail__not-found">
            <Result
              status="404"
              title="未找到该溯源批次"
              subTitle={`溯源码：${traceCode ?? '—'}`}
              extra={
                <Space>
                  <Button onClick={() => navigate(navigation.resourcePath)}>
                    返回{navigation.resourceLabel}
                  </Button>
                  <Button type="primary" onClick={reload}>
                    重试
                  </Button>
                </Space>
              }
            />
          </Card>
        ) : (
          <BatchView
            batch={batch}
            role={role}
            showInternal={vis.showInternalFields}
            showAuditActions={vis.showAuditActions}
            showTimeline={vis.showTimeline}
            onAudit={handleAudit}
            onOpenQuickView={() => setQuickOpen(true)}
          />
        )}
      </Content>

      <TraceQuickViewModal
        open={quickOpen}
        batch={batch}
        role={role}
        onClose={() => setQuickOpen(false)}
        onViewFull={() => setQuickOpen(false)}
      />
    </Layout>
  )
}

function BatchView({
  batch,
  role,
  showInternal,
  showAuditActions,
  showTimeline,
  onAudit,
  onOpenQuickView,
}: {
  batch: HerbBatch
  role: UserRole
  showInternal: boolean
  showAuditActions: boolean
  showTimeline: boolean
  onAudit: (next: AuditDecision) => void
  onOpenQuickView: () => void
}) {
  const { token } = theme.useToken()
  const navigate = useNavigate()
  const cover = batch.coverImageUrl ?? '/images/herbs/placeholder.svg'
  const buyerOnlyTip =
    role === 'buyer' && batch.auditStatus !== 'approved'
      ? '该批次尚未通过审核，仅展示有限信息。'
      : null

  const { message } = AntdApp.useApp()
  const attachments = useMemo(() => collectAttachments(batch, role), [batch, role])

  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      {buyerOnlyTip ? <Alert type="warning" showIcon title={buyerOnlyTip} /> : null}

      <Card variant="borderless" className="trace-detail__hero">
        <div className="trace-detail__hero-grid">
          <div
            className="trace-detail__cover"
            style={{ backgroundImage: `url(${cover})` }}
            aria-label={batch.herbName}
          />
          <div className="trace-detail__hero-body">
            <Title level={3} className="trace-detail__hero-title">
              <span>{batch.herbName}</span>
              <Tag color="default">{HERB_CATEGORY_LABEL[batch.category]}</Tag>
              <StageTag stage={batch.stage} />
              <AuditTag status={batch.auditStatus} />
              <RiskTag level={batch.riskLevel} />
            </Title>
            <div className="trace-detail__hero-meta">
              <span>
                <Text type="secondary">批次号：</Text>
                <Text copyable={{ text: batch.batchNo }}>{batch.batchNo}</Text>
              </span>
              <span>
                <Text type="secondary">溯源码：</Text>
                <Text copyable={{ text: batch.traceCode }} strong>
                  {batch.traceCode}
                </Text>
              </span>
              <span>
                <Text type="secondary">种植商：</Text>
                <Text>{batch.growerName}</Text>
              </span>
              <span>
                <Text type="secondary">产地：</Text>
                <Text>{formatOrigin(batch)}</Text>
              </span>
            </div>
            {batch.description ? (
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                {batch.description}
              </Paragraph>
            ) : null}

            <Flex gap={8} wrap style={{ marginTop: 8 }}>
              {/** 采购商视角下，时间轴只在弹窗里，给个显眼入口 */}
              {!showTimeline ? (
                <Button
                  type="primary"
                  ghost
                  icon={<HistoryOutlined />}
                  onClick={onOpenQuickView}
                >
                  查看溯源链路
                </Button>
              ) : null}
              {/** 种植商视角：仅在「种植中 + 未驳回」时显示「去采收登记」快捷入口 */}
              {role === 'grower' &&
                batch.stage === 'planting' &&
                batch.auditStatus !== 'rejected' ? (
                <Button
                  type="primary"
                  icon={<CheckCircleOutlined />}
                  onClick={() =>
                    navigate(`/grower/harvest/new?batchId=${batch.id}`)
                  }
                >
                  采收登记
                </Button>
              ) : null}
              {showAuditActions ? (
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
                    onClick: ({ key }) => onAudit(key as AuditDecision),
                  }}
                >
                  <Button icon={<MoreOutlined />}>审核操作</Button>
                </Dropdown>
              ) : null}
            </Flex>
          </div>
        </div>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={16}>
          <Card title="基础信息" variant="borderless">
            <Descriptions column={{ xs: 1, sm: 2 }} size="middle">
              <Descriptions.Item label="药材名称">{batch.herbName}</Descriptions.Item>
              <Descriptions.Item label="类别">{HERB_CATEGORY_LABEL[batch.category]}</Descriptions.Item>
              <Descriptions.Item label="种植商">{batch.growerName}</Descriptions.Item>
              <Descriptions.Item label="种植开始日期">{batch.plantingStartDate}</Descriptions.Item>
              <Descriptions.Item label="当前阶段">
                <StageTag stage={batch.stage} /> <Text type="secondary">{STAGE_LABEL[batch.stage]}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="风险等级">
                <RiskTag level={batch.riskLevel} />
              </Descriptions.Item>
              {showInternal ? (
                <>
                  <Descriptions.Item label="审核状态">
                    <AuditTag status={batch.auditStatus} />
                  </Descriptions.Item>
                  <Descriptions.Item label="批次创建">
                    {batch.createdAt} · {batch.createdByRole === 'admin' ? '管理员' : '种植商'}
                  </Descriptions.Item>
                  <Descriptions.Item label="最近更新" span="filled">
                    {batch.updatedAt}
                  </Descriptions.Item>
                </>
              ) : (
                <Descriptions.Item label="审核状态">
                  <AuditTag status={batch.auditStatus} />
                </Descriptions.Item>
              )}
            </Descriptions>
          </Card>

          <Card
            title={
              <Space>
                <EnvironmentOutlined />
                <span>环境与产地</span>
              </Space>
            }
            variant="borderless"
            className="trace-detail__env-card"
            style={{ marginTop: 16 }}
          >
            <Row gutter={[16, 12]}>
              <Col xs={24} md={12}>
                <div className="trace-detail__env-field">
                  <Text type="secondary">产地</Text>
                  <div className="trace-detail__env-value">{formatOrigin(batch)}</div>
                </div>
              </Col>
              <Col xs={24} md={12}>
                <div className="trace-detail__env-field">
                  <Text type="secondary">种植开始</Text>
                  <div className="trace-detail__env-value">{batch.plantingStartDate}</div>
                </div>
              </Col>
              <Col xs={24}>
                <div className="trace-detail__env-field">
                  <Text type="secondary">环境信息</Text>
                  <div className="trace-detail__env-value">
                    {batch.environment ?? <Text type="secondary">—</Text>}
                  </div>
                </div>
              </Col>
            </Row>
          </Card>

          <Card
            title={
              <Space>
                <FileDoneOutlined />
                <span>附件档案</span>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  共 {attachments.length} 份
                </Text>
              </Space>
            }
            variant="borderless"
            style={{ marginTop: 16 }}
          >
            {attachments.length === 0 ? (
              <Empty
                description="暂无可见附件"
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              />
            ) : (
              <div className="trace-detail__attach-list">
                {attachments.map((a) => {
                  const href = getAttachmentHref(a.url)
                  const body = (
                    <>
                      <PaperClipOutlined className="trace-detail__attach-icon" />
                      <div className="trace-detail__attach-body">
                        <div className="trace-detail__attach-name">{a.name}</div>
                        <div className="trace-detail__attach-meta">
                          <Tag variant="filled">{EVENT_TYPE_LABEL[a.eventType]}</Tag>
                          {!href && <Tag>仅元数据，暂无文件</Tag>}
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {a.eventTitle} · {a.occurredAt}
                          </Text>
                        </div>
                      </div>
                    </>
                  )
                  const key = a.url + a.name + a.occurredAt
                  return href ? (
                    <a
                      key={key}
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="trace-detail__attach-item"
                    >
                      {body}
                    </a>
                  ) : (
                    <button
                      key={key}
                      type="button"
                      className="trace-detail__attach-item"
                      onClick={() =>
                        message.info('该附件仅有登记元数据，尚未提供可打开的文件')
                      }
                    >
                      {body}
                    </button>
                  )
                })}
              </div>
            )}
          </Card>

          <HerbQuestionPanel key={batch.id} batch={batch} />

          {showTimeline ? (
            <Card
              title={
                <Space>
                  <HistoryOutlined />
                  <span>溯源时间轴</span>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    共 {batch.events.length} 条
                  </Text>
                </Space>
              }
              variant="borderless"
              className="trace-detail__timeline-card"
              style={{ marginTop: 16 }}
            >
              <TraceTimeline events={batch.events} role={role} />
            </Card>
          ) : null}
        </Col>

        <Col xs={24} xl={8}>
          <Card title="溯源二维码与分享" variant="borderless" className="trace-detail__qr-card">
            <TraceQrPanel traceCode={batch.traceCode} size={232} />
            <Paragraph
              type="secondary"
              style={{ marginTop: 16, marginBottom: 0, fontSize: 12, wordBreak: 'break-all' }}
            >
              公开链接：{buildTraceUrl(batch.traceCode)}
            </Paragraph>
            <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
              扫码或访问链接可查看已审核批次的公开档案；
              完整详情与 AI 仍需登录并通过权限检查。
            </Paragraph>
          </Card>

          <Card title="当前状态与风险" variant="borderless" style={{ marginTop: 16 }}>
            <Space orientation="vertical" size={12} style={{ width: '100%' }}>
              <Flex justify="space-between" align="center">
                <Text type="secondary">流转阶段</Text>
                <StageTag stage={batch.stage} />
              </Flex>
              <Flex justify="space-between" align="center">
                <Text type="secondary">审核状态</Text>
                <AuditTag status={batch.auditStatus} />
              </Flex>
              <Flex justify="space-between" align="center">
                <Text type="secondary">风险等级</Text>
                <RiskTag level={batch.riskLevel} />
              </Flex>
              {batch.riskLevel !== 'normal' ? (
                <Alert
                  showIcon
                  type={batch.riskLevel === 'high' ? 'error' : 'warning'}
                  title={
                    batch.riskLevel === 'high'
                      ? '该批次目前为高风险状态，建议核查后续节点。'
                      : '该批次存在一定风险因素，请关注后续质检与流转。'
                  }
                />
              ) : null}
            </Space>
          </Card>
        </Col>
      </Row>
    </Space>
  )
}
