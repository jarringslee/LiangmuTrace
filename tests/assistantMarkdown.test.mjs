import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { PassThrough } from 'node:stream'
import { readFile } from 'node:fs/promises'
import less from 'less'
import { createElement } from 'react'
import { renderToString, renderToPipeableStream } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { createServer } from 'vite'

let vite, AssistantMarkdown, AssistantMessages
before(async () => {
  vite = await createServer({ cacheDir: 'node_modules/.vite-tests/assistant-markdown',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'silent' })
  AssistantMarkdown = (await vite.ssrLoadModule('/src/components/assistant/AssistantMarkdown.tsx')).default
  AssistantMessages = (await vite.ssrLoadModule('/src/components/assistant/AssistantMessages.tsx')).default
})
after(async () => { await vite?.close() })
const render = (text) => renderToString(createElement(AssistantMarkdown, null, text))

test('Markdown 支持标题、加粗、列表、引用和代码，普通文本保持可读', () => {
  const html = render('## 药材资料\n\n**甘草**与`批次号`\n\n- 登记产地\n- 当前阶段\n\n> 不代表质量认证\n\n```text\n保存记录\n```')
  assert.match(html, /<h2>药材资料<\/h2>/)
  assert.match(html, /<strong>甘草<\/strong>/)
  assert.match(html, /<code>批次号<\/code>/)
  assert.match(html, /<ul>/)
  assert.match(html, /<blockquote>/)
  assert.match(html, /<pre><code class="language-text">/)
  assert.match(render('你好，我可以帮你查看批次资料。'), /<p>你好，我可以帮你查看批次资料。<\/p>/)
})

test('GFM 表格使用独立滚动区域；标题不继承全局暗色文字', async () => {
  const html = render('| 项目 | 内容 |\n| --- | --- |\n| 药材 | 甘草 |\n| 阶段 | 种植中 |')
  assert.match(html, /class="assistant-markdown-table" role="region" aria-label="回答表格，可横向滚动" tabindex="0"/)
  assert.match(html, /<table><thead>/)
  assert.match(html, /<th>项目<\/th>/)
  assert.match(html, /<td>甘草<\/td>/)
  const { css } = await less.render(await readFile(new URL('../src/components/assistant/assistant.less', import.meta.url), 'utf8'))
  assert.match(css, /\.assistant-chat \.assistant-markdown \{[^}]*color: #1f2937;/)
  assert.match(css, /\.assistant-markdown h2,[^}]*color: inherit;/)
  assert.match(css, /\.assistant-markdown-table \{[^}]*overflow-x: auto;/)
})

test('原始 HTML、脚本、图片和模型生成链接不能执行或发起外部资源请求', () => {
  const html = render('正常正文\n\n<script>alert("unsafe")</script>\n\n<img src="https://tracking.test/pixel" onerror="alert(1)">\n\n[外链](https://tracking.test) [危险](javascript:alert%281%29) ![图片](https://tracking.test/image)')
  assert.match(html, /正常正文/)
  assert.match(html, /外链/)
  assert.doesNotMatch(html, /<(?:script|img|a|iframe|input)\b/i)
  assert.doesNotMatch(html, /href=|src=|onerror=|tracking\.test/)
})

test('代码里的 HTML 只作为转义文字展示；来源编号和换行不丢失', () => {
  const html = render('登记产地为陕西。[1]\n第二行\n\n`<script>alert(1)</script>`')
  assert.match(html, /陕西。\[1\]\n第二行/)
  assert.match(html, /<code>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/code>/)
  assert.doesNotMatch(html, /<script>/)
})

test('实际消息组件异步加载 Markdown，保留友好编号、复制与服务端来源', { timeout: 10_000 }, async () => {
  const answer = '## 登记资料\n\n**陕西**是本批次登记产地。[batch:origin]'
  const tree = createElement(MemoryRouter, null, createElement(AssistantMessages, {
    turns: [{ id: 'markdown-turn', question: '产地在哪里？', batch: { id: 'A', herbName: '甘草', batchNo: 'YM-A' }, status: 'done',
      reply: { id: 'markdown-reply', question: '产地在哪里？', scope: 'batch', batchId: 'A', status: 'answered', answer,
        citations: [{ id: 'batch:origin', kind: 'batch', title: '登记产地', publisher: '批次档案', url: null }], mode: 'api', modelName: 'fixture-model' } }],
    busy: false, retry: () => undefined,
  }))
  const output = new PassThrough()
  let html = ''
  const complete = new Promise((resolve, reject) => {
    output.on('data', (chunk) => { html += chunk.toString() })
    output.on('end', resolve)
    output.on('error', reject)
  })
  const stream = renderToPipeableStream(tree, { onAllReady() { stream.pipe(output) }, onError(error) { output.destroy(error) } })
  try {
    await complete
    assert.match(html, /<h2>登记资料<\/h2>/)
    assert.match(html, /<strong>陕西<\/strong>/)
    assert.match(html, /登记产地。\[1\]/)
    assert.match(html, /复制回答/)
    assert.match(html, /查看依据（1）/)
    assert.doesNotMatch(html, /batch:origin/)
  } finally { stream.abort() }
})

test('正常资料不足不标为错误；请求失败保留独立的失败与重试入口', () => {
  const reply = { id: 'refusal', question: '问题', scope: 'general', batchId: null, status: 'insufficient',
    answer: '抱歉，我暂时没有可核对的资料。', citations: [], mode: 'api', modelName: null }
  const normal = renderToString(createElement(AssistantMessages, {
    turns: [{ id: 'normal', question: '问题', batch: null, status: 'done', reply }], busy: false, retry: () => undefined,
  }))
  assert.doesNotMatch(normal, /ant-typography-danger|重新提问/)
  const failure = renderToString(createElement(AssistantMessages, {
    turns: [{ id: 'failed', question: '问题', batch: null, status: 'error', error: '回答格式不正确' }], busy: false, retry: () => undefined,
  }))
  assert.match(failure, /ant-typography-danger/)
  assert.match(failure, /回答格式不正确/)
  assert.match(failure, /重新提问/)
})
