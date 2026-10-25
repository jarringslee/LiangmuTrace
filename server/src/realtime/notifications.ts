import type { Server as HttpServer } from 'node:http'
import { decodeJwt } from 'jose'
import { Server } from 'socket.io'
import { z } from 'zod'
import { env } from '../config/env.js'
import { verifyAccessToken } from '../lib/token.js'
import { readSessionToken } from '../lib/sessionCookie.js'
import { HttpError } from '../middleware/error.js'
import type { AuthService, AuthUser } from '../services/auth.js'
import { notificationChanges, type NotificationChanges } from '../services/notificationChanges.js'
import { chatChanges } from '../services/chatChanges.js'

const handshakeSchema = z.object({ userId: z.string().min(1).max(200).optional() }).strict()
type ServerEvents = {
  'notifications:changed': () => void
  'chat:changed': () => void
  'session:invalid': (error: { code: string; message: string }) => void
}
type SocketData = { user: AuthUser; token: string; expiresAt: number }
const room = (id: string) => `notification-user:${id}`

/** Socket 不接收业务写入和加入房间指令；身份/收件人一律由服务器决定。 */
export function attachNotificationRealtime(
  server: HttpServer,
  auth: AuthService,
  changes: NotificationChanges = notificationChanges,
  recheckMs = 30_000,
  humanChatChanges: NotificationChanges = chatChanges,
) {
  const io = new Server<Record<string, never>, ServerEvents, Record<string, never>, SocketData>(server, {
    cors: { origin: env.CLIENT_ORIGIN, credentials: true }, maxHttpBufferSize: 16_384,
    // CORS 本身不约束 WebSocket，额外检查浏览器握手 Origin；无 Origin 的 CLI 仍须有效 Cookie。
    allowRequest: (req, done) => done(null, !req.headers.origin || req.headers.origin === env.CLIENT_ORIGIN),
  })
  io.use(async (socket, next) => {
    try {
      // 不再接收前端 token 或指定用户/房间，只读取浏览器握手自动携带的 Cookie。
      const expected = handshakeSchema.parse(socket.handshake.auth)
      const token = readSessionToken(socket.request.headers.cookie)
      if (!token) throw new HttpError(401, 'UNAUTHENTICATED', '请先登录')
      const user = await auth.currentUser(await verifyAccessToken(token))
      if (expected.userId && expected.userId !== user.id) {
        throw new HttpError(409, 'SESSION_CHANGED', '登录账号已变化，请刷新页面后重试')
      }
      // 仅在签名、issuer、audience 和有效期验证通过后读取 exp，不能用 decode 代替验签。
      socket.data = { user, token, expiresAt: decodeJwt(token).exp! * 1000 }
      next()
    } catch (error) {
      const denied = new Error('实时通知连接未通过认证') as Error & { data: { code: string } }
      denied.data = { code: error instanceof HttpError ? error.code : 'INVALID_HANDSHAKE' }
      next(denied)
    }
  })
  io.on('connection', (socket) => {
    void socket.join(room(socket.data.user.id))
    const invalidateSession = () => {
      socket.emit('session:invalid', { code: 'SESSION_INVALID', message: '登录身份已变化或过期，请重新登录' })
      socket.disconnect(true)
    }
    const expiry = setTimeout(invalidateSession, Math.max(0, socket.data.expiresAt - Date.now()))
    // 中间件只在连接时执行；已连接账号的停用、组织/角色变化需再次检查。
    let checking = false
    const check = setInterval(async () => {
      if (checking || !socket.connected) return
      checking = true
      try {
        const current = await auth.currentUser(await verifyAccessToken(socket.data.token))
        if (
          current.role !== socket.data.user.role ||
          current.organizationId !== socket.data.user.organizationId
        ) invalidateSession()
      } catch (error) {
        if (error instanceof HttpError && [401, 403].includes(error.status)) invalidateSession()
        else socket.conn.close() // 临时故障关闭传输层，让客户端自动重连；不误判账号永久失效。
      } finally { checking = false }
    }, recheckMs)
    expiry.unref()
    check.unref()
    socket.once('disconnect', () => { clearTimeout(expiry); clearInterval(check) })
  })
  const unsubscribe = changes.subscribe((ids) => {
    for (const id of ids) io.to(room(id)).emit('notifications:changed')
  })
  server.once('close', unsubscribe)
  const unsubscribeChat = humanChatChanges.subscribe((ids) => {
    for (const id of ids) io.to(room(id)).emit('chat:changed')
  })
  server.once('close', unsubscribeChat)
  return io
}
