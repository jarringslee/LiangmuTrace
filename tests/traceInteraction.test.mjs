import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { createServer } from 'vite'

let vite, fixture, Live, Image, Drawer, QrPanel
const code = 'YM-TRACE-2026-0015'
const origin = 'https://liangmutrace.pages.dev'
const originalGlobals = new Map(['window', 'document', 'navigator'].map(key =>
  [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
const originalCreateUrl = URL.createObjectURL, originalRevokeUrl = URL.revokeObjectURL

before(async () => {
  vite = await createServer({ cacheDir: 'node_modules/.vite-tests/trace-interaction',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'silent',
    plugins: [{ name: 'trace-interaction-fixture', enforce: 'pre',
      transform(source, id) {
        const file = id.replaceAll('\\', '/')
        if (!/\/components\/herb\/(QrScanDrawer|TraceQrPanel)\.tsx$/.test(file)) return
        const transformed = source.replace(/from (['"])(react|antd|@ant-design\/icons|html5-qrcode|qrcode\.react)\1/g,
          "from 'virtual:trace-interaction'")
        // 只在测试模块导出内部组件，不改变生产模块 API。
        return transformed + (file.endsWith('/QrScanDrawer.tsx')
          ? '\nexport { LiveScanTab, ImageScanTab }\n' : '')
      },
      resolveId(source) {
        if (source === 'virtual:trace-interaction') return '\0virtual:trace-interaction'
      },
      load(id) {
        if (id !== '\0virtual:trace-interaction') return
        return `
          export const fixture = { owner: null, instances: [], calls: [], messages: [],
            starts: [], stops: [], files: [], enumerate: null, nextId: 0 }
          export const useRef = value => fixture.owner.ref(value)
          export const useState = value => fixture.owner.state(value)
          export const useEffect = (setup, deps) => fixture.owner.effect(setup, deps)
          export const useMemo = (factory, deps) => fixture.owner.memo(factory, deps)
          export const useCallback = (callback, deps) => fixture.owner.memo(() => callback, deps)
          export const useId = () => fixture.owner.memo(() => ':fixture-' + (++fixture.nextId) + ':', [])
          const ui = name => Object.assign(() => null, { uiName: name })
          export const Alert = ui('Alert'), Button = ui('Button'), Drawer = ui('Drawer'),
            Empty = ui('Empty'), Flex = ui('Flex'), Select = ui('Select'), Space = ui('Space'),
            Tabs = ui('Tabs'), Tag = ui('Tag'), QRCodeCanvas = ui('QRCodeCanvas')
          export const Typography = { Text: ui('Text'), Paragraph: ui('Paragraph') }
          export const Input = Object.assign(ui('Input'), { TextArea: ui('TextArea') })
          export const Upload = { Dragger: ui('Dragger') }
          export const CameraOutlined = ui('Icon'), CloseCircleOutlined = CameraOutlined,
            EditOutlined = CameraOutlined, PictureOutlined = CameraOutlined,
            PlayCircleOutlined = CameraOutlined, PoweroffOutlined = CameraOutlined,
            ScanOutlined = CameraOutlined, SearchOutlined = CameraOutlined,
            CopyOutlined = CameraOutlined, DownloadOutlined = CameraOutlined
          const message = Object.fromEntries(['success', 'warning', 'error'].map(level =>
            [level, text => fixture.messages.push([level, text])]))
          export const App = { useApp: () => ({ message }) }
          export class Html5Qrcode {
            static getCameras() {
              fixture.calls.push(['enumerate'])
              return fixture.enumerate ?? Promise.resolve([{ id: 'front', label: 'front' },
                { id: 'back', label: 'rear' }])
            }
            constructor(elementId) {
              this.id = fixture.instances.length; this.elementId = elementId; this.isScanning = false
              fixture.instances.push(this); fixture.calls.push(['construct', this.id])
            }
            async start(camera, config, onHit) {
              this.onHit = onHit; this.camera = camera; this.config = config
              fixture.calls.push(['start', this.id])
              await (fixture.starts.shift() ?? Promise.resolve())
              this.isScanning = true; fixture.calls.push(['ready', this.id])
            }
            async stop() {
              assertNotStarting(this)
              fixture.calls.push(['stop', this.id])
              await (fixture.stops.shift() ?? Promise.resolve())
              this.isScanning = false; fixture.calls.push(['stopped', this.id])
            }
            clear() {
              if (this.isScanning) throw new Error('不能清理正在扫描的实例')
              fixture.calls.push(['clear', this.id])
            }
            async scanFile(file, showImage) {
              fixture.calls.push(['file', this.id, file.name, showImage])
              return await (fixture.files.shift() ?? Promise.resolve('${code}'))
            }
          }
          function assertNotStarting(instance) {
            if (!instance.isScanning) throw new Error('启动完成前不能 stop')
          }
        `
      },
    }],
  })
  fixture = (await vite.ssrLoadModule('virtual:trace-interaction')).fixture
  const module = await vite.ssrLoadModule('/src/components/herb/QrScanDrawer.tsx')
  Live = module.LiveScanTab; Image = module.ImageScanTab; Drawer = module.default
  QrPanel = (await vite.ssrLoadModule('/src/components/herb/TraceQrPanel.tsx')).default
})
after(async () => { await vite?.close() })

// 执行真实组件的事件与 Effect 回调；Hook/DOM/扫码设备是可控替身。
// 不模拟 React 调度、AntD 动画、真实摄像头、图片解码或微信权限。
class HookRun {
  slots = []; cursor = 0; writes = []; mounted = true
  ref(value) { return this.slot('ref', () => ({ current: value })).value }
  slot(kind, create) {
    const index = this.cursor++
    this.slots[index] ??= { kind, value: create() }
    assert.equal(this.slots[index].kind, kind, 'Hook 顺序保持一致')
    return this.slots[index]
  }
  state(value) {
    const slot = this.slot('state', () => typeof value === 'function' ? value() : value)
    slot.set ??= next => {
      const value = typeof next === 'function' ? next(slot.value) : next
      this.writes.push({ value, mounted: this.mounted }); slot.value = value
    }
    return [slot.value, slot.set]
  }
  memo(factory, deps) {
    const slot = this.slot('memo', () => undefined)
    if (!sameDeps(slot.deps, deps)) { slot.value = factory(); slot.deps = deps }
    return slot.value
  }
  effect(setup, deps) {
    const slot = this.slot('effect', () => undefined)
    if (!sameDeps(slot.deps, deps)) { slot.next = { setup, deps } }
  }
  render(Component, props) {
    this.cursor = 0; fixture.owner = this
    try { this.tree = Component(props) } finally { fixture.owner = null }
    return this.tree
  }
  commit() {
    const changed = this.slots.filter(slot => slot.kind === 'effect' && slot.next)
    for (const slot of changed) slot.cleanup?.()
    for (const slot of changed) {
      slot.deps = slot.next.deps; slot.cleanup = slot.next.setup(); slot.next = null
    }
  }
  unmount() {
    this.mounted = false
    for (const slot of this.slots) if (slot.kind === 'effect') slot.cleanup?.()
  }
}
const sameDeps = (left, right) => left && right && left.length === right.length &&
  left.every((value, index) => Object.is(value, right[index]))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve() }
function find(tree, name) {
  if (Array.isArray(tree)) return tree.flatMap(node => find(node, name))
  if (!tree || typeof tree !== 'object') return []
  return [...(tree.type?.uiName === name ? [tree.props] : []), ...find(tree.props?.children, name)]
}
const button = (run, label) => find(run.tree, 'Button').find(props => props.children === label)
const runs = []
function mount(Component, props) {
  const run = new HookRun(); runs.push(run); run.render(Component, props); run.commit(); return run
}
let urls, revoked
beforeEach(() => {
  fixture.instances = []; fixture.calls = []; fixture.messages = []; fixture.starts = []
  fixture.stops = []; fixture.files = []; fixture.enumerate = null; urls = []; revoked = []
  Object.defineProperty(globalThis, 'window', { configurable: true,
    value: { location: { origin, protocol: 'https:', hostname: 'liangmutrace.pages.dev' } } })
  Object.defineProperty(globalThis, 'document', { configurable: true,
    value: { getElementById: () => ({ clientWidth: 320 }) } })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} })
  URL.createObjectURL = file => { const url = `blob:fixture-${urls.length}`; urls.push([url, file]); return url }
  URL.revokeObjectURL = url => revoked.push(url)
})
afterEach(async () => {
  for (const run of runs.splice(0)) if (run.mounted) run.unmount()
  await flush()
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
  URL.createObjectURL = originalCreateUrl; URL.revokeObjectURL = originalRevokeUrl
})

test('摄像头枚举迟到：关闭后不构造实例、不写界面、不跳转', async () => {
  const gate = deferred(), hits = []; fixture.enumerate = gate.promise
  const run = mount(Live, { active: true, onHit: value => hits.push(value) })
  run.unmount(); run.writes = []; gate.resolve([{ id: 'back', label: 'rear' }]); await flush()
  assert.equal(fixture.instances.length, 0); assert.deepEqual(run.writes, []); assert.deepEqual(hits, [])
})

test('启动未完成就关闭：等 start 成功后按 stop/clear 顺序释放，旧回调失效', async () => {
  const gate = deferred(), hits = []; fixture.starts.push(gate.promise)
  const run = mount(Live, { active: true, onHit: value => hits.push(value) }); await flush()
  const scanner = fixture.instances[0]; assert.ok(scanner)
  run.unmount(); run.writes = []; scanner.onHit(code)
  assert.equal(fixture.calls.some(call => call[0] === 'stop'), false)
  gate.resolve(); await flush(); scanner.onHit(code)
  assert.deepEqual(fixture.calls.filter(call => ['ready', 'stop', 'stopped', 'clear'].includes(call[0])),
    [['ready', 0], ['stop', 0], ['stopped', 0], ['clear', 0]])
  assert.equal(scanner.isScanning, false); assert.deepEqual(hits, []); assert.deepEqual(run.writes, [])
})

test('摄像头切换串行执行，旧启动与旧停止完成之前不能启动新实例', async () => {
  const startGate = deferred(), stopGate = deferred(), hits = []
  fixture.starts.push(startGate.promise); fixture.stops.push(stopGate.promise)
  const props = { active: true, onHit: value => hits.push(value) }
  const run = mount(Live, props); await flush(); run.render(Live, props); run.commit()
  const change = find(run.tree, 'Select')[0].onChange('front')
  assert.equal(fixture.instances.length, 1)
  startGate.resolve(); await flush(); assert.equal(fixture.instances.length, 1)
  fixture.instances[0].onHit(code); assert.deepEqual(hits, [])
  stopGate.resolve(); await change; await flush()
  assert.equal(fixture.instances.length, 2)
  assert.deepEqual(fixture.instances[1].camera, { deviceId: { exact: 'front' } })
  const stopped = fixture.calls.findIndex(call => call[0] === 'stopped' && call[1] === 0)
  const started = fixture.calls.findIndex(call => call[0] === 'start' && call[1] === 1)
  assert.ok(stopped < started)
})

test('连续识别只跳转一次，非法二维码不命中，回调更新不重启摄像头', async () => {
  const oldHits = [], hits = [], run = mount(Live, { active: true, onHit: value => oldHits.push(value) })
  await flush(); const scanner = fixture.instances[0]
  run.render(Live, { active: true, onHit: value => hits.push(value) }); run.commit(); await flush()
  assert.equal(fixture.instances.length, 1)
  scanner.onHit('不是溯源码'); scanner.onHit(`${origin}/public/trace/${code.toLowerCase()}`); scanner.onHit(code)
  await flush(); assert.deepEqual(oldHits, []); assert.deepEqual(hits, [code]); assert.equal(scanner.isScanning, false)
})

test('权限错误有兜底提示，失败后可手动重试；停止后回到 idle', async () => {
  const gate = deferred(); fixture.starts.push(gate.promise)
  const props = { active: true, onHit: () => {} }, run = mount(Live, props); await flush()
  gate.reject(new Error('NotAllowedError')); await flush(); run.render(Live, props); run.commit()
  assert.match(find(run.tree, 'Alert')[0].title, /图片识别 \/ 手动输入/)
  await button(run, '重试').onClick(); await flush(); run.render(Live, props); run.commit()
  assert.equal(fixture.instances.length, 2); button(run, '停止').onClick(); await flush()
  run.render(Live, props); run.commit(); assert.ok(button(run, '开始扫描'))
})

test('未启用的扫码标签不访问摄像头，父抽屉正确传递图片标签启用状态', async () => {
  mount(Live, { active: false, onHit: () => {} }); await flush(); assert.deepEqual(fixture.instances, [])
  const props = { open: true, onClose: () => {}, onResult: () => {} }, run = mount(Drawer, props)
  let tabs = find(run.tree, 'Tabs')[0]
  assert.equal(tabs.items.find(item => item.key === 'image').children.props.active, false)
  tabs.onChange('image'); run.render(Drawer, props); run.commit(); tabs = find(run.tree, 'Tabs')[0]
  assert.equal(tabs.items.find(item => item.key === 'image').children.props.active, true)
  run.render(Drawer, { ...props, open: false }); run.commit()
  assert.equal(find(run.tree, 'Tabs')[0].items.find(item => item.key === 'image').children.props.active, false)
})

test('图片预览更换/卸载释放 URL；beforeUpload 返回 false，不执行上传', async () => {
  const hits = [], props = { active: true, onHit: value => hits.push(value) }, run = mount(Image, props)
  let upload = find(run.tree, 'Dragger')[0]; assert.equal(upload.disabled, false)
  assert.equal(await upload.beforeUpload({ name: 'one.png' }), false)
  run.render(Image, props); run.commit(); assert.deepEqual(revoked, [])
  upload = find(run.tree, 'Dragger')[0]
  assert.equal(await upload.beforeUpload({ name: 'two.png' }), false)
  run.render(Image, props); run.commit(); assert.deepEqual(revoked, ['blob:fixture-0'])
  run.unmount(); assert.deepEqual(revoked, ['blob:fixture-0', 'blob:fixture-1'])
  assert.deepEqual(hits, [code, code])
  assert.equal(fixture.calls.filter(call => call[0] === 'file').every(call => call[3] === false), true)
})

test('图片异步解析同步防重；切换标签后成功结果也不能跳转', async () => {
  const gate = deferred(), hits = []; fixture.files.push(gate.promise)
  const props = { active: true, onHit: value => hits.push(value) }, run = mount(Image, props)
  const upload = find(run.tree, 'Dragger')[0], task = upload.beforeUpload({ name: 'slow.png' })
  assert.equal(await upload.beforeUpload({ name: 'duplicate.png' }), false)
  assert.equal(fixture.instances.length, 1)
  run.render(Image, { ...props, active: false }); run.commit()
  assert.equal(find(run.tree, 'Dragger')[0].disabled, true)
  gate.resolve(code); assert.equal(await task, false); assert.deepEqual(hits, [])
  assert.equal(fixture.calls.filter(call => call[0] === 'clear').length, 1)
})

test('图片解析关闭后迟到错误不写状态；未启用时不创建预览或解析器', async () => {
  const gate = deferred(); fixture.files.push(gate.promise)
  const props = { active: true, onHit: () => assert.fail('不应命中') }, run = mount(Image, props)
  const task = find(run.tree, 'Dragger')[0].beforeUpload({ name: 'error.png' })
  run.render(Image, props); run.commit(); run.unmount(); run.writes = []
  gate.reject(new Error('unable to decode')); assert.equal(await task, false)
  assert.deepEqual(run.writes, []); assert.deepEqual(revoked, ['blob:fixture-0'])
  const inactive = mount(Image, { ...props, active: false })
  assert.equal(await find(inactive.tree, 'Dragger')[0].beforeUpload({ name: 'ignored.png' }), false)
  assert.equal(urls.length, 1)
})

test('不支持剪贴板时显示可选中的只读完整链接；切换批次不显示旧失败状态', async () => {
  const props = { traceCode: code }, run = mount(QrPanel, props)
  await button(run, '复制链接').onClick(); run.render(QrPanel, props); run.commit()
  const input = find(run.tree, 'TextArea')[0]
  assert.equal(input.value, `${origin}/public/trace/${code}`); assert.equal(input.readOnly, true)
  let selected = false; input.onFocus({ currentTarget: { select: () => { selected = true } } }); assert.ok(selected)
  run.render(QrPanel, { traceCode: 'YM-TRACE-2026-0001' }); run.commit()
  assert.equal(find(run.tree, 'TextArea').length, 0)
  assert.equal(fixture.messages[0][0], 'warning')
})

test('剪贴板拒绝也可兜底，成功重试清除兜底，不携带身份或内部详情链接', async () => {
  const copied = []; navigator.clipboard = { writeText: async () => { throw new Error('NotAllowedError') } }
  const props = { traceCode: code.toLowerCase() }, run = mount(QrPanel, props)
  await button(run, '复制链接').onClick(); run.render(QrPanel, props); run.commit()
  assert.equal(find(run.tree, 'TextArea').length, 1)
  navigator.clipboard.writeText = async value => copied.push(value)
  await button(run, '复制链接').onClick(); run.render(QrPanel, props); run.commit()
  assert.deepEqual(copied, [`${origin}/public/trace/${code}`])
  assert.equal(find(run.tree, 'TextArea').length, 0); assert.equal(fixture.messages.at(-1)[0], 'success')
})

test('二维码共享公开地址，窄屏约束/按钮换行存在，compact 只显示二维码', () => {
  const run = mount(QrPanel, { traceCode: code, size: 400 })
  assert.equal(run.tree.props.style.maxWidth, '100%'); assert.equal(run.tree.props.style.minWidth, 0)
  assert.ok(find(run.tree, 'Space').some(props => props.wrap))
  const canvas = find(run.tree, 'QRCodeCanvas')[0]
  assert.equal(canvas.value, `${origin}/public/trace/${code}`)
  assert.deepEqual(canvas.style, { maxWidth: '100%', height: 'auto' })
  run.render(QrPanel, { traceCode: code, compact: true }); run.commit()
  assert.equal(find(run.tree, 'Button').length, 0); assert.equal(find(run.tree, 'TextArea').length, 0)
  assert.equal(find(run.tree, 'QRCodeCanvas').length, 1)
})
