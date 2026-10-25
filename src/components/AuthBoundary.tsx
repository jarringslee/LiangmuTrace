import { useEffect } from 'react'
import { Button, Result, Space, Spin } from 'antd'
import { useAuth } from '../hooks/useAuth'
import { startAuthSync } from '../services/auth'

/** 只在应用入口恢复一次，验证完成前不挂载受保护页面和它们的数据查询。 */
export function AuthBoundary({ children }: { children: React.ReactNode }) {
  const { status, message, errorAction, restoreAuth, logout } = useAuth()
  useEffect(() => {
    const stopSync = startAuthSync()
    void restoreAuth()
    return stopSync
  }, [restoreAuth])

  if (status === 'checking') {
    return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
      <Space orientation="vertical" align="center"><Spin size="large" /><span>正在验证登录状态…</span></Space>
    </div>
  }
  if (status === 'error') {
    return <Result status="warning" title={errorAction === 'logout' ? '退出尚未完成' : '暂时无法验证登录状态'} subTitle={message}
      extra={<Space>
        <Button type="primary" onClick={() => { if (errorAction === 'logout') void logout(); else void restoreAuth() }}>
          {errorAction === 'logout' ? '重试退出' : '重试验证'}
        </Button>
        {errorAction !== 'logout' && <Button onClick={() => void logout()}>退出当前会话</Button>}
      </Space>} />
  }
  return children
}
