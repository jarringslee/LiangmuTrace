import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { io } from 'socket.io-client'
import { apiBaseUrl, authMode } from '../config/api'
import { useAuth } from './useAuth'
import { getAuthRevision } from '../utils/auth'
import type { NotificationQuery } from '../types/notification'
import { listNotifications, markNotificationRead } from '../services/notificationDataSource'
import { subscribeDemoNotifications } from '../services/notificationDemo'
import { chatKey } from './useChat'

// 缓存包含模式和用户 ID，避免不同账号共用通知。
const notificationKey = (userId: string | undefined) =>
    ['notifications', authMode, userId ?? 'anonymous'] as const


// 查询通知列表、标记已读，交给 TanStack Query 管缓存和 loading
export function useNotifications(input: NotificationQuery) {
    const { session, isAuthenticated } = useAuth()
    const queryClient = useQueryClient()
    const key = notificationKey(session?.userId)

    const query = useQuery({
        queryKey: [...key, input],
        queryFn: ({ signal }) => listNotifications(input, signal),
        enabled: isAuthenticated,
        refetchOnWindowFocus: true,
    })

    const markRead = useMutation({
        mutationFn: markNotificationRead,
        retry: false,
        // 已读成功后，刷新该用户所有筛选/分页对应的通知缓存。
        onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
    })

    return { query, markRead }
}

/** 只在 App 挂载一次，通知与人工聊天共用连接，页面和铃铛不各自创建 Socket。 */
// Socket.IO 实时连接（通常从轮询升级到 WebSocket）；收到通知变更后让缓存失效，不直接追加数组。

export function useNotificationRealtime() {
    const { session, isAuthenticated, invalidateAuth } = useAuth()
    const queryClient = useQueryClient()
    const userId = session?.userId
    const revision = getAuthRevision()

    useEffect(() => {
        if (!isAuthenticated || !userId) return

        const invalidate = () => {
            void queryClient.invalidateQueries({
                queryKey: notificationKey(userId),
            })
        }

        // demo 使用本地事件，不连接真实后端。
        if (authMode === 'demo') {
            return subscribeDemoNotifications(invalidate)
        }

        let active = true
        const socket = io(
            new URL(apiBaseUrl, window.location.origin).origin,
            {
                path: '/socket.io',
                auth: { userId },
                withCredentials: true,
                autoConnect: false,
            },
        )

        const sync = () => {
            // 旧连接的回调不能影响新账号。
            if (active && getAuthRevision() === revision) {
                invalidate()
                void queryClient.invalidateQueries({ queryKey: chatKey(userId) })
            }
        }
        const syncChat = () => {
            if (active && getAuthRevision() === revision) {
                void queryClient.invalidateQueries({ queryKey: chatKey(userId) })
            }
        }

        const expired = () => {
            if (!active || getAuthRevision() !== revision) return

            socket.disconnect()
            invalidateAuth('实时连接的登录身份已失效，请重新登录')
        }

        // 首次连接、自动重连都重新查询数据库。
        socket.on('connect', sync)
        socket.on('notifications:changed', sync)
        socket.on('chat:changed', syncChat)
        socket.on('session:invalid', expired)

        socket.on('connect_error', (error) => {
            const code = error.data?.code
            if ([
                'INVALID_TOKEN',
                'UNAUTHENTICATED',
                'SESSION_CHANGED',
                'ACCOUNT_DISABLED',
                'ORGANIZATION_DISABLED',
                'INVALID_ORGANIZATION',
            ].includes(code)) {
                expired()
            }
        })

        // 先注册监听，再连接，避免遗漏连接事件。
        socket.connect()

        return () => {
            active = false
            socket.removeAllListeners()
            socket.disconnect()
        }
    }, [isAuthenticated, userId, revision, queryClient, invalidateAuth])
}
