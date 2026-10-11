import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createElement, lazy, Suspense } from 'react'
import { renderToString, renderToPipeableStream } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { createServer } from 'vite'
import ts from 'typescript'
import { collectStaticFiles } from '../scripts/check-bundle.mjs'
import { App as AntdApp, ConfigProvider, message as staticMessage, Modal, theme } from 'antd'

let vite, PageLoading, PageErrorBoundary, RequireAuth, GuestOnly, authFixture, navigationFixture, resolveLoginRedirect
before(async () => {
  vite = await createServer({
    cacheDir: 'node_modules/.vite-tests/engineering',
    server: { middlewareMode: true, hmr: false, watch: null },
    ssr: { noExternal: ['@ant-design/icons', '@ant-design/icons-svg', '@rc-component/util'] },
    optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'silent',
    plugins: [{
      name: 'engineering-auth-fixture', enforce: 'pre',
      resolveId(source, importer) {
        const isGuard = importer?.replaceAll('\\', '/').endsWith('/components/RequireAuth.tsx')
        if (source === 'virtual:engineering-auth' ||
          (source === '../hooks/useAuth' && isGuard)) {
          return '\0virtual:engineering-auth'
        }
        if (source === 'virtual:engineering-navigation') {
          return '\0virtual:engineering-navigation'
        }
      },
      transform(code, id) {
        // 仅替换守卫的测试导入；真实路由工具和生产代码不受影响。
        if (id.replaceAll('\\', '/').endsWith('/components/RequireAuth.tsx')) {
          return code.replace(/(from\s+)(['"])react-router-dom\2/g, '$1$2virtual:engineering-navigation$2')
        }
      },
      load(id) {
        if (id === '\0virtual:engineering-auth') return 'export const authFixture = { session: null }; export const useAuth = () => authFixture'
        // SSR 不执行 Navigate 的浏览器 effect，只记录守卫实际传出的目标与 replace。
        if (id === '\0virtual:engineering-navigation') return `
          export * from 'react-router-dom'
          export const navigationFixture = { last: null }
          export function Navigate(props) { navigationFixture.last = props; return null }
        `
      },
    }],
  })
  PageLoading = (await vite.ssrLoadModule('/src/components/PageLoading.tsx')).default
  PageErrorBoundary = (await vite.ssrLoadModule('/src/components/PageErrorBoundary.tsx')).default
  const guards = await vite.ssrLoadModule('/src/components/RequireAuth.tsx')
  RequireAuth = guards.RequireAuth
  GuestOnly = guards.GuestOnly
  authFixture = (await vite.ssrLoadModule('virtual:engineering-auth')).authFixture
  navigationFixture = (await vite.ssrLoadModule('virtual:engineering-navigation')).navigationFixture
  resolveLoginRedirect = (await vite.ssrLoadModule('/src/utils/loginRedirect.ts')).resolveLoginRedirect
})
after(async () => { await vite?.close() })

test('页面/图表加载提示有状态语义和保留高度', () => {
  const html = renderToString(createElement(PageLoading, { label: '正在加载图表…', height: 300 }))
  assert.match(html, /role="status"/)
  assert.match(html, /aria-live="polite"/)
  assert.match(html, /min-height:300px/)
  assert.match(html, /正在加载图表/)
})

test('错误边界状态渲染恢复入口，不暴露内部异常；普通状态保持子树', () => {
  const boundary = new PageErrorBoundary({ children: createElement('p', null, '批次列表'), scope: '图表' })
  assert.match(renderToString(boundary.render()), /批次列表/)
  boundary.state = PageErrorBoundary.getDerivedStateFromError(new Error('private database information'))
  const html = renderToString(boundary.render())
  assert.match(html, /图表加载或显示失败/)
  assert.match(html, /重新加载当前页/)
  assert.match(html, /href="\/"/)
  assert.doesNotMatch(html, /private database information|批次列表/)
  // SSR 不捕获 Error Boundary 的子组件错误，真实 import 失败另经浏览器验收。
})

test('Suspense 先输出等待内容，lazy 模块就绪后输出真正组件', { timeout: 5000 }, async (context) => {
  let resolveModule
  const modulePromise = new Promise((resolve) => { resolveModule = resolve })
  const DelayedPage = lazy(() => modulePromise)
  const output = new PassThrough()
  let html = ''
  let firstChunkReady
  const firstChunk = new Promise((resolve) => { firstChunkReady = resolve })
  output.on('data', (chunk) => { html += chunk.toString(); firstChunkReady() })
  let shellReady
  const shell = new Promise((resolve) => { shellReady = resolve })
  const completed = new Promise((resolve, reject) => {
    output.on('end', resolve); output.on('error', reject)
  })
  const stream = renderToPipeableStream(createElement('main', null, createElement(Suspense,
    { fallback: createElement(PageLoading) }, createElement(DelayedPage))), {
    onShellReady() { stream.pipe(output); shellReady() },
    onError(error) { output.destroy(error) },
  })
  context.after(() => stream.abort())
  await shell
  await firstChunk
  assert.match(html, /正在加载页面/)
  resolveModule({ default: () => createElement('p', null, '模块已加载') })
  await completed
  assert.match(html, /模块已加载/)
})

test('角色守卫拒绝越权时不执行 lazy loader，合法角色才进入模块', () => {
  let loads = 0
  const ProtectedPage = lazy(() => { loads++; return Promise.resolve({ default: () => null }) })
  const render = () => renderToString(createElement(MemoryRouter, { initialEntries: ['/dashboard'] },
    createElement(Suspense, { fallback: '加载中' },
      createElement(RequireAuth, { allowedRoles: ['admin'] }, createElement(ProtectedPage)))))
  authFixture.session = { role: 'buyer' }
  assert.match(render(), /没有访问权限/)
  assert.equal(loads, 0)
  authFixture.session = { role: 'admin' }
  render()
  assert.equal(loads, 1)
})

const roleHomes = {
  admin: '/dashboard', grower: '/grower/dashboard', processor: '/processor/dashboard', buyer: '/buyer/herbs',
}

test('登录回跳允许本角色页面，其他角色页面回到自己的工作台', () => {
  const pages = {
    admin: ['/dashboard', '/admin/herbs', '/admin/herbs/new'],
    grower: ['/grower/dashboard', '/grower/batches', '/grower/batches/new', '/grower/logs', '/grower/logs/new', '/grower/harvest', '/grower/harvest/new'],
    processor: ['/processor/dashboard', '/processor/batches'],
    buyer: ['/buyer/herbs'],
  }
  for (const role of Object.keys(roleHomes)) {
    for (const [owner, paths] of Object.entries(pages)) {
      for (const path of paths) {
        assert.equal(resolveLoginRedirect(role, path), owner === role ? path : roleHomes[role])
      }
    }
  }
})

test('共享页可回跳，合法目标保留查询参数、锚点和末尾斜杠', () => {
  const paths = [
    '/messages', '/chat?contact=demo#history', '/profile/',
    '/trace/YM-TRACE-2026-0015?from=list#timeline', '/public/trace/YM-TRACE-2026-0015',
  ]
  for (const role of Object.keys(roleHomes)) {
    for (const path of paths) assert.equal(resolveLoginRedirect(role, path), path)
  }
  assert.equal(resolveLoginRedirect('buyer', '/buyer/herbs?search=黄精#list'), '/buyer/herbs?search=黄精#list')
})

test('登录回跳拒绝不安全、循环、未知和只匹配前缀的地址', () => {
  const paths = [
    null, undefined, '', 'https://evil.test', '//evil.test', '/\\evil.test', '/\nevil', '/profile\t',
    '/', '/login?redirect=/profile', '/LOGIN/#again', '/unknown', '/buyer/herbs-extra',
    '/buyer/herbs/extra', '/admin/herbs/new/extra', '/grower/logs/extra', '/processor/batches/extra',
    '/messages/extra', '/trace', '/trace/code/extra', '/public/trace', '/public/trace/code/extra',
  ]
  for (const role of Object.keys(roleHomes)) {
    for (const path of paths) assert.equal(resolveLoginRedirect(role, path), roleHomes[role], `${role}: ${String(path)}`)
  }
})

test('回跳白名单与 App 实际页面及 allowedRoles 保持一致', () => {
  const ast = ts.createSourceFile('App.tsx', readFileSync('src/App.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let checked = 0
  const attribute = (node, name) => node.attributes.properties.find((item) => ts.isJsxAttribute(item) && item.name.getText(ast) === name)
  function visit(node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'Route') {
      const path = attribute(node, 'path')?.initializer
      if (path && ts.isStringLiteral(path) && !['/', '/login', '*'].includes(path.text)) {
        let allowedRoles = Object.keys(roleHomes)
        function findGuard(element) {
          if (ts.isJsxOpeningElement(element) && element.tagName.getText(ast) === 'RequireAuth') {
            const initializer = attribute(element, 'allowedRoles')?.initializer
            if (initializer && ts.isJsxExpression(initializer) && ts.isArrayLiteralExpression(initializer.expression)) {
              allowedRoles = initializer.expression.elements.map((role) => role.text)
            }
          }
          ts.forEachChild(element, findGuard)
        }
        findGuard(node)
        const target = path.text.replace(':traceCode', 'YM-TRACE-2026-0015')
        for (const role of Object.keys(roleHomes)) {
          assert.equal(resolveLoginRedirect(role, target), allowedRoles.includes(role) ? target : roleHomes[role], `${role}: ${target}`)
        }
        checked++
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(checked > 0, '必须找到真实页面，避免空遍历导致测试假通过')
})

test('GuestOnly 接入回跳校验并使用 replace，匿名用户仍看到登录表单', () => {
  const render = (role, target) => {
    authFixture.session = role ? { role } : null
    navigationFixture.last = null
    return renderToString(createElement(MemoryRouter, { initialEntries: [`/login?redirect=${encodeURIComponent(target)}`] },
      createElement(GuestOnly, null, createElement('p', null, '登录表单'))))
  }
  for (const [role, candidate, expected] of [
    ['admin', '/buyer/herbs', '/dashboard'],
    ['buyer', '/buyer/herbs?search=黄精#list', '/buyer/herbs?search=黄精#list'],
    ['grower', '/trace/YM-TRACE-2026-0015', '/trace/YM-TRACE-2026-0015'],
    ['processor', '//evil.test', '/processor/dashboard'],
  ]) {
    assert.doesNotMatch(render(role, candidate), /登录表单/)
    assert.equal(navigationFixture.last.to, expected)
    assert.equal(navigationFixture.last.replace, true)
  }
  assert.match(render(null, '/buyer/herbs'), /登录表单/)
  assert.equal(navigationFixture.last, null)
})

test('RequireAuth 未登录仍携带原页面和查询参数返回登录页', () => {
  authFixture.session = null
  navigationFixture.last = null
  renderToString(createElement(MemoryRouter, { initialEntries: ['/buyer/herbs?search=黄精'] },
    createElement(RequireAuth, { allowedRoles: ['buyer'] }, createElement('p', null, '私有页面'))))
  assert.equal(navigationFixture.last.to, `/login?redirect=${encodeURIComponent('/buyer/herbs?search=黄精')}`)
  assert.equal(navigationFixture.last.replace, true)
})

test('构建静态图递归去重/处理环，不把 dynamicImports 计入首屏，缺失项失败', () => {
  const manifest = {
    root: { file: 'root.js', imports: ['shared'], dynamicImports: ['page'] },
    shared: { file: 'shared.js', imports: ['root'] },
    page: { file: 'page.js', imports: ['shared'] },
  }
  assert.deepEqual(collectStaticFiles(manifest, ['root']), ['root.js', 'shared.js'])
  assert.deepEqual(collectStaticFiles(manifest, ['root', 'page']), ['root.js', 'shared.js', 'page.js'])
  assert.throws(() => collectStaticFiles(manifest, ['missing']), /manifest 缺少/)
})

test('图表没有全量 ECharts 引入，JSX 不再使用本刀清理的旧组件属性', () => {
  const chart = readFileSync('src/components/charts/DashboardChart.tsx', 'utf8')
  assert.doesNotMatch(chart, /from ['"](?:echarts|echarts-for-react)['"]/)
  assert.match(chart, /echarts\/core/)
  assert.match(chart, /CanvasRenderer/)
  const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(directory, entry.name)) : entry.name.endsWith('.tsx') ? [join(directory, entry.name)] : [])
  for (const file of walk('src')) {
    const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    function visit(node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const component = node.tagName.getText(ast)
        for (const attr of node.attributes.properties) {
          if (!ts.isJsxAttribute(attr)) continue
          const name = attr.name.getText(ast)
          const deprecated = (['Card', 'Tag'].includes(component) && name === 'bordered') ||
            (component === 'Space' && name === 'direction') || (component === 'Alert' && name === 'message') ||
            (['Drawer', 'Modal'].includes(component) && name === 'destroyOnClose') ||
            (component === 'Drawer' && name === 'width')
          assert.equal(deprecated, false, `${file}: ${component}.${name}`)
          if (component === 'Timeline' && name === 'mode' && attr.initializer && ts.isStringLiteral(attr.initializer)) {
            assert.ok(!['left', 'right'].includes(attr.initializer.text), `${file}: Timeline.mode 使用 start/end`)
          }
          if (component === 'Timeline' && name === 'items' && attr.initializer) {
            function checkItem(item) {
              if (ts.isPropertyAssignment(item)) {
                assert.ok(!['children', 'dot'].includes(item.name.getText(ast)), `${file}: Timeline.items 使用 content/icon`)
              }
              ts.forEachChild(item, checkItem)
            }
            checkItem(attr.initializer)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
})

test('AntdApp 为子组件提供实际提示/弹窗实例并读取上层主题，不使用静态实例', () => {
  let instances
  function Probe() {
    instances = AntdApp.useApp()
    const { token } = theme.useToken()
    return createElement('p', null, token.colorPrimary)
  }
  const html = renderToString(createElement(ConfigProvider, { theme: { token: { colorPrimary: '#315a42' } } },
    createElement(AntdApp, null, createElement(Probe))))
  assert.match(html, /#315a42/)
  assert.equal(typeof instances.message.success, 'function')
  assert.equal(typeof instances.modal.confirm, 'function')
  assert.notEqual(instances.message, staticMessage)
  assert.notEqual(instances.modal.confirm, Modal.confirm)
  // SSR 只证明上下文/实例读取；弹窗行为与主题警告另由真实浏览器检查。
})

test('根部上下文层级正确，业务组件不直接调用 antd 静态提示/确认函数', () => {
  const app = readFileSync('src/App.tsx', 'utf8')
  assert.match(app, /<ConfigProvider[^>]*>\s*<AntdApp>\s*<BrowserRouter>/)
  assert.doesNotMatch(app, /<AntdApp[^>]*component=\{false\}/)
  const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(directory, entry.name)) : entry.name.endsWith('.tsx') ? [join(directory, entry.name)] : [])
  for (const file of walk('src')) {
    const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const forbidden = new Map()
    for (const node of ast.statements) {
      if (!ts.isImportDeclaration(node) || node.moduleSpecifier.text !== 'antd') continue
      const bindings = node.importClause?.namedBindings
      if (!bindings || !ts.isNamedImports(bindings)) continue
      for (const spec of bindings.elements) {
        const imported = (spec.propertyName ?? spec.name).text
        if (['message', 'notification', 'Modal'].includes(imported)) forbidden.set(spec.name.text, imported)
      }
    }
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const { expression, name } = node.expression
        if (ts.isIdentifier(expression) && forbidden.has(expression.text)) {
          const allowed = ['useMessage', 'useNotification', 'useModal'].includes(name.text)
          assert.ok(allowed, `${file}: 请使用上下文实例，而非 ${expression.text}.${name.text}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
})

test('sold 仅改变展示语义，受控阶段标题适配旧记录，普通备注保持原文', async () => {
  const { STAGE_LABEL } = await vite.ssrLoadModule('/src/types/herb.ts')
  const Timeline = (await vite.ssrLoadModule('/src/components/herb/TraceTimeline.tsx')).default
  const { welcomeSlides } = await vite.ssrLoadModule('/src/mock/login/welcomeSlides.ts')
  assert.equal(STAGE_LABEL.sold, '已收货')
  assert.deepEqual(Object.keys(STAGE_LABEL), ['planting', 'harvested', 'processing', 'warehousing', 'shipped', 'sold'])
  const event = { id: 'legacy', type: 'stageChange', title: '阶段变更：已出库 → 已售',
    fromStage: 'shipped', toStage: 'sold', occurredAt: '2026-10-09 12:00:00', scopes: ['public'] }
  const html = renderToString(createElement(Timeline, { role: 'buyer', events: [event] }))
  assert.match(html, /已收货/); assert.doesNotMatch(html, /已售/)
  assert.equal(event.title, '阶段变更：已出库 → 已售')
  const note = renderToString(createElement(Timeline, { role: 'buyer', events: [{ ...event, type: 'note', title: '旧术语“已售”说明' }] }))
  assert.match(note, /旧术语“已售”说明/)
  const copy = welcomeSlides.flatMap((slide) => slide.paragraphs).join(' ')
  assert.doesNotMatch(copy, /GMP|温湿度|气象|土壤|设备|合同|监管接口|质量认证要求/)
  assert.match(copy, /药材列表、溯源码或二维码/)
  assert.match(copy, /静态 demo/)
})
