/** 应用入口工厂文件
 * 提供 createApp 工厂函数，用来创建并配置整个Express应用实例
 * 统一加载中间件、挂载所有业务路由，支持依赖注入方便单元测试
 */
import cors from 'cors'
import express from 'express'
import { env } from './config/env.js'
// 健康检查路由
import { healthRouter } from './routes/health.js'
// 认证模块路由工厂
import { createAuthRouter } from './routes/auth.js'
// 认证服务工厂与类型定义
import { createAuthService, type AuthService } from './services/auth.js'
// 全局错误处理中间件、自定义HTTP错误类
import { errorHandler, HttpError } from './middleware/error.js'
// 批次模块路由工厂
import { createBatchRouter } from './routes/batches.js'
import { createRiskAnalysisRouter } from './routes/riskAnalysis.js'
import { createRiskAnalysisService, type RiskAnalysisService } from './services/riskAnalysis.js'
import { createHerbQuestionRouter } from './routes/herbQuestion.js'
import { createHerbQuestionService, type HerbQuestionService } from './services/herbQuestion.js'
import { createNotificationRouter } from './routes/notifications.js'
import { createNotificationService, type NotificationService } from './services/notifications.js'
import { createAssistantRouter } from './routes/assistant.js'
import { createAssistantService, type AssistantService } from './services/assistant.js'
import { createAssistantConversationService, type AssistantConversationService } from './services/assistantConversation.js'
import { createDashboardRouter } from './routes/dashboard.js'
import { createDashboardService, type DashboardService } from './services/dashboard.js'
import { createChatService, type ChatService } from './services/chat.js'
import { createChatRouter } from './routes/chat.js'
import { createPublicTraceRouter } from './routes/publicTrace.js'
import { createPublicTraceService, type PublicTraceService } from './services/publicTrace.js'
// 批次业务服务工厂与类型定义
import {
  createBatchService,
  type BatchService,
} from './services/batches.js'

/**
 * 创建Express应用实例的工厂函数
 * @param authService 认证服务，不传则自动创建真实认证服务
 * @param batchService 批次业务服务，不传则自动创建真实批次服务
 * 支持传入mock服务，用于自动化测试，避免连接真实数据库
 */
export function createApp(
  authService: AuthService = createAuthService(),
  batchService: BatchService = createBatchService(),
  riskAnalysisService: RiskAnalysisService = createRiskAnalysisService(batchService, undefined, undefined, authService),
  herbQuestionService: HerbQuestionService = createHerbQuestionService(batchService),
  notificationService: NotificationService = createNotificationService(),
  assistantService: AssistantService = createAssistantService(),
  assistantConversationService: AssistantConversationService = createAssistantConversationService({ batches: batchService, auth: authService }),
  dashboardService: DashboardService = createDashboardService(),
  chatService: ChatService = createChatService(),
  publicTraceService: PublicTraceService = createPublicTraceService(),
) {
  // 初始化express app实例
  const app = express()
  // 默认关闭；仅信任已核对的代理地址，供 req.ip 与各接口限流共用。
  app.set('trust proxy', env.TRUST_PROXY)

  // CORS 只决定浏览器能否读取响应，不替代 JWT/角色/组织鉴权。
  // 项目使用 Authorization: Bearer，不依赖跨站 Cookie。
  app.use(
    cors({
      origin: (origin, done) => done(null, !origin || origin === env.CLIENT_ORIGIN),
      allowedHeaders: ['Authorization', 'Content-Type'],
      exposedHeaders: ['Retry-After'],
    }),
  )

  // 解析请求体为json，限制最大请求体大小2MB，防止超大请求攻击
  app.use(express.json({ limit: '2mb' }))

  // 挂载健康检查接口 /api
  app.use('/api', healthRouter)
  // 挂载鉴权相关接口 /api/auth，注入认证服务
  app.use('/api/auth', createAuthRouter(authService))
  app.use('/api/public/trace', createPublicTraceRouter(publicTraceService))
  app.use('/api/notifications', createNotificationRouter(authService, notificationService))
  app.use('/api/chat', createChatRouter(authService, chatService))
  app.use('/api/assistant', createAssistantRouter(authService, assistantService, assistantConversationService))
  app.use('/api/dashboard', createDashboardRouter(authService, dashboardService))
  app.use('/api/batches', createRiskAnalysisRouter(authService, riskAnalysisService))
  app.use('/api/batches', createHerbQuestionRouter(authService, herbQuestionService))
  // 挂载药材批次接口 /api/batches，注入鉴权服务和批次业务服务
  app.use(
    '/api/batches',
    createBatchRouter(authService, batchService),
  )

  // 兜底中间件：访问不存在的接口路径，抛出404自定义错误
  app.use((_req, _res, next) => {
    next(new HttpError(404, 'NOT_FOUND', 'API route not found'))
  })

  // 全局统一异常捕获处理中间件，格式化所有接口抛出的错误并返回给前端
  app.use(errorHandler)

  // 返回配置完成的express应用实例
  return app
}
