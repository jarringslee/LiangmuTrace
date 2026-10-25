import { useMemo } from 'react'
import {
  Avatar,
  Breadcrumb,
  Button,
  Card,
  Col,
  Dropdown,
  Empty,
  Flex,
  Layout,
  List,
  Row,
  Space,
  Spin,
  Statistic,
  Typography,
  theme,
} from 'antd'
import {
  AppstoreOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  EyeOutlined,
  ExperimentOutlined,
  LogoutOutlined,
  MedicineBoxOutlined,
  ToolOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../../hooks/useAuth'
import { useHerbBatches } from '../../../hooks/useHerbBatches'
import BatchQueryError from '../../../components/herb/BatchQueryError'
import { MessageBell } from '../../../components/MessageBell'
import { AuditTag, RiskTag, StageTag } from '../../../components/herb/herbTags'
import type { HerbBatch } from '../../../types/herb'
import '../../dashboard/index.less'
import './processor.less'

const { Header, Content } = Layout
const { Title, Text, Paragraph } = Typography

function formatOrigin(b: HerbBatch): string {
  return [b.origin.province, b.origin.city, b.origin.district].filter(Boolean).join(' · ')
}

export default function ProcessorDashboardPage() {
  const { token } = theme.useToken()
  const navigate = useNavigate()
  const { session, logout } = useAuth()
  const { data, loading, error, reload } = useHerbBatches()

  /**
   * 第一版 processor 端暂不做分配关系：
   * harvested 视为待接收，processing 视为加工中，warehousing 视为已完成/待平台复核。
   */
  const processable = useMemo(
    () => data.filter((b) => ['harvested', 'processing', 'warehousing'].includes(b.stage)),
    [data],
  )

  const stats = useMemo(
    () => ({
      pendingReceive: processable.filter((b) => b.stage === 'harvested').length,
      processing: processable.filter((b) => b.stage === 'processing').length,
      warehousing: processable.filter((b) => b.stage === 'warehousing').length,
      total: processable.length,
    }),
    [processable],
  )

  const recent = useMemo(
    () => [...processable].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5),
    [processable],
  )

  const handleLogout = async () => {
    if (!await logout()) return
    navigate('/login', { replace: true })
  }

  return (
    <Layout className="admin-dashboard processor-dashboard">
      <Header className="admin-dashboard__header">
        <Flex align="center" justify="space-between" style={{ width: '100%' }}>
          <Space size="middle" wrap>
            <MedicineBoxOutlined style={{ fontSize: 22, color: token.colorPrimary }} />
            <Title level={4} style={{ margin: 0 }}>
              良木药谷 · 加工商端
            </Title>
          </Space>
          <Space size="middle">
            <MessageBell />
            <Dropdown
              menu={{
                items: [
                  {
                    key: 'profile',
                    icon: <UserOutlined />,
                    label: '个人中心',
                    onClick: () => navigate('/profile'),
                  },
                  { type: 'divider' },
                  {
                    key: 'logout',
                    icon: <LogoutOutlined />,
                    label: '退出登录',
                    danger: true,
                    onClick: handleLogout,
                  },
                ],
              }}
              placement="bottomRight"
              trigger={['click']}
            >
              <button type="button" className="processor-dashboard__user-trigger">
                <Space>
                  <Avatar style={{ backgroundColor: token.colorPrimary }} icon={<UserOutlined />} />
                  <div style={{ lineHeight: 1.2, textAlign: 'left' }}>
                    <div>
                      <Text strong>{session?.displayName ?? '—'}</Text>
                    </div>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {session?.processorName ?? session?.roleLabel ?? '加工商'}
                    </Text>
                  </div>
                </Space>
              </button>
            </Dropdown>
          </Space>
        </Flex>
      </Header>

      <Content className="admin-dashboard__content">
        <Breadcrumb
          style={{ marginBottom: 16 }}
          items={[
            { title: '加工商端' },
            { title: <span style={{ color: token.colorText }}>加工工作台</span> },
          ]}
        />

        <BatchQueryError error={error} onRetry={reload} />

        <div className="processor-dashboard__hero">
          <div>
            <Title level={3} style={{ marginBottom: 8 }}>
              欢迎，{session?.displayName ?? '加工商'}
            </Title>
            <Paragraph type="secondary" style={{ marginBottom: 0, maxWidth: 720 }}>
              这里是 <strong>{session?.processorName ?? '我的加工厂'}</strong> 的加工工作台。
              可在加工批次中完成接收、加工、质检与入库，并查看最近可处理批次。
            </Paragraph>
          </div>
          <div className="processor-dashboard__hero-actions">
            <Button
              type="primary"
              icon={<AppstoreOutlined />}
              onClick={() => navigate('/processor/batches')}
            >
              加工批次
            </Button>
          </div>
        </div>

        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          <Col xs={12} md={6}>
            <Card variant="borderless">
              <Statistic
                title="待接收"
                value={stats.pendingReceive}
                prefix={<ClockCircleOutlined style={{ color: token.colorWarning }} />}
              />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card variant="borderless">
              <Statistic
                title="加工中"
                value={stats.processing}
                prefix={<ToolOutlined style={{ color: token.colorPrimary }} />}
              />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card variant="borderless">
              <Statistic
                title="已入库"
                value={stats.warehousing}
                prefix={<CheckCircleOutlined style={{ color: token.colorSuccess }} />}
              />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card variant="borderless">
              <Statistic
                title="可处理批次"
                value={stats.total}
                prefix={<ExperimentOutlined style={{ color: token.colorPrimary }} />}
              />
            </Card>
          </Col>
        </Row>

        <Card
          title="最近可处理批次"
          variant="borderless"
          style={{ marginTop: 16 }}
          extra={
            <Button type="link" onClick={() => navigate('/processor/batches')}>
              查看全部
            </Button>
          }
        >
          {loading ? (
            <Flex justify="center" style={{ padding: 40 }}>
              <Spin />
            </Flex>
          ) : recent.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可处理批次" />
          ) : (
            <List
              itemLayout="horizontal"
              dataSource={recent}
              renderItem={(b) => (
                <List.Item
                  actions={[
                    <Button
                      key="view"
                      type="link"
                      size="small"
                      icon={<EyeOutlined />}
                      onClick={() =>
                        navigate(`/trace/${b.traceCode}`, { state: { fromInternal: true } })
                      }
                    >
                      查看
                    </Button>,
                  ]}
                >
                  <List.Item.Meta
                    avatar={
                      <span
                        className="processor-dashboard__thumb"
                        aria-label={b.herbName}
                        style={{
                          backgroundImage: `url(${b.coverImageUrl ?? '/images/herbs/placeholder.svg'})`,
                        }}
                      />
                    }
                    title={
                      <Space wrap size={6}>
                        <Text strong>{b.herbName}</Text>
                        <StageTag stage={b.stage} />
                        <AuditTag status={b.auditStatus} />
                        <RiskTag level={b.riskLevel} />
                      </Space>
                    }
                    description={
                      <Space wrap size={16}>
                        <Text type="secondary">{formatOrigin(b)}</Text>
                        <Text type="secondary">{b.batchNo}</Text>
                        <Text type="secondary">更新于 {b.updatedAt}</Text>
                      </Space>
                    }
                  />
                </List.Item>
              )}
            />
          )}
        </Card>
      </Content>
    </Layout>
  )
}
