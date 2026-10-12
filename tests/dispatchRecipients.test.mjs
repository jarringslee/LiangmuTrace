import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { createServer } from 'vite'

let vite, source, authStorage, fixture, queryClient
const originalFetch = globalThis.fetch
const originalGlobals = new Map(['window', 'localStorage', 'sessionStorage']
  .map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
const admin = { userId: 'admin-a', role: 'admin', organizationId: 'platform', displayName: '管理员' }
const buyer = (organizationId) => ({ userId: `buyer-${organizationId}`, role: 'buyer', organizationId, displayName: '采购商' })
const batch = { id: 'batch-a', batchNo: 'YM-BATCH-A', traceCode: 'YM-TRACE-2026-0001', herbName: '黄芪',
  category: 'root', growerId: 'grower-a', growerName: '种植机构', plantingStartDate: '2026-01-01',
  origin: { province: '甘肃省', city: '定西市' }, stage: 'shipped', auditStatus: 'approved', riskLevel: 'normal',
  createdAt: '2026-01-01T01:00:00.000Z', createdBy: '种植商', createdByRole: 'grower',
  updatedAt: '2026-01-01T01:00:00.000Z', events: [], buyerId: 'buyer-org', buyerName: '采购组织', canConfirmReceipt: true }
const apiBatch = { ...batch, growerOrganization: { id: 'grower-a', name: '种植机构' },
  processorOrganization: null, buyerOrganization: { id: 'buyer-org', name: '采购组织' },
  createdBy: { id: 'grower-user', displayName: '种植商', role: 'grower' },
  environment: null, coverImageUrl: null, description: null, requiresProcessing: false, version: 1,
  audits: [], attachments: [] }
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers })

async function setup(mode = 'api') {
  vite = await createServer({ cacheDir: `node_modules/.vite-tests/dispatch-recipients-${mode}`,
    server: { middlewareMode: true, hmr: false, watch: null },
    ssr: { noExternal: ['antd', '@ant-design/icons'] },
    optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'silent',
    define: { 'import.meta.env.VITE_AUTH_MODE': JSON.stringify(mode), 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api') },
    plugins: [{ name: 'dispatch-query-auth-fixture', enforce: 'pre',
      resolveId(source, importer) {
        const file = importer?.replaceAll('\\', '/')
        if (source === 'virtual:trace-identifier-ui' ||
          ['/pages/messages/index.tsx', '/pages/trace/Detail.tsx'].some(path => file?.endsWith(path)) &&
          ['antd', '@ant-design/icons'].includes(source)) return '\0virtual:trace-identifier-ui'
        if (source === 'virtual:trace-identifier-view' || file?.endsWith('/pages/trace/Detail.tsx') &&
          ['../../components/herb/HerbQuestionPanel', '../../components/herb/TraceQuickViewModal',
            '../../components/herb/TraceQrPanel', '../../components/herb/TraceTimeline',
            '../../components/herb/herbTags'].includes(source)) return '\0virtual:trace-identifier-view'
        if (source === 'virtual:dispatch-query-auth' ||
          source === './auth' && file?.endsWith('/services/batchDispatchSupport.ts') ||
          source.endsWith('/useAuth') && ['/hooks/useDispatchRecipients.ts', '/hooks/useNotifications.ts',
            '/pages/messages/index.tsx', '/pages/trace/Detail.tsx'].some(path => file?.endsWith(path))) return '\0virtual:dispatch-query-auth'
      },
      load(id) {
        if (id === '\0virtual:trace-identifier-view') return `
          export const AuditTag = () => null, RiskTag = () => null, StageTag = () => null
          export default () => null
        `
        if (id === '\0virtual:trace-identifier-ui') return `
          import { createElement } from 'react'
          const box = ({ children, title, subTitle }) => createElement('div', null, title, subTitle, children)
          export const Alert = box, Breadcrumb = box, Card = box, Col = box,
            Dropdown = box, Empty = box, Flex = box, Result = box, Row = box, Space = box, Spin = box,
            Tabs = box, Tag = box
          export const Button = ({ children }) => createElement('button', null, children)
          export const Layout = Object.assign(box, { Header: box, Content: box })
          export const descriptionItems = []
          export const Descriptions = Object.assign(box, { Item: (props) => {
            descriptionItems.push({ label: props.label, span: props.span })
            return box(props)
          } })
          export const Typography = { Title: box, Text: box, Paragraph: box }
          export const theme = { useToken: () => ({ token: {} }) }
          export const App = { useApp: () => ({ message: {}, modal: {} }) }
          export const Table = ({ columns, dataSource }) => createElement('table', null,
            createElement('tbody', null, dataSource.map(row => createElement('tr', { key: row.id },
              columns.map((column, index) => createElement('td', { key: index },
                column.render ? column.render(row[column.dataIndex], row) : row[column.dataIndex]))))))
          export const ArrowLeftOutlined = () => null, BellOutlined = () => null,
            MedicineBoxOutlined = () => null, ReloadOutlined = () => null, CheckCircleOutlined = () => null,
            CloseCircleOutlined = () => null, EnvironmentOutlined = () => null, FileDoneOutlined = () => null,
            HistoryOutlined = () => null, HomeOutlined = () => null, MoreOutlined = () => null,
            PaperClipOutlined = () => null
        `
        if (id === '\0virtual:dispatch-query-auth') return `
        export const fixture = { status: 'authenticated', session: null }
        export const getAuthSnapshot = () => fixture
        export const useAuth = () => ({ ...fixture, isAuthenticated: fixture.status === 'authenticated' })
      ` },
    }],
  })
  fixture = (await vite.ssrLoadModule('virtual:dispatch-query-auth')).fixture
  fixture.session = admin
  source = await vite.ssrLoadModule('/src/services/herbDataSource.ts')
  authStorage = await vite.ssrLoadModule('/src/utils/auth.ts')
  authStorage.setAccessToken('test-token')
}

beforeEach(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true,
    value: Object.assign(new EventTarget(), { location: { origin: 'http://localhost:5173' } }) })
  for (const name of ['localStorage', 'sessionStorage']) {
    const values = new Map()
    Object.defineProperty(globalThis, name, { configurable: true, value: {
      getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    } })
  }
  await setup()
})
afterEach(async () => {
  queryClient?.clear(); queryClient = undefined
  await vite?.close(); globalThis.fetch = originalFetch
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

test('采购候选数据源使用认证 GET、透传 signal，只返回最小字段并校验响应', async () => {
  let calls = 0
  globalThis.fetch = async (url, options) => {
    calls++; assert.equal(url, '/api/batches/dispatch-recipients')
    assert.equal(options.method, 'GET'); assert.equal(options.body, undefined)
    assert.equal(options.headers.Authorization, 'Bearer test-token'); assert.ok(options.signal)
    return json({ items: [{ id: 'buyer-org', name: '采购组织', email: 'private-data' }] })
  }
  assert.deepEqual(await source.listDispatchRecipients(), [{ id: 'buyer-org', name: '采购组织' }])
  assert.equal(calls, 1)
  globalThis.fetch = async () => json({ items: [] })
  assert.deepEqual(await source.listDispatchRecipients(), [])
  for (const value of [null, {}, { items: [{ id: '', name: '组织' }] },
    { items: [{ id: 'same', name: '甲' }, { id: 'same', name: '乙' }] }]) {
    globalThis.fetch = async () => json(value)
    await assert.rejects(source.listDispatchRecipients(), { code: 'INVALID_RESPONSE' })
  }
})

test('采购候选 API 不把权限/限流/网络异常转为空或 demo，身份变化拒绝迟到响应', async () => {
  let calls = 0
  for (const status of [403, 429, 503]) {
    globalThis.fetch = async (url) => {
      calls++; assert.equal(url, '/api/batches/dispatch-recipients')
      return json({ error: { code: `HTTP_${status}`, message: '测试错误' } }, status, { 'Retry-After': '60' })
    }
    await assert.rejects(source.listDispatchRecipients(), { status, code: `HTTP_${status}`, retryAfter: '60' })
  }
  globalThis.fetch = async () => { calls++; throw new TypeError('offline') }
  await assert.rejects(source.listDispatchRecipients(), { code: 'NETWORK_ERROR' })
  globalThis.fetch = async () => {
    calls++; authStorage.setAccessToken('another-account-token')
    return json({ items: [{ id: 'old-recipient', name: '旧账号候选' }] })
  }
  await assert.rejects(source.listDispatchRecipients(), { name: 'AbortError' })
  assert.equal(calls, 5)
})

test('采购候选取消：已取消不请求，等待期间 abort 到达实际 fetch', async () => {
  let calls = 0, signal, entered
  const cancelled = new AbortController(); cancelled.abort()
  globalThis.fetch = async () => { calls++; return json({ items: [] }) }
  await assert.rejects(source.listDispatchRecipients(cancelled.signal), { name: 'AbortError' })
  assert.equal(calls, 0)
  const started = new Promise((resolve) => { entered = resolve })
  globalThis.fetch = (_url, options) => {
    calls++; signal = options.signal; entered()
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  const controller = new AbortController()
  const pending = source.listDispatchRecipients(controller.signal)
  await started; controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.ok(signal.aborted); assert.equal(calls, 1)
})

test('批次 API 列表与 ID/溯源码详情都映射收货组织，收货能力仅严格 true 放行', async () => {
  globalThis.fetch = async (url) => {
    if (url.startsWith('/api/batches?')) return json({ items: [apiBatch], pagination: { totalPages: 1 } })
    assert.ok(['/api/batches/batch-a', '/api/batches/YM-TRACE-2026-0001'].includes(url))
    return json({ batch: apiBatch })
  }
  for (const value of [(await source.listHerbBatches())[0], await source.getHerbBatchById(batch.id),
    await source.getHerbBatchByTraceCode(batch.traceCode.toLowerCase())]) {
    assert.equal(value.buyerId, 'buyer-org'); assert.equal(value.buyerName, '采购组织')
    assert.equal(value.canConfirmReceipt, true)
  }
  for (const capability of [false, undefined, 'true', 1]) {
    globalThis.fetch = async () => json({ batch: { ...apiBatch, buyerOrganization: null, canConfirmReceipt: capability } })
    const value = await source.getHerbBatchById(batch.id)
    assert.equal(value.buyerId, undefined); assert.equal(value.buyerName, undefined)
    assert.equal(value.canConfirmReceipt, false)
  }
})

test('通用详情数据源保留 ID 大小写，仅溯源码大写化；空输入不请求', async () => {
  const mixedId = 'cmv28Lower_MiXeD'
  const paths = []
  globalThis.fetch = async (url, options) => {
    paths.push(url); assert.equal(options.method, 'GET')
    assert.equal(options.headers.Authorization, 'Bearer test-token')
    return json({ batch: { ...apiBatch, id: mixedId } })
  }
  assert.equal((await source.getHerbBatchByIdentifier(`  ${mixedId}  `)).id, mixedId)
  await source.getHerbBatchByIdentifier('  ym-trace-2026-0001  ')
  assert.deepEqual(paths, [`/api/batches/${mixedId}`, '/api/batches/YM-TRACE-2026-0001'])
  for (const input of ['', '  ', '\n\t']) assert.equal(await source.getHerbBatchByIdentifier(input), null)
  assert.equal(paths.length, 2)
})

test('通用详情仅将 404 转为 null，权限/网络错误不回退 demo，旧身份响应仍丢弃', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; return json({ error: { code: 'BATCH_NOT_FOUND' } }, 404) }
  assert.equal(await source.getHerbBatchByIdentifier('cmv28Lower'), null)
  for (const status of [403, 429, 503]) {
    globalThis.fetch = async () => { calls++; return json({ error: { code: `HTTP_${status}` } }, status) }
    await assert.rejects(source.getHerbBatchByIdentifier('cmv28Lower'), { status, code: `HTTP_${status}` })
  }
  globalThis.fetch = async () => { calls++; throw new TypeError('offline') }
  await assert.rejects(source.getHerbBatchByIdentifier('cmv28Lower'), { code: 'NETWORK_ERROR' })
  globalThis.fetch = async () => {
    calls++; authStorage.setAccessToken('new-account-token'); return json({ batch: apiBatch })
  }
  await assert.rejects(source.getHerbBatchByIdentifier('cmv28Lower'), { name: 'AbortError' })
  assert.equal(calls, 6)
})

test('demo 通用详情按原 ID 或规范化溯源码读取，继续裁剪非所属采购组织信息', async () => {
  await vite.close(); await setup('demo')
  const mixedId = 'cmv28Lower_MiXeD'
  let calls = 0
  globalThis.fetch = async (url) => {
    calls++; assert.equal(url, '/data/herb-batches.json')
    return json({ batches: [{ ...batch, id: mixedId }] })
  }
  fixture.session = buyer('other-org')
  for (const input of [` ${mixedId} `, ` ${batch.traceCode.toLowerCase()} `]) {
    const value = await source.getHerbBatchByIdentifier(input)
    assert.equal(value.id, mixedId); assert.equal(value.buyerId, undefined)
    assert.equal(value.buyerName, undefined); assert.equal(value.canConfirmReceipt, false)
  }
  assert.equal(await source.getHerbBatchByIdentifier(mixedId.toUpperCase()), null)
  assert.equal(await source.getHerbBatchByIdentifier('missing'), null)
  assert.equal(calls, 1)
})

async function identifierHarness() {
  const { QueryClient, QueryClientProvider } = await vite.ssrLoadModule('@tanstack/react-query')
  const { useHerbBatchByIdentifier, herbQueryKeys } = await vite.ssrLoadModule('/src/hooks/useHerbBatches.ts')
  queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } })
  let hook
  function Harness({ input }) { hook = useHerbBatchByIdentifier(input); return null }
  const render = (input) => {
    renderToString(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness, { input })))
    return hook
  }
  return { render, keys: herbQueryKeys, QueryClientProvider }
}

test('通用详情 Hook 使用去空格但保留大小写的 key 和真实数据源，缺少标识不启用', async () => {
  const { render, keys } = await identifierHarness()
  const mixedId = 'cmv28Lower_MiXeD'
  let calls = 0
  globalThis.fetch = async (url) => {
    calls++; assert.equal(url, `/api/batches/${mixedId}`)
    return json({ batch: { ...apiBatch, id: mixedId } })
  }
  render(` ${mixedId} `)
  const query = queryClient.getQueryCache().find({ queryKey: keys.detail(mixedId), exact: true })
  assert.equal(query.options.enabled, true)
  assert.equal((await queryClient.fetchQuery(query.options)).id, mixedId)
  assert.equal(render(mixedId).data.id, mixedId)
  for (const input of [undefined, null, '', '  ']) {
    render(input)
    const disabled = queryClient.getQueryCache().find({ queryKey: [...keys.all, 'noop-detail'], exact: true })
    assert.equal(disabled.options.enabled, false)
    assert.equal(await disabled.options.queryFn({}), null)
  }
  assert.equal(calls, 1)
})

test('真实通知页面输出 ID 链接，详情页面通过通用 Hook 读取同一批次', async () => {
  // 执行真实页面/路由/Query/数据源；身份、网络、视觉组件为 fixture。
  // SSR 不验证浏览器点击、Effect 或 AntD 布局/动画，实际页面复验另做。
  const { keys, QueryClientProvider } = await identifierHarness()
  const mixedId = 'cmv28Lower_MiXeD'
  const notification = { id: 'notice-28', batchId: mixedId, type: 'auditResult', title: '黄芪审核通过',
    content: '第28刀测试通知', createdAt: '2026-10-12T08:00:00.000Z', readAt: null }
  queryClient.setQueryData(['notifications', 'api', admin.userId, { page: 1, pageSize: 10, status: 'all' }],
    { items: [notification], total: 1, unreadCount: 1, page: 1, pageSize: 10 })
  const Messages = (await vite.ssrLoadModule('/src/pages/messages/index.tsx')).default
  const messageHtml = renderToString(createElement(QueryClientProvider, { client: queryClient },
    createElement(MemoryRouter, { initialEntries: ['/messages'] }, createElement(Messages))))
  const target = `/trace/${encodeURIComponent(mixedId)}`
  assert.ok(messageHtml.includes(`href="${target}"`), '通知使用原 ID 构造链接')
  let calls = 0
  globalThis.fetch = async (url) => {
    calls++; assert.equal(url, `/api/batches/${mixedId}`)
    return json({ batch: { ...apiBatch, id: mixedId } })
  }
  const Detail = (await vite.ssrLoadModule('/src/pages/trace/Detail.tsx')).default
  const renderDetail = () => renderToString(createElement(QueryClientProvider, { client: queryClient },
    createElement(MemoryRouter, { initialEntries: [target] }, createElement(Routes, null,
      createElement(Route, { path: '/trace/:traceCode', element: createElement(Detail) })))))
  renderDetail()
  const query = queryClient.getQueryCache().find({ queryKey: keys.detail(mixedId), exact: true })
  assert.equal(query.options.enabled, true)
  await queryClient.fetchQuery(query.options)
  const detailHtml = renderDetail()
  assert.ok(detailHtml.includes(mixedId)); assert.ok(detailHtml.includes('黄芪'))
  assert.ok(!detailHtml.includes('未找到该溯源批次')); assert.equal(calls, 1)
  const { descriptionItems } = await vite.ssrLoadModule('virtual:trace-identifier-ui')
  assert.equal(descriptionItems.find(item => item.label === '最近更新').span, 'filled',
    '最近更新填满当前行剩余列，不写死跨列数；实际响应式布局另作浏览器验证')
})

async function hookHarness() {
  const { QueryClient, QueryClientProvider } = await vite.ssrLoadModule('@tanstack/react-query')
  const { useDispatchRecipients } = await vite.ssrLoadModule('/src/hooks/useDispatchRecipients.ts')
  queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } })
  let hook
  function Harness({ enabled }) { hook = useDispatchRecipients(enabled); return null }
  return (enabled = true) => {
    renderToString(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness, { enabled })))
    return hook
  }
}

test('候选 Hook 按模式/账号隔离，弹窗和管理员身份共同启用，缓存/重试策略正确', async () => {
  // SSR 读取真实 Hook 配置；不声称验证了浏览器重渲染、聚焦或卸载 Effect。
  const render = await hookHarness()
  const key = ['dispatch-recipients', 'api', admin.userId]
  queryClient.setQueryData(key, [{ id: 'a', name: '账号 A 候选' }])
  assert.equal(render().data[0].id, 'a')
  const query = queryClient.getQueryCache().find({ queryKey: key, exact: true })
  assert.equal(query.options.enabled, true); assert.equal(query.options.retry, false)
  assert.equal(query.options.staleTime, 0); assert.equal(query.options.gcTime, 60_000)
  assert.equal(query.options.refetchOnWindowFocus, true)
  render(false); assert.equal(query.options.enabled, false)
  fixture.session = { ...admin, userId: 'admin-b' }
  assert.equal(render().data, undefined)
  assert.equal(queryClient.getQueryCache().find({ queryKey: ['dispatch-recipients', 'api', 'admin-b'], exact: true }).options.enabled, true)
  for (const [status, session] of [['authenticated', buyer('buyer-org')], ['loading', admin], ['anonymous', null]]) {
    fixture.status = status; fixture.session = session; render()
    const current = queryClient.getQueryCache().find({ queryKey: ['dispatch-recipients', 'api', session?.userId ?? 'anonymous'], exact: true })
    assert.equal(current.options.enabled, false)
  }
})

test('候选 Hook queryFn 消费取消信号，Query 取消请求，失败不自动重试', async () => {
  const render = await hookHarness(); render()
  const key = ['dispatch-recipients', 'api', admin.userId]
  const query = queryClient.getQueryCache().find({ queryKey: key, exact: true })
  let calls = 0, signal, entered
  const started = new Promise((resolve) => { entered = resolve })
  globalThis.fetch = (_url, options) => {
    calls++; signal = options.signal; entered()
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  const pending = queryClient.fetchQuery(query.options)
  await started; await queryClient.cancelQueries({ queryKey: key, exact: true })
  await assert.rejects(pending); assert.ok(signal.aborted)
  globalThis.fetch = async () => { calls++; return json({ error: { code: 'UNAVAILABLE', message: '暂时不可用' } }, 503) }
  await assert.rejects(queryClient.fetchQuery(query.options), { status: 503 })
  assert.equal(calls, 2)
})

test('demo 查询不接真实 API；列表/ID/溯源码按当前归属推导，旧 true 不授予收货权限', async () => {
  await vite.close(); await setup('demo')
  let calls = 0
  globalThis.fetch = async (url) => {
    calls++; assert.equal(url, '/data/herb-batches.json')
    return json({ batches: [batch, { ...batch, id: 'legacy', traceCode: 'YM-TRACE-2026-LEGACY', buyerId: undefined, buyerName: undefined }] })
  }
  const recipients = await source.listDispatchRecipients()
  assert.ok(recipients.length > 0); assert.equal(calls, 0)
  fixture.session = buyer('buyer-org')
  for (const value of [(await source.listHerbBatches())[0], await source.getHerbBatchById(batch.id),
    await source.getHerbBatchByTraceCode(batch.traceCode)]) {
    assert.equal(value.canConfirmReceipt, true); assert.equal(value.buyerId, 'buyer-org')
  }
  assert.equal((await source.getHerbBatchById('legacy')).canConfirmReceipt, false)
  fixture.session = buyer('other-org')
  for (const value of [(await source.listHerbBatches())[0], await source.getHerbBatchById(batch.id),
    await source.getHerbBatchByTraceCode(batch.traceCode)]) {
    assert.equal(value.canConfirmReceipt, false); assert.equal(value.buyerId, undefined); assert.equal(value.buyerName, undefined)
  }
  assert.equal(await source.getHerbBatchById('missing'), null)
  assert.equal(calls, 1)
  fixture.session = admin
  assert.equal((await source.getHerbBatchById(batch.id)).buyerId, 'buyer-org')
  const render = await hookHarness(); render()
  assert.ok(queryClient.getQueryCache().find({ queryKey: ['dispatch-recipients', 'demo', admin.userId], exact: true }))
})

test('出库仅提交目标组织，收货空请求体；认证与详情映射仍复用统一请求层', async () => {
  let calls = 0
  globalThis.fetch = async (url, options) => {
    calls++; assert.equal(options.method, 'POST')
    assert.equal(options.headers.Authorization, 'Bearer test-token')
    if (url.endsWith('/shipping/dispatch')) {
      assert.equal(url, '/api/batches/batch%2Fa/shipping/dispatch')
      assert.deepEqual(JSON.parse(options.body), { buyerOrganizationId: 'buyer-org' })
      return json({ batch: apiBatch })
    }
    assert.equal(url, '/api/batches/batch%2Fa/receipt/confirm')
    assert.equal(options.body, undefined)
    return json({ batch: { ...apiBatch, stage: 'sold', canConfirmReceipt: false } })
  }
  const shipped = await source.dispatchHerbBatch('batch/a', {
    buyerOrganizationId: 'buyer-org', operatorName: '不能上传', organizationId: '不能上传', stage: 'sold',
  })
  assert.equal(shipped.buyerId, 'buyer-org'); assert.equal(shipped.stage, 'shipped')
  assert.equal((await source.confirmHerbReceipt('batch/a')).stage, 'sold')
  assert.equal(calls, 2)
})

test('出库/收货写入错误不吞掉、不自动重试、不回退 demo；迟到身份结果被拒绝', async () => {
  let calls = 0
  for (const [invoke, status] of [
    [() => source.dispatchHerbBatch(batch.id, { buyerOrganizationId: 'buyer-org' }), 409],
    [() => source.confirmHerbReceipt(batch.id), 404],
  ]) {
    globalThis.fetch = async () => { calls++; return json({ error: { code: `HTTP_${status}` } }, status) }
    await assert.rejects(invoke(), { status })
  }
  globalThis.fetch = async () => { calls++; throw new TypeError('offline') }
  await assert.rejects(source.confirmHerbReceipt(batch.id), { code: 'NETWORK_ERROR' })
  globalThis.fetch = async () => {
    calls++; authStorage.setAccessToken('new-account-token'); return json({ batch: apiBatch })
  }
  await assert.rejects(source.dispatchHerbBatch(batch.id, { buyerOrganizationId: 'buyer-org' }), { name: 'AbortError' })
  assert.equal(calls, 4)
})

test('demo 主数据源出库/收货完成归属流转；非所属/未分配/重复均不新增事件', async () => {
  await vite.close(); await setup('demo')
  globalThis.fetch = async (url) => {
    assert.equal(url, '/data/herb-batches.json')
    return json({ batches: [{ ...batch, stage: 'warehousing', buyerId: undefined, buyerName: undefined },
      { ...batch, id: 'legacy', buyerId: undefined, buyerName: undefined }] })
  }
  const recipient = (await source.listDispatchRecipients())[0]
  const shipped = await source.dispatchHerbBatch(batch.id, { buyerOrganizationId: recipient.id })
  assert.equal(shipped.buyerId, recipient.id); assert.equal(shipped.stage, 'shipped')
  assert.equal(shipped.events.length, 1)
  fixture.session = buyer('other-org')
  await assert.rejects(source.confirmHerbReceipt(batch.id), { status: 404 })
  await assert.rejects(source.confirmHerbReceipt('legacy'), { status: 404 })
  fixture.session = buyer(recipient.id)
  const sold = await source.confirmHerbReceipt(batch.id)
  assert.equal(sold.stage, 'sold'); assert.equal(sold.canConfirmReceipt, false); assert.equal(sold.events.length, 2)
  await assert.rejects(source.confirmHerbReceipt(batch.id), { status: 409 })
  assert.equal((await source.getHerbBatchById(batch.id)).events.length, 2)
})

async function mutationHarness() {
  const { QueryClient, QueryClientProvider } = await vite.ssrLoadModule('@tanstack/react-query')
  const { useHerbBatchMutations, herbQueryKeys } = await vite.ssrLoadModule('/src/hooks/useHerbBatches.ts')
  queryClient = new QueryClient({ defaultOptions: { mutations: { gcTime: Infinity } } })
  let hook
  function Harness() { hook = useHerbBatchMutations(); return null }
  renderToString(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)))
  return { hook, keys: herbQueryKeys }
}

test('真实出库/收货 mutation 传递新参数，成功后失效列表和详情；不失效公开档案', async () => {
  const { hook, keys } = await mutationHarness()
  let calls = 0
  globalThis.fetch = async (url, options) => {
    calls++
    if (url.endsWith('/shipping/dispatch')) assert.deepEqual(JSON.parse(options.body), { buyerOrganizationId: 'buyer-org' })
    else assert.equal(options.body, undefined)
    return json({ batch: apiBatch })
  }
  const privateKeys = [keys.list(), keys.detail(batch.id)]
  for (const key of privateKeys) queryClient.setQueryData(key, batch)
  const publicKey = ['public-trace', 'api', batch.traceCode]
  queryClient.setQueryData(publicKey, { traceCode: batch.traceCode })
  await hook.dispatch.mutateAsync({ batchId: batch.id, input: { buyerOrganizationId: 'buyer-org' } })
  for (const key of privateKeys) {
    assert.equal(queryClient.getQueryCache().find({ queryKey: key, exact: true }).state.isInvalidated, true)
    queryClient.setQueryData(key, batch)
  }
  await hook.confirmReceipt.mutateAsync({ batchId: batch.id })
  for (const key of privateKeys) assert.equal(queryClient.getQueryCache().find({ queryKey: key, exact: true }).state.isInvalidated, true)
  assert.equal(queryClient.getQueryCache().find({ queryKey: publicKey, exact: true }).state.isInvalidated, false)
  assert.equal(calls, 2)
})

test('真实写入 mutation 失败不自动重复提交、不失效成功缓存，保留后端错误', async () => {
  const { hook, keys } = await mutationHarness()
  queryClient.setQueryData(keys.list(), [batch])
  let calls = 0
  globalThis.fetch = async () => { calls++; return json({ error: { code: 'CONFLICT' } }, 409) }
  await assert.rejects(hook.dispatch.mutateAsync({ batchId: batch.id, input: { buyerOrganizationId: 'buyer-org' } }), { status: 409 })
  await assert.rejects(hook.confirmReceipt.mutateAsync({ batchId: batch.id }), { status: 409 })
  assert.equal(calls, 2)
  assert.equal(queryClient.getQueryCache().find({ queryKey: keys.list(), exact: true }).state.isInvalidated, false)
})
