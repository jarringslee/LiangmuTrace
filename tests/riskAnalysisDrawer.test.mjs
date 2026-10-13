import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { createServer } from 'vite'

let vite, Drawer, fixture
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
            Spin = box, Tag = box, Timeline = box
          export const RobotOutlined = () => null, RiskTag = () => null
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
