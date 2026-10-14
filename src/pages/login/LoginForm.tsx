import { lazy, Suspense, useMemo, useRef, useState } from 'react'
import { App as AntdApp, Alert, Button, Flex, Form, Input, Segmented, Tabs, Typography } from 'antd'
import { useAuth } from '../../hooks/useAuth'
import { loginRoleTabs, type LoginRoleKey } from '../../mock/login/roles'
import { authMode } from '../../config/api'
import { ApiError, isAbortError } from '../../services/api'

const { Text } = Typography
const BuyerRegistration = lazy(() => import('../../components/account/BuyerRegistration'))

export type LoginAccountMode = 'username' | 'email'

type FieldValues = {
  account: string
  password: string
}

export function LoginForm() {
  const { message } = AntdApp.useApp()
  const { login, message: authMessage } = useAuth()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [registerOpen, setRegisterOpen] = useState(false)
  const submittingRef = useRef(false)
  const [role, setRole] = useState<LoginRoleKey>('admin')
  const [mode, setMode] = useState<LoginAccountMode>('username')
  const [form] = Form.useForm<FieldValues>()

  const accountPlaceholder = mode === 'username' ? '用户名' : '邮箱'

  const tabItems = useMemo(
    () =>
      loginRoleTabs.map((t) => ({
        key: t.key,
        label: t.label,
        disabled: submitting,
      })),
    [submitting],
  )

  const onFinish = async (values: FieldValues) => {
    // ref 同步锁住同一渲染周期内的重复提交，loading 负责视觉反馈。
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    try {
      await login({ role, account: values.account.trim(), password: values.password })
      // 登录状态发布后由 GuestOnly 统一跳转，避免两处 navigate 相互竞争。
    } catch (error) {
      if (isAbortError(error)) return
      setError(error instanceof ApiError ? error.message : '登录失败，请稍后重试')
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const onForgotPassword = () => {
    message.info('暂不提供找回或重置密码，请妥善保存密码；需要时联系平台管理员处理。')
  }

  return (
    <div className="login-page__form-wrap">
      {authMode === 'demo' && <Alert type="info" title="演示模式：操作仅保存在当前浏览器" showIcon style={{ marginBottom: 16 }} />}
      {(error || authMessage) && <Alert type="error" title={error ?? authMessage} showIcon role="alert" style={{ marginBottom: 16 }} />}
      <Tabs
        activeKey={role}
        onChange={(k) => {
          setRole(k as LoginRoleKey)
          form.resetFields()
          setError(null)
        }}
        size="small"
        className="login-page__role-tabs"
        items={tabItems}
      />

      <Segmented<LoginAccountMode>
        block
        disabled={submitting}
        value={mode}
        onChange={(v) => {
          setMode(v)
          form.setFieldValue('account', '')
          setError(null)
        }}
        options={[
          { label: '用户名登录', value: 'username' },
          { label: '邮箱登录', value: 'email' },
        ]}
        className="login-page__mode-segmented"
      />

      <Form<FieldValues>
        form={form}
        disabled={submitting}
        layout="vertical"
        requiredMark={false}
        className="login-page__form"
        onFinish={onFinish}
        autoComplete="off"
      >
        <Form.Item name="account" label={accountPlaceholder} rules={[
          { required: true, whitespace: true, message: `请输入${accountPlaceholder}` },
          ...(mode === 'email' ? [{ type: 'email' as const, message: '请输入有效邮箱' }] : []),
        ]}>
          <Input allowClear placeholder={`请输入${accountPlaceholder}`} size="large" maxLength={254} autoComplete="username" />
        </Form.Item>

        <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
          <Input.Password placeholder="请输入密码" size="large" visibilityToggle autoComplete="current-password" />
        </Form.Item>

        <div className="login-page__pwd-hint">
          <Text type="secondary">{authMode === 'demo' ? '演示账号密码为用户名 + 123' : role === 'buyer' ? '采购商可自行注册，或使用管理员分配的账号' : '请使用管理员分配的账号登录'}</Text>
        </div>

        <Flex justify="flex-end" className="login-page__forgot-row">
          <Button type="link" className="login-page__forgot-btn" onClick={onForgotPassword}>
            忘记密码
          </Button>
        </Flex>

        <Form.Item className="login-page__submit-item">
          <Button type="primary" htmlType="submit" size="large" block loading={submitting}>
            登录
          </Button>
        </Form.Item>
      </Form>
      {authMode === 'api' && role === 'buyer' && <Button type="link" disabled={submitting} onClick={() => setRegisterOpen(true)}>注册采购商账号</Button>}
      {registerOpen && role === 'buyer' && <Suspense fallback={<Text>正在加载注册表单……</Text>}>
        <BuyerRegistration onClose={() => setRegisterOpen(false)} onRegistered={username => {
          form.setFieldsValue({ account: username, password: '' })
          setMode('username')
          setError(null)
          setRegisterOpen(false)
        }} />
      </Suspense>}
    </div>
  )
}
