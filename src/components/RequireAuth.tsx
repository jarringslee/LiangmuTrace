import { Link, Navigate, useLocation } from 'react-router-dom'
import { Button, Result } from 'antd'
import { useAuth } from '../hooks/useAuth'
import type { UserRole } from '../types/auth'
import { resolveLoginRedirect } from '../utils/loginRedirect'
import { getDefaultHome } from '../utils/roleNavigation'

type RequireAuthProps = {
  children: React.ReactNode
  /** 不传则任意已登录用户可访问 */
  allowedRoles?: UserRole[]
}

export function RequireAuth({ children, allowedRoles }: RequireAuthProps) {
  const location = useLocation()
  const { session } = useAuth()

  if (!session) {
    const redirect = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`/login?redirect=${redirect}`} replace />
  }

  if (allowedRoles && !allowedRoles.includes(session.role)) {
    return <Result status="403" title="没有访问权限" subTitle="当前账号无权访问此页面。"
      extra={<Link to={getDefaultHome(session.role)}><Button type="primary">返回工作台</Button></Link>} />
  }

  return children
}

type GuestOnlyProps = {
  children: React.ReactNode
}

/** 登录后只回到当前角色可进入的页面，否则返回当前角色工作台。 */
export function GuestOnly({ children }: GuestOnlyProps) {
  const { session } = useAuth()
  const location = useLocation()

  if (session) {
    const params = new URLSearchParams(location.search)
    const target = resolveLoginRedirect(
      session.role,
      params.get('redirect'),
    )

    return <Navigate to={target} replace />
  }

  return children
}
