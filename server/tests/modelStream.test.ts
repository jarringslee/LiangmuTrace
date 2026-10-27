import assert from 'node:assert/strict'
import { test } from 'node:test'
import { partialAnswer, readModelStream } from '../src/lib/modelStream.js'
import { parseAnswerJson } from '../src/lib/answerJson.js'

const frame = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\r\n\r\n`
const end = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
const body = (value: string) => new ReadableStream<Uint8Array>({ start(controller) {
  // 故意逐字节分块，覆盖中文 UTF-8、CRLF、JSON 和反斜杠跨块。
  for (const byte of new TextEncoder().encode(value)) controller.enqueue(new Uint8Array([byte]))
  controller.close()
} })

test('仅规范化字符串内未转义控制字符；截断、坏转义、缺引号不能被修成成功', () => {
  const expected = { status: 'answered', answer: '第一行\n第二行\r\n制表\t与"引号"、\\路径' }
  const escaped = JSON.stringify(expected)
  assert.deepEqual(parseAnswerJson(escaped), expected)
  assert.deepEqual(parseAnswerJson(escaped.replaceAll('\\n', '\n').replaceAll('\\r', '\r').replaceAll('\\t', '\t')), expected)
  for (const raw of [null, '', '{"answer":"半截', '{"answer":"坏\\q"}', '{"answer":"没转义"引号"}', '{"answer":"x"', '```json\n{}\n```'])
    assert.throws(() => parseAnswerJson(raw), { code: 'AI_RESULT_JSON_INVALID' })
})

test('流式预览与最终换行规范化一致，但未完成结构仍须拒绝', async () => {
  const raw = '{"status":"answered","answer":"第一行\n第二行"}'
  const seen: string[] = []
  const result = await readModelStream(body(frame(raw) + end), new AbortController().signal, text => { seen.push(text) })
  assert.equal((parseAnswerJson(result.content) as { answer: string }).answer, seen.at(-1))
  assert.throws(() => parseAnswerJson(raw.slice(0, -1)), { code: 'AI_RESULT_JSON_INVALID' })
})

test('answer 增量解码支持半个转义和 Unicode；生成中隐藏引用 ID', () => {
  assert.equal(partialAnswer('{"status":"answered","answer":"山茱'), '山茱')
  assert.equal(partialAnswer('{"answer":"第一行\\n第二行\\u4'), '第一行\n第二行')
  assert.equal(partialAnswer('{"answer":"\\u4e2d\\u6587 [knowledge:B00234:origin]。"}'), '中文 。')
  assert.equal(partialAnswer('{"answer":"中文 [knowledge:'), '中文 ')
  assert.equal(partialAnswer('{"answer":"\\"引号\\"\\\\路径"}'), '"引号"\\路径')
})
test('模型原始 delta 在终态前触发回调，完整 JSON 原文保留给最终校验', async () => {
  const fragments = ['{"status":"answered","answer":"山茱', '萸。\\n[knowledge:B00234:origin]"', ',"sourceIds":["knowledge:B00234:origin"]}']
  const updates: string[] = []
  const result = await readModelStream(body(fragments.map(frame).join('') + end), new AbortController().signal, text => { updates.push(text) })
  assert.deepEqual(updates, ['山茱', '山茱萸。\n'])
  assert.equal(result.content, fragments.join(''))
  assert.deepEqual(result.toolCalls, [])
})
test('缺少 DONE/finish_reason 或输出截断，不能冒充完整回答', async () => {
  for (const value of [frame('{"answer":"一半'), frame('回复') + 'data: [DONE]\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n']) {
    await assert.rejects(readModelStream(body(value), new AbortController().signal, () => undefined), { code: 'AI_INCOMPLETE_RESPONSE' })
  }
})
test('流式问答拒绝工具、非法帧、过大输出；取消释放 reader', async () => {
  await assert.rejects(readModelStream(body('data: not-json\n\n'), new AbortController().signal, () => undefined), { code: 'AI_INVALID_RESPONSE' })
  await assert.rejects(readModelStream(body('data: null\n\n'), new AbortController().signal, () => undefined), { code: 'AI_INVALID_RESPONSE' })
  await assert.rejects(readModelStream(body('data: {"choices":[{"delta":{"tool_calls":[{}]}}]}\n\n'), new AbortController().signal, () => undefined), { code: 'AI_INVALID_RESULT' })
  const controller = new AbortController()
  await assert.rejects(readModelStream(body(frame('{"answer":"中') + end), controller.signal, () => controller.abort()), { name: 'AbortError' })
})
