type ApiConfigInput = {
  mode?: string
  baseUrl?: string
  production: boolean
}

type ApiConfig = {
  authMode: 'api' | 'demo'
  apiBaseUrl: string
}

/** 纯函数：不读取环境变量，便于页面和构建工具共用、独立测试。 */
export function resolveApiConfig({
  mode,
  baseUrl,
  production,
}: ApiConfigInput): ApiConfig {
  const authMode = mode ?? 'demo'

  if (authMode !== 'api' && authMode !== 'demo') {
    throw new Error('VITE_AUTH_MODE 必须为 api 或 demo')
  }

  // 未配置时使用默认值；显式空字符串不能悄悄退回默认值。
  const raw = (baseUrl ?? '/api').trim().replace(/\/+$/, '')

  // 同源地址：开发时由 Vite 代理，生产时需要真正的服务端代理。
  if (raw === '/api') {
    return { authMode, apiBaseUrl: raw }
  }

  const invalidUrlMessage =
    'VITE_API_BASE_URL 必须为 /api 或完整的 http(s)://域名/api'

  if (!/^https?:\/\//i.test(raw)) {
    throw new Error(invalidUrlMessage)
  }

  let url: URL

  try {
    url = new URL(raw)
  } catch {
    throw new Error(invalidUrlMessage)
  }

  // 配置只描述接口地址，不允许夹带账号密码、查询参数或片段。
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/api'
  ) {
    throw new Error(invalidUrlMessage)
  }

  if (production && url.protocol !== 'https:') {
    throw new Error('生产环境的跨域 API 地址必须使用 HTTPS')
  }

  // 当前 Cookie 是 SameSite=Lax，禁止把旧的 Pages → Render 跨站直连配置再次发布。
  if (production && authMode === 'api') {
    throw new Error('生产 API 模式的 VITE_API_BASE_URL 必须为 /api，并配置 /api、/socket.io 同源代理')
  }

  return {
    authMode,
    apiBaseUrl: `${url.origin}/api`,
  }
}
