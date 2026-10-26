// Pages 同源入口：浏览器只访问本站，Node/数据库/AI 仍由 Render 承担。
// 固定上游，不能从 URL、查询参数或请求头选择任意转发地址。
const API_ORIGIN = 'https://liangmu-trace-api.onrender.com'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const isBackend = ['/api', '/socket.io'].some(
      path => url.pathname === path || url.pathname.startsWith(`${path}/`),
    )
    if (!isBackend) return env.ASSETS.fetch(request)

    const target = new URL(`${url.pathname}${url.search}`, API_ORIGIN)
    const forwarded = new Request(target, request)
    // Host 按上游 URL 生成；不把客户端可提交的转发头当作可信代理身份。
    for (const name of ['Host', 'Forwarded', 'X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto']) {
      forwarded.headers.delete(name)
    }
    // Cookie、Origin、Referer、CSRF/期待用户头和请求体原样保留，后端仍独立鉴权。
    try {
      const upstream = await fetch(forwarded, { redirect: 'manual', cache: 'no-store', signal: request.signal })
      // 101 包含运行时的 WebSocket 连接，必须直接返回，不能按普通 Response 重建。
      if (upstream.status === 101) return upstream
      // 不读取 text/json，不等待整段正文；SSE 边生成边传输，并保留所有 Set-Cookie。
      const response = new Response(upstream.body, upstream)
      response.headers.set('Cache-Control', 'no-store, no-transform')
      return response
    } catch {
      return Response.json({ error: { code: 'UPSTREAM_UNAVAILABLE', message: '服务暂时无法连接，请稍后重试' } },
        { status: 502, headers: { 'Cache-Control': 'no-store' } })
    }
  },
}
