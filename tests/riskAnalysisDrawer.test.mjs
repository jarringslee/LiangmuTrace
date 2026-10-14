import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, beforeEach, test } from 'node:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { createServer } from 'vite'

let vite, Drawer, fixture, workbench
const batch = { id: 'batch-test', batchNo: 'YM-TEST', herbName: '甘草', auditStatus: 'pending' }
const reviewInput = { decision: 'approved', riskLevel: 'low', reason: '人工核对完成' }
const analysis = () => ({
  id: 'saved-analysis', stale: false, riskLevel: 'low', recommendation: 'manualReview',
  summary: '请人工核对资料。', modelName: 'test-model', mode: 'api',
  missingInformation: [], toolCalls: [], evidence: [],
})

before(async () => {
  vite = await createServer({
    cacheDir: 'node_modules/.vite-tests/risk-analysis-drawer',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'silent',
    plugins: [{
      name: 'risk-drawer-fixture', enforce: 'pre',
      // 只替换待测组件的 UI 和 Hook 依赖；执行的仍是实际组件逻辑。
      transform(code, id) {
        if (!id.replaceAll('\\', '/').endsWith('/components/herb/RiskAnalysisDrawer.tsx')) return
        return code.replace(/from (['"])(antd|@ant-design\/icons|\.\.\/\.\.\/hooks\/useBatchRiskAnalysis|\.\/herbTags)\1/g,
          "from 'virtual:risk-drawer'")
      },
      resolveId(source) {
        if (source === 'virtual:risk-drawer') return '\0virtual:risk-drawer'
      },
      load(id) {
        if (id !== '\0virtual:risk-drawer') return
        return `
          import { createElement } from 'react'
          export const fixture = { hook: {}, buttons: [], drawers: [], forms: [], calls: [], values: [] }
          export const useBatchRiskAnalysis = () => fixture.hook
          const box = ({ children }) => createElement('div', null, children)
          export const Alert = ({ title, description, children }) => createElement('div', null, title, description, children)
          export const Divider = box, Empty = box, Select = box, Space = box,
            Spin = box, Tag = box
          export const Timeline = ({ items }) => createElement('div', null,
            items.map((item) => createElement('div', { key: item.key }, item.content)))
          export const RobotOutlined = () => null, RiskTag = () => null, AuditTag = () => null, StageTag = () => null
          export const Typography = { Text: box, Title: box, Paragraph: box }
          export const Input = { TextArea: box }
          export const App = { useApp: () => ({
            message: { success: (text) => fixture.calls.push(['success', text]) },
          }) }
          export const Drawer = (props) => {
            fixture.drawers.push(props)
            return box(props)
          }
          export const Button = (props) => {
            fixture.buttons.push(props)
            return createElement('button', { disabled: props.disabled }, props.children)
          }
          export const Form = Object.assign((props) => {
            fixture.forms.push(props)
            return box(props)
          }, {
            Item: box,
            useForm: () => [{
              resetFields: () => fixture.calls.push(['reset']),
              setFieldsValue: (value) => fixture.values.push(value),
            }],
          })
        `
      },
    }],
  })
  fixture = (await vite.ssrLoadModule('virtual:risk-drawer')).fixture
  Drawer = (await vite.ssrLoadModule('/src/components/herb/RiskAnalysisDrawer.tsx')).default
  workbench = await vite.ssrLoadModule('/src/utils/riskWorkbench.ts')
})
after(async () => { await vite?.close() })
beforeEach(() => {
  fixture.buttons = []; fixture.drawers = []; fixture.forms = []; fixture.calls = []; fixture.values = []
  fixture.hook = {
    query: { data: analysis(), isSuccess: true, isFetching: false, isPaused: false, isPending: false, error: null },
    analyze: { isPending: false },
    review: { isPending: false, error: null, mutateAsync: async (input) => fixture.calls.push(['review', input]) },
    progress: [], stopped: false, analysisError: null,
    startAnalyze: async () => undefined,
    stopAnalyze: () => fixture.calls.push(['stop']),
  }
})
function renderDrawer(currentBatch = batch) {
  fixture.buttons = []; fixture.drawers = []; fixture.forms = []
  // SSR 不执行卸载 Effect；替身只验证关闭/提交事件与组件属性，不验证 AntD 动画或真机交互。
  return renderToString(createElement(Drawer, { batch: currentBatch, onClose: () => fixture.calls.push(['close']) }))
}
const button = (label) => fixture.buttons.find((props) => props.children === label)

test('分析中可以通过关闭按钮、Esc 或遮罩退出，先停止分析再通知父组件关闭', () => {
  fixture.hook.analyze.isPending = true
  renderDrawer()
  const drawer = fixture.drawers[0]
  assert.equal(drawer.closable, true)
  assert.equal(drawer.keyboard, true)
  assert.equal(drawer.mask.closable, true)
  drawer.onClose()
  assert.deepEqual(fixture.calls, [['stop'], ['close']])
})

test('人工审核提交期间关闭入口被禁用，直接调用关闭回调也不能取消或关闭', () => {
  fixture.hook.review.isPending = true
  renderDrawer()
  const drawer = fixture.drawers[0]
  assert.equal(drawer.closable, false)
  assert.equal(drawer.keyboard, false)
  assert.equal(drawer.mask.closable, false)
  drawer.onClose()
  assert.deepEqual(fixture.calls, [])
  assert.equal(fixture.forms[0].disabled, true)
})

test('空闲时可正常关闭，关闭动作不触发人工审核写入', () => {
  renderDrawer()
  fixture.drawers[0].onClose()
  assert.deepEqual(fixture.calls, [['stop'], ['close']])
})

test('后台读取、暂停、失败或旧建议时禁用表单，绕过按钮调用回调也不会提交', async () => {
  renderDrawer()
  assert.equal(fixture.forms[0].disabled, false)
  button('将建议填入表单').onClick()
  assert.deepEqual(fixture.values[0], { decision: undefined, riskLevel: 'low', reason: '请人工核对资料。' })

  const cases = [
    { query: { isFetching: true } },
    { query: { isPaused: true } },
    { query: { isSuccess: false, error: new Error('读取失败，仍有旧缓存') } },
    { query: { data: { ...analysis(), stale: true } } },
    { analyze: { isPending: true } },
    { review: { isPending: true } },
    { auditStatus: 'approved' },
  ]
  for (const state of cases) {
    fixture.hook.query = { data: analysis(), isSuccess: true, isFetching: false, isPaused: false, error: null, ...state.query }
    fixture.hook.analyze.isPending = state.analyze?.isPending ?? false
    fixture.hook.review.isPending = state.review?.isPending ?? false
    fixture.calls = []; fixture.values = []
    renderDrawer({ ...batch, auditStatus: state.auditStatus ?? 'pending' })
    assert.equal(fixture.forms[0].disabled, true)
    assert.equal(button('将建议填入表单').disabled, true)
    assert.equal(button('确认并保存人工结论').disabled, true)
    button('将建议填入表单').onClick()
    await fixture.forms[0].onFinish(reviewInput)
    assert.deepEqual(fixture.values, [])
    assert.deepEqual(fixture.calls, [])
  }
})

test('人工审核成功后直接通知父组件关闭，不误走提交期间受限的关闭回调', async () => {
  fixture.hook.review.mutateAsync = async (input) => {
    fixture.calls.push(['review', input])
    // 模拟 mutation 状态还没完成重渲染；成功分支不能被 handleClose 的锁拦住。
    fixture.hook.review.isPending = true
  }
  renderDrawer()
  await fixture.forms[0].onFinish(reviewInput)
  assert.deepEqual(fixture.calls, [
    ['review', { analysisId: 'saved-analysis', input: reviewInput }],
    ['success', '人工审核结论已保存'], ['close'],
  ])
})

test('人工审核失败保留窗口与表单，不关闭、不显示成功提示', async () => {
  fixture.hook.review.mutateAsync = async () => { throw new Error('阶段已变化') }
  renderDrawer()
  await fixture.forms[0].onFinish(reviewInput)
  assert.deepEqual(fixture.calls, [])
})

test('v2 区分模型判断与服务端资料并按文本转义，v1 不伪造原文快照', () => {
  fixture.hook.query.data = { ...analysis(), promptVersion: 'audit-risk-v2', missingInformation: ['缺少种植环境说明'],
    evidence: [{ sourceId: 'batch:origin', note: '需要核对产地', sourceText: '<script>合成恶意资料</script>' }] }
  const html = renderDrawer()
  assert.match(html, /当前阶段规则发现的缺失资料/)
  assert.match(html, /模型判断：/)
  assert.match(html, /服务端提供的资料：/)
  assert.match(html, /&lt;script&gt;/)
  assert.doesNotMatch(html, /<script>/)
  fixture.hook.query.data = { ...analysis(), promptVersion: 'audit-risk-v1',
    evidence: [{ sourceId: 'batch:origin', note: '旧模型判断' }] }
  assert.match(renderDrawer(), /旧建议未保存原文快照/)
})

test('已审核与已驳回明确解释只读原因，不允许事件回调绕过禁用分析', async () => {
  fixture.hook.startAnalyze = async () => fixture.calls.push(['analyze'])
  for (const auditStatus of ['approved', 'rejected']) {
    const html = renderDrawer({ ...batch, auditStatus })
    assert.match(html, /Agent 只分析待审核批次/)
    assert.equal(button('重新分析').disabled, true)
    await button('重新分析').onClick()
    assert.deepEqual(fixture.calls, [])
  }
})

test('首次读取、后台读取、离线暂停和读取失败都阻止重复付费分析', async () => {
  fixture.hook.startAnalyze = async () => fixture.calls.push(['analyze'])
  for (const state of [
    { isPending: true }, { isFetching: true }, { isPaused: true }, { isSuccess: false, error: new Error('读取失败') },
  ]) {
    fixture.hook.query = { data: analysis(), isSuccess: true, isFetching: false, isPending: false, isPaused: false, ...state }
    const html = renderDrawer()
    assert.equal(button('重新分析').disabled, true)
    assert.match(html, /正在读取|读取已暂停|尚未成功读取/)
    await button('重新分析').onClick()
    assert.deepEqual(fixture.calls, [])
  }
})

test('待审无报告可分析但不能人工提交；待审过期报告可以重分析但不能继续提交', () => {
  const state = { auditStatus: 'pending', analysis: null, analyzing: false, reviewing: false,
    reading: false, readSuccess: true, readPaused: false }
  assert.equal(workbench.getRiskWorkbenchState(state).canAnalyze, true)
  assert.equal(workbench.getRiskWorkbenchState(state).canReview, false)
  assert.match(workbench.getRiskWorkbenchState(state).reviewReason, /先运行分析/)
  const stale = workbench.getRiskWorkbenchState({ ...state, analysis: { ...analysis(), stale: true } })
  assert.equal(stale.canAnalyze, true)
  assert.equal(stale.canReview, false)
  assert.match(stale.reviewReason, /版本已变化/)
})

test('依据名称与工具显示使用友好文字，未改写服务端来源与阶段事件', () => {
  assert.equal(workbench.riskEvidenceLabel('batch:origin'), '登记产地')
  assert.equal(workbench.riskEvidenceLabel('event:abc'), '溯源记录')
  assert.equal(workbench.riskEvidenceLabel('legacy:abc'), '资料来源')
  assert.equal(workbench.riskProgressLabel({ toolName: 'get_batch_snapshot', status: 'completed' }), '已完成：读取所选批次快照')
  assert.equal(workbench.riskProgressLabel({ message: '建议已保存', status: 'completed' }), '建议已保存')
  fixture.hook.query.data = { ...analysis(), promptVersion: 'audit-risk-v2', evidence: [
    { sourceId: 'batch:origin', note: '产地文字需核对', sourceText: '甘肃省定西市' },
  ] }
  const html = renderDrawer()
  assert.match(html, /判断与资料对照/)
  assert.match(html, /登记产地/)
  assert.match(html, /技术来源标识/)
  assert.match(html, /填入建议只预填表单/)
  assert.match(html, /当前阶段必需项均已登记/)
})

test('真实阶段与工具使用单栏内容，报告保存后过程收起；代码样式不继承暗色文字', async () => {
  fixture.hook.progress = [{ seq: 1, stage: 'tool', status: 'completed', toolName: 'get_batch_snapshot', message: '已完成工具' }]
  fixture.hook.query.data = { ...analysis(), toolCalls: [
    { name: 'inspect_trace_records', summary: '检查当前登记资料', completedAt: '2026-10-14T00:00:00Z' },
  ] }
  const html = renderDrawer()
  assert.match(html, /已完成：读取所选批次快照/)
  assert.match(html, /检查当前阶段资料并整理依据/)
  assert.match(html, /<details class="risk-workbench__process">/)
  fixture.hook.analyze.isPending = true
  assert.match(renderDrawer(), /<details class="risk-workbench__process" open="">/)
  const less = (await import('less')).default
  const css = (await less.render(readFileSync('src/components/herb/riskAnalysis.less', 'utf8'))).css
  assert.match(css, /\.risk-workbench \.ant-typography code/)
  assert.match(css, /color: #244b36/)
  assert.match(css, /overflow-wrap: anywhere/)
})
