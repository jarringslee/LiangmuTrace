import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { createServer } from 'vite'
import less from 'less'

let vite, getAttachmentHref, Timeline, Drawer, fixture
before(async () => {
  vite = await createServer({
    cacheDir: 'node_modules/.vite-tests/trace-presentation',
    server: { middlewareMode: true, hmr: false, watch: null },
    ssr: { noExternal: ['@ant-design/icons', '@ant-design/icons-svg', '@rc-component/util'] },
    optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'silent',
    plugins: [{ name: 'trace-presentation-assistant', enforce: 'pre',
      transform(source, id) {
        if (!id.replaceAll('\\', '/').endsWith('/assistant/AssistantDrawer.tsx')) return
        const imported = "import { Alert, Button, Drawer, Input, Space, Tag, Typography } from 'antd'"
        assert.ok(source.includes(imported), '组件导入变化后同步测试适配')
        return source.replace(imported,
          "import { Alert, Button, Input, Space, Tag, Typography } from 'antd'\n" +
          "import { Drawer } from 'virtual:trace-presentation-assistant'")
      },
      resolveId(source, importer) {
        if (source === 'virtual:trace-presentation-assistant' ||
          (source === '../../hooks/useAssistant' &&
            importer?.replaceAll('\\', '/').endsWith('/assistant/AssistantDrawer.tsx'))) {
          return '\0virtual:trace-presentation-assistant'
        }
      },
      load(id) {
        if (id === '\0virtual:trace-presentation-assistant') return `
          import { createElement } from 'react'
          export const fixture = { batch: null, historyMode: 'api' }
          export const Drawer = ({ children, open, rootClassName }) =>
            open ? createElement('section', { className: rootClassName }, children) : null
          const noop = () => {}
          export const useAssistant = () => ({ ...fixture, open: true, turns: [], draft: '',
            isPending: false, historyLoading: false, historyError: null, conversationBusy: false,
            setDraft: noop, reloadHistory: noop, openAssistant: noop, closeAssistant: noop,
            removeBatch: noop, send: noop, stop: noop })
        `
      },
    }],
  })
  getAttachmentHref = (await vite.ssrLoadModule('/src/utils/attachmentUrl.ts')).getAttachmentHref
  Timeline = (await vite.ssrLoadModule('/src/components/herb/TraceTimeline.tsx')).default
  Drawer = (await vite.ssrLoadModule('/src/components/assistant/AssistantDrawer.tsx')).default
  fixture = (await vite.ssrLoadModule('virtual:trace-presentation-assistant')).fixture
})
after(async () => { await vite?.close() })
beforeEach(() => { fixture.batch = null; fixture.historyMode = 'api' })

test('附件占位、空白、控制字符与反斜线不生成链接', () => {
  for (const input of ['', ' ', '#', ' #report ', '/file\n.pdf', '/file\t.pdf', '/file\u0000.pdf', '/file\\report.pdf']) {
    assert.equal(getAttachmentHref(input), null, JSON.stringify(input))
  }
})

test('HTTP(S) 地址规范化，但拒绝凭证、协议相对地址和危险协议', () => {
  assert.equal(getAttachmentHref(' https://example.test/report.pdf '), 'https://example.test/report.pdf')
  assert.equal(getAttachmentHref('http://example.test'), 'http://example.test/')
  for (const input of ['https://user:pass@example.test/a', '//example.test/a', 'javascript:alert(1)',
    'file:///C:/report.pdf', 'ftp://example.test/a', 'not-a-url']) {
    assert.equal(getAttachmentHref(input), null, input)
  }
})

test('保留站内路径和现有 HTTP(S) Blob；不接受其他 Blob 来源', () => {
  assert.equal(getAttachmentHref('/reports/a.pdf?download=1'), '/reports/a.pdf?download=1')
  assert.equal(getAttachmentHref('blob:https://example.test/id'), 'blob:https://example.test/id')
  assert.equal(getAttachmentHref('blob:null/id'), null)
  assert.equal(getAttachmentHref('blob:file:///id'), null)
})

test('Data URL 只保留允许的 base64 图片/PDF，不执行 HTML 或 SVG', () => {
  for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'application/pdf']) {
    const value = `data:${mime};base64,YQ==`
    assert.equal(getAttachmentHref(value), value)
  }
  for (const value of ['data:text/html;base64,YQ==', 'data:image/svg+xml;base64,YQ==',
    'data:application/pdf,hello', 'data:image/png;base64,%%%']) {
    assert.equal(getAttachmentHref(value), null)
  }
})

const event = (attachments, scopes = ['public']) => ({ id: 'event', type: 'qcReport',
  title: '质检摘要', occurredAt: '2026-10-13 10:00', scopes, attachments })
// React SSR 在相邻文本之间插入 hydration 注释；它不是页面可见文字。
const withoutTextBoundaries = (html) => html.replaceAll('<!-- -->', '')
const renderTimeline = (events, role = 'buyer') =>
  withoutTextBoundaries(renderToString(createElement(Timeline, { events, role })))

test('真实时间线将占位和危险附件显示为元数据，不渲染假链接', () => {
  const html = renderTimeline([event([{ name: '占位报告.pdf', url: '#' },
    { name: '危险报告.pdf', url: 'javascript:alert(1)' }])])
  assert.match(html, /占位报告.pdf（仅元数据，暂无文件）/)
  assert.match(html, /危险报告.pdf（仅元数据，暂无文件）/)
  assert.doesNotMatch(html, /href=["'](?:#|javascript:)/)
})

test('真实时间线保留允许的附件链接及新窗口隔离属性', () => {
  const html = renderTimeline([event([{ name: '可打开报告.pdf', url: 'https://example.test/a.pdf' }])])
  assert.match(html, /href="https:\/\/example.test\/a.pdf"/)
  assert.match(html, /rel="noopener noreferrer"/)
  assert.doesNotMatch(html, /仅元数据/)
})

test('附件展示改动不绕过原有事件角色过滤', () => {
  const events = [event([{ name: '内部报告.pdf', url: '/internal.pdf' }], ['admin'])]
  assert.doesNotMatch(renderTimeline(events), /内部报告.pdf|internal.pdf/)
  assert.match(renderTimeline(events, 'admin'), /内部报告.pdf/)
})

// Drawer 默认使用浏览器 Portal，SSR 不输出正文。测试替换 Portal 外壳，
// 保留真实 Drawer 内部 JSX、React Hook 和其他 AntD 组件；不冒充真实浏览器布局。
test('批次标签和前缀工具保留，默认折叠状态使用 ARIA 关联真实工具区', () => {
  fixture.batch = { id: 'fixture', herbName: '黄精', batchNo: 'YM-2026-SX-HJ-0601' }
  const html = withoutTextBoundaries(renderToString(createElement(Drawer)))
  assert.match(html, /黄精 · YM-2026-SX-HJ-0601/)
  assert.match(html, /批次工具/)
  assert.match(html, /插入批次前缀/)
  assert.match(html, /aria-expanded="false"/)
  const controlId = html.match(/aria-controls="([^"]+)"/)?.[1]
  assert.ok(controlId)
  assert.ok(html.includes(`id="${controlId}"`))
  assert.match(html, /本人历史已保存/)
})

test('无批次和 demo 的说明区分普通聊天与离线历史，不声称调用真实 AI', () => {
  fixture.historyMode = 'demo'
  const html = withoutTextBoundaries(renderToString(createElement(Drawer)))
  assert.match(html, /药材知识 \/ 批次查询/)
  assert.match(html, /使用说明/)
  assert.match(html, /仅本次登录保留历史，不调用 AI/)
  assert.doesNotMatch(html, /插入批次前缀|本人历史已保存/)
})

test('聊天 Less 可编译，短屏规则收拢工具且保留独立滚动区域', async () => {
  const source = readFileSync(new URL('../src/components/assistant/assistant.less', import.meta.url), 'utf8')
  const { css } = await less.render(source)
  assert.match(css, /@media \(max-width: 600px\), \(max-height: 480px\)/)
  assert.match(css, /\.assistant-chat \.assistant-history\s*\{[^}]*min-height: 0;[^}]*overflow-y: auto;/)
  assert.match(css, /\.assistant-context--expanded \.assistant-context-details\s*\{\s*display: block;/)
})
