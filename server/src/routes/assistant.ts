import { Router, type ErrorRequestHandler } from 'express'
import { rateLimit } from 'express-rate-limit'
import { authenticate } from '../middleware/auth.js'
import { HttpError } from '../middleware/error.js'
import type { AuthService } from '../services/auth.js'
import { assistantQuestionSchema, type AssistantService } from '../services/assistant.js'
import { conversationMessageSchema, type AssistantConversationService } from '../services/assistantConversation.js'
import { z } from 'zod'
import { publicAssistantError } from '../services/assistantErrors.js'

export function createAssistantRouter(auth: AuthService, service: AssistantService, conversations?: AssistantConversationService) {
  const router = Router()
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
  router.use(authenticate(auth))
  const limiter = rateLimit({
    windowMs: 60_000, limit: 10, keyGenerator: (req) => req.auth!.id,
    standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, _res, next) => next(new HttpError(429, 'AI_RATE_LIMITED', '提问过于频繁，请稍后重试')),
  })
  // 新接口与旧 /chat 共用提问限流；读取历史不会调用模型。
  const storageError = (error: unknown): never => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2021')
      throw new HttpError(503, 'ASSISTANT_STORAGE_NOT_READY', '聊天数据库表尚未建立，请先完成已确认的迁移')
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
      throw new HttpError(409, 'AI_REQUEST_CONFLICT', '并发请求发生冲突，请刷新历史后再试')
    throw error
  }
  router.get('/conversation', async (req, res) => {
    z.object({}).strict().parse(req.query)
    if (!conversations) throw new HttpError(503, 'ASSISTANT_STORAGE_NOT_READY', '会话服务尚未接入')
    try { res.json(await conversations.read(req.auth!)) } catch (error) { storageError(error) }
  })
  router.post('/conversation/messages', limiter, async (req, res) => {
    const input = conversationMessageSchema.parse(req.body)
    if (!conversations) throw new HttpError(503, 'ASSISTANT_STORAGE_NOT_READY', '会话服务尚未接入')
    const controller = new AbortController()
    const disconnected = () => { if (!res.writableEnded) controller.abort() }
    req.once('aborted', disconnected)
    res.once('close', disconnected)
    try {
      const turn = await conversations.send(req.auth!, input, controller.signal)
      if (!controller.signal.aborted && !res.destroyed) res.json({ turn })
    } catch (error) { storageError(error) } finally {
      req.off('aborted', disconnected)
      res.off('close', disconnected)
    }
  })
  router.post('/conversation/messages/stream', limiter, async (req, res, next) => {
    const input = conversationMessageSchema.parse(req.body)
    if (!conversations) throw new HttpError(503, 'ASSISTANT_STORAGE_NOT_READY', '会话服务尚未接入')
    const controller = new AbortController()
    const disconnected = () => { if (!res.writableEnded) controller.abort() }
    req.once('aborted', disconnected); res.once('close', disconnected)
    let heartbeat: ReturnType<typeof setInterval> | undefined, seq = 0
    const send = (event: string, data: unknown) => {
      controller.signal.throwIfAborted()
      if (res.destroyed) { controller.abort(); controller.signal.throwIfAborted() }
      if (!res.headersSent) {
        res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' })
        res.flushHeaders()
        heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n') }, 10_000)
        heartbeat.unref()
      }
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    try {
      const turn = await conversations.send(req.auth!, input, controller.signal, text => {
        send('delta', { requestId: input.requestId, seq: ++seq, text })
      })
      // 只有完整校验及落库后的 turn 才是成功终态；规则拒答可直接返回 result。
      send('result', { turn }); res.end()
    } catch (error) {
      if (controller.signal.aborted || res.destroyed) return
      if (!res.headersSent) { try { storageError(error) } catch (safe) { next(safe) }; return }
      const mapped = publicAssistantError(error)
      const safe = mapped instanceof HttpError ? mapped : new HttpError(500, 'INTERNAL_ERROR', '刚刚系统有点开小差，再问一遍试试吧～')
      send('error', { status: safe.status, code: safe.code, message: safe.message }); res.end()
    } finally {
      if (heartbeat) clearInterval(heartbeat)
      req.off('aborted', disconnected); res.off('close', disconnected)
    }
  })
  router.post('/chat', limiter, async (req, res) => {
    const input = assistantQuestionSchema.parse(req.body)
    const controller = new AbortController()
    const disconnected = () => { if (!res.writableEnded) controller.abort() }
    req.once('aborted', disconnected)
    res.once('close', disconnected)
    try {
      const reply = await service.ask(req.auth!, input, controller.signal)
      // 四角色均可普通聊天；模型等待期间被停用/变更身份，不能返回旧身份的回复。
      const current = await auth.currentUser(req.auth!.id)
      if (current.role !== req.auth!.role || current.organizationId !== req.auth!.organizationId) {
        throw new HttpError(403, 'FORBIDDEN', '身份权限已经变化，请重新登录')
      }
      if (!controller.signal.aborted && !res.destroyed) res.json({ reply })
    } finally {
      req.off('aborted', disconnected)
      res.off('close', disconnected)
    }
  })
  const sanitize: ErrorRequestHandler = (error, _req, _res, next) => next(publicAssistantError(error))
  router.use(sanitize)
  return router
}
