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
  CloseCircleOutlined,
  EnvironmentOutlined,
  EyeOutlined,
  FileTextOutlined,
  LogoutOutlined,
  MedicineBoxOutlined,
  PlusOutlined,
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
import './grower.less'

const { Header, Content } = Layout
const { Title, Text, Paragraph } = Typography

function formatOrigin(b: HerbBatch): string {
  return [b.origin.province, b.origin.city, b.origin.district].filter(Boolean).join(' · ')
}

export default function GrowerDashboardPage() {
  const { token } = theme.useToken()
  const navigate = useNavigate()
  const { session, logout } = useAuth()
  const { data, loading, error, reload } = useHerbBatches()

  const growerId = session?.growerId

  /** 只看自己合作社的批次 */
  const mine = useMemo(
    () => (growerId ? data.filter((b) => b.growerId === growerId) : []),
    [data, growerId],
  )

  const stats = useMemo(
    () => ({
      total: mine.length,
      pending: mine.filter((b) => b.auditStatus === 'pending').length,
      approved: mine.filter((b) => b.auditStatus === 'approved').length,
      rejected: mine.filter((b) => b.auditStatus === 'rejected').length,
    }),
    [mine],
  )

  const recent = useMemo(
    () => [...mine].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5),
    [mine],
  )

  const handleLogout = async () => {
    if (!await logout()) return
    navigate('/login', { replace: true })
  }

  return (
    <Layout className="admin-dashboard grower-dashboard">
      <Header className="admin-dashboard__header">
        <Flex align="center" justify="space-between" style={{ width: '100%' }}>
          <Space size="middle" wrap>
            <MedicineBoxOutlined style={{ fontSize: 22, color: token.colorPrimary }} />
            <Title level={4} style={{ margin: 0 }}>
              良木药谷 · 种植商端
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
              <button type="button" className="grower-dashboard__user-trigger">
                <Space>
                  <Avatar style={{ backgroundColor: token.colorPrimary }} icon={<UserOutlined />} />
                  <div style={{ lineHeight: 1.2, textAlign: 'left' }}>
                    <div>
                      <Text strong>{session?.displayName ?? '—'}</Text>
                    </div>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {session?.growerName ?? session?.roleLabel ?? '种植商'}
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
            { title: '种植商端' },
            { title: <span style={{ color: token.colorText }}>种植工作台</span> },
          ]}
        />

        <BatchQueryError error={error} onRetry={reload} />

        <div className="grower-dashboard__hero">
          <div>
            <Title level={3} style={{ marginBottom: 8 }}>
              欢迎，{session?.displayName ?? '种植商'}
            </Title>
            <Paragraph type="secondary" style={{ marginBottom: 0, maxWidth: 720 }}>
              这里是 <strong>{session?.growerName ?? '我的合作社'}</strong> 的种植工作台。
              你可以建档新批次、登记种植与采收信息，提交后将进入管理员审核流程。
            </Paragraph>
          </div>
          <div className="grower-dashboard__hero-actions">
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => navigate('/grower/batches/new')}
            >
              新建批次
            </Button>
            <Button icon={<AppstoreOutlined />} onClick={() => navigate('/grower/batches')}>
              我的批次
            </Button>
            <Button icon={<FileTextOutlined />} onClick={() => navigate('/grower/logs')}>
              种植日志
            </Button>
            <Button
              icon={<CheckCircleOutlined />}
              onClick={() => navigate('/grower/harvest')}
            >
              采收登记
            </Button>
          </div>
        </div>

        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          <Col xs={12} md={6}>
            <Card variant="borderless">
              <Statistic
                title="我的批次"
                value={stats.total}
                prefix={<AppstoreOutlined style={{ color: token.colorPrimary }} />}
              />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card variant="borderless">
              <Statistic
                title="待审核"
                value={stats.pending}
                prefix={<ClockCircleOutlined style={{ color: token.colorWarning }} />}
              />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card variant="borderless">
              <Statistic
                title="已通过"
                value={stats.approved}
                prefix={<CheckCircleOutlined style={{ color: token.colorSuccess }} />}
              />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card variant="borderless">
              <Statistic
                title="已驳回"
                value={stats.rejected}
                prefix={<CloseCircleOutlined style={{ color: token.colorError }} />}
              />
            </Card>
          </Col>
        </Row>

        <Card
          title="最近批次"
          variant="borderless"
          style={{ marginTop: 16 }}
          extra={
            <Button type="link" onClick={() => navigate('/grower/batches')}>
              查看全部
            </Button>
          }
        >
          {loading ? (
            <Flex justify="center" style={{ padding: 40 }}>
              <Spin />
            </Flex>
          ) : recent.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="还没有批次，点击「新建批次」开始建档"
            />
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
                        className="grower-dashboard__thumb"
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
                        <Text type="secondary">
                          <EnvironmentOutlined /> {formatOrigin(b)}
                        </Text>
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
