import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { createServer } from 'vite'

let vite, accounts, storage, fixture, Manager, Registration
const realFetch = globalThis.fetch, oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
const account = { id: 'buyer-test', username: 'buyer', email: 'buyer@example.invalid', displayName: '采购测试', role: 'buyer', status: 'active',
  organizationId: 'org-buyer', organizationName: '采购组织', organizationEnabled: true }
const directory = { users: [account], organizations: [{ id: 'org-buyer', name: '采购组织', type: 'buyer' }], truncated: false }
const input = { username: 'newbuyer', email: 'newbuyer@example.invalid', displayName: '测试用户', password: 'Example-123', organizationName: '独立组织' }
before(async () => {
  vite = await createServer({ cacheDir: 'node_modules/.vite-tests/accounts', server: { middlewareMode: true, hmr: false, watch: null },
    define: { 'import.meta.env.VITE_AUTH_MODE': '"api"', 'import.meta.env.VITE_API_BASE_URL': '"/api"' },
    optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'silent', plugins: [{
      name: 'account-ui-fixture', enforce: 'pre',
      transform(code, id) {
        if (!/\/components\/account\/[^/]+\.tsx$/.test(id.replaceAll('\\', '/'))) return
        return code.replace(/from (['"])(antd|@tanstack\/react-query|\.\.\/\.\.\/hooks\/useAccounts|\.\.\/\.\.\/utils\/auth|\.\.\/\.\.\/services\/accounts)\1/g, "from 'virtual:accounts'")
      },
      resolveId(source) { if (source === 'virtual:accounts') return '\0virtual:accounts' },
      load(id) {
        if (id !== '\0virtual:accounts') return
        return `
          import { createElement } from 'react'
          export const fixture = { buttons: [], forms: [], confirmations: [], messages: [], token: 'admin-token', hook: {}, registration: {} }
          const box = ({ children }) => createElement('div', null, children)
          export const Alert = ({ title }) => box({ children: title }), Space = box, Tag = box, Select = box
          export const Typography = { Paragraph: box }
          export const Input = Object.assign(box, { Search: box, Password: box })
          export const Modal = box
          export const Table = ({ columns, dataSource }) => box({ children: dataSource.flatMap(row => columns.map((column, index) =>
            createElement('div', { key: row.id + index }, column.render?.(undefined, row) ?? row[column.dataIndex]))) })
          export const Form = Object.assign(props => { fixture.forms.push(props); return box(props) }, {
            Item: box, useWatch: () => 'buyer', useForm: () => [{ resetFields() {}, setFieldValue() {} }],
          })
          export const Button = props => { fixture.buttons.push(props); return createElement('button', { disabled: props.disabled }, props.children) }
          export const App = { useApp: () => ({ message: { success: text => fixture.messages.push(text) }, modal: { confirm: props => {
            fixture.confirmations.push(props); return { destroy() {} }
          } } }) }
          export const useAccounts = () => fixture.hook, getAccessToken = () => fixture.token
          export const useMutation = () => fixture.registration, registerBuyer = () => {}
        `
      },
    }] })
  accounts = await vite.ssrLoadModule('/src/services/accounts.ts')
  storage = await vite.ssrLoadModule('/src/utils/auth.ts')
  fixture = (await vite.ssrLoadModule('virtual:accounts')).fixture
  Manager = (await vite.ssrLoadModule('/src/components/account/AccountManager.tsx')).default
  Registration = (await vite.ssrLoadModule('/src/components/account/BuyerRegistration.tsx')).default
})
after(async () => { await vite?.close(); globalThis.fetch = realFetch
  if (oldStorage) Object.defineProperty(globalThis, 'sessionStorage', oldStorage); else delete globalThis.sessionStorage })
beforeEach(() => {
  const values = new Map()
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key),
  } })
  storage.setAccessToken('test-token')
  fixture.buttons = []; fixture.forms = []; fixture.confirmations = []; fixture.messages = []; fixture.token = 'admin-token'
  fixture.hook = { query: { data: directory, isSuccess: true, isFetching: false, isPaused: false }, create: { isPending: false }, setStatus: { isPending: false, mutateAsync: async () => {} } }
  fixture.registration = { isPending: false, mutateAsync: async () => ({ username: 'newbuyer' }) }
})
const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
const button = label => fixture.buttons.find(item => item.children === label)
const renderManager = () => renderToString(createElement(Manager, { onClose() {} }))

test('目录与账号白名单不保留hash、元数据；管理员、重复ID和不完整组织响应拒绝', () => {
  const parsed = accounts.parseAccountDirectory({ ...directory, users: [{ ...account, passwordHash: 'secret', metadata: {} }] })
  assert.deepEqual(parsed, directory)
  for (const value of [
    { ...directory, users: [{ ...account, role: 'admin' }] }, { ...directory, users: [account, account] },
    { ...directory, users: [{ ...account, organizationName: null }] },
    { ...directory, organizations: [{ ...directory.organizations[0], type: 'platform' }] },
  ]) assert.throws(() => accounts.parseAccountDirectory(value), { code: 'INVALID_RESPONSE' })
})
test('公开注册不带Token，只挑选公开字段；确认密码/角色/已有组织不能跟随表单传入', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/auth/register'); assert.equal(options.headers.Authorization, undefined)
    assert.deepEqual(JSON.parse(options.body), input)
    return json({ account: { id: 'new', username: 'newbuyer', role: 'buyer', passwordHash: 'do-not-store' } })
  }
  assert.deepEqual(await accounts.registerBuyer({ ...input, role: 'admin', organizationId: 'existing', confirmPassword: 'Example-123' }), { id: 'new', username: 'newbuyer' })
})
test('管理请求带Bearer并只传状态，返回账号必须匹配目标；创建不传确认密码', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer test-token')
    if (options.method === 'POST') { assert.equal('confirmPassword' in JSON.parse(options.body), false); return json({ account }) }
    assert.equal(url, '/api/accounts/buyer-test/status'); assert.deepEqual(JSON.parse(options.body), { status: 'disabled' })
    return json({ account: { ...account, status: 'disabled' } })
  }
  await accounts.createAccount({ ...input, role: 'buyer', organizationId: 'org-buyer', confirmPassword: input.password })
  await accounts.setAccountStatus('buyer-test', 'disabled')
  globalThis.fetch = async () => json({ account: { ...account, id: 'other', status: 'disabled' } })
  await assert.rejects(accounts.setAccountStatus('buyer-test', 'disabled'), { code: 'INVALID_RESPONSE' })
})
test('注册回调只在成功时触发，同一周期重复提交仅执行一次', async () => {
  let finish, calls = 0, registered = ''
  fixture.registration.mutateAsync = () => { calls++; return new Promise(resolve => { finish = resolve }) }
  renderToString(createElement(Registration, { onClose() {}, onRegistered: value => { registered = value } }))
  const submit = fixture.forms[0].onFinish
  assert.equal(fixture.forms[0].name, 'buyerRegistration', '命名表单避免与登录页产生重复输入框ID')
  const pending = submit(input); await submit(input)
  assert.equal(calls, 1); assert.equal(registered, '')
  finish({ username: input.username }); await pending; assert.equal(registered, input.username)
})
test('读取失败、暂停、刷新或写入中，不能打开停用确认或创建；防止绕过disabled', () => {
  for (const state of [{ query: { isSuccess: false } }, { query: { isPaused: true } }, { query: { isFetching: true } }, { createPending: true }, { statusPending: true }]) {
    fixture.hook.query = { data: directory, isSuccess: true, ...state.query }
    fixture.hook.create.isPending = state.createPending ?? false
    fixture.hook.setStatus.isPending = state.statusPending ?? false
    fixture.buttons = []
    renderManager(); assert.equal(button('停用').disabled, true); assert.equal(button('创建业务账号').disabled, true)
    button('停用').onClick(); assert.equal(fixture.confirmations.length, 0)
  }
})
test('停用确认先说明保留历史，身份变化后的旧确认框不能替新账号提交', async () => {
  let calls = 0
  fixture.hook.setStatus.mutateAsync = async () => { calls++ }
  renderManager(); button('停用').onClick()
  assert.match(fixture.confirmations[0].content, /历史批次、消息和审核记录保留/)
  fixture.token = 'another-admin-token'
  await fixture.confirmations[0].onOk(); assert.equal(calls, 0)
})
