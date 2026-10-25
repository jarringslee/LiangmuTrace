import {
  App as AntdApp,
  Breadcrumb,
  Button,
  Card,
  Descriptions,
  Flex,
  Layout,
  Space,
  Typography,
  theme,
} from 'antd'
import {
  ArrowLeftOutlined,
  LogoutOutlined,
  MedicineBoxOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { getRoleNavigation } from '../../utils/roleNavigation'
import type { UserRole } from '../../types/auth'
import '../dashboard/index.less'
import './index.less'

const { Header, Content } = Layout
const { Title, Text, Paragraph } = Typography

function organizationLabel(role: UserRole): string {
  if (role === 'admin') return '所属平台'
  if (role === 'grower') return '所属合作社'
  if (role === 'processor') return '所属加工组织'
  return '采购主体'
}

export default function ProfilePage() {
  const { modal } = AntdApp.useApp()
  const { token } = theme.useToken()
  const navigate = useNavigate()
  const { session, logout } = useAuth()

  // Profile 路由已被 RequireAuth 保护；这里仍保留类型与异常状态防护。
  if (!session) return null

  const navigation = getRoleNavigation(session.role)

  const confirmLogout = () => {
    modal.confirm({
      title: '退出当前账号？',
      content: '退出后将返回登录页，可以重新选择其他账号。',
      okText: '退出登录',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        if (!await logout()) return
        navigate('/login', { replace: true })
      },
    })
  }

  return (
    <Layout
      className="admin-dashboard profile-page"
      style={{ minHeight: '100vh' }}
    >
      <Header className="admin-dashboard__header">
        <Flex
          align="center"
          justify="space-between"
          wrap
          gap={12}
          style={{ width: '100%' }}
        >
          <Space size="middle">
            <MedicineBoxOutlined
              style={{ fontSize: 22, color: token.colorPrimary }}
            />
            <Title level={4} style={{ margin: 0 }}>
              个人资料
            </Title>
          </Space>

          <Link to={navigation.homePath}>
            <Space>
              <ArrowLeftOutlined />
              返回{navigation.homeLabel}
            </Space>
          </Link>
        </Flex>
      </Header>

      <Content className="admin-dashboard__content profile-page__content">
        <Breadcrumb
          style={{ marginBottom: 16 }}
          items={[
            {
              title: (
                <Link to={navigation.homePath}>
                  {navigation.homeLabel}
                </Link>
              ),
            },
            { title: '个人资料' },
          ]}
        />

        <Card className="profile-page__hero" variant="borderless">
          <Flex align="center" gap={20} wrap>
            <div className="profile-page__avatar-wrap">
              <UserOutlined className="profile-page__avatar-icon" />
            </div>

            <div>
              <Title level={4} style={{ margin: '0 0 8px' }}>
                {session.displayName}
              </Title>

              <Space wrap>
                <Text type="secondary">{session.roleLabel}</Text>
                <Text type="secondary">·</Text>
                <Text type="secondary">
                  {session.organizationName ?? '未绑定组织'}
                </Text>
              </Space>
            </div>
          </Flex>
        </Card>

        <Card
          title="真实账号资料"
          variant="borderless"
          style={{ marginTop: 16 }}
        >
          <Descriptions
            column={{ xs: 1, sm: 1, md: 2 }}
            bordered
            size="middle"
          >
            <Descriptions.Item label="姓名">
              {session.displayName}
            </Descriptions.Item>

            <Descriptions.Item label="登录账号">
              <Text code>{session.username}</Text>
            </Descriptions.Item>

            <Descriptions.Item label="邮箱">
              {session.email}
            </Descriptions.Item>

            <Descriptions.Item label="角色">
              {session.roleLabel}
            </Descriptions.Item>

            <Descriptions.Item
              label={organizationLabel(session.role)}
              span={2}
            >
              {session.organizationName ?? '未绑定组织'}
            </Descriptions.Item>
          </Descriptions>

          <Paragraph type="secondary" style={{ margin: '16px 0 0' }}>
            以上资料来自当前登录身份；页面不展示密码、Token、内部权限信息或模拟登录地点。
          </Paragraph>
        </Card>

        <Card variant="borderless" style={{ marginTop: 16 }}>
          <Button
            danger
            icon={<LogoutOutlined />}
            onClick={confirmLogout}
          >
            退出登录
          </Button>
        </Card>
      </Content>
    </Layout>
  )
}
