// 先判断地址安全，再判断它是否属于当前角色或共享页面。比如管理员不能沿用 /buyer/herbs，但可以回到 /trace/某个编号；该编号是否有权查看，仍由后端判断。

import { matchPath, parsePath } from 'react-router-dom'
import type { UserRole } from '../types/auth'
import { sanitizeRedirectPath } from './auth'
import { getDefaultHome } from './roleNavigation'

// 这里只决定登录后的落点，不代替路由守卫或后端资源权限。
const sharedRoutePatterns: readonly string[] = [
    '/messages',
    '/chat',
    '/profile',
    '/trace/:traceCode',
    '/public/trace/:traceCode',
]

// 使用明确的页面模式，避免 /buyer/herbs-extra 等未知路径被放行。
// 新增页面时需要同步这份回跳白名单。
const roleRoutePatterns: Record<UserRole, readonly string[]> = {
    admin: [
        '/dashboard',
        '/admin/herbs',
        '/admin/herbs/new',
    ],
    grower: [
        '/grower/dashboard',
        '/grower/batches',
        '/grower/batches/new',
        '/grower/logs',
        '/grower/logs/new',
        '/grower/harvest',
        '/grower/harvest/new',
    ],
    processor: [
        '/processor/dashboard',
        '/processor/batches',
    ],
    buyer: [
        '/buyer/herbs',
    ],
}

export function resolveLoginRedirect(
    role: UserRole,
    candidate: string | null | undefined,
): string {
    // 第一步：复用现有安全过滤，拒绝外链和登录循环等地址。
    const safePath = sanitizeRedirectPath(candidate)
    if (!safePath) return getDefaultHome(role)

    // 第二步：只用 pathname 匹配页面，不让查询参数或锚点干扰匹配。
    const pathname = parsePath(safePath).pathname ?? '/'
    const patterns = [
        ...sharedRoutePatterns,
        ...roleRoutePatterns[role],
    ]

    const matches = patterns.some((pattern) =>
        matchPath({ path: pattern, end: true }, pathname) !== null,
    )

    // 返回原地址，保留合法目标的查询参数与锚点。
    return matches ? safePath : getDefaultHome(role)
}